import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPlatform429Total } from '../integration/acceptance/platform-metrics.js';

afterEach(() => vi.unstubAllGlobals());

function metrics(text: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(text)));
}

describe('independent platform rate-limit evidence', () => {
  it('counts all 429s regardless of label order or sample timestamp', async () => {
    metrics([
      'pokertools_http_requests_total{status="429",route="/tables/:id/observation",method="GET"} 2',
      'pokertools_http_requests_total{method="POST",route="/tables/:id/action",status="429"} 3 1791114288238',
      'pokertools_http_requests_total{method="GET",status="200"} 40',
    ].join('\n'));
    expect(await readPlatform429Total({ url: 'http://127.0.0.1:1' })).toBe(5);
  });

  it('does not infer zero from missing counters', async () => {
    metrics('# HELP pokertools_http_requests_total Request count\npokertools_http_requests_total_created 1');
    await expect(readPlatform429Total({ url: 'http://127.0.0.1:1' })).rejects.toThrow('did not expose');
  });

  it('rejects an invalid counter rather than silently claiming zero', async () => {
    metrics('pokertools_http_requests_total{status="429"} NaN');
    await expect(readPlatform429Total({ url: 'http://127.0.0.1:1' })).rejects.toThrow('counter is invalid');
  });
});
