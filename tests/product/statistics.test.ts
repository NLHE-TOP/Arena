import { describe, expect, it } from 'vitest';
import { productStatistics, type ProductOutcome } from '../../src/product/statistics.js';

const result: ProductOutcome = { roomId: 'room', principalId: 'service', agentId: 'ace', placement: 1, mode: 'SPONSORED' };
describe('product statistics', () => {
  it('does not assign compute expense or financial P&L to humans', () => {
    expect(productStatistics([result, { ...result, principalId: 'wallet', agentId: null, placement: 2 }], []))
      .toEqual([{ agentId: 'ace', games: 1, wins: 1, calls: 0, inputTokens: 0, outputTokens: 0, costUsdMicro: 0, latencyMs: 0 }]);
  });
  it('aggregates integer provider expense separately', () => {
    const rows = productStatistics([result], [{ agentId: 'ace', inputTokens: 1, outputTokens: 2, costUsdMicro: 3, latencyMs: 4 }]);
    expect(rows[0].costUsdMicro).toBe(3);
    expect(rows[0]).not.toHaveProperty('profit');
  });
  it('rejects duplicate results and noninteger or overflowing costs', () => {
    expect(() => productStatistics([result, result], [])).toThrow();
    const call = { agentId: 'ace', inputTokens: 1, outputTokens: 1, costUsdMicro: 0.1, latencyMs: 1 };
    expect(() => productStatistics([], [call])).toThrow();
    expect(() => productStatistics([], [{ ...call, costUsdMicro: Number.MAX_SAFE_INTEGER }, { ...call, costUsdMicro: 1 }])).toThrow();
    expect(() => productStatistics([{ ...result, placement: 0 }], [])).toThrow();
  });
});
