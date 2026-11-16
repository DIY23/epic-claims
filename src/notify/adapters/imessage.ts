import path from 'node:path';
import type { AppEvent, AppEventType } from '../../shared/events.js';
import type { Config } from '../../config/schema.js';
import type { AdapterContext, AdapterStatus, DeliveryResult, NotificationAdapter, RenderedNotification } from '../adapter.js';
import type { TemplateFields } from '../template-vars.js';
import { renderForAdapter } from '../manager.js';
import { createTransport, type IMessageTransport } from '../imessage/transports.js';

export interface IMessageAdapterOptions {
  /** Injectable for tests; otherwise built from config. */
  transport?: IMessageTransport;
  /** Max text length accepted by the bridge / Messages.app before truncation. */
  maxLength?: number;
}

const APPROVAL_HINT = (code: string): string => `Reply "CLAIM ${code}" to claim or "SKIP ${code}" to skip.`;

/**
 * iMessage notification adapter.
 *
 * Sending is delegated to a swappable transport (AppleScript on this Mac, or an
 * HTTP bridge). Approval interactions use explicit, verifiable commands
 * ("CLAIM <code>" / "SKIP <code>") or the single-use approval link — native
 * iMessage notification replies are never assumed to be programmable.
 *
 * Disabling or breaking this adapter cannot affect claiming: the manager
 * isolates delivery failures.
 */
export class IMessageNotificationAdapter implements NotificationAdapter {
  readonly id = 'imessage';
  readonly displayName = 'iMessage';
  private cachedTransport: IMessageTransport | null = null;
  private cachedKey: string | null = null;

  constructor(private readonly opts: IMessageAdapterOptions = {}) {}

  /** Public so the inbound command service can reply through the same transport. */
  resolveTransport(config: Config): IMessageTransport {
    if (this.opts.transport) return this.opts.transport;
    const cfg = config.notifications.adapters.imessage;
    const key = `${cfg.transport}|${cfg.service}|${cfg.bridge.baseUrl}|${cfg.bridge.password ? 'pw' : ''}`;
    if (this.cachedTransport && this.cachedKey === key) return this.cachedTransport;
    this.cachedTransport = createTransport(cfg.transport, { baseUrl: cfg.bridge.baseUrl, password: cfg.bridge.password }, cfg.service);
    this.cachedKey = key;
    return this.cachedTransport;
  }

  private transport(config: Config): IMessageTransport {
    return this.resolveTransport(config);
  }

  isEnabled(config: Config, event: AppEventType): boolean {
    if (!config.notifications.adapters.imessage.enabled) return false;
    const toggle = (config.notifications.events as unknown as Record<string, { imessage?: { enabled: boolean } }>)[event];
    return toggle?.imessage?.enabled === true;
  }

  isConfigured(config: Config): boolean {
    const cfg = config.notifications.adapters.imessage;
    if (!cfg.enabled) return false;
    if (!cfg.recipient.trim()) return false;
    if (cfg.transport === 'bluebubbles') return cfg.bridge.baseUrl.trim().length > 0;
    return true;
  }

  render(event: AppEvent, template: TemplateFields, ctx: AdapterContext): RenderedNotification {
    const rendered = renderForAdapter(this.id, event, template, ctx.approvalBaseUrl);
    const max = this.opts.maxLength ?? 3500;
    let body = rendered.body;
    // Approval messages must always carry the reply command, even if a user
    // edited the template down to just the game name.
    if (event.type === 'APPROVAL_REQUIRED' && typeof rendered.data.approvalCode === 'string') {
      const code = String(rendered.data.approvalCode);
      if (!body.toLowerCase().includes(`claim ${code}`)) body = `${body}\n${APPROVAL_HINT(code)}`;
      if (rendered.data.approvalUrl && !body.includes(String(rendered.data.approvalUrl))) {
        body = `${body}\n${String(rendered.data.approvalUrl)}`;
      }
    }
    if (body.length > max) body = `${body.slice(0, max - 1)}…`;
    rendered.body = body;
    rendered.subject = null;
    rendered.subtitle = null;
    rendered.actions = [];
    return rendered;
  }

  async deliver(message: RenderedNotification, event: AppEvent, ctx: AdapterContext): Promise<DeliveryResult> {
    const cfg = ctx.config.notifications.adapters.imessage;
    if (!cfg.recipient.trim()) {
      return { ok: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorMessage: 'no iMessage recipient configured', attempts: 1 };
    }
    try {
      const transport = this.transport(ctx.config);
      const res = await transport.send(cfg.recipient, message.body, cfg.sendTimeoutSeconds * 1000);
      if (res.ok) return { ok: true, attempts: 1, detail: res.detail ?? 'sent' };
      return { ok: false, errorCode: res.errorCode ?? 'NOTIFICATION_FAILED', errorMessage: res.errorMessage ?? 'send failed', attempts: 1 };
    } catch (e) {
      return { ok: false, errorCode: 'NOTIFICATION_FAILED', errorMessage: (e as Error).message, attempts: 1 };
    }
  }

  async status(ctx: AdapterContext): Promise<AdapterStatus> {
    const cfg = ctx.config.notifications.adapters.imessage;
    const enabled = cfg.enabled;
    if (!enabled) {
      return { id: this.id, enabled, configured: false, detail: 'disabled in configuration', capabilities: { interactive: true, richText: false } };
    }
    if (!cfg.recipient.trim()) {
      return { id: this.id, enabled, configured: false, detail: 'no recipient configured', capabilities: { interactive: true, richText: false } };
    }
    try {
      const ready = await this.transport(ctx.config).readiness();
      return {
        id: this.id,
        enabled,
        configured: ready.ready,
        detail: `${cfg.transport}: ${ready.detail}`,
        capabilities: { interactive: true, richText: false },
      };
    } catch (e) {
      return { id: this.id, enabled, configured: false, detail: (e as Error).message, capabilities: { interactive: true, richText: false } };
    }
  }

  async test(event: AppEvent, template: TemplateFields, ctx: AdapterContext): Promise<DeliveryResult> {
    const rendered = this.render(event, template, ctx);
    return this.deliver(rendered, event, ctx);
  }
}

export function chatDbPath(config: Config): string {
  return path.resolve(config.notifications.adapters.imessage.chatDbPath.replace(/^~/, process.env.HOME ?? '~'));
}
