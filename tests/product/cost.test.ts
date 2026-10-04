/**
 * Integer micro-USD cost tests: per-million integer prices, ceiling-rounded per
 * token term, no floating point money.
 */
import { describe, expect, it } from 'vitest';
import {
  ceilDivBigInt,
  computeUsageCostUsdMicro,
  estimateRequestCostCeilingUsdMicro,
  tokenTermCostUsdMicro,
} from '../../src/llm/cost.js';

describe('integer usage costUsdMicro', () => {
  it('rounds every token term up rather than away', () => {
    expect(ceilDivBigInt(0n, 1_000_000n)).toBe(0n);
    expect(ceilDivBigInt(1n, 1_000_000n)).toBe(1n);
    expect(tokenTermCostUsdMicro(0, 1_000_000n)).toBe(0n);
    expect(tokenTermCostUsdMicro(null, 5n)).toBe(0n);
    expect(tokenTermCostUsdMicro(undefined, 5n)).toBe(0n);
    expect(tokenTermCostUsdMicro(1, 1n)).toBe(1n);
    expect(tokenTermCostUsdMicro(1, 1_000_000n)).toBe(1n);
    expect(tokenTermCostUsdMicro(1, 2_500_000n)).toBe(3n);
    expect(tokenTermCostUsdMicro(1_000_000, 3n)).toBe(3n);
    expect(tokenTermCostUsdMicro(3, 2_000_000n)).toBe(6n);
  });

  it('sums independently rounded input and output terms', () => {
    expect(
      computeUsageCostUsdMicro({
        inputTokens: 1,
        outputTokens: 1,
        inputUsdMicroPerMillion: 1n,
        outputUsdMicroPerMillion: 1n,
      }),
    ).toBe(2n);
    expect(
      computeUsageCostUsdMicro({
        inputTokens: 1,
        outputTokens: 3,
        inputUsdMicroPerMillion: 2_500_000n,
        outputUsdMicroPerMillion: 1_000_000n,
      }),
    ).toBe(6n);
    expect(
      computeUsageCostUsdMicro({
        inputTokens: null,
        outputTokens: null,
        inputUsdMicroPerMillion: 999n,
        outputUsdMicroPerMillion: 999n,
      }),
    ).toBe(0n);
  });

  it('rejects malformed token counts and prices instead of guessing', () => {
    expect(() => tokenTermCostUsdMicro(1.5, 1n)).toThrow(/non-negative integer/);
    expect(() => tokenTermCostUsdMicro(-1, 1n)).toThrow(/non-negative integer/);
    expect(() => tokenTermCostUsdMicro(1, -1n)).toThrow(/non-negative/);
    expect(() => tokenTermCostUsdMicro(1, 1 as unknown as bigint)).toThrow(/bigint/);
    expect(() =>
      computeUsageCostUsdMicro({
        inputTokens: 1,
        outputTokens: 1.5,
        inputUsdMicroPerMillion: 1n,
        outputUsdMicroPerMillion: 1n,
      }),
    ).toThrow(/non-negative integer/);
    expect(() => ceilDivBigInt(1n, 0n)).toThrow(/positive divisor/);
  });

  it('bounds a call pre-HTTP from its exact body bytes and output cap', () => {
    expect(
      estimateRequestCostCeilingUsdMicro({
        requestBytes: 100,
        maxOutputTokens: 10,
        inputUsdMicroPerMillion: 1_000_000n,
        outputUsdMicroPerMillion: 1_000_000n,
      }),
    ).toBe(110n);
    expect(() =>
      estimateRequestCostCeilingUsdMicro({
        requestBytes: -1,
        maxOutputTokens: 10,
        inputUsdMicroPerMillion: 1n,
        outputUsdMicroPerMillion: 1n,
      }),
    ).toThrow(/requestBytes/);
  });
});
