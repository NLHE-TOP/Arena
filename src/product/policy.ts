/**
 * Product room policies.
 *
 * A policy is the economic envelope of a room. It is resolved from operator
 * input, snapshotted to JSON by `ProductStore`, and re-checked on every roster
 * change:
 *
 * - `SPONSORED`: 2..10 seats of any HUMAN/AGENT mix. Entry fees, prizes and
 *   settlement assets are forbidden.
 * - `CHALLENGE`: exactly one HUMAN plus 1..9 AGENTs. Finance terms are
 *   optional; when present they must be explicitly opted into (`optIn: true`)
 *   and carry the complete atomic entry/prize/asset triple.
 *
 * A DRAFT room may hold a partial roster while it waits for participants, so
 * `resolveProductPolicy` validates the policy envelope and the supplied
 * participants (shape and per-kind caps), while `assertRosterSatisfiesPolicy`
 * enforces final roster rules when provisioning starts and
 * `assertParticipantAllowed` checks each incremental join.
 *
 * All validation is performed by the zod schemas exported below; failures are
 * wrapped in `PolicyViolationError` with a stable `code`.
 */
import { z } from 'zod';

/** Canonical positive base-10 atomic amount (no floats, exponents or leading zeros). */
export const AtomicAmountSchema = z.string().refine((value) => {
  if (!/^(0|[1-9]\d*)$/.test(value)) return false;
  return BigInt(value) > 0n;
}, 'must be a positive canonical base-10 integer string');

/** Settlement asset identifier (non-empty, no whitespace). */
export const AssetIdSchema = z
  .string()
  .min(1)
  .refine((value) => !/\s/.test(value), 'must not contain whitespace');

export const ParticipantKindSchema = z.enum(['HUMAN', 'AGENT']);

export const PolicyParticipantSchema = z
  .strictObject({
    kind: ParticipantKindSchema,
    agentId: z.string().min(1).nullable().optional(),
    /** Principal identity; required by the store when creating room participants. */
    principalId: z.string().min(1).optional(),
  })
  .superRefine((participant, ctx) => {
    if (participant.kind === 'AGENT' && participant.agentId == null) {
      ctx.addIssue({ code: 'custom', path: ['agentId'], message: 'AGENT participant requires an agentId' });
    }
    if (participant.kind === 'HUMAN' && participant.agentId != null) {
      ctx.addIssue({ code: 'custom', path: ['agentId'], message: 'HUMAN participant must not carry an agentId' });
    }
  });

export const ChallengeFinanceOptInSchema = z.strictObject({
  optIn: z.literal(true),
  entryAtomic: AtomicAmountSchema,
  prizeAtomic: AtomicAmountSchema,
  assetId: AssetIdSchema,
});

export const SponsoredPolicyInputSchema = z.strictObject({
  kind: z.literal('SPONSORED'),
  participants: z.array(PolicyParticipantSchema),
  finance: z.null().optional(),
});

export const ChallengePolicyInputSchema = z.strictObject({
  kind: z.literal('CHALLENGE'),
  participants: z.array(PolicyParticipantSchema),
  finance: ChallengeFinanceOptInSchema.nullable().optional(),
});

export const ProductPolicyInputSchema = z.discriminatedUnion('kind', [
  SponsoredPolicyInputSchema,
  ChallengePolicyInputSchema,
]);

export type ParticipantKind = z.infer<typeof ParticipantKindSchema>;
export type PolicyParticipant = z.infer<typeof PolicyParticipantSchema>;
export type ChallengeFinanceOptIn = z.infer<typeof ChallengeFinanceOptInSchema>;
export type ProductPolicyInput = z.infer<typeof ProductPolicyInputSchema>;
export type ProductPolicyKind = ProductPolicyInput['kind'];

/** Validated CHALLENGE finance terms (the opt-in flag is consumed). */
export interface ChallengeFinanceTerms {
  readonly entryAtomic: string;
  readonly prizeAtomic: string;
  readonly assetId: string;
}

/** Resolved SPONSORED snapshot; counts are captured when it was resolved. */
export interface SponsoredPolicy {
  readonly kind: 'SPONSORED';
  readonly seatCount: number;
  readonly humanCount: number;
  readonly agentCount: number;
  readonly finance: null;
}

/** Resolved CHALLENGE snapshot; counts are captured when it was resolved. */
export interface ChallengePolicy {
  readonly kind: 'CHALLENGE';
  readonly seatCount: number;
  readonly humanCount: number;
  readonly agentCount: number;
  readonly finance: ChallengeFinanceTerms | null;
}

export type ProductPolicy = SponsoredPolicy | ChallengePolicy;

/** Stable failure codes for policy validation. */
export type PolicyViolationCode =
  | 'INVALID_KIND'
  | 'INVALID_PARTICIPANT'
  | 'SEAT_COUNT'
  | 'HUMAN_COUNT'
  | 'AGENT_COUNT'
  | 'FINANCE_NOT_ALLOWED'
  | 'FINANCE_OPT_IN_REQUIRED'
  | 'ATOMIC_AMOUNT'
  | 'ASSET_ID';

export class PolicyViolationError extends Error {
  readonly code: PolicyViolationCode;

  constructor(code: PolicyViolationCode, message: string) {
    super(message);
    this.name = 'PolicyViolationError';
    this.code = code;
  }
}

function violationCode(issue: { code: string; path: PropertyKey[] }): PolicyViolationCode {
  const path = issue.path.map(String).join('.');
  if (path === 'finance' && issue.code === 'invalid_type') return 'FINANCE_NOT_ALLOWED';
  if (path.startsWith('finance')) {
    if (path.endsWith('entryAtomic') || path.endsWith('prizeAtomic')) return 'ATOMIC_AMOUNT';
    if (path.endsWith('assetId')) return 'ASSET_ID';
    return 'FINANCE_OPT_IN_REQUIRED';
  }
  if (path.startsWith('participants')) return 'INVALID_PARTICIPANT';
  return 'INVALID_KIND';
}

function parsePolicy<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new PolicyViolationError(
      issue === undefined ? 'INVALID_KIND' : violationCode(issue),
      issue?.message ?? 'invalid policy',
    );
  }
  return result.data;
}

/** Validate and normalize one participant. */
export function normalizePolicyParticipant(participant: unknown): PolicyParticipant {
  return parsePolicy(PolicyParticipantSchema, participant);
}

/** Validate explicit CHALLENGE finance terms (requires `optIn: true`). */
export function validateChallengeFinanceTerms(terms: unknown): ChallengeFinanceTerms {
  const parsed = parsePolicy(ChallengeFinanceOptInSchema, terms);
  return Object.freeze({
    entryAtomic: parsed.entryAtomic,
    prizeAtomic: parsed.prizeAtomic,
    assetId: parsed.assetId,
  });
}

function countRoster(participants: readonly PolicyParticipant[]): {
  seatCount: number;
  humanCount: number;
  agentCount: number;
} {
  let humanCount = 0;
  let agentCount = 0;
  for (const participant of participants) {
    if (participant.kind === 'HUMAN') humanCount += 1;
    else agentCount += 1;
  }
  return { seatCount: humanCount + agentCount, humanCount, agentCount };
}

/**
 * Resolve and validate a policy envelope plus the participants supplied with
 * it. Enforces per-kind caps (SPONSORED ≤10 seats; CHALLENGE ≤1 HUMAN and
 * ≤9 AGENTs) and the SPONSORED ban on finance terms. Minimum/exact roster
 * sizes are enforced by `assertRosterSatisfiesPolicy`.
 */
export function resolveProductPolicy(input: unknown): ProductPolicy {
  const parsed = parsePolicy(ProductPolicyInputSchema, input);
  const counts = countRoster(parsed.participants);

  if (parsed.kind === 'SPONSORED') {
    if (counts.seatCount > 10) {
      throw new PolicyViolationError('SEAT_COUNT', 'SPONSORED rooms allow at most 10 seats');
    }
    return Object.freeze({ kind: 'SPONSORED', ...counts, finance: null });
  }

  if (counts.humanCount > 1) {
    throw new PolicyViolationError('HUMAN_COUNT', 'CHALLENGE allows exactly one HUMAN');
  }
  if (counts.agentCount > 9) {
    throw new PolicyViolationError('AGENT_COUNT', 'CHALLENGE allows at most 9 AGENTs');
  }
  if (counts.seatCount > 10) {
    throw new PolicyViolationError('SEAT_COUNT', 'CHALLENGE rooms allow at most 10 seats');
  }
  const finance =
    parsed.finance == null
      ? null
      : validateChallengeFinanceTerms(parsed.finance);
  return Object.freeze({ kind: 'CHALLENGE', ...counts, finance });
}

/**
 * Check adding one more participant to an existing roster. Enforces per-kind
 * caps only; call `assertRosterSatisfiesPolicy` before provisioning to require
 * the final roster size.
 */
export function assertParticipantAllowed(
  policy: ProductPolicy,
  roster: readonly PolicyParticipant[],
  candidate: unknown,
): void {
  const normalized = normalizePolicyParticipant(candidate);
  const counts = countRoster(roster);
  const humanCount = counts.humanCount + (normalized.kind === 'HUMAN' ? 1 : 0);
  const agentCount = counts.agentCount + (normalized.kind === 'AGENT' ? 1 : 0);

  if (policy.kind === 'CHALLENGE') {
    if (humanCount > 1) {
      throw new PolicyViolationError('HUMAN_COUNT', 'CHALLENGE allows exactly one HUMAN');
    }
    if (agentCount > 9) {
      throw new PolicyViolationError('AGENT_COUNT', 'CHALLENGE allows at most 9 AGENTs');
    }
  }
  if (humanCount + agentCount > 10) {
    throw new PolicyViolationError('SEAT_COUNT', 'policy allows at most 10 seats');
  }
}

/**
 * Check that a roster is complete enough to provision:
 * - SPONSORED: 2..10 seats of any mix.
 * - CHALLENGE: exactly one HUMAN plus 1..9 AGENTs.
 */
export function assertRosterSatisfiesPolicy(
  policy: ProductPolicy,
  roster: readonly PolicyParticipant[],
): void {
  const counts = countRoster(roster);
  if (policy.kind === 'SPONSORED') {
    if (counts.seatCount < 2 || counts.seatCount > 10) {
      throw new PolicyViolationError('SEAT_COUNT', `SPONSORED requires 2..10 seats, got ${counts.seatCount}`);
    }
    return;
  }
  if (counts.humanCount !== 1) {
    throw new PolicyViolationError('HUMAN_COUNT', `CHALLENGE requires exactly one HUMAN, got ${counts.humanCount}`);
  }
  if (counts.agentCount < 1 || counts.agentCount > 9) {
    throw new PolicyViolationError('AGENT_COUNT', `CHALLENGE requires 1..9 AGENTs, got ${counts.agentCount}`);
  }
}
