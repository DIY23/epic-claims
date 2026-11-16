import type { AppEventType } from '../shared/events.js';
import type { TemplateSet } from './template-vars.js';

/**
 * Default templates. Each adapter renders its own: macOS gets a title, subtitle,
 * body and action labels. Adding a channel means adding a set here plus an
 * adapter — the claim engine never changes.
 */
export const DEFAULT_MACOS_TEMPLATES: TemplateSet = {
  GAME_DISCOVERED: {
    title: 'Epic Claims',
    subtitle: 'Free now on {store_name}',
    body: '{game_name} by {publisher} · available until {offer_expiry}',
    approveLabel: 'Claim',
    skipLabel: 'Skip',
  },
  CLAIM_SUCCEEDED: {
    title: 'Epic Claims',
    subtitle: 'Claimed {game_name}',
    body: '{game_name} by {publisher} · added to your library',
  },
  CLAIM_FAILED: {
    title: 'Claim failed: {game_name}',
    subtitle: '{error_code}',
    body: '{error_message}',
  },
  APPROVAL_REQUIRED: {
    title: 'Epic Claims',
    subtitle: 'Claim {game_name}?',
    body: '{game_name} by {publisher} · available until {offer_expiry}',
    approveLabel: 'Claim',
    skipLabel: 'Skip',
  },
  APPROVAL_ACCEPTED: {
    title: 'Approved: {game_name}',
    body: 'Decision accepted by {claim_status}.',
  },
  APPROVAL_REJECTED: {
    title: 'Skipped: {game_name}',
    body: 'You rejected this offer.',
  },
  APPROVAL_EXPIRED: {
    title: 'Approval expired: {game_name}',
    body: 'No decision was received in time. The offer was not claimed.',
  },
  GAME_ALREADY_OWNED: {
    title: 'Already owned',
    subtitle: '{game_name}',
    body: 'No action needed.',
  },
  OFFER_EXPIRING: {
    title: 'Expiring soon: {game_name}',
    subtitle: '{hours_left}h left',
    body: 'Claim before {offer_expiry}.',
    approveLabel: 'Claim',
    skipLabel: 'Skip',
  },
  AUTHENTICATION_EXPIRED: {
    title: 'Epic authentication expired',
    body: 'Run "epic-claims auth login" to sign in again. Reason: {reason}',
  },
  APPLICATION_ERROR: {
    title: 'Epic Claims error',
    subtitle: '{error_scope}',
    body: '{error_code}: {error_message}',
  },
  FIRST_RUN_SUMMARY: {
    title: '{free_count} free games found',
    subtitle: 'nothing claimed yet',
    body: 'Review them in the dashboard and claim what you want. {hint}',
  },
  UPDATE_AVAILABLE: {
    title: 'Epic Claims {available_version} available',
    subtitle: 'installed {current_version}',
    body: 'Run "epic-claims update" to install. {release_url}',
  },
  UPDATE_INSTALLED: {
    title: 'Epic Claims updated',
    subtitle: '{to_version}',
    body: 'Updated from {from_version} to {to_version}.',
  },
  UPDATE_FAILED: {
    title: 'Epic Claims update failed',
    subtitle: '{to_version}',
    body: '{error_code}: {error_message} (rolled back: {rolled_back})',
  },
  RESTART_REQUIRED: {
    title: 'Restart required',
    subtitle: '{restart_version}',
    body: '{reason}',
  },
};

export function cloneTemplates<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export type AdapterId = 'macos';
export const ADAPTER_IDS: AdapterId[] = ['macos'];

export const DEFAULT_TEMPLATES: Record<AdapterId, TemplateSet> = {
  macos: DEFAULT_MACOS_TEMPLATES,
};
