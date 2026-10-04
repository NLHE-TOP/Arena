import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const findings = [];
const rules = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{32,}\b/,
  /\bptsvc_[A-Za-z0-9_-]{43}\b/,
  /(?:API_KEY|ADMIN_TOKEN|ORCHESTRATION_TOKEN)\s*=\s*['"]?[A-Za-z0-9_-]{32,}/,
];
/** Obvious synthetic placeholders are not live credentials. */
const PLACEHOLDER = /(?:test|example|placeholder|replace|fixture|dummy|synthetic)/i;
for (const file of paths) {
  // Only file names are printed: a failure must not leak the matching secret.
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const uncommented = text.replace(/^[ \t]*#.*$/gm, '');
  const template = file === '.env.example';
  const genericMatch = /(?:API_KEY|ADMIN_TOKEN|ORCHESTRATION_TOKEN)\s*=\s*['"]?([A-Za-z0-9_-]{32,})/.exec(uncommented);
  const genericIsPlaceholder = genericMatch !== null && PLACEHOLDER.test(genericMatch[1]);
  // Templates may contain placeholder names; live credential shapes are still
  // detected because they are not comments.
  if (rules.some((rule, index) => {
    if (template && index === 3) return false;
    if (index === 3 && genericIsPlaceholder) return false;
    return rule.test(uncommented);
  })) {
    findings.push(file);
  }
  if (/^(?:\.env$|coverage\/|tests\/artifacts\/|pokertools\/)|\.(?:sqlite|db)$/.test(file)) findings.push(file);
}
if (findings.length) {
  console.error('Secret/artifact scan failed:', [...new Set(findings)].join(', '));
  process.exitCode = 1;
} else console.log('Tracked-source secret and artifact scan passed');
