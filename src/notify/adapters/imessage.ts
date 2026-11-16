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
    const key = `${cfg.transport}|${cfg.service}|${cfg.photon.baseUrl}|${cfg.photon.spaceId}|${cfg.bridge.baseUrl}`;
    if (this.cachedTransport && this.cachedKey === key) return this.cachedTransport;
    this.cachedTransport = createTransport(cfg.transport, {
      service: cfg.service,
      recipient: cfg.recipient,
      bridgePassword: cfg.bridge.password,
      baseUrl: cfg.transport === 'photon' ? cfg.photon.baseUrl : cfg.bridge.baseUrl,
      spaceId: cfg.photon.spaceId,
      tokenFile: cfg.photon.tokenFile,
    });
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
    if (cfg.transport === 'photon') return cfg.photon.baseUrl.trim().length > 0 && cfg.photon.spaceId.trim().length > 0;
    if (cfg.transport === 'bluebubbles') return cfg.bridge.baseUrl.trim().length > 0 && cfg.recipient.trim().length > 0;
    return cfg.recipient.trim().length > 0;
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
    // Hard rule for this channel: only public https links may appear. A local
    // approval URL is useless on a phone and the gateway refuses/strips it, so
    // any loopback, .local or private-network URL is removed from the body.
    body = body
      .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?\S*/gi, '')
      .replace(/https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)[^\s]*/gi, '')
      .replace(/https?:\/\/[^\s/]+\.local\S*/gi, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n');

    if (body.length > max) body = `${body.slice(0, max - 1)}…`;
    rendered.body = body;
    rendered.subject = null;
    rendered.subtitle = null;
    rendered.actions = [];
    return rendered;
  }

  async deliver(message: RenderedNotification, event: AppEvent, ctx: AdapterContext): Promise<DeliveryResult> {
    const cfg = ctx.config.notifications.adapters.imessage;
    if (!this.isConfigured(ctx.config)) {
      return { ok: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorMessage: 'iMessage channel is not configured', attempts: 1 };
    }
    try {
      const transport = this.transport(ctx.config);
      const timeoutMs = cfg.sendTimeoutSeconds * 1000;
      const parts: string[] = [];

      // 1. The message itself.
      const text = await transport.send(cfg.recipient, message.body, timeoutMs);
      if (!text.ok) {
        return { ok: false, errorCode: text.errorCode ?? 'NOTIFICATION_FAILED', errorMessage: text.errorMessage ?? 'send failed', attempts: 1 };
      }
      parts.push('message');

      // 2. The store page as a link card (thumbnail + title + domain), never a
      //    second inline URL: iMessage only renders a card for a bare link.
      const storeUrl = typeof message.data.offerUrl === 'string' ? message.data.offerUrl : '';
      if (storeUrl && typeof transport.sendRichLink === 'function') {
        const card = await transport.sendRichLink(storeUrl, timeoutMs);
        parts.push(card.ok ? 'link card' : `link card failed (${card.errorMessage ?? 'error'})`);
      }

      // 3. One-tap Claim / Skip poll for approvals.
      if (event.type === 'APPROVAL_REQUIRED' && cfg.photon.usePoll && typeof transport.sendPoll === 'function') {
        const options = message.actions.length >= 2 ? message.actions.map((a) => a.title) : ['Claim', 'Skip'];
        const pollTitle =
          message.subject ??
          (typeof message.data.offerTitle === 'string' ? `Claim ${message.data.offerTitle}?` : 'Claim this game?');
        const poll = await transport.sendPoll(pollTitle, options, timeoutMs);
        parts.push(poll.ok ? 'poll' : `poll failed (${poll.errorMessage ?? 'error'})`);
      }

      return { ok: true, attempts: 1, detail: parts.join(' + ') };
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
    if (!this.isConfigured(ctx.config)) {
      const why =
        cfg.transport === 'photon'
          ? 'Photon gateway needs a spaceId (run: epic-claims notifications photon <spaceId>)'
          : cfg.transport === 'bluebubbles'
            ? 'BlueBubbles needs a baseUrl and a recipient'
            : 'AppleScript transport needs a recipient handle';
      return { id: this.id, enabled, configured: false, detail: why, capabilities: { interactive: true, richText: false } };
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
