import { describe, expect, it } from 'vitest';
import { compareVersions, isNewer, isPrerelease, maxVersion, parseSemver, bump } from '../src/shared/semver.js';
import { backoffDelay, retry } from '../src/shared/http.js';
import { httpJson } from '../src/shared/http.js';
import { Logger, redact, sha256, randomToken, safeEqual, memorySink } from '../src/shared/logger.js';
import { FakeClock } from '../src/shared/clock.js';
import { appleDateToIso } from '../src/notify/imessage/reader.js';
import { resolvePaths } from '../src/shared/paths.js';
import { configSchema, describeIssues } from '../src/config/schema.js';
import { defaultConfig } from '../src/config/defaults.js';
import { ConfigStore } from '../src/config/store.js';
import { AppError } from '../src/shared/errors.js';
import { makeTempDir } from './helpers.js';
import path from 'node:path';
import fs from 'node:fs';

describe('semver', () => {
  it('parses and compares versions', () => {
    expect(parseSemver('v1.2.3')?.patch).toBe(3);
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(isNewer('1.1.0', '1.0.0')).toBe(true);
    expect(isNewer('1.0.0', '1.1.0')).toBe(false);
  });

  it('orders prereleases below their release', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBe(1);
    expect(isPrerelease('1.0.0-rc.1')).toBe(true);
    expect(isPrerelease('1.0.0')).toBe(false);
  });

  it('picks the highest version, honouring the channel', () => {
    expect(maxVersion(['1.0.0', '1.2.0', '1.1.5'])).toBe('1.2.0');
    expect(maxVersion(['1.0.0', '1.2.0-beta.1'])).toBe('1.0.0');
    expect(maxVersion(['1.0.0', '1.2.0-beta.1'], true)).toBe('1.2.0-beta.1');
  });

  it('bumps versions', () => {
    expect(bump('1.2.3', 'patch')).toBe('1.2.4');
    expect(bump('1.2.3', 'minor')).toBe('1.3.0');
    expect(bump('1.2.3', 'major')).toBe('2.0.0');
  });
});

describe('retry and backoff', () => {
  it('retries and eventually succeeds', async () => {
    let attempts = 0;
    const value = await retry(async () => {
      attempts++;
      if (attempts < 3) throw new AppError('NETWORK', 'flaky', {}, true);
      return 'ok';
    }, { attempts: 5, sleep: async () => undefined });
    expect(value).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry a permanent failure', async () => {
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts++;
        throw new AppError('AUTH_EXPIRED', 'nope');
      }, { attempts: 5, sleep: async () => undefined }),
    ).rejects.toThrow(/nope/);
    expect(attempts).toBe(1);
  });

  it('grows the delay exponentially', () => {
    expect(backoffDelay(1, 100, 10_000, false)).toBe(100);
    expect(backoffDelay(2, 100, 10_000, false)).toBe(200);
    expect(backoffDelay(3, 100, 10_000, false)).toBe(400);
    expect(backoffDelay(10, 100, 1_000, false)).toBe(1_000);
  });
});

describe('http client', () => {
  it('maps a timeout to a TIMEOUT AppError', async () => {
    const slowFetch = (async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as typeof fetch;
    await expect(httpJson('https://example.invalid/x', { fetchImpl: slowFetch, timeoutMs: 20, retries: 0 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('maps 429 to RATE_LIMITED', async () => {
    const fetchImpl = (async () => new Response('slow down', { status: 429, headers: { 'retry-after': '1' } })) as typeof fetch;
    await expect(httpJson('https://example.invalid/x', { fetchImpl, retries: 0 })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('returns parsed JSON on success', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ a: 1 }), { status: 200 })) as typeof fetch;
    const res = await httpJson<{ a: number }>('https://example.invalid/x', { fetchImpl });
    expect(res.data.a).toBe(1);
  });
});

describe('logger', () => {
  it('redacts secrets recursively', () => {
    const out = redact({ access_token: 'abc', nested: { refreshToken: 'x', password: 'y' }, keep: 'visible' }) as Record<string, unknown>;
    expect(out.access_token).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).refreshToken).toBe('[redacted]');
    expect(out.keep).toBe('visible');
  });

  it('filters by level', () => {
    const sink = memorySink();
    const logger = new Logger('test', 'warn');
    logger.addSink(sink);
    logger.debug('nope');
    logger.info('nope');
    logger.warn('yes');
    expect(sink.records).toHaveLength(1);
  });
});

describe('crypto helpers', () => {
  it('produces stable hashes and constant-time comparisons', () => {
    expect(sha256('a')).toBe(sha256('a'));
    expect(sha256('a')).not.toBe(sha256('b'));
    expect(safeEqual('token', 'token')).toBe(true);
    expect(safeEqual('token', 'other')).toBe(false);
    expect(randomToken(16).length).toBeGreaterThan(10);
  });
});

describe('paths', () => {
  it('keeps binaries and data in separate trees', () => {
    const paths = resolvePaths({ home: '/tmp/home', logs: '/tmp/logs' });
    expect(paths.dataDir).toBe('/tmp/home');
    expect(paths.installRoot.startsWith('/tmp/home/')).toBe(true);
    expect(paths.dbFile.startsWith('/tmp/home')).toBe(true);
    expect(paths.logsDir).toBe('/tmp/logs');
    expect(paths.currentLink.startsWith(paths.installRoot)).toBe(true);
  });
});

describe('config', () => {
  it('ships a valid default configuration', () => {
    const parsed = configSchema.safeParse(defaultConfig());
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown mode with a readable message', () => {
    const bad = structuredClone(defaultConfig()) as unknown as Record<string, unknown>;
    (bad.claiming as Record<string, unknown>).mode = 'sometimes';
    const parsed = configSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issues = describeIssues(parsed.error);
      expect(issues.some((i) => i.path.includes('claiming.mode'))).toBe(true);
    }
  });

  it('round-trips through the store and refuses invalid writes', () => {
    const dir = makeTempDir();
    const store = new ConfigStore({ filePath: path.join(dir, 'config.json') });
    const initial = store.load();
    expect(initial.claiming.mode).toBe('approval');
    store.update({ claiming: { mode: 'auto' } });
    expect(store.load().claiming.mode).toBe('auto');
    expect(() => store.save({ claiming: { mode: 'bogus' } })).toThrow();
    expect(store.load().claiming.mode).toBe('auto');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies transient overrides without writing them to disk', async () => {
    const dir = makeTempDir();
    const store = new ConfigStore({ filePath: path.join(dir, 'config.json') });
    store.load();
    await store.withTransient({ claiming: { dryRun: true } }, async () => {
      expect(store.load().claiming.dryRun).toBe(true);
    });
    expect(store.load().claiming.dryRun).toBe(false);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as { claiming: { dryRun: boolean } };
    expect(onDisk.claiming.dryRun).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('clock helpers', () => {
  it('advances deterministically', async () => {
    const clock = new FakeClock('2026-01-01T00:00:00.000Z');
    const before = clock.nowMs();
    await clock.sleep(1000);
    expect(clock.nowMs()).toBe(before + 1000);
  });

  it('converts Apple timestamps', () => {
    expect(appleDateToIso(814848602116619008)).toBe('2026-10-28T02:50:02.116Z');
  });
});
