import os from 'node:os';
import path from 'node:path';

/**
 * Filesystem layout — the separation between installable binaries and user data
 * is a hard architectural invariant:
 *
 *   install root (replaced by updates)  ~/Library/Application Support/Epic Claims/install/versions/<v>
 *                                                 current -> versions/<v>   (symlink, flipped atomically)
 *   data dir     (never touched)        ~/Library/Application Support/Epic Claims/
 *   logs         (append-only)          ~/Library/Logs/Epic Claims/
 *   keychain     (never touched)        login keychain, service "Epic Claims"
 *
 * The updater may only write inside `installRoot()`. Everything else is off limits.
 * Overrides exist so tests (and developers) can run entirely inside a temp sandbox.
 */

export interface AppPaths {
  readonly dataDir: string;
  readonly installRoot: string;
  readonly versionsDir: string;
  readonly currentLink: string;
  readonly logsDir: string;
  readonly backupsDir: string;
  readonly updatesDir: string;
  readonly dbFile: string;
  readonly configFile: string;
  readonly pidFile: string;
  readonly apiTokenFile: string;
  readonly servicePlist: string;
}

function envOverride(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? path.resolve(v) : undefined;
}

const DATA_DIR_NAME = 'Epic Claims';
const LOG_DIR_NAME = 'Epic Claims';

export function resolvePaths(overrides: { home?: string; logs?: string; install?: string } = {}): AppPaths {
  const home = overrides.home ?? envOverride('EPIC_CLAIMS_HOME') ?? path.join(os.homedir(), 'Library', 'Application Support', DATA_DIR_NAME);
  const logsBase = overrides.logs ?? envOverride('EPIC_CLAIMS_LOGS');
  const logsDir = logsBase ?? path.join(os.homedir(), 'Library', 'Logs', LOG_DIR_NAME);
  const installRoot = overrides.install ?? envOverride('EPIC_CLAIMS_INSTALL_ROOT') ?? path.join(home, 'install');

  const versionsDir = path.join(installRoot, 'versions');
  return {
    dataDir: home,
    installRoot,
    versionsDir,
    currentLink: path.join(installRoot, 'current'),
    logsDir,
    backupsDir: path.join(home, 'backups'),
    updatesDir: path.join(home, 'updates'),
    dbFile: path.join(home, 'epic-claims.db'),
    configFile: path.join(home, 'config.json'),
    pidFile: path.join(home, 'epic-claims.pid'),
    apiTokenFile: path.join(home, 'api-token'),
    servicePlist: path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.diy23.epic-claims.plist'),
  };
}

/**
 * The running program's directory, resolved through the `current` symlink when
 * the app was started from an installed version.
 */
export function resolveRuntimeDir(paths: AppPaths): string | null {
  // import.meta.url of the caller is not available here; the CLI passes it in.
  return paths.currentLink;
}
