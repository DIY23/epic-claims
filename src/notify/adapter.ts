import type { AppEvent, AppEventType } from '../shared/events.js';
import type { TemplateFields } from './template-vars.js';
import type { Config } from '../config/schema.js';

/** A fully rendered, platform-specific message. Adapters produce these themselves. */
export interface RenderedNotification {
  /** macOS: notification title. iMessage: unused (kept for logging). */
  subject: string | null;
  subtitle: string | null;
  body: string;
  /** Interactive affordances; adapters decide what they can actually render. */
  actions: Array<{ id: 'claim' | 'skip'; title: string }>;
  /** Machine-readable data an adapter may need to wire an interaction. */
  data: Record<string, string | number | null>;
}

export interface DeliveryResult {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  attempts: number;
  detail?: string;
}

export interface AdapterStatus {
  id: string;
  enabled: boolean;
  configured: boolean;
  detail: string;
  capabilities: { interactive: boolean; richText: boolean };
}

export interface AdapterContext {
  config: Config;
  logger: import('../shared/logger.js').Logger;
  clock: import('../shared/clock.js').Clock;
  /** Base URL used to build single-use approval links. */
  approvalBaseUrl: string;
}

/**
 * Notification Adapter Pattern.
 *
 * An adapter owns everything platform specific: rendering its own templates,
 * delivering the message, reporting delivery status and — where the platform
 * supports it — wiring an interaction back to the application. Adapters are
 * constructed from configuration only; they never touch the claim engine, the
 * database or the scheduler.
 */
export interface NotificationAdapter {
  readonly id: string;
  readonly displayName: string;

  /** Cheap, side-effect-free check used by the manager before rendering. */
  isEnabled(config: Config, event: AppEventType): boolean;
  /** Whether the adapter has everything it needs (recipient, binary, permission). */
  isConfigured(config: Config): boolean;

  render(event: AppEvent, template: TemplateFields, ctx: AdapterContext): RenderedNotification;

  deliver(message: RenderedNotification, event: AppEvent, ctx: AdapterContext): Promise<DeliveryResult>;

  status(ctx: AdapterContext): Promise<AdapterStatus>;

  /** Used by "send test notification" in the dashboard / CLI. */
  test(event: AppEvent, template: TemplateFields, ctx: AdapterContext): Promise<DeliveryResult>;
}

/** Shared action labels: an adapter may override them from the template. */
export function actionLabels(template: TemplateFields, defaults: { claim: string; skip: string }): Array<{ id: 'claim' | 'skip'; title: string }> {
  return [
    { id: 'claim', title: template.approveLabel?.trim() || defaults.claim },
    { id: 'skip', title: template.skipLabel?.trim() || defaults.skip },
  ];
}
