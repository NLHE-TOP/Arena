/**
 * Read-only platform metrics access for independent rate-limit gates.
 *
 * The SDK retries 429s internally, so a driver can observe zero 429 errors
 * while the platform actually answered 429 many times. The focused gates
 * therefore compare the platform's own Prometheus counter
 * `pokertools_http_requests_total{...status="429"}` before and after the run.
 */
export interface PlatformMetricsSource {
  /** Platform base URL (the helper appends `/metrics`) or a full `/metrics` URL. */
  url: string;
  /** Bearer METRICS_TOKEN when the platform enforces production metrics auth. */
  token?: string | null;
}

const METRIC = 'pokertools_http_requests_total';
const STATUS_429 = /(?:^|,)status="429"(?:,|$)/;

function metricsUrl(source: PlatformMetricsSource): string {
  return source.url.endsWith('/metrics') ? source.url : `${source.url.replace(/\/$/, '')}/metrics`;
}

/**
 * Total HTTP 429 responses recorded by the platform so far. Throws when the
 * endpoint is unreachable/unauthorized or the expected counter family is
 * absent, so a focused gate can never claim "zero 429" from a missing source.
 */
export async function readPlatform429Total(source: PlatformMetricsSource): Promise<number> {
  const url = metricsUrl(source);
  const headers: Record<string, string> = {};
  if (source.token) headers.authorization = `Bearer ${source.token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`platform metrics unavailable at ${url}: HTTP ${response.status}`);
  }
  const text = await response.text();
  let total = 0;
  let sawFamily = false;
  for (const line of text.split('\n')) {
    const sample = /^pokertools_http_requests_total(?:\{([^}]*)\})?\s+(\S+)(?:\s+\S+)?$/.exec(line);
    if (sample === null) continue;
    sawFamily = true;
    if (!STATUS_429.test(sample[1] ?? '')) continue;
    const value = Number(sample[2]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('platform 429 counter is invalid');
    total += value;
  }
  if (!sawFamily) {
    throw new Error(`platform metrics at ${url} did not expose ${METRIC}`);
  }
  return total;
}
