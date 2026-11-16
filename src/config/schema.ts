import { z } from 'zod';
import { EVENT_TYPES } from '../shared/events.js';

const templateFields = z.object({
  title: z.string().max(120).optional(),
  subtitle: z.string().max(200).optional(),
  body: z.string().min(1).max(1200),
  approveLabel: z.string().max(40).optional(),
  skipLabel: z.string().max(40).optional(),
});

const templateSet = z.object(
  Object.fromEntries(EVENT_TYPES.map((e) => [e, templateFields])) as Record<(typeof EVENT_TYPES)[number], typeof templateFields>,
);

const adapterToggle = z.object({ enabled: z.boolean() }).strict();
const eventToggle = z.object({ macos: adapterToggle }).strict();
const eventToggles = z.object(
  Object.fromEntries(EVENT_TYPES.map((e) => [e, eventToggle])) as Record<(typeof EVENT_TYPES)[number], typeof eventToggle>,
);

export const policyRuleSchema = z
  .object({
    id: z.string().min(1).max(64),
    enabled: z.boolean(),
    /** null/empty means "any" */
    field: z.enum(['kind', 'publisher', 'title', 'price', 'discount_percent']),
    op: z.enum(['is', 'is_not', 'contains', 'not_contains', 'matches', 'gte', 'lte']),
    value: z.string().max(200),
    action: z.enum(['claim', 'approval', 'skip']),
    note: z.string().max(200).optional(),
  })
  .strict();

const epicSchema = z
  .object({
    country: z.string().length(2).default('BE'),
    locale: z.string().min(2).max(10).default('en-US'),
    /** Playwright browser channel used for interactive sign-in. */
    browserChannel: z.enum(['chrome', 'chromium', 'msedge']).default('chrome'),
    browserExecutablePath: z.string().nullable().default(null),
    /** Sign-in window is always headed; refresh/re-validation may stay headless. */
    headlessAfterLogin: z.boolean().default(true),
    loginTimeoutSeconds: z.number().int().min(60).max(1800).default(300),
    requestTimeoutMs: z.number().int().min(2000).max(120000).default(20000),
    /** Extra retries on top of the first attempt for store API calls. */
    requestRetries: z.number().int().min(0).max(6).default(2),
  })
  .strict();

const schedulingSchema = z
  .object({
    /**
     * 'release'  — 30 minutes after the store publishes (default, location-aware)
     * 'daily'    — a fixed local wall-clock time
     * 'interval' — every N hours (coarse fallback)
     */
    mode: z.enum(['release', 'daily', 'interval']).default('release'),
    /** Publish time in the publisher's zone: 11:00 America/New_York = 17:00 CET. */
    releaseTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'expected HH:MM (24h)')
      .default('11:00'),
    releaseTimeZone: z.string().default('America/New_York'),
    /** Minutes to wait after the publish instant. */
    scanOffsetMinutes: z.number().int().min(0).max(1440).default(30),
    /** Only used by mode = 'daily'. Empty means "this machine's time zone". */
    dailyTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'expected HH:MM (24h)')
      .default('17:30'),
    timeZone: z.string().default(''),
    intervalHours: z.number().min(0.1).max(168).default(24),
    runOnStartup: z.boolean().default(true),
    /** Retry cadence for offers that are pending approval, in minutes. */
    approvalPollMinutes: z.number().int().min(1).max(1440).default(15),
    /** Emit OFFER_EXPIRING this many hours before an offer ends. */
    expiringWarningHours: z.number().min(0).max(240).default(24),
    /** A cycle that takes longer than this is aborted (prevents overlaps). */
    cycleTimeoutMinutes: z.number().int().min(1).max(240).default(20),
  })
  .strict();

const claimingSchema = z
  .object({
    mode: z.enum(['auto', 'approval', 'hybrid']).default('approval'),
    /**
     * First run behaviour. 'discover_only' records what is on offer and claims
     * nothing, so a fresh install never sweeps the whole catalogue into an
     * account without a decision. 'normal' applies the mode immediately.
     */
    firstRun: z.enum(['discover_only', 'normal']).default('discover_only'),
    dryRun: z.boolean().default(false),
    /** What happens when an approval request expires. */
    approvalExpiryAction: z.enum(['skip', 'keep_pending']).default('skip'),
    approvalExpiryHours: z.number().min(0.25).max(720).default(72),
    /** Hard cap per cycle; protects against a bad data day. */
    maxClaimsPerCycle: z.number().int().min(1).max(100).default(10),
    /** Never claim items whose promotion has this many seconds left or less. */
    minSecondsBeforeExpiry: z.number().int().min(0).max(86400).default(300),
    /** Ownership verification polling after a claim. */
    verificationAttempts: z.number().int().min(1).max(20).default(5),
    verificationDelaySeconds: z.number().int().min(0).max(120).default(4),
    rules: z.array(policyRuleSchema).default([]),
  })
  .strict();

const macOSAdapterSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Play the default notification sound. */
    sound: z.boolean().default(true),
    /** Show action buttons on approval notifications (requires the helper app). */
    interactiveActions: z.boolean().default(true),
    helperPath: z.string().nullable().default(null),
  })
  .strict();



const notificationsSchema = z
  .object({
    adapters: z
      .object({
        macos: macOSAdapterSchema,
      })
      .strict(),
    /** Per-event, per-adapter delivery toggles. */
    events: eventToggles,
    /** Independent editable templates per platform. */
    templates: z
      .object({
        macos: templateSet,
      })
      .strict(),
    /** Global off-switch that keeps the app running with no notifications. */
    enabled: z.boolean().default(true),
  })
  .strict();

const apiSchema = z
  .object({
    enabled: z.boolean().default(true),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1024).max(65535).default(8781),
    /** Public base URL used in approval links (loopback only by default). */
    publicBaseUrl: z.string().default('http://127.0.0.1:8781'),
  })
  .strict();

const loggingSchema = z
  .object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    maxFileMb: z.number().min(1).max(200).default(10),
    maxFiles: z.number().int().min(1).max(30).default(7),
    /** Keep error rows in the database for this many days. */
    retentionDays: z.number().int().min(1).max(3650).default(180),
  })
  .strict();

const updatesSchema = z
  .object({
    preference: z.enum(['manual', 'notify', 'auto']).default('notify'),
    channel: z.enum(['stable', 'beta']).default('stable'),
    checkIntervalHours: z.number().min(1).max(720).default(24),
    repo: z.string().default('DIY23/epic-claims'),
    /** Optional ed25519 public key (base64, raw 32 bytes) for artifact signature checks. */
    publicKey: z.string().default(''),
    /** Refuse to install an artifact whose signature is missing when a key is configured. */
    requireSignature: z.boolean().default(false),
    /** Seconds to wait for an in-flight claim before refusing/aborting an update. */
    drainTimeoutSeconds: z.number().int().min(0).max(600).default(60),
  })
  .strict();

const serviceSchema = z
  .object({
    label: z.string().default('com.diy23.epic-claims'),
    startAtLogin: z.boolean().default(true),
    keepAlive: z.boolean().default(true),
  })
  .strict();

export const configSchema = z
  .object({
    configVersion: z.literal(1).default(1),
    epic: epicSchema.default({}),
    scheduling: schedulingSchema.default({}),
    claiming: claimingSchema.default({}),
    notifications: notificationsSchema,
    api: apiSchema.default({}),
    logging: loggingSchema.default({}),
    updates: updatesSchema.default({}),
    service: serviceSchema.default({}),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type PolicyRule = z.infer<typeof policyRuleSchema>;
export type EpicConfig = z.infer<typeof epicSchema>;
export type ClaimingConfig = z.infer<typeof claimingSchema>;
export type SchedulingConfig = z.infer<typeof schedulingSchema>;
export type NotificationsConfig = z.infer<typeof notificationsSchema>;
export type UpdatesConfig = z.infer<typeof updatesSchema>;
export type ApiConfig = z.infer<typeof apiSchema>;

export interface ValidationFailure {
  path: string;
  message: string;
}

export function describeIssues(err: z.ZodError): ValidationFailure[] {
  return err.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}
