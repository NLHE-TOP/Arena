/**
 * Focused unit coverage for the acceptance-only read-only exactly-once journal
 * evidence helper (`tests/integration/acceptance/financial-journals.ts`).
 *
 * Every case injects a synthetic `AcceptanceSqlQuery`; no database, no
 * platform, no provider and no product code is involved. The fixtures mirror
 * the actual pinned PokerTools 2.0.0 operational journal identities and posting
 * classes.
 */
import { describe, expect, it } from 'vitest';
import {
  assertExactlyOnceFinancialJournals,
  assertExactlyOnceFinancialJournalsAcrossRestart,
  assertFinancialJournalEvidenceUnchanged,
  captureFinancialJournalEvidence,
  financialJournalEvidenceFingerprint,
  financialJournalEvidenceSql,
  type AcceptanceSqlQuery,
  type CompetitionEntrantEvidence,
  type CompetitionEvidence,
  type FinancialJournalEvidence,
  type JournalEvidence,
  type JournalPostingEvidence,
} from '../integration/acceptance/financial-journals.js';

const ASSET = 'eip155:31337/erc20:0x5fbdb2315678afecb367f032d93f642f64180aa3';
const COMPETITION = 'comp-1';
const PAYER = 'payer-1';
const SERVICE = 'service-1';
const SPONSOR = 'sponsor-1';
const ENTRY_ATOMIC = '5';
const PRIZE_ATOMIC = '20';

const ENTRY_ID = `competition-entry-reserve:${COMPETITION}:${PAYER}`;
const RELEASE_ID = `competition-entry-release:${COMPETITION}:${PAYER}`;
const RESERVE_ID = `competition-prize-reserve:${COMPETITION}`;
const SETTLEMENT_ID = `competition-prize-settlement:${COMPETITION}`;
const ENTRY_RESERVE = `competition-entry:${COMPETITION}`;
const PRIZE_RESERVE = `competition-prize:${COMPETITION}`;

const PAYER_ACCOUNT = 'acct-payer-available';
const SPONSOR_ACCOUNT = 'acct-sponsor-operator';

function posting(
  ownerId: string,
  accountClass: string,
  amountAtomic: string,
  accountId: string
): JournalPostingEvidence {
  return { accountId, assetId: ASSET, class: accountClass, ownerId, amountAtomic };
}

function entryJournal(): JournalEvidence {
  return {
    id: 'jt-entry',
    requestId: ENTRY_ID,
    assetId: ASSET,
    sealed: true,
    postings: [
      posting(PAYER, 'USER_AVAILABLE', `-${ENTRY_ATOMIC}`, PAYER_ACCOUNT),
      posting(ENTRY_RESERVE, 'TOURNAMENT_RESERVE', ENTRY_ATOMIC, 'acct-entry-reserve'),
    ],
  };
}

function releaseJournal(): JournalEvidence {
  return {
    id: 'jt-release',
    requestId: RELEASE_ID,
    assetId: ASSET,
    sealed: true,
    postings: [
      posting(ENTRY_RESERVE, 'TOURNAMENT_RESERVE', `-${ENTRY_ATOMIC}`, 'acct-entry-reserve'),
      posting(SPONSOR, 'OPERATOR', ENTRY_ATOMIC, SPONSOR_ACCOUNT),
    ],
  };
}

function reserveJournal(): JournalEvidence {
  return {
    id: 'jt-reserve',
    requestId: RESERVE_ID,
    assetId: ASSET,
    sealed: true,
    postings: [
      posting(SPONSOR, 'OPERATOR', `-${PRIZE_ATOMIC}`, SPONSOR_ACCOUNT),
      posting(PRIZE_RESERVE, 'TOURNAMENT_RESERVE', PRIZE_ATOMIC, 'acct-prize-reserve'),
    ],
  };
}

function settlementJournal(released: boolean): JournalEvidence {
  return {
    id: 'jt-settlement',
    requestId: SETTLEMENT_ID,
    assetId: ASSET,
    sealed: true,
    postings: [
      posting(PRIZE_RESERVE, 'TOURNAMENT_RESERVE', `-${PRIZE_ATOMIC}`, 'acct-prize-reserve'),
      released
        ? posting(SPONSOR, 'OPERATOR', PRIZE_ATOMIC, SPONSOR_ACCOUNT)
        : posting(PAYER, 'USER_AVAILABLE', PRIZE_ATOMIC, PAYER_ACCOUNT),
    ],
  };
}

function competition(overrides: Partial<CompetitionEvidence> = {}): CompetitionEvidence {
  return {
    id: COMPETITION,
    mode: 'ASSET',
    status: 'FINISHED',
    prizeStatus: 'PAID',
    entryAssetId: ASSET,
    entryAmountAtomic: ENTRY_ATOMIC,
    prizeAssetId: ASSET,
    prizeAmountAtomic: PRIZE_ATOMIC,
    sponsorId: SPONSOR,
    prizeReservationJournalId: RESERVE_ID,
    prizeSettlementJournalId: SETTLEMENT_ID,
    ...overrides,
  };
}

function payerEntrant(overrides: Partial<CompetitionEntrantEvidence> = {}): CompetitionEntrantEvidence {
  return {
    id: 'entrant-payer',
    principalId: PAYER,
    kind: 'WALLET',
    seat: 0,
    entryState: 'PAID',
    entryAmountAtomic: ENTRY_ATOMIC,
    entryJournalId: ENTRY_ID,
    entrySettlementJournalId: RELEASE_ID,
    refundJournalId: null,
    ...overrides,
  };
}

function serviceEntrant(overrides: Partial<CompetitionEntrantEvidence> = {}): CompetitionEntrantEvidence {
  return {
    id: 'entrant-service',
    principalId: SERVICE,
    kind: 'SERVICE',
    seat: 1,
    entryState: 'NOT_REQUIRED',
    entryAmountAtomic: null,
    entryJournalId: null,
    entrySettlementJournalId: null,
    refundJournalId: null,
    ...overrides,
  };
}

function paidEvidence(): FinancialJournalEvidence {
  return {
    competition: competition(),
    entrants: [payerEntrant(), serviceEntrant()],
    journals: [entryJournal(), releaseJournal(), reserveJournal(), settlementJournal(false)],
  };
}

function releasedEvidence(): FinancialJournalEvidence {
  return {
    competition: competition({ prizeStatus: 'RELEASED' }),
    entrants: [payerEntrant(), serviceEntrant()],
    journals: [entryJournal(), releaseJournal(), reserveJournal(), settlementJournal(true)],
  };
}

/** Injected query returning one fixed payload; records the last SQL issued. */
function staticQuery(payload: unknown): { query: AcceptanceSqlQuery; lastSql: () => string } {
  let lastSql = '';
  return {
    query: async (sql) => {
      lastSql = sql;
      return typeof payload === 'string' ? payload : JSON.stringify(payload);
    },
    lastSql: () => lastSql,
  };
}

describe('financial journal evidence helper', () => {
  it('accepts a terminal PAID competition with four distinct sealed balanced journals', async () => {
    const { query, lastSql } = staticQuery(paidEvidence());
    const captured = await captureFinancialJournalEvidence(query, COMPETITION);

    const sql = lastSql();
    expect(sql).toMatch(/^\s*SELECT/i);
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE|DROP|ALTER|TRUNCATE)\b/i);
    expect(sql).toContain(`c.id = '${COMPETITION}'`);
    expect(sql).toContain('"JournalPosting"');
    expect(sql).toContain('"CompetitionEntrant"');

    const digest = assertExactlyOnceFinancialJournals(captured);
    expect(digest.journalCount).toBe(4);
    expect(digest.postingCount).toBe(8);
    expect(digest.requestIds).toEqual([ENTRY_ID, RELEASE_ID, RESERVE_ID, SETTLEMENT_ID].sort());
    expect(digest.entryDebits).toEqual([{ principalId: PAYER, amountAtomic: ENTRY_ATOMIC }]);
    expect(digest.reserveBalances).toEqual({ entryAtomic: '0', prizeAtomic: '0' });
    expect(digest.prizeStatus).toBe('PAID');
    expect(financialJournalEvidenceFingerprint(captured)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a terminal RELEASED competition and pins the scenario actors', async () => {
    const { query } = staticQuery(releasedEvidence());
    const captured = await captureFinancialJournalEvidence(query, COMPETITION);
    const digest = assertExactlyOnceFinancialJournals(captured, {
      prizeStatus: 'RELEASED',
      expectedPayerPrincipalIds: [PAYER],
      expectedServicePrincipalIds: [SERVICE],
    });
    expect(digest.prizeStatus).toBe('RELEASED');
    expect(digest.entryDebits).toHaveLength(1);
    expect(digest.reserveBalances.prizeAtomic).toBe('0');
  });

  it('accepts a pre-opt-in cancellation where the configured payer never paid', async () => {
    const evidence: FinancialJournalEvidence = {
      competition: competition({ status: 'CANCELLED', prizeStatus: 'RELEASED', prizeSettlementJournalId: null }),
      entrants: [
        payerEntrant({
          entryState: 'PENDING',
          entryJournalId: null,
          entrySettlementJournalId: null,
          refundJournalId: null,
        }),
        serviceEntrant(),
      ],
      journals: [reserveJournal(), settlementJournal(true)],
    };
    const { query } = staticQuery(evidence);
    const captured = await captureFinancialJournalEvidence(query, COMPETITION);
    const digest = assertExactlyOnceFinancialJournals(captured, {
      status: 'CANCELLED',
      prizeStatus: 'RELEASED',
    });
    expect(digest.journalCount).toBe(2);
    expect(digest.entryDebits).toEqual([]);
    expect(digest.reserveBalances).toEqual({ entryAtomic: '0', prizeAtomic: '0' });
  });

  it('accepts a refunded cancellation and still counts exactly one entry debit', async () => {
    const refundId = `competition-entry-refund:${COMPETITION}:${PAYER}`;
    const refund: JournalEvidence = {
      id: 'jt-refund',
      requestId: refundId,
      assetId: ASSET,
      sealed: true,
      postings: [
        posting(ENTRY_RESERVE, 'TOURNAMENT_RESERVE', `-${ENTRY_ATOMIC}`, 'acct-entry-reserve'),
        posting(PAYER, 'USER_AVAILABLE', ENTRY_ATOMIC, PAYER_ACCOUNT),
      ],
    };
    const evidence: FinancialJournalEvidence = {
      competition: competition({ status: 'CANCELLED', prizeStatus: 'RELEASED', prizeSettlementJournalId: null }),
      entrants: [
        payerEntrant({ entryState: 'REFUNDED', entrySettlementJournalId: null, refundJournalId: refundId }),
        serviceEntrant(),
      ],
      journals: [entryJournal(), refund, reserveJournal(), settlementJournal(true)],
    };
    const digest = assertExactlyOnceFinancialJournals(evidence, {
      status: 'CANCELLED',
      prizeStatus: 'RELEASED',
      expectedPayerPrincipalIds: [PAYER],
    });
    expect(digest.journalCount).toBe(4);
    expect(digest.entryDebits).toEqual([{ principalId: PAYER, amountAtomic: ENTRY_ATOMIC }]);
  });

  it('rejects journal references on a never-opted-in payer', () => {
    const evidence: FinancialJournalEvidence = {
      competition: competition({ status: 'CANCELLED', prizeStatus: 'RELEASED' }),
      entrants: [
        payerEntrant({
          entryState: 'PENDING',
          entryJournalId: ENTRY_ID,
          entrySettlementJournalId: null,
          refundJournalId: null,
        }),
        serviceEntrant(),
      ],
      journals: [entryJournal(), reserveJournal(), settlementJournal(true)],
    };
    expect(() =>
      assertExactlyOnceFinancialJournals(evidence, { status: 'CANCELLED', prizeStatus: 'RELEASED' })
    ).toThrow(/pending-journal/);
  });

  it('rejects a cancelled competition whose prize release journal is missing', () => {
    const evidence: FinancialJournalEvidence = {
      competition: competition({ status: 'CANCELLED', prizeStatus: 'RELEASED', prizeSettlementJournalId: null }),
      entrants: [
        payerEntrant({
          entryState: 'PENDING',
          entryJournalId: null,
          entrySettlementJournalId: null,
          refundJournalId: null,
        }),
        serviceEntrant(),
      ],
      journals: [reserveJournal()],
    };
    expect(() =>
      assertExactlyOnceFinancialJournals(evidence, { status: 'CANCELLED', prizeStatus: 'RELEASED' })
    ).toThrow(/journal-missing/);
  });

  it('rejects a missing competition and unparseable evidence', async () => {
    await expect(captureFinancialJournalEvidence(staticQuery('').query, COMPETITION)).rejects.toThrow(
      /absent from the operator database/
    );
    await expect(captureFinancialJournalEvidence(staticQuery('not json').query, COMPETITION)).rejects.toThrow(
      /not valid JSON/
    );
    await expect(captureFinancialJournalEvidence(staticQuery(null).query, COMPETITION)).rejects.toThrow(
      /unexpected shape/
    );
  });

  it('rejects an evidence payload for a different competition id', async () => {
    const other = paidEvidence();
    other.competition.id = 'other-competition';
    await expect(captureFinancialJournalEvidence(staticQuery(other).query, COMPETITION)).rejects.toThrow(
      /captured competition other-competition != requested comp-1/
    );
  });

  it('rejects a duplicate journal projection', () => {
    const evidence = paidEvidence();
    evidence.journals.push(structuredClone(evidence.journals[0]!));
    expect(() => assertExactlyOnceFinancialJournals(evidence)).toThrow(/duplicate-projection|projection-cardinality/);
  });

  it('rejects an unreferenced journal touching the competition reserves', () => {
    const evidence = paidEvidence();
    evidence.journals.push({
      ...structuredClone(evidence.journals[2]!),
      id: 'jt-reserve-extra',
      requestId: `${RESERVE_ID}:extra`,
    });
    expect(() => assertExactlyOnceFinancialJournals(evidence)).toThrow(/projection-cardinality/);
  });

  it('rejects two roles collapsing onto one request identity', () => {
    const evidence = paidEvidence();
    evidence.competition.prizeSettlementJournalId = RESERVE_ID;
    evidence.journals = evidence.journals.filter((journal) => journal.requestId !== SETTLEMENT_ID);
    expect(() => assertExactlyOnceFinancialJournals(evidence)).toThrow(/distinct-journals/);
  });

  it('rejects a non-canonical request identity', () => {
    const evidence = paidEvidence();
    const impostor = `competition-entry-reserve:${COMPETITION}:impostor`;
    evidence.entrants[0]!.entryJournalId = impostor;
    evidence.journals[0]!.requestId = impostor;
    expect(() => assertExactlyOnceFinancialJournals(evidence)).toThrow(/request-identity/);
  });

  it('rejects an unsealed journal', () => {
    const evidence = paidEvidence();
    evidence.journals[0]!.sealed = false;
    expect(() => assertExactlyOnceFinancialJournals(evidence)).toThrow(/\[sealed\]/);
  });

  it('rejects an unbalanced journal', () => {
    const evidence = paidEvidence();
    evidence.journals[3]!.postings[1] = { ...evidence.journals[3]!.postings[1]!, amountAtomic: '19' };
    expect(() => assertExactlyOnceFinancialJournals(evidence)).toThrow(/balanced/);
  });

  it('rejects a journal that posts one account twice', () => {
    const evidence = paidEvidence();
    evidence.journals[0]!.postings = [
      evidence.journals[0]!.postings[0]!,
      { ...evidence.journals[0]!.postings[1]!, accountId: PAYER_ACCOUNT },
    ];
    expect(() => assertExactlyOnceFinancialJournals(evidence)).toThrow(/balance-pair|balanced/);
  });

  it('rejects a duplicated payer entry debit', () => {
    const evidence = paidEvidence();
    evidence.journals[0]!.postings = [
      evidence.journals[0]!.postings[0]!,
      { ...evidence.journals[0]!.postings[0]!, accountId: `${PAYER_ACCOUNT}-second` },
      { ...evidence.journals[0]!.postings[1]!, amountAtomic: '10' },
    ];
    expect(() => assertExactlyOnceFinancialJournals(evidence)).toThrow(/posting-count|entry-debit/);
  });

  it('rejects any SERVICE journal reference or value', () => {
    const referenced = paidEvidence();
    referenced.entrants[1]!.entryJournalId = ENTRY_ID;
    expect(() => assertExactlyOnceFinancialJournals(referenced)).toThrow(/service-entry/);

    const valued = releasedEvidence();
    valued.competition.sponsorId = SERVICE;
    valued.journals[1]!.postings[1] = { ...valued.journals[1]!.postings[1]!, ownerId: SERVICE };
    valued.journals[2]!.postings[0] = { ...valued.journals[2]!.postings[0]!, ownerId: SERVICE };
    valued.journals[3]!.postings[1] = { ...valued.journals[3]!.postings[1]!, ownerId: SERVICE };
    expect(() => assertExactlyOnceFinancialJournals(valued)).toThrow(/service-value/);
  });

  it('rejects unfinished entrant obligations and wrong terminal states', () => {
    const pending = paidEvidence();
    pending.entrants[0]!.entryState = 'PENDING';
    expect(() => assertExactlyOnceFinancialJournals(pending)).toThrow(/entry-pending/);

    const paidButCancelled = paidEvidence();
    paidButCancelled.competition.status = 'CANCELLED';
    paidButCancelled.competition.prizeStatus = 'RELEASED';
    paidButCancelled.journals[3] = settlementJournal(true);
    expect(() => assertExactlyOnceFinancialJournals(paidButCancelled, { status: 'CANCELLED' })).toThrow(
      /cancelled-paid|finished-refund/
    );

    const reserved = paidEvidence();
    reserved.competition.prizeStatus = 'RESERVED';
    reserved.competition.prizeSettlementJournalId = null;
    reserved.journals = reserved.journals.filter((journal) => journal.requestId !== SETTLEMENT_ID);
    expect(() => assertExactlyOnceFinancialJournals(reserved)).toThrow(/prize-status/);
  });

  it('rejects expectation mismatches against the pinned scenario actors', () => {
    expect(() =>
      assertExactlyOnceFinancialJournals(paidEvidence(), { expectedPayerPrincipalIds: ['someone-else'] })
    ).toThrow(/payer-identity/);
    expect(() =>
      assertExactlyOnceFinancialJournals(paidEvidence(), { expectedServicePrincipalIds: ['someone-else'] })
    ).toThrow(/service-identity/);
    expect(() =>
      assertExactlyOnceFinancialJournals(releasedEvidence(), { prizeStatus: 'PAID' })
    ).toThrow(/prize-status/);
  });

  it('rejects unsafe competition identifiers in the generated read-only SQL', () => {
    expect(() => financialJournalEvidenceSql("comp'; DROP TABLE x;--")).toThrow(/competition-id/);
    expect(financialJournalEvidenceSql(COMPETITION)).toContain(`'${COMPETITION}'`);
  });

  it('asserts IDs, counts and postings unchanged across a restart boundary', async () => {
    const fixture = paidEvidence();
    const { query } = staticQuery(fixture);
    const before = await captureFinancialJournalEvidence(query, COMPETITION);
    const after = structuredClone(before);
    expect(() => assertFinancialJournalEvidenceUnchanged(before, after)).not.toThrow();

    after.journals[3]!.postings[1]!.amountAtomic = '-19';
    expect(() => assertFinancialJournalEvidenceUnchanged(before, after)).toThrow(
      /restart-unchanged.*journals\[3\]\.postings\[1\]\.amountAtomic/
    );
  });

  it('captures before and after a restart and fails on any ledger change', async () => {
    let fixture = paidEvidence();
    const result = await assertExactlyOnceFinancialJournalsAcrossRestart({
      query: async () => JSON.stringify(fixture),
      competitionId: COMPETITION,
      restart: async () => undefined,
    });
    expect(result.digest.journalCount).toBe(4);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    fixture = paidEvidence();
    await expect(
      assertExactlyOnceFinancialJournalsAcrossRestart({
        query: async () => JSON.stringify(fixture),
        competitionId: COMPETITION,
        restart: async () => {
          const journals = structuredClone(fixture.journals);
          journals[3]!.postings[1]!.amountAtomic = '-19';
          fixture = { ...fixture, journals };
        },
      })
    ).rejects.toThrow(/restart-unchanged/);
  });
});
