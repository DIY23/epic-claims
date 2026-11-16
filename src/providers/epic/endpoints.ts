/**
 * Epic endpoints, in one place.
 *
 * Everything here except the free-promotion listing is an undocumented interface
 * reverse-engineered by the community (legendary, epicgames-client, claabs,
 * free-games-claimer). They are isolated in this module so a change on Epic's
 * side is a one-file fix, and every response is validated before use.
 *
 * Verified 16/11/2026 — see docs/epic-interface.md.
 */

export const OAUTH_HOST = 'account-public-service-prod03.ol.epicgames.com';
export const TOKEN_URL = `https://${OAUTH_HOST}/account/api/oauth/token`;
export const VERIFY_URL = `https://${OAUTH_HOST}/account/api/oauth/verify`;
export const KILL_SESSION_URL = `https://${OAUTH_HOST}/account/api/oauth/sessions/kill`;

/** Epic Games Launcher OAuth client (the launcher's own credentials). */
export const LAUNCHER_CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
export const LAUNCHER_CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';

/** Client permitted to use the device-code grant (the launcher client is not). */
export const DEVICE_CLIENT_ID = '98f7e42c2e3a4f86a74eb43fbb41ed39';
export const DEVICE_CLIENT_SECRET = '0a2449a2-001a-451e-afec-3e812901c4d7';
export const DEVICE_AUTHORIZATION_URL = `https://${OAUTH_HOST}/account/api/oauth/deviceAuthorization`;

export const WEB_LOGIN_URL = 'https://www.epicgames.com/id/login';
export const WEB_REDIRECT_URL = `https://www.epicgames.com/id/api/redirect?clientId=${LAUNCHER_CLIENT_ID}&responseType=code`;

export const FREE_GAMES_URL = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions';
export const ECOM_BASE = 'https://api.epicgames.dev/epic/ecom';
export const ENTITLEMENT_SERVICE = 'https://entitlement-public-service-prod08.ol.epicgames.com';
export const ORDER_PROCESSOR = 'https://orderprocessor-public-service-ecomprod01.ol.epicgames.com';
export const PAYMENT_SERVICE = 'https://payment-website-pci.ol.epicgames.com';
export const EULA_SERVICE = 'https://eulatracking-public-service-prod-m.ol.epicgames.com';

/** Launcher user agent — Epic's services reject some default clients. */
export const LAUNCHER_UA = 'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit';

export const EULA_KEYS = ['egstore', 'epicgames_privacy_policy_no_table'] as const;

export function storeUrl(pageSlug: string | null, locale: string): string | null {
  if (!pageSlug) return null;
  return `https://store.epicgames.com/${locale}/p/${pageSlug}`;
}
