# Epic Games Store — HTTP interface for free-promotion discovery & claiming

**Checked:** 2026-11-16, ~15:20 UTC (live probes + repo source read at HEAD).
**Purpose:** implementation-ready request/response shapes for a Node/TS CLI that lists current+upcoming free promotions and claims them for an authenticated account.

**Evidence legend**

| Tag | Meaning |
|---|---|
| `VERIFIED-LIVE` | I called the endpoint during this session and quote the real status/body. |
| `FROM-CODE` | Literal code from a named file in a named repo (file path given). |
| `UNCERTAIN` | Not directly evidenced — flagged inline, collected at the end. |

**Repos actually read** (all at HEAD on 2026-11-16):

| Repo | Files |
|---|---|
| `derrod/legendary` (Python, master) | `legendary/api/egs.py`, `legendary/core.py`, `legendary/utils/webview_login.py` |
| `vogler/free-games-claimer` (main) | `epic-games.js`, `README.md` |
| `claabs/epicgames-freegames-node` (master) | `src/common/constants.ts`, `src/puppet/free-games.ts`, `src/purchase.ts`, `src/eula-manager.ts`, `src/device-login.ts`, `src/interfaces/promotions-response.ts` |
| `SzymonLisowiec/node-epicgames-client` (npm `epicgames-client@2.0.25`) | `resources/Endpoint.js`, `src/Client/index.js`, `src/Http.js` |
| `Amrsatrio/ak47-java` (master) | `.../commands/PurchaseCommand.kt` |
| `metorial/metorial` (main) | `integrations/epic-games/src/lib/client.ts` |
| `acidicoala/dream-api` (master) | `src/mitm/addons/epic.py` |
| `AchetaGames/egs-api-rs`, `AchetaGames/Epic-Asset-Manager`, `nayetdet/gatekeeper`, `Peacock` | claim flow / route corroboration |

> Two of the three repos named in the task brief do not match their description:
> **`vogler/free-games-claimer` no longer has `egs/egs.py`** — it is a Playwright (Firefox) automation: `epic-games.js`. The raw URLs in the brief 404.
> **`claudeaizen/epic-free-games` does not exist** (GitHub API returns `404 {"message":"Not Found"}`). API-level claim code was therefore sourced from `epicgames-client`, `egs-api-rs`, `ak47-java`, `metorial` and `metroid`-style integrations instead.

---

## 1. Free promotions listing

### 1.1 Primary endpoint (works today, no auth, no UA requirement)

```
GET https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions
      ?locale=en-US&country=US&allowCountries=US
```

Both hosts serve identical bytes — `store-site-backend-static-ipv4.ak.epicgames.com` and `store-site-backend-static.ak.epicgames.com` (`VERIFIED-LIVE`: both `200`, `44,832` bytes, same 12 elements).

```ts
// claabs/epicgames-freegames-node/src/common/constants.ts:18
export const FREE_GAMES_PROMOTIONS_ENDPOINT =
  'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions';
```

Query params (`FROM-CODE`, `claabs/src/puppet/free-games.ts:116-126`):

```ts
const searchParams = { locale: 'en-US', country: 'US', allowCountries: 'US' };
const body = await this.request<PromotionsQueryResponse>('GET', FREE_GAMES_PROMOTIONS_ENDPOINT, searchParams);
```

`VERIFIED-LIVE` behaviour:
- Params are **optional** — bare URL returns the same 12 elements, priced in USD.
- `country` / `allowCountries` control **pricing + currency**, not the item set (`country=DE&allowCountries=DE` → `currencyCode: "EUR"`, same 12 titles).
- `count` / `start` are **ignored** (response `paging: {count: 40, total: 12}`). There is no pagination.
- No `User-Agent` needed: `curl` default, `curl/8.7.1`, `Mozilla/5.0` and no-UA all returned `200`. No Cloudflare on this host.

### 1.2 Response envelope and field paths

Envelope: `data.Catalog.searchStore.elements[]` (+ `data.Catalog.searchStore.paging`).

`VERIFIED-LIVE` element keys (all present on every element, 2026-11-16):

```
catalogNs, categories, customAttributes, description, effectiveDate, expiryDate, id,
isCodeRedemptionOnly, items, keyImages, namespace, offerMappings, offerType, price,
promotions, productSlug, seller, status, tags, title, url, urlSlug, viewableDate
```

| Need | JSON path | Notes |
|---|---|---|
| title | `elements[].title` | `string` |
| description | `elements[].description` | `string`, plain text, may be long/HTML-free |
| seller / publisher | `elements[].seller.name`, `elements[].seller.id` | `seller.id` is an `o-…` org id, **not** a namespace |
| offer id | `elements[].id` | 32-hex. This is the **offerId** you pass to purchase calls |
| namespace | `elements[].namespace` | 32-hex sandbox/namespace of the offer |
| catalog item id | `elements[].items[0].id` | 32-hex. This is the **catalogItemId** used for ownership/entitlements |
| product slug | `elements[].productSlug` | **frequently `null`** — see 1.4 |
| url slug | `elements[].urlSlug` | often an opaque hex (`32b3e0adbe0c4399be1874958194f97f`) |
| page slug (offer page) | `elements[].offerMappings[0].pageSlug` | `pageType: "offer"`; present on all 12 elements today |
| page slug (product page) | `elements[].catalogNs.mappings[]` where `pageType === "productHome"` → `.pageSlug` | may be absent / `null` |
| promo start | `elements[].promotions.promotionalOffers[].promotionalOffers[].startDate` | ISO-8601 Z |
| promo end | `elements[].promotions.promotionalOffers[].promotionalOffers[].endDate` | ISO-8601 Z |
| upcoming start/end | `elements[].promotions.upcomingPromotionalOffers[].promotionalOffers[]` | same inner shape |
| **is free now** | `...discountSetting.discountPercentage === 0` (with `discountType: "PERCENTAGE"`) | the only reliable free signal |
| price | `elements[].price.totalPrice.{discountPrice, originalPrice, discount, currencyCode, fmtPrice.*}` | integer minor units (`399` = $3.99), `currencyInfo.decimals` |
| item type | `elements[].offerType` ∈ `BASE_GAME` \| `ADD_ON` \| `BUNDLE` | see 1.3 |
| categories | `elements[].categories[].path` | `games`, `games/edition/base`, `addons`, `addons/durable`, `bundles`, `bundles/games`, `freegames` |
| tags | `elements[].tags[].id` | numeric strings; `9547`/`9549` appear on many promo items |
| images | `elements[].keyImages[].{type,url}` | `OfferImageWide`, `OfferImageTall`, `Thumbnail`, `featuredMedia`, `heroCarouselVideo`, `GalleryImage` |
| status | `elements[].status` | `"ACTIVE"` on all current elements |
| store URL | `https://store.epicgames.com/en-US/p/${pageSlug}` | `url` field is `null` today |

`elements[].promotions` **can be `null`** — the array includes items tagged `freegames` that are not currently promoted (verified: the "Lost Castle: The Old Ones Awaken" DLC element has `"promotions": null`). Always null-check.

There is **no `isDiscountApplicable` field** in this response (`UNCERTAIN` whether it exists in some other storefront query — it is absent from all 12 live elements and from `claabs/src/interfaces/promotions-response.ts`).

### 1.3 Base game vs DLC / add-on

Three independent discriminators, all present on the same element:

| Signal | Base game | Add-on / DLC |
|---|---|---|
| `offerType` | `BASE_GAME` (or `BUNDLE` for a bundle) | `ADD_ON` |
| `categories[].path` | `games`, `games/edition/base`, `applications`, `bundles/games` | `addons`, `addons/durable` |
| `items[]` | usually 1 element, `items[0].id` = the game's catalog item | 1 element belonging to the *base game's* namespace |

Real `ADD_ON` element (`VERIFIED-LIVE`, 2026-11-16):

```json
{
 "title": "Lost Castle: The Old Ones Awaken",
 "id": "4a88d0dc64114b20b67339c74543f859",          // offerId (DLC offer)
 "namespace": "ab29925a0a9a49598adba45d108ceb3e",
 "offerType": "ADD_ON",
 "categories": [{"path":"addons"},{"path":"freegames"},{"path":"addons/durable"}],
 "productSlug": null,
 "urlSlug": "lost-castle-the-old-ones-awaken",
 "items": [{"id":"30f2fedfe5af4e9d96e151696f372a70","namespace":"ab29925a0a9a49598adba45d108ceb3e"}],
 "catalogNs": {"mappings":[{"pageSlug":"lost-castle-abb2e2","pageType":"productHome"}]},
 "offerMappings": [{"pageSlug":"lost-castle-lost-castle-the-old-ones-awaken-db1545","pageType":"offer"}],
 "promotions": null
}
```

Note how the two mapping sources differ for a DLC: `catalogNs.mappings[productHome].pageSlug` = base game page (`lost-castle-abb2e2`), `offerMappings[0].pageSlug` = the add-on's own page. **Use `offerMappings[0].pageSlug` when you want to link/claim the specific offer; use `catalogNs` productHome only to find the base game.**

`claabs` falls back to the base game for add-ons (a DLC "requires base game"):

```ts
// claabs/src/puppet/free-games.ts:155-157
let pageSlug =
  game?.catalogNs?.mappings?.find((mapping) => mapping.pageType === 'productHome')
    ?.pageSlug ?? game.productSlug;
```

`vogler/epic-games.js:160-183` does the same via UI text: the CTA reads `get` / `in library` / **`requires base game`**, and on that path it pushes the *base game* URL into the claim queue first.

### 1.4 `pageSlug` / `productSlug` are unreliable — resolution order

`productSlug` is `null` on 8 of 12 live elements, and `urlSlug` is often opaque hex. Resolution order used by working code:

1. `offerMappings[0].pageSlug` (offer page; most specific)
2. `catalogNs.mappings[productHome].pageSlug`
3. `productSlug`
4. `urlSlug`

`vogler` records the known-bad case:

```js
// vogler/free-games-claimer/epic-games.js:151-154
// Alternative: parse the json loaded to build the page https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions
// i.e. filter data.Catalog.searchStore.elements for .promotions.promotionalOffers being set and build URL with
// .catalogNs.mappings[0].pageSlug or .urlSlug if not set to some wrong id like it was the case for spirit-of-the-north-f58a66
```

`bigu1/epic-free-games/src/epic-api.js` implements exactly that fallback chain (`productHome` mapping → `productSlug` → `urlSlug` → `id`).

### 1.5 Free-vs-discounted filtering (the trap)

Live sample, 2026-11-16 — 12 elements, only **one** currently free:

| Title | `promotions` | Result |
|---|---|---|
| Knightica | current `2026-11-12T16:00Z → 2026-11-19T16:00Z`, `discountPercentage: 0` | **free now** |
| Mark of the Deep | *upcoming* `2026-11-19T16:00Z → 2026-11-26T16:00Z`, `0` | free next week |
| Ghostrunner 2 | upcoming, `discountPercentage: 20` | 20 % off, **not free** |
| LISA: The Definitive Edition | upcoming, `55` | not free |
| Monument Valley | upcoming, `35` | not free |
| TerraScape | upcoming, `70` | not free |
| 7 others | `promotions.promotionalOffers` empty | not free |

Canonical filter (`FROM-CODE`, `claabs/src/puppet/free-games.ts:134-150`):

```ts
const freeOfferedGames = elements.filter((offer) => {
  let r = false;
  if (offer.promotions) {
    for (const innerOffers of offer.promotions.promotionalOffers) {
      for (const pOffer of innerOffers.promotionalOffers) {
        const startDate = new Date(pOffer.startDate);
        const endDate = new Date(pOffer.endDate);
        const isFree = pOffer.discountSetting.discountPercentage === 0;
        if (startDate <= nowDate && nowDate <= endDate && isFree) r = true;
      }
    }
  }
  return r;
});
```

`price.totalPrice.discountPrice === 0` is also used (`claabs`, `bigu1`) and is consistent with today's data, but it is *price state*, not *promotion state*; the `discountPercentage === 0` + date-window test is the authoritative one. Promo windows start/end on **Thursdays 16:00 UTC** (observed `2026-11-12T16:00:00.000Z`, `2026-11-19T16:00:00.000Z`).

### 1.6 GraphQL alternatives (currently unusable from a server)

Storefront persisted queries at `https://store.epicgames.com/graphql` — hashes quoted from `claabs`:

| operationName | sha256Hash | Use |
|---|---|---|
| `searchStoreQuery` | `7d58e12d9dd8cb14c84a3ff18d360bf9f0caa96bf218f2c5fda68ba88d68a437` | full catalog, filter `price.totalPrice.discountPrice === 0` |
| `getMappingByPageSlug` | `781fd69ec8116125fa8dc245c0838198cdf5283e31647d08dfa27f45ee8b1f30` | pageSlug → `{namespace, offerId}` |
| `getOffersValidation` | `3c9bb0f213f6d0cb6bf056e6b206ba166c8dd59d014618e4d59bff11689f403a` | ownership / prerequisites |
| `getCatalogOffer` | `abafd6e0aa80535c43676f533f0283c7f5214a59e9fae6ebfb37bed1b1bb2e9b` | single offer detail |

`VERIFIED-LIVE`: **both** `store.epicgames.com/graphql` and `launcher.store.epicgames.com/graphql` return **HTTP 403 with a Cloudflare challenge page** (26–28 KB HTML) for a plain HTTPS client, even with a browser UA. All four hashes above are also stale-version-dependent (`UNCERTAIN` whether they still validate). **Do not build discovery on GraphQL**; use §1.1. Reserve GraphQL for browser-context fallbacks only.

Useful field mapping if you do run `searchStoreQuery` in a browser context (`FROM-CODE`):

```ts
// claabs/src/puppet/free-games.ts:39-53
const variables = {
  allowCountries: 'US',
  category: 'games/edition/base|software/edition/base|editors|bundles/games',
  count: pageLimit, country: 'US',
  effectiveDate: onSale ? `[,${nowTimestamp}]` : undefined,
  keywords: '', locale: 'en-US', onSale: onSale ? true : undefined,
  sortBy: 'relevancy', sortDir: 'DESC', start: 0, tag: '', withPrice: true,
};
// offers are: { offerId: game.id, offerNamespace: game.namespace, productName: game.title,
//              productSlug: game.productSlug ?? game.urlSlug }
```

---

## 2. OAuth

### 2.1 Client credentials (all real, two of them verified live)

| Role | client_id | secret | Source |
|---|---|---|---|
| **EGS Launcher** (`Live-EternalKnight`) | `34a02cf8f4414e29b15921876da36f9a` | `daafbccc737745039dffe53d94fc76cf` | `legendary/api/egs.py:24-26` |
| **Web store / login redirect** | `875a3b57d3a640a6b7f9b4e883463ab4` | *(none published)* | `claabs/src/common/constants.ts:1` |
| **Device-code client** (`fortniteNewSwitchGameClient`) | `98f7e42c2e3a4f86a74eb43fbb41ed39` | `0a2449a2-001a-451e-afec-3e812901c4d7` | `claabs/src/common/config/zod.ts:821,830` |

```python
# legendary/api/egs.py:23-26
# required for the oauth request
_user_basic = '34a02cf8f4414e29b15921876da36f9a'
_pw_basic = 'daafbccc737745039dffe53d94fc76cf'
_label = 'Live-EternalKnight'
```

`VERIFIED-LIVE`: `POST …/oauth/token` with `grant_type=client_credentials&token_type=eg1` and launcher Basic auth → `200` and `{"access_token":"eg1~eyJraWQi…","expires_in":14400,"token_type":"bearer","client_id":"34a02cf8f4414e29b15921876da36f9a","internal_client":true,"client_service":"42c61cfdc3d24af5a8333b3284d47240","product_id":"42c61cfdc3d24af5a8333b3284d47240","application_id":"fghi4567KEIkE93BQjKGjnyql0oI6X1a"}`. The device client likewise returns `200`. Anonymous sessions were revoked afterwards (`DELETE …/oauth/sessions/kill/{token}` → `204`).

### 2.2 Token endpoint & grants

```
POST https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded
```

`account-public-service-prod.ol.epicgames.com` (no numeric shard) serves the same API — `claabs/src/common/constants.ts` uses it, and `VERIFIED-LIVE` `POST …/oauth/token` there returned `200` with the same launcher credentials (session revoked afterwards). `/account/api/oauth/deviceAuthorization?prompt=login` on that host returns `401 authentication_failed` unauthenticated, i.e. the route exists. Prefer `prod03` to match legendary.

| grant_type | Body fields | Notes |
|---|---|---|
| `client_credentials` | `token_type=eg1` (optional) | anonymous; 4 h token (`expires_in: 14400`) |
| `exchange_code` | `exchange_code=<code>&token_type=eg1` | the browser-session path |
| `refresh_token` | `refresh_token=<token>&token_type=eg1` | refresh token lives ~1 year |
| `authorization_code` | `code=<code>&token_type=eg1` | only for clients with a redirect URI |
| `device_code` | `device_code=<code>` | poll; pair with §2.5 |

```python
# legendary/api/egs.py:100-122
if refresh_token:
    params = dict(grant_type='refresh_token', refresh_token=refresh_token, token_type='eg1')
elif exchange_token:
    params = dict(grant_type='exchange_code', exchange_code=exchange_token, token_type='eg1')
...
r = self.session.post(f'https://{self._oauth_host}/account/api/oauth/token',
                      data=params, auth=self._oauth_basic, timeout=self.request_timeout)
```

Token response fields to persist: `access_token` (`eg1~…` JWT-ish), `expires_in`, `expires_at`, `refresh_token`, `refresh_expires`, `refresh_expires_at`, `account_id`, `displayName`, `token_type` (`bearer`), `client_id`, `internal_client`, `client_service`, `app`, `in_app_id`, `device_id`.

`VERIFIED-LIVE` error shape for a bad exchange code:

```json
{"errorCode":"errors.com.epicgames.account.oauth.exchange_code_not_found",
 "errorMessage":"Sorry the exchange code you supplied was not found. It is possible that it was no longer valid",
 "numericErrorCode":18057,"originatingService":"com.epicgames.account.public","intent":"prod",
 "error_description":"…"}
```

### 2.3 Getting an exchange code from a browser session

**Option A — JSON redirect endpoint (simplest, still live).**

```
GET https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code
Cookie: <logged-in www.epicgames.com session cookies>
```

`VERIFIED-LIVE` response contract (unauthenticated call returns all-null fields, `200`):

```json
{"warning":"Do not share this code with any 3rd party service. It allows full access to your Epic account.",
 "redirectUrl":"https://localhost/launcher/authorized",
 "authorizationCode":null,"exchangeCode":null,"sid":null}
```

With a logged-in cookie jar, `exchangeCode` (and `sid`) are populated. Feed `exchangeCode` into §2.2. Legendary wires the login form to this exact URL:

```python
# legendary/api/egs.py:62-65
def get_auth_url(self):
    login_url = 'https://www.epicgames.com/id/login?redirectUrl='
    redirect_url = f'https://www.epicgames.com/id/api/redirect?clientId={self._user_basic}&responseType=code'
    return login_url + urllib.parse.quote(redirect_url)
```

The launcher's own JS hook is what `legendary/utils/webview_login.py` intercepts — `set_exchange_code(exchange_code, param)` is bound to `window.ue.signinprompt.requestexchangecodesignin`.

**Option B — `sid` → fresh exchange code (survives logout, used by legendary when the webview keeps cookies).**

```python
# legendary/core.py:123-155 (verbatim, condensed headers)
s.cookies['EPIC_COUNTRY'] = self.country_code.upper()
# get first set of cookies (EPIC_BEARER_TOKEN etc.)
_ = s.get('https://www.epicgames.com/id/api/set-sid', params=dict(sid=sid))
# get XSRF-TOKEN and EPIC_SESSION_AP cookie
_ = s.get('https://www.epicgames.com/id/api/csrf')
# finally, get the exchange code
r = s.post('https://www.epicgames.com/id/api/exchange/generate',
           headers={'X-XSRF-TOKEN': s.cookies['XSRF-TOKEN']})
if r.status_code == 200:
    return r.json()['code']
```

Headers that flow requires (`legendary/core.py:130-140`): `X-Epic-Event-Action: login`, `X-Epic-Event-Category: login`, `X-Epic-Strategy-Flags: ''`, `X-Requested-With: XMLHttpRequest`, and the launcher UA string `…EpicGamesLauncher/{ver} UnrealEngine/4.23.0-14907503+++Portal+Release-Live Chrome/84.0.4147.38…`.

`VERIFIED-LIVE`: `GET /id/api/csrf` → `204` (sets `XSRF-TOKEN`); `POST /id/api/exchange/generate` **without** the CSRF token → `409 {"errorCode":"errors.com.epicgames.accountportal.csrf_token_invalid",…}`, confirming the header is mandatory.

**Option C — headless device code** (§2.5) — no browser, best fit for a CLI that cannot scrape cookies.

### 2.4 Web-store login redirects

```ts
// claabs/src/purchase.ts:5-12
export const generateLoginRedirect = (redirectUrl: string): string => {
  const loginRedirectUrl = new URL(ID_LOGIN_ENDPOINT);           // https://www.epicgames.com/id/login
  loginRedirectUrl.searchParams.set('noHostRedirect', 'true');
  loginRedirectUrl.searchParams.set('redirectUrl', redirectUrl);
  loginRedirectUrl.searchParams.set('client_id', EPIC_CLIENT_ID); // 875a3b57d3a640a6b7f9b4e883463ab4
  return loginRedirectUrl.toString();
};
```

### 2.5 Device-code flow (`claabs/src/device-login.ts:255-310`)

```
1) POST {ACCOUNT_OAUTH_TOKEN}                 grant_type=client_credentials   (Basic: device client)
2) POST https://account-public-service-prod.ol.epicgames.com/account/api/oauth/deviceAuthorization?prompt=login
        Authorization: bearer <client_credentials token>            -> {device_code, user_code,
                                                                       verification_uri,
                                                                       verification_uri_complete,
                                                                       expires_in, interval}
3) POST {ACCOUNT_OAUTH_TOKEN}   grant_type=device_code & device_code=…  (Basic: device client)
   poll until 200; on failure the body carries an errorCode (device_code_expired / slow_down / pending)
4) subsequent refreshes:       grant_type=refresh_token & refresh_token=…
```

Note the grant is **`device_code`**, not `device_auth`. `claabs` defaults to the `fortniteNewSwitchGameClient` pair (§2.1) because that client is permitted to use the device flow; the launcher client is not.

---

## 3. Ownership / entitlement check

Route map I established by probing (unauthenticated / anon-token → `401` = route exists, `404` = no such route; `VERIFIED-LIVE`):

| Method | Path | Result |
|---|---|---|
| GET | `/epic/ecom/v1/identities/{id}/entitlements` | `401` authentication_failed → **exists** |
| GET | `/epic/ecom/v3/identities/{id}/entitlements?sandboxId=` | `401` → exists |
| GET | `/epic/ecom/v4/identities/{id}/entitlements?sandboxId=` | `401` → exists |
| GET | `/epic/ecom/v2/identities/{id}/entitlements` | `404` → gone |
| GET | `/epic/ecom/v5/identities/{id}/entitlements` | `404` → does not exist |
| GET | `/epic/ecom/v1/identities/{id}/namespaces/{ns}/offers` | `401` → exists |
| GET | `/epic/ecom/v1\|v3/platforms/EPIC/identities/{id}/ownership?nsCatalogItemId=` | `401` → exists |
| GET | `/epic/ecom/v1/platforms/EPIC/identities/{id}/entitlements` | **`404`** → **wrong path, does not exist** |
| PUT | `/epic/ecom/v1\|v3/identities/{id}/entitlements/redeem` | `401` → exists |
| POST | `/epic/ecom/v1/identities/{id}/entitlements[/redeem]` | `405` method_not_allowed → path exists, wrong verb |
| POST | `/epic/ecom/v1/identities/{id}/orders`, `/checkout` | `404` → do not exist |

⚠️ The URL in the task brief — `api.epicgames.dev/epic/ecom/v1/platforms/EPIC/identities/{accountId}/entitlements` — **404s**. `platforms/EPIC` belongs on `ownership`, not `entitlements`.

All these live under the service base URL published by Epic's own SDK config:

```json
// https://api.epicgames.dev/sdk/v1/default  ->  services
"EcommerceEpicIdService": {"BaseUrl": "https://api.epicgames.dev/epic/ecom"},
"EcommerceService":       {"BaseUrl": "https://ecommerceintegration-public-service-ecomprod02.ol.epicgames.com/ecommerceintegration"}
```

### 3.1 Launcher-side entitlement list (simplest "what do I own")

```
GET https://entitlement-public-service-prod08.ol.epicgames.com/entitlement/api/account/{accountId}/entitlements?start=0&count=1000
Authorization: bearer eg1~…
```

```python
# legendary/api/egs.py:193-209
def get_user_entitlements(self, start=0):
    user_id = self.user.get('account_id')
    r = self.session.get(f'https://{self._entitlements_host}/entitlement/api/account/{user_id}/entitlements',
                         params=dict(start=start, count=1000), timeout=self.request_timeout)
...
def get_user_entitlements_full(self):
    while True:
        resp = self.get_user_entitlements(start=len(ret))
        ret.extend(resp)
        if len(resp) < 1000: break
```

- Response is a **bare JSON array** (no envelope, no total count) — paginate by `start += len(page)` until a page is shorter than `count`.
- `VERIFIED-LIVE`: with an anonymous `eg1` token → `403 {"errorCode":"errors.com.epicgames.common.missing_permission","errorMessage":"Sorry your login does not posses the permissions 'entitlement:account:{id}:entitlements READ' …"}`. Confirms route + required scope.
- Also live on `entitlement-public-service-prod.ol.epicgames.com` (`401`), same path.

### 3.2 EOS Ecom entitlement query (per-sandbox, documented API)

```
GET https://api.epicgames.dev/epic/ecom/v4/identities/{accountId}/entitlements
      ?sandboxId={namespace}
      &entitlementName={name}          # repeatable / array
      &includeRedeemed=true|false
Authorization: bearer <EOS|eg1 token>
```

```ts
// metorial/metorial integrations/epic-games/src/lib/client.ts:530-548
const response = await this.http.request(
  'GET',
  `/epic/ecom/v4/identities/${segment(accountId)}/entitlements`,
  { params: pickDefined({ sandboxId, entitlementName: entitlementNames, includeRedeemed }) }
);
```

`v3` takes the same shape (both `401` live). The older `v1` + legacy host are what the launcher used, per `dream-api`'s MITM matchers:

```python
# acidicoala/dream-api src/mitm/addons/epic.py:119-131
if BaseAddon.host_and_path_match(flow, host=EpicAddon.ecom_host,
        path=r"^/ecommerceintegration/api/public/v2/identities/\w+/entitlements$") \
or BaseAddon.host_and_path_match(flow, host=EpicAddon.api_host,
        path=r"^/epic/ecom/v1/identities/\w+/entitlements"):
    ...
    sandbox_id = parse_qs(url.query)['sandboxId'][0]
    entitlementNames = parse_qs(url.query)['entitlementName']
```

### 3.3 Ownership check (fast path, no paging)

```
GET https://api.epicgames.dev/epic/ecom/v3/platforms/EPIC/identities/{accountId}/ownership
      ?nsCatalogItemId={namespace}:{catalogItemId}&nsCatalogItemId={namespace}:{catalogItemId}…
      # or, instead of the ids:  &sandboxId={namespace}
Authorization: bearer …
```

```ts
// metorial …/client.ts:505-517
const response = await this.http.request(
  'GET',
  `/epic/ecom/v3/platforms/EPIC/identities/${segment(accountId)}/ownership`,
  { params: pickDefined({ nsCatalogItemId: nsCatalogItemIds, sandboxId }) }
);
// response: [{ namespace, itemId, owned }]  (validated client-side: ids must be "sandboxId:catalogItemId",
// batch ≤ 100)
```

`dream-api` documents current-vs-legacy for the same call (`src/mitm/addons/epic.py:83-95`):

```python
if BaseAddon.host_and_path_match(flow, host=EpicAddon.api_host,
        path=r"^/epic/ecom/v1/platforms/EPIC/identities/\w+/ownership$"):
    param_string = 'nsCatalogItemId'      # Current endpoint
elif BaseAddon.host_and_path_match(flow, host=EpicAddon.ecom_host,
        path=r"^/ecommerceintegration/api/public/platforms/EPIC/identities/\w+/ownership$"):
    param_string = 'nsItemId'             # Legacy endpoint
```

### 3.4 Mapping a free offer → an owned entitlement

Three distinct identifiers, do not conflate them:

| Identifier | Comes from | Used for |
|---|---|---|
| **offerId** | `elements[].id` (promotions response), `promotionsOffers…` | purchase/claim (`lineOffers[].offerId`, `offers[]`) |
| **catalogItemId** | `elements[].items[0].id` | ownership (`nsCatalogItemId = "{namespace}:{catalogItemId}"`), entitlement join |
| **entitlementName** | `entitlements[].entitlementName` | EOS `entitlementName` filter |

Join rule that is consistent across `legendary`, `dream-api` and `metorial`: match on **`entitlement.namespace === element.namespace && entitlement.catalogItemId === element.items[].id`** (optionally also `entitlementName` contains the catalog item id). `entitlementName` is *not* guaranteed to equal the catalog item id (`UNCERTAIN` — no repo I read asserts a formula; `dream-api` only uses it as a query filter).

Entitlement object shape (`FROM-CODE`, `dream-api` TypedDict + `metorial` zod schema agree):

```ts
// metorial …/lib/types.ts:69-80
{ id, entitlementName, namespace, catalogItemId, entitlementType,
  grantDate, consumable, status, useCount, entitlementSource? }
```

`entitlementType` values seen in the wild: `EXECUTABLE`, `ENTITLEMENT`, `GAME_CODE`… (`UNCERTAIN` for the full set). `status` is typically `ACTIVE`.

Third-party "is it already claimed" shortcut used by `claabs` (GraphQL, browser-only today): `getOffersValidation` → `data.Entitlements.cartOffersValidation.{missingPrerequisites, conflictingOffers, fullyOwnedOffers, unablePartiallyUpgradeOffers}`; any non-empty array ⇒ not claimable.

---

## 4. Claim / redemption

### 4.1 `quickPurchase` — keep for compatibility, but it now dead-ends

```
POST https://orderprocessor-public-service-ecomprod01.ol.epicgames.com/orderprocessor/api/shared/accounts/{accountId}/orders/quickPurchase?country=US&locale=en-US
Authorization: bearer eg1~…
Content-Type: application/json

{
  "salesChannel": "Launcher-purchase-client",
  "entitlementSource": "Launcher-purchase-client",
  "returnSplitPaymentItems": false,
  "lineOffers": [ { "offerId": "<elements[].id>", "quantity": 1, "namespace": "<elements[].namespace>" } ]
}
```

`FROM-CODE`, `epicgames-client` `src/Client/index.js:545-581` and `AchetaGames/egs-api-rs` `src/api/commerce.rs` (identical body). Endpoint constant:

```js
// SzymonLisowiec/node-epicgames-client resources/Endpoint.js:6
ORDER_QUICKPURCHASE:
  'https://orderprocessor-public-service-ecomprod01.ol.epicgames.com/orderprocessor/api/shared/accounts/{{account_id}}/orders/quickPurchase', // ?country=PL&locale=pl
```

`VERIFIED-LIVE`: `401 authentication_failed` for `POST …/orders/quickPurchase` (route alive), and Epic's SDK config still advertises `PurchaseUrl: https://launcher-website-prod07.ol.epicgames.com/purchase`.

**Current behaviour is the catch.** `ak47-java` (2025-era, Fortnite store) comments out exactly this call:

```kotlin
// Amrsatrio/ak47-java …/PurchaseCommand.kt:277-302
// Quick purchase API no longer works
/*val quickPurchasePayload = JsonObject().apply { … "salesChannel","entitlementSource","returnSplitPaymentItems","lineOffers" … }
  val response = … .url("https://orderprocessor-…/orders/quickPurchase") … */
// Response is always {"quickPurchaseStatus":"CHECKOUT"}
```

`AchetaGames/Epic-Asset-Manager/docs/api-map.md` documents the same: `POST /accounts/{accountId}/orders/quickPurchase?country={cc}&locale={l}` → `{quickPurchaseStatus: "CHECKOUT"}`.

So treat the response tri-state as designed-but-unreliable:

```js
// epicgames-client src/Client/index.js:652-676
const quickPurchaseStatus = await this.quickPurchase(offer, quantity);
switch (quickPurchaseStatus) {
  case 'SUCCESS': return true;
  case 'CHECKOUT': {
    const purchase = await this.newPurchase(offer);
    if (!purchase || !purchase.token) throw new Error('Unable to acquire purchase token');
    const order = await this.purchaseOrderPreview(purchase, offer);
    if (!order) return false;
    return this.purchaseOrderConfirm(purchase, order);
  }
  default: throw new Error(`Unknown quick purchase status: ${quickPurchaseStatus}`);
}
```

### 4.2 The working claim chain: purchase token → order-preview → confirm-order

This is what actually completes a $0 order (used by `epicgames-client`, `ak47-java`, `claabs` via browser, `gatekeeper` via response-sniffing).

**Step 1a — purchase token from the launcher purchase page (store offers; cookie session)**

```
GET https://launcher-website-prod07.ol.epicgames.com/purchase?showNavigation=true&namespace={namespace}&offers={offerId}
Cookie: <launcher/www session>
→ HTML containing <input id="purchaseToken" value="…">
```

```js
// epicgames-client src/Client/index.js:583-590
async newPurchase(offer) {
  let { data: purchase } = await this.http.sendGet(
    `https://launcher-website-prod07.ol.epicgames.com/purchase?showNavigation=true&namespace=${offer.namespace}&offers=${offer.id}`);
  purchase = Cheerio.load(purchase);
  const token = purchase('#purchaseToken').val();
  return { token };
}
```

`VERIFIED-LIVE`: unauthenticated → `302 Found. Redirecting to /login?state=%2Fpurchase-login%3FshowNavigation%3Dtrue%26namespace%3Dabc%26offers%3Ddef%26attemptLogin%3Dtrue` (route alive; needs session).

**Step 1b — purchase token from the payment API (bearer instead of cookies)**

```
POST https://payment-website-pci.ol.epicgames.com/payment/v1/purchaseToken
Authorization: bearer eg1~…
Content-Type: application/json

{ "locale": "", "offers": ["<offerId>"], "subscriptionSlug": "", "namespace": "<namespace>" }
→ { "purchaseToken": "…" }
```

```kotlin
// Amrsatrio/ak47-java …/PurchaseCommand.kt:394-410 (generatePurchaseToken)
val purchaseTokenPayload = JsonObject().apply {
    addProperty("locale", "")
    add("offers", JsonArray().apply { add(offerId) })
    addProperty("subscriptionSlug", "")
    addProperty("namespace", "fn")            // <-- their namespace; substitute yours
}
// POST https://payment-website-pci.ol.epicgames.com/payment/v1/purchaseToken
```

`VERIFIED-LIVE`: `POST /payment/v1/purchaseToken` unauthenticated → `401 {"errorCode":"errors.com.epicgames.ecommerce.paymentweb.unauthorize",…,"error":true}` — route alive, bearer required.

**Step 2 — order preview**

```
POST https://payment-website-pci.ol.epicgames.com/purchase/order-preview
Authorization: bearer eg1~…
Content-Type: application/json
x-requested-with: <purchaseToken>

{
  "useDefault": true, "setDefault": false,
  "namespace": "<namespace>",
  "country": null, "countryName": null,
  "orderId": null, "orderComplete": null, "orderError": null, "orderPending": null,
  "offers": ["<offerId>"],
  "offerPrice": ""
}
→ { syncToken, namespace, country, countryName, offers: [...], orderResponse: { totalPrice: 0, ... } }
```

**Step 3 — confirm order (this is the claim)**

```
POST https://payment-website-pci.ol.epicgames.com/purchase/confirm-order
Authorization: bearer eg1~…
Content-Type: application/json
x-requested-with: <purchaseToken>

{
  "useDefault": true, "setDefault": false,
  "namespace": "<namespace>",
  "country": "<from preview>", "countryName": "<from preview>",
  "orderId": null, "orderComplete": null, "orderError": null, "orderPending": null,
  "offers": [...from preview...],
  "includeAccountBalance": false,
  "totalAmount": <orderResponse.totalPrice>,
  "affiliateId": "", "creatorSource": "",
  "syncToken": "<from preview>"
}
→ { "confirmation": true, ... }
```

Both are quoted verbatim from `epicgames-client src/Client/index.js:592-650`; `ak47-java …/PurchaseCommand.kt:320-355` builds the identical bodies (it reads `totalAmount` from `orderResponse.totalPrice` and asserts `confirmation == true`).

`VERIFIED-LIVE`: `POST /purchase/order-preview` and `POST /purchase/confirm-order` both return `401` (HTML error page) unauthenticated → routes alive. `gatekeeper` treats a successful **`POST …/v2/purchase/confirm-order`** as the canonical success signal (`src/gatekeeper/events/claim_events.py:28`), i.e. a `/v2/` variant of the same path is in use by the web checkout today (`UNCERTAIN` whether `/purchase/v2/confirm-order` requires different fields — not exercised).

Success/failure signals to check rather than guess: `confirmation === true` on confirm-order, then re-read entitlements (§3.1/3.2) or `getCatalogOffer`/store page ("In library").

### 4.3 Official EOS redeem (different concept — do not confuse with claiming)

```
PUT https://api.epicgames.dev/epic/ecom/v3/identities/{accountId}/entitlements/redeem
Authorization: bearer …            # EOS client token / account token
Content-Type: application/json

{ "entitlementIds": ["<entitlements[].id>"], "sandboxId": "<namespace>" }
→ 200 / 204
```

```ts
// metorial …/client.ts:556-566
const response = await this.http.request('PUT',
  `/epic/ecom/v3/identities/${segment(accountId)}/entitlements/redeem`,
  { data: { entitlementIds, sandboxId }, statuses: [200, 204] });
```

This calls `EOS_Ecom_RedeemEntitlements`, which redeems **already-granted, redeemable** entitlements (max 32 ids per the SDK header) — it does **not** purchase a store promotion. It is the right call only if your account was granted a promo entitlement that is sitting unredeemed (`entitlement.status`/`consumable`). `VERIFIED-LIVE`: `PUT` on `v1` and `v3` → `401` (route exists); `POST` → `405`; `v5` → `404`.

### 4.4 Prerequisites before a claim can succeed

1. **EULA acceptance** — `claabs/src/eula-manager.ts:78-108`:
   ```
   GET  https://eulatracking-public-service-prod-m.ol.epicgames.com/eulatracking/api/public/agreements/{key}/account/{accountId}
   POST https://eulatracking-public-service-prod-m.ol.epicgames.com/eulatracking/api/public/agreements/{key}/version/{version}/account/{accountId}/accept?locale={locale}
   keys: ['epicgames_privacy_policy_no_table', 'egstore']
   ```
   `VERIFIED-LIVE`: `403 missing_permission 'eulatracking:public:displayagreement:{id} READ'` for an anonymous token → route + scope confirmed.
2. **Base game for DLC** — an `ADD_ON` claim fails without the base game (`vogler/epic-games.js:160-183`, CTA text `requires base game`). Claim the base game offer first.
3. **Region availability** — the offer's `countriesBlacklist` (GraphQL `getCatalogOffer`) / UI `unavailable in your region`. The promotions endpoint already filters by `allowCountries`, but a mismatch between `allowCountries` and the account's country yields a claim failure, not a listing failure.
4. **Age gate / mature content** for 18+ titles (browser flow sets a DOB cookie; API flow generally doesn't need it — `UNCERTAIN`).
5. **Captcha** — Epic fronts purchase with Talon/Arkose (`arkoselabs`, `talon-service-prod.ak.epicgames.com` in `claabs/src/common/constants.ts`). `vogler` README: "This currently gives you a captcha challenge for epic-games" and its claimer handles a captcha by notifying and skipping. A pure-HTTP claimer must expect intermittent `403`/challenge on the payment endpoints (`UNCERTAIN` exact challenge response body for the JSON API — never observed in code, only browser-side).

---

## 5. Rate limits, headers, error codes

### 5.1 Documented rate limits (from Epic's own SDK config)

`GET https://api.epicgames.dev/sdk/v1/default` (`VERIFIED-LIVE`, `200`, 21,463 bytes) — this is what the EOS SDK itself uses:

```json
"BaseService": { "HttpRetryLimit": 4, "HttpRetryResponseCodes": [429, 503, 504] },
"RateLimiter.EComClient": { "MessageCount": 300, "TimeIntervalInSeconds": 60.0 },
"RateLimiter.EComClient.Operations": {
  "MessageCount": 300, "TimeIntervalInSeconds": 60.0,
  "Operation": ["QueryOwnership","QueryOwnershipToken","QueryEntitlement","QueryOffer",
                "RedeemEntitlements","Checkout","QueryEntitlementToken"] },
"RateLimiter.AuthClient": { "MessageCount": 300, "TimeIntervalInSeconds": 60.0 },
"RateLimiter.AuthClient.SensitiveOperations": { "MessageCount": 12, "TimeIntervalInSeconds": 60.0,
  "Operation": ["GenerateUserAuth"] },
"HTTP": { "HttpTimeout": 30, "HttpConnectionTimeout": 60, "HttpReceiveTimeout": 30 }
```

⇒ 300 ecom calls/min, retry `429/503/504` up to 4× with backoff. The `account-public-service` (launcher OAuth) and `orderprocessor` publish no limits; community tooling treats them as heavily throttled and claims sequentially with human-ish delays (`vogler` clicks with a deliberate `delay: 11` ms and never parallelizes across accounts).

### 5.2 Headers per call

| Call | Headers that matter |
|---|---|
| `freeGamesPromotions` | none (UA optional) |
| `account/api/oauth/token` | `Authorization: Basic …`, `Content-Type: application/x-www-form-urlencoded` |
| `id/api/set-sid`, `id/api/csrf`, `id/api/exchange/generate` | Cookie jar, `X-XSRF-TOKEN`, `X-Requested-With: XMLHttpRequest`, `X-Epic-Event-Action: login`, `X-Epic-Event-Category: login`, `X-Epic-Strategy-Flags: ''`, launcher-browser UA |
| `entitlement-public-service`, `api.epicgames.dev/epic/ecom/*`, `orderprocessor` | `Authorization: bearer eg1~…` |
| `purchase/order-preview`, `purchase/confirm-order`, `payment/v1/purchaseToken` | `Authorization: bearer …`, `Content-Type: application/json`, **`x-requested-with: <purchaseToken>`** |

**User-Agent:** launcher-side calls send a launcher UA. `legendary` default:

```python
# legendary/api/egs.py:21-22
_user_agent = 'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit'
_store_user_agent = 'EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live'
```

`epicgames-client` sends `EpicGamesLauncher/{build} {os}` (e.g. `EpicGamesLauncher/11.0.1 Windows/10.0.19041.1.256.64bit`). The payment endpoints in `ak47-java` send a plain Chrome UA (`…Chrome/96.0.4664.110…`).

**Device fingerprint (`X-Epic-Device-*`, `X-Epic-Correlation-ID`, `X-Epic-Strategy-Flags`):** none of the reviewed API-based clients send any device-fingerprint header for these calls — `legendary`, `epicgames-client`, `egs-api-rs`, `metorial`, `dream-api` rely on bearer/basic auth + UA only. `X-Epic-Strategy-Flags` appears **only** in the `www.epicgames.com/id/api/*` web-session flow (§2.3). Treat any claim that device headers are mandatory as `UNCERTAIN` — no evidence in working code.

### 5.3 Error codes observed live (2026-11-16)

| HTTP | `errorCode` | `numericErrorCode` | Where |
|---|---|---|---|
| 400 | `errors.com.epicgames.account.oauth.exchange_code_not_found` | 18057 | `oauth/token` `grant_type=exchange_code`, bad code |
| 401 | `errors.com.epicgames.common.authentication.authentication_failed` | 1032 | all `api.epicgames.dev/epic/ecom/*`, entitlement host, orderprocessor, `oauth/deviceAuthorization` |
| 401 | `errors.com.epicgames.ecommerce.paymentweb.unauthorize` | — | `payment-website-pci…/payment/v1/purchaseToken` without bearer |
| 403 | `errors.com.epicgames.common.missing_permission` | — | entitlement list, EULA, when token lacks `entitlement:account:{id}:entitlements READ` / `eulatracking:public:displayagreement:{id} READ` |
| 403 | *(Cloudflare HTML, not JSON)* | — | `store.epicgames.com/graphql`, `launcher.store.epicgames.com/graphql` |
| 404 | `errors.com.epicgames.common.not_found` | 1004 | wrong path / unknown account on ecom routes |
| 405 | `errors.com.epicgames.common.method_not_allowed` | — | wrong verb on a known ecom path |
| 409 | `errors.com.epicgames.accountportal.csrf_token_invalid` | — | `id/api/exchange/generate` without `X-XSRF-TOKEN` |
| 429 | *(not observed)* | — | documented retry case in Epic SDK config; back off per §5.1 |

Additional codes named in code:

```python
# legendary/api/egs.py:129-134
if j['errorCode'] == 'errors.com.epicgames.oauth.corrective_action_required':
    self.log.error(f'{j["errorMessage"]} ({j["correctiveAction"]}), '
                   f'open the following URL to take action: {j["continuationUrl"]}')
```

```js
// epicgames-client src/Http.js:88-96
case 'errors.com.epicgames.common.oauth.invalid_token': reject(new Error("You aren't logged in!")); break;
```

`errors.com.epicgames.oauth.corrective_action_required` carries `correctiveAction` + `continuationUrl` — surface that URL to the user (account needs a manual step, e.g. parental consent / account merge).

---

## 6. Official vs undocumented

| Surface | Status | Evidence |
|---|---|---|
| `GET /epic/ecom/v{1,3,4}/identities/{id}/entitlements` | **Official** — EOS Ecom Web API (`QueryEntitlement`) | service base URL published in `api.epicgames.dev/sdk/v1/default`; listed as `QueryEntitlement` in `RateLimiter.EComClient.Operations`; docs at `dev.epicgames.dev/docs/web-api-ref/ecom-web-apis` (could not be fetched from this network — DNS NXDOMAIN) |
| `GET /epic/ecom/v{1,3}/platforms/EPIC/identities/{id}/ownership` | **Official** (`QueryOwnership`) | same config; `EOS_Ecom_QueryOwnership` mirrors it |
| `PUT /epic/ecom/v{1,3}/identities/{id}/entitlements/redeem` | **Official** (`RedeemEntitlements`) | same config; `EOS_Ecom_RedeemEntitlements` in `citizenfx/fivem` SDK headers, `MAX_IDS 32` |
| `GET /epic/ecom/v1/identities/{id}/namespaces/{ns}/offers` | **Official** (`QueryOffer`) | route `401`; `QueryOffer` in SDK op list |
| `POST /epic/ecom/.../checkout`, `.../orders` | **Not present** — 404 | live probe |
| `account-public-service` OAuth (`/account/api/oauth/token`, `verify`, `exchange`, `sessions/kill`, `deviceAuthorization`) | **Undocumented** (launcher client internals; widely reverse-engineered) | not in any public API reference; only in `legendary`/`epicgames-client` |
| `www.epicgames.com/id/api/*` (login, redirect, set-sid, csrf, exchange/generate) | **Undocumented** (web app internals) | only in `legendary` + `claabs` |
| `orderprocessor-public-service…/orders/quickPurchase` | **Undocumented** (launcher order processor) | only in `epicgames-client`, `egs-api-rs`, `ak47-java`, `Epic-Asset-Manager` docs |
| `payment-website-pci.ol.epicgames.com/purchase/{order-preview,confirm-order}` + `/payment/v1/purchaseToken` | **Undocumented** (checkout SPA backend) | only in `epicgames-client`, `ak47-java`, `claabs` constants, `gatekeeper` |
| `launcher-website-prod07.ol.epicgames.com/purchase` | **Undocumented** | `PurchaseUrl` in Epic SDK config *is* published, but the token-in-HTML contract is reverse-engineered |
| `entitlement-public-service…/entitlement/api/account/{id}/entitlements` | **Undocumented** (launcher entitlement service); superseded by EOS ecom | live `403` with scope `entitlement:account:{id}:entitlements READ`; only in `legendary`/`epicgames-client` |
| `store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions` | **Undocumented** but de-facto public (used by RSSHub, RSS-Bridge, every claimer) | §1.1 |
| `store.epicgames.com/graphql` persisted queries | **Undocumented**, hash-versioned, Cloudflare-protected | §1.6 |

Practical consequence: only §3.2/3.3/4.3 are contract-stable. Everything in §1.1 and §4.2 can change without notice — code for it defensively (`claabs` and `vogler` both carry version-skew workarounds: "Older CMS product lookup strategy" vs "Newer catalog lookup strategy", `v4` vs `v1` entitlements).

---

## 7. Minimal implementation sequence

```text
DISCOVER
  GET freeGamesPromotions?locale&country&allowCountries          (no auth)
  for each element with promotions != null:
      free_now  = any(promotionalOffers[].promotionalOffers[] where
                      discountPercentage==0 and start<=now<=end)
      upcoming  = any(upcomingPromotionalOffers[] … discountPercentage==0)
      kind      = element.offerType           // BASE_GAME | ADD_ON | BUNDLE
      offerId   = element.id
      namespace = element.namespace
      itemId    = element.items[0].id
      pageSlug  = element.offerMappings?.[0]?.pageSlug
                  ?? element.catalogNs?.mappings?.find(m=>m.pageType=='productHome')?.pageSlug
                  ?? element.productSlug ?? element.urlSlug

AUTH
  (a) exchange code from browser → POST oauth/token grant_type=exchange_code  (Basic: launcher)
  (b) or device code: client_credentials → deviceAuthorization → poll device_code
  keep {access_token, refresh_token, account_id}; refresh with grant_type=refresh_token

OWNERSHIP
  GET /epic/ecom/v3/platforms/EPIC/identities/{accountId}/ownership?nsCatalogItemId={ns}:{itemId}
  (fallback: GET entitlement-public-service…/account/{accountId}/entitlements?start&count
   and join on namespace + catalogItemId)

EULA (once)
  GET  eulatracking…/agreements/{key}/account/{accountId}   keys: egstore,
       epicgames_privacy_policy_no_table
  POST eulatracking…/agreements/{key}/version/{v}/account/{accountId}/accept?locale=

CLAIM  (per offer, sequential, exponential backoff on 429/503/504)
  1. POST payment-website-pci…/payment/v1/purchaseToken   {locale:"",offers:[offerId],
                                                           subscriptionSlug:"",namespace}
     (or GET launcher-website-prod07…/purchase?showNavigation=true&namespace&offers → #purchaseToken)
  2. POST payment-website-pci…/purchase/order-preview     x-requested-with: <token>
  3. POST payment-website-pci…/purchase/confirm-order     x-requested-with: <token>
     require confirmation === true
VERIFY
  re-query ownership/entitlements for {ns}:{itemId}; treat owned==true as success
```

Notes for the CLI design:
- Do **not** trust `quickPurchase` alone; always fall through to steps 1–3 when the status is anything but `SUCCESS`.
- Discovery needs no credentials — run it before login so the user sees what is available.
- `ADD_ON` items: claim the base game first (resolve it via `catalogNs.mappings[productHome].pageSlug`, then re-run discovery/`getCatalogOffer` to get *that* offer's id).
- Keep `offerId`, `catalogItemId`, `entitlementName` in separate fields with distinct types in your model; conflating them is the most common bug in these repos.

---

## 8. UNCERTAIN items

1. Whether `POST /purchase/v2/confirm-order` (as matched by `gatekeeper`) takes the same body as `/purchase/confirm-order`; no code exercises `/v2/` field-for-field.
2. Whether `POST /payment/v1/purchaseToken` works for **non-Fortnite** store offers (all quoted evidence uses `namespace: "fn"`); the launcher-page `#purchaseToken` route is the store-evidenced one.
3. Exact `entitlementName` derivation from catalog item id — no repo asserts a formula; join on `namespace` + `catalogItemId` instead.
4. Whether `price.totalPrice.discountPrice === 0` can be true outside a free promotion window (I only observed it consistent with `discountPercentage === 0` + date window on 2026-11-16). Use the promotion window as primary.
5. `isDiscountApplicable` does not exist in this response; unclear which (if any) API exposes it — I did not find it in any repo or live payload.
6. Whether the four `claabs` persisted-query hashes still validate — `store.epicgames.com/graphql` is Cloudflare-403 for non-browser clients, so I could not test them.
7. `dev.epicgames.dev` (official Ecom docs) is DNS-blocked from this host; the official/undocumented classification of the `api.epicgames.dev/epic/ecom/*` paths rests on Epic's own SDK config (`/sdk/v1/default`) plus that host being the public EOS gateway, not on a fetched doc page.
8. Whether `PUT .../entitlements/redeem` is ever the *correct* call for a weekly free-game claim (it redeems pre-granted entitlements); semantically it looks wrong for a store promotion, but the route is live and official.
9. Exact response body/status when a claim trips the Talon/Arkose captcha over plain HTTP — only browser-side evidence exists.
