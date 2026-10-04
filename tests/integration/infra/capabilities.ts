/**
 * Capability detection for in-progress public surfaces.
 *
 * The NLHE product and the platform SDK evolve together. The harness must not
 * assume an extension exists: it checks the actual built SDK source and the
 * actual running product routes, then reports PENDING with the missing
 * capability instead of guessing an interface.
 */
import type { PokerClient } from '@pokertools/sdk';

export interface SdkCapabilities {
  found: string[];
  missing: string[];
  has: (method: string) => boolean;
}

const EXPECTED_SDK_EXTENSIONS = [
  'getPrincipal',
  'getReadiness',
  'createServiceCredential',
  'listServiceCredentials',
  'revokeServiceCredential',
  'getChat',
  'sendChat',
  'getReplay',
  // In progress on the public API (`POST /chips/grant`); not yet an SDK method.
  'grantChips',
] as const;

export function detectSdkCapabilities(client: PokerClient | object): SdkCapabilities {
  const prototype = Object.getPrototypeOf(client) as Record<string, unknown>;
  const found: string[] = [];
  const missing: string[] = [];
  for (const method of EXPECTED_SDK_EXTENSIONS) {
    if (typeof prototype?.[method] === 'function') found.push(method);
    else missing.push(method);
  }
  return {
    found,
    missing,
    has: (method) => typeof prototype?.[method] === 'function',
  };
}

export interface HttpProbe {
  path: string;
  status: number | null;
  available: boolean;
  detail: string;
}

export interface ProductSurface {
  baseUrl: string;
  healthPath: string | null;
  catalog: HttpProbe[];
  rooms: HttpProbe[];
  probes: HttpProbe[];
}

export function productRouteCandidates(): { catalog: string[]; rooms: string[] } {
  const override = process.env.NLHE_IT_PRODUCT_ROUTES;
  if (override) {
    const parsed = JSON.parse(override) as { catalog?: string[]; rooms?: string[] };
    return { catalog: parsed.catalog ?? [], rooms: parsed.rooms ?? [] };
  }
  return {
    catalog: ['/api/catalog', '/api/agents', '/v1/agents'],
    rooms: ['/api/rooms', '/api/lobbies', '/v1/lobbies/current'],
  };
}

async function probe(baseUrl: string, path: string): Promise<HttpProbe> {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    // 404/405 means the surface is not implemented; 401/403 means it exists
    // behind authentication (expected for product-owned orchestration routes).
    const available = response.status !== 404 && response.status !== 405 && response.status < 500;
    return {
      path,
      status: response.status,
      available,
      detail: available ? `HTTP ${response.status}` : `HTTP ${response.status} (not implemented)`,
    };
  } catch (error) {
    return {
      path,
      status: null,
      available: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeProductSurface(baseUrl: string): Promise<ProductSurface> {
  const expected = productRouteCandidates();
  // The product exposes exactly /health (liveness) and /ready (readiness).
  const healthCandidates = ['/health'];
  let healthPath: string | null = null;
  const probes: HttpProbe[] = [];
  for (const path of healthCandidates) {
    const result = await probe(baseUrl, path);
    probes.push(result);
    if (result.status === 200 && healthPath === null) healthPath = path;
  }
  probes.push(await probe(baseUrl, '/ready'));
  const catalog: HttpProbe[] = [];
  for (const path of expected.catalog) catalog.push(await probe(baseUrl, path));
  const rooms: HttpProbe[] = [];
  for (const path of expected.rooms) rooms.push(await probe(baseUrl, path));
  return { baseUrl, healthPath, catalog, rooms, probes: [...probes, ...catalog, ...rooms] };
}

export function surfaceReady(surface: ProductSurface): boolean {
  return surface.catalog.some((entry) => entry.available) && surface.rooms.some((entry) => entry.available);
}

export function describeSurface(surface: ProductSurface): string {
  const render = (probes: HttpProbe[]) =>
    probes.length === 0 ? 'none configured' : probes.map((entry) => `${entry.path}=${entry.status ?? 'ERR'}`).join(' ');
  return `health=${surface.healthPath ?? 'none'}; catalog[${render(surface.catalog)}]; rooms[${render(surface.rooms)}]`;
}
