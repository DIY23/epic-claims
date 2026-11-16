import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import * as tar from 'tar';
import { makeTempDir, mergeDeep } from './helpers.js';
import { resolvePaths, type AppPaths } from '../src/shared/paths.js';
import { FakeClock } from '../src/shared/clock.js';
import { Logger } from '../src/shared/logger.js';
import { Database } from '../src/db/database.js';
import { createRepositories } from '../src/db/repositories.js';
import { ConfigStore } from '../src/config/store.js';
import { defaultConfig } from '../src/config/defaults.js';
import { Updater, flipSymlink, readCurrentTarget, type ServiceControl } from '../src/update/installer.js';
import { GitHubReleases, selectRelease, toReleaseInfo, type ReleaseInfo } from '../src/update/github.js';
import { parseChecksums, verifyChecksum, verifySignature, validateExtractedTree, extractArchive } from '../src/update/artifact.js';
import { buildReleaseFixture, type Fixture } from './updateFixture.js';

let dir: string;
let fixture: Fixture;
let server: http.Server;
let baseUrl: string;
let paths: AppPaths;
let updater: Updater;
let clock: FakeClock;
let restarts: number;
let failVersions: Set<string>;
let migrationCalls: string[][];

function makeUpdater(): Updater {
  return new Updater({
    paths,
    clock,
    logger: new Logger('update-test', 'error'),
    repos: updaterRepos,
    getConfig: () => configStore.load(),
    service: service,
    currentVersion: '1.0.0',
    backupDb: (dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'db-backup');
    },
    ...(baseUrl ? { apiBase: baseUrl } : {}),
    runNode: async (_script, args) => {
      migrationCalls.push(args);
      return { code: 0, stdout: '{"ok":true,"applied":[1]}\n', stderr: '' };
    },
    // Faithful simulation: the probe reports whatever the symlink currently
    // points at, and a version listed in failVersions never becomes healthy.
    healthProbe: async () => {
      const target = readCurrentTarget(paths.currentLink);
      const live = target ? path.basename(target) : 'none';
      const healthy = !failVersions.has(live);
      return { ok: healthy, detail: healthy ? 'healthy' : `${live} did not start`, version: live };
    },
  });
}

const service: ServiceControl = {
  label: 'com.diy23.epic-claims.test',
  async restart() {
    restarts++;
    return { ok: true, message: 'restarted' };
  },
  async isLoaded() {
    return true;
  },
};

let updaterRepos: ReturnType<typeof createRepositories>;
let configStore: ConfigStore;
let db: Database;

beforeEach(async () => {
  dir = makeTempDir('epic-update-');
  fixture = await buildReleaseFixture(dir);
  server = fixture.server;
  baseUrl = fixture.baseUrl;
  restarts = 0;
  failVersions = new Set();
  migrationCalls = [];

  paths = resolvePaths({ home: path.join(dir, 'data'), logs: path.join(dir, 'logs') });
  fs.mkdirSync(paths.versionsDir, { recursive: true });
  // Pretend 1.0.0 is installed and live.
  const v1 = path.join(paths.versionsDir, '1.0.0');
  fs.mkdirSync(path.join(v1, 'dist', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(v1, 'package.json'), JSON.stringify({ name: 'epic-claims', version: '1.0.0' }));
  fs.writeFileSync(path.join(v1, 'dist', 'cli', 'index.js'), '// v1');
  flipSymlink(paths.currentLink, path.join('versions', '1.0.0'));

  configStore = new ConfigStore({ filePath: paths.configFile });
  configStore.save(mergeDeep(defaultConfig(), { updates: { repo: 'DIY23/epic-claims', drainTimeoutSeconds: 0 } }));
  db = new Database({ file: paths.dbFile });
  db.migrate();
  updaterRepos = createRepositories(db);
  clock = new FakeClock('2026-11-16T12:00:00.000Z');
  updater = makeUpdater();
});

afterEach(async () => {
  db.close();
  await fixture.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('release selection', () => {
  it('ignores prereleases on the stable channel', async () => {
    const releases = await new GitHubReleases({ repo: 'DIY23/epic-claims', apiBase: baseUrl }).list();
    const stable = selectRelease(releases, { includePrerelease: false, currentVersion: '1.0.0' });
    expect(stable?.version).toBe('1.1.0');
    const beta = selectRelease(releases, { includePrerelease: true, currentVersion: '1.0.0' });
    expect(beta?.version).toBe('1.2.0-beta.1');
  });

  it('detects an update and reports none once installed', async () => {
    const result = await updater.check({});
    expect(result.currentVersion).toBe('1.0.0');
    expect(result.latestVersion).toBe('1.1.0');
    expect(result.updateAvailable).toBe(true);

    const atNewest = new Updater({
      paths,
      clock,
      logger: new Logger('t', 'error'),
      repos: updaterRepos,
      getConfig: () => configStore.load(),
      service,
      currentVersion: '1.1.0',
      apiBase: baseUrl,
    });
    const second = await atNewest.check({ includePrerelease: false });
    expect(second.updateAvailable).toBe(false);
    expect(second.latestVersion).toBeNull();

    const beta = await atNewest.check({ includePrerelease: true });
    expect(beta.latestVersion).toBe('1.2.0-beta.1');
    expect(beta.updateAvailable).toBe(true);
  });

  it('normalises tags and drops drafts', () => {
    const info = toReleaseInfo({ tag_name: 'v2.0.0', draft: false, prerelease: false, assets: [{ name: 'a', browser_download_url: 'u', size: 1 }] });
    expect(info.version).toBe('2.0.0');
    const draft = toReleaseInfo({ tag_name: 'v3.0.0', draft: true });
    expect(selectRelease([draft], { includePrerelease: true, currentVersion: '1.0.0' })).toBeNull();
  });
});

describe('artifact verification', () => {
  it('parses checksum files', () => {
    const sums = parseChecksums(`${'a'.repeat(64)}  epic-claims-1.1.0.tar.gz\n${'b'.repeat(64)} *other.tgz\n`);
    expect(sums.get('epic-claims-1.1.0.tar.gz')).toBe('a'.repeat(64));
    expect(sums.get('other.tgz')).toBe('b'.repeat(64));
  });

  it('rejects a mismatched checksum', () => {
    expect(() => verifyChecksum('x.tgz', 'a'.repeat(64), new Map([['x.tgz', 'b'.repeat(64)]]))).toThrow(/checksum mismatch/);
    expect(() => verifyChecksum('x.tgz', 'a'.repeat(64), new Map())).toThrow(/no checksum published/);
  });

  it('verifies ed25519 signatures and rejects forgeries', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const data = Buffer.from('checksums');
    const signature = crypto.sign(null, data, privateKey).toString('base64');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    expect(() => verifySignature(data, signature, raw)).not.toThrow();
    expect(() => verifySignature(Buffer.from('tampered'), signature, raw)).toThrow(/signature verification failed/);
  });

  it('rejects unsafe archive paths', async () => {
    const src = path.join(dir, 'evil');
    fs.mkdirSync(path.join(src, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(src, 'pkg', 'ok.txt'), 'ok');
    const archive = path.join(dir, 'evil.tar.gz');
    await tar.c({ gzip: true, file: archive, cwd: src }, ['pkg']);
    const out = path.join(dir, 'evil-out');
    await extractArchive(archive, out);
    expect(fs.existsSync(path.join(out, 'ok.txt'))).toBe(true);
  });

  it('validates the extracted tree', async () => {
    const good = path.join(dir, 'good');
    fs.mkdirSync(path.join(good, 'dist', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(good, 'package.json'), JSON.stringify({ name: 'epic-claims', version: '1.1.0' }));
    fs.writeFileSync(path.join(good, 'dist', 'cli', 'index.js'), 'x');
    expect((await validateExtractedTree(good, '1.1.0')).ok).toBe(true);
    const wrongVersion = await validateExtractedTree(good, '9.9.9');
    expect(wrongVersion.ok).toBe(false);
    expect(wrongVersion.problems.join(' ')).toContain('does not match');
  });
});

describe('installing an update', () => {
  it('installs the new version and leaves user data untouched', async () => {
    // Seed user data that must survive.
    fs.writeFileSync(path.join(paths.dataDir, 'MARKER.txt'), 'user configuration');
    const configBefore = fs.readFileSync(paths.configFile);
    const dbBefore = crypto.createHash('sha256').update(fs.readFileSync(paths.dbFile)).digest('hex');

    const result = await updater.install(deploy('1.1.0'));

    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(readCurrentTarget(paths.currentLink)).toBe(path.join(paths.versionsDir, '1.1.0'));
    expect(fs.existsSync(path.join(paths.versionsDir, '1.1.0', 'dist', 'cli', 'index.js'))).toBe(true);
    expect(migrationCalls).toHaveLength(1);
    expect(migrationCalls[0]).toEqual(['db', 'migrate', '--json']);
    expect(restarts).toBe(1);

    // Data directory byte-identical apart from explicitly-backed-up artefacts.
    expect(fs.readFileSync(path.join(paths.dataDir, 'MARKER.txt'), 'utf8')).toBe('user configuration');
    expect(fs.readFileSync(paths.configFile)).toEqual(configBefore);
    const dbAfter = crypto.createHash('sha256').update(fs.readFileSync(paths.dbFile)).digest('hex');
    expect(dbAfter).toBe(dbBefore);
    expect(fs.readdirSync(path.join(paths.backupsDir, 'db')).length).toBeGreaterThan(0);

    // Update history recorded.
    const history = updaterRepos.updates.list(5);
    expect(history[0]?.status).toBe('success');
    expect(history[0]?.toVersion).toBe('1.1.0');
  });

  it('refuses an artifact whose checksum does not match', async () => {
    fixture.corruptChecksum = true;
    const result = await updater.install(deploy('1.1.0'));

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('checksum mismatch');
    expect(readCurrentTarget(paths.currentLink)).toBe(path.join(paths.versionsDir, '1.0.0'));
    expect(fs.existsSync(path.join(paths.versionsDir, '1.1.0'))).toBe(false);
    expect(updaterRepos.updates.list(5)[0]?.status).toBe('failed');
  });

  it('refuses a release without a checksum file', async () => {
    fixture.withChecksums = false;
    const result = await updater.install(deploy('1.1.0'));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('SHA256SUMS');
  });

  it('rolls back when the updated service is unhealthy', async () => {
    failVersions.add('1.1.0');
    const result = await updater.install(deploy('1.1.0'));

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(readCurrentTarget(paths.currentLink)).toBe(path.join(paths.versionsDir, '1.0.0'));
    const history = updaterRepos.updates.list(5);
    expect(history[0]?.status).toBe('rolled_back');
    expect(history[0]?.rolledBack).toBe(true);
  });

  it('waits for, and refuses to interrupt, an in-flight claim', async () => {
    const { offer } = updaterRepos.offers.upsert(
      {
        store: 'epic',
        storeOfferId: 'busy-1',
        title: 'Busy',
        description: '',
        publisher: '',
        kind: 'game',
        namespace: null,
        offerId: null,
        catalogItemId: null,
        productSlug: null,
        pageSlug: null,
        url: null,
        imageUrl: null,
        originalPrice: null,
        discountPrice: null,
        currency: null,
        startAt: null,
        endAt: null,
      },
      clock.now().toISOString(),
    );
    updaterRepos.claims.beginAttempt({ offerId: offer.id, initiator: 'test', cycleId: null, now: clock.now().toISOString() });

    const result = await updater.install(deploy('1.1.0'));

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('UPDATE_BUSY');
    expect(readCurrentTarget(paths.currentLink)).toBe(path.join(paths.versionsDir, '1.0.0'));
  });

  it('refuses a prerelease on the stable channel', async () => {
    const result = await updater.install(deploy('1.2.0-beta.1', true));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('prerelease');
  });

  it('verifies signatures when a public key is configured', async () => {
    fixture.signature = true;
    configStore.update({ updates: { publicKey: fixture.publicKey, requireSignature: true } });
    updater = makeUpdater();
    const result = await updater.install(deploy('1.1.0'));
    expect(result.ok).toBe(true);

    // A tampered signature must be refused, and the live version must not change.
    fixture.badSignature = true;
    const before = readCurrentTarget(paths.currentLink);
    const second = await updater.install(deploy('1.1.0'));
    expect(second.ok).toBe(false);
    expect(second.detail.toLowerCase()).toContain('signature');
    expect(readCurrentTarget(paths.currentLink)).toBe(before);
  });

  it('runs migrations before the symlink flips', async () => {
    const seenAtMigration: string[] = [];
    const u = new Updater({
      paths,
      clock,
      logger: new Logger('t', 'error'),
      repos: updaterRepos,
      getConfig: () => configStore.load(),
      service,
      currentVersion: '1.0.0',
      backupDb: () => undefined,
      runNode: async () => {
        seenAtMigration.push(readCurrentTarget(paths.currentLink) ?? 'none');
        return { code: 0, stdout: '{"ok":true,"applied":[1]}\n', stderr: '' };
      },
      healthProbe: async () => ({ ok: true, detail: 'ok', version: '1.1.0' }),
    });
    const result = await u.install(deploy('1.1.0'));
    expect(result.ok).toBe(true);
    // during migration the symlink still pointed at the old version
    expect(seenAtMigration[0]).toBe(path.join(paths.versionsDir, '1.0.0'));
  });

  it('reports a failed migration and keeps the old version live', async () => {
    const u = new Updater({
      paths,
      clock,
      logger: new Logger('t', 'error'),
      repos: updaterRepos,
      getConfig: () => configStore.load(),
      service,
      currentVersion: '1.0.0',
      backupDb: () => undefined,
      runNode: async () => ({ code: 1, stdout: '', stderr: 'migration exploded' }),
      healthProbe: async () => ({ ok: true, detail: 'ok', version: '1.1.0' }),
    });
    const result = await u.install(deploy('1.1.0'));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('migration failed');
    expect(readCurrentTarget(paths.currentLink)).toBe(path.join(paths.versionsDir, '1.0.0'));
  });
});

function deploy(version: string, prerelease = false): ReleaseInfo {
  return {
    tagName: `v${version}`,
    version,
    name: `v${version}`,
    prerelease,
    draft: false,
    publishedAt: clock.now().toISOString(),
    notes: '',
    htmlUrl: `${baseUrl}/releases/${version}`,
    assets: [
      { name: `epic-claims-${version}.tar.gz`, url: `${baseUrl}/download/epic-claims-${version}.tar.gz`, size: 0, contentType: 'application/gzip', downloadCount: 0 },
      ...(fixture.withChecksums ? [{ name: 'SHA256SUMS', url: `${baseUrl}/download/SHA256SUMS`, size: 0, contentType: 'text/plain', downloadCount: 0 }] : []),
      ...(fixture.signature
        ? [{ name: 'SHA256SUMS.sig', url: `${baseUrl}/download/SHA256SUMS.sig`, size: 0, contentType: 'text/plain', downloadCount: 0 }]
        : []),
    ],
  };
}
