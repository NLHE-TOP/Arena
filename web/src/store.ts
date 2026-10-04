/**
 * Tiny observable application store.
 *
 * Views read immutable snapshots; the controller mutates state through
 * `setState` and a single `render` listener repaints the page. No framework,
 * no two-way binding, no hidden backend state.
 */

import type { Asset, ChatMessage, Competition, ReplayFrame, SeatObservation } from '@pokertools/sdk';
import type {
  AgentSummary,
  ProductConfig,
  ProductStats,
  RoomDetail,
  RoomSummary,
} from './product-api';
import type { PrincipalLike } from './auth';
import type { SocketStatus } from './sdk';

export type NoticeKind = 'info' | 'success' | 'error';

export interface Notice {
  kind: NoticeKind;
  text: string;
}

export interface AppState {
  /** Product API `/api/config`. */
  config: ProductConfig | null;
  configError: string | null;

  agents: AgentSummary[];
  agentsError: string | null;

  rooms: RoomSummary[];
  roomsLoading: boolean;
  roomsError: string | null;

  room: RoomDetail | null;
  roomLoading: boolean;
  roomError: string | null;

  /** Latest authoritative per-seat observation from the SDK socket. */
  observation: SeatObservation | null;
  socketStatus: SocketStatus;
  socketDetail: string;

  /** Actual platform competition projection for a CHALLENGE room. */
  competition: Competition | null;
  competitionLoading: boolean;
  competitionError: string | null;
  /** One explicit Pay entry opt-in in flight. */
  payingEntry: boolean;

  /**
   * Read-only browser projection of the platform's actual finance assets
   * (`PokerClient.getAssets()`). This is the only source of symbol/decimals;
   * product config placeholders are never used for money display.
   */
  platformAssets: Asset[];
  platformAssetsLoading: boolean;
  platformAssetsError: string | null;

  /** Authenticated PokerTools identity (verified with getPrincipal()). */
  principal: PrincipalLike | null;
  walletAddress: string | null;
  connecting: boolean;
  /** One canonical action submission in flight (disables re-entry). */
  busy: boolean;

  chat: ChatMessage[];
  chatCursor: number | null;
  chatSending: boolean;
  chatError: string | null;

  replay: ReplayFrame | null;
  replayLoading: boolean;
  replayError: string | null;

  stats: ProductStats | null;
  statsLoading: boolean;
  statsError: string | null;

  notice: Notice | null;
}

export const initialState: AppState = {
  config: null,
  configError: null,

  agents: [],
  agentsError: null,

  rooms: [],
  roomsLoading: false,
  roomsError: null,

  room: null,
  roomLoading: false,
  roomError: null,

  observation: null,
  socketStatus: 'idle',
  socketDetail: 'off',

  competition: null,
  competitionLoading: false,
  competitionError: null,
  payingEntry: false,

  platformAssets: [],
  platformAssetsLoading: false,
  platformAssetsError: null,

  principal: null,
  walletAddress: null,
  connecting: false,
  busy: false,

  chat: [],
  chatCursor: null,
  chatSending: false,
  chatError: null,

  replay: null,
  replayLoading: false,
  replayError: null,

  stats: null,
  statsLoading: false,
  statsError: null,

  notice: null,
};

export const state: AppState = { ...initialState };

type Listener = (state: AppState) => void;
const listeners: Listener[] = [];

/** Merge a partial update (undefined values are ignored by callers). */
export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  for (const listener of listeners) listener(state);
}

export function subscribe(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
}
