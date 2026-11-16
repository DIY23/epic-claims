/** Domain types shared by every module. No I/O here. */

export type StoreId = 'epic';
export type OfferKind = 'game' | 'dlc' | 'other';

export interface Offer {
  store: StoreId;
  /** Stable per-store identifier of the promotional offer. */
  storeOfferId: string;
  title: string;
  description: string;
  publisher: string;
  kind: OfferKind;
  namespace: string | null;
  offerId: string | null;
  catalogItemId: string | null;
  productSlug: string | null;
  pageSlug: string | null;
  url: string | null;
  imageUrl: string | null;
  originalPrice: number | null;
  discountPrice: number | null;
  currency: string | null;
  startAt: string | null;
  endAt: string | null;
  raw?: unknown;
}

/** A persisted offer row (database shape, camelCased). */
export interface StoredOffer extends Offer {
  id: number;
  discoveredAt: string;
  lastSeenAt: string;
  status: OfferStatus;
}

export type OfferStatus =
  | 'discovered'
  | 'pending_approval'
  | 'claiming'
  | 'claimed'
  | 'already_owned'
  | 'skipped'
  | 'failed'
  | 'expired';

export interface ClaimAttempt {
  id: number;
  offerId: number;
  attemptNo: number;
  status: 'in_progress' | 'succeeded' | 'failed' | 'abandoned';
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  verified: boolean;
  initiator: string;
}

export interface OwnershipRecord {
  offerId: number;
  owned: boolean;
  entitlementName: string | null;
  verifiedAt: string;
  source: 'entitlements' | 'claim_response' | 'unknown';
}

export type ApprovalStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

export interface Approval {
  id: number;
  offerId: number;
  tokenHash: string;
  shortCode: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  channel: string | null;
}

export type ClaimMode = 'auto' | 'approval' | 'hybrid';

export interface CycleSummary {
  startedAt: string;
  finishedAt: string;
  trigger: 'startup' | 'scheduled' | 'manual';
  discovered: number;
  claimed: number;
  alreadyOwned: number;
  pendingApproval: number;
  skipped: number;
  failed: number;
  expired: number;
  authRequired: boolean;
  errors: string[];
}

export interface HealthReport {
  ok: boolean;
  version: string;
  uptimeSec: number;
  dbOk: boolean;
  authOk: boolean;
  schedulerRunning: boolean;
  lastCycleAt: string | null;
  nextCycleAt: string | null;
  checkedAt: string;
}
