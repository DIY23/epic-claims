import type { Offer, OfferKind, StoreId } from '../shared/types.js';

export interface OwnershipCheck {
  owned: boolean;
  entitlementName: string | null;
  source: 'entitlements' | 'claim_response' | 'unknown';
}

export interface ClaimResponse {
  httpStatus: number;
  ok: boolean;
  entitlementNames: string[];
  raw: unknown;
}

export interface AuthStatus {
  authenticated: boolean;
  accountName: string | null;
  accountId: string | null;
  expiresAt: string | null;
  detail: string;
}

/**
 * Store provider abstraction. Adding a second store means implementing this
 * interface and registering it — the claim engine, scheduler, database and
 * notification layer stay untouched.
 */
export interface StoreProvider {
  readonly id: StoreId;
  readonly displayName: string;

  /** Throws AppError('AUTH_REQUIRED'|'AUTH_EXPIRED') when the session is unusable. */
  ensureAuthenticated(): Promise<void>;
  authStatus(): Promise<AuthStatus>;

  /** Current promotions. Must be free, validated, and de-duplicated by the provider. */
  discoverOffers(): Promise<Offer[]>;

  /** Account entitlement lookup — never infer ownership from storefront metadata. */
  isOwned(offer: Offer): Promise<OwnershipCheck>;

  /** Redeem. Must be idempotent from the caller's perspective (re-claiming is safe). */
  claim(offer: Offer): Promise<ClaimResponse>;
}

export type ProviderFactory = () => StoreProvider;

/** Normalises the loose "kind" strings different sources use. */
export function normaliseKind(input: string | null | undefined): OfferKind {
  const v = (input ?? '').toLowerCase();
  if (v.includes('dlc') || v.includes('addon') || v.includes('add-on') || v.includes('season') || v.includes('pack')) return 'dlc';
  if (v === 'game' || v === 'basegame' || v === 'base_game' || v === 'application') return 'game';
  return v.length === 0 ? 'other' : 'other';
}
