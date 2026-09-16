/**
 * Update-channel policy shared by startup, the Help menu and tests.
 *
 * Installing a `-beta.N` build is the opt-in: it follows the beta feed and
 * may later move to a semantically newer stable release. Stable builds stay
 * on `latest` and never consider prereleases. Assigning electron-updater's
 * `channel` flips `allowDowngrade` to true internally, so this module always
 * restores the no-downgrade invariant after selecting the feed.
 */

export type UpdateChannel = 'latest' | 'beta';

export interface UpdatePolicy {
  channel: UpdateChannel;
  allowPrerelease: boolean;
  allowDowngrade: false;
  /** Betas require an explicit user check until launch-crash recovery exists. */
  automaticCheck: boolean;
  installOnQuit: boolean;
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: Array<number | string>;
}

export interface ConfigurableUpdater {
  channel: string | null;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseIdentifier(value: string): number | string {
  return /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.').map(parseIdentifier) : [],
  };
}

function compareIdentifiers(left: number | string, right: number | string): number {
  if (left === right) return 0;
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return left < right ? -1 : 1;
}

function compareParsed(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    if (index >= left.prerelease.length) return -1;
    if (index >= right.prerelease.length) return 1;
    const compared = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

function isBeta(parsed: ParsedVersion): boolean {
  return parsed.prerelease.length === 2
    && parsed.prerelease[0] === 'beta'
    && typeof parsed.prerelease[1] === 'number';
}

export function updatePolicyForVersion(version: string): UpdatePolicy {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`Invalid application version: ${version}`);
  const beta = isBeta(parsed);
  return {
    channel: beta ? 'beta' : 'latest',
    allowPrerelease: beta,
    allowDowngrade: false,
    automaticCheck: !beta,
    installOnQuit: !beta,
  };
}

/** The update-info filename prefix electron-builder must derive. */
export function updateMetadataChannel(version: string): UpdateChannel {
  return updatePolicyForVersion(version).channel;
}

/**
 * Defense-in-depth check for downloaded metadata. electron-updater performs
 * the same version ordering, but this makes the product policy explicit and
 * independently testable.
 */
export function shouldAcceptUpdate(currentVersion: string, candidateVersion: string): boolean {
  const current = parseVersion(currentVersion);
  const candidate = parseVersion(candidateVersion);
  if (!current || !candidate) return false;
  if (compareParsed(candidate, current) <= 0) return false;

  const currentIsBeta = isBeta(current);
  if (!currentIsBeta) return candidate.prerelease.length === 0;

  // A beta installation may follow beta or graduate to stable. It never
  // crosses to another prerelease channel.
  return candidate.prerelease.length === 0 || isBeta(candidate);
}

export function configureAutoUpdater(
  updater: ConfigurableUpdater,
  installedVersion: string,
): UpdatePolicy {
  const policy = updatePolicyForVersion(installedVersion);
  updater.channel = policy.channel;
  updater.allowPrerelease = policy.allowPrerelease;
  // Must be assigned last: electron-updater's channel setter sets this true.
  updater.allowDowngrade = false;
  return policy;
}
