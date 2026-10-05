/**
 * DOM rendering for the whole product UI.
 *
 * The controller (`main.ts`) owns behavior; this module only translates a
 * state snapshot into DOM updates. Repeated lists are rebuilt with safe DOM
 * builders (never `innerHTML`), and the form controls themselves are static so
 * typing is never interrupted by a repaint.
 */

import {
  formatCard,
  formatChips,
  getActivePlayer,
  getStreetName,
  getTotalPot,
  type Asset,
  type ChatMessage,
  type LegalAction,
  type SeatObservation,
} from '@pokertools/sdk';
import { byId, clear, el, metaRow, option, setDisabled, setHidden, setText } from './dom';
import type { AppState, NoticeKind } from './store';
import type {
  CreateRoomRequest,
  RoomDetail,
  RoomMode,
  RoomParticipant,
  RoomSummary,
} from './product-api';
import { roomIsLive, roomIsTerminal } from './product-api';

export interface ViewActions {
  connect(): void;
  disconnect(): void;
  refreshRooms(): void;
  createRoom(request: CreateRoomRequest): Promise<boolean>;
  openRoom(roomId: string): void;
  joinRoom(roomId: string): void;
  startRoom(roomId: string): void;
  refreshRoom(): void;
  refreshTable(): void;
  submitAction(actionId: string, amount?: number): void;
  refreshChat(older: boolean): void;
  sendChat(text: string): Promise<boolean>;
  loadReplay(): void;
  refreshStats(): void;
  payEntry(): void;
  dismissNotice(): void;
  notify(kind: NoticeKind, text: string): void;
}

const FAMILY_LABELS: Record<string, string> = {
  DEAL: 'Deal',
  CHECK: 'Check',
  CALL: 'Call',
  BET: 'Bet',
  RAISE: 'Raise',
  FOLD: 'Fold',
  SHOW: 'Show',
  MUCK: 'Muck',
  TIME_BANK: 'Time bank',
  STAND: 'Stand',
  NEXT_BLIND_LEVEL: 'Next level',
};

const CHIP_FAMILIES = new Set(['BET', 'RAISE']);

interface Elements {
  platformChip: HTMLSpanElement;
  walletChip: HTMLSpanElement;
  connectBtn: HTMLButtonElement;
  disconnectBtn: HTMLButtonElement;
  notice: HTMLDivElement;
  noticeText: HTMLSpanElement;
  noticeClose: HTMLButtonElement;
  refreshRoomsBtn: HTMLButtonElement;
  roomList: HTMLDivElement;
  createForm: HTMLFormElement;
  createMode: HTMLSelectElement;
  createName: HTMLInputElement;
  sponsoredFields: HTMLDivElement;
  sponsoredHumans: HTMLInputElement;
  sponsoredAgents: HTMLSelectElement;
  challengeFields: HTMLDivElement;
  challengeAgents: HTMLSelectElement;
  challengeAsset: HTMLSelectElement;
  challengeTerms: HTMLDListElement;
  challengeAccept: HTMLInputElement;
  createPlatformStatus: HTMLSpanElement;
  createNote: HTMLParagraphElement;
  createBtn: HTMLButtonElement;
  roomCard: HTMLElement;
  roomTitle: HTMLHeadingElement;
  roomStatusChip: HTMLSpanElement;
  roomMeta: HTMLDListElement;
  roomRoster: HTMLDivElement;
  roomFinance: HTMLDListElement;
  payEntryBtn: HTMLButtonElement;
  entryNote: HTMLParagraphElement;
  roomRefreshBtn: HTMLButtonElement;
  joinRoomBtn: HTMLButtonElement;
  startRoomBtn: HTMLButtonElement;
  roomNote: HTMLParagraphElement;
  tableCard: HTMLElement;
  tableConnection: HTMLSpanElement;
  tableVersion: HTMLSpanElement;
  refreshTableBtn: HTMLButtonElement;
  board: HTMLDivElement;
  tableMeta: HTMLDListElement;
  seats: HTMLDivElement;
  turnLine: HTMLDivElement;
  legalActions: HTMLDivElement;
  chatCard: HTMLElement;
  olderChatBtn: HTMLButtonElement;
  chatLog: HTMLDivElement;
  chatForm: HTMLFormElement;
  chatInput: HTMLInputElement;
  chatSendBtn: HTMLButtonElement;
  chatNote: HTMLParagraphElement;
  replayCard: HTMLElement;
  loadReplayBtn: HTMLButtonElement;
  results: HTMLDivElement;
  replayMeta: HTMLDListElement;
  replayLog: HTMLDivElement;
  refreshStatsBtn: HTMLButtonElement;
  statsList: HTMLDListElement;
}

let els: Elements;
let current: AppState;
let actions: ViewActions;

let agentSignatureSponsored = '';
let agentSignatureChallenge = '';
let assetSignature = '';
let turnSignature = '';
let actionButtons: HTMLButtonElement[] = [];
let amountInputs: HTMLInputElement[] = [];

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

function shortHex(value: string | null): string {
  if (!value) return '—';
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function shortId(value: string | null): string {
  if (!value) return '—';
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function safeChips(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? formatChips(value)
    : '—';
}

function clock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString();
}

/** Format a canonical atomic amount for display without treating it as a number. */
function formatAtomic(value: string | null, decimals: number): string {
  if (value === null) return 'server-configured';
  if (!/^\d+$/.test(value)) return value;
  if (decimals <= 0) return value;
  const padded = value.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, '');
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

function publishablePayload(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return '';
    return json.length > 240 ? `${json.slice(0, 240)}…` : json;
  } catch {
    return '';
  }
}

function participantRole(participant: RoomParticipant): string {
  if (participant.kind === 'AGENT') {
    return `agent · ${participant.agentModel ?? participant.agentId ?? 'model metadata unavailable'}`;
  }
  return `wallet · ${shortHex(participant.address)}`;
}

function isSelf(state: AppState, participant: RoomParticipant): boolean {
  const principal = state.principal;
  if (!principal) return false;
  if (participant.pokerPrincipalId && participant.pokerPrincipalId === principal.id) return true;
  const wallet = principal.walletAddress?.toLowerCase();
  return Boolean(wallet && participant.address && participant.address.toLowerCase() === wallet);
}

function statusKind(status: string): string {
  const normalized = status.toUpperCase();
  if (['AVAILABLE', 'ACTIVE', 'COMPLETE'].includes(normalized)) return 'good';
  if (['UNAVAILABLE', 'FAILED', 'CANCELLED'].includes(normalized)) return 'bad';
  if (normalized === 'UNKNOWN' || normalized === 'DRAFT' || normalized === 'WAITING_FOR_ROSTER' || normalized === 'PROVISIONING') {
    return 'warn';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function initView(viewActions: ViewActions): void {
  actions = viewActions;
  els = {
    platformChip: byId('platformChip'),
    walletChip: byId('walletChip'),
    connectBtn: byId('connectBtn'),
    disconnectBtn: byId('disconnectBtn'),
    notice: byId('notice'),
    noticeText: byId('noticeText'),
    noticeClose: byId('noticeClose'),
    refreshRoomsBtn: byId('refreshRoomsBtn'),
    roomList: byId('roomList'),
    createForm: byId('createForm'),
    createMode: byId('createMode'),
    createName: byId('createName'),
    sponsoredFields: byId('sponsoredFields'),
    sponsoredHumans: byId('sponsoredHumans'),
    sponsoredAgents: byId('sponsoredAgents'),
    challengeFields: byId('challengeFields'),
    challengeAgents: byId('challengeAgents'),
    challengeAsset: byId('challengeAsset'),
    challengeTerms: byId('challengeTerms'),
    challengeAccept: byId('challengeAccept'),
    createPlatformStatus: byId('createPlatformStatus'),
    createNote: byId('createNote'),
    createBtn: byId('createBtn'),
    roomCard: byId('roomCard'),
    roomTitle: byId('roomTitle'),
    roomStatusChip: byId('roomStatusChip'),
    roomMeta: byId('roomMeta'),
    roomRoster: byId('roomRoster'),
    roomFinance: byId('roomFinance'),
    payEntryBtn: byId('payEntryBtn'),
    entryNote: byId('entryNote'),
    roomRefreshBtn: byId('roomRefreshBtn'),
    joinRoomBtn: byId('joinRoomBtn'),
    startRoomBtn: byId('startRoomBtn'),
    roomNote: byId('roomNote'),
    tableCard: byId('tableCard'),
    tableConnection: byId('tableConnection'),
    tableVersion: byId('tableVersion'),
    refreshTableBtn: byId('refreshTableBtn'),
    board: byId('board'),
    tableMeta: byId('tableMeta'),
    seats: byId('seats'),
    turnLine: byId('turnLine'),
    legalActions: byId('legalActions'),
    chatCard: byId('chatCard'),
    olderChatBtn: byId('olderChatBtn'),
    chatLog: byId('chatLog'),
    chatForm: byId('chatForm'),
    chatInput: byId('chatInput'),
    chatSendBtn: byId('chatSendBtn'),
    chatNote: byId('chatNote'),
    replayCard: byId('replayCard'),
    loadReplayBtn: byId('loadReplayBtn'),
    results: byId('results'),
    replayMeta: byId('replayMeta'),
    replayLog: byId('replayLog'),
    refreshStatsBtn: byId('refreshStatsBtn'),
    statsList: byId('statsList'),
  };

  els.connectBtn.addEventListener('click', () => actions.connect());
  els.disconnectBtn.addEventListener('click', () => actions.disconnect());
  els.refreshRoomsBtn.addEventListener('click', () => actions.refreshRooms());
  els.roomRefreshBtn.addEventListener('click', () => actions.refreshRoom());
  els.joinRoomBtn.addEventListener('click', () => {
    if (current.room) actions.joinRoom(current.room.id);
  });
  els.startRoomBtn.addEventListener('click', () => {
    if (current.room) actions.startRoom(current.room.id);
  });
  els.refreshTableBtn.addEventListener('click', () => actions.refreshTable());
  els.olderChatBtn.addEventListener('click', () => actions.refreshChat(true));
  els.loadReplayBtn.addEventListener('click', () => actions.loadReplay());
  els.payEntryBtn.addEventListener('click', () => actions.payEntry());
  els.refreshStatsBtn.addEventListener('click', () => actions.refreshStats());
  els.noticeClose.addEventListener('click', () => actions.dismissNotice());

  els.createMode.addEventListener('change', () => render(current));
  for (const control of [
    els.challengeAccept,
    els.challengeAsset,
    els.sponsoredHumans,
    els.sponsoredAgents,
    els.challengeAgents,
  ]) {
    control.addEventListener('change', () => render(current));
  }
  els.sponsoredHumans.addEventListener('input', () => render(current));
  els.createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitCreateForm();
  });
  els.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitChatForm();
  });
}

async function submitCreateForm(): Promise<void> {
  const mode = els.createMode.value === 'CHALLENGE' ? 'CHALLENGE' : 'SPONSORED';
  const humanCount = mode === 'CHALLENGE'
    ? 1
    : Number.parseInt(els.sponsoredHumans.value, 10);
  const agentSelect = mode === 'CHALLENGE' ? els.challengeAgents : els.sponsoredAgents;
  const agentIds = Array.from(agentSelect.selectedOptions).map((selected) => selected.value);
  const terms = current.config?.challenge.terms ?? null;

  // The CHALLENGE body always carries the exact operator-configured tuple.
  const finance = mode === 'CHALLENGE' && terms !== null
    ? {
        assetId: terms.assetId,
        entryAtomic: terms.entryAtomic,
        prizeAtomic: terms.prizeAtomic,
        optIn: els.challengeAccept.checked,
      }
    : null;

  const request: CreateRoomRequest = {
    mode,
    humanCount: Number.isFinite(humanCount) ? humanCount : 0,
    agentIds,
    name: els.createName.value.trim(),
    finance,
  };
  await actions.createRoom(request);
}

async function submitChatForm(): Promise<void> {
  const text = els.chatInput.value.trim();
  if (text.length === 0) return;
  const sent = await actions.sendChat(text);
  if (sent) els.chatInput.value = '';
}

/**
 * Actual platform asset metadata (read-only browser projection). The product
 * config may carry placeholders; money display never trusts them.
 */
function platformAsset(assetId: string): Asset | null {
  return current.platformAssets.find((asset) => asset.assetId === assetId) ?? null;
}

/** Display one atomic amount; without metadata, explicit atomic units + id. */
function displayAmount(amountAtomic: string, assetId: string): string {
  const asset = platformAsset(assetId);
  if (asset === null) return `${amountAtomic} atomic units · ${assetId}`;
  return `${formatAtomic(amountAtomic, asset.decimals)} ${asset.symbol}`;
}

// ---------------------------------------------------------------------------
// Options sync (preserves the user's selection across repaints)
// ---------------------------------------------------------------------------

interface OptionSpec {
  value: string;
  label: string;
  disabled?: boolean;
}

function syncSelect(
  select: HTMLSelectElement,
  specs: OptionSpec[],
  signature: string,
  previousSignature: string
): string {
  if (signature === previousSignature) return previousSignature;
  const selected = new Set(Array.from(select.selectedOptions).map((entry) => entry.value));
  clear(select);
  for (const spec of specs) {
    const entry = option(spec.value, spec.label, spec.disabled === true);
    if (spec.value && selected.has(spec.value)) entry.selected = true;
    select.appendChild(entry);
  }
  return signature;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function render(state: AppState): void {
  current = state;
  renderTopbar(state);
  renderNotice(state);
  renderRoomList(state);
  renderCreateForm(state);
  renderRoom(state);
  renderTable(state);
  renderChat(state);
  renderReplay(state);
  renderStats(state);
}

function renderTopbar(state: AppState): void {
  const platform = state.config?.platform;
  setText(els.platformChip, `platform: ${platform?.status ?? (state.configError ? 'unavailable' : 'loading…')}`);
  els.platformChip.className = `chip${platform ? ` ${statusKind(platform.status)}` : ''}`;

  const connected = state.principal !== null;
  setHidden(els.walletChip, !connected);
  setHidden(els.disconnectBtn, !connected);
  setHidden(els.connectBtn, connected);
  if (connected) {
    setText(els.walletChip, shortHex(state.walletAddress ?? state.principal?.walletAddress ?? null));
    els.walletChip.title = state.walletAddress ?? '';
  }
  setDisabled(els.connectBtn, state.connecting || state.config === null);
  setText(els.connectBtn, state.connecting ? 'Signing in…' : 'Connect wallet');
}

function renderNotice(state: AppState): void {
  const notice = state.notice;
  setHidden(els.notice, notice === null);
  if (!notice) return;
  els.notice.className = `notice ${notice.kind}`;
  setText(els.noticeText, notice.text);
}

function renderRoomList(state: AppState): void {
  clear(els.roomList);
  if (state.roomsError) {
    els.roomList.appendChild(el('p', { className: 'empty error', text: state.roomsError }));
    return;
  }
  if (state.roomsLoading && state.rooms.length === 0) {
    els.roomList.appendChild(el('p', { className: 'empty', text: 'Loading rooms…' }));
    return;
  }
  if (state.rooms.length === 0) {
    els.roomList.appendChild(el('p', { className: 'empty', text: 'No rooms yet. Create one below.' }));
    return;
  }

  for (const room of state.rooms) {
    els.roomList.appendChild(roomRow(room));
  }
}

function roomRow(room: RoomSummary): HTMLElement {
  const row = el('div', {
    className: 'room-row',
    dataset: { testid: 'room-row', roomId: room.id, roomName: room.name },
  }, [
    el('div', { className: 'room-row-main' }, [
      el('div', { className: 'room-row-title' }, [
        el('span', { text: room.name }),
        el('span', { className: `chip ${room.mode === 'CHALLENGE' ? 'challenge' : 'sponsored'}`, text: room.mode }),
        el('span', { className: `chip ${statusKind(room.status)}`, text: room.status }),
      ]),
      el('div', {
        className: 'room-row-meta muted',
        text: `${room.humanCount} human · ${room.agentCount} agent · ${room.totalSeats} seats${
          room.pokerTableId ? ` · table ${shortId(room.pokerTableId)}` : ''
        }`,
      }),
    ]),
    el('div', { className: 'room-row-actions' }, [
      el('button', {
        className: 'btn ghost small',
        text: 'Open',
        dataset: { testid: 'room-open' },
        on: { click: () => actions.openRoom(room.id) },
      }),
      el('button', {
        className: 'btn ghost small',
        text: 'Join',
        dataset: { testid: 'room-join' },
        on: { click: () => actions.joinRoom(room.id) },
      }),
      el('button', {
        className: 'btn primary small',
        text: 'Start',
        dataset: { testid: 'room-start' },
        on: { click: () => actions.startRoom(room.id) },
      }),
    ]),
  ]);
  return row;
}

function renderCreateForm(state: AppState): void {
  const agents = state.agents;
  const agentSpecs = agents.map((agent) => ({
    value: agent.id,
    label: agent.available ? `${agent.name} (${agent.model})` : `${agent.name} (${agent.model}) — unavailable`,
    disabled: !agent.available,
  }));
  const agentSignatureText = agents
    .map((agent) => `${agent.id}:${agent.available ? '1' : '0'}`)
    .join(',');
  agentSignatureSponsored = syncSelect(
    els.sponsoredAgents,
    agentSpecs,
    agentSignatureText,
    agentSignatureSponsored
  );
  agentSignatureChallenge = syncSelect(
    els.challengeAgents,
    agentSpecs,
    agentSignatureText,
    agentSignatureChallenge
  );

  // Only the operator-configured challenge tuple is selectable; labels use the
  // actual platform asset projection when it is available.
  const challenge = state.config?.challenge ?? null;
  const terms = challenge?.terms ?? null;
  const configuredAsset = terms !== null ? platformAsset(terms.assetId) : null;
  const assetSpecs: OptionSpec[] = terms === null
    ? []
    : [
        {
          value: terms.assetId,
          label: configuredAsset
            ? `${configuredAsset.symbol} — entry ${formatAtomic(terms.entryAtomic, configuredAsset.decimals)} / prize ${formatAtomic(terms.prizeAtomic, configuredAsset.decimals)}`
            : `${terms.assetId} — ${terms.entryAtomic} / ${terms.prizeAtomic} atomic units`,
        },
      ];
  assetSignature = syncSelect(
    els.challengeAsset,
    assetSpecs,
    assetSpecs
      .map((spec) => `${spec.value}:${configuredAsset?.symbol ?? ''}:${configuredAsset?.decimals ?? ''}:${configuredAsset?.status ?? ''}`)
      .join(','),
    assetSignature
  );

  const mode: RoomMode = els.createMode.value === 'CHALLENGE' ? 'CHALLENGE' : 'SPONSORED';
  setHidden(els.sponsoredFields, mode !== 'SPONSORED');
  setHidden(els.challengeFields, mode !== 'CHALLENGE');

  const platform = state.config?.platform;
  setText(els.createPlatformStatus, platform?.status ?? 'unavailable');
  els.createPlatformStatus.className = `chip${platform ? ` ${statusKind(platform.status)}` : ' warn'}`;

  clear(els.challengeTerms);
  if (mode === 'CHALLENGE' && terms !== null) {
    metaRow(
      els.challengeTerms,
      'Asset',
      configuredAsset ? `${configuredAsset.symbol} (${terms.assetId})` : terms.assetId
    );
    metaRow(
      els.challengeTerms,
      'Entry',
      configuredAsset ? formatAtomic(terms.entryAtomic, configuredAsset.decimals) : `${terms.entryAtomic} atomic units`
    );
    metaRow(
      els.challengeTerms,
      'Prize',
      configuredAsset ? formatAtomic(terms.prizeAtomic, configuredAsset.decimals) : `${terms.prizeAtomic} atomic units`
    );
    metaRow(
      els.challengeTerms,
      'Asset status',
      configuredAsset ? configuredAsset.status : 'metadata unavailable'
    );
    metaRow(els.challengeTerms, 'Terms version', terms.termsVersion);
    metaRow(
      els.challengeTerms,
      'Payment',
      'Creating the room does not charge anything; the entry is paid later with an explicit Pay entry action and only while the platform asset is ACTIVE.'
    );
  } else if (mode === 'CHALLENGE') {
    metaRow(els.challengeTerms, 'Terms', 'Challenge entry/prize terms are not configured.');
  }

  let note = '';
  let disabled = false;
  if (!state.principal) {
    note = 'Connect a wallet to create a room.';
    disabled = true;
  } else if (mode === 'CHALLENGE') {
    if (challenge === null || !challenge.enabled) {
      note = 'Challenge rooms are disabled by the server.';
      disabled = true;
    } else if (terms === null) {
      note = 'Challenge entry/prize terms are not configured.';
      disabled = true;
    } else if (!els.challengeAccept.checked) {
      note = 'Opt in to the entry and prize terms before creating a challenge.';
      disabled = true;
    }
  } else {
    const humans = Number.parseInt(els.sponsoredHumans.value, 10);
    const selectedAgents = Array.from(els.sponsoredAgents.selectedOptions).length;
    const total = (Number.isFinite(humans) ? humans : 0) + selectedAgents;
    if (!Number.isFinite(humans) || humans < 1) {
      note = 'The creating wallet claims one human seat.';
      disabled = true;
    } else if (total < 2 || total > 10) {
      note = 'Sponsored rooms need 2–10 total participants (humans + agents).';
      disabled = true;
    }
  }
  setText(els.createNote, note);
  setDisabled(els.createBtn, disabled);
}

function renderRoom(state: AppState): void {
  setHidden(els.roomCard, state.room === null);
  if (!state.room) return;
  const room = state.room;
  setText(els.roomTitle, room.name);
  setText(els.roomStatusChip, room.status);
  els.roomStatusChip.className = `chip ${statusKind(room.status)}`;

  clear(els.roomMeta);
  metaRow(els.roomMeta, 'Mode', room.mode);
  metaRow(els.roomMeta, 'Participants', `${room.humanCount} human · ${room.agentCount} agent · ${room.totalSeats} seats`);
  if (room.pokerTableId) metaRow(els.roomMeta, 'PokerTools table', room.pokerTableId);
  if (room.pokerCompetitionId) metaRow(els.roomMeta, 'PokerTools competition', room.pokerCompetitionId);
  if (room.failureReason) metaRow(els.roomMeta, 'Failure', room.failureReason);

  clear(els.roomRoster);
  if (room.participants.length === 0) {
    els.roomRoster.appendChild(el('p', { className: 'empty', text: 'No participants yet.' }));
  } else {
    for (const participant of room.participants) {
      const self = isSelf(state, participant);
      els.roomRoster.appendChild(
        el('div', { className: `roster-row${self ? ' self' : ''}` }, [
          el('span', { className: `kind ${participant.kind.toLowerCase()}`, text: participant.kind }),
          el('span', { className: 'roster-name', text: participant.name }),
          el('span', { className: 'roster-role muted', text: participantRole(participant) }),
          participant.seat !== null ? el('span', { className: 'chip tiny', text: `seat ${participant.seat + 1}` }) : null,
          self ? el('span', { className: 'chip tiny good', text: 'you' }) : null,
        ])
      );
    }
  }

  renderEntry(state, room);

  setDisabled(els.joinRoomBtn, state.principal === null);
  setDisabled(els.startRoomBtn, state.principal === null);
  setDisabled(els.roomRefreshBtn, state.roomLoading);
  setText(els.roomNote, state.roomError ?? (state.roomLoading ? 'Loading room…' : ''));
}

/**
 * CHALLENGE entry/prize panel. Terms come from the actual platform competition
 * when it is loaded; the room's immutable finance snapshot is shown until then.
 * Payment is always a separate, explicit Pay entry action.
 */
function renderEntry(state: AppState, room: RoomDetail): void {
  const isChallenge = room.mode === 'CHALLENGE';
  setHidden(els.roomFinance, !isChallenge);
  if (!isChallenge) {
    setHidden(els.payEntryBtn, true);
    setHidden(els.entryNote, true);
    return;
  }
  setHidden(els.entryNote, false);

  const competition = state.competition;
  const terms = competition?.terms ?? null;
  const finance = room.finance;
  clear(els.roomFinance);

  if (terms !== null) {
    metaRow(els.roomFinance, 'Entry', displayAmount(terms.entry.amountAtomic, terms.entry.assetId));
    metaRow(els.roomFinance, 'Prize', displayAmount(terms.prize.amountAtomic, terms.prize.assetId));
    const asset = platformAsset(terms.entry.assetId);
    metaRow(els.roomFinance, 'Asset status', asset === null ? 'metadata unavailable' : asset.status);
    metaRow(els.roomFinance, 'Competition', competition ? competition.status : '—');
    metaRow(els.roomFinance, 'Prize status', competition?.prizeStatus ?? '—');
  } else if (finance !== null) {
    metaRow(
      els.roomFinance,
      'Entry / prize',
      `${displayAmount(finance.entryAtomic, finance.assetId)} / ${displayAmount(finance.prizeAtomic, finance.assetId)}`
    );
    const asset = platformAsset(finance.assetId);
    metaRow(els.roomFinance, 'Asset status', asset === null ? 'metadata unavailable' : asset.status);
    metaRow(els.roomFinance, 'Terms version', finance.termsVersion);
  } else {
    metaRow(els.roomFinance, 'Entry / prize', 'No entry terms recorded for this room.');
  }
  if (state.platformAssetsLoading) metaRow(els.roomFinance, 'Asset metadata', 'Loading…');
  if (state.platformAssetsError !== null) {
    metaRow(els.roomFinance, 'Asset metadata', `Unavailable: ${state.platformAssetsError}`);
  }
  if (state.competitionLoading) metaRow(els.roomFinance, 'Competition', 'Loading…');
  if (state.competitionError) metaRow(els.roomFinance, 'Competition', state.competitionError);

  const principal = state.principal;
  const own =
    principal !== null && competition !== null
      ? competition.entrants.find((entrant) => entrant.principalId === principal.id) ?? null
      : null;
  const isPayer =
    principal !== null && terms !== null
      ? terms.entry.payers.some((payer) => payer.principalId === principal.id)
      : false;
  if (own !== null) metaRow(els.roomFinance, 'Your entry', own.entryState);

  // Consent is bound to the configured product terms; the actual platform
  // terms must match, and the real asset must be ACTIVE, before payment.
  const configured = state.config?.challenge.terms ?? null;
  const termsMatch =
    configured !== null &&
    terms !== null &&
    terms.entry.assetId === configured.assetId &&
    terms.entry.amountAtomic === configured.entryAtomic &&
    terms.prize.assetId === configured.assetId &&
    terms.prize.amountAtomic === configured.prizeAtomic;
  const asset = configured !== null ? platformAsset(configured.assetId) : null;
  const assetActive = asset !== null && asset.status === 'ACTIVE';

  const pending = isPayer && own !== null && own.entryState === 'PENDING';
  const canPay =
    pending && termsMatch && assetActive && room.status === 'PROVISIONING' && !state.payingEntry;
  setHidden(els.payEntryBtn, !pending);
  setDisabled(els.payEntryBtn, !canPay);
  setText(els.payEntryBtn, state.payingEntry ? 'Paying entry…' : 'Pay entry');

  let note: string;
  if (principal === null) {
    note = 'Sign in with the payer wallet to see and pay the entry.';
  } else if (state.competitionError !== null) {
    note = 'The platform competition could not be loaded; the entry state is unknown.';
  } else if (competition === null) {
    note = 'The platform competition appears once the room starts provisioning.';
  } else if (own === null) {
    note = 'This wallet is not an entrant of the platform competition.';
  } else if (own.entryState === 'PAID') {
    note = 'Entry paid on the platform. The room starts when the platform confirms the roster.';
  } else if (!isPayer) {
    note = 'This entrant has no entry obligation.';
  } else if (!termsMatch) {
    note = 'The platform terms do not match the configured product terms; payment is disabled.';
  } else if (asset === null) {
    note = 'Settlement asset metadata is unavailable; amounts are shown in atomic units and payment is disabled.';
  } else if (!assetActive) {
    note = `Settlement asset status is ${asset.status}; payment is disabled until it is ACTIVE.`;
  } else if (room.status === 'PROVISIONING') {
    note = 'Entry payment is required. It is charged only by the explicit Pay entry action, never at creation.';
  } else {
    note = 'The entry is pending; the room can provision once it is paid.';
  }
  setText(els.entryNote, note);
}

function renderTable(state: AppState): void {
  const room = state.room;
  const tableId = room?.pokerTableId ?? null;
  const visible =
    tableId !== null && (room === null || !roomIsTerminal(room.status) || state.observation !== null);
  setHidden(els.tableCard, !visible);
  if (!visible || !tableId) return;

  setText(els.tableConnection, `ws: ${state.socketStatus}${state.socketDetail ? ` · ${state.socketDetail}` : ''}`);
  els.tableConnection.dataset.socketStatus = state.socketStatus;
  els.tableConnection.className = `chip ${state.socketStatus === 'connected' ? 'good' : state.socketStatus === 'reconnecting' ? 'warn' : ''}`;
  setText(els.tableVersion, `v${state.observation?.version ?? '—'}`);

  renderBoard(state.observation);
  renderSeats(state.observation);
  renderTableMeta(state);
  renderActions(state);
}

function renderBoard(observation: SeatObservation | null): void {
  clear(els.board);
  const board = observation?.state.board ?? [];
  for (let index = 0; index < 5; index += 1) {
    const card = board[index];
    els.board.appendChild(
      el('span', {
        className: `card board-card${card ? '' : ' empty'}`,
        text: card ? formatCard(card) : '·',
      })
    );
  }
}

function renderSeats(observation: SeatObservation | null): void {
  clear(els.seats);
  if (!observation) {
    els.seats.appendChild(el('p', { className: 'empty', text: 'Waiting for the first authoritative observation…' }));
    return;
  }
  const state = observation.state;
  state.players.forEach((player, seat) => {
    if (player === null) {
      els.seats.appendChild(
        el('div', { className: 'seat empty' }, [el('span', { className: 'seat-index', text: `seat ${seat + 1}` })])
      );
      return;
    }
    const classes = ['seat'];
    if (state.actionTo === seat) classes.push('active');
    if (player.status === 'FOLDED') classes.push('folded');
    if (state.winners?.some((winner) => winner.seat === seat)) classes.push('winner');
    if (state.viewingPlayerId === player.id) classes.push('viewer');

    const hand = player.hand && player.hand.length > 0 ? player.hand : [null, null];
    const cards = el('div', { className: 'cards' });
    for (const card of hand) {
      cards.appendChild(
        el('span', { className: `card small${card ? '' : ' back'}`, text: card ? formatCard(card) : '🂠' })
      );
    }

    els.seats.appendChild(
      el('div', { className: classes.join(' ') }, [
        el('div', { className: 'seat-head' }, [
          el('span', { className: 'seat-name', text: player.name }),
          el('span', { className: 'seat-stack', text: `${safeChips(player.stack)} chips` }),
        ]),
        cards,
        player.betThisStreet > 0
          ? el('div', { className: 'seat-line muted', text: `bet ${safeChips(player.betThisStreet)}` })
          : null,
        el('div', { className: 'seat-line muted', text: player.status }),
      ])
    );
  });
}

function renderTableMeta(state: AppState): void {
  clear(els.tableMeta);
  const observation = state.observation;
  if (!observation) {
    metaRow(els.tableMeta, 'Table', state.room?.pokerTableId ?? '—');
    return;
  }
  const wire = observation.state;
  metaRow(els.tableMeta, 'Table', observation.tableId);
  metaRow(els.tableMeta, 'Street', `${getStreetName(wire.street)} · hand ${wire.handNumber}`);
  metaRow(els.tableMeta, 'Pot', getTotalPot(wire));
  metaRow(els.tableMeta, 'Blinds', `${safeChips(wire.smallBlind)} / ${safeChips(wire.bigBlind)}`);
  metaRow(els.tableMeta, 'Version', `${observation.version} · event ${observation.eventSeq}`);
}

function renderActions(state: AppState): void {
  const observation = state.observation;
  const legal: LegalAction[] = observation?.legalActions ?? [];
  const signature = observation
    ? `${observation.tableId}:${observation.turnId}:${observation.version}:${legal
        .map((action) => action.actionId)
        .join(',')}`
    : '';

  if (signature !== turnSignature) {
    turnSignature = signature;
    clear(els.legalActions);
    actionButtons = [];
    amountInputs = [];

    for (const action of legal) {
      if (CHIP_FAMILIES.has(action.family)) {
        const input = el('input', { className: 'amount-input' });
        input.type = 'number';
        input.step = '1';
        input.inputMode = 'numeric';
        input.setAttribute('aria-label', `${action.family} amount`);
        if (action.minAmount !== undefined) input.min = String(action.minAmount);
        if (action.maxAmount !== undefined) input.max = String(action.maxAmount);
        const initial = action.amount ?? action.minAmount;
        if (initial !== undefined) input.value = String(initial);

        const button = el('button', { className: 'btn primary small' });
        button.type = 'button';
        setText(button, `${FAMILY_LABELS[action.family] ?? action.family}`);
        button.addEventListener('click', () => {
          const parsed = Number.parseInt(input.value, 10);
          if (!Number.isFinite(parsed)) {
            actions.notify('error', 'Enter a whole-chip amount.');
            return;
          }
          if (action.minAmount !== undefined && parsed < action.minAmount) {
            actions.notify('error', `Minimum is ${safeChips(action.minAmount)}.`);
            return;
          }
          if (action.maxAmount !== undefined && parsed > action.maxAmount) {
            actions.notify('error', `Maximum is ${safeChips(action.maxAmount)}.`);
            return;
          }
          actions.submitAction(action.actionId, parsed);
        });
        actionButtons.push(button);
        amountInputs.push(input);

        const bounds =
          action.minAmount !== undefined || action.maxAmount !== undefined
            ? ` (${action.amount !== undefined ? safeChips(action.amount) : `${safeChips(action.minAmount ?? 0)}–${safeChips(action.maxAmount ?? 0)}`})`
            : '';
        els.legalActions.appendChild(
          el('div', { className: 'action-group' }, [
            el('span', { className: 'action-label muted', text: `${FAMILY_LABELS[action.family] ?? action.family}${bounds}` }),
            input,
            button,
          ])
        );
      } else {
        const button = el('button', { className: 'btn primary small' });
        button.type = 'button';
        setText(button, FAMILY_LABELS[action.family] ?? action.family);
        button.addEventListener('click', () => actions.submitAction(action.actionId));
        actionButtons.push(button);
        els.legalActions.appendChild(button);
      }
    }
  }

  for (const button of actionButtons) setDisabled(button, state.busy);
  for (const input of amountInputs) setDisabled(input, state.busy);

  if (legal.length === 0) {
    setText(
      els.turnLine,
      state.room && roomIsLive(state.room.status)
        ? 'Waiting for the server to issue a turn…'
        : 'The table is not running yet.'
    );
    return;
  }

  const actor = observation ? getActivePlayer(observation.state) : null;
  setText(
    els.turnLine,
    state.busy
      ? 'Submitting your action…'
      : `Your turn${actor ? ` — ${actor.name} to act` : ''}: choose a server-issued action.`
  );
}

function renderChat(state: AppState): void {
  const tableId = state.room?.pokerTableId ?? null;
  setHidden(els.chatCard, tableId === null);
  if (!tableId) return;

  const nearBottom =
    els.chatLog.scrollTop + els.chatLog.clientHeight >= els.chatLog.scrollHeight - 24;

  clear(els.chatLog);
  if (state.chatError) {
    els.chatLog.appendChild(el('p', { className: 'empty error', text: state.chatError }));
  } else if (state.chat.length === 0) {
    els.chatLog.appendChild(el('p', { className: 'empty', text: 'No messages yet.' }));
  } else {
    for (const message of state.chat) {
      els.chatLog.appendChild(chatRow(message));
    }
  }
  if (nearBottom) els.chatLog.scrollTop = els.chatLog.scrollHeight;

  setHidden(els.olderChatBtn, state.chatCursor === null);

  const running = state.room !== null && roomIsLive(state.room.status);
  const canChat = Boolean(state.principal && tableId && running && !state.chatSending);
  setDisabled(els.chatInput, !canChat);
  setDisabled(els.chatSendBtn, !canChat);
  setText(
    els.chatNote,
    state.chatSending
      ? 'Sending…'
      : !state.principal
        ? 'Sign in to chat.'
        : !running
          ? 'Chat is available while the table is running.'
          : 'Chat is public and plain text; the server enforces length and rate limits.'
  );
}

function chatRow(message: ChatMessage): HTMLElement {
  return el('div', { className: 'chat-message' }, [
    el('span', { className: 'chat-sender', text: shortId(message.principalId) }),
    el('span', { className: 'chat-body', text: message.body }),
    el('span', { className: 'chat-time muted', text: clock(message.sentAt) }),
  ]);
}

function renderReplay(state: AppState): void {
  const tableId = state.room?.pokerTableId ?? null;
  setHidden(els.replayCard, tableId === null);
  if (!tableId) return;

  clear(els.results);
  const results = state.room?.results ?? null;
  if (results && results.length > 0) {
    const sorted = [...results].sort((a, b) => a.finishPosition - b.finishPosition);
    for (const result of sorted) {
      els.results.appendChild(
        el('div', { className: 'roster-row' }, [
          el('span', { className: 'chip tiny', text: `#${result.finishPosition}` }),
          el('span', { className: 'roster-name', text: result.name }),
          el('span', { className: 'kind ' + result.kind.toLowerCase(), text: result.kind }),
        ])
      );
    }
  } else {
    els.results.appendChild(
      el('p', {
        className: 'empty',
        text: 'No result projection yet. Load the replay for the authoritative server event log.',
      })
    );
  }

  clear(els.replayMeta);
  if (state.replayError) {
    metaRow(els.replayMeta, 'Replay', state.replayError);
  } else if (state.replay) {
    metaRow(els.replayMeta, 'Chain valid', state.replay.chainValid ? 'yes' : 'no');
    metaRow(els.replayMeta, 'Events', `${state.replay.fromEventSeq}–${state.replay.toEventSeq} of ${state.replay.headEventSeq}`);
  } else {
    metaRow(els.replayMeta, 'Replay', state.replayLoading ? 'Loading…' : 'Not loaded');
  }

  clear(els.replayLog);
  if (!state.replay) return;
  for (const event of state.replay.events) {
    const correlation =
      event.turnId || event.requestId || event.actionId
        ? ` · turn ${shortId(event.turnId ?? null)} · request ${shortId(event.requestId ?? null)} · action ${shortId(event.actionId ?? null)}`
        : '';
    els.replayLog.appendChild(
      el('div', { className: 'replay-row' }, [
        el('div', { className: 'replay-head' }, [
          el('span', { className: 'chip tiny', text: `#${event.eventSeq}` }),
          el('span', { className: 'replay-type', text: event.type }),
          el('span', { className: 'muted small', text: `v${event.version} · ${clock(event.occurredAt)}${correlation}` }),
        ]),
        el('div', { className: 'replay-payload mono muted', text: publishablePayload(event.payload) }),
      ])
    );
  }
  const tournamentEvents = state.replay.tournamentEvents ?? [];
  for (const event of tournamentEvents) {
    els.replayLog.appendChild(
      el('div', { className: 'replay-row' }, [
        el('div', { className: 'replay-head' }, [
          el('span', { className: 'chip tiny', text: `#${event.eventSeq}` }),
          el('span', { className: 'replay-type', text: event.type }),
          el('span', { className: 'muted small', text: clock(event.occurredAt) }),
        ]),
        el('div', { className: 'replay-payload mono muted', text: publishablePayload(event.payload) }),
      ])
    );
  }
}

function renderStats(state: AppState): void {
  clear(els.statsList);
  if (state.statsError) {
    metaRow(els.statsList, 'Stats', state.statsError);
    return;
  }
  const stats = state.stats;
  if (!stats) {
    metaRow(els.statsList, 'Stats', state.statsLoading ? 'Loading…' : 'Not loaded');
    return;
  }
  metaRow(
    els.statsList,
    'Platform',
    `${stats.platform.status}${stats.platform.reason ? ` — ${stats.platform.reason}` : ''}`
  );
  metaRow(
    els.statsList,
    'Rooms',
    `total ${stats.rooms.total} · open ${stats.rooms.open} · running ${stats.rooms.running} · finished ${stats.rooms.finished}`
  );
  metaRow(
    els.statsList,
    'Games',
    `total ${stats.games.total} · running ${stats.games.running} · finished ${stats.games.finished}`
  );
  metaRow(els.statsList, 'Humans', stats.humans);
  metaRow(els.statsList, 'Agents', stats.agents);

  if (stats.models.length === 0) {
    metaRow(els.statsList, 'Models', 'No recorded model metrics.');
  } else {
    for (const model of stats.models) {
      metaRow(
        els.statsList,
        model.agentId,
        `${model.games} games · ${model.wins} wins · ${model.calls} calls · ${model.inputTokens + model.outputTokens} tokens · ${model.costUsdMicro} µUSD · ${model.latencyMs} ms`
      );
    }
  }
}

/** Reset per-table render caches (called when the selected room changes). */
export function resetTableRender(): void {
  turnSignature = '';
  actionButtons = [];
  amountInputs = [];
}
