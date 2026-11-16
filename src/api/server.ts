import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { AppPaths } from '../shared/paths.js';
import type { Clock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import type { Repositories } from '../db/repositories.js';
import type { ConfigStore } from '../config/store.js';
import type { Config } from '../config/schema.js';
import type { NotificationManager } from '../notify/manager.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { ClaimEngine } from '../claim/claimEngine.js';
import type { Updater } from '../update/installer.js';
import type { LaunchdService } from '../service/launchd.js';
import type { ApiTokenStore } from './auth.js';
import { assertLoopback, bearerFrom } from './auth.js';
import { AppError, toAppError } from '../shared/errors.js';
import { EVENT_LABELS, EVENT_TYPES, makeEvent, type AppEvent } from '../shared/events.js';
import { EVENT_VARIABLES, validateTemplate, type TemplateFields } from '../notify/template-vars.js';
import { validateRule } from '../claim/policy.js';
import type { AuthStatus } from '../providers/provider.js';
import type { CycleSummary } from '../shared/types.js';

export interface ApiServices {
  paths: AppPaths;
  version: string;
  startedAt: string;
  configStore: ConfigStore;
  repos: Repositories;
  logger: Logger;
  clock: Clock;
  notifications: NotificationManager;
  scheduler: Scheduler;
  engine: ClaimEngine;
  updater: Updater;
  service: LaunchdService;
  apiToken: ApiTokenStore;
  provider: { readonly id: string; readonly displayName: string; authStatus(): Promise<AuthStatus> };
  runCheck(trigger: CycleSummary['trigger']): Promise<CycleSummary>;
  /** Explicit user opt-in: ignores the first-run gate. */
  runCheckBypassingGate(trigger: CycleSummary['trigger']): Promise<CycleSummary>;
  health(): Promise<{ ok: boolean; detail: string }>;
  requestShutdown(): void;
  assetsDir: string;
}

const decideSchema = z.object({ decision: z.enum(['claim', 'skip']) }).strict();
const publicApprovalSchema = z.object({ token: z.string().min(8).max(200), decision: z.enum(['claim', 'skip']) }).strict();
const testSchema = z.object({ adapter: z.string().min(1), event: z.string().min(1) }).strict();
const rollSchema = z.object({ action: z.enum(['claim', 'skip']) }).strict();
const previewSchema = z
  .object({ adapter: z.string().min(1), event: z.string().min(1), template: z.record(z.unknown()).optional() })
  .strict();

function errorBody(e: unknown): { error: string; message: string; details?: unknown } {
  const err = toAppError(e);
  return { error: err.code, message: err.message, ...(Object.keys(err.context).length ? { details: err.context } : {}) };
}

export async function createApiServer(services: ApiServices): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const log = services.logger.child('api');

  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 400) log.warn('api request failed', { method: req.method, url: req.url, status: reply.statusCode });
  });

  const requireAuth = async (req: FastifyRequest): Promise<void> => {
    const token = bearerFrom(req.headers.authorization) ?? (typeof req.headers['x-api-token'] === 'string' ? req.headers['x-api-token'] : null);
    if (!(await services.apiToken.verify(token))) {
      throw new AppError('AUTH_FAILED', 'missing or invalid API token', { hint: 'pass "Authorization: Bearer <token>" (epic-claims config token)' });
    }
  };

  const publicPaths = new Set(['/api/health', '/api/version']);
  app.addHook('preHandler', async (req) => {
    const url = req.url.split('?')[0] ?? '';
    if (!url.startsWith('/api/')) return;
    if (publicPaths.has(url)) return;
    if (url.startsWith('/api/public/')) return;
    await requireAuth(req);
  });

  app.setErrorHandler((error, _req, reply) => {
    const err = toAppError(error);
    const status = err.code === 'AUTH_FAILED' ? 401 : err.code === 'OFFER_NOT_FOUND' || err.code === 'APPROVAL_NOT_FOUND' ? 404 : err.code === 'CONFIG_INVALID' ? 400 : 500;
    reply.status(status).send(errorBody(error));
  });

  // ---------- health ----------
  app.get('/api/health', async () => {
    const health = await services.health();
    return {
      ok: health.ok,
      version: services.version,
      uptimeSec: Math.round(process.uptime()),
      detail: health.detail,
      checkedAt: services.clock.now().toISOString(),
    };
  });

  app.get('/api/version', async () => ({ version: services.version, startedAt: services.startedAt }));

  // ---------- status ----------
  app.get('/api/status', async () => {
    const config = services.configStore.load();
    const schedulerState = services.scheduler.state();
    const auth = await services.provider.authStatus().catch((e: unknown) => ({ authenticated: false, accountName: null, accountId: null, expiresAt: null, detail: (e as Error).message }));
    const counts = services.repos.offers.countByStatus();
    const updateState = services.updater.readState();
    const serviceStatus = await services.service.status().catch(() => null);
    return {
      version: services.version,
      uptimeSec: Math.round(process.uptime()),
      startedAt: services.startedAt,
      store: { id: services.provider.id, name: services.provider.displayName, auth },
      mode: config.claiming.mode,
      dryRun: config.claiming.dryRun,
      scheduler: {
        running: schedulerState.running,
        lastCheckAt: schedulerState.lastRunAt,
        nextCheckAt: schedulerState.nextRunAt,
        intervalHours: config.scheduling.intervalHours,
        lastSummary: schedulerState.lastSummary,
        lastError: schedulerState.lastError,
      },
      counts,
      approvalsPending: services.repos.approvals.pending().length,
      service: serviceStatus,
      updates: { ...updateState, preference: config.updates.preference, channel: config.updates.channel },
      notifications: await services.notifications.status(),
      database: services.repos.state.get('db.stats') ? JSON.parse(services.repos.state.get('db.stats') as string) : null,
      errors: services.repos.logs.recent(10, 'error'),
    };
  });

  // ---------- offers ----------
  app.get('/api/offers', async () => {
    const offers = services.repos.offers.list({ limit: 200 });
    return offers.map((o) => {
      const owner = services.repos.ownership.get(o.id);
      const attempt = services.repos.claims.latest(o.id);
      const approval = services.repos.approvals.pendingForOffer(o.id);
      return {
        ...o,
        owned: owner?.owned ?? false,
        ownershipVerifiedAt: owner?.verifiedAt ?? null,
        lastAttempt: attempt ?? null,
        pendingApproval: approval ? { id: approval.id, expiresAt: approval.expiresAt, shortCode: approval.shortCode } : null,
      };
    });
  });

  app.post<{ Params: { id: string } }>('/api/offers/:id/claim', async (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new AppError('OFFER_NOT_FOUND', 'invalid offer id');
    const outcome = await services.engine.claimOffer(id, 'dashboard');
    return { outcome };
  });

  app.post<{ Params: { id: string } }>('/api/offers/:id/skip', async (req) => {
    const id = Number(req.params.id);
    const offer = services.repos.offers.get(id);
    if (!offer) throw new AppError('OFFER_NOT_FOUND', 'no such offer');
    services.repos.offers.setStatus(id, 'skipped');
    const pending = services.repos.approvals.pendingForOffer(id);
    if (pending) services.repos.approvals.decide(pending.id, 'rejected', 'dashboard', services.clock.now().toISOString());
    return { ok: true };
  });

  // ---------- approvals ----------
  app.get('/api/approvals', async () => {
    return services.repos.approvals.pending().map((a) => {
      const offer = services.repos.offers.get(a.offerId);
      const { tokenHash: _tokenHash, ...safe } = a;
      return { ...safe, offer: offer ? { id: offer.id, title: offer.title, endAt: offer.endAt, url: offer.url, imageUrl: offer.imageUrl } : null };
    });
  });

  app.post<{ Params: { id: string } }>('/api/approvals/:id/decide', async (req) => {
    const parsed = decideSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', 'body must be {"decision":"claim"|"skip"}');
    const id = Number(req.params.id);
    const result = await services.engine.handleApprovalDecision({ approvalId: id, decision: parsed.data.decision, decidedBy: 'dashboard' });
    if (!result.ok) {
      return { ok: false, reason: result.decision };
    }
    return { ok: true, decision: result.decision, claim: result.claim ?? null };
  });

  /**
   * Token-authenticated, single-use approval endpoint used by the macOS
   * notification buttons and the approval web page. Loopback only.
   */
  app.post('/api/public/approval', async (req) => {
    assertLoopback(req.ip);
    const parsed = publicApprovalSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('APPROVAL_INVALID_TOKEN', 'body must be {"token":"...","decision":"claim"|"skip"}');
    const { approvalId } = await tokenToApprovalId(services, parsed.data.token);
    if (!approvalId) throw new AppError('APPROVAL_INVALID_TOKEN', 'unknown, expired or already used approval token');
    const result = await services.engine.handleApprovalDecision({ approvalId, decision: parsed.data.decision, decidedBy: 'notification' });
    if (!result.ok) throw new AppError(result.decision === 'expired' ? 'APPROVAL_EXPIRED' : 'APPROVAL_INVALID_TOKEN', `approval not applied: ${result.decision}`);
    return { ok: true, decision: result.decision, claim: result.claim ?? null };
  });

  app.get<{ Params: { token: string } }>('/approve/:token', async (req, reply) => {
    assertLoopback(req.ip);
    const approval = await approvalByToken(services, req.params.token);
    if (!approval) {
      reply.type('text/html').send(page('Approval link invalid', '<p>This approval link is invalid or has already been used.</p>'));
      return;
    }
    const offer = approval.offerId ? services.repos.offers.get(approval.offerId) : undefined;
    const expired = Date.parse(approval.expiresAt) <= services.clock.nowMs();
    const status = approval.status;
    const body = `
      <h1>${escapeHtml(offer?.title ?? 'Offer')}</h1>
      <p class="muted">${escapeHtml(services.provider.displayName)} · expires ${escapeHtml(approval.expiresAt)}</p>
      <p>Approval status: <strong>${escapeHtml(expired && status === 'pending' ? 'expired' : status)}</strong></p>
      ${
        status === 'pending' && !expired
          ? `<form method="post" action="/approve/${encodeURIComponent(req.params.token)}">
               <button name="decision" value="claim" class="primary">Claim</button>
               <button name="decision" value="skip">Skip</button>
             </form>`
          : '<p>No action available.</p>'
      }`;
    reply.type('text/html').send(page('Epic Claims approval', body));
  });

  app.post<{ Params: { token: string }; Body: { decision?: string } }>('/approve/:token', async (req, reply) => {
    assertLoopback(req.ip);
    const decision = req.body?.decision === 'skip' ? 'skip' : req.body?.decision === 'claim' ? 'claim' : null;
    if (!decision) {
      reply.status(400).type('text/html').send(page('Epic Claims approval', '<p>Unknown decision.</p>'));
      return;
    }
    const resolved = await tokenToApprovalId(services, req.params.token);
    if (!resolved.approvalId) {
      reply.status(404).type('text/html').send(page('Epic Claims approval', '<p>This approval link is invalid or already used.</p>'));
      return;
    }
    const result = await services.engine.handleApprovalDecision({ approvalId: resolved.approvalId, decision, decidedBy: 'approval-link' });
    const message = result.ok ? (decision === 'claim' ? 'Claiming now. You can close this page.' : 'Skipped. You can close this page.') : `Not applied: ${result.decision}.`;
    reply.type('text/html').send(page('Epic Claims approval', `<p>${escapeHtml(message)}</p>`));
  });

  // ---------- history ----------
  app.get<{ Querystring: { limit?: string } }>('/api/history', async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
    return {
      offers: services.repos.offers.list({ limit }),
      claims: services.repos.claims.history(limit),
      approvals: services.repos.approvals.history(limit).map(({ tokenHash: _tokenHash, ...rest }) => rest),
      notifications: services.repos.notifications.recent(limit),
      events: services.repos.events.recent(limit),
      updates: services.repos.updates.list(limit),
      logs: services.repos.logs.recent(limit, 'info'),
    };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/logs', async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));
    return services.repos.logs.recent(limit, 'debug');
  });

  // ---------- config ----------
  app.get('/api/config', async () => services.configStore.load());

  app.put('/api/config', async (req) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') throw new AppError('CONFIG_INVALID', 'body must be a config object');
    const saved = services.configStore.update(body);
    // Validate hybrid rules separately for friendlier errors.
    const ruleIssues = saved.claiming.rules.flatMap((r) => validateRule(r));
    return { ok: true, config: saved, ruleIssues };
  });

  app.post('/api/config/reset', async () => ({ ok: true, config: services.configStore.reset() }));

  // ---------- notifications ----------
  app.get('/api/notifications/matrix', async () => {
    const config = services.configStore.load();
    const adapters = await services.notifications.status();
    return {
      adapters,
      events: EVENT_TYPES.map((e) => ({
        event: e,
        label: EVENT_LABELS[e],
        toggles: {
          macos: (config.notifications.events as unknown as Record<string, { macos?: { enabled: boolean } }>)[e]?.macos?.enabled ?? false,
          imessage: (config.notifications.events as unknown as Record<string, { imessage?: { enabled: boolean } }>)[e]?.imessage?.enabled ?? false,
        },
        variables: EVENT_VARIABLES[e],
        templates: {
          macos: (config.notifications.templates as unknown as Record<string, Record<string, TemplateFields> | undefined>)['macos']?.[e] ?? null,
          imessage: (config.notifications.templates as unknown as Record<string, Record<string, TemplateFields> | undefined>)['imessage']?.[e] ?? null,
        },
      })),
    };
  });

  app.post('/api/notifications/test', async (req) => {
    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', 'body must be {"adapter":"macos"|"imessage","event":"EVENT"}');
    const event = buildExampleEvent(parsed.data.event, services.clock.now().toISOString());
    const report = await services.notifications.test(event, parsed.data.adapter);
    return { report };
  });

  app.post('/api/notifications/preview', async (req) => {
    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', 'body must be {"adapter","event"}');
    const event = buildExampleEvent(parsed.data.event, services.clock.now().toISOString());
    const override = parsed.data.template ? normaliseTemplate(parsed.data.template) : undefined;
    return services.notifications.preview(event, parsed.data.adapter, override);
  });

  app.put('/api/notifications/templates', async (req) => {
    const body = req.body as { adapter?: string; event?: string; template?: Record<string, unknown> } | undefined;
    if (!body?.adapter || !body.event || !body.template) throw new AppError('CONFIG_INVALID', 'body must be {"adapter","event","template"}');
    if (!(EVENT_TYPES as string[]).includes(body.event)) throw new AppError('CONFIG_INVALID', `unknown event ${body.event}`);
    const template = normaliseTemplate(body.template);
    const issues = validateTemplate(body.event as (typeof EVENT_TYPES)[number], template);
    if (issues.length > 0) throw new AppError('CONFIG_INVALID', 'template is invalid', { issues });
    const config = services.configStore.load();
    const templates = structuredClone(config.notifications.templates) as unknown as Record<string, Record<string, TemplateFields>>;
    const adapterSet = templates[body.adapter];
    if (!adapterSet) throw new AppError('CONFIG_INVALID', `unknown adapter ${body.adapter}`);
    adapterSet[body.event] = template;
    services.configStore.update({ notifications: { templates } });
    return { ok: true, template };
  });

  app.put('/api/notifications/toggles', async (req) => {
    const body = req.body as { events?: Record<string, Record<string, boolean>> } | undefined;
    if (!body?.events) throw new AppError('CONFIG_INVALID', 'body must be {"events":{"EVENT":{"macos":bool,"imessage":bool}}}');
    const patch: Record<string, Record<string, { enabled: boolean }>> = {};
    for (const [event, toggles] of Object.entries(body.events)) {
      if (!(EVENT_TYPES as string[]).includes(event)) throw new AppError('CONFIG_INVALID', `unknown event ${event}`);
      const eventPatch: Record<string, { enabled: boolean }> = {};
      for (const [adapter, enabled] of Object.entries(toggles)) {
        if (adapter !== 'macos' && adapter !== 'imessage') throw new AppError('CONFIG_INVALID', `unknown adapter ${adapter}`);
        eventPatch[adapter] = { enabled: Boolean(enabled) };
      }
      patch[event] = eventPatch;
    }
    services.configStore.update({ notifications: { events: patch } });
    return { ok: true };
  });

  // ---------- scheduler / actions ----------
  app.post('/api/check', async () => {
    const summary = await services.runCheck('manual');
    return { summary };
  });

  /**
   * Explicit "claim everything eligible now". This is the user's opt-in after
   * reviewing the first scan; the scheduler never takes this path.
   */
  app.post('/api/claim-all', async () => {
    const summary = await services.runCheckBypassingGate('manual');
    return { summary };
  });

  app.get('/api/scheduler', async () => services.scheduler.state());

  // ---------- updates ----------
  app.get('/api/updates', async () => ({
    installed: services.updater.readState(),
    preference: services.configStore.load().updates.preference,
    channel: services.configStore.load().updates.channel,
    history: services.repos.updates.list(20),
  }));

  app.post('/api/updates/check', async () => {
    const result = await services.updater.check({});
    return result;
  });

  // ---------- service ----------
  app.get('/api/service', async () => services.service.status());

  // ---------- dashboard ----------
  // The dashboard is static files served from the same origin as the API. Its
  // absence must never stop the backend: the service keeps claiming without it.
  if (fs.existsSync(path.join(services.assetsDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: services.assetsDir,
      prefix: '/',
      index: ['index.html'],
      wildcard: true,
    });
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/html').send(page('Epic Claims', '<p>The dashboard has not been built. Run <code>npm run build:web</code>.</p>'));
    });
  }

  return app;
}

async function approvalByToken(services: ApiServices, token: string): Promise<{ offerId: number | null; expiresAt: string; status: string } | null> {
  const { sha256 } = await import('../shared/logger.js');
  const approval = services.repos.approvals.byTokenHash(sha256(token));
  if (!approval) return null;
  return { offerId: approval.offerId, expiresAt: approval.expiresAt, status: approval.status };
}

async function tokenToApprovalId(services: ApiServices, token: string): Promise<{ approvalId?: number }> {
  const { sha256 } = await import('../shared/logger.js');
  const approval = services.repos.approvals.byTokenHash(sha256(token));
  return approval ? { approvalId: approval.id } : {};
}

function normaliseTemplate(input: Record<string, unknown>): TemplateFields {
  const out: TemplateFields = { body: String(input.body ?? '') };
  if (input.title !== undefined) out.title = String(input.title);
  if (input.subtitle !== undefined) out.subtitle = String(input.subtitle);
  if (input.approveLabel !== undefined) out.approveLabel = String(input.approveLabel);
  if (input.skipLabel !== undefined) out.skipLabel = String(input.skipLabel);
  return out;
}

export function buildExampleEvent(eventType: string, at: string): AppEvent {
  const offer = {
    id: 1,
    storeOfferId: 'example-offer',
    title: 'Example Game',
    publisher: 'Example Studio',
    kind: 'game' as const,
    url: 'https://store.epicgames.com/en-US/p/example',
    imageUrl: null,
    startAt: new Date(Date.now() - 86_400_000).toISOString(),
    endAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    storeName: 'Epic Games Store',
  };
  const payloads: Record<string, unknown> = {
    GAME_DISCOVERED: { offer },
    CLAIM_SUCCEEDED: { offer, verified: true, alreadyOwned: false },
    CLAIM_FAILED: { offer, errorCode: 'HTTP_ERROR', errorMessage: 'HTTP 500 from /entitlements', attempts: 1 },
    APPROVAL_REQUIRED: { offer, approvalId: 1, shortCode: 'a1b2c3d4', token: 'example-token-value-for-preview', expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() },
    APPROVAL_ACCEPTED: { offer, decidedBy: 'dashboard' },
    APPROVAL_REJECTED: { offer, decidedBy: 'dashboard' },
    APPROVAL_EXPIRED: { offer, expiredAt: at },
    GAME_ALREADY_OWNED: { offer },
    OFFER_EXPIRING: { offer, hoursLeft: 6 },
    AUTHENTICATION_EXPIRED: { reason: 'refresh token rejected', accountName: 'player@example.com' },
    APPLICATION_ERROR: { scope: 'scheduler', errorCode: 'NETWORK', message: 'request timed out after 20000ms' },
    FIRST_RUN_SUMMARY: { freeCount: 2, mode: 'approval', hint: 'Run "epic-claims claim --all" to claim everything.' },
    UPDATE_AVAILABLE: { currentVersion: '1.0.0', availableVersion: '1.1.0', releaseUrl: 'https://github.com/DIY23/epic-claims/releases/tag/v1.1.0' },
    UPDATE_INSTALLED: { fromVersion: '1.0.0', toVersion: '1.1.0' },
    UPDATE_FAILED: { fromVersion: '1.0.0', targetVersion: '1.1.0', errorCode: 'UPDATE_HEALTH_FAILED', message: 'service did not become healthy', rolledBack: true },
    RESTART_REQUIRED: { version: '1.1.0', reason: 'restart the launchd service to activate the new version' },
  };
  const payload = payloads[eventType];
  if (!payload) throw new AppError('CONFIG_INVALID', `unknown event ${eventType}`);
  return makeEvent(eventType as (typeof EVENT_TYPES)[number], payload as never, at) as AppEvent;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0d10;color:#e8eaf0}
main{max-width:34rem;padding:2rem}
h1{font-size:1.4rem;margin:0 0 .25rem}
.muted{color:#8b93a7;font-size:.85rem}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #333a4a;background:#171b23;color:inherit;cursor:pointer;margin-right:.5rem}
button.primary{background:#2b6cb0;border-color:#2b6cb0;color:#fff}
form{margin-top:1.5rem}
</style></head><body><main>${body}</main></body></html>`;
}
