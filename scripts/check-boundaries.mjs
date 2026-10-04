import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : path.join(directory, entry.name)));
  return nested.flat();
}
const errors = [];
for (const root of ['src', 'web']) {
  for (const file of await files(root)) {
    if (!/\.(?:ts|js|html)$/.test(file)) continue;
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)/g)) {
      const specifier = match[1];
      if (specifier.startsWith('@pokertools/') && !['@pokertools/sdk', '@pokertools/types'].includes(specifier)) {
        errors.push(`${file}: private platform dependency ${specifier}`);
      }
      if (/(?:^|\/)pokertools(?:-arena)?(?:\/|$)|prisma/i.test(specifier)) errors.push(`${file}: platform persistence/source import`);
      if (root === 'web' && /(?:src\/|server|database|product\/store|llm\/|agents\/runtime)/.test(specifier)) {
        errors.push(`${file}: server dependency in browser`);
      }
    }
    if (/PAYOUT_TREASURY_PRIVATE_KEY|RPC_QUORUM|custody mnemonic|ledger_posting|new PokerEngine/.test(source)) {
      errors.push(`${file}: duplicated platform authority`);
    }
    if (root === 'src' && !file.startsWith('src/llm/') && /\bfetch\s*\(/.test(source)) {
      errors.push(`${file}: HTTP transport outside the provider boundary; use the public SDK`);
    }
    if (/(?:replay|statistic|stats)/.test(file) && /new\s+ProductDecisionProvider|\.chooseAction\s*\(/.test(source)) {
      errors.push(`${file}: provider execution in a read-only product surface`);
    }
  }
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Public package and browser boundaries passed');
