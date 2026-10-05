#!/usr/bin/env tsx
/**
 * Standalone deterministic tournament blind-boundary acceptance entrypoint.
 *
 *   NLHE_IT_STAGING_FIXTURE=<abs path to staging-platform.mjs> \
 *     tsx tests/integration/tournament-blind-boundary.ts
 *
 * Brings up a fresh disposable staging topology (external fixture), then runs
 * the competition-backed tournament scenario in
 * `acceptance/tournament-blind-boundary.ts`: two real wallet entrants in a
 * public `CompetitionClient` NONFINANCIAL competition (the same production
 * path NLHE uses), the legitimate initial DEAL from `start`, auto-dealt
 * following hands, a real worker-driven blind boundary crossed while hands
 * finish, and settlement to FINISHED — with the platform's own 429 counter
 * delta asserted to be exactly zero. No legacy `/tournaments` route is
 * touched: no self-registration, no manual DEAL/advance-blinds.
 *
 * Exit codes: 0 PASS, 1 acceptance FAIL, 2 not runnable (missing fixture).
 * No paid provider is ever used and no manual DEAL/advance-blinds workaround
 * exists.
 *
 * Environment:
 *   NLHE_IT_STAGING_FIXTURE  absolute path to the built external staging
 *                            fixture exporting startStagingPlatform (required)
 *   NLHE_IT_PLATFORM_IMAGE   pinned PokerTools image (default: ghcr digest)
 *   NLHE_IT_KEEP             keep the run artifact directory diagnostics
 */
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createRunContext } from './infra/context.js';
import { getAccount } from './infra/wallet.js';
import { startStagingTopology, type StagingTopology } from './infra/staging.js';
import { installPlatformTrace, PLATFORM_TRACE_ARTIFACT } from './infra/trace-platform.js';
import {
  runTournamentBlindBoundary,
  type TournamentBlindBoundaryResult,
} from './acceptance/tournament-blind-boundary.js';

async function main(): Promise<number> {
  const unknown = process.argv.slice(2);
  if (unknown.length > 0) {
    console.error(`unknown tournament-blind-boundary arguments: ${unknown.join(' ')}`);
    return 2;
  }
  const fixture = process.env.NLHE_IT_STAGING_FIXTURE;
  if (fixture === undefined || !isAbsolute(fixture)) {
    console.error(
      'BLOCKED: NLHE_IT_STAGING_FIXTURE is required (absolute path to the built external staging fixture exporting startStagingPlatform)'
    );
    return 2;
  }

  const context = createRunContext();
  context.log(`tournament blind-boundary acceptance ${context.runId}`);
  context.log(`artifacts: ${context.artifactDir}`);
  context.log(`fixture: ${fixture}`);

  const trace = installPlatformTrace();
  let topology: StagingTopology | null = null;
  let result: TournamentBlindBoundaryResult | null = null;
  let failure: string | null = null;
  let code = 1;
  const checks: Array<{ name: string; status: 'PASS' | 'FAIL'; detail?: string }> = [];

  try {
    topology = await startStagingTopology({
      context,
      sponsor: { principalId: randomUUID(), address: getAccount(2).address },
    });
    context.log(`platform image: ${topology.platformImage}`);
    checks.push({ name: 'fresh disposable topology ready', status: 'PASS' });

    result = await runTournamentBlindBoundary({ context, topology });
    checks.push({ name: 'competition-backed tournament blind-boundary scenario', status: 'PASS' });
    code = 0;
  } catch (error) {
    failure = topology
      ? topology.secretRegistry.redact(error instanceof Error ? error.message : String(error))
      : error instanceof Error
        ? error.message
        : String(error);
    checks.push({
      name: 'competition-backed tournament blind-boundary scenario',
      status: 'FAIL',
      detail: failure,
    });
    context.log(`tournament blind-boundary FAIL: ${failure}`);
  } finally {
    trace.writeJsonl(join(context.artifactDir, PLATFORM_TRACE_ARTIFACT));
    trace.restore();
    if (topology) {
      const errors = await topology.stop();
      for (const cleanupError of errors) {
        context.log(`teardown: ${topology.secretRegistry.redact(cleanupError)}`);
      }
      if (errors.length > 0) code = 1;
      context.log(`teardown ${errors.length === 0 ? 'complete' : 'FAILED'}`);
    }
  }

  const summary = {
    runId: context.runId,
    kind: 'tournament-blind-boundary',
    platformImage: topology?.platformImage ?? process.env.NLHE_IT_PLATFORM_IMAGE ?? null,
    checks,
    result,
    failure,
    exitCode: code,
  };
  writeFileSync(
    join(context.artifactDir, 'tournament-blind-boundary-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  if (code === 0) context.log('TOURNAMENT_BLIND_BOUNDARY=PASS');
  return code;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
