/**
 * Application controller.
 *
 * Responsibilities:
 * - load the product config (`pokerApiUrl`) and product metadata;
 * - restore/verify the PokerTools session token from sessionStorage;
 * - run the injected-wallet SIWE login and attach the opaque bearer token to
 *   product API calls;
 * - open the SDK live table stream for the selected room;
 * - submit canonical actions (stable requestId, one in flight at a time) and
 *   chat/replay reads through the public SDK.
 *
 * No NLHE legality, balances, winners or authorization decisions live here:
 * the server issues the legal action menu and amount bounds, and the product
 * API resolves product identity by introspecting the bearer token.
 */

import type { CompetitionClient, PokerClient } from '@pokertools/sdk';
import './styles.css';
import {
  clearStoredToken,
  injectedProvider,
  readStoredToken,
  signInWithWallet,
  type Eip1193Provider,
} from './auth';
import {
  ProductApi,
  roomIsTerminal,
  validateCreateRoom,
  type CreateRoomRequest,
  type RoomDetail,
} from './product-api';
import {
  TableSocket,
  createCompetitionClient,
  createPokerClient,
  loadChat,
  loadReplay,
  postChat,
  submitCanonicalAction,
} from './sdk';
import { setState, state, subscribe } from './store';
import { initView, render, resetTableRender, type ViewActions } from './view';

const api = new ProductApi();

let pokerApiUrl = '';
let client: PokerClient | null = null;
let competitionClient: CompetitionClient | null = null;
let token: string | null = null;
let socket: TableSocket | null = null;
let tableGeneration = 0;

let submittingAction = false;
let sendingChat = false;
let chatRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let chatPollTimer: ReturnType<typeof setInterval> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let walletWatched = false;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

function notify(kind: 'info' | 'success' | 'error', text: string): void {
  setState({ notice: { kind, text } });
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => setState({ notice: null }), 9000);
}

function activeTableId(): string | null {
  return state.room?.pokerTableId ?? null;
}

/**
 * Competition transport is separate from gameplay and always uses the human's
 * own opaque bearer. It is the only path that can display actual terms and
 * charge an entry.
 */
function ensureCompetitionClient(): CompetitionClient | null {
  if (competitionClient !== null) return competitionClient;
  if (pokerApiUrl.length === 0 || token === null) return null;
  competitionClient = createCompetitionClient(pokerApiUrl, token);
  return competitionClient;
}

// ---------------------------------------------------------------------------
// Loading product data
// ---------------------------------------------------------------------------

async function loadConfig(): Promise<void> {
  try {
    const config = await api.getConfig();
    pokerApiUrl = config.pokerApiUrl;
    setState({ config, configError: null });
  } catch (error) {
    setState({ config: null, configError: describeError(error) });
    notify('error', `Product config unavailable: ${describeError(error)}`);
  }
}

async function loadAgents(): Promise<void> {
  try {
    const agents = await api.getAgents();
    setState({ agents, agentsError: null });
  } catch (error) {
    setState({ agentsError: describeError(error) });
  }
}

async function loadRooms(): Promise<void> {
  setState({ roomsLoading: true });
  try {
    const rooms = await api.getRooms();
    setState({ rooms, roomsLoading: false, roomsError: null });
  } catch (error) {
    setState({ roomsLoading: false, roomsError: `Rooms unavailable: ${describeError(error)}` });
  }
}

async function loadStats(): Promise<void> {
  setState({ statsLoading: true });
  try {
    const stats = await api.getStats();
    setState({ stats, statsLoading: false, statsError: null });
  } catch (error) {
    setState({ statsLoading: false, statsError: `Stats unavailable: ${describeError(error)}` });
  }
}

/**
 * Read the platform's actual finance assets with the human's own session.
 * This read-only projection is the only source of symbol/decimals the UI may
 * display; when it is unavailable, money is shown in explicit atomic units and
 * payment stays disabled. No RPC, registry or fabricated metadata is used.
 */
async function loadAssets(): Promise<void> {
  if (client === null) {
    setState({ platformAssets: [], platformAssetsLoading: false, platformAssetsError: null });
    return;
  }
  setState({ platformAssetsLoading: true });
  try {
    const platformAssets = await client.getAssets();
    setState({ platformAssets, platformAssetsLoading: false, platformAssetsError: null });
  } catch (error) {
    setState({
      platformAssets: [],
      platformAssetsLoading: false,
      platformAssetsError: describeError(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

async function restoreSession(): Promise<void> {
  const stored = readStoredToken();
  if (!stored || pokerApiUrl.length === 0) return;
  const candidate = createPokerClient(pokerApiUrl, stored);
  try {
    const principal = await candidate.getPrincipal();
    token = stored;
    client = candidate;
    competitionClient = createCompetitionClient(pokerApiUrl, stored);
    api.setToken(stored);
    setState({
      principal: { id: principal.id, kind: principal.kind, walletAddress: principal.walletAddress },
      walletAddress: principal.walletAddress,
    });
    await loadAssets();
  } catch {
    clearStoredToken();
    token = null;
    client = null;
    api.setToken(null);
  }
}

function watchWallet(provider: Eip1193Provider): void {
  if (walletWatched) return;
  walletWatched = true;
  provider.on?.('accountsChanged', (...args: unknown[]) => {
    const accounts = Array.isArray(args[0]) ? args[0] : [];
    const currentAddress = state.walletAddress?.toLowerCase();
    const stillPresent =
      currentAddress !== undefined &&
      accounts.some((account) => typeof account === 'string' && account.toLowerCase() === currentAddress);
    if (!stillPresent) {
      void disconnect('Wallet account changed; signed out.');
    }
  });
}

async function connect(): Promise<void> {
  if (state.connecting) return;
  if (pokerApiUrl.length === 0) {
    notify('error', 'Product config is unavailable; cannot sign in yet.');
    return;
  }
  const provider = injectedProvider();
  if (!provider) {
    notify('error', 'No injected EIP-1193 wallet found. Install or enable a browser wallet.');
    return;
  }

  setState({ connecting: true });
  try {
    const candidate = createPokerClient(pokerApiUrl);
    const identity = await signInWithWallet(candidate, provider, pokerApiUrl);
    const sessionToken = candidate.getToken();
    if (!sessionToken) throw new Error('Missing session token after login');

    token = sessionToken;
    client = candidate;
    competitionClient = createCompetitionClient(pokerApiUrl, sessionToken);
    api.setToken(sessionToken);
    setState({
      principal: identity.principal,
      walletAddress: identity.address,
      connecting: false,
    });
    watchWallet(provider);
    notify('success', `Signed in as ${identity.address.slice(0, 6)}…${identity.address.slice(-4)}.`);
    await loadAssets();
    await loadRooms();
    if (state.room) {
      await loadCompetition(state.room);
      await attachTable(state.room);
    }
  } catch (error) {
    setState({ connecting: false });
    notify('error', `Sign-in failed: ${describeError(error)}`);
  }
}

async function disconnect(reason?: string): Promise<void> {
  const previous = client;
  client = null;
  competitionClient = null;
  token = null;
  api.setToken(null);
  clearStoredToken();
  closeTable();
  resetTableRender();
  setState({
    principal: null,
    walletAddress: null,
    room: null,
    observation: null,
    competition: null,
    competitionError: null,
    payingEntry: false,
    platformAssets: [],
    platformAssetsError: null,
    chat: [],
    chatCursor: null,
    replay: null,
    replayError: null,
  });
  if (previous) {
    try {
      await previous.logout();
    } catch {
      // The session may already be gone; local sign-out still completes.
    }
  }
  if (reason) notify('info', reason);
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

async function openRoom(roomId: string): Promise<void> {
  setState({ roomLoading: true, roomError: null });
  try {
    const room = await api.getRoom(roomId);
    applyRoom(room);
    if (room.mode === 'CHALLENGE') await loadAssets();
    await loadCompetition(room);
    await attachTable(room);
    await refreshChat(false);
  } catch (error) {
    setState({ roomLoading: false, roomError: describeError(error) });
    notify('error', `Room unavailable: ${describeError(error)}`);
  }
}

async function refreshRoom(): Promise<void> {
  if (!state.room) return;
  await openRoom(state.room.id);
}

async function createRoom(request: CreateRoomRequest): Promise<boolean> {
  const problem = validateCreateRoom(request) ?? challengeTupleProblem(request);
  if (problem !== null) {
    notify('error', problem);
    return false;
  }
  try {
    const room = await api.createRoom(request);
    applyRoom(room);
    notify('success', `Room “${room.name}” created.`);
    await loadRooms();
    await loadCompetition(room);
    await attachTable(room);
    return true;
  } catch (error) {
    notify('error', `Create failed: ${describeError(error)}`);
    return false;
  }
}

/**
 * The CHALLENGE create body must carry the exact operator-configured tuple.
 * The server re-validates; this prevents an avoidable round trip.
 */
function challengeTupleProblem(request: CreateRoomRequest): string | null {
  if (request.mode !== 'CHALLENGE') return null;
  const config = state.config;
  const terms = config?.challenge.terms ?? null;
  if (config === null || !config.challenge.enabled || terms === null) {
    return 'Challenge rooms are disabled by the server.';
  }
  const finance = request.finance;
  if (
    !finance ||
    finance.assetId !== terms.assetId ||
    finance.entryAtomic !== terms.entryAtomic ||
    finance.prizeAtomic !== terms.prizeAtomic
  ) {
    return 'The challenge terms do not match the operator-configured entry and prize.';
  }
  return null;
}

async function joinRoom(roomId: string): Promise<void> {
  if (!state.principal) {
    notify('error', 'Connect a wallet before joining a room.');
    return;
  }
  setState({ roomLoading: true, roomError: null });
  try {
    const room = await api.joinRoom(roomId);
    applyRoom(room);
    notify('success', 'Joined the room.');
    await loadRooms();
    await loadCompetition(room);
    await attachTable(room);
    await refreshChat(false);
  } catch (error) {
    setState({ roomLoading: false, roomError: describeError(error) });
    notify('error', `Join failed: ${describeError(error)}`);
  }
}

async function startRoom(roomId: string): Promise<void> {
  if (!state.principal) {
    notify('error', 'Connect a wallet before starting a room.');
    return;
  }
  setState({ roomLoading: true, roomError: null });
  try {
    const room = await api.startRoom(roomId);
    applyRoom(room);
    if (room.status === 'PROVISIONING') {
      notify('info', 'Room is provisioning on the platform. Complete a pending entry payment to continue.');
    } else if (room.status === 'ACTIVE') {
      notify('success', 'Room started.');
    } else {
      notify('info', `Room status: ${room.status}.`);
    }
    await loadRooms();
    if (room.mode === 'CHALLENGE') await loadAssets();
    await loadCompetition(room);
    await attachTable(room);
    await refreshChat(false);
  } catch (error) {
    setState({ roomLoading: false, roomError: describeError(error) });
    notify('error', `Start failed: ${describeError(error)}`);
  }
}

function applyRoom(room: RoomDetail): void {
  const changed = state.room?.id !== room.id;
  if (changed) {
    resetTableRender();
    setState({
      chat: [],
      chatCursor: null,
      chatError: null,
      replay: null,
      replayError: null,
      competition: null,
      competitionError: null,
      competitionLoading: false,
    });
  }
  setState({ room, roomLoading: false, roomError: null });
}

// ---------------------------------------------------------------------------
// Platform competition (display + explicit entry payment)
// ---------------------------------------------------------------------------

/**
 * Load the actual platform competition projection with the human's own bearer.
 * It shows the real terms, this wallet's entrant entry state and the prize
 * status; the product room DTO remains the durable product reference.
 */
async function loadCompetition(room: RoomDetail): Promise<void> {
  if (room.mode !== 'CHALLENGE' || room.pokerCompetitionId === null) {
    setState({ competition: null, competitionError: null, competitionLoading: false });
    return;
  }
  const competitions = ensureCompetitionClient();
  if (competitions === null) {
    setState({ competition: null, competitionError: null, competitionLoading: false });
    return;
  }
  setState({ competitionLoading: true, competitionError: null });
  try {
    const competition = await competitions.getCompetition(room.pokerCompetitionId);
    setState({ competition, competitionLoading: false });
  } catch (error) {
    setState({
      competition: null,
      competitionLoading: false,
      competitionError: `Competition unavailable: ${describeError(error)}`,
    });
  }
}

/**
 * Explicit Pay entry action. This is the only place an entry is charged and it
 * runs directly against the platform `CompetitionClient` with the payer's own
 * session. A stable key makes a retry idempotent; on success the product room
 * start is resumed so provisioning can complete.
 */
async function payEntry(): Promise<void> {
  const room = state.room;
  const competition = state.competition;
  const principal = state.principal;
  if (state.payingEntry || room === null || competition === null || principal === null) return;
  if (room.mode !== 'CHALLENGE' || room.pokerCompetitionId === null) return;

  const competitions = ensureCompetitionClient();
  if (competitions === null) {
    notify('error', 'Sign in with the payer wallet to pay the entry.');
    return;
  }
  const entrant = competition.entrants.find((entry) => entry.principalId === principal.id) ?? null;
  const isPayer =
    competition.terms?.entry.payers.some((payer) => payer.principalId === principal.id) ?? false;
  if (entrant === null || !isPayer || entrant.entryState !== 'PENDING') {
    notify('error', 'This wallet has no pending entry to pay for this competition.');
    return;
  }

  // Consent is bound to the configured product terms: the actual platform
  // terms must match before any charge can happen.
  const configured = state.config?.challenge.terms ?? null;
  const platformTerms = competition.terms;
  const termsMatch =
    configured !== null &&
    platformTerms !== null &&
    platformTerms.entry.assetId === configured.assetId &&
    platformTerms.entry.amountAtomic === configured.entryAtomic &&
    platformTerms.prize.assetId === configured.assetId &&
    platformTerms.prize.amountAtomic === configured.prizeAtomic;
  if (!termsMatch) {
    notify('error', 'The platform competition terms do not match the configured product terms; payment is blocked.');
    return;
  }

  // Payment requires the real platform asset projection and an ACTIVE asset.
  await loadAssets();
  const asset = state.platformAssets.find((candidate) => candidate.assetId === configured.assetId) ?? null;
  if (asset === null) {
    notify('error', 'Settlement asset metadata is unavailable; payment is disabled.');
    return;
  }
  if (asset.status !== 'ACTIVE') {
    notify('error', `Settlement asset status is ${asset.status}; payment is disabled until it is ACTIVE.`);
    return;
  }

  setState({ payingEntry: true });
  try {
    await competitions.optIn(room.pokerCompetitionId);
    notify('success', 'Entry paid on the platform. Resuming room start…');
    await loadCompetition(room);
    await startRoom(room.id);
  } catch (error) {
    notify('error', `Entry payment failed: ${describeError(error)}`);
    await loadCompetition(room);
  } finally {
    setState({ payingEntry: false });
  }
}

// ---------------------------------------------------------------------------
// Live table
// ---------------------------------------------------------------------------

async function attachTable(room: RoomDetail): Promise<void> {
  const tableId = room.pokerTableId;
  if (!tableId || !token || roomIsTerminal(room.status)) {
    closeTable();
    return;
  }

  closeTable(false);
  const generation = ++tableGeneration;
  setState({ observation: null, socketStatus: 'connecting', socketDetail: 'opening' });

  const session = new TableSocket({
    observation: (observedTableId, observation) => {
      if (generation !== tableGeneration) return;
      if (observedTableId !== activeTableId()) return;
      setState({ observation });
      scheduleChatRefresh();
    },
    status: (status, detail) => {
      if (generation !== tableGeneration) return;
      setState({ socketStatus: status, socketDetail: detail });
    },
  });
  socket = session;

  try {
    const first = await session.open(pokerApiUrl, token, tableId);
    if (generation !== tableGeneration) return;
    setState({ observation: first });
    startChatPolling();
    scheduleChatRefresh();
  } catch (error) {
    if (generation !== tableGeneration) return;
    setState({ socketStatus: 'disconnected', socketDetail: 'unavailable' });
    notify('error', `Live table unavailable: ${describeError(error)}`);
  }
}

function closeTable(resetSocketState = true): void {
  tableGeneration += 1;
  if (socket) {
    socket.close();
    socket = null;
  }
  stopChatPolling();
  if (chatRefreshTimer !== null) {
    clearTimeout(chatRefreshTimer);
    chatRefreshTimer = null;
  }
  if (resetSocketState) {
    setState({ observation: null, socketStatus: 'idle', socketDetail: 'off' });
  }
}

async function refreshTable(): Promise<void> {
  const tableId = activeTableId();
  if (!client || !tableId) return;
  try {
    const observation = await client.getObservation(tableId);
    setState({ observation });
  } catch (error) {
    notify('error', `Table refresh failed: ${describeError(error)}`);
  }
}

async function submitAction(actionId: string, amount?: number): Promise<void> {
  const observation = state.observation;
  if (submittingAction || !client || !observation) return;
  submittingAction = true;
  setState({ busy: true });
  try {
    const result = await submitCanonicalAction(client, observation, actionId, amount);
    setState({ observation: result.observation });
  } catch (error) {
    notify('error', `Action rejected: ${describeError(error)}`);
    await refreshTable();
  } finally {
    submittingAction = false;
    setState({ busy: false });
  }
}

// ---------------------------------------------------------------------------
// Chat (no idempotency key in the current SDK; re-entry is blocked locally)
// ---------------------------------------------------------------------------

function scheduleChatRefresh(): void {
  if (chatRefreshTimer !== null) return;
  chatRefreshTimer = setTimeout(() => {
    chatRefreshTimer = null;
    void refreshChat(false);
  }, 2500);
}

function startChatPolling(): void {
  stopChatPolling();
  chatPollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void refreshChat(false);
  }, 10_000);
}

function stopChatPolling(): void {
  if (chatPollTimer !== null) {
    clearInterval(chatPollTimer);
    chatPollTimer = null;
  }
}

async function refreshChat(older: boolean): Promise<void> {
  const tableId = activeTableId();
  if (!client || !tableId) return;
  try {
    if (older) {
      const cursor = state.chatCursor;
      if (cursor === null) return;
      const page = await loadChat(client, tableId, { beforeSeq: cursor });
      setState({
        chat: [...page.messages, ...state.chat],
        chatCursor: page.nextBeforeSeq,
        chatError: null,
      });
    } else {
      const page = await loadChat(client, tableId, { limit: 100 });
      setState({ chat: page.messages, chatCursor: page.nextBeforeSeq, chatError: null });
    }
  } catch (error) {
    setState({ chatError: `Chat unavailable: ${describeError(error)}` });
  }
}

async function sendChat(text: string): Promise<boolean> {
  const tableId = activeTableId();
  if (sendingChat || !client || !tableId) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  sendingChat = true;
  setState({ chatSending: true });
  try {
    await postChat(client, tableId, trimmed);
    await refreshChat(false);
    return true;
  } catch (error) {
    notify('error', `Chat rejected: ${describeError(error)}`);
    return false;
  } finally {
    sendingChat = false;
    setState({ chatSending: false });
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

async function loadReplayData(): Promise<void> {
  const tableId = activeTableId();
  if (!client || !tableId) return;
  setState({ replayLoading: true, replayError: null });
  try {
    const replay = await loadReplay(client, tableId, { fromEventSeq: 1 });
    setState({ replay, replayLoading: false });
  } catch (error) {
    setState({ replay: null, replayLoading: false, replayError: describeError(error) });
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const viewActions: ViewActions = {
  connect: () => void connect(),
  disconnect: () => void disconnect(),
  refreshRooms: () => void loadRooms(),
  createRoom,
  openRoom: (roomId) => void openRoom(roomId),
  joinRoom: (roomId) => void joinRoom(roomId),
  startRoom: (roomId) => void startRoom(roomId),
  refreshRoom: () => void refreshRoom(),
  refreshTable: () => void refreshTable(),
  submitAction: (actionId, amount) => void submitAction(actionId, amount),
  refreshChat: (older) => void refreshChat(older),
  sendChat,
  payEntry: () => void payEntry(),
  loadReplay: () => void loadReplayData(),
  refreshStats: () => void loadStats(),
  dismissNotice: () => setState({ notice: null }),
  notify: (kind, text) => notify(kind, text),
};

async function bootstrap(): Promise<void> {
  initView(viewActions);
  subscribe(() => render(state));
  render(state);

  await loadConfig();
  await Promise.allSettled([loadAgents(), loadRooms(), loadStats()]);
  await restoreSession();
  render(state);
}

void bootstrap();
