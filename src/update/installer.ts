import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppPaths } from '../shared/paths.js';
import type { Clock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import type { Repositories } from '../db/repositories.js';
import type { Config } from '../config/schema.js';
import { AppError, toAppError } from '../shared/errors.js';
import { compareVersions, isNewer } from '../shared/semver.js';
import { GitHubReleases, type ReleaseInfo } from './github.js';
import {
  CHECKSUM_ASSET,
  SIGNATURE_ASSET,
  downloadToFile,
  extractArchive,
  parseChecksums,
  validateExtractedTree,
  verifyChecksum,
  verifySignature,
  redactUrl,
} from './artifact.js';

const execFileAsync = promisify(execFile);

export interface ServiceControl {
  label: string;
  /** `hard` unloads and reloads the agent so the old process is really gone. */
  restart(opts?: { hard?: boolean }): Promise<{ ok: boolean; message: string }>;
  isLoaded(): Promise<boolean>;
  /** Rewrites the plist if its arguments are stale (e.g. pinned to an old version). */
  repairPlist?(): Promise<boolean>;
}

export interface UpdaterDeps {
  paths: AppPaths;
  clock: Clock;
  logger: Logger;
  repos: Repositories;
  getConfig: () => Config;
  service: ServiceControl;
  currentVersion: string;
  fetchImpl?: typeof fetch;
  /** How long a single health probe waits. */
  healthTimeoutMs?: number;
  /** Injectable for tests. */
  runNode?: (script: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;
  healthProbe?: (port: number, timeoutMs: number) => Promise<{ ok: boolean; version?: string; detail: string }>;
  /** Copies the live SQLite database to the given path (VACUUM INTO). */
  backupDb?: (destFile: string) => void;
  /** Override the GitHub API base (tests, GitHub Enterprise). */
  apiBase?: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  release: ReleaseInfo | null;
  channel: 'stable' | 'beta';
  checkedAt: string;
  detail: string;
}

export interface InstallResult {
  ok: boolean;
  fromVersion: string;
  toVersion: string;
  rolledBack: boolean;
  detail: string;
  migrationsApplied?: number[];
}

export interface UpdateState {
  lastCheckAt: string | null;
  lastAvailableVersion: string | null;
  lastInstallAt: string | null;
  installedVersion: string;
  previousVersion: string | null;
}

const STATE_FILE = 'update-state.json';

export class Updater {
  constructor(private readonly deps: UpdaterDeps) {}

  private statePath(): string {
    return path.join(this.deps.paths.dataDir, STATE_FILE);
  }

  readState(): UpdateState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath(), 'utf8')) as Partial<UpdateState>;
      return {
        lastCheckAt: raw.lastCheckAt ?? null,
        lastAvailableVersion: raw.lastAvailableVersion ?? null,
        lastInstallAt: raw.lastInstallAt ?? null,
        installedVersion: raw.installedVersion ?? this.deps.currentVersion,
        previousVersion: raw.previousVersion ?? null,
      };
    } catch {
      return { lastCheckAt: null, lastAvailableVersion: null, lastInstallAt: null, installedVersion: this.deps.currentVersion, previousVersion: null };
    }
  }

  private writeState(patch: Partial<UpdateState>): UpdateState {
    const next = { ...this.readState(), ...patch };
    try {
      fs.mkdirSync(this.deps.paths.dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.statePath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    } catch (e) {
      this.deps.logger.warn('could not persist update state', { error: (e as Error).message });
    }
    return next;
  }

  private releases(): GitHubReleases {
    const cfg = this.deps.getConfig();
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    return new GitHubReleases({
      repo: cfg.updates.repo,
      ...(token ? { token } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.apiBase ? { apiBase: this.deps.apiBase } : {}),
    });
  }

  async check(opts: { includePrerelease?: boolean } = {}): Promise<UpdateCheckResult> {
    const cfg = this.deps.getConfig();
    const includePrerelease = opts.includePrerelease ?? cfg.updates.channel === 'beta';
    const channel: 'stable' | 'beta' = includePrerelease ? 'beta' : 'stable';
    const current = this.deps.currentVersion;
    const checkedAt = this.deps.clock.now().toISOString();

    let releases: ReleaseInfo[];
    try {
      releases = await this.releases().list();
    } catch (e) {
      const err = toAppError(e);
      this.writeState({ lastCheckAt: checkedAt });
      throw err.code === 'HTTP_ERROR' && err.context.status === 404
        ? new AppError('UPDATE_UNAVAILABLE', `no GitHub releases found for ${cfg.updates.repo} yet`, { repo: cfg.updates.repo })
        : err;
    }

    const { selectRelease } = await import('./github.js');
    const release = selectRelease(releases, { includePrerelease, currentVersion: current });
    this.writeState({ lastCheckAt: checkedAt, lastAvailableVersion: release?.version ?? null });

    return {
      currentVersion: current,
      latestVersion: release?.version ?? null,
      updateAvailable: release !== null && release.version !== null && isNewer(release.version, current),
      release,
      channel,
      checkedAt,
      detail: release ? `latest ${channel} release is ${release.version ?? release.tagName}` : `no ${channel} release newer than ${current}`,
    };
  }

  /**
   * Installs a release next to the current one and flips a symlink.
   *
   * The data directory (config, SQLite database, Keychain items, templates) is
   * never modified by this routine apart from an additive database migration and
   * a pre-migration backup. Executables live under
   * <data>/install/versions/<version>, so an update six months after the last one
   * cannot endanger authentication, claim history or notification settings.
   */
  async install(release: ReleaseInfo, opts: { dryRun?: boolean } = {}): Promise<InstallResult> {
    const { paths, clock, logger, repos, getConfig } = this.deps;
    const cfg = getConfig();
    const from = this.deps.currentVersion;
    const to = release.version;
    const log = logger.child('update');
    if (!to) throw new AppError('UPDATE_VERIFICATION_FAILED', 'release has no valid semantic version');
    if (compareVersions(to, from) <= 0) {
      return { ok: true, fromVersion: from, toVersion: to, rolledBack: false, detail: `already on ${from} (release ${to})` };
    }
    if (compareVersions(to, from) > 0 && release.prerelease && cfg.updates.channel !== 'beta') {
      return {
        ok: false,
        fromVersion: from,
        toVersion: to,
        rolledBack: false,
        detail: `refusing to install prerelease ${to} on the stable channel (switch the channel to beta first)`,
      };
    }

    const historyId = repos.updates.start(from, to, clock.now().toISOString());
    let installed = false;
    let previousTarget: string | null = null;

    try {
      // 1. Drain: never replace executables mid-redemption.
      await this.drain(cfg.updates.drainTimeoutSeconds, log);

      // 2. Download + verify.
      const assetName = `epic-claims-${to}.tar.gz`;
      const asset = release.assets.find((a) => a.name === assetName) ?? release.assets.find((a) => a.name.endsWith('.tar.gz'));
      if (!asset) throw new AppError('UPDATE_UNAVAILABLE', `release ${to} has no tarball asset`, { assets: release.assets.map((a) => a.name) });
      const sumsAsset = release.assets.find((a) => a.name === CHECKSUM_ASSET);
      if (!sumsAsset) throw new AppError('UPDATE_VERIFICATION_FAILED', `release ${to} publishes no ${CHECKSUM_ASSET}; refusing to install an unverified artifact`);

      const workDir = path.join(paths.updatesDir, to);
      await fsp.rm(workDir, { recursive: true, force: true });
      await fsp.mkdir(workDir, { recursive: true, mode: 0o700 });

      log.info('downloading release artifact', { version: to, asset: asset.name, size: asset.size });
      const archive = await downloadToFile(asset.url, path.join(workDir, asset.name), {
        timeoutMs: 180_000,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      });

      const sumsFile = await downloadToFile(sumsAsset.url, path.join(workDir, CHECKSUM_ASSET), {
        timeoutMs: 30_000,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      });
      const sumsText = await fsp.readFile(sumsFile.file, 'utf8');
      verifyChecksum(asset.name, archive.sha256, parseChecksums(sumsText));

      // 3. Signature (optional but enforced when a key is configured).
      const sigAsset = release.assets.find((a) => a.name === SIGNATURE_ASSET);
      if (cfg.updates.publicKey) {
        if (!sigAsset) {
          if (cfg.updates.requireSignature) throw new AppError('UPDATE_VERIFICATION_FAILED', `${SIGNATURE_ASSET} is required but missing`);
          log.warn('release is unsigned and signature verification is not required');
        } else {
          const sig = await downloadToFile(sigAsset.url, path.join(workDir, SIGNATURE_ASSET), {
            timeoutMs: 30_000,
            ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
          });
          verifySignature(await fsp.readFile(sumsFile.file), await fsp.readFile(sig.file, 'utf8'), cfg.updates.publicKey);
          log.info('artifact signature verified');
        }
      } else {
        log.info('no update public key configured; relying on published SHA-256 checksums over HTTPS');
      }

      // 4. Extract + validate.
      const staging = path.join(paths.versionsDir, `.staging-${to}-${Date.now()}`);
      await extractArchive(archive.file, staging);
      const validation = await validateExtractedTree(staging, to);
      if (!validation.ok) {
        await fsp.rm(staging, { recursive: true, force: true });
        throw new AppError('UPDATE_VERIFICATION_FAILED', `artifact failed validation: ${validation.problems.join('; ')}`, { problems: validation.problems });
      }

      if (opts.dryRun) {
        await fsp.rm(staging, { recursive: true, force: true });
        repos.updates.finish(historyId, 'success', 'dry run: artifact downloaded and verified, nothing installed', false, clock.now().toISOString());
        return { ok: true, fromVersion: from, toVersion: to, rolledBack: false, detail: 'dry run: artifact verified, installation skipped' };
      }

      // 5. Database backup before any migration.
      const backup = path.join(paths.backupsDir, 'db', `${clock.now().toISOString().replace(/[:.]/g, '-')}-pre-${to}.db`);
      if (this.deps.backupDb) {
        try {
          this.deps.backupDb(backup);
          log.info('database backed up before migration', { backup });
        } catch (e) {
          // A failed backup must stop the update: migrations are irreversible.
          throw new AppError('UPDATE_INSTALL_FAILED', `pre-migration database backup failed: ${(e as Error).message}`);
        }
      } else {
        log.warn('no database handle available for a pre-migration backup');
      }

      // 6. Promote the new version directory.
      const target = path.join(paths.versionsDir, to);
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.rename(staging, target);

      previousTarget = readCurrentTarget(paths.currentLink);
      this.writeState({ previousVersion: previousTarget ? path.basename(previousTarget) : from });

      // 7. Migrations run under the *new* code, before the symlink flips.
      const migrations = await this.runMigrations(target, log);

      // 8. Flip the symlink atomically.
      flipSymlink(paths.currentLink, path.relative(paths.installRoot, target));
      installed = true;
      log.info('new version linked', { version: to, path: target });

      // 9. Restart + health check. Repair a plist that still points at a
      //    versioned path, then a hard restart so the process answering the
      //    probe is genuinely the new one.
      if (this.deps.service.repairPlist) {
        const repaired = await this.deps.service.repairPlist();
        if (repaired) log.info('service plist updated to launch through the current symlink');
      }
      const restart = await this.deps.service.restart({ hard: true });
      if (!restart.ok) throw new AppError('UPDATE_HEALTH_FAILED', `service restart failed: ${restart.message}`);
      const health = await this.waitForHealth(cfg.api.port, to);
      if (!health.ok) throw new AppError('UPDATE_HEALTH_FAILED', `updated service did not become healthy: ${health.detail}`);

      this.writeState({ lastInstallAt: clock.now().toISOString(), installedVersion: to, lastAvailableVersion: null });
      repos.updates.finish(historyId, 'success', `installed ${to}; migrations: ${migrations.join(',') || 'none'}`, false, clock.now().toISOString());
      await this.pruneVersions(to, log);
      return {
        ok: true,
        fromVersion: from,
        toVersion: to,
        rolledBack: false,
        detail: `updated ${from} -> ${to}`,
        migrationsApplied: migrations,
      };
    } catch (e) {
      const err = toAppError(e);
      log.exception('update failed', err, { from, to, installed });
      let rolledBack = false;
      if (installed && previousTarget) {
        try {
          flipSymlink(paths.currentLink, previousTarget);
          const restart = await this.deps.service.restart({ hard: true });
          const health = await this.waitForHealth(getConfig().api.port, path.basename(previousTarget));
          rolledBack = restart.ok && health.ok;
          log.warn('rolled back to the previous version', { previous: previousTarget, healthy: rolledBack });
        } catch (rollbackError) {
          log.exception('rollback failed', rollbackError, { previous: previousTarget });
        }
      }
      repos.updates.finish(historyId, rolledBack ? 'rolled_back' : 'failed', `${err.code}: ${err.message}`, rolledBack, clock.now().toISOString());
      return {
        ok: false,
        fromVersion: from,
        toVersion: to,
        rolledBack,
        detail: `${err.code}: ${err.message}${rolledBack ? ' (rolled back to ' + from + ')' : ''}`,
      };
    }
  }

  /** Refuses to replace binaries while a redemption is in flight. */
  async drain(timeoutSeconds: number, log: Logger): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      const inflight = this.deps.repos.claims.countInflight();
      if (inflight === 0) return;
      if (Date.now() >= deadline) {
        throw new AppError('UPDATE_BUSY', `a claim is still in progress after waiting ${timeoutSeconds}s; try again shortly`, { inflight });
      }
      log.info('waiting for in-flight claims before updating', { inflight });
      await this.deps.clock.sleep(1000);
    }
  }

  private async runMigrations(target: string, log: Logger): Promise<number[]> {
    const cli = path.join(target, 'dist', 'cli', 'index.js');
    const env = {
      ...process.env,
      EPIC_CLAIMS_HOME: this.deps.paths.dataDir,
      EPIC_CLAIMS_LOGS: this.deps.paths.logsDir,
      EPIC_CLAIMS_INSTALL_ROOT: this.deps.paths.installRoot,
    } as Record<string, string>;
    const runner =
      this.deps.runNode ??
      (async (script: string, args: string[], envVars: Record<string, string>) => {
        try {
          const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], { env: envVars, timeout: 180_000 });
          return { code: 0, stdout, stderr };
        } catch (e) {
          const err = e as { code?: number; stdout?: string; stderr?: string };
          return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
        }
      });
    const res = await runner(cli, ['db', 'migrate', '--json'], env);
    if (res.code !== 0) {
      throw new AppError('UPDATE_INSTALL_FAILED', `database migration failed: ${res.stderr.trim() || `exit ${res.code}`}`, { exitCode: res.code });
    }
    try {
      const parsed = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { applied?: number[] };
      log.info('migrations applied', { applied: parsed.applied ?? [] });
      return parsed.applied ?? [];
    } catch {
      return [];
    }
  }

  private async waitForHealth(port: number, expectedVersion: string, attempts = 45): Promise<{ ok: boolean; detail: string }> {
    const probe =
      this.deps.healthProbe ??
      (async (p: number, timeoutMs: number) => {
        try {
          const res = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
          if (!res.ok) return { ok: false, detail: `health endpoint returned HTTP ${res.status}` };
          const body = (await res.json()) as { ok?: boolean; version?: string };
          return { ok: body.ok === true, version: body.version, detail: `HTTP ${res.status}` };
        } catch (e) {
          return { ok: false, detail: (e as Error).message };
        }
      });
    let last: { ok: boolean; detail: string; version?: string } = { ok: false, detail: 'not probed' };
    for (let i = 0; i < attempts; i++) {
      await this.deps.clock.sleep(i === 0 ? 1000 : 2000);
      last = await probe(port, this.deps.healthTimeoutMs ?? 3000);
      if (last.ok) {
        if (last.version && compareVersions(last.version, expectedVersion) < 0) {
          last = { ok: false, detail: `service reports ${last.version}, expected ${expectedVersion}` };
          continue;
        }
        return last;
      }
    }
    return last;
  }

  /** Keeps the previous two versions on disk for manual rollback. */
  private async pruneVersions(keep: string, log: Logger): Promise<void> {
    try {
      const dirs = (await fsp.readdir(this.deps.paths.versionsDir, { withFileTypes: true })).filter((d) => d.isDirectory());
      const withTimes = await Promise.all(
        dirs.map(async (d) => ({ name: d.name, mtime: (await fsp.stat(path.join(this.deps.paths.versionsDir, d.name))).mtimeMs })),
      );
      withTimes.sort((a, b) => b.mtime - a.mtime);
      const keepNames = new Set([keep, ...withTimes.slice(0, 3).map((d) => d.name)]);
      for (const v of withTimes) {
        if (keepNames.has(v.name)) continue;
        if (v.name.startsWith('.staging-')) {
          await fsp.rm(path.join(this.deps.paths.versionsDir, v.name), { recursive: true, force: true });
        }
      }
    } catch (e) {
      log.warn('could not prune old versions', { error: (e as Error).message });
    }
  }
}

export function readCurrentTarget(linkPath: string): string | null {
  try {
    const target = fs.readlinkSync(linkPath);
    return path.isAbsolute(target) ? target : path.resolve(path.dirname(linkPath), target);
  } catch {
    return null;
  }
}

/** Creates the link under a temporary name and renames it over the old one. */
export function flipSymlink(linkPath: string, relativeTarget: string): void {
  const tmp = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(relativeTarget, tmp, 'dir');
    fs.renameSync(tmp, linkPath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw new AppError('UPDATE_INSTALL_FAILED', `cannot switch the version symlink: ${(e as Error).message}`);
  }
}

export function describeCheck(result: UpdateCheckResult): string {
  if (result.updateAvailable && result.latestVersion) {
    return `update available: ${result.currentVersion} -> ${result.latestVersion} (${redactUrl(result.release?.htmlUrl ?? '') || result.channel})`;
  }
  return `up to date (${result.currentVersion}); ${result.detail}`;
}
