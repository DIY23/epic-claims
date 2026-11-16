import { describe, expect, it } from 'vitest';
import { parsePromotions, resolvePageSlug, entitlementMatches, type RawPromotionElement } from './epicFixtures.js';
import { EpicGamesProvider } from '../src/providers/epic/index.js';
import { EpicClient } from '../src/providers/epic/client.js';
import { FakeClock } from '../src/shared/clock.js';
import { Logger } from '../src/shared/logger.js';
import { defaultConfig } from '../src/config/defaults.js';
import { configSchema } from '../src/config/schema.js';
import type { Offer } from '../src/shared/types.js';
import type { EpicAuthManager } from '../src/auth/epicAuth.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');

function element(overrides: Partial<RawPromotionElement> = {}): RawPromotionElement {
  return {
    id: 'offer-1',
    namespace: 'ns-1',
    title: 'Knightica',
    description: 'Desc',
    offerType: 'BASE_GAME',
    seller: { id: 'o-1', name: 'Studio X' },
    items: [{ id: 'cat-1', namespace: 'ns-1' }],
    keyImages: [
      { type: 'Thumbnail', url: 'https://img/thumb.jpg' },
      { type: 'OfferImageWide', url: 'https://img/wide.jpg' },
    ],
    categories: [{ path: 'games' }, { path: 'freegames' }],
    offerMappings: [{ pageSlug: 'knightica-abc123', pageType: 'offer' }],
    catalogNs: { mappings: [{ pageSlug: 'knightica-home', pageType: 'productHome' }] },
    productSlug: null,
    urlSlug: '32b3e0adbe0c4399be1874958194f97f',
    price: { totalPrice: { originalPrice: 1999, discountPrice: 0, currencyCode: 'EUR', discount: 0 } },
    promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: '2026-11-12T16:00:00.000Z', endDate: '2026-11-19T16:00:00.000Z', discountSetting: { discountPercentage: 0 } }] }] },
    status: 'ACTIVE',
    ...overrides,
  };
}

const payload = (elements: RawPromotionElement[]): unknown => ({ data: { Catalog: { searchStore: { elements } } } });

describe('promotion parsing', () => {
  it('accepts only promotions that are free right now', () => {
    const parsed = parsePromotions(
      payload([
        element(),
        element({ id: 'offer-dlc', title: 'A DLC', offerType: 'ADD_ON', categories: [{ path: 'addons' }] }),
        element({
          id: 'offer-upcoming',
          title: 'Next Week',
          promotions: { upcomingPromotionalOffers: [{ promotionalOffers: [{ startDate: '2026-11-19T16:00:00.000Z', endDate: '2026-11-26T16:00:00.000Z', discountSetting: { discountPercentage: 0 } }] }] },
        }),
        element({
          id: 'offer-deal',
          title: 'Discounted Only',
          promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: '2026-11-12T16:00:00.000Z', endDate: '2026-11-19T16:00:00.000Z', discountSetting: { discountPercentage: 35 } }] }] },
        }),
        element({ id: 'offer-none', title: 'No Promotion', promotions: null }),
        element({ id: 'offer-expired', title: 'Over', promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: '2026-11-01T00:00:00.000Z', endDate: '2026-11-05T00:00:00.000Z', discountSetting: { discountPercentage: 0 } }] }] } }),
      ]),
      NOW,
    );

    expect(parsed.free.map((o) => o.title)).toEqual(['Knightica', 'A DLC']);
    expect(parsed.upcoming.map((o) => o.title)).toEqual(['Next Week']);
    expect(parsed.discounted).toBe(1);
    expect(parsed.skipped).toBe(2);
  });

  it('maps every identifier into its own field', () => {
    const offer = parsePromotions(payload([element()]), NOW).free[0]!;
    expect(offer.storeOfferId).toBe('offer-1');
    expect(offer.offerId).toBe('offer-1');
    expect(offer.catalogItemId).toBe('cat-1');
    expect(offer.namespace).toBe('ns-1');
    expect(offer.publisher).toBe('Studio X');
    expect(offer.kind).toBe('game');
    expect(offer.discountPrice).toBe(0);
    expect(offer.originalPrice).toBe(19.99);
    expect(offer.currency).toBe('EUR');
    expect(offer.imageUrl).toBe('https://img/wide.jpg');
    expect(offer.startAt).toBe('2026-11-12T16:00:00.000Z');
    expect(offer.endAt).toBe('2026-11-19T16:00:00.000Z');
  });

  it('prefers the offer page slug, then productHome, then productSlug, then urlSlug', () => {
    expect(resolvePageSlug(element())).toBe('knightica-abc123');
    expect(resolvePageSlug(element({ offerMappings: [] }))).toBe('knightica-home');
    expect(resolvePageSlug(element({ offerMappings: [], catalogNs: null, productSlug: 'real-slug' }))).toBe('real-slug');
    // opaque hex urlSlugs are not usable page slugs
    expect(resolvePageSlug(element({ offerMappings: [], catalogNs: null, productSlug: null }))).toBeNull();
    expect(resolvePageSlug(element({ offerMappings: [], catalogNs: null, productSlug: null, urlSlug: 'a'.repeat(32) }))).toBeNull();
    expect(resolvePageSlug(element({ offerMappings: [], catalogNs: null, productSlug: null, urlSlug: 'real-url-slug' }))).toBe('real-url-slug');
  });

  it('classifies add-ons and bundles', () => {
    expect(parsePromotions(payload([element({ offerType: 'ADD_ON' })]), NOW).free[0]?.kind).toBe('dlc');
    expect(parsePromotions(payload([element({ offerType: 'BUNDLE' })]), NOW).free[0]?.kind).toBe('game');
    // classification also works from categories alone (offerType missing)
    expect(parsePromotions(payload([element({ offerType: undefined, categories: [{ path: 'addons/durable' }] })]), NOW).free[0]?.kind).toBe('dlc');
    expect(parsePromotions(payload([element({ offerType: undefined, categories: [{ path: 'games/edition/base' }] })]), NOW).free[0]?.kind).toBe('game');
  });

  it('tolerates an unexpected payload shape', () => {
    expect(parsePromotions(null, NOW).free).toEqual([]);
    expect(parsePromotions({ data: {} }, NOW).free).toEqual([]);
    expect(parsePromotions({ data: { Catalog: { searchStore: { elements: 'nope' } } } }, NOW).free).toEqual([]);
  });

  it('matches an entitlement by namespace and catalog item, never by title', () => {
    const offer = parsePromotions(payload([element()]), NOW).free[0]!;
    expect(entitlementMatches([{ namespace: 'ns-1', catalogItemId: 'cat-1', entitlementName: 'something' }], offer)?.catalogItemId).toBe('cat-1');
    expect(entitlementMatches([{ namespace: 'ns-1', catalogItemId: 'other' }], offer)).toBeNull();
    expect(entitlementMatches([{ entitlementName: 'cat-1' }], offer)?.entitlementName).toBe('cat-1');
  });
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function makeProvider(handler: (call: Call) => { status?: number; body: unknown }): { provider: EpicGamesProvider; calls: Call[] } {
  const calls: Call[] = [];
  const config = configSchema.parse(defaultConfig());
  const clock = new FakeClock(NOW);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const result = handler(call);
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const auth = {
    getAccessToken: async () => ({ token: 'token-abc', accountId: 'acc-1' }),
    ensureAuthenticated: async () => undefined,
    status: async () => ({ authenticated: true, accountName: 'tester', accountId: 'acc-1', expiresAt: null, detail: 'ok' }),
  } as unknown as EpicAuthManager;

  const client = new EpicClient({ auth, getConfig: () => config, logger: new Logger('epic-test', 'error'), clock, fetchImpl });
  const provider = new EpicGamesProvider({ auth, getConfig: () => config, logger: new Logger('epic-test', 'error'), clock, fetchImpl, client });
  return { provider, calls };
}

const freeOffer = (): Offer => {
  const parsed = parsePromotions(payload([element()]), NOW).free[0]!;
  return parsed;
};

describe('epic provider', () => {
  it('reports ownership from the ownership endpoint', async () => {
    const { provider, calls } = makeProvider((call) => {
      if (call.url.includes('/ownership')) return { body: [{ namespace: 'ns-1', itemId: 'cat-1', owned: true }] };
      return { body: [] };
    });
    const result = await provider.isOwned(freeOffer());
    expect(result.owned).toBe(true);
    expect(calls[0]?.url).toContain('nsCatalogItemId=ns-1%3Acat-1');
  });

  it('falls back to the entitlement list when ownership fails', async () => {
    const { provider, calls } = makeProvider((call) => {
      if (call.url.includes('/ownership')) return { status: 500, body: { errorCode: 'boom' } };
      if (call.url.includes('/entitlements')) return { body: [{ namespace: 'ns-1', catalogItemId: 'cat-1', entitlementName: 'ent-1' }] };
      return { body: [] };
    });
    const result = await provider.isOwned(freeOffer());
    expect(result.owned).toBe(true);
    expect(result.entitlementName).toBe('ent-1');
    expect(calls.some((c) => c.url.includes('/entitlements'))).toBe(true);
  });

  it('completes the purchase-token → preview → confirm chain', async () => {
    const { provider, calls } = makeProvider((call) => {
      if (call.url.includes('quickPurchase')) return { body: { quickPurchaseStatus: 'CHECKOUT' } };
      if (call.url.includes('/payment/v1/purchaseToken')) return { body: { purchaseToken: 'pt-1' } };
      if (call.url.includes('/purchase/order-preview')) return { body: { syncToken: 'sync', offers: ['offer-1'], orderResponse: { totalPrice: 0, country: 'BE', countryName: 'Belgium' } } };
      if (call.url.includes('/purchase/confirm-order')) return { body: { confirmation: true } };
      return { body: {} };
    });

    const result = await provider.claim(freeOffer());

    expect(result.ok).toBe(true);
    const confirm = calls.find((c) => c.url.includes('confirm-order'));
    expect(confirm?.body).toMatchObject({ totalAmount: 0, syncToken: 'sync', namespace: 'ns-1' });
    expect(calls.some((c) => c.url.includes('quickPurchase'))).toBe(true);
  });

  it('aborts rather than completing an order that costs money', async () => {
    const { provider, calls } = makeProvider((call) => {
      if (call.url.includes('quickPurchase')) return { status: 400, body: { errorCode: 'nope' } };
      if (call.url.includes('/payment/v1/purchaseToken')) return { body: { purchaseToken: 'pt-1' } };
      if (call.url.includes('order-preview')) return { body: { orderResponse: { totalPrice: 999 } } };
      return { body: {} };
    });

    await expect(provider.claim(freeOffer())).rejects.toMatchObject({ code: 'OFFER_NOT_FREE' });
    expect(calls.some((c) => c.url.includes('confirm-order'))).toBe(false);
  });

  it('turns an ownership error from Epic into ALREADY_OWNED', async () => {
    const { provider } = makeProvider((call) => {
      if (call.url.includes('quickPurchase')) return { status: 400, body: { errorCode: 'errors.com.epicgames.ecommerce.owned', errorMessage: 'already own' } };
      return { status: 400, body: { errorCode: 'errors.com.epicgames.ecommerce.owned', errorMessage: 'you already own this' } };
    });
    await expect(provider.claim(freeOffer())).rejects.toMatchObject({ code: 'ALREADY_OWNED' });
  });

  it('surfaces a captcha challenge as a rejected claim with a clear message', async () => {
    const { provider } = makeProvider((call) => {
      if (call.url.includes('quickPurchase')) return { status: 400, body: { errorCode: 'x' } };
      return { status: 403, body: { errorCode: 'errors.com.epicgames.captcha', errorMessage: 'arkose challenge required' } };
    });
    await expect(provider.claim(freeOffer())).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
  });

  it('refuses to claim without an offer id or namespace', async () => {
    const { provider } = makeProvider(() => ({ body: {} }));
    const offer = { ...freeOffer(), offerId: null };
    await expect(provider.claim(offer)).rejects.toMatchObject({ code: 'CLAIM_REJECTED' });
  });
});
