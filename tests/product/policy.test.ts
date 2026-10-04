import { describe, expect, it } from 'vitest';

import {
  assertParticipantAllowed,
  assertRosterSatisfiesPolicy,
  resolveProductPolicy,
  type PolicyParticipant,
  type ProductPolicy,
} from '../../src/product/policy.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const human = (principalId: string): PolicyParticipant => ({ kind: 'HUMAN', principalId });
const agent = (agentId: string): PolicyParticipant => ({ kind: 'AGENT', agentId, principalId: `svc:${agentId}` });

function sponsored(participants: PolicyParticipant[]): ProductPolicy {
  return resolveProductPolicy({ kind: 'SPONSORED', participants });
}

function challenge(participants: PolicyParticipant[], finance?: unknown): ProductPolicy {
  return resolveProductPolicy({ kind: 'CHALLENGE', participants, finance } as never);
}

describe('SPONSORED policy', () => {
  it('accepts 2..10 seats of any HUMAN/AGENT mix and forbids finance terms', () => {
    const policy = sponsored([human('u:1'), agent('a-1'), human('u:2')]);
    expect(policy).toMatchObject({
      kind: 'SPONSORED',
      seatCount: 3,
      humanCount: 2,
      agentCount: 1,
      finance: null,
    });
    expect(sponsored(Array.from({ length: 10 }, (_, index) => agent(`a-${index}`))).seatCount).toBe(10);
    expect(sponsored([]).seatCount).toBe(0); // partial DRAFT roster envelope

    expect(
      codeOf(() =>
        resolveProductPolicy({
          kind: 'SPONSORED',
          participants: [human('u:1')],
          finance: { optIn: true, entryAtomic: '1', prizeAtomic: '1', assetId: 'eip155:1/erc20:0x1' },
        } as never),
      ),
    ).toBe('FINANCE_NOT_ALLOWED');
    expect(
      codeOf(() => sponsored(Array.from({ length: 11 }, (_, index) => agent(`a-${index}`)))),
    ).toBe('SEAT_COUNT');
  });

  it('rejects an 11th participant addition and requires 2..10 to provision', () => {
    const seats = Array.from({ length: 10 }, (_, index) => agent(`a-${index}`));
    const full = sponsored(seats);
    expect(codeOf(() => assertParticipantAllowed(full, seats, agent('a-11')))).toBe('SEAT_COUNT');

    const single = sponsored([human('u:1')]);
    expect(codeOf(() => assertRosterSatisfiesPolicy(single, [human('u:1')]))).toBe('SEAT_COUNT');
    expect(() => assertRosterSatisfiesPolicy(single, [human('u:1'), agent('a-1')])).not.toThrow();
  });
});

describe('CHALLENGE policy', () => {
  it('accepts exactly one HUMAN plus 1..9 AGENTs', () => {
    expect(
      challenge([
        human('u:1'),
        ...Array.from({ length: 9 }, (_, index) => agent(`a-${index}`)),
      ]),
    ).toMatchObject({ kind: 'CHALLENGE', seatCount: 10, humanCount: 1, agentCount: 9 });

    expect(challenge([human('u:1'), agent('a-1')])).toMatchObject({ humanCount: 1, agentCount: 1 });

    // Partial roster envelope while WAITING_FOR_ROSTER, final rule checked separately.
    const waiting = challenge([human('u:1')]);
    expect(codeOf(() => assertRosterSatisfiesPolicy(waiting, [human('u:1')]))).toBe('AGENT_COUNT');
    expect(
      codeOf(() => assertParticipantAllowed(waiting, [human('u:1')], human('u:2'))),
    ).toBe('HUMAN_COUNT');
    const fullChallenge = [human('u:1'), ...Array.from({ length: 9 }, (_, index) => agent(`a-${index}`))];
    expect(
      codeOf(() => assertParticipantAllowed(challenge(fullChallenge), fullChallenge, agent('a-extra'))),
    ).toBe('AGENT_COUNT');

    expect(codeOf(() => challenge([human('u:1'), human('u:2'), agent('a-1')]))).toBe('HUMAN_COUNT');
    expect(
      codeOf(() => challenge([human('u:1'), ...Array.from({ length: 10 }, (_, index) => agent(`a-${index}`))])),
    ).toBe('AGENT_COUNT');
  });

  it('accepts only explicitly opted-in atomic finance terms', () => {
    const terms = challenge([human('u:1'), agent('a-1')], {
      optIn: true,
      entryAtomic: '1000000',
      prizeAtomic: '5000000',
      assetId: 'eip155:31337/erc20:0x1111111111111111111111111111111111111111',
    });
    expect(terms.finance).toEqual({
      entryAtomic: '1000000',
      prizeAtomic: '5000000',
      assetId: 'eip155:31337/erc20:0x1111111111111111111111111111111111111111',
    });
    expect(challenge([human('u:1'), agent('a-1')]).finance).toBeNull();

    const base = { entryAtomic: '1', prizeAtomic: '1', assetId: 'eip155:1/erc20:0x1' };
    expect(codeOf(() => challenge([human('u:1'), agent('a-1')], { ...base }))).toBe(
      'FINANCE_OPT_IN_REQUIRED',
    );
    expect(codeOf(() => challenge([human('u:1'), agent('a-1')], { ...base, optIn: false }))).toBe(
      'FINANCE_OPT_IN_REQUIRED',
    );
    for (const entryAtomic of ['0', '1.5', '-1', '01', 'abc']) {
      expect(codeOf(() => challenge([human('u:1'), agent('a-1')], { ...base, optIn: true, entryAtomic }))).toBe(
        'ATOMIC_AMOUNT',
      );
    }
    expect(
      codeOf(() => challenge([human('u:1'), agent('a-1')], { ...base, optIn: true, assetId: '' })),
    ).toBe('ASSET_ID');
    expect(
      codeOf(() => challenge([human('u:1'), agent('a-1')], { ...base, optIn: true, assetId: 'bad asset' })),
    ).toBe('ASSET_ID');
  });

  it('rejects malformed participants', () => {
    expect(codeOf(() => challenge([{ kind: 'AGENT' } as never, human('u:1')]))).toBe('INVALID_PARTICIPANT');
    expect(codeOf(() => challenge([{ kind: 'HUMAN', agentId: 'a-1', principalId: 'u:1' }]))).toBe(
      'INVALID_PARTICIPANT',
    );
    expect(codeOf(() => resolveProductPolicy({ kind: 'OTHER', participants: [] } as never))).toBe(
      'INVALID_KIND',
    );
  });
});
