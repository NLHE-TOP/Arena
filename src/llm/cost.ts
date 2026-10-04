/**
 * Integer usage cost for a single product-owned LLM call.
 *
 * Prices are integer micro-USD per 1,000,000 tokens. Cost is never computed
 * with floating point: each token term is ceiling-rounded independently in
 * `bigint`, so a sub-micro charge still costs one micro-USD rather than being
 * rounded away:
 *
 *     ceil(inputTokens  * inputPrice  / 1_000_000)
 *   + ceil(outputTokens * outputPrice / 1_000_000)
 *
 * The result is `costUsdMicro`, an exact non-negative integer. Callers persist
 * it through their own canonical formatting; this module never formats money.
 */

/** Integer micro-USD per 1,000,000 tokens. */
export type MicroUsdPerMillion = bigint;

/** Smallest usable non-negative micro-USD price (0 is a valid free rate). */
const TOKENS_PER_MILLION = 1_000_000n;

/** Ceiling division `ceil(n / d)` for non-negative `n` and positive `d`. */
export function ceilDivBigInt(n: bigint, d: bigint): bigint {
  if (n < 0n) throw new RangeError('ceilDivBigInt requires a non-negative dividend');
  if (d <= 0n) throw new RangeError('ceilDivBigInt requires a positive divisor');
  return (n + d - 1n) / d;
}

function assertTokenCount(tokens: number, label: string): void {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new RangeError(`${label} must be a non-negative integer: ${String(tokens)}`);
  }
}

function assertPrice(price: MicroUsdPerMillion, label: string): void {
  if (typeof price !== 'bigint') {
    throw new TypeError(`${label} must be a bigint micro-USD per million value`);
  }
  if (price < 0n) {
    throw new RangeError(`${label} must be non-negative`);
  }
}

/** One ceiling-rounded token term: `ceil(tokens * price / 1_000_000)`. */
export function tokenTermCostUsdMicro(
  tokens: number | null | undefined,
  priceMicroUsdPerMillion: MicroUsdPerMillion,
): bigint {
  assertPrice(priceMicroUsdPerMillion, 'priceMicroUsdPerMillion');
  if (tokens == null) return 0n;
  assertTokenCount(tokens, 'token count');
  if (tokens === 0 || priceMicroUsdPerMillion === 0n) return 0n;
  return ceilDivBigInt(BigInt(tokens) * priceMicroUsdPerMillion, TOKENS_PER_MILLION);
}

export interface UsageCostInput {
  inputTokens?: number | null;
  outputTokens?: number | null;
  inputUsdMicroPerMillion: MicroUsdPerMillion;
  outputUsdMicroPerMillion: MicroUsdPerMillion;
}

/**
 * Exact integer cost of observed provider usage. Missing token counts
 * contribute zero; malformed counts or prices throw rather than silently
 * producing a wrong charge.
 */
export function computeUsageCostUsdMicro(input: UsageCostInput): bigint {
  return (
    tokenTermCostUsdMicro(input.inputTokens, input.inputUsdMicroPerMillion) +
    tokenTermCostUsdMicro(input.outputTokens, input.outputUsdMicroPerMillion)
  );
}

export interface RequestCostCeilingInput {
  /**
   * Exact UTF-8 byte length of the serialized request. Every token is encoded
   * as at least one byte, so this is a safe upper bound on input tokens.
   */
  requestBytes: number;
  /** Hard output-token cap configured for the call. */
  maxOutputTokens: number;
  inputUsdMicroPerMillion: MicroUsdPerMillion;
  outputUsdMicroPerMillion: MicroUsdPerMillion;
}

/** Conservative pre-HTTP worst-case cost ceiling for one call attempt. */
export function estimateRequestCostCeilingUsdMicro(input: RequestCostCeilingInput): bigint {
  assertTokenCount(input.requestBytes, 'requestBytes');
  assertTokenCount(input.maxOutputTokens, 'maxOutputTokens');
  return computeUsageCostUsdMicro({
    inputTokens: input.requestBytes,
    outputTokens: input.maxOutputTokens,
    inputUsdMicroPerMillion: input.inputUsdMicroPerMillion,
    outputUsdMicroPerMillion: input.outputUsdMicroPerMillion,
  });
}
