/**
 * Focused regression for the browser driver's server-issued action picker.
 *
 * The picker only ever selects among controls the product rendered (so the
 * canonical server `actionId` is echoed, never invented). The pre-reload
 * driver must size conservatively (`minimum`) so the human cannot force an
 * instant all-in terminal before the agent-commit/reload window exists; the
 * completion driver keeps the existing `maximum` behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  actionCadenceElapsed,
  classifyTerminalContinuation,
  parseTableVersion,
  pickUiAction,
  tableVersionReady,
  UI_ACTION_CADENCE_MS,
  UI_BETTING_LABEL_SOURCE,
  uiActionReady,
  type UiActionControl,
} from '../browser/ui.js';

function control(overrides: Partial<UiActionControl> & { label: string }): UiActionControl {
  return { min: null, max: null, disabled: false, ...overrides };
}

describe('pre-reload conservative picker (minimum)', () => {
  it('prefers Check over Call and over a bounded chip control', () => {
    const controls = [
      control({ label: 'Raise (4–100)', min: 4, max: 100 }),
      control({ label: 'Call (4)' }),
      control({ label: 'Check' }),
      control({ label: 'Fold' }),
    ];
    expect(pickUiAction(controls, 'minimum')).toEqual({ index: 2 });
  });

  it('prefers Call when Check is not legal', () => {
    const controls = [
      control({ label: 'Raise (4–100)', min: 4, max: 100 }),
      control({ label: 'Call (4)' }),
      control({ label: 'Fold' }),
    ];
    expect(pickUiAction(controls, 'minimum')).toEqual({ index: 1 });
  });

  it('uses the minimum legal Bet/Raise (never the maximum) when no Check/Call exists', () => {
    const controls = [control({ label: 'Bet (2–100)', min: 2, max: 100 }), control({ label: 'Fold' })];
    expect(pickUiAction(controls, 'minimum')).toEqual({ index: 0, amount: 2 });
    const raise = [control({ label: 'Raise (8–200)', min: 8, max: 200 })];
    expect(pickUiAction(raise, 'minimum')).toEqual({ index: 0, amount: 8 });
  });

  it('folds only when nothing else is offered', () => {
    expect(pickUiAction([control({ label: 'Fold' })], 'minimum')).toEqual({ index: 0 });
    expect(
      pickUiAction(
        [control({ label: 'Check', disabled: true }), control({ label: 'Fold' })],
        'minimum'
      )
    ).toEqual({ index: 1 });
  });

  it('skips disabled controls and returns null when none are enabled', () => {
    expect(
      pickUiAction(
        [control({ label: 'Check', disabled: true }), control({ label: 'Call', disabled: false })],
        'minimum'
      )
    ).toEqual({ index: 1 });
    expect(pickUiAction([control({ label: 'Check', disabled: true })], 'minimum')).toBeNull();
    expect(pickUiAction([], 'minimum')).toBeNull();
  });
});

describe('completion picker (maximum)', () => {
  it('sizes the first enabled chip control at its maximum legal amount', () => {
    const controls = [
      control({ label: 'Raise (4–100)', min: 4, max: 100 }),
      control({ label: 'Bet (2–50)', min: 2, max: 50 }),
      control({ label: 'Call (4)' }),
    ];
    expect(pickUiAction(controls, 'maximum')).toEqual({ index: 0, amount: 100 });
  });

  it('keeps the UI default amount when the chip control is unbounded', () => {
    expect(pickUiAction([control({ label: 'Bet (2–50)', min: 2, max: null })], 'maximum')).toEqual({
      index: 0,
      amount: undefined,
    });
  });

  it('falls back to the first enabled Check/Call/Fold in document order', () => {
    const controls = [control({ label: 'Fold' }), control({ label: 'Call (4)' }), control({ label: 'Check' })];
    expect(pickUiAction(controls, 'maximum')).toEqual({ index: 0 });
  });

  it('skips disabled chip controls and returns null when none are enabled', () => {
    expect(
      pickUiAction(
        [
          control({ label: 'Raise (4–100)', min: 4, max: 100, disabled: true }),
          control({ label: 'Bet (2–50)', min: 2, max: 50 }),
        ],
        'maximum'
      )
    ).toEqual({ index: 1, amount: 50 });
    expect(pickUiAction([control({ label: 'Call (4)', disabled: true })], 'maximum')).toBeNull();
  });

  it('never selects a non-legal rendered control', () => {
    expect(pickUiAction([control({ label: 'Sit out' })], 'maximum')).toBeNull();
    expect(pickUiAction([control({ label: 'Sit out' })], 'minimum')).toBeNull();
  });
});

describe('deterministic fold picker (fold)', () => {
  it('prefers the first enabled Fold even when Check/Call/Raise are offered', () => {
    const controls = [
      control({ label: 'Check' }),
      control({ label: 'Fold' }),
      control({ label: 'Raise (4–100)', min: 4, max: 100 }),
    ];
    expect(pickUiAction(controls, 'fold')).toEqual({ index: 1 });
  });

  it('returns null when no enabled Fold control is rendered', () => {
    expect(pickUiAction([control({ label: 'Check' })], 'fold')).toBeNull();
    expect(pickUiAction([control({ label: 'Fold', disabled: true })], 'fold')).toBeNull();
    expect(pickUiAction([control({ label: 'Deal' })], 'fold')).toBeNull();
    expect(pickUiAction([], 'fold')).toBeNull();
  });

  it('is ready under the fold policy exactly when a Fold control exists', () => {
    expect(uiActionReady([control({ label: 'Fold' })], 'fold')).toBe(true);
    expect(uiActionReady([control({ label: 'Check' })], 'fold')).toBe(false);
    expect(uiActionReady([control({ label: 'Deal' })], 'fold')).toBe(false);
  });
});

describe('canonical human action readiness (pure control selection)', () => {
  it('is not ready for the SHOWDOWN intermission DEAL menu', () => {
    // The product renders `Your turn` while the only legal control is DEAL;
    // that is not a betting turn and must never be treated as one.
    expect(uiActionReady([control({ label: 'Deal' })], 'minimum')).toBe(false);
    expect(uiActionReady([control({ label: 'Deal' })], 'maximum')).toBe(false);
  });

  it('is ready for an enabled server-issued betting control under both sizings', () => {
    for (const label of ['Check', 'Call (4)', 'Bet (2–50)', 'Raise (8–200)', 'Fold']) {
      expect(uiActionReady([control({ label })], 'minimum')).toBe(true);
      expect(uiActionReady([control({ label })], 'maximum')).toBe(true);
    }
  });

  it('is not ready when betting controls are disabled or only non-betting controls render', () => {
    expect(uiActionReady([control({ label: 'Check', disabled: true })], 'minimum')).toBe(false);
    expect(
      uiActionReady([control({ label: 'Deal' }), control({ label: 'Call', disabled: true })], 'minimum')
    ).toBe(false);
    expect(uiActionReady([control({ label: 'Sit out' })], 'maximum')).toBe(false);
    expect(uiActionReady([], 'minimum')).toBe(false);
  });

  it('is sizing-independent, so the page-side readiness wait needs no sizing', () => {
    const menus: UiActionControl[][] = [
      [control({ label: 'Deal' })],
      [control({ label: 'Check' })],
      [control({ label: 'Fold' })],
      [control({ label: 'Check', disabled: true })],
      [],
    ];
    for (const menu of menus) {
      expect(uiActionReady(menu, 'minimum')).toBe(uiActionReady(menu, 'maximum'));
    }
  });

  it('shares one betting-label source with the page-side readiness wait', () => {
    const betting = new RegExp(UI_BETTING_LABEL_SOURCE, 'i');
    for (const label of ['Check', 'Call (4)', 'Bet (2–50)', 'Raise (8–200)', 'Fold']) {
      expect(betting.test(label)).toBe(true);
    }
    expect(betting.test('Deal')).toBe(false);
  });
});

describe('authoritative table version readiness (pure)', () => {
  it('is not ready before the JOIN observation: placeholder or missing version', () => {
    // Socket connected but no observation yet: the product renders `v—`.
    expect(tableVersionReady('v—')).toBe(false);
    expect(tableVersionReady('')).toBe(false);
    expect(tableVersionReady(null)).toBe(false);
    expect(tableVersionReady(undefined)).toBe(false);
    // `v0` is not a positive authoritative version either.
    expect(tableVersionReady('v0')).toBe(false);
  });

  it('is ready only for a real positive authoritative version', () => {
    expect(tableVersionReady('v1')).toBe(true);
    expect(tableVersionReady(' v42 ')).toBe(true);
    expect(parseTableVersion('v7')).toBe(7);
    expect(parseTableVersion('v—')).toBeNull();
    expect(parseTableVersion('')).toBeNull();
  });
});

describe('browser action submission cadence (acceptance only)', () => {
  it('allows the first successful browser action immediately', () => {
    expect(actionCadenceElapsed(null, 1_000)).toBe(true);
  });

  it('blocks rapid successful submissions until the 2.5s window elapses', () => {
    expect(UI_ACTION_CADENCE_MS).toBe(2_500);
    // A fast deterministic provider can fold hands in milliseconds; without the
    // gate the UI driver re-submitted every ~200ms.
    expect(actionCadenceElapsed(10_000, 10_000 + 2_499)).toBe(false);
    expect(actionCadenceElapsed(10_000, 10_000 + 2_500)).toBe(true);
    expect(actionCadenceElapsed(10_000, 10_000 + 30_000)).toBe(true);
  });

  it('honors an injected short cadence for bounded tests', () => {
    expect(actionCadenceElapsed(10_000, 10_079, 80)).toBe(false);
    expect(actionCadenceElapsed(10_000, 10_080, 80)).toBe(true);
    expect(actionCadenceElapsed(0, 79, 80)).toBe(false);
    expect(actionCadenceElapsed(0, 80, 80)).toBe(true);
  });
});

describe('post-reconnect terminal continuation contract', () => {
  const base = {
    reconnectedAt: 5_000,
    humanActionTimes: [5_400],
    agentCommittedAtReload: 1,
    agentCommittedFinal: 1,
    roomStatus: 'COMPLETE',
  };

  it('proves the human-terminal branch when a post-reconnect human call ends the room', () => {
    // A legitimate final human call busted the opponent; no additional AI turn
    // is possible, so no extra agent COMMIT is required.
    expect(classifyTerminalContinuation(base)).toMatchObject({
      branch: 'human-terminal-continuation',
      humanContinuedAt: 5_400,
      continuedAgent: false,
    });
  });

  it('classifies agent continuation when the agent also committed after reconnect', () => {
    expect(
      classifyTerminalContinuation({ ...base, agentCommittedFinal: 2 })
    ).toMatchObject({ branch: 'agent-continuation', continuedAgent: true });
  });

  it('never accepts continuation without a strictly post-reconnect human action', () => {
    expect(classifyTerminalContinuation({ ...base, humanActionTimes: [4_999] })).toMatchObject({
      branch: 'insufficient-continuation',
      humanContinuedAt: null,
      reason: expect.stringMatching(/strictly after the reconnect/),
    });
    // Exactly at the reconnect instant is still not strictly after it.
    expect(
      classifyTerminalContinuation({ ...base, humanActionTimes: [5_000] }).branch
    ).toBe('insufficient-continuation');
    // An agent-only continuation after reconnect does not prove canonical
    // human play continued.
    expect(
      classifyTerminalContinuation({
        ...base,
        humanActionTimes: [],
        agentCommittedFinal: 3,
      }).branch
    ).toBe('insufficient-continuation');
  });

  it('requires the authoritative room to be COMPLETE', () => {
    expect(
      classifyTerminalContinuation({ ...base, roomStatus: 'ACTIVE' })
    ).toMatchObject({
      branch: 'insufficient-continuation',
      reason: expect.stringMatching(/room status ACTIVE != COMPLETE/),
    });
  });
});
