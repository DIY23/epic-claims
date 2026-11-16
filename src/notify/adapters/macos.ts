import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppEvent, AppEventType } from '../../shared/events.js';
import type { Config } from '../../config/schema.js';
import type { AdapterContext, AdapterStatus, DeliveryResult, NotificationAdapter, RenderedNotification } from '../adapter.js';
import { actionLabels } from '../adapter.js';
import type { TemplateFields } from '../template-vars.js';
import { renderForAdapter } from '../manager.js';
import { describeAuthorization, locateHelper, osascriptNotification, NotifierClient, registerBundle, type HelperLocation } from '../macos/helper.js';

export interface MacOSAdapterOptions {
  /** Where the helper bundle may live; defaults to <runtime>/native. */
  helperCandidates: Array<string | null | undefined>;
  /** Data directory (socket + actions log live under <dataDir>/notifier). */
  dataDir: string;
  /** Force the osascript path (tests, or a documented fallback). */
  forceOsascript?: boolean;
}

/**
 * Native macOS notifications through the UserNotifications helper app.
 *
 * Approval notifications carry real action buttons (Claim / Skip). A click is
 * turned into a POST of the single-use approval token to the local API — no LLM,
 * no external service and no polling of the notification itself.
 */
export class MacOSNotificationAdapter implements NotificationAdapter {
  readonly id = 'macos';
  readonly displayName = 'macOS Notification Center';

  constructor(private readonly opts: MacOSAdapterOptions) {}

  private locate(config: Config): HelperLocation {
    return locateHelper(this.opts.helperCandidates, config.notifications.adapters.macos.helperPath);
  }

  private client(config: Config): NotifierClient {
    return new NotifierClient({ location: this.locate(config), dataDir: this.opts.dataDir });
  }

  isEnabled(config: Config, event: AppEventType): boolean {
    if (!config.notifications.adapters.macos.enabled) return false;
    const toggle = (config.notifications.events as unknown as Record<string, { macos?: { enabled: boolean } }>)[event];
    return toggle?.macos?.enabled === true;
  }

  isConfigured(config: Config): boolean {
    return config.notifications.adapters.macos.enabled;
  }

  render(event: AppEvent, template: TemplateFields, ctx: AdapterContext): RenderedNotification {
    const rendered = renderForAdapter(this.id, event, template, ctx.approvalBaseUrl);
    const interactive = ctx.config.notifications.adapters.macos.interactiveActions && typeof rendered.data.approvalUrl === 'string';
    rendered.actions = interactive ? actionLabels(template, { claim: 'Claim', skip: 'Skip' }) : [];
    return rendered;
  }

  async deliver(message: RenderedNotification, event: AppEvent, ctx: AdapterContext): Promise<DeliveryResult> {
    const title = message.subject ?? 'Epic Claims';
    const subtitle = message.subtitle ?? '';
    const cfg = ctx.config.notifications.adapters.macos;

    if (this.opts.forceOsascript) {
      const r = await osascriptNotification(title, subtitle, message.body, cfg.sound);
      return r.ok ? { ok: true, attempts: 1, detail: r.message } : { ok: false, errorCode: 'NOTIFICATION_FAILED', errorMessage: r.message, attempts: 1 };
    }

    const location = this.locate(ctx.config);
    if (!location.present) {
      // Documented degradation: without the helper there are no action buttons.
      const r = await osascriptNotification(title, subtitle, message.body, cfg.sound);
      return r.ok
        ? { ok: true, attempts: 1, detail: 'notification helper missing; delivered via osascript without action buttons' }
        : { ok: false, errorCode: 'NOTIFICATION_FAILED', errorMessage: r.message, attempts: 1 };
    }

    const approvalUrl = typeof message.data.approvalUrl === 'string' ? message.data.approvalUrl : '';
    const approvalToken = approvalUrl ? (approvalUrl.split('/').pop() ?? '') : '';
    const client = this.client(ctx.config);
    try {
      const running = await client.ensureRunning();
      if (!running) {
        // The helper's own log is the only clue when a bundle refuses to start.
        let hint = '';
        try {
          const logPath = path.join(path.dirname(client.socketPath), 'helper.log');
          const tail = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-3).join(' | ');
          if (tail) hint = ` (helper log: ${tail.slice(0, 300)})`;
        } catch {
          /* no log yet */
        }
        ctx.logger.warn('notification helper did not start', { hint });
        const r = await osascriptNotification(title, subtitle, message.body, cfg.sound);
        return r.ok
          ? { ok: true, attempts: 1, detail: 'notification helper did not start; delivered via osascript without action buttons' }
          : { ok: false, errorCode: 'NOTIFICATION_FAILED', errorMessage: `helper did not start and osascript failed: ${r.message}`, attempts: 1 };
      }
      const result = await client.post({
        id: String(message.data.approvalId ?? message.data.offerId ?? randomUUID()),
        title,
        subtitle,
        body: message.body,
        sound: cfg.sound,
        actions: message.actions,
        approvalToken,
        approvalBase: ctx.approvalBaseUrl,
      });
      if (!result.ok) {
        return { ok: false, errorCode: 'NOTIFICATION_FAILED', errorMessage: result.error ?? 'helper rejected the notification', attempts: 1 };
      }
      return { ok: true, attempts: 1, detail: 'delivered via UserNotifications helper' };
    } catch (e) {
      return { ok: false, errorCode: 'NOTIFICATION_FAILED', errorMessage: (e as Error).message, attempts: 1 };
    }
  }

  /** Registers the bundle and requests authorization; call once with a human present. */
  async authorize(config: Config, timeoutMs = 120_000): Promise<{ ok: boolean; detail: string; authorizationStatus: number }> {
    const location = this.locate(config);
    if (!location.present) return { ok: false, detail: `notification helper not found at ${location.bundlePath || '(unset)'}`, authorizationStatus: 0 };
    await registerBundle(location.bundlePath);
    const client = this.client(config);
    const running = await client.ensureRunning();
    if (!running) return { ok: false, detail: 'notification helper did not start', authorizationStatus: 0 };
    const before = await client.status().catch(() => null);
    if (before && before.authorizationStatus === 2) return { ok: true, detail: 'already authorized', authorizationStatus: 2 };
    const result = await client.authorize(timeoutMs);
    return {
      ok: result.authorizationStatus === 2,
      detail: result.granted ? 'authorization granted' : `authorization status ${result.authorizationStatus}`,
      authorizationStatus: result.authorizationStatus,
    };
  }

  async status(ctx: AdapterContext): Promise<AdapterStatus> {
    const cfg = ctx.config.notifications.adapters.macos;
    const enabled = cfg.enabled;
    const location = this.locate(ctx.config);
    if (this.opts.forceOsascript) {
      return { id: this.id, enabled, configured: true, detail: 'osascript fallback forced: no action buttons', capabilities: { interactive: false, richText: false } };
    }
    if (!location.present) {
      return {
        id: this.id,
        enabled,
        configured: enabled,
        detail: `helper not found at ${location.bundlePath || '(unset)'}; falling back to osascript without actions`,
        capabilities: { interactive: false, richText: false },
      };
    }
    try {
      const client = this.client(ctx.config);
      const running = await client.ensureRunning();
      if (!running) {
        return { id: this.id, enabled, configured: false, detail: 'helper installed but not running', capabilities: { interactive: true, richText: false } };
      }
      const status = await client.status();
      return {
        id: this.id,
        enabled,
        configured: status.authorizationStatus === 2 || status.authorizationStatus === 3,
        detail: `${describeAuthorization(status)}${location.signed ? ' · helper signed' : ' · helper ad-hoc signed'}`,
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
