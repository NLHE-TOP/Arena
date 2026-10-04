import { rm } from 'node:fs/promises';

// A failed build must never leave a runnable mix of current and stale modules.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
