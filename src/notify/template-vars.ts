import { EVENT_TYPES, type AppEventType } from '../shared/events.js';

/** Variables available to templates, per event. Rendering is limited to this whitelist. */
export const COMMON_VARIABLES = [
  'game_name',
  'publisher',
  'store_name',
  'offer_start',
  'offer_expiry',
  'claim_status',
  'offer_url',
  'app_version',
] as const;

export const EVENT_VARIABLES: Record<AppEventType, string[]> = {
  GAME_DISCOVERED: [...COMMON_VARIABLES, 'game_kind'],
  CLAIM_SUCCEEDED: [...COMMON_VARIABLES, 'game_kind'],
  CLAIM_FAILED: [...COMMON_VARIABLES, 'game_kind', 'error_code', 'error_message'],
  APPROVAL_REQUIRED: [...COMMON_VARIABLES, 'game_kind', 'approval_code', 'approval_url', 'approval_expiry'],
  APPROVAL_ACCEPTED: [...COMMON_VARIABLES],
  APPROVAL_REJECTED: [...COMMON_VARIABLES],
  APPROVAL_EXPIRED: [...COMMON_VARIABLES],
  GAME_ALREADY_OWNED: [...COMMON_VARIABLES],
  OFFER_EXPIRING: [...COMMON_VARIABLES, 'hours_left'],
  AUTHENTICATION_EXPIRED: ['account_name', 'reason', 'app_version'],
  APPLICATION_ERROR: ['error_scope', 'error_code', 'error_message', 'app_version'],
  FIRST_RUN_SUMMARY: ['free_count', 'claim_mode', 'hint'],
  UPDATE_AVAILABLE: ['current_version', 'available_version', 'release_url', 'app_version'],
  UPDATE_INSTALLED: ['from_version', 'to_version', 'app_version'],
  UPDATE_FAILED: ['from_version', 'to_version', 'error_code', 'error_message', 'rolled_back', 'app_version'],
  RESTART_REQUIRED: ['restart_version', 'reason', 'app_version'],
};

export interface TemplateFields {
  /** macOS only */
  title?: string;
  subtitle?: string;
  /** both */
  body: string;
  /** Action labels shown by adapters that support buttons */
  approveLabel?: string;
  skipLabel?: string;
}

export type TemplateSet = Record<AppEventType, TemplateFields>;

export interface TemplateValidationIssue {
  field: string;
  message: string;
}

const VAR_RE = /\{([a-zA-Z0-9_]+)\}/g;

export function extractVariables(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found];
}

/**
 * Validates a template against an event's whitelist. Rejects unknown variables,
 * unbalanced braces and unreasonable length. Never throws.
 */
export function validateTemplate(event: AppEventType, fields: TemplateFields, limits = { body: 1200, title: 120, subtitle: 200 }): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  const allowed = new Set(EVENT_VARIABLES[event] ?? COMMON_VARIABLES);
  const check = (field: string, value: string | undefined, max: number, required = false): void => {
    if (value === undefined) {
      if (required) issues.push({ field, message: 'is required' });
      return;
    }
    if (required && value.trim().length === 0) issues.push({ field, message: 'must not be empty' });
    if (value.length > max) issues.push({ field, message: `must be at most ${max} characters (is ${value.length})` });
    // unbalanced braces
    const opens = (value.match(/\{/g) ?? []).length;
    const closes = (value.match(/\}/g) ?? []).length;
    if (opens !== closes) issues.push({ field, message: 'has unbalanced braces' });
    for (const v of extractVariables(value)) {
      if (!allowed.has(v)) issues.push({ field, message: `uses unknown variable {${v}} (allowed: ${[...allowed].sort().join(', ')})` });
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) issues.push({ field, message: 'contains control characters' });
  };
  check('title', fields.title, limits.title);
  check('subtitle', fields.subtitle, limits.subtitle);
  check('body', fields.body, limits.body, true);
  check('approveLabel', fields.approveLabel, 40);
  check('skipLabel', fields.skipLabel, 40);
  return issues;
}

export interface RenderContext {
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Safe substitution: only whitelisted variable names are replaced, unknown
 * placeholders are left verbatim (validation flags them before a template can be
 * saved, so a stray brace can never become an injection vector).
 */
export function renderTemplate(template: string, ctx: RenderContext, allowed: string[]): string {
  const allowedSet = new Set(allowed);
  return template.replace(VAR_RE, (whole, name: string) => {
    if (!allowedSet.has(name)) return whole;
    const value = ctx[name];
    if (value === null || value === undefined) return '';
    return String(value).replace(/[\u0000-\u001F\u007F]/g, ' ');
  });
}

export function defaultValueSets(): Record<AppEventType, TemplateSet> {
  throw new Error('not used');
}

export const DEFAULT_VARIABLE_EXAMPLE: RenderContext = {
  game_name: 'Example Game',
  publisher: 'Example Studio',
  store_name: 'Epic Games Store',
  offer_start: '17/11/2026, 17:00',
  offer_expiry: '24/11/2026, 17:00',
  claim_status: 'pending',
  offer_url: 'https://store.epicgames.com/en-US/p/example',
  app_version: '1.0.0',
  game_kind: 'game',
  error_code: 'NETWORK',
  error_message: 'request timed out after 20000ms',
  approval_code: '3f9c1a7b',
  approval_url: 'http://127.0.0.1:8781/approve/3f9c1a7b',
  approval_expiry: '20/11/2026, 17:00',
  hours_left: '6',
  account_name: 'player@example.com',
  reason: 'refresh token rejected',
  error_scope: 'scheduler',
  current_version: '1.0.0',
  available_version: '1.1.0',
  release_url: 'https://github.com/DIY23/epic-claims/releases/tag/v1.1.0',
  from_version: '1.0.0',
  to_version: '1.1.0',
  rolled_back: 'true',
  restart_version: '1.1.0',
};
