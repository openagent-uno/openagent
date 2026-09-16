import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER_DATA_ARG = '--e2e-user-data-dir=';
const DESKTOP_STORE_FILE = 'openagent-desktop.json';
const NETWORK_PROFILE_DIR = 'openagent-user';

export interface LocalE2EProfile {
  userDataDir: string;
  networkProfileDir: string;
}

export interface DesktopRuntimePolicy {
  useStaticRenderer: boolean;
  bypassSingleInstanceLock: boolean;
  enableAutoUpdater: boolean;
}

/**
 * Keep the local fixture's process-level exceptions explicit and testable.
 * Packaged smoke already owns its single-instance bypass; local E2E is the
 * only mode that changes normal dev renderer, updater, and lock behaviour.
 */
export function desktopRuntimePolicy(args: {
  isPackaged: boolean;
  packagedSmoke: boolean;
  localE2E: boolean;
}): DesktopRuntimePolicy {
  return {
    useStaticRenderer: args.isPackaged || args.localE2E,
    bypassSingleInstanceLock: args.packagedSmoke || args.localE2E,
    enableAutoUpdater: args.isPackaged && !args.localE2E,
  };
}

function strictChildOf(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0
    && !relative.startsWith('..')
    && !path.isAbsolute(relative);
}

function realTempRoots(tempRoots: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const candidate of tempRoots) {
    try {
      const real = fs.realpathSync(candidate);
      if (fs.statSync(real).isDirectory()) roots.add(real);
    } catch {
      // A platform may not expose every conventional temp alias (for
      // example, /tmp on Windows). At least one real root is required below.
    }
  }
  if (roots.size === 0) {
    throw new Error('no usable OS temp directory is available for --local-e2e');
  }
  return [...roots];
}

/**
 * Resolve (without mutating Electron or the environment) the isolated local
 * E2E profile requested on the command line.
 */
export function resolveLocalE2EProfile(
  argv: readonly string[],
  tempRoots: readonly string[] = [os.tmpdir(), '/tmp'],
): LocalE2EProfile | null {
  const modeArgs = argv.filter((value) => value === '--local-e2e');
  const directoryArgs = argv.filter((value) => value.startsWith(USER_DATA_ARG));

  if (modeArgs.length > 1) {
    throw new Error('--local-e2e may only be specified once');
  }
  if (modeArgs.length === 0) {
    if (directoryArgs.length > 0) {
      throw new Error('--e2e-user-data-dir is only valid together with --local-e2e');
    }
    return null;
  }
  if (directoryArgs.length !== 1) {
    throw new Error('--local-e2e requires exactly one --e2e-user-data-dir=<existing temp directory>');
  }

  const rawUserDataDir = directoryArgs[0].slice(USER_DATA_ARG.length);
  if (!rawUserDataDir) {
    throw new Error('--e2e-user-data-dir must not be empty');
  }

  let suppliedStat: fs.Stats;
  try {
    suppliedStat = fs.lstatSync(rawUserDataDir);
  } catch {
    throw new Error('--e2e-user-data-dir must be an existing directory');
  }
  if (suppliedStat.isSymbolicLink() || !suppliedStat.isDirectory()) {
    throw new Error('--e2e-user-data-dir must be a real directory, not a file or symlink');
  }

  const userDataDir = fs.realpathSync(rawUserDataDir);
  const roots = realTempRoots(tempRoots);
  if (!roots.some((root) => strictChildOf(root, userDataDir))) {
    throw new Error('--e2e-user-data-dir must be a child of an OS temp directory');
  }

  return {
    userDataDir,
    networkProfileDir: path.join(userDataDir, NETWORK_PROFILE_DIR),
  };
}

function assertNotSymlink(target: string, expected: 'directory' | 'file'): void {
  let stat: fs.Stats;
  try {
    // lstat (rather than existsSync) also catches dangling symlinks, which
    // could otherwise redirect a later electron-store write outside /tmp.
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const validKind = expected === 'directory' ? stat.isDirectory() : stat.isFile();
  if (stat.isSymbolicLink() || !validKind) {
    throw new Error(`local E2E ${expected} must not be a symlink: ${target}`);
  }
}

/**
 * Apply the already-resolved profile before storage handlers are registered.
 * Known persistent paths are guarded against symlink escapes so a crafted
 * temp fixture cannot redirect reads or writes into the real user profile.
 */
export function applyLocalE2EProfile(
  profile: LocalE2EProfile,
  setUserDataPath: (value: string) => void,
  environment: Record<string, string | undefined> = process.env,
): void {
  const expectedNetworkProfile = path.join(profile.userDataDir, NETWORK_PROFILE_DIR);
  if (path.resolve(profile.networkProfileDir) !== expectedNetworkProfile) {
    throw new Error('local E2E network profile must be inside the isolated userData directory');
  }
  assertNotSymlink(profile.userDataDir, 'directory');
  if (fs.realpathSync(profile.userDataDir) !== profile.userDataDir) {
    throw new Error('local E2E userData directory changed after validation');
  }

  const desktopStorePath = path.join(profile.userDataDir, DESKTOP_STORE_FILE);
  assertNotSymlink(desktopStorePath, 'file');
  assertNotSymlink(profile.networkProfileDir, 'directory');

  fs.chmodSync(profile.userDataDir, 0o700);
  fs.mkdirSync(profile.networkProfileDir, { recursive: true, mode: 0o700 });
  assertNotSymlink(profile.networkProfileDir, 'directory');
  const realNetworkProfile = fs.realpathSync(profile.networkProfileDir);
  if (!strictChildOf(profile.userDataDir, realNetworkProfile)) {
    throw new Error('local E2E network profile escaped the isolated userData directory');
  }
  fs.chmodSync(realNetworkProfile, 0o700);

  setUserDataPath(profile.userDataDir);
  environment.OPENAGENT_USER_DIR = realNetworkProfile;
  environment.OPENAGENT_IROH_DISCOVERY = 'none';
}
