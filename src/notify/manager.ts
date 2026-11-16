import type { AppEvent, AppEventType } from '../shared/events.js';
import { EVENT_TYPES } from '../shared/events.js';
import type { Logger } from '../shared/logger.js';
import type { Clock } from '../shared/clock.js';
import { formatDate } from '../shared/clock.js';
import type { Config } from '../config/schema.js';
import type { Repositories } from '../db/repositories.js';
import type { AdapterContext, DeliveryResult, NotificationAdapter, RenderedNotification } from './adapter.js';
import { renderTemplate, validateTemplate, type RenderContext, type TemplateFields } from './template-vars.js';
import { EVENT_VARIABLES } from './template-vars.js';
import { APP_VERSION } from '../version.js';

export interface DispatchReport {
  adapter: string;
  event: AppEventType;
  status: 'delivered' | 'failed' | 'skipped' | 'duplicate' | 'not_configured';
  errorCode?: string;
  errorMessage?: string;
}

export interface NotificationManagerDeps {
  adapters: NotificationAdapter[];
  repos: Repositories;
  clock: Clock;
  logger: Logger;
  getConfig: () => Config;
}

/**
 * Central notification manager.
 *
 * Routing rules live here and nowhere else:
 *  - one global switch (notifications.enabled)
 *  - one switch per adapter (notifications.adapters.<id>.enabled)
 *  - one switch per event *per adapter* (notifications.events.<event>.<id>.enabled)
 *
 * A delivery failure is recorded and swallowed: it can never interrupt, fail or
 * roll back a claim. Missing or disabled channels are never treated as approval.
 */
export class NotificationManager {
  private readonly adapters: Map<string, NotificationAdapter>;

  constructor(private readonly deps: NotificationManagerDeps) {
    this.adapters = new Map(deps.adapters.map((a) => [a.id, a]));
  }

  getAdapterIds(): string[] {
    return [...this.adapters.keys()];
  }

  getAdapter(id: string): NotificationAdapter | undefined {
    return this.adapters.get(id);
  }

  context(config: Config = this.deps.getConfig()): AdapterContext {
    return {
      config,
      logger: this.deps.logger,
      clock: this.deps.clock,
      approvalBaseUrl: config.api.publicBaseUrl.replace(/\/$/, ''),
    };
  }

  /** Routes one event to every enabled, configured adapter. Never throws. */
  async dispatch(event: AppEvent, opts: { ignoreToggles?: boolean; only?: string } = {}): Promise<DispatchReport[]> {
    const config = this.deps.getConfig();
    const reports: DispatchReport[] = [];
    if (!config.notifications.enabled) {
      return [{ adapter: '*', event: event.type, status: 'skipped', errorCode: 'NOTIFICATIONS_DISABLED' }];
    }

    for (const adapter of this.adapters.values()) {
      if (opts.only && adapter.id !== opts.only) continue;
      const report = await this.dispatchToAdapter(adapter, event, config, opts.ignoreToggles === true);
      reports.push(report);
    }
    return reports;
  }

  private async dispatchToAdapter(adapter: NotificationAdapter, event: AppEvent, config: Config, ignoreToggles: boolean): Promise<DispatchReport> {
    const log = this.deps.logger.child(`notify.${adapter.id}`);
    const base: DispatchReport = { adapter: adapter.id, event: event.type, status: 'skipped' };

    try {
      if (!ignoreToggles) {
        if (!adapter.isEnabled(config, event.type)) {
          return { ...base, status: 'skipped', errorCode: 'EVENT_DISABLED' };
        }
        if (!adapter.isConfigured(config)) {
          return { ...base, status: 'not_configured', errorCode: 'ADAPTER_NOT_CONFIGURED' };
        }
      }

      const template = this.templateFor(config, adapter.id, event.type);
      const ctx = this.context(config);
      const issues = validateTemplate(event.type, template);
      if (issues.length > 0) {
        // A user-edited template that no longer validates must not sink the event.
        log.warn('template invalid, falling back to a minimal message', { issues: issues.slice(0, 3) });
      }

      let rendered: RenderedNotification;
      try {
        rendered = adapter.render(event, template, ctx);
      } catch (e) {
        return { ...base, status: 'failed', errorCode: 'RENDER_FAILED', errorMessage: (e as Error).message };
      }

      const dedupeKey = ignoreToggles ? null : dedupeKeyFor(event, adapter.id);
      const now = this.deps.clock.now().toISOString();
      const recordId = this.deps.repos.notifications.insert({
        event: event.type,
        adapter: adapter.id,
        status: 'skipped',
        dedupeKey,
        subject: rendered.subject ?? rendered.body.slice(0, 80),
        body: rendered.body,
        createdAt: now,
        payload: { data: rendered.data },
      });
      if (recordId === null) {
        log.debug('duplicate notification suppressed', { dedupeKey });
        return { ...base, status: 'duplicate' };
      }

      let result: DeliveryResult;
      try {
        result = await adapter.deliver(rendered, event, ctx);
      } catch (e) {
        result = { ok: false, errorCode: 'DELIVERY_EXCEPTION', errorMessage: (e as Error).message, attempts: 1 };
      }

      if (result.ok) {
        this.deps.repos.notifications.markDelivered(recordId, this.deps.clock.now().toISOString(), result.attempts);
        if (rendered.data.approvalId !== undefined && rendered.data.approvalId !== null) {
          this.deps.repos.approvals.markDelivered(Number(rendered.data.approvalId), adapter.id);
        }
        return { ...base, status: 'delivered' };
      }
      this.deps.repos.notifications.markFailed(recordId, result.errorCode ?? 'DELIVERY_FAILED', result.errorMessage ?? 'delivery failed', result.attempts);
      log.warn('delivery failed', { event: event.type, errorCode: result.errorCode, errorMessage: result.errorMessage });
      return { ...base, status: 'failed', ...(result.errorCode ? { errorCode: result.errorCode } : {}), ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}) };
    } catch (e) {
      log.exception('notification dispatch failed', e, { event: event.type });
      return { ...base, status: 'failed', errorCode: 'DISPATCH_FAILED', errorMessage: (e as Error).message };
    }
  }

  /** Sends a test notification through a specific adapter, bypassing toggles. */
  async test(event: AppEvent, adapterId: string): Promise<DispatchReport> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return { adapter: adapterId, event: event.type, status: 'failed', errorCode: 'UNKNOWN_ADAPTER', errorMessage: `no adapter named ${adapterId}` };
    const config = this.deps.getConfig();
    const ctx = this.context(config);
    const template = this.templateFor(config, adapterId, event.type);
    try {
      const result = await adapter.test(event, template, ctx);
      return {
        adapter: adapterId,
        event: event.type,
        status: result.ok ? 'delivered' : 'failed',
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      };
    } catch (e) {
      return { adapter: adapterId, event: event.type, status: 'failed', errorCode: 'TEST_FAILED', errorMessage: (e as Error).message };
    }
  }

  async status(): Promise<Array<{ id: string; displayName: string } & Awaited<ReturnType<NotificationAdapter['status']>>>> {
    const ctx = this.context();
    const out: Array<{ id: string; displayName: string } & Awaited<ReturnType<NotificationAdapter['status']>>> = [];
    for (const adapter of this.adapters.values()) {
      const st = await adapter.status(ctx);
      out.push({ displayName: adapter.displayName, ...st });
    }
    return out;
  }

  /** Renders without delivering — used by the dashboard preview. */
  preview(event: AppEvent, adapterId: string, templateOverride?: TemplateFields): { ok: boolean; rendered?: RenderedNotification; issues?: unknown[] } {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return { ok: false, issues: [`unknown adapter ${adapterId}`] };
    const config = this.deps.getConfig();
    const template = templateOverride ?? this.templateFor(config, adapterId, event.type);
    const issues = validateTemplate(event.type, template);
    const ctx = this.context(config);
    try {
      return { ok: issues.length === 0, rendered: adapter.render(event, template, ctx), issues };
    } catch (e) {
      return { ok: false, issues: [...issues, (e as Error).message] };
    }
  }

  private templateFor(config: Config, adapterId: string, event: AppEventType): TemplateFields {
    const sets = config.notifications.templates as unknown as Record<string, Record<string, TemplateFields>>;
    const fromConfig = sets[adapterId]?.[event];
    if (fromConfig) return fromConfig;
    // Last-resort fallback so a partially migrated config still notifies.
    return { body: '{game_name}' };
  }

  /** All events, for the dashboard matrix. */
  static events(): AppEventType[] {
    return EVENT_TYPES;
  }
}

/**
 * Dedupe scope per event: durable for facts (discovered, owned, expiring) and
 * per-approval for decisions, so a re-delivered notification can never cause a
 * second claim and a genuine second event is not swallowed.
 */
export function dedupeKeyFor(event: AppEvent, adapterId: string): string | null {
  const p = event.payload as Record<string, unknown>;
  const offer = p.offer as { id?: number | null; storeOfferId?: string } | undefined;
  const offerKey = offer?.id ?? offer?.storeOfferId ?? null;
  switch (event.type) {
    case 'GAME_DISCOVERED':
    case 'GAME_ALREADY_OWNED':
    case 'CLAIM_SUCCEEDED':
    case 'OFFER_EXPIRING':
      return offerKey === null ? null : `${event.type}|${adapterId}|${offerKey}`;
    case 'CLAIM_FAILED':
      return offerKey === null ? null : `${event.type}|${adapterId}|${offerKey}|${String(p.errorCode ?? '')}`;
    case 'APPROVAL_REQUIRED':
    case 'APPROVAL_ACCEPTED':
    case 'APPROVAL_REJECTED':
    case 'APPROVAL_EXPIRED':
      return `${event.type}|${adapterId}|${String(p.approvalId ?? offerKey ?? '')}`;
    case 'FIRST_RUN_SUMMARY':
      return `${event.type}|${adapterId}|baseline`;
    case 'AUTHENTICATION_EXPIRED':
      return `${event.type}|${adapterId}|${event.at.slice(0, 13)}`; // once per hour
    case 'UPDATE_AVAILABLE':
      return `${event.type}|${adapterId}|${String(p.availableVersion ?? '')}`;
    default:
      return null;
  }
}

/** Builds the template context for an event. Values are pre-formatted strings. */
export function buildRenderContext(event: AppEvent, extra: Record<string, unknown> = {}): RenderContext {
  const p = event.payload as Record<string, unknown>;
  const offer = (p.offer ?? {}) as Record<string, unknown>;
  const ctx: RenderContext = {
    game_name: String(offer.title ?? 'Unknown game'),
    publisher: String(offer.publisher ?? ''),
    store_name: String(offer.storeName ?? 'Epic Games Store'),
    offer_start: formatDate(offer.startAt as string | null),
    offer_expiry: formatDate(offer.endAt as string | null),
    claim_status: String(offer.id ? `offer #${offer.id}` : ''),
    offer_url: String(offer.url ?? ''),
    game_kind: String(offer.kind ?? 'game'),
    app_version: APP_VERSION,
    ...extra,
  };
  if (event.type === 'APPROVAL_REQUIRED') {
    ctx.approval_code = String(p.shortCode ?? '');
    ctx.approval_expiry = formatDate(p.expiresAt as string | null);
    ctx.approval_url = ''; // filled by the adapter, which knows its own base URL
  }
  if (event.type === 'CLAIM_FAILED') {
    ctx.error_code = String(p.errorCode ?? '');
    ctx.error_message = String(p.errorMessage ?? '');
  }
  if (event.type === 'OFFER_EXPIRING') ctx.hours_left = String(p.hoursLeft ?? '');
  if (event.type === 'AUTHENTICATION_EXPIRED') {
    ctx.reason = String(p.reason ?? '');
    ctx.account_name = String(p.accountName ?? '');
  }
  if (event.type === 'FIRST_RUN_SUMMARY') {
    ctx.free_count = String(p.freeCount ?? 0);
    ctx.claim_mode = String(p.mode ?? '');
    ctx.hint = String(p.hint ?? '');
  }
  if (event.type === 'APPLICATION_ERROR') {
    ctx.error_scope = String(p.scope ?? '');
    ctx.error_code = String(p.errorCode ?? '');
    ctx.error_message = String(p.message ?? '');
  }
  if (event.type === 'UPDATE_AVAILABLE') {
    ctx.current_version = String(p.currentVersion ?? '');
    ctx.available_version = String(p.availableVersion ?? '');
    ctx.release_url = String(p.releaseUrl ?? '');
  }
  if (event.type === 'UPDATE_INSTALLED') {
    ctx.from_version = String(p.fromVersion ?? '');
    ctx.to_version = String(p.toVersion ?? '');
  }
  if (event.type === 'UPDATE_FAILED') {
    ctx.from_version = String(p.fromVersion ?? '');
    ctx.to_version = String(p.targetVersion ?? '');
    ctx.error_code = String(p.errorCode ?? '');
    ctx.error_message = String(p.message ?? '');
    ctx.rolled_back = p.rolledBack ? 'true' : 'false';
  }
  if (event.type === 'RESTART_REQUIRED') {
    ctx.restart_version = String(p.version ?? '');
    ctx.reason = String(p.reason ?? '');
  }
  return ctx;
}

export function renderForAdapter(adapterId: string, event: AppEvent, template: TemplateFields, approvalBaseUrl: string): RenderedNotification {
  const p = event.payload as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  if (event.type === 'APPROVAL_REQUIRED' && typeof p.token === 'string') {
    extra.approval_url = `${approvalBaseUrl}/approve/${p.token}`;
  }
  const ctx = buildRenderContext(event, extra);
  const allowed = EVENT_VARIABLES[event.type] ?? [];
  const body = renderTemplate(template.body, ctx, allowed);
  const title = template.title ? renderTemplate(template.title, ctx, allowed) : null;
  const subtitle = template.subtitle ? renderTemplate(template.subtitle, ctx, allowed) : null;
  const data: Record<string, string | number | null> = {};
  if (typeof p.approvalId === 'number') data.approvalId = p.approvalId;
  if (typeof p.shortCode === 'string') data.approvalCode = p.shortCode;
  if (typeof p.token === 'string') data.approvalUrl = `${approvalBaseUrl}/approve/${p.token}`;
  const offer = p.offer as { id?: number; title?: string } | undefined;
  if (offer?.id !== undefined) data.offerId = offer.id;
  if (offer?.title) data.offerTitle = offer.title;
  data.adapter = adapterId;
  data.event = event.type;
  return { subject: title, subtitle, body, actions: [], data };
}
