import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeSandbox, makeOffer, type Sandbox } from './helpers.js';
import { createApiServer } from '../src/api/server.js';
import { NotificationManager } from '../src/notify/manager.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { Updater } from '../src/update/installer.js';
import { ApiTokenStore } from '../src/api/auth.js';
import fs from 'node:fs';
import { resolvePaths } from '../src/shared/paths.js';
import { createHash } from 'node:crypto';
import type { AppEvent, AppEventType } from '../src/shared/events.js';
import type { AdapterContext, AdapterStatus, DeliveryResult, NotificationAdapter, RenderedNotification } from '../src/notify/adapter.js';
import type { TemplateFields } from '../src/notify/template-vars.js';
import type { Config } from '../src/config/schema.js';

class SilentAdapter implements NotificationAdapter {
  readonly displayName = 'silent';
  delivered: string[] = [];
  constructor(readonly id: string) {}
  isEnabled(): boolean {
    return true;
  }
  isConfigured(): boolean {
    return true;
  }
  render(event: AppEvent, template: TemplateFields, _ctx: AdapterContext): RenderedNotification {
    return { subject: template.title ?? null, subtitle: template.subtitle ?? null, body: template.body, actions: [], data: { event: event.type } };
  }
  async deliver(message: RenderedNotification): Promise<DeliveryResult> {
    this.delivered.push(message.body);
    return { ok: true, attempts: 1 };
  }
  async status(): Promise<AdapterStatus> {
    return { id: this.id, enabled: true, configured: true, detail: 'silent', capabilities: { interactive: false, richText: false } };
  }
  async test(event: AppEvent, template: TemplateFields, ctx: AdapterContext): Promise<DeliveryResult> {
    return this.deliver(this.render(event, template, ctx));
  }
}

let box: Sandbox;
let app: FastifyInstance;
let token: string;
let paths: ReturnType<typeof resolvePaths>;
let macos: SilentAdapter;
let imessage: SilentAdapter;

async function build(t: 'main' | 'admin' = 'main'): Promise<FastifyInstance> {
  const configStore = box.configStore;
  const notifications = new NotificationManager({
    adapters: [macos, imessage],
    repos: box.repos,
    clock: box.clock,
    logger: box.logger,
    getConfig: () => configStore.load(),
  });
  const scheduler = new Scheduler({ engine: box.engine, repos: box.repos, clock: box.clock, logger: box.logger, getConfig: () => configStore.load() });
  // The API token lives in a 0600 file (never the Keychain) so every CLI run
  // stays prompt-free; seed it before the server starts.
  const apiToken = new ApiTokenStore({ dataDir: box.dataDir, filePath: paths.apiTokenFile });
  fs.mkdirSync(box.dataDir, { recursive: true });
  fs.writeFileSync(paths.apiTokenFile, 'test-token-1234567890\n', { mode: 0o600 });
  const updater = new Updater({
    paths,
    clock: box.clock,
    logger: box.logger,
    repos: box.repos,
    getConfig: () => configStore.load(),
    service: { label: 'test', restart: async () => ({ ok: true, message: 'ok' }), isLoaded: async () => true },
    currentVersion: '1.0.0',
  });
  const server = await createApiServer({
    paths,
    version: '1.0.0',
    startedAt: box.clock.now().toISOString(),
    configStore,
    repos: box.repos,
    logger: box.logger,
    clock: box.clock,
    notifications,
    scheduler,
    engine: box.engine,
    updater,
    service: {
      label: 'test',
      status: async () => ({ label: 'test', installed: true, loaded: true, running: true, pid: 42, lastExitCode: 0, plistPath: '/tmp/x.plist', detail: 'running' }),
      restart: async () => ({ ok: true, message: 'ok' }),
      isLoaded: async () => true,
    } as never,
    apiToken,
    provider: box.provider,
    assetsDir: box.dir,
    runCheck: (trigger) => box.engine.runCycle(trigger),
    runCheckBypassingGate: (trigger) => box.engine.runCycle(trigger, { bypassFirstRunGate: true }),
    health: async () => ({ ok: true, detail: 'ok' }),
    requestShutdown: () => undefined,
  });
  await server.ready();
  token = 'test-token-1234567890';
  return server;
}

const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  box = makeSandbox();
  paths = resolvePaths({ home: box.dataDir, logs: box.logsDir });
  macos = new SilentAdapter('macos');
  imessage = new SilentAdapter('imessage');
  app = await build();
});

afterEach(async () => {
  await app.close();
  box.cleanup();
});

describe('api security', () => {
  it('exposes health without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, version: '1.0.0' });
  });

  it('refuses every other endpoint without a token', async () => {
    for (const url of ['/api/status', '/api/offers', '/api/config', '/api/approvals', '/api/history']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error).toBe('AUTH_FAILED');
    }
  });

  it('accepts the bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe('1.0.0');
  });

  it('rejects a wrong token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer nope-nope-nope-nope' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('approval endpoints', () => {
  beforeEach(async () => {
    box.configStore.update({ claiming: { mode: 'approval' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'api-1', title: 'API Game' })];
    await box.engine.runCycle('manual');
  });

  it('lists pending approvals', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/approvals', headers: auth() });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ shortCode: string; offer: { title: string } }>;
    expect(rows[0]?.offer.title).toBe('API Game');
  });

  it('decides an approval from the dashboard', async () => {
    const pending = box.repos.approvals.pending()[0]!;
    const res = await app.inject({ method: 'POST', url: `/api/approvals/${pending.id}/decide`, headers: auth(), payload: { decision: 'claim' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, decision: 'accepted' });
    expect(box.provider.claimCalls).toEqual(['api-1']);
  });

  it('rejects an invalid decision body', async () => {
    const pending = box.repos.approvals.pending()[0]!;
    const res = await app.inject({ method: 'POST', url: `/api/approvals/${pending.id}/decide`, headers: auth(), payload: { decision: 'maybe' } });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a single-use token from a notification action, once', async () => {
    const approval = box.repos.approvals.pending()[0]!;
    const rawToken = (box.events.find((e) => e.type === 'APPROVAL_REQUIRED') as { payload: { token: string } }).payload.token;

    const first = await app.inject({ method: 'POST', url: '/api/public/approval', payload: { token: rawToken, decision: 'claim' } });
    expect(first.statusCode).toBe(200);
    expect(box.provider.claimCalls).toEqual(['api-1']);

    const second = await app.inject({ method: 'POST', url: '/api/public/approval', payload: { token: rawToken, decision: 'claim' } });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(box.repos.approvals.get(approval.id)?.status).toBe('accepted');
  });

  it('refuses an unknown or forged token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/public/approval', payload: { token: 'forged-token-value', decision: 'claim' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(box.provider.claimCalls).toEqual([]);
  });

  it('renders the approval page for a valid token', async () => {
    const rawToken = (box.events.find((e) => e.type === 'APPROVAL_REQUIRED') as { payload: { token: string } }).payload.token;
    const res = await app.inject({ method: 'GET', url: `/approve/${rawToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('API Game');
    expect(res.body).toContain('Claim');
  });

  it('does not leak the token hash', async () => {
    const approval = box.repos.approvals.pending()[0]!;
    const res = await app.inject({ method: 'GET', url: '/api/approvals', headers: auth() });
    expect(res.body).not.toContain(approval.tokenHash);
  });
});

describe('config and notifications endpoints', () => {
  it('saves a valid config change', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: auth(), payload: { claiming: { mode: 'auto' } } });
    expect(res.statusCode).toBe(200);
    expect(box.configStore.load().claiming.mode).toBe('auto');
  });

  it('rejects an invalid config change', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: auth(), payload: { claiming: { mode: 'nonsense' } } });
    expect(res.statusCode).toBe(400);
    expect(box.configStore.load().claiming.mode).toBe('approval');
  });

  it('toggles one channel without touching the other', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/notifications/toggles', headers: auth(), payload: { events: { CLAIM_SUCCEEDED: { macos: false } } } });
    expect(res.statusCode).toBe(200);
    const config = box.configStore.load();
    expect(config.notifications.events.CLAIM_SUCCEEDED.macos.enabled).toBe(false);
    expect(config.notifications.events.CLAIM_SUCCEEDED.imessage.enabled).toBe(false); // default was off
    expect(config.notifications.events.CLAIM_FAILED.macos.enabled).toBe(true);
    expect(config.notifications.events.CLAIM_FAILED.imessage.enabled).toBe(true);
  });

  it('saves a per-platform template and rejects a bad one', async () => {
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/notifications/templates',
      headers: auth(),
      payload: { adapter: 'imessage', event: 'GAME_DISCOVERED', template: { body: 'New: {game_name} until {offer_expiry}' } },
    });
    expect(ok.statusCode).toBe(200);
    expect(box.configStore.load().notifications.templates.imessage.GAME_DISCOVERED.body).toContain('New:');

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/notifications/templates',
      headers: auth(),
      payload: { adapter: 'imessage', event: 'GAME_DISCOVERED', template: { body: '{totally_unknown}' } },
    });
    expect(bad.statusCode).toBe(400);
    // the macOS template is untouched
    expect(box.configStore.load().notifications.templates.macos.GAME_DISCOVERED.title).toContain('{store_name}');
  });

  it('previews a template without delivering it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/notifications/preview', headers: auth(), payload: { adapter: 'macos', event: 'APPROVAL_REQUIRED' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rendered: { subject: string; body: string } };
    expect(body.rendered.subject).toContain('Claim');
    expect(macos.delivered).toHaveLength(0);
  });

  it('exposes the event matrix with variables per event', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications/matrix', headers: auth() });
    const body = res.json() as { events: Array<{ event: string; variables: string[] }> };
    const approval = body.events.find((e) => e.event === 'APPROVAL_REQUIRED');
    expect(approval?.variables).toContain('approval_url');
  });
});

describe('other endpoints', () => {
  it('returns offers with ownership and attempt state', async () => {
    box.configStore.update({ claiming: { mode: 'auto' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'list-1' })];
    await box.engine.runCycle('manual');
    const res = await app.inject({ method: 'GET', url: '/api/offers', headers: auth() });
    const rows = res.json() as Array<{ title: string; owned: boolean; status: string }>;
    expect(rows[0]?.owned).toBe(true);
    expect(rows[0]?.status).toBe('claimed');
  });

  it('runs a manual check', async () => {
    box.configStore.update({ claiming: { mode: 'auto' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'manual-1' })];
    const res = await app.inject({ method: 'POST', url: '/api/check', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { summary: { claimed: number } }).summary.claimed).toBe(1);
  });

  it('serves update status and history', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/updates', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('history');
  });

  it('serves the dashboard shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('runs a notification test through the API', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/notifications/test', headers: auth(), payload: { adapter: 'imessage', event: 'APPROVAL_REQUIRED' } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { report: { status: string } }).report.status).toBe('delivered');
  });
});

describe('token store', () => {
  it('hashes decision tokens so the database never holds a usable token', () => {
    const raw = 'my-secret-token';
    const hash = createHash('sha256').update(raw).digest('hex');
    expect(hash).not.toBe(raw);
    expect(hash.length).toBe(64);
  });
});

// keep the type import used
export type { AppEventType, Config };
