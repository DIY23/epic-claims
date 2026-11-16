import type { Logger } from '../../shared/logger.js';
import type { Clock } from '../../shared/clock.js';
import type { Config } from '../../config/schema.js';
import type { Offer } from '../../shared/types.js';
import { AppError, toAppError } from '../../shared/errors.js';
import type { AuthStatus, ClaimResponse, OwnershipCheck, StoreProvider } from '../provider.js';
import type { EpicAuthManager } from '../../auth/epicAuth.js';
import { EpicClient } from './client.js';
import { entitlementMatches, parsePromotions, type RawEntitlement } from './parse.js';

export interface EpicProviderDeps {
  auth: EpicAuthManager;
  getConfig: () => Config;
  logger: Logger;
  clock: Clock;
  fetchImpl?: typeof fetch;
  /** Injected in tests. */
  client?: EpicClient;
}

const ENTITLEMENT_CACHE_MS = 30_000;

/**
 * Epic Games Store provider.
 *
 * Keeps three identifiers strictly separate — offerId (purchase), catalogItemId
 * (ownership/entitlements) and entitlementName (entitlement records). Conflating
 * them is the classic bug in free-game claimers.
 */
export class EpicGamesProvider implements StoreProvider {
  readonly id = 'epic' as const;
  readonly displayName = 'Epic Games Store';
  private readonly client: EpicClient;
  private entitlementCache: { at: number; rows: RawEntitlement[] } | null = null;
  private eulasAccepted = false;

  constructor(private readonly deps: EpicProviderDeps) {
    this.client =
      deps.client ??
      new EpicClient({
        auth: deps.auth,
        getConfig: deps.getConfig,
        logger: deps.logger,
        clock: deps.clock,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
  }

  async ensureAuthenticated(): Promise<void> {
    await this.deps.auth.ensureAuthenticated();
  }

  async authStatus(): Promise<AuthStatus> {
    return this.deps.auth.status();
  }

  /** Current free promotions only. Upcoming ones are exposed for the dashboard. */
  async discoverOffers(): Promise<Offer[]> {
    const payload = await this.client.promotions();
    const parsed = parsePromotions(payload, this.deps.clock.now());
    this.deps.logger.child('epic').info('promotions discovered', {
      free: parsed.free.length,
      upcoming: parsed.upcoming.length,
      discounted: parsed.discounted,
      skipped: parsed.skipped,
    });
    return parsed.free;
  }

  async discoverUpcoming(): Promise<Offer[]> {
    const payload = await this.client.promotions();
    return parsePromotions(payload, this.deps.clock.now()).upcoming;
  }

  private async accountId(): Promise<string> {
    const { accountId } = await this.deps.auth.getAccessToken();
    if (!accountId) throw new AppError('AUTH_EXPIRED', 'the Epic session has no account id — sign in again');
    return accountId;
  }

  /**
   * Ownership is answered by Epic, never inferred from storefront metadata.
   * Primary: the documented-ish QueryOwnership endpoint (fast, batched).
   * Fallback: the launcher entitlement list, matched on namespace+catalogItemId.
   */
  async isOwned(offer: Offer): Promise<OwnershipCheck> {
    const accountId = await this.accountId();
    if (offer.namespace && offer.catalogItemId) {
      try {
        const rows = await this.client.ownership(accountId, [{ namespace: offer.namespace, itemId: offer.catalogItemId }]);
        const match = rows.find((r) => r.namespace === offer.namespace && r.itemId === offer.catalogItemId);
        if (match) return { owned: match.owned === true, entitlementName: null, source: 'entitlements' };
      } catch (e) {
        const err = toAppError(e);
        if (err.code === 'AUTH_EXPIRED' || err.code === 'AUTH_REQUIRED') throw err;
        this.deps.logger.child('epic').debug('ownership endpoint failed, falling back to entitlements', { error: err.message });
      }
    }
    const entitlements = await this.entitlements();
    const match = entitlementMatches(entitlements, offer);
    return { owned: match !== null, entitlementName: match?.entitlementName ?? null, source: 'entitlements' };
  }

  private async entitlements(): Promise<RawEntitlement[]> {
    if (this.entitlementCache && this.deps.clock.nowMs() - this.entitlementCache.at < ENTITLEMENT_CACHE_MS) {
      return this.entitlementCache.rows;
    }
    const accountId = await this.accountId();
    const rows = await this.client.entitlements(accountId);
    this.entitlementCache = { at: this.deps.clock.nowMs(), rows };
    return rows;
  }

  /** Invalidates the in-process ownership cache (called after a successful claim). */
  invalidateCache(): void {
    this.entitlementCache = null;
  }

  /**
   * Redemption chain:
   *   quickPurchase (fast path) -> purchaseToken -> order-preview -> confirm-order
   *
   * The order preview must total zero; anything else aborts rather than risking a
   * paid order. Success is a `confirmation === true`, but the caller must still
   * verify ownership — a confirmation is not an entitlement.
   */
  async claim(offer: Offer): Promise<ClaimResponse> {
    const accountId = await this.accountId();
    const log = this.deps.logger.child('epic.claim');
    if (!offer.offerId || !offer.namespace) {
      throw new AppError('CLAIM_REJECTED', 'offer is missing its Epic offer id or namespace', { storeOfferId: offer.storeOfferId });
    }

    if (!this.eulasAccepted) {
      await this.client.acceptEulas(accountId);
      this.eulasAccepted = true;
    }

    try {
      const quick = await this.client.quickPurchase(accountId, offer);
      if (quick.status === 'SUCCESS') {
        this.invalidateCache();
        return { httpStatus: quick.httpStatus, ok: true, entitlementNames: [], raw: { path: 'quickPurchase' } };
      }
      log.info('quickPurchase did not complete the order, using the checkout chain', { status: quick.status });
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'ALREADY_OWNED') throw err;
      if (err.code === 'AUTH_EXPIRED' || err.code === 'AUTH_REQUIRED') throw err;
      log.info('quickPurchase unavailable, using the checkout chain', { error: err.message });
    }

    let purchaseToken: string;
    try {
      purchaseToken = await this.client.purchaseToken(accountId, offer);
    } catch (e) {
      throw classifyClaimError(e, offer);
    }

    let preview: Record<string, unknown>;
    try {
      preview = await this.client.orderPreview(accountId, offer, purchaseToken);
    } catch (e) {
      throw classifyClaimError(e, offer);
    }

    let confirmation;
    try {
      confirmation = await this.client.confirmOrder(accountId, offer, purchaseToken, preview);
    } catch (e) {
      throw classifyClaimError(e, offer);
    }

    this.invalidateCache();
    if (!confirmation.confirmed) {
      throw new AppError('CLAIM_REJECTED', 'Epic did not confirm the order', { body: confirmation.body });
    }
    return {
      httpStatus: confirmation.httpStatus,
      ok: true,
      entitlementNames: [],
      raw: { path: 'confirm-order', confirmation: confirmation.body },
    };
  }
}

function classifyClaimError(e: unknown, offer: Offer): AppError {
  const err = toAppError(e);
  const epicCode = String(err.context.epicCode ?? '');
  const epicMessage = String(err.context.epicMessage ?? err.message);
  if (/owned|already_purchased|already_redeemed/i.test(epicCode) || /already own/i.test(epicMessage)) {
    return new AppError('ALREADY_OWNED', `Epic reports the account already owns ${offer.title}`, { epicCode });
  }
  if (/not_available|unavailable|region/i.test(epicCode)) {
    return new AppError('CLAIM_REJECTED', `Epic refused the claim (${epicCode}): ${epicMessage}`, { epicCode, offerId: offer.storeOfferId });
  }
  if (/prerequisite|base_game/i.test(epicCode)) {
    return new AppError('CLAIM_REJECTED', `this add-on needs its base game first (${epicCode})`, { epicCode });
  }
  return err.code === 'HTTP_ERROR'
    ? new AppError('CLAIM_REJECTED', `Epic refused the claim (${epicCode || err.context.status}): ${epicMessage}`, { epicCode })
    : err;
}

export function createEpicProvider(deps: EpicProviderDeps): StoreProvider {
  return new EpicGamesProvider(deps);
}
