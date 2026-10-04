/**
 * Thin public-SDK factories for the product server.
 *
 * The public `@pokertools/sdk` is the only poker/platform transport: each
 * credential gets its own client, competition orchestration uses the public
 * `CompetitionClient`, and the availability probe authenticates canonically
 * before reading public health/readiness. No platform source, persistence or
 * ad-hoc HTTP lives here, and no authorization rule is shadowed.
 */
import { CompetitionClient, PokerClient } from '@pokertools/sdk';

import type { PlatformCompetitions, PlatformProbe } from './product/rooms.js';

/** The public SDK is the only poker transport. Each credential gets its own client. */
export function platformClient(baseUrl: string, token?: string): PokerClient {
  return new PokerClient({ baseUrl, token, timeout: 10000, retry: { count: 2, delay: 100, backoff: 2 } });
}

/**
 * Adapt the public SDK competition client to the rooms interface. The
 * orchestration client carries the `competition:orchestrate` credential; no
 * wallet payer flow is proxied here (the payer opts in directly).
 */
export function platformCompetitions(baseUrl: string, token?: string): PlatformCompetitions {
  const config = {
    baseUrl,
    ...(token === undefined ? {} : { token }),
    timeout: 10000,
    retry: { count: 2, delay: 100, backoff: 2 },
  };
  const orchestration = new CompetitionClient(config);
  return {
    createCompetition: (request) => orchestration.createCompetition(request),
    getCompetition: (competitionId) => orchestration.getCompetition(competitionId),
    startCompetition: (competitionId) => orchestration.start(competitionId),
    settleCompetition: (competitionId) => orchestration.settle(competitionId),
    cancelCompetition: (competitionId) => orchestration.cancel(competitionId),
    issueAgentCredential: (competitionId, request) =>
      orchestration.issueAgentCredential(competitionId, request),
  };
}

/**
 * Platform availability probe.
 *
 * Canonical SDK authentication comes first: the configured orchestration
 * credential must resolve through `getPrincipal()` to a `SERVICE` principal.
 * A missing, invalid, revoked or WALLET (including ADMIN) credential is
 * unavailable — the product never carries broad platform authority, and it
 * never inspects JWT contents or infers scopes from the public principal
 * shape. Only after authentication are the public health/readiness endpoints
 * read; actual competition operations are authorized canonically by the
 * platform. Read-only product browsing stays available either way; room
 * operations fail closed.
 */
export function createPlatformProbe(
  platformUrl: string,
  token: string | undefined,
): PlatformProbe {
  const authenticated = async (): Promise<PokerClient> => {
    const client = platformClient(platformUrl, token);
    const principal = await client.getPrincipal();
    if (principal.kind !== 'SERVICE') {
      throw new Error('orchestration credential must resolve to a SERVICE principal');
    }
    return client;
  };
  return {
    health: async () => (await authenticated()).health(),
    readiness: async () => (await authenticated()).getReadiness(),
  };
}
