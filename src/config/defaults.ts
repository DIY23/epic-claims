import { EVENT_TYPES } from '../shared/events.js';
import { DEFAULT_MACOS_TEMPLATES, cloneTemplates } from '../notify/default-templates.js';
import type { Config } from './schema.js';

type EventToggles = Record<(typeof EVENT_TYPES)[number], { macos: Toggle }>;
type Toggle = { enabled: boolean };

/**
 * Default delivery matrix. macOS is the only shipped channel (2.0.0 removed the
 * iMessage adapter); the adapter interface stays, so another channel can be
 * added without touching the claim engine.
 */
const DEFAULT_EVENT_TOGGLES: Record<(typeof EVENT_TYPES)[number], { macos: boolean }> = {
  GAME_DISCOVERED: { macos: true },
  CLAIM_SUCCEEDED: { macos: true },
  CLAIM_FAILED: { macos: true },
  APPROVAL_REQUIRED: { macos: true },
  APPROVAL_ACCEPTED: { macos: false },
  APPROVAL_REJECTED: { macos: false },
  APPROVAL_EXPIRED: { macos: true },
  GAME_ALREADY_OWNED: { macos: false },
  OFFER_EXPIRING: { macos: false },
  AUTHENTICATION_EXPIRED: { macos: true },
  APPLICATION_ERROR: { macos: true },
  FIRST_RUN_SUMMARY: { macos: true },
  UPDATE_AVAILABLE: { macos: true },
  UPDATE_INSTALLED: { macos: true },
  UPDATE_FAILED: { macos: true },
  RESTART_REQUIRED: { macos: true },
};

export function defaultConfig(): Config {
  const events = {} as EventToggles;
  for (const e of EVENT_TYPES) {
    const t = DEFAULT_EVENT_TOGGLES[e];
      events[e] = { macos: { enabled: t.macos } };
  }

  return {
    configVersion: 1,
    epic: {
      country: 'BE',
      locale: 'en-US',
      browserChannel: 'chrome',
      browserExecutablePath: null,
      headlessAfterLogin: true,
      loginTimeoutSeconds: 300,
      requestTimeoutMs: 20000,
      requestRetries: 2,
    },
    scheduling: {
      mode: 'release',
      releaseTime: '11:00',
      releaseTimeZone: 'America/New_York',
      scanOffsetMinutes: 30,
      dailyTime: '17:30',
      timeZone: '',
      intervalHours: 24,
      runOnStartup: true,
      approvalPollMinutes: 15,
      expiringWarningHours: 24,
      cycleTimeoutMinutes: 20,
    },
    claiming: {
      mode: 'approval',
      firstRun: 'discover_only',
      dryRun: false,
      approvalExpiryAction: 'skip',
      approvalExpiryHours: 72,
      maxClaimsPerCycle: 10,
      minSecondsBeforeExpiry: 300,
      verificationAttempts: 5,
      verificationDelaySeconds: 4,
      rules: [],
    },
    notifications: {
      enabled: true,
      adapters: {
        macos: { enabled: true, sound: true, interactiveActions: true, helperPath: null },
      },
      events,
      templates: {
        macos: cloneTemplates(DEFAULT_MACOS_TEMPLATES),
      },
    },
    api: { enabled: true, host: '127.0.0.1', port: 8781, publicBaseUrl: 'http://127.0.0.1:8781' },
    logging: { level: 'info', maxFileMb: 10, maxFiles: 7, retentionDays: 180 },
    updates: {
      preference: 'notify',
      channel: 'stable',
      checkIntervalHours: 24,
      repo: 'DIY23/epic-claims',
      publicKey: '',
      requireSignature: false,
      drainTimeoutSeconds: 60,
    },
    service: { label: 'com.diy23.epic-claims', startAtLogin: true, keepAlive: true },
  };
}

/** Deep-ish merge used when the on-disk file predates a new field. */
export function mergeConfig(base: unknown, patch: unknown): unknown {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch;
  if (typeof patch !== 'object' || typeof base !== 'object' || base === null) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = mergeConfig((base as Record<string, unknown>)[k], v);
  }
  return out;
}
