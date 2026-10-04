#!/usr/bin/env tsx
/**
 * Tests-only ledger fixture child.
 *
 * Private fixture import of local PokerTools production source (never copied).
 * Runs in an isolated child process with a filtered platform environment and no
 * provider credentials. It performs exactly one declared infrastructure action:
 * an idempotent, balanced classification of already-claimed sponsor funds from
 * USER_AVAILABLE to the same principal's OPERATOR account (the account the
 * platform debits for a competition prize reserve). It never creates value.
 *
 *   node --import tsx tests/integration/fixtures/ledger-fixture.ts classify <assetId> <principalId> <amountAtomic> <requestId>
 *   node --import tsx tests/integration/fixtures/ledger-fixture.ts accounts <assetId> <principalId>
 */
import { createPrismaClient } from '../../../pokertools/packages/api/src/utils/prisma-client.js';
import {
  AtomicLedger,
  runTransactionWithRetry,
} from '../../../pokertools/packages/api/src/services/atomic-ledger.js';

const [command, assetId, principalId, amountText, requestId] = process.argv.slice(2);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!assetId || !principalId) fail('usage: ledger-fixture <classify|accounts> <assetId> <principalId> ...');
  const prisma = createPrismaClient();
  try {
    const ledger = new AtomicLedger(prisma as never);
    if (command === 'classify') {
      if (!amountText || !requestId) fail('classify requires <amountAtomic> <requestId>');
      const amount = BigInt(amountText);
      if (amount <= 0n) fail('amount must be positive');
      await runTransactionWithRetry(prisma as never, async (tx) => {
        const available = await ledger.ensureAccount(tx, {
          assetId,
          ownerId: principalId,
          class: 'USER_AVAILABLE',
        });
        const operator = await ledger.ensureAccount(tx, {
          assetId,
          ownerId: principalId,
          class: 'OPERATOR',
        });
        await ledger.post(tx, {
          assetId,
          requestId,
          postings: [
            { accountId: available.accountId, amountAtomic: (-amount).toString() },
            { accountId: operator.accountId, amountAtomic: amount.toString() },
          ],
        });
      });
      process.stdout.write(JSON.stringify({ ok: true, classified: amount.toString() }) + '\n');
      return;
    }
    if (command === 'accounts') {
      const accounts = await prisma.atomicAccount.findMany({
        where: { assetId, ownerId: principalId },
        select: { class: true, balanceAtomic: true },
      });
      process.stdout.write(JSON.stringify({ accounts }) + '\n');
      return;
    }
    fail(`unknown command ${command}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
