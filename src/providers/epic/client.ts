import type { Clock } from '../../shared/clock.js';
import type { Logger } from '../../shared/logger.js';
import { AppError, toAppError } from '../../shared/errors.js';
import { httpJson } from '../../shared/http.js';
import type { Config } from '../../config/schema.js';
import type { Offer } from '../../shared/types.js';
import type { EpicAuthManager } from '../../auth/epicAuth.js';
import {
  ECOM_BASE,
  ENTITLEMENT_SERVICE,
  EULA_KEYS,
  EULA_SERVICE,
  FREE_GAMES_URL,
  ORDER_PROCESSOR,
  PAYMENT_SERVICE,
  LAUNCHER_UA,
} from './endpoints.js';
import type { RawEntitlement, RawOwnershipEntry } from './parse.js';

export interface EpicClientDeps {
  auth: EpicAuthManager;
  getConfig: () => Config;
  logger: Logger;
  clock: Clock;
  fetchImpl?: typeof fetch;
}

interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  /** Skip auth (the promotions endpoint is public). */
  anonymous?: boolean;
  timeoutMs?: number;
}

/**
 * Thin HTTP layer for Epic's services.
 *
 * Every non-2xx answer is raised as an AppError carrying the HTTP status and the
 * parsed Epic error body, so callers can classify (auth, ownership, rate limit,
 * prerequisite) instead of string-matching.
 */
export class EpicClient {
  constructor(private readonly deps: EpicClientDeps) {}

  private config(): Config {
    return this.deps.getConfig();
  }

  private async authHeader(): Promise<string | null> {
    const { token } = await this.deps.auth.getAccessToken();
    return `bearer ${token}`;
  }

  private async call<T>(url: string, opts: CallOptions = {}): Promise<{ status: number; data: T }> {
    const config = this.config();
    const headers: Record<string, string> = {
      'user-agent': LAUNCHER_UA,
      ...opts.headers,
    };
    if (!opts.anonymous) {
      const auth = await this.authHeader();
      if (auth) headers.authorization = auth;
    }
    try {
      const res = await httpJson<T>(url, {
        method: opts.method ?? 'GET',
        headers,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        timeoutMs: opts.timeoutMs ?? config.epic.requestTimeoutMs,
        retries: config.epic.requestRetries,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      });
      return { status: res.status, data: res.data };
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'HTTP_ERROR') {
        const status = Number(err.context.status ?? 0);
        const rawBody = typeof err.context.body === 'string' ? err.context.body : '';
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        const epicCode = typeof parsed?.errorCode === 'string' ? parsed.errorCode : '';
        if (status === 401 || epicCode.includes('authentication_failed') || epicCode.includes('invalid_token')) {
          throw new AppError('AUTH_EXPIRED', `Epic rejected the session (${epicCode || status}) — sign in again`, { status, url: safeUrl(url) });
        }
        if (status === 403 && epicCode.includes('missing_permission')) {
          throw new AppError('AUTH_FAILED', `this Epic account lacks the required permission (${epicCode})`, { status, url: safeUrl(url) });
        }
        if (status === 429) throw new AppError('RATE_LIMITED', 'Epic rate-limited the request', { status, url: safeUrl(url) }, true);
        if (/captcha|challenge|arkose|talon/i.test(rawBody)) {
          throw new AppError('CLAIM_REJECTED', 'Epic presented a captcha challenge; this claim needs a manual sign-in and retry', { status });
        }
        throw new AppError('HTTP_ERROR', `Epic returned HTTP ${status} from ${safeUrl(url)}`, {
          status,
          epicCode,
          epicMessage: parsed?.errorMessage ?? rawBody.slice(0, 300),
          url: safeUrl(url),
        });
      }
      throw err;
    }
  }

  /** Public free-promotion listing. No credentials involved. */
  async promotions(): Promise<unknown> {
    const config = this.config();
    const url = `${FREE_GAMES_URL}?locale=${encodeURIComponent(config.epic.locale)}&country=${config.epic.country}&allowCountries=${config.epic.country}`;
    const res = await this.call<unknown>(url, { anonymous: true, timeoutMs: 25_000 });
    return res.data;
  }

  /** Authoritative ownership answer for up to 100 catalog items. */
  async ownership(accountId: string, items: Array<{ namespace: string; itemId: string }>): Promise<RawOwnershipEntry[]> {
    if (items.length === 0) return [];
    const params = items
      .slice(0, 100)
      .map((i) => `nsCatalogItemId=${encodeURIComponent(`${i.namespace}:${i.itemId}`)}`)
      .join('&');
    const url = `${ECOM_BASE}/v3/platforms/EPIC/identities/${encodeURIComponent(accountId)}/ownership?${params}`;
    const res = await this.call<RawOwnershipEntry[]>(url);
    return Array.isArray(res.data) ? res.data : [];
  }

  /** Full entitlement list from the launcher entitlement service (paginated). */
  async entitlements(accountId: string): Promise<RawEntitlement[]> {
    const out: RawEntitlement[] = [];
    let start = 0;
    for (let page = 0; page < 20; page++) {
      const url = `${ENTITLEMENT_SERVICE}/entitlement/api/account/${encodeURIComponent(accountId)}/entitlements?start=${start}&count=1000`;
      const res = await this.call<RawEntitlement[]>(url);
      const rows = Array.isArray(res.data) ? res.data : [];
      out.push(...rows);
      if (rows.length < 1000) break;
      start += rows.length;
    }
    return out;
  }

  /** First attempt in the claim chain; Epic answers CHECKOUT for store offers. */
  async quickPurchase(accountId: string, offer: Offer): Promise<{ status: string; httpStatus: number }> {
    const config = this.config();
    const url = `${ORDER_PROCESSOR}/orderprocessor/api/shared/accounts/${encodeURIComponent(accountId)}/orders/quickPurchase?country=${config.epic.country}&locale=${config.epic.locale}`;
    const res = await this.call<{ quickPurchaseStatus?: string }>(url, {
      method: 'POST',
      body: {
        salesChannel: 'Launcher-purchase-client',
        entitlementSource: 'Launcher-purchase-client',
        returnSplitPaymentItems: false,
        lineOffers: [{ offerId: offer.offerId ?? offer.storeOfferId, quantity: 1, namespace: offer.namespace }],
      },
    });
    return { status: res.data?.quickPurchaseStatus ?? 'UNKNOWN', httpStatus: res.status };
  }

  /** Step 1 of the checkout chain: a purchase token for this offer. */
  async purchaseToken(accountId: string, offer: Offer): Promise<string> {
    const res = await this.call<{ purchaseToken?: string }>(`${PAYMENT_SERVICE}/payment/v1/purchaseToken`, {
      method: 'POST',
      body: {
        locale: '',
        offers: [offer.offerId ?? offer.storeOfferId],
        subscriptionSlug: '',
        namespace: offer.namespace,
      },
    });
    const token = res.data?.purchaseToken;
    if (!token) throw new AppError('CLAIM_REJECTED', 'Epic did not return a purchase token', { accountId });
    return token;
  }

  /** Step 2: order preview (total price must be zero for a free promotion). */
  async orderPreview(accountId: string, offer: Offer, purchaseToken: string): Promise<Record<string, unknown>> {
    const res = await this.call<Record<string, unknown>>(`${PAYMENT_SERVICE}/purchase/order-preview`, {
      method: 'POST',
      headers: { 'x-requested-with': purchaseToken },
      body: {
        useDefault: true,
        setDefault: false,
        namespace: offer.namespace,
        country: null,
        countryName: null,
        orderId: null,
        orderComplete: null,
        orderError: null,
        orderPending: null,
        offers: [offer.offerId ?? offer.storeOfferId],
        offerPrice: '',
      },
    });
    const total = (res.data?.orderResponse as { totalPrice?: number } | undefined)?.totalPrice;
    if (typeof total === 'number' && total > 0) {
      throw new AppError('OFFER_NOT_FREE', `Epic's order preview asks for ${total} — refusing to complete a paid order`, { total });
    }
    return res.data;
  }

  /** Step 3: confirm the (zero-cost) order. This is the actual claim. */
  async confirmOrder(accountId: string, offer: Offer, purchaseToken: string, preview: Record<string, unknown>): Promise<{ confirmed: boolean; httpStatus: number; body: Record<string, unknown> }> {
    const orderResponse = (preview.orderResponse ?? {}) as { totalPrice?: number; country?: string; countryName?: string; offers?: unknown[] };
    const res = await this.call<{ confirmation?: boolean }>(`${PAYMENT_SERVICE}/purchase/confirm-order`, {
      method: 'POST',
      headers: { 'x-requested-with': purchaseToken },
      body: {
        useDefault: true,
        setDefault: false,
        namespace: offer.namespace,
        country: preview.country ?? orderResponse.country ?? null,
        countryName: preview.countryName ?? orderResponse.countryName ?? null,
        orderId: null,
        orderComplete: null,
        orderError: null,
        orderPending: null,
        offers: orderResponse.offers ?? [offer.offerId ?? offer.storeOfferId],
        includeAccountBalance: false,
        totalAmount: orderResponse.totalPrice ?? 0,
        affiliateId: '',
        creatorSource: '',
        syncToken: preview.syncToken ?? null,
      },
    });
    return { confirmed: res.data?.confirmation === true, httpStatus: res.status, body: (res.data ?? {}) as Record<string, unknown> };
  }

  /**
   * Best-effort EULA acceptance for the two agreements a launcher purchase
   * requires. Failures are logged, never fatal: some accounts already accepted
   * them, and a rejected EULA surfaces later as an explicit claim failure.
   */
  async acceptEulas(accountId: string): Promise<void> {
    const log = this.deps.logger.child('eula');
    for (const key of EULA_KEYS) {
      try {
        const current = await this.call<{ version?: number; accepted?: boolean }>(
          `${EULA_SERVICE}/eulatracking/api/public/agreements/${encodeURIComponent(key)}/account/${encodeURIComponent(accountId)}`,
          { timeoutMs: 12_000 },
        );
        const version = current.data?.version;
        if (!version || current.data?.accepted === true) continue;
        await this.call(
          `${EULA_SERVICE}/eulatracking/api/public/agreements/${encodeURIComponent(key)}/version/${version}/account/${encodeURIComponent(accountId)}/accept?locale=${encodeURIComponent(this.config().epic.locale)}`,
          { method: 'POST', body: {} },
        );
        log.info('accepted EULA', { key, version });
      } catch (e) {
        log.debug('EULA check skipped', { key, error: (e as Error).message });
      }
    }
  }
}

function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '<invalid url>';
  }
}
