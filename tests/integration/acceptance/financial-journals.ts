/**
 * Read-only exactly-once journal evidence for the paid competition surface.
 *
 * The public SDK projection reports balances and entry/prize statuses, but it
 * never exposes journal cardinality. This acceptance-only helper reads the
 * operator database directly (a single `SELECT` per capture) and proves the
 * durable ledger contract for one actual competition against the pinned
 * PokerTools 2.0.0 operational journal identities:
 *
 *   competition-entry-reserve:<competitionId>:<principalId>
 *   competition-entry-release:<competitionId>:<principalId>
 *   competition-entry-refund:<competitionId>:<principalId>
 *   competition-prize-reserve:<competitionId>
 *   competition-prize-settlement:<competitionId>
 *
 * Contract enforced for every terminal ASSET competition:
 * - the competition is FINISHED (or explicitly CANCELLED) with a terminal
 *   prize status PAID or RELEASED; no value stays stranded in a reserve;
 * - each configured WALLET payer that opted in is charged exactly once (exactly
 *   one negative USER_AVAILABLE posting) through its canonical entry reserve
 *   journal; a configured payer that never opted in stays PENDING with no
 *   journal on a pre-start cancellation;
 * - at start the held entry is released to the sponsor exactly once, or on
 *   cancellation refunded to the payer exactly once;
 * - the sponsor prize is reserved exactly once from the sponsor OPERATOR
 *   account into the competition prize reserve;
 * - the prize is disposed exactly once (paid to a WALLET winner for PAID,
 *   released to the sponsor for RELEASED); the cancellation path releases the
 *   prize under the canonical settlement identity while leaving
 *   `prizeSettlementJournalId` null, so that identity is derived there and the
 *   journal must still exist exactly once;
 * - SERVICE entrants never pay, never receive entry/prize value and carry no
 *   journal references;
 * - every journal referenced by a durable column is sealed, carries exactly one
 *   request identity, has exactly one balance pair, sums to zero and is the
 *   only row with that identity; no journal that touches a competition reserve
 *   account is left unreferenced, so duplicate projections are impossible;
 * - capture before/after a product restart compares IDs, counts, postings and
 *   sealing byte-for-byte.
 *
 * Nothing here writes, migrates, imports platform/product source or embeds
 * PokerTools code. `captureFinancialJournalEvidence` is one PostgreSQL
 * statement (single snapshot) returning plain serializable JSON.
 */
import { createHash } from 'node:crypto';
import type { AdminDatabaseTarget } from '../infra/admin.js';
import { psqlContainer, psqlUrl } from '../infra/docker.js';

/** Injected operator SQL executor: container psql or host psql, read-only. */
export type AcceptanceSqlQuery = (sql: string) => Promise<string>;

/** Default executor over the existing explicit-infrastructure query helpers. */
export function adminDatabaseQuery(target: AdminDatabaseTarget): AcceptanceSqlQuery {
  return target.kind === 'container'
    ? (sql) => psqlContainer(target.container, sql)
    : (sql) => psqlUrl(target.databaseUrl, sql);
}

export interface JournalPostingEvidence {
  accountId: string;
  assetId: string;
  class: string;
  ownerId: string | null;
  /** Signed canonical atomic decimal string. */
  amountAtomic: string;
}

export interface JournalEvidence {
  /** JournalTransaction.id (the durable transaction row identity). */
  id: string;
  /** The one request identity this sealed journal was committed under. */
  requestId: string;
  assetId: string;
  sealed: boolean;
  postings: JournalPostingEvidence[];
}

export interface CompetitionEntrantEvidence {
  id: string;
  principalId: string;
  kind: string;
  seat: number;
  entryState: string;
  entryAmountAtomic: string | null;
  entryJournalId: string | null;
  entrySettlementJournalId: string | null;
  refundJournalId: string | null;
}

export interface CompetitionEvidence {
  id: string;
  mode: string;
  status: string;
  prizeStatus: string;
  entryAssetId: string | null;
  entryAmountAtomic: string | null;
  prizeAssetId: string | null;
  prizeAmountAtomic: string | null;
  sponsorId: string | null;
  prizeReservationJournalId: string | null;
  prizeSettlementJournalId: string | null;
}

export interface FinancialJournalEvidence {
  competition: CompetitionEvidence;
  entrants: CompetitionEntrantEvidence[];
  /**
   * Every journal that touches this competition's own entry or prize reserve
   * account. Reserve owner ids are scoped to the competition
   * (`competition-entry:<id>` / `competition-prize:<id>`), so this enumeration
   * cannot pick up another competition's value.
   */
  journals: JournalEvidence[];
}

export interface FinancialJournalExpectations {
  /** Terminal competition status. Defaults to FINISHED. */
  status?: 'FINISHED' | 'CANCELLED';
  /** Required prize disposition (winner-aware). Defaults to the durable status. */
  prizeStatus?: 'PAID' | 'RELEASED';
  /** When supplied, the exact charged WALLET payers (PAID at FINISHED, REFUNDED at CANCELLED). */
  expectedPayerPrincipalIds?: readonly string[];
  /** When supplied, the exact SERVICE entrants the scenario configured. */
  expectedServicePrincipalIds?: readonly string[];
}

export type JournalRole =
  | 'entry'
  | 'entry-release'
  | 'entry-refund'
  | 'prize-reserve'
  | 'prize-settlement';

export interface FinancialJournalDigest {
  competitionId: string;
  status: string;
  prizeStatus: string;
  entryAssetId: string | null;
  entryAmountAtomic: string | null;
  prizeAssetId: string | null;
  prizeAmountAtomic: string | null;
  journalCount: number;
  postingCount: number;
  requestIds: string[];
  journals: Array<{
    role: JournalRole;
    requestId: string;
    transactionId: string;
    assetId: string;
    sealed: boolean;
    postingCount: number;
  }>;
  entryDebits: Array<{ principalId: string; amountAtomic: string }>;
  reserveBalances: { entryAtomic: string; prizeAtomic: string };
}

const COMPETITION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function fail(rule: string, detail: string): never {
  throw new Error(`financial journal evidence violation [${rule}]: ${detail}`);
}

function assertSafeCompetitionId(competitionId: string): void {
  if (!COMPETITION_ID_PATTERN.test(competitionId)) {
    fail(
      'competition-id',
      `competition id ${JSON.stringify(competitionId)} is not a plain durable identifier`
    );
  }
}

/**
 * The single read-only statement behind one evidence capture. Returns the
 * competition, its entrants and every journal touching either competition
 * reserve account as one JSON document (one statement = one snapshot).
 */
export function financialJournalEvidenceSql(competitionId: string): string {
  assertSafeCompetitionId(competitionId);
  return `SELECT json_build_object(
  'competition', json_build_object(
    'id', c.id,
    'mode', c.mode,
    'status', c.status,
    'prizeStatus', c."prizeStatus",
    'entryAssetId', c."entryAssetId",
    'entryAmountAtomic', c."entryAmountAtomic",
    'prizeAssetId', c."prizeAssetId",
    'prizeAmountAtomic', c."prizeAmountAtomic",
    'sponsorId', c."sponsorId",
    'prizeReservationJournalId', c."prizeReservationJournalId",
    'prizeSettlementJournalId', c."prizeSettlementJournalId"
  ),
  'entrants', COALESCE((
    SELECT json_agg(json_build_object(
      'id', e.id,
      'principalId', e."principalId",
      'kind', e.kind,
      'seat', e.seat,
      'entryState', e."entryState",
      'entryAmountAtomic', e."entryAmountAtomic",
      'entryJournalId', e."entryJournalId",
      'entrySettlementJournalId', e."entrySettlementJournalId",
      'refundJournalId', e."refundJournalId"
    ) ORDER BY e.seat)
    FROM "CompetitionEntrant" e WHERE e."competitionId" = c.id
  ), '[]'::json),
  'journals', COALESCE((
    SELECT json_agg(journal.j ORDER BY journal."requestId")
    FROM (
      SELECT json_build_object(
        'id', jt.id,
        'requestId', jt."requestId",
        'assetId', jt."assetId",
        'sealed', jt.sealed,
        'postings', COALESCE((
          SELECT json_agg(json_build_object(
            'accountId', jp."accountId",
            'assetId', jp."assetId",
            'class', aa.class,
            'ownerId', aa."ownerId",
            'amountAtomic', jp."amountAtomic"
          ) ORDER BY jp.id)
          FROM "JournalPosting" jp
          JOIN "AtomicAccount" aa ON aa.id = jp."accountId" AND aa."assetId" = jp."assetId"
          WHERE jp."transactionId" = jt.id AND jp."assetId" = jt."assetId"
        ), '[]'::json)
      ) AS j, jt."requestId"
      FROM "JournalTransaction" jt
      WHERE EXISTS (
        SELECT 1 FROM "JournalPosting" jp
        JOIN "AtomicAccount" aa ON aa.id = jp."accountId" AND aa."assetId" = jp."assetId"
        WHERE jp."transactionId" = jt.id
          AND aa."ownerId" IN ('competition-entry:' || c.id, 'competition-prize:' || c.id)
      )
    ) AS journal
  ), '[]'::json)
)::text
FROM "Competition" c
WHERE c.id = '${competitionId}';`;
}

/**
 * Capture one immutable evidence snapshot from the operator database. Read-only
 * by construction; the caller owns when to capture (for example before and
 * after a product restart).
 */
export async function captureFinancialJournalEvidence(
  query: AcceptanceSqlQuery,
  competitionId: string
): Promise<FinancialJournalEvidence> {
  const output = (await query(financialJournalEvidenceSql(competitionId))).trim();
  if (output === '') {
    throw new Error(
      `competition ${competitionId} is absent from the operator database (read-only journal evidence found no row)`
    );
  }
  let parsed: FinancialJournalEvidence;
  try {
    parsed = JSON.parse(output) as FinancialJournalEvidence;
  } catch (error) {
    throw new Error(
      `competition ${competitionId} journal evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (
    typeof parsed?.competition?.id !== 'string' ||
    !Array.isArray(parsed.entrants) ||
    !Array.isArray(parsed.journals)
  ) {
    fail('evidence-shape', `competition ${competitionId} journal evidence has an unexpected shape`);
  }
  if (parsed.competition.id !== competitionId) {
    fail('evidence-shape', `captured competition ${parsed.competition.id} != requested ${competitionId}`);
  }
  return parsed;
}

interface ResolvedRole {
  role: JournalRole;
  requestId: string;
  journal: JournalEvidence;
  entrant: CompetitionEntrantEvidence | null;
}

interface BalancedPair {
  debit: { posting: JournalPostingEvidence; amount: bigint };
  credit: { posting: JournalPostingEvidence; amount: bigint };
}

function canonicalAtomic(value: string | null, label: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    fail('amount-format', `${label} amount ${JSON.stringify(value)} is not a signed canonical atomic integer`);
  }
  return BigInt(value);
}

function entryAmountFor(entrant: CompetitionEntrantEvidence, competition: CompetitionEvidence): bigint {
  const raw = entrant.entryAmountAtomic ?? competition.entryAmountAtomic;
  const amount = canonicalAtomic(raw, `entrant ${entrant.principalId} entry`);
  if (amount <= 0n) fail('entry-amount', `entrant ${entrant.principalId} entry amount ${amount} is not positive`);
  return amount;
}

function sameStringSet(expected: readonly string[], actual: readonly string[]): boolean {
  const left = [...expected].sort();
  const right = [...actual].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function splitBalancedJournal(resolved: ResolvedRole): BalancedPair {
  const { journal, role } = resolved;
  if (journal.sealed !== true) {
    fail('sealed', `${role} journal ${journal.requestId} is not sealed`);
  }
  if (!Array.isArray(journal.postings) || journal.postings.length !== 2) {
    fail(
      'posting-count',
      `${role} journal ${journal.requestId} has ${journal.postings?.length ?? 0} postings, expected exactly one debit and one credit`
    );
  }
  const parsed = journal.postings.map((posting) => {
    if (posting.assetId !== journal.assetId) {
      fail(
        'posting-asset',
        `${role} journal ${journal.requestId} posting asset ${posting.assetId} != journal asset ${journal.assetId}`
      );
    }
    return { posting, amount: canonicalAtomic(posting.amountAtomic, `${role} journal ${journal.requestId}`) };
  });
  const debits = parsed.filter((leg) => leg.amount < 0n);
  const credits = parsed.filter((leg) => leg.amount > 0n);
  if (debits.length !== 1 || credits.length !== 1) {
    fail(
      'balance-pair',
      `${role} journal ${journal.requestId} has ${debits.length} debit(s) and ${credits.length} credit(s), expected exactly one of each`
    );
  }
  if (parsed[0]!.amount + parsed[1]!.amount !== 0n) {
    fail('balanced', `${role} journal ${journal.requestId} postings do not sum to zero`);
  }
  const debit = debits[0]!;
  const credit = credits[0]!;
  if (debit.posting.accountId === credit.posting.accountId) {
    fail('balance-pair', `${role} journal ${journal.requestId} posts both legs to the same account`);
  }
  return { debit, credit };
}

function assertLeg(
  role: JournalRole,
  side: 'debit' | 'credit',
  leg: { posting: JournalPostingEvidence; amount: bigint },
  expected: { ownerId: string; class: string },
  amount: bigint
): void {
  if (leg.posting.ownerId !== expected.ownerId) {
    fail(
      `${role}-${side}-owner`,
      `${role} ${side} is owned by ${JSON.stringify(leg.posting.ownerId)}, expected ${expected.ownerId}`
    );
  }
  if (leg.posting.class !== expected.class) {
    fail(
      `${role}-${side}-class`,
      `${role} ${side} class ${leg.posting.class} != ${expected.class}`
    );
  }
  if (leg.amount !== amount) {
    fail(`${role}-${side}-amount`, `${role} ${side} amount ${leg.amount} != ${amount}`);
  }
}

function expectedRequestIdFor(role: JournalRole, competitionId: string, entrant: CompetitionEntrantEvidence | null): string {
  switch (role) {
    case 'entry':
      return `competition-entry-reserve:${competitionId}:${entrant!.principalId}`;
    case 'entry-release':
      return `competition-entry-release:${competitionId}:${entrant!.principalId}`;
    case 'entry-refund':
      return `competition-entry-refund:${competitionId}:${entrant!.principalId}`;
    case 'prize-reserve':
      return `competition-prize-reserve:${competitionId}`;
    case 'prize-settlement':
      return `competition-prize-settlement:${competitionId}`;
  }
}

/**
 * Validate one captured snapshot against the exactly-once journal contract and
 * return a compact digest. Throws on the first violation with a stable
 * `[rule]` tag; never writes and never repairs.
 */
export function assertExactlyOnceFinancialJournals(
  evidence: FinancialJournalEvidence,
  expectations: FinancialJournalExpectations = {}
): FinancialJournalDigest {
  const { competition, entrants, journals } = evidence;
  const competitionId = competition.id;

  if (competition.mode !== 'ASSET') {
    fail('mode', `competition ${competitionId} mode ${competition.mode} is not the paid ASSET surface`);
  }
  const status = expectations.status ?? 'FINISHED';
  if (competition.status !== status) {
    fail('status', `competition status ${competition.status} != terminal ${status}`);
  }
  const prizeStatus = expectations.prizeStatus ?? competition.prizeStatus;
  if (competition.prizeStatus !== prizeStatus) {
    fail('prize-status', `prize status ${competition.prizeStatus} != expected ${prizeStatus}`);
  }
  if (prizeStatus !== 'PAID' && prizeStatus !== 'RELEASED') {
    fail('prize-status', `terminal prize status must be PAID or RELEASED, saw ${competition.prizeStatus}`);
  }
  if (status === 'CANCELLED' && prizeStatus !== 'RELEASED') {
    fail('cancelled-prize', `cancelled competition ${competitionId} prize status ${prizeStatus} != RELEASED`);
  }
  const sponsorId = competition.sponsorId;
  if (sponsorId === null || sponsorId === '') {
    fail('sponsor', `competition ${competitionId} has no sponsor for its prize reserve`);
  }
  const prizeAmount = canonicalAtomic(competition.prizeAmountAtomic, 'competition prize');
  if (prizeAmount <= 0n) fail('prize-amount', `competition prize ${prizeAmount} is not positive`);

  const services = entrants.filter((entrant) => entrant.kind === 'SERVICE');
  const payingEntrants: CompetitionEntrantEvidence[] = [];
  const refundedEntrants: CompetitionEntrantEvidence[] = [];

  for (const entrant of entrants) {
    if (entrant.kind === 'SERVICE') {
      if (
        entrant.entryState !== 'NOT_REQUIRED' ||
        entrant.entryAmountAtomic !== null ||
        entrant.entryJournalId !== null ||
        entrant.entrySettlementJournalId !== null ||
        entrant.refundJournalId !== null
      ) {
        fail(
          'service-entry',
          `SERVICE entrant ${entrant.principalId} carries entryState=${entrant.entryState} and journal references; SERVICE entrants never pay`
        );
      }
      continue;
    }
    if (entrant.kind !== 'WALLET') {
      fail('entrant-kind', `entrant ${entrant.principalId} has unsupported kind ${entrant.kind}`);
    }
    if (entrant.entryState === 'PENDING') {
      if (status !== 'CANCELLED') {
        fail('entry-pending', `WALLET entrant ${entrant.principalId} is still PENDING at ${status}`);
      }
      // A configured payer that never opted in before cancellation has no
      // charge and therefore no charge/settlement/refund journal.
      if (
        entrant.entryJournalId !== null ||
        entrant.entrySettlementJournalId !== null ||
        entrant.refundJournalId !== null
      ) {
        fail(
          'pending-journal',
          `never-opted-in WALLET entrant ${entrant.principalId} carries journal references on a cancelled competition`
        );
      }
      continue;
    }
    if (entrant.entryState === 'NOT_REQUIRED') {
      if (
        entrant.entryAmountAtomic !== null ||
        entrant.entryJournalId !== null ||
        entrant.entrySettlementJournalId !== null ||
        entrant.refundJournalId !== null
      ) {
        fail(
          'non-payer-journal',
          `non-paying WALLET entrant ${entrant.principalId} carries entry journal references`
        );
      }
      continue;
    }
    if (entrant.entryState === 'PAID') {
      entryAmountFor(entrant, competition);
      if (status !== 'FINISHED') {
        fail('cancelled-paid', `entrant ${entrant.principalId} is PAID on a ${status} competition`);
      }
      if (entrant.entryJournalId === null) {
        fail('entry-journal-missing', `PAID entrant ${entrant.principalId} has no entryJournalId`);
      }
      if (entrant.entrySettlementJournalId === null) {
        fail('entry-settlement-missing', `PAID entrant ${entrant.principalId} has no entrySettlementJournalId at ${status}`);
      }
      if (entrant.refundJournalId !== null) {
        fail('paid-refund', `PAID entrant ${entrant.principalId} also carries refundJournalId ${entrant.refundJournalId}`);
      }
      payingEntrants.push(entrant);
      continue;
    }
    if (entrant.entryState === 'REFUNDED') {
      entryAmountFor(entrant, competition);
      if (status !== 'CANCELLED') {
        fail('finished-refund', `entrant ${entrant.principalId} is REFUNDED on a ${status} competition`);
      }
      if (entrant.entryJournalId === null) {
        fail('entry-journal-missing', `REFUNDED entrant ${entrant.principalId} has no entryJournalId`);
      }
      if (entrant.refundJournalId === null) {
        fail('refund-journal-missing', `REFUNDED entrant ${entrant.principalId} has no refundJournalId`);
      }
      if (entrant.entrySettlementJournalId !== null) {
        fail(
          'refunded-settlement',
          `REFUNDED entrant ${entrant.principalId} also carries entrySettlementJournalId ${entrant.entrySettlementJournalId}`
        );
      }
      refundedEntrants.push(entrant);
      continue;
    }
    fail('entry-state', `entrant ${entrant.principalId} has unknown entry state ${entrant.entryState}`);
  }

  if (status === 'FINISHED' && payingEntrants.length === 0) {
    fail('no-payer', `competition ${competitionId} reached ${status} without a PAID WALLET entry`);
  }
  if (expectations.expectedPayerPrincipalIds !== undefined) {
    const actual = (status === 'FINISHED' ? payingEntrants : refundedEntrants).map((entrant) => entrant.principalId);
    if (!sameStringSet(expectations.expectedPayerPrincipalIds, actual)) {
      fail(
        'payer-identity',
        `paying WALLET entrants [${actual.join(', ')}] != expected [${expectations.expectedPayerPrincipalIds.join(', ')}]`
      );
    }
  }
  if (expectations.expectedServicePrincipalIds !== undefined) {
    const actual = services.map((entrant) => entrant.principalId);
    if (!sameStringSet(expectations.expectedServicePrincipalIds, actual)) {
      fail(
        'service-identity',
        `SERVICE entrants [${actual.join(', ')}] != expected [${expectations.expectedServicePrincipalIds.join(', ')}]`
      );
    }
  }

  // Durable journal references resolve to exactly one journal row each.
  const byRequestId = new Map<string, JournalEvidence>();
  for (const journal of journals) {
    if (typeof journal.requestId !== 'string' || journal.requestId === '') {
      fail('request-identity', `journal row ${journal.id} has no request identity`);
    }
    if (byRequestId.has(journal.requestId)) {
      fail(
        'duplicate-projection',
        `journal request identity ${journal.requestId} appears more than once in the competition ledger`
      );
    }
    byRequestId.set(journal.requestId, journal);
  }

  const roles: ResolvedRole[] = [];
  const addRole = (role: JournalRole, requestId: string | null, entrant: CompetitionEntrantEvidence | null): void => {
    if (requestId === null) return;
    const journal = byRequestId.get(requestId);
    if (!journal) {
      fail(
        'journal-missing',
        `${role} journal ${requestId} is referenced by a durable column but absent from the competition ledger enumeration`
      );
    }
    roles.push({ role, requestId, journal, entrant });
  };

  for (const entrant of payingEntrants) {
    addRole('entry', entrant.entryJournalId, entrant);
    addRole('entry-release', entrant.entrySettlementJournalId, entrant);
  }
  for (const entrant of refundedEntrants) {
    addRole('entry', entrant.entryJournalId, entrant);
    addRole('entry-refund', entrant.refundJournalId, entrant);
  }
  if (competition.prizeReservationJournalId === null) {
    fail('reserve-missing', `terminal competition ${competitionId} has no prizeReservationJournalId`);
  }
  addRole('prize-reserve', competition.prizeReservationJournalId, null);
  // The settlement path records prizeSettlementJournalId. The cancellation
  // path releases the reserved prize under the same canonical identity but
  // leaves the column null, so derive it from the operational contract there
  // while still requiring the journal to exist exactly once.
  const settlementRequestId =
    competition.prizeSettlementJournalId ??
    (status === 'CANCELLED' ? `competition-prize-settlement:${competitionId}` : null);
  if (settlementRequestId === null) {
    fail('settlement-missing', `terminal competition ${competitionId} has no prizeSettlementJournalId`);
  }
  addRole('prize-settlement', settlementRequestId, null);

  const distinctRequestIds = new Set(roles.map((resolved) => resolved.requestId));
  if (distinctRequestIds.size !== roles.length) {
    fail(
      'distinct-journals',
      `expected four distinct journals, saw ${roles.length} roles over ${distinctRequestIds.size} request identities`
    );
  }
  const distinctTransactionIds = new Set(roles.map((resolved) => resolved.journal.id));
  if (distinctTransactionIds.size !== roles.length) {
    fail(
      'duplicate-projection',
      `one journal transaction row was projected for ${roles.length - distinctTransactionIds.size + 1} roles`
    );
  }
  if (journals.length !== distinctRequestIds.size) {
    const referenced = new Set(distinctRequestIds);
    const unreferenced = journals
      .map((journal) => journal.requestId)
      .filter((requestId) => !referenced.has(requestId));
    fail(
      'projection-cardinality',
      `${journals.length} journals touch the competition reserves but ${distinctRequestIds.size} are referenced by durable columns` +
        (unreferenced.length > 0 ? `; unreferenced: ${unreferenced.join(', ')}` : '')
    );
  }

  const entryReserveOwner = `competition-entry:${competitionId}`;
  const prizeReserveOwner = `competition-prize:${competitionId}`;
  const allPostings = journals.flatMap((journal) => journal.postings);
  const digestJournals: FinancialJournalDigest['journals'] = [];

  for (const resolved of roles) {
    const expectedRequestId = expectedRequestIdFor(resolved.role, competitionId, resolved.entrant);
    if (resolved.requestId !== expectedRequestId) {
      fail(
        'request-identity',
        `${resolved.role} journal identity ${resolved.requestId} != canonical ${expectedRequestId}`
      );
    }
    const { debit, credit } = splitBalancedJournal(resolved);
    switch (resolved.role) {
      case 'entry': {
        const amount = entryAmountFor(resolved.entrant!, competition);
        assertLeg('entry', 'debit', debit, { ownerId: resolved.entrant!.principalId, class: 'USER_AVAILABLE' }, -amount);
        assertLeg('entry', 'credit', credit, { ownerId: entryReserveOwner, class: 'TOURNAMENT_RESERVE' }, amount);
        break;
      }
      case 'entry-release': {
        const amount = entryAmountFor(resolved.entrant!, competition);
        assertLeg('entry-release', 'debit', debit, { ownerId: entryReserveOwner, class: 'TOURNAMENT_RESERVE' }, -amount);
        assertLeg('entry-release', 'credit', credit, { ownerId: sponsorId, class: 'OPERATOR' }, amount);
        break;
      }
      case 'entry-refund': {
        const amount = entryAmountFor(resolved.entrant!, competition);
        assertLeg('entry-refund', 'debit', debit, { ownerId: entryReserveOwner, class: 'TOURNAMENT_RESERVE' }, -amount);
        assertLeg('entry-refund', 'credit', credit, { ownerId: resolved.entrant!.principalId, class: 'USER_AVAILABLE' }, amount);
        break;
      }
      case 'prize-reserve': {
        assertLeg('prize-reserve', 'debit', debit, { ownerId: sponsorId, class: 'OPERATOR' }, -prizeAmount);
        assertLeg('prize-reserve', 'credit', credit, { ownerId: prizeReserveOwner, class: 'TOURNAMENT_RESERVE' }, prizeAmount);
        break;
      }
      case 'prize-settlement': {
        assertLeg('prize-settlement', 'debit', debit, { ownerId: prizeReserveOwner, class: 'TOURNAMENT_RESERVE' }, -prizeAmount);
        if (prizeStatus === 'PAID') {
          if (credit.posting.class !== 'USER_AVAILABLE') {
            fail(
              'settlement-disposition',
              `PAID prize settled to ${credit.posting.class} instead of a WALLET winner's USER_AVAILABLE account`
            );
          }
          const winner = entrants.find((entrant) => entrant.principalId === credit.posting.ownerId);
          if (!winner || winner.kind !== 'WALLET') {
            fail(
              'settlement-winner',
              `PAID prize credited ${JSON.stringify(credit.posting.ownerId)} which is not a WALLET entrant`
            );
          }
          assertLeg(
            'prize-settlement',
            'credit',
            credit,
            { ownerId: winner.principalId, class: 'USER_AVAILABLE' },
            prizeAmount
          );
        } else {
          assertLeg('prize-settlement', 'credit', credit, { ownerId: sponsorId, class: 'OPERATOR' }, prizeAmount);
        }
        break;
      }
    }
    digestJournals.push({
      role: resolved.role,
      requestId: resolved.requestId,
      transactionId: resolved.journal.id,
      assetId: resolved.journal.assetId,
      sealed: resolved.journal.sealed === true,
      postingCount: resolved.journal.postings.length,
    });
  }

  // Exactly one payer entry debit per charged WALLET entrant, in the canonical
  // amount, across the whole competition ledger.
  const chargedEntrants = [...payingEntrants, ...refundedEntrants];
  const entryDebits: FinancialJournalDigest['entryDebits'] = [];
  for (const payer of chargedEntrants) {
    const amount = entryAmountFor(payer, competition);
    const debits = allPostings.filter(
      (posting) =>
        posting.ownerId === payer.principalId &&
        posting.class === 'USER_AVAILABLE' &&
        canonicalAtomic(posting.amountAtomic, `payer ${payer.principalId} posting`) < 0n
    );
    if (debits.length !== 1) {
      fail(
        'entry-debit-count',
        `payer ${payer.principalId} has ${debits.length} USER_AVAILABLE debits, expected exactly one entry charge`
      );
    }
    if (-canonicalAtomic(debits[0]!.amountAtomic, `payer ${payer.principalId} entry debit`) !== amount) {
      fail(
        'entry-debit-amount',
        `payer ${payer.principalId} entry debit ${debits[0]!.amountAtomic} != -${amount}`
      );
    }
    entryDebits.push({ principalId: payer.principalId, amountAtomic: amount.toString() });
  }

  // Prize reserve exactly once: only the canonical reservation debits the
  // sponsor OPERATOR account, and both competition reserves end empty.
  const operatorDebits = allPostings.filter(
    (posting) =>
      posting.ownerId === sponsorId &&
      posting.class === 'OPERATOR' &&
      canonicalAtomic(posting.amountAtomic, `sponsor ${sponsorId} posting`) < 0n
  );
  if (operatorDebits.length !== 1) {
    fail(
      'prize-reserve-count',
      `sponsor OPERATOR account has ${operatorDebits.length} debits, expected exactly one prize reservation`
    );
  }
  if (-canonicalAtomic(operatorDebits[0]!.amountAtomic, 'sponsor prize reservation') !== prizeAmount) {
    fail(
      'prize-reserve-amount',
      `sponsor prize reservation ${operatorDebits[0]!.amountAtomic} != -${prizeAmount}`
    );
  }

  const netFor = (ownerId: string, accountClass: string): bigint =>
    allPostings
      .filter((posting) => posting.ownerId === ownerId && posting.class === accountClass)
      .reduce((sum, posting) => sum + canonicalAtomic(posting.amountAtomic, `${ownerId} reserve`), 0n);
  const entryReserveBalance = netFor(entryReserveOwner, 'TOURNAMENT_RESERVE');
  const prizeReserveBalance = netFor(prizeReserveOwner, 'TOURNAMENT_RESERVE');
  if (entryReserveBalance !== 0n) {
    fail('entry-reserve-empty', `entry reserve holds ${entryReserveBalance} at ${status}; entry value is not fully disposed`);
  }
  if (prizeReserveBalance !== 0n) {
    fail('prize-reserve-empty', `prize reserve holds ${prizeReserveBalance} at ${status}; prize value is not fully disposed`);
  }

  // SERVICE entrants never touch a journal posting (paid or received).
  const serviceIds = new Set(services.map((entrant) => entrant.principalId));
  for (const journal of journals) {
    for (const posting of journal.postings) {
      if (posting.ownerId !== null && serviceIds.has(posting.ownerId)) {
        fail('service-value', `journal ${journal.requestId} touches SERVICE principal ${posting.ownerId}`);
      }
    }
  }

  return {
    competitionId,
    status: competition.status,
    prizeStatus: competition.prizeStatus,
    entryAssetId: competition.entryAssetId,
    entryAmountAtomic: competition.entryAmountAtomic,
    prizeAssetId: competition.prizeAssetId,
    prizeAmountAtomic: competition.prizeAmountAtomic,
    journalCount: journals.length,
    postingCount: allPostings.length,
    requestIds: [...distinctRequestIds].sort(),
    journals: digestJournals.sort((left, right) => (left.requestId < right.requestId ? -1 : 1)),
    entryDebits,
    reserveBalances: {
      entryAtomic: entryReserveBalance.toString(),
      prizeAtomic: prizeReserveBalance.toString(),
    },
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Stable content fingerprint over one captured snapshot. */
export function financialJournalEvidenceFingerprint(evidence: FinancialJournalEvidence): string {
  return createHash('sha256').update(canonicalJson(evidence), 'utf8').digest('hex');
}

function firstDifference(path: string, before: unknown, after: unknown): string | null {
  if (before === after) return null;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= before.length) return `${path}[${index}] (added)`;
      if (index >= after.length) return `${path}[${index}] (removed)`;
      const difference = firstDifference(`${path}[${index}]`, before[index], after[index]);
      if (difference !== null) return difference;
    }
    return null;
  }
  if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object') {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const childPath = path === '' ? key : `${path}.${key}`;
      const difference = firstDifference(
        childPath,
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key]
      );
      if (difference !== null) return difference;
    }
    return null;
  }
  return path === '' ? 'evidence' : path;
}

/**
 * Assert two captures describe the identical ledger: same journal IDs, request
 * identities, counts, postings, amounts and sealing flags. Any change across a
 * restart boundary is a duplicate/disposition violation.
 */
export function assertFinancialJournalEvidenceUnchanged(
  before: FinancialJournalEvidence,
  after: FinancialJournalEvidence
): void {
  if (canonicalJson(before) === canonicalJson(after)) return;
  const difference = firstDifference('', before, after) ?? 'unknown difference';
  fail(
    'restart-unchanged',
    `ledger evidence changed across the restart boundary at ${difference} ` +
      `(before=${financialJournalEvidenceFingerprint(before).slice(0, 16)} after=${financialJournalEvidenceFingerprint(after).slice(0, 16)})`
  );
}

export interface FinancialJournalRestartInput {
  query: AcceptanceSqlQuery;
  competitionId: string;
  /** Actual product restart hook owned by the runner. */
  restart: () => Promise<void>;
  expectations?: FinancialJournalExpectations;
  /** Bounded settle delay after the restart hook before the second capture. */
  afterRestartDelayMs?: number;
}

export interface FinancialJournalRestartResult {
  before: FinancialJournalEvidence;
  after: FinancialJournalEvidence;
  digest: FinancialJournalDigest;
  fingerprint: string;
}

/**
 * Runner contract: capture + validate, restart the actual product process,
 * capture again and require byte-identical ledger evidence. No product write,
 * no provider call, no platform source import.
 */
export async function assertExactlyOnceFinancialJournalsAcrossRestart(
  input: FinancialJournalRestartInput
): Promise<FinancialJournalRestartResult> {
  const before = await captureFinancialJournalEvidence(input.query, input.competitionId);
  const digest = assertExactlyOnceFinancialJournals(before, input.expectations);
  await input.restart();
  const delayMs = input.afterRestartDelayMs ?? 0;
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const after = await captureFinancialJournalEvidence(input.query, input.competitionId);
  assertFinancialJournalEvidenceUnchanged(before, after);
  return { before, after, digest, fingerprint: financialJournalEvidenceFingerprint(after) };
}
