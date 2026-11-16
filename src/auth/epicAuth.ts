import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import { AppError, errorMessage, toAppError } from '../shared/errors.js';
import { httpJson } from '../shared/http.js';
import type { Config } from '../config/schema.js';
import type { Repositories } from '../db/repositories.js';
import type { AuthStatus } from '../providers/provider.js';
import { ACCOUNT_EPIC_SESSION, type KeychainBackend } from './keychain.js';
import { LAUNCHER_CLIENT_ID, LAUNCHER_CLIENT_SECRET, TOKEN_URL, VERIFY_URL, KILL_SESSION_URL, WEB_LOGIN_URL, WEB_REDIRECT_URL } from '../providers/epic/endpoints.js';

export interface EpicSession {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  accountId: string;
  displayName: string;
  /** ISO timestamps. */
  expiresAt: string;
  refreshExpiresAt: string | null;
  scope: string | null;
  obtainedAt: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: string;
  refresh_expires_at?: string;
  account_id?: string;
  display_name?: string;
  scope?: string;
  errorCode?: string;
  errorMessage?: string;
  numericErrorCode?: number;
  correctiveAction?: string;
  continuationUrl?: string;
}

export interface EpicAuthDeps {
  keychain: KeychainBackend;
  clock: Clock;
  logger: Logger;
  getConfig: () => Config;
  repos: Repositories;
  fetchImpl?: typeof fetch;
  /** Directory for the persistent browser profile. */
  dataDir?: string;
}

function basicAuth(): string {
  return `Basic ${Buffer.from(`${LAUNCHER_CLIENT_ID}:${LAUNCHER_CLIENT_SECRET}`).toString('base64')}`;
}

/** Maps Epic's error codes onto the application's error codes. */
export function mapEpicAuthError(body: TokenResponse | null, status: number): AppError {
  const code = body?.errorCode ?? '';
  const message = body?.errorMessage ?? `HTTP ${status}`;
  if (code.includes('corrective_action_required')) {
    return new AppError('AUTH_FAILED', `${message} — open ${body?.continuationUrl ?? 'the Epic account page'} to resolve it`, {
      correctiveAction: body?.correctiveAction,
      continuationUrl: body?.continuationUrl,
    });
  }
  if (code.includes('exchange_code_not_found') || code.includes('invalid_grant') || code.includes('invalid_refresh')) {
    return new AppError('AUTH_EXPIRED', `the Epic session can no longer be refreshed (${code || status}) — sign in again`);
  }
  if (status === 401 || code.includes('authentication_failed')) return new AppError('AUTH_EXPIRED', `Epic rejected the session (${code || status})`);
  return new AppError('AUTH_FAILED', `${message} (${code || status})`, { status, code });
}

/**
 * Epic authentication.
 *
 * Design:
 *  - the browser is used exactly once, interactively, to obtain an exchange code
 *    (2FA, captcha and consent are left to the user — nothing is bypassed)
 *  - the resulting refresh token is stored in the macOS Keychain and refreshes
 *    the session silently for up to a year
 *  - a failed refresh never silently degrades: it surfaces AUTH_EXPIRED and the
 *    notification/UI path asks for a human
 */
export class EpicAuthManager {
  private cached: EpicSession | null = null;
  private refreshing: Promise<EpicSession> | null = null;

  constructor(private readonly deps: EpicAuthDeps) {}

  private log(): Logger {
    return this.deps.logger;
  }

  async loadSession(): Promise<EpicSession | null> {
    if (this.cached) return this.cached;
    let raw: string | null;
    try {
      raw = await this.deps.keychain.get(ACCOUNT_EPIC_SESSION);
    } catch (e) {
      const err = toAppError(e);
      this.log().warn('cannot read the Epic session from the Keychain', { code: err.code, error: err.message });
      throw err;
    }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as EpicSession;
      if (!parsed.accessToken || !parsed.refreshToken) return null;
      this.cached = parsed;
      return parsed;
    } catch {
      this.log().warn('stored Epic session is not valid JSON; ignoring it');
      return null;
    }
  }

  private async saveSession(session: EpicSession): Promise<void> {
    this.cached = session;
    await this.deps.keychain.set(ACCOUNT_EPIC_SESSION, JSON.stringify(session));
    this.deps.repos.auth.set(
      {
        accountId: session.accountId,
        displayName: session.displayName,
        sessionValid: true,
        lastValidatedAt: this.deps.clock.now().toISOString(),
        lastRefreshAt: this.deps.clock.now().toISOString(),
        expiresAt: session.expiresAt,
        error: null,
      },
      this.deps.clock.now().toISOString(),
    );
  }

  /** RFC form-encoded token request. */
  private async tokenRequest(params: Record<string, string>): Promise<EpicSession> {
    const body = new URLSearchParams({ ...params, token_type: 'eg1' }).toString();
    const doFetch = this.deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.getConfig().epic.requestTimeoutMs);
    try {
      const res = await doFetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          authorization: basicAuth(),
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'UELauncher/11.0.1-14907503+++Portal+Release-Live',
        },
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: TokenResponse;
      try {
        parsed = JSON.parse(text) as TokenResponse;
      } catch {
        throw new AppError('AUTH_FAILED', `Epic token endpoint returned non-JSON (HTTP ${res.status})`);
      }
      if (!res.ok || !parsed.access_token) throw mapEpicAuthError(parsed, res.status);
      const now = this.deps.clock.now();
      const expiresIn = Number(parsed.expires_in ?? 7200);
      const refreshExpiresIn = parsed.refresh_expires_at ? null : null;
      return {
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token ?? '',
        tokenType: parsed.token_type ?? 'bearer',
        accountId: parsed.account_id ?? '',
        displayName: parsed.display_name ?? '',
        expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
        refreshExpiresAt: parsed.refresh_expires_at ?? refreshExpiresIn,
        scope: parsed.scope ?? null,
        obtainedAt: now.toISOString(),
      };
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new AppError('TIMEOUT', 'Epic token request timed out', {}, true);
      throw toAppError(e, 'AUTH_FAILED');
    } finally {
      clearTimeout(timer);
    }
  }

  async exchangeCode(code: string): Promise<EpicSession> {
    const session = await this.tokenRequest({ grant_type: 'exchange_code', exchange_code: code });
    if (!session.refreshToken) throw new AppError('AUTH_FAILED', 'Epic did not return a refresh token for the exchange code');
    await this.saveSession(session);
    this.log().info('epic session established', { account: session.displayName });
    return session;
  }

  /** Refreshes when the access token is close to expiry. Serialised, never parallel. */
  async ensureFreshSession(): Promise<EpicSession> {
    const session = await this.loadSession();
    if (!session) throw new AppError('AUTH_REQUIRED', 'no Epic session stored — run "epic-claims auth login"');
    const expiresAt = Date.parse(session.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt - this.deps.clock.nowMs() > 5 * 60_000) return session;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        if (!session.refreshToken) throw new AppError('AUTH_EXPIRED', 'the stored session has no refresh token — sign in again');
        const next = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refreshToken });
        const merged: EpicSession = { ...session, ...next, refreshToken: next.refreshToken || session.refreshToken };
        await this.saveSession(merged);
        this.log().info('epic session refreshed');
        return merged;
      } catch (e) {
        const err = toAppError(e);
        this.deps.repos.auth.set({ sessionValid: false, error: err.message }, this.deps.clock.now().toISOString());
        throw err;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async getAccessToken(): Promise<{ token: string; accountId: string }> {
    const session = await this.ensureFreshSession();
    return { token: session.accessToken, accountId: session.accountId };
  }

  async status(): Promise<AuthStatus> {
    let session: EpicSession | null = null;
    try {
      session = await this.loadSession();
    } catch (e) {
      return { authenticated: false, accountName: null, accountId: null, expiresAt: null, detail: `Keychain unavailable: ${errorMessage(e)}` };
    }
    if (!session) return { authenticated: false, accountName: null, accountId: null, expiresAt: null, detail: 'no Epic session stored — run "epic-claims auth login"' };

    // Cheap local judgement first; only hit the network when the token looks usable.
    const expiresAt = Date.parse(session.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt < this.deps.clock.nowMs()) {
      try {
        const refreshed = await this.ensureFreshSession();
        return {
          authenticated: true,
          accountName: refreshed.displayName || null,
          accountId: refreshed.accountId || null,
          expiresAt: refreshed.expiresAt,
          detail: 'session refreshed',
        };
      } catch (e) {
        return {
          authenticated: false,
          accountName: session.displayName || null,
          accountId: session.accountId || null,
          expiresAt: session.expiresAt,
          detail: `session expired: ${errorMessage(e)}`,
        };
      }
    }
    try {
      const verified = await this.verify(session.accessToken);
      return {
        authenticated: true,
        accountName: verified.displayName || session.displayName || null,
        accountId: verified.accountId || session.accountId || null,
        expiresAt: verified.expiresAt ?? session.expiresAt,
        detail: 'session valid',
      };
    } catch (e) {
      return {
        authenticated: false,
        accountName: session.displayName || null,
        accountId: session.accountId || null,
        expiresAt: session.expiresAt,
        detail: `session rejected by Epic: ${errorMessage(e)}`,
      };
    }
  }

  private async verify(accessToken: string): Promise<{ displayName: string; accountId: string; expiresAt: string | null }> {
    const res = await httpJson<{ displayName?: string; account_id?: string; expires_at?: string }>(VERIFY_URL, {
      headers: { authorization: `bearer ${accessToken}` },
      timeoutMs: this.deps.getConfig().epic.requestTimeoutMs,
      retries: 1,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    }).catch((e: unknown) => {
      const err = toAppError(e);
      if (err.code === 'HTTP_ERROR' && err.context.status === 401) throw new AppError('AUTH_EXPIRED', 'Epic rejected the stored token');
      throw err;
    });
    return {
      displayName: res.data.displayName ?? '',
      accountId: res.data.account_id ?? '',
      expiresAt: res.data.expires_at ?? null,
    };
  }

  /**
   * Interactive sign-in. Opens a real browser window: Epic's login, 2FA and
   * captcha stay in the user's hands. We only read the exchange code the
   * launcher redirect hands back.
   */
  async login(opts: { headless?: boolean } = {}): Promise<{ ok: boolean; accountName: string | null; detail: string }> {
    const existing = await this.loadSession();
    if (existing) {
      const status = await this.status();
      if (status.authenticated) return { ok: true, accountName: status.accountName, detail: 'already signed in' };
    }

    const code = await this.obtainExchangeCode(opts.headless === true);
    const session = await this.exchangeCode(code);
    return { ok: true, accountName: session.displayName || null, detail: `signed in as ${session.displayName || session.accountId}` };
  }

  /** Drives Playwright to the exchange-code redirect. */
  private async obtainExchangeCode(headless: boolean): Promise<string> {
    const cfg = this.deps.getConfig();
    const dataDir = this.deps.dataDir ?? path.join(process.env.HOME ?? '.', 'Library', 'Application Support', 'Epic Claims');
    const profileDir = path.join(dataDir, 'browser-profile');
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

    let chromium: typeof import('playwright-core').chromium;
    try {
      ({ chromium } = await import('playwright-core'));
    } catch (e) {
      throw new AppError('AUTH_FAILED', `playwright-core is not installed: ${(e as Error).message}`);
    }

    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless,
      args: ['--no-first-run', '--no-default-browser-check'],
      viewport: { width: 1280, height: 820 },
      ...(cfg.epic.browserExecutablePath ? { executablePath: cfg.epic.browserExecutablePath } : { channel: cfg.epic.browserChannel }),
    };

    this.log().info('opening the Epic sign-in window', { headless, channel: cfg.epic.browserChannel });
    const context = await chromium.launchPersistentContext(profileDir, launchOptions);
    const page = context.pages()[0] ?? (await context.newPage());
    const deadline = Date.now() + cfg.epic.loginTimeoutSeconds * 1000;
    let exchangeCode: string | null = null;

    try {
      await page.goto(`${WEB_LOGIN_URL}?redirectUrl=${encodeURIComponent(WEB_REDIRECT_URL)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      while (Date.now() < deadline && !exchangeCode) {
        // SSO (Google/Apple) opens a popup; the redirect can land on any page in
        // the context, so scan all of them rather than only the first one.
        for (const candidate of context.pages()) {
          const candidateUrl = candidate.url();
          const m = /[?&]code=([^&]+)/.exec(candidateUrl);
          if (m?.[1]) {
            exchangeCode = decodeURIComponent(m[1]);
            break;
          }
        }
        if (exchangeCode) break;

        // 1. The redirect may land directly on a URL carrying ?code=
        const url = page.url();
        const urlMatch = /[?&]code=([^&]+)/.exec(url);
        if (urlMatch?.[1]) {
          exchangeCode = decodeURIComponent(urlMatch[1]);
          break;
        }
        // 2. Otherwise read the JSON body the /id/api/redirect endpoint returns
        try {
          const text = (await page.textContent('body')) ?? '';
          if (text.trim().startsWith('{')) {
            const parsed = JSON.parse(text) as { exchangeCode?: string | null; authorizationCode?: string | null };
            if (parsed.exchangeCode) {
              exchangeCode = parsed.exchangeCode;
              break;
            }
          }
        } catch {
          /* page is navigating */
        }
        // 3. Navigating to the redirect endpoint with the session cookie yields the JSON
        if (!page.url().includes('/id/api/redirect')) {
          try {
            await page.goto(WEB_REDIRECT_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
            continue;
          } catch {
            /* keep polling */
          }
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      try {
        await context.close();
      } catch {
        /* ignore */
      }
    }

    if (!exchangeCode) {
      throw new AppError('AUTH_INTERRUPTED', `sign-in did not complete within ${cfg.epic.loginTimeoutSeconds}s (the window was closed, or 2FA/captcha was not finished)`);
    }
    return exchangeCode;
  }

  async logout(): Promise<void> {
    const session = await this.loadSession().catch(() => null);
    if (session) {
      try {
        await httpJson(KILL_SESSION_URL, {
          method: 'DELETE',
          headers: { authorization: `bearer ${session.accessToken}` },
          timeoutMs: 8000,
          retries: 0,
          ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        });
      } catch {
        /* best effort: the local delete is what matters */
      }
    }
    await this.deps.keychain.delete(ACCOUNT_EPIC_SESSION).catch(() => false);
    this.cached = null;
    this.deps.repos.auth.set({ sessionValid: false, error: 'signed out', accountId: null, displayName: null, expiresAt: null }, this.deps.clock.now().toISOString());
  }

  async ensureAuthenticated(): Promise<void> {
    const session = await this.loadSession();
    if (!session) throw new AppError('AUTH_REQUIRED', 'no Epic session stored — run "epic-claims auth login"');
    await this.ensureFreshSession();
  }
}
