import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AppError, errorMessage } from '../../shared/errors.js';

const execFileAsync = promisify(execFile);

export interface SendResult {
  ok: boolean;
  detail?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface ReadinessResult {
  ready: boolean;
  detail: string;
}

/**
 * A transport is the replaceable half of the iMessage adapter: sending a message
 * and reporting readiness. Everything else (templates, routing, approvals) is
 * shared, so a new transport is one file plus one registration.
 */
export interface IMessageTransport {
  readonly id: string;
  readonly displayName: string;
  send(recipient: string, text: string, timeoutMs: number): Promise<SendResult>;
  readiness(): Promise<ReadinessResult>;
  /** Native poll (iMessage), used for approval prompts where supported. */
  sendPoll?(title: string, options: string[], timeoutMs: number): Promise<SendResult>;
}

/**
 * AppleScript program that sends one message. The handle and text arrive as
 * argv (never interpolated into the source), so no escaping can break out.
 */
const SEND_SCRIPT = `
on run argv
  set theHandle to item 1 of argv
  set theService to item 2 of argv
  set theText to item 3 of argv
  if theHandle is "" then error "empty recipient handle" number -1700
  if theText is "" then error "empty message text" number -1700
  tell application id "com.apple.MobileSMS"
    if theService is "SMS" then
      set targetAccount to 1st account whose service type = SMS
    else
      set targetAccount to 1st account whose service type = iMessage
    end if
    set targetParticipant to participant theHandle of targetAccount
    send theText to targetParticipant
  end tell
  return "sent"
end run
`;

/**
 * Sends through Messages.app with AppleScript.
 *
 * Operational notes:
 *  - requires the Automation → Messages grant for the *responsible* process
 *    (approve the first-run dialog; a launchd agent is judged as itself)
 *  - exit 0 only means Messages accepted the AppleEvent; delivery is confirmed
 *    by polling chat.db for a matching `is_from_me = 1` row
 *  - Messages must be signed in, otherwise `1st account …` throws
 */
export class AppleScriptTransport implements IMessageTransport {
  readonly id = 'applescript';
  readonly displayName = 'Messages.app (AppleScript)';

  constructor(private readonly service: 'iMessage' | 'SMS' = 'iMessage') {}

  async send(recipient: string, text: string, timeoutMs: number): Promise<SendResult> {
    if (!recipient.trim()) return { ok: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorMessage: 'no iMessage recipient configured' };
    try {
      await execFileAsync('/usr/bin/osascript', ['-e', SEND_SCRIPT, recipient.trim(), this.service, text], { timeout: timeoutMs });
      return { ok: true, detail: 'Messages.app accepted the message' };
    } catch (e) {
      const msg = errorMessage(e);
      const code = /\((-?\d{3,5})\)\s*$/.exec(msg.trim())?.[1];
      // -1743 / TCC denial is a permission problem, not a transient one: never retry it.
      if (/not allowed|not authorized|automation|1743|1002/i.test(msg) || code === '-1743') {
        return {
          ok: false,
          errorCode: 'NOTIFICATION_FAILED',
          errorMessage: `Automation permission for Messages.app is missing (${msg.trim()})`,
        };
      }
      return { ok: false, errorCode: 'NOTIFICATION_FAILED', errorMessage: msg.trim() };
    }
  }

  async readiness(): Promise<ReadinessResult> {
    try {
      const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', 'tell application id "com.apple.MobileSMS" to get name'], { timeout: 15_000 });
      return { ready: true, detail: `Messages.app reachable (${stdout.trim()})` };
    } catch (e) {
      return { ready: false, detail: `Messages.app not reachable: ${errorMessage(e)}` };
    }
  }
}

/**
 * BlueBubbles bridge (optional transport).
 *
 * BlueBubbles is the only self-hosted iMessage server with a verified local REST
 * API (`POST /api/v1/message/text`, password as a query parameter), so it drops in
 * behind the same interface when someone wants push/webhooks instead of polling
 * chat.db. It still sends through AppleScript on its own host, so it inherits the
 * same Messages.app requirements.
 */
export class BlueBubblesTransport implements IMessageTransport {
  readonly id = 'bluebubbles';
  readonly displayName = 'BlueBubbles (local HTTP)';

  constructor(
    private readonly opts: { baseUrl: string; password: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private base(): string {
    return this.opts.baseUrl.replace(/\/$/, '');
  }

  async send(recipient: string, text: string, timeoutMs: number): Promise<SendResult> {
    if (!this.opts.baseUrl) return { ok: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorMessage: 'no BlueBubbles baseUrl configured' };
    if (!this.opts.password) return { ok: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorMessage: 'no BlueBubbles password configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base()}/api/v1/message/text?password=${encodeURIComponent(this.opts.password)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatGuid: `any;-;${recipient}`,
          tempGuid: `temp-${randomUUID()}`,
          message: text,
        }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => ({}))) as { status?: number; message?: string; error?: { error?: string } };
      if (!res.ok || (body.status !== undefined && body.status >= 400)) {
        return {
          ok: false,
          errorCode: 'NOTIFICATION_FAILED',
          errorMessage: body.error?.error ?? body.message ?? `bridge returned HTTP ${res.status}`,
        };
      }
      return { ok: true, detail: 'sent via BlueBubbles' };
    } catch (e) {
      const msg = errorMessage(e);
      return { ok: false, errorCode: /abort/i.test(msg) ? 'TIMEOUT' : 'NOTIFICATION_FAILED', errorMessage: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  async readiness(): Promise<ReadinessResult> {
    if (!this.opts.baseUrl) return { ready: false, detail: 'no BlueBubbles baseUrl configured' };
    try {
      const res = await this.fetchImpl(`${this.base()}/api/v1/server/info?password=${encodeURIComponent(this.opts.password)}`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok ? { ready: true, detail: `bridge healthy (HTTP ${res.status})` } : { ready: false, detail: `bridge returned HTTP ${res.status}` };
    } catch (e) {
      return { ready: false, detail: `bridge unreachable: ${errorMessage(e)}` };
    }
  }
}

/**
 * Photon iMessage gateway transport.
 *
 * Speaks to the local Photon sidecar over HTTP — the interface the gateway
 * already exposes for its own channel: `POST /send {spaceId, text, format}` with
 * `x-hermes-sidecar-token`. This is the right path on a machine whose Apple
 * account has no iMessage: nothing touches Messages.app, and no other profile's
 * traffic is affected (outbound only; inbound approvals use the single-use link).
 */
export class PhotonTransport implements IMessageTransport {
  readonly id = 'photon';
  readonly displayName = 'Photon iMessage gateway';

  constructor(
    private readonly opts: { baseUrl: string; spaceId: string; token?: string; tokenFile?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private base(): string {
    return this.opts.baseUrl.replace(/\/$/, '');
  }

  /** Token precedence: explicit value → env → the sidecar's own config file. */
  private token(): string | null {
    if (this.opts.token) return this.opts.token;
    const env = process.env.EPIC_CLAIMS_PHOTON_TOKEN;
    if (env) return env;
    const file = (this.opts.tokenFile ?? '').replace(/^~/, process.env.HOME ?? '~');
    if (!file) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: string };
      return parsed.token ?? null;
    } catch {
      return null;
    }
  }

  private headers(): Record<string, string> {
    const token = this.token();
    return {
      'content-type': 'application/json',
      ...(token ? { 'x-hermes-sidecar-token': token } : {}),
    };
  }

  async send(_recipient: string, text: string, timeoutMs: number): Promise<SendResult> {
    if (!this.opts.baseUrl) return { ok: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorMessage: 'no Photon gateway baseUrl configured' };
    if (!this.opts.spaceId) return { ok: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorMessage: 'no Photon spaceId (chat) configured' };
    if (!this.token()) return { ok: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorMessage: 'no Photon sidecar token available' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base()}/send`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ spaceId: this.opts.spaceId, text, format: 'text' }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; messageId?: string };
      if (!res.ok || body.ok === false) {
        return {
          ok: false,
          errorCode: res.status === 401 ? 'ADAPTER_NOT_CONFIGURED' : 'NOTIFICATION_FAILED',
          errorMessage: body.error ?? `gateway returned HTTP ${res.status}`,
        };
      }
      return { ok: true, detail: `sent via Photon${body.messageId ? ` (${body.messageId})` : ''}` };
    } catch (e) {
      const msg = errorMessage(e);
      return { ok: false, errorCode: /abort/i.test(msg) ? 'TIMEOUT' : 'NOTIFICATION_FAILED', errorMessage: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Native iMessage poll: a one-tap Claim/Skip prompt. */
  async sendPoll(title: string, options: string[], timeoutMs: number): Promise<SendResult> {
    if (!this.opts.spaceId) return { ok: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorMessage: 'no Photon spaceId configured' };
    if (options.length < 2) return { ok: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorMessage: 'a poll needs at least two options' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base()}/send-poll`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ spaceId: this.opts.spaceId, title, options }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; messageId?: string };
      if (!res.ok || body.ok === false) {
        return { ok: false, errorCode: 'NOTIFICATION_FAILED', errorMessage: body.error ?? `gateway returned HTTP ${res.status}` };
      }
      return { ok: true, detail: `poll sent${body.messageId ? ` (${body.messageId})` : ''}` };
    } catch (e) {
      const msg = errorMessage(e);
      return { ok: false, errorCode: /abort/i.test(msg) ? 'TIMEOUT' : 'NOTIFICATION_FAILED', errorMessage: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  async readiness(): Promise<ReadinessResult> {
    if (!this.opts.baseUrl) return { ready: false, detail: 'no Photon gateway baseUrl configured' };
    if (!this.token()) return { ready: false, detail: 'no Photon sidecar token (set photon.tokenFile or EPIC_CLAIMS_PHOTON_TOKEN)' };
    try {
      const res = await this.fetchImpl(`${this.base()}/healthz`, {
        method: 'POST',
        headers: this.headers(),
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) return { ready: false, detail: 'Photon gateway rejected the sidecar token' };
      return res.ok ? { ready: true, detail: `gateway healthy (HTTP ${res.status})` } : { ready: false, detail: `gateway returned HTTP ${res.status}` };
    } catch (e) {
      return { ready: false, detail: `Photon gateway unreachable at ${this.opts.baseUrl}: ${errorMessage(e)}` };
    }
  }
}

export interface TransportOptions {
  /** AppleScript / BlueBubbles recipient. */
  recipient?: string;
  service?: 'iMessage' | 'SMS';
  bridgePassword?: string;
  baseUrl?: string;
  spaceId?: string;
  token?: string;
  tokenFile?: string;
}

/**
 * Photon is the default: it is the only path that works when the Mac's Apple
 * account has no iMessage, and it never launches Messages.app.
 */
export function createTransport(id: 'photon' | 'applescript' | 'bluebubbles', opts: TransportOptions): IMessageTransport {
  if (id === 'photon') {
    return new PhotonTransport({
      baseUrl: opts.baseUrl ?? 'http://127.0.0.1:8789',
      spaceId: opts.spaceId ?? '',
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.tokenFile ? { tokenFile: opts.tokenFile } : {}),
    });
  }
  if (id === 'bluebubbles') return new BlueBubblesTransport({ baseUrl: opts.baseUrl ?? '', password: opts.bridgePassword ?? '' });
  if (process.platform !== 'darwin') throw new AppError('UNSUPPORTED_PLATFORM', 'the AppleScript iMessage transport requires macOS');
  return new AppleScriptTransport(opts.service ?? 'iMessage');
}
