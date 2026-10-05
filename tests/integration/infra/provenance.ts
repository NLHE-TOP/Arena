/**
 * Immutable platform/product artifact provenance for the deterministic
 * container gate and the guarded paid acceptance wrappers.
 *
 * The gate records the ACTUAL released platform artifact for each supervised
 * API, workers and custody container: Docker `Config.Image`, image ID
 * (`.Image`), `RepoDigests` digest and the monorepo root package version read
 * from `/app/package.json`, plus the ACTUAL running product container identity
 * (`Config.Image` + `.Image`, captured after start, never a pre-spawn tag
 * inspection). Both paid wrappers preflight the expected released artifact
 * against the reviewed gate summary BEFORE any topology starts, then capture
 * the ACTUAL running platform/product containers and require an exact match
 * before any provider can be used. Any missing or mismatched field fails
 * closed; a mutable tag or stale digest platform override can never authorize
 * a paid run.
 *
 * Only read-only Docker inspection/`exec` commands are used: no platform source
 * is modified, no container environment is read and no credential is printed.
 */
import { runCommand } from './proc.js';

/**
 * Immutable default of the released PokerTools platform root package version
 * (`/app/package.json`). Paid acceptance refuses any other accepted version.
 */
export const DEFAULT_RELEASE_PLATFORM_VERSION = '2.0.3';

/**
 * The ONE released immutable platform artifact acceptance is bound to (full
 * digest-pinned ghcr URI, proven by the approved 2.0.3 pull + full-smoke
 * evidence). Staging derives its default from this constant and paid
 * acceptance rejects every other reference, including stale immutable digests.
 */
export const RELEASED_PLATFORM_IMAGE =
  'ghcr.io/aaurelions/pokertools@sha256:a7342a355c3bd35b7cec7acf6b6c50c320227b30b85598a08dae3a1fda00cfe9';

/** Monorepo root package manifest inside the pinned PokerTools image. */
export const PLATFORM_ROOT_PACKAGE_PATH = '/app/package.json';

/** The `docker inspect` identity used for a platform container. */
export const CONTAINER_PROVENANCE_FORMAT =
  '{{.Config.Image}}|{{.Image}}|{{.State.StartedAt}}|{{.State.Running}}';

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const IMAGE_DIGEST_RE = /@(sha256:[0-9a-f]{64})$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** The immutable platform artifact a reviewed gate summary authorizes. */
export interface PlatformArtifact {
  /** Root package version observed inside the platform containers. */
  version: string;
  /** Actual Docker `Config.Image` of the platform containers. */
  image: string;
  /** Actual Docker image ID (`sha256:...`). */
  imageId: string;
  /** Actual RepoDigests digest, or null when the image is not digest-backed. */
  digest: string | null;
}

/** Immutable product image identity recorded by the gate. */
export interface ProductArtifact {
  image: string;
  imageId: string;
}

/** Provenance required from the reviewed deterministic gate summary. */
export interface GateImmutableArtifact {
  platform: PlatformArtifact;
  product: ProductArtifact;
}

/** Expected immutable release artifact resolved from local configuration. */
export interface ExpectedPlatformArtifact {
  version: string;
  image: string;
  digest: string;
}

/** Actual provenance of one supervised platform container. */
export interface ContainerProvenance {
  container: string;
  configImage: string;
  imageId: string;
  repoDigests: string[];
  packageVersion: string;
  startedAt: string;
}

export interface PlatformRuntimeProvenance {
  artifact: PlatformArtifact;
  containers: ContainerProvenance[];
}

export interface PlatformContainerNames {
  api: string;
  workers: string;
  custody: string;
}

export function isSha256(value: string): boolean {
  return SHA256_RE.test(value);
}

/** Extract `sha256:<digest>` from an `image@sha256:<digest>` reference. */
export function parseImageDigest(imageRef: string): string | null {
  return IMAGE_DIGEST_RE.exec(imageRef.trim())?.[1] ?? null;
}

/** Extract `sha256:<digest>` from a full `repo@sha256:<digest>` RepoDigests entry. */
export function digestFromRepoDigest(repoDigest: string): string | null {
  return IMAGE_DIGEST_RE.exec(repoDigest.trim())?.[1] ?? null;
}

/**
 * Resolve the image digest actually backing a container image. A digest-pinned
 * reference must be present in `RepoDigests` (fail closed), with one narrow
 * exception: Docker Desktop's containerd image store can report the manifest
 * digest itself as the inspected image ID while `RepoDigests` is empty, so an
 * ACTUAL image ID equal to the pinned digest is accepted as evidence. An
 * unpinned image resolves only when exactly one digest is exposed.
 */
export function selectImageDigest(
  imageRef: string,
  repoDigests: readonly string[],
  actualImageId?: string
): string | null {
  const pinned = parseImageDigest(imageRef);
  const digests = [...new Set(repoDigests.map(digestFromRepoDigest).filter((value): value is string => value !== null))];
  if (pinned !== null) {
    if (digests.includes(pinned)) return pinned;
    if (actualImageId === pinned) return pinned;
    throw new Error(
      `platform image ${imageRef} does not expose its pinned digest ${pinned} in RepoDigests (${JSON.stringify(repoDigests)}) or as its actual image ID`
    );
  }
  if (digests.length === 1) return digests[0]!;
  if (digests.length === 0) return null;
  throw new Error(
    `platform image ${imageRef} exposes multiple RepoDigests (${digests.join(', ')}); pin the immutable digest`
  );
}

/**
 * Select exactly one supervised platform container per role from the
 * supervisor's registered names. Ambiguity or absence fails closed.
 */
export function selectPlatformContainers(names: readonly string[]): PlatformContainerNames {
  const pick = (pattern: RegExp, label: string): string => {
    const matches = names.filter((name) => pattern.test(name));
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one supervised ${label} container, saw ${
          matches.length === 0 ? 'none' : matches.join(', ')
        } (all: ${names.join(', ')})`
      );
    }
    return matches[0]!;
  };
  return {
    api: pick(/(^|[-_])api([-_]|$)/i, 'platform API'),
    workers: pick(/(^|[-_])workers?([-_]|$)/i, 'platform workers'),
    custody: pick(/(^|[-_])custody([-_]|$)/i, 'platform custody'),
  };
}

/**
 * Select the actual supervised standalone product container (never the
 * proxy sidecar) by role. Absence or ambiguity fails closed.
 */
export function selectStandaloneProductContainer(names: readonly string[]): string {
  const matches = names.filter(
    (name) => /(^|[-_])standalone([-_]|$)/i.test(name) && !/(^|[-_])proxy([-_]|$)/i.test(name)
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one supervised standalone product container, saw ${
        matches.length === 0 ? 'none' : matches.join(', ')
      } (all: ${names.join(', ')})`
    );
  }
  return matches[0]!;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error(`${label} ${JSON.stringify(value)} is not an immutable sha256 identity`);
  }
  return value;
}

/** Parse the `docker inspect` one-line identity of a platform container. */
export function parseContainerInspectState(
  stdout: string,
  container: string
): { configImage: string; imageId: string; startedAt: string; running: boolean } {
  const [configImage, imageId, startedAt, running, ...rest] = stdout.trim().split('|');
  if (
    rest.length > 0 ||
    configImage === undefined ||
    configImage.length === 0 ||
    startedAt === undefined ||
    startedAt.length === 0 ||
    (running !== 'true' && running !== 'false')
  ) {
    throw new Error(
      `unreadable docker inspect identity for ${container}: ${JSON.stringify(stdout.trim().slice(0, 200))}`
    );
  }
  return {
    configImage,
    imageId: requireSha256(imageId, `platform container ${container} image ID`),
    startedAt,
    running: running === 'true',
  };
}

/** Parse a JSON string array (Docker `RepoDigests`/`RepoTags` format). */
export function parseJsonStringArray(raw: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON: ${raw.slice(0, 120)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} is not a JSON string array`);
  }
  return parsed as string[];
}

/**
 * Reduce the three per-container captures to one consistent artifact. Any
 * disagreement (image, image ID or root package version) fails closed.
 */
export function platformArtifactFromContainers(containers: readonly ContainerProvenance[]): PlatformArtifact {
  if (containers.length === 0) throw new Error('no platform container provenance was captured');
  const [first, ...others] = containers;
  for (const other of others) {
    if (other.configImage !== first!.configImage) {
      throw new Error(
        `platform containers disagree on Config.Image: ${first!.container}=${first!.configImage} vs ${other.container}=${other.configImage}`
      );
    }
    if (other.imageId !== first!.imageId) {
      throw new Error(
        `platform containers disagree on image ID: ${first!.container}=${first!.imageId} vs ${other.container}=${other.imageId}`
      );
    }
    if (other.packageVersion !== first!.packageVersion) {
      throw new Error(
        `platform containers disagree on root package version: ${first!.container}=${first!.packageVersion} vs ${other.container}=${other.packageVersion}`
      );
    }
  }
  const repoDigests = [...new Set(containers.flatMap((container) => container.repoDigests))];
  return {
    version: first!.packageVersion,
    image: first!.configImage,
    imageId: first!.imageId,
    // Docker Desktop/containerd can report the manifest digest as the actual
    // image ID while RepoDigests is empty; the inspected ID is real evidence.
    digest: selectImageDigest(first!.configImage, repoDigests, first!.imageId),
  };
}

/** Read the monorepo root package version from a running platform container. */
async function containerPackageVersion(container: string): Promise<string> {
  const script = `process.stdout.write(JSON.parse(require('fs').readFileSync(${JSON.stringify(
    PLATFORM_ROOT_PACKAGE_PATH
  )},'utf8')).version)`;
  const result = await runCommand('docker', ['exec', container, 'node', '-e', script], { timeoutMs: 20_000 });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');
    throw new Error(`could not read the platform root package version from ${container}: ${detail}`);
  }
  const version = result.stdout.trim();
  if (!SEMVER_RE.test(version)) {
    throw new Error(`platform container ${container} reported an invalid root package version ${JSON.stringify(version)}`);
  }
  return version;
}

/**
 * Capture actual provenance of one running platform container. A missing,
 * stopped or unreadable container fails closed.
 */
export async function captureContainerProvenance(container: string): Promise<ContainerProvenance> {
  const inspect = await runCommand('docker', ['inspect', '--format', CONTAINER_PROVENANCE_FORMAT, container], {
    timeoutMs: 15_000,
  });
  if (inspect.code !== 0) {
    const detail = (inspect.stderr || inspect.stdout).trim().split('\n').slice(-3).join(' ');
    throw new Error(`docker inspect ${container} failed: ${detail}`);
  }
  const state = parseContainerInspectState(inspect.stdout, container);
  if (!state.running) {
    throw new Error(`platform container ${container} is not running (State.Running != true)`);
  }
  const imageInspect = await runCommand(
    'docker',
    ['image', 'inspect', '--format', '{{json .RepoDigests}}', state.imageId],
    { timeoutMs: 15_000 }
  );
  if (imageInspect.code !== 0) {
    const detail = (imageInspect.stderr || imageInspect.stdout).trim().split('\n').slice(-3).join(' ');
    throw new Error(`docker image inspect ${state.imageId} failed: ${detail}`);
  }
  const repoDigests = parseJsonStringArray(imageInspect.stdout.trim(), `${container} RepoDigests`);
  return {
    container,
    configImage: state.configImage,
    imageId: state.imageId,
    repoDigests,
    packageVersion: await containerPackageVersion(container),
    startedAt: state.startedAt,
  };
}

/** Capture and reconcile actual provenance of API + workers + custody. */
export async function capturePlatformRuntimeProvenance(
  containers: PlatformContainerNames
): Promise<PlatformRuntimeProvenance> {
  const captured: ContainerProvenance[] = [];
  for (const container of [containers.api, containers.workers, containers.custody]) {
    captured.push(await captureContainerProvenance(container));
  }
  return { artifact: platformArtifactFromContainers(captured), containers: captured };
}

/**
 * Parse the ACTUAL running product container inspect identity into its
 * artifact. `Config.Image` is what Docker recorded at launch (mutable tag or
 * digest) and `.Image` is the image ID actually running, so a tag replaced
 * after the gate fails the identity comparison. A non-running or unreadable
 * container fails closed.
 */
export function parseRunningProductProvenance(stdout: string, container: string): ProductArtifact {
  const state = parseContainerInspectState(stdout, container);
  if (!state.running) {
    throw new Error(`product container ${container} is not running (State.Running != true)`);
  }
  return { image: state.configImage, imageId: state.imageId };
}

/**
 * Capture the actual running product container identity immediately after
 * start (never a pre-spawn image-tag inspection).
 */
export async function captureRunningProductProvenance(container: string): Promise<ProductArtifact> {
  const inspect = await runCommand('docker', ['inspect', '--format', CONTAINER_PROVENANCE_FORMAT, container], {
    timeoutMs: 15_000,
  });
  if (inspect.code !== 0) {
    const detail = (inspect.stderr || inspect.stdout).trim().split('\n').slice(-3).join(' ');
    throw new Error(`docker inspect product container ${container} failed: ${detail}`);
  }
  return parseRunningProductProvenance(inspect.stdout, container);
}

/**
 * Resolve the expected immutable release artifact. Acceptance is bound to the
 * ONE central released platform URI: every other reference (mutable tag OR
 * stale immutable digest) is rejected and the expected version is the
 * immutable release default.
 */
export function expectedPlatformArtifact(platformImage: string = RELEASED_PLATFORM_IMAGE): ExpectedPlatformArtifact {
  const image = platformImage.trim();
  if (image !== RELEASED_PLATFORM_IMAGE) {
    throw new Error(
      `platform image ${JSON.stringify(image)} is not the released immutable artifact ${RELEASED_PLATFORM_IMAGE}; acceptance rejects stale or mutable platform image overrides`
    );
  }
  const digest = parseImageDigest(image);
  if (digest === null) {
    // Defensive: the central release constant itself must stay digest-pinned.
    throw new Error(`released platform image ${image} is not pinned to an immutable sha256 digest`);
  }
  return { version: DEFAULT_RELEASE_PLATFORM_VERSION, image, digest };
}

/**
 * Preflight: the reviewed gate summary must describe the same pinned immutable
 * release artifact configured for this paid run. Runs BEFORE any topology.
 */
export function assertExpectedPlatformArtifact(
  gate: PlatformArtifact,
  expected: ExpectedPlatformArtifact
): void {
  const problems: string[] = [];
  if (gate.version !== expected.version) {
    problems.push(`version gate=${gate.version} expected=${expected.version}`);
  }
  if (gate.image !== expected.image) {
    problems.push(`image gate=${gate.image} expected=${expected.image}`);
  }
  if (gate.digest !== expected.digest) {
    problems.push(`digest gate=${JSON.stringify(gate.digest)} expected=${expected.digest}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `reviewed deterministic gate artifact does not match the pinned release platform: ${problems.join('; ')}`
    );
  }
}

/**
 * Runtime: the ACTUAL running API/workers/custody artifact must exactly match
 * the reviewed gate artifact (version, Config.Image, image ID and digest). Any
 * missing field or mismatch fails closed before a provider can be used.
 */
export function assertPlatformArtifactMatches(
  label: string,
  gate: PlatformArtifact,
  actual: PlatformArtifact
): void {
  if (actual.version !== gate.version) {
    throw new Error(`${label} root version ${actual.version} != gate platformVersion ${gate.version}`);
  }
  if (actual.image !== gate.image) {
    throw new Error(`${label} Config.Image ${actual.image} != gate platformImage ${gate.image}`);
  }
  if (actual.imageId !== gate.imageId) {
    throw new Error(`${label} image ID ${actual.imageId} != gate platformImageId ${gate.imageId}`);
  }
  if (actual.digest === null || gate.digest === null) {
    throw new Error(
      `${label} digest provenance is unavailable (gate=${JSON.stringify(gate.digest)} actual=${JSON.stringify(
        actual.digest
      )}); paid acceptance fails closed`
    );
  }
  if (actual.digest !== gate.digest) {
    throw new Error(`${label} digest ${actual.digest} != gate platformDigest ${gate.digest}`);
  }
}

/** Runtime: the actual running platform artifact must match the gate. */
export function assertRuntimePlatformMatches(gate: PlatformArtifact, actual: PlatformArtifact): void {
  assertPlatformArtifactMatches('actual platform', gate, actual);
}

/** Runtime: the actual product image must match the reviewed gate artifact. */
export function assertProductArtifactMatches(
  label: string,
  gate: ProductArtifact,
  actual: ProductArtifact
): void {
  if (actual.image !== gate.image) {
    throw new Error(`${label} image ${actual.image} != gate productImage ${gate.image}`);
  }
  if (actual.imageId !== gate.imageId) {
    throw new Error(`${label} image ID ${actual.imageId} != gate productImageId ${gate.imageId}`);
  }
}

/** Runtime: the actual product image must match the reviewed gate artifact. */
export function assertRuntimeProductMatches(gate: ProductArtifact, actual: ProductArtifact): void {
  assertProductArtifactMatches('actual product', gate, actual);
}

function requiredSummaryString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `deterministic gate summary ${field} is missing; a paid run requires the exact immutable artifact provenance`
    );
  }
  return value;
}

/**
 * Pure extraction of the mandatory immutable artifact provenance from a
 * reviewed deterministic gate summary. Every field is required (a null or
 * absent digest/product identity fails closed).
 */
export function gateImmutableArtifactFromSummary(record: Record<string, unknown>): GateImmutableArtifact {
  return {
    platform: {
      version: requiredSummaryString(record, 'platformVersion'),
      image: requiredSummaryString(record, 'platformImage'),
      imageId: requireSha256(record['platformImageId'], 'deterministic gate summary platformImageId'),
      digest: requireSha256(record['platformDigest'], 'deterministic gate summary platformDigest'),
    },
    product: {
      image: requiredSummaryString(record, 'productImage'),
      imageId: requireSha256(record['productImageId'], 'deterministic gate summary productImageId'),
    },
  };
}

/** Projected focused terminal-FOLD evidence produced by the focused runner. */
export interface TerminalFoldEvidence {
  status: 'PASS';
  requestId: string;
  tableId: string;
  handId: string;
  family: 'FOLD';
  handCompleted: true;
  archiveCompleted: true;
  directorProgressed: true;
  continuation: 'NEXT_HAND' | 'SETTLEMENT_READY';
  roomTerminal: true;
  platform429: 0;
  secretScan: 'pass';
}

/** Validated focused proof + the artifact it was actually produced on. */
export interface ValidatedTerminalFold {
  evidence: TerminalFoldEvidence;
  provenance: GateImmutableArtifact;
}

/** Reviewed gate artifact plus its validated focused terminal-FOLD proof. */
export interface GatePaidEligibleArtifact extends GateImmutableArtifact {
  terminalFold: ValidatedTerminalFold;
}

const TERMINAL_FOLD_CONTINUATIONS = ['NEXT_HAND', 'SETTLEMENT_READY'] as const;

function requiredEvidenceString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} ${field} is missing`);
  }
  return value;
}

function requiredEvidenceTrue(record: Record<string, unknown>, field: string, label: string): true {
  if (record[field] !== true) {
    throw new Error(`${label} ${field} must be true, saw ${JSON.stringify(record[field])}`);
  }
  return true;
}

/**
 * Pure projection validator for the focused terminal-FOLD summary. Requires
 * the exact PASS evidence contract: FOLD family, completed hand/archive,
 * progressed director, a usable continuation (NEXT_HAND or SETTLEMENT_READY),
 * a terminal room, zero platform 429s and a passing secret scan.
 */
export function validateTerminalFoldEvidence(
  value: unknown,
  label = 'terminal FOLD evidence'
): TerminalFoldEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (record['status'] !== 'PASS') {
    throw new Error(`${label} status ${JSON.stringify(record['status'])} != PASS`);
  }
  if (record['family'] !== 'FOLD') {
    throw new Error(`${label} family ${JSON.stringify(record['family'])} != FOLD`);
  }
  const continuation = record['continuation'];
  if (continuation !== 'NEXT_HAND' && continuation !== 'SETTLEMENT_READY') {
    throw new Error(
      `${label} continuation ${JSON.stringify(continuation)} is not one of ${TERMINAL_FOLD_CONTINUATIONS.join('|')}`
    );
  }
  if (record['platform429'] !== 0) {
    throw new Error(`${label} platform429 ${JSON.stringify(record['platform429'])} != 0`);
  }
  if (record['secretScan'] !== 'pass') {
    throw new Error(`${label} secretScan ${JSON.stringify(record['secretScan'])} != pass`);
  }
  return {
    status: 'PASS',
    requestId: requiredEvidenceString(record, 'requestId', label),
    tableId: requiredEvidenceString(record, 'tableId', label),
    handId: requiredEvidenceString(record, 'handId', label),
    family: 'FOLD',
    handCompleted: requiredEvidenceTrue(record, 'handCompleted', label),
    archiveCompleted: requiredEvidenceTrue(record, 'archiveCompleted', label),
    directorProgressed: requiredEvidenceTrue(record, 'directorProgressed', label),
    continuation,
    roomTerminal: requiredEvidenceTrue(record, 'roomTerminal', label),
    platform429: 0,
    secretScan: 'pass',
  };
}

/** Validate the `{ platform, product }` provenance projection of a summary. */
export function immutableArtifactFromProvenance(value: unknown, label: string): GateImmutableArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} provenance is not an object`);
  }
  const record = value as Record<string, unknown>;
  const platform = record['platform'];
  const product = record['product'];
  if (typeof platform !== 'object' || platform === null || Array.isArray(platform)) {
    throw new Error(`${label} provenance.platform is not an object`);
  }
  if (typeof product !== 'object' || product === null || Array.isArray(product)) {
    throw new Error(`${label} provenance.product is not an object`);
  }
  const platformRecord = platform as Record<string, unknown>;
  const productRecord = product as Record<string, unknown>;
  return {
    platform: {
      version: requiredEvidenceString(platformRecord, 'version', `${label} provenance.platform`),
      image: requiredEvidenceString(platformRecord, 'image', `${label} provenance.platform`),
      imageId: requireSha256(platformRecord['imageId'], `${label} provenance.platform.imageId`),
      digest: requireSha256(platformRecord['digest'], `${label} provenance.platform.digest`),
    },
    product: {
      image: requiredEvidenceString(productRecord, 'image', `${label} provenance.product`),
      imageId: requireSha256(productRecord['imageId'], `${label} provenance.product.imageId`),
    },
  };
}

/**
 * Pure validator for a focused terminal-FOLD summary bound to the ACTUAL gate
 * artifact. The summary must carry the exact `provenance` (same platform
 * version/Config.Image/image ID/digest and product image identity) and the
 * exact `terminalFold` PASS evidence.
 */
export function validateTerminalFoldSummary(
  payload: unknown,
  expected: GateImmutableArtifact,
  label = 'terminal FOLD summary'
): ValidatedTerminalFold {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`${label} is not an object`);
  }
  const record = payload as Record<string, unknown>;
  const provenance = immutableArtifactFromProvenance(record['provenance'], label);
  assertPlatformArtifactMatches(`${label} platform`, expected.platform, provenance.platform);
  assertProductArtifactMatches(`${label} product`, expected.product, provenance.product);
  return { evidence: validateTerminalFoldEvidence(record['terminalFold'], `${label} terminalFold`), provenance };
}

/**
 * Pure extraction of the mandatory focused terminal-FOLD proof from a reviewed
 * deterministic gate summary. The persisted proof must be valid AND bound to
 * the gate summary's own immutable artifact (the full gate validated it
 * against the actual running artifact before persisting). A summary without
 * the proof (including every pre-fold full summary) fails closed.
 */
export function terminalFoldFromGateSummary(
  record: Record<string, unknown>,
  gate: GateImmutableArtifact
): ValidatedTerminalFold {
  const fold = record['terminalFold'];
  if (typeof fold !== 'object' || fold === null || Array.isArray(fold)) {
    throw new Error(
      'deterministic gate summary terminalFold is missing; a paid run requires a focused terminal FOLD PASS bound to the same immutable artifact'
    );
  }
  const foldRecord = fold as Record<string, unknown>;
  const provenance = immutableArtifactFromProvenance(foldRecord['provenance'], 'deterministic gate summary terminalFold');
  assertPlatformArtifactMatches('gate summary terminal FOLD platform', gate.platform, provenance.platform);
  assertProductArtifactMatches('gate summary terminal FOLD product', gate.product, provenance.product);
  return {
    evidence: validateTerminalFoldEvidence(foldRecord, 'deterministic gate summary terminalFold'),
    provenance,
  };
}
