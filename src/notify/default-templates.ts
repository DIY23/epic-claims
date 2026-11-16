import type { AppEventType } from '../shared/events.js';
import type { TemplateSet } from './template-vars.js';

/**
 * Default, platform-specific templates. macOS and iMessage are deliberately NOT
 * the same: macOS notifications get a title/subtitle/body and action labels,
 * iMessage gets a compact multi-line message with explicit reply commands.
 */
export const DEFAULT_MACOS_TEMPLATES: TemplateSet = {
  GAME_DISCOVERED: {
    title: 'Free on {store_name}',
    subtitle: '{game_name}',
    body: 'Available until {offer_expiry}. {publisher}',
    approveLabel: 'Claim',
    skipLabel: 'Skip',
  },
  CLAIM_SUCCEEDED: {
    title: 'Claimed: {game_name}',
    subtitle: '{store_name}',
    body: 'Ownership verified. {claim_status}',
  },
  CLAIM_FAILED: {
    title: 'Claim failed: {game_name}',
    subtitle: '{error_code}',
    body: '{error_message}',
  },
  APPROVAL_REQUIRED: {
    title: 'Claim {game_name}?',
    subtitle: 'Expires {offer_expiry}',
    body: 'Awaiting your decision. Approval expires {approval_expiry}.',
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

export const DEFAULT_IMESSAGE_TEMPLATES: TemplateSet = {
  GAME_DISCOVERED: {
    body: '🎮 Free on {store_name}: {game_name} ({game_kind}) by {publisher}. Available until {offer_expiry}. {offer_url}',
  },
  CLAIM_SUCCEEDED: {
    body: '✅ Claimed and verified: {game_name}. Owned in your Epic library.',
  },
  CLAIM_FAILED: {
    body: '⚠️ Claim failed: {game_name} ({error_code}). {error_message}',
  },
  APPROVAL_REQUIRED: {
    // iMessage may only carry Epic Store links, never a localhost/DDNS URL.
    // The poll above the text is the one-tap path; this line says what the code
    // is for and where the decision can always be taken.
    body: '❓ Claim {game_name}? Free until {offer_expiry}.\nCode {approval_code} — decide in Epic Claims on the Mac (or tap the poll).\nStore: {offer_url}',
    approveLabel: 'Claim',
    skipLabel: 'Skip',
  },
  APPROVAL_ACCEPTED: {
    body: '👍 Approved: {game_name}. Claiming now.',
  },
  APPROVAL_REJECTED: {
    body: '👌 Skipped: {game_name}.',
  },
  APPROVAL_EXPIRED: {
    body: '⌛ Approval expired for {game_name}. Not claimed.',
  },
  GAME_ALREADY_OWNED: {
    body: '📚 Already in your library: {game_name}.',
  },
  OFFER_EXPIRING: {
    body: '⏳ {hours_left}h left: {game_name} — free until {offer_expiry}. {offer_url}',
  },
  AUTHENTICATION_EXPIRED: {
    body: '🔐 Epic session expired ({reason}). Re-authenticate on the Mac: epic-claims auth login',
  },
  APPLICATION_ERROR: {
    body: '🐞 Epic Claims error in {error_scope}: {error_code} — {error_message}',
  },
  FIRST_RUN_SUMMARY: {
    body: '👋 First scan complete: {free_count} free game(s) on the Epic Games Store. Nothing has been claimed. Open the dashboard to choose, then run "epic-claims claim --all" if you want them all. {hint}',
  },
  UPDATE_AVAILABLE: {
    body: '⬆️ Epic Claims {available_version} is available (installed {current_version}). Run: epic-claims update',
  },
  UPDATE_INSTALLED: {
    body: '🔄 Epic Claims updated {from_version} → {to_version}.',
  },
  UPDATE_FAILED: {
    body: '❌ Epic Claims update to {to_version} failed: {error_code} — {error_message} (rolled back: {rolled_back})',
  },
  RESTART_REQUIRED: {
    body: '🔁 Epic Claims {restart_version} needs a restart: {reason}',
  },
};

export function cloneTemplates<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export type AdapterId = 'macos' | 'imessage';
export const ADAPTER_IDS: AdapterId[] = ['macos', 'imessage'];

export const DEFAULT_TEMPLATES: Record<AdapterId, TemplateSet> = {
  macos: DEFAULT_MACOS_TEMPLATES,
  imessage: DEFAULT_IMESSAGE_TEMPLATES,
};
