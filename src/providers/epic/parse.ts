import type { Offer, OfferKind } from '../../shared/types.js';

/** Raw shape of one element of `data.Catalog.searchStore.elements[]`. */
export interface RawPromotionElement {
  id?: string;
  namespace?: string;
  title?: string;
  description?: string;
  offerType?: string;
  productSlug?: string | null;
  urlSlug?: string | null;
  url?: string | null;
  seller?: { id?: string; name?: string } | null;
  items?: Array<{ id?: string; namespace?: string }>;
  keyImages?: Array<{ type?: string; url?: string }>;
  categories?: Array<{ path?: string }>;
  offerMappings?: Array<{ pageSlug?: string; pageType?: string }>;
  catalogNs?: { mappings?: Array<{ pageSlug?: string; pageType?: string }> } | null;
  price?: {
    totalPrice?: {
      discountPrice?: number;
      originalPrice?: number;
      discount?: number;
      currencyCode?: string;
      fmtPrice?: { originalPrice?: string; discountPrice?: string; intermediatePrice?: string };
    };
  } | null;
  promotions?: {
    promotionalOffers?: Array<{ promotionalOffers?: Array<PromotionWindow> }>;
    upcomingPromotionalOffers?: Array<{ promotionalOffers?: Array<PromotionWindow> }>;
  } | null;
  status?: string;
  effectiveDate?: string;
  expiryDate?: string;
}

export interface PromotionWindow {
  startDate?: string;
  endDate?: string;
  discountSetting?: { discountType?: string; discountPercentage?: number };
}

export interface ParsedPromotions {
  /** Genuinely free right now (discountPercentage === 0 inside the window). */
  free: Offer[];
  /** Free later; recorded for the dashboard but never claimed early. */
  upcoming: Offer[];
  /** Elements that carried promotions but were not free. */
  discounted: number;
  /** Elements without any promotion data. */
  skipped: number;
}

function normaliseKind(element: RawPromotionElement): OfferKind {
  const type = (element.offerType ?? '').toUpperCase();
  if (type === 'BASE_GAME' || type === 'BUNDLE') return 'game';
  if (type === 'ADD_ON') return 'dlc';
  const paths = (element.categories ?? []).map((c) => (c.path ?? '').toLowerCase());
  if (paths.some((p) => p.startsWith('addons'))) return 'dlc';
  if (paths.some((p) => p.startsWith('games') || p.startsWith('applications') || p.startsWith('bundles'))) return 'game';
  return 'other';
}

/** pageSlug resolution order that works with today's payloads. */
export function resolvePageSlug(element: RawPromotionElement): string | null {
  const offerMapping = element.offerMappings?.find((m) => m.pageType === 'offer') ?? element.offerMappings?.[0];
  if (offerMapping?.pageSlug) return offerMapping.pageSlug;
  const productHome = element.catalogNs?.mappings?.find((m) => m.pageType === 'productHome');
  if (productHome?.pageSlug) return productHome.pageSlug;
  if (element.productSlug) return element.productSlug;
  if (element.urlSlug && !/^[0-9a-f]{32}$/i.test(element.urlSlug)) return element.urlSlug;
  return null;
}

function pickImage(element: RawPromotionElement): string | null {
  const preferred = ['OfferImageWide', 'OfferImageTall', 'Thumbnail', 'featuredMedia', 'heroCarouselMedia'];
  for (const type of preferred) {
    const match = element.keyImages?.find((i) => i.type === type && i.url);
    if (match?.url) return match.url;
  }
  return element.keyImages?.find((i) => i.url)?.url ?? null;
}

interface ActiveWindow {
  startDate: string;
  endDate: string;
  free: boolean;
}

function collectWindows(element: RawPromotionElement, kind: 'current' | 'upcoming'): ActiveWindow[] {
  const buckets = kind === 'current' ? element.promotions?.promotionalOffers : element.promotions?.upcomingPromotionalOffers;
  const out: ActiveWindow[] = [];
  for (const bucket of buckets ?? []) {
    for (const window of bucket.promotionalOffers ?? []) {
      if (!window.startDate || !window.endDate) continue;
      out.push({ startDate: window.startDate, endDate: window.endDate, free: window.discountSetting?.discountPercentage === 0 });
    }
  }
  return out;
}

/**
 * Converts the promotions payload into offers.
 *
 * The free test is the authoritative one used by every working claimer: a
 * promotion window that contains "now" with `discountPercentage === 0`. Price
 * alone is not trusted — a 100 % discount and a free promotion are different
 * states on Epic's side.
 */
export function parsePromotions(payload: unknown, now: Date = new Date()): ParsedPromotions {
  const result: ParsedPromotions = { free: [], upcoming: [], discounted: 0, skipped: 0 };
  const elements = (payload as { data?: { Catalog?: { searchStore?: { elements?: RawPromotionElement[] } } } })?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements)) return result;

  for (const element of elements) {
    if (!element?.id || !element.title) {
      result.skipped++;
      continue;
    }
    if (!element.promotions) {
      result.skipped++;
      continue;
    }
    const currentWindows = collectWindows(element, 'current');
    const nowMs = now.getTime();
    const activeFree = currentWindows.find((w) => w.free && Date.parse(w.startDate) <= nowMs && nowMs <= Date.parse(w.endDate));
    const upcomingFree = collectWindows(element, 'upcoming').find((w) => w.free);

    if (!activeFree && !upcomingFree) {
      const wasFreeOutsideWindow = currentWindows.some((w) => w.free);
      // A free promotion whose window has closed is not a discount, and a plain
      // discount is not free: keep them apart so the numbers mean something.
      if (!wasFreeOutsideWindow && currentWindows.length > 0) result.discounted++;
      else result.skipped++;
      continue;
    }

    const window = activeFree ?? upcomingFree!;
    const price = element.price?.totalPrice;
    const slug = resolvePageSlug(element);
    const offer: Offer = {
      store: 'epic',
      storeOfferId: element.id,
      title: element.title,
      description: (element.description ?? '').slice(0, 4000),
      publisher: element.seller?.name ?? '',
      kind: normaliseKind(element),
      namespace: element.namespace ?? element.items?.[0]?.namespace ?? null,
      offerId: element.id,
      catalogItemId: element.items?.[0]?.id ?? null,
      productSlug: element.productSlug ?? null,
      pageSlug: slug,
      url: element.url ?? (slug ? `https://store.epicgames.com/en-US/p/${slug}` : null),
      imageUrl: pickImage(element),
      originalPrice: typeof price?.originalPrice === 'number' ? price.originalPrice / 100 : null,
      discountPrice: typeof price?.discountPrice === 'number' ? price.discountPrice / 100 : null,
      currency: price?.currencyCode ?? null,
      startAt: window.startDate,
      endAt: window.endDate,
      raw: { offerType: element.offerType, categories: element.categories?.map((c) => c.path) },
    };

    if (activeFree) result.free.push(offer);
    else result.upcoming.push(offer);
  }
  return result;
}

export interface RawOwnershipEntry {
  namespace?: string;
  itemId?: string;
  owned?: boolean;
}

export interface RawEntitlement {
  id?: string;
  entitlementName?: string;
  namespace?: string;
  catalogItemId?: string;
  entitlementType?: string;
  status?: string;
  grantDate?: string;
}

/** Does an entitlement list contain this offer's catalog item? */
export function entitlementMatches(entitlements: RawEntitlement[], offer: Offer): RawEntitlement | null {
  if (!offer.namespace || !offer.catalogItemId) return null;
  return (
    entitlements.find((e) => e.namespace === offer.namespace && e.catalogItemId === offer.catalogItemId) ??
    entitlements.find((e) => e.entitlementName === offer.catalogItemId) ??
    null
  );
}
