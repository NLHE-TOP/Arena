export interface ProductOutcome {
  roomId: string;
  principalId: string;
  agentId: string | null;
  placement: number;
  mode: 'SPONSORED' | 'CHALLENGE';
}

export interface ModelMetric {
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  costUsdMicro: number;
  latencyMs: number;
}

/** Outcomes are platform-result projections; compute expense is never player P&L. */
export function productStatistics(outcomes: readonly ProductOutcome[], calls: readonly ModelMetric[]) {
  const agents = new Map<string, {
    agentId: string; games: number; wins: number; calls: number;
    inputTokens: number; outputTokens: number; costUsdMicro: number; latencyMs: number;
  }>();
  const get = (agentId: string) => {
    let row = agents.get(agentId);
    if (!row) {
      row = { agentId, games: 0, wins: 0, calls: 0, inputTokens: 0, outputTokens: 0, costUsdMicro: 0, latencyMs: 0 };
      agents.set(agentId, row);
    }
    return row;
  };
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    const key = JSON.stringify([outcome.roomId, outcome.principalId]);
    if (seen.has(key)) throw new Error('Duplicate authoritative product result');
    seen.add(key);
    if (!Number.isSafeInteger(outcome.placement) || outcome.placement < 1) throw new Error('Invalid placement');
    if (!outcome.agentId) continue;
    const row = get(outcome.agentId);
    row.games++;
    row.wins += Number(outcome.placement === 1);
  }
  for (const call of calls) {
    const row = get(call.agentId);
    row.calls++;
    for (const field of ['inputTokens', 'outputTokens', 'costUsdMicro', 'latencyMs'] as const) {
      if (!Number.isSafeInteger(call[field]) || call[field] < 0) throw new Error('Invalid model analytics');
      const sum = row[field] + call[field];
      if (!Number.isSafeInteger(sum)) throw new Error('Model analytics overflow');
      row[field] = sum;
    }
  }
  return [...agents.values()].sort((a, b) => b.wins - a.wins || a.agentId.localeCompare(b.agentId));
}
