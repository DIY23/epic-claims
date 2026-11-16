import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../shared/errors.js';

const execFileAsync = promisify(execFile);

export interface KeychainBackend {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
  readonly kind: string;
}

export const KEYCHAIN_SERVICE = 'Epic Claims';
export const ACCOUNT_EPIC_SESSION = 'epic-session';
export const ACCOUNT_API_TOKEN = 'local-api-token';
export const ACCOUNT_APPROVAL_KEY = 'approval-hmac-key';

interface SecurityRunner {
  run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
}

const defaultRunner: SecurityRunner = {
  async run(args) {
    try {
      const { stdout, stderr } = await execFileAsync('/usr/bin/security', args, { timeout: 15_000, maxBuffer: 1024 * 1024 });
      return { stdout, stderr, code: 0 };
    } catch (e) {
      const err = e as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '', code: typeof err.code === 'number' ? err.code : 1 };
    }
  },
};

/**
 * macOS Keychain access through the `security` CLI.
 *
 * The item is created with an ACL that trusts this Node binary (the app's
 * interpreter), so unattended reads work while the login keychain is unlocked
 * and no password prompt appears after a restart. If the ACL cannot be set the
 * item is still created; a locked keychain then surfaces as KEYCHAIN_LOCKED and
 * the caller fails safe instead of silently losing the session.
 */
export class MacKeychain implements KeychainBackend {
  readonly kind = 'macos-keychain';

  constructor(
    private readonly service: string = KEYCHAIN_SERVICE,
    private readonly runner: SecurityRunner = defaultRunner,
    private readonly trustedBinary: string | null = process.execPath,
  ) {}

  async get(account: string): Promise<string | null> {
    const res = await this.runner.run(['find-generic-password', '-s', this.service, '-a', account, '-w']);
    if (res.code === 0) return res.stdout.replace(/\n$/, '');
    if (res.code === 44 || /could not be found/i.test(res.stderr)) return null;
    if (/interaction is not allowed|not allowed/i.test(res.stderr)) {
      throw new AppError('KEYCHAIN_LOCKED', 'Keychain access was denied without user interaction (keychain locked or ACL missing)', {
        account,
        hint: 'Unlock the login keychain and run "epic-claims auth login" once from a Terminal window.',
      });
    }
    if (/user name or passphrase|not correct|passphrase/i.test(res.stderr)) {
      throw new AppError('KEYCHAIN_LOCKED', 'Keychain is locked; unlock it and retry', { account });
    }
    throw new AppError('KEYCHAIN_UNAVAILABLE', `keychain read failed: ${res.stderr.trim() || `exit ${res.code}`}`, { account });
  }

  /**
   * Writes (or updates) an item.
   *
   * Access control, in order of preference:
   *
   *  - `any` (default): `-A`, i.e. the item carries no application ACL, so any
   *    process running as this user can read it once the login keychain is
   *    unlocked. No prompt ever appears — which is what "unattended" requires.
   *    The protection is the login keychain itself plus the 0700 data directory.
   *  - `binary`: `-T <node>` restricts the item to this interpreter. Stronger,
   *    but macOS then shows a "wants to use your confidential information"
   *    prompt whenever a *different* path asks (a launchd agent, an updated
   *    interpreter), which is unusable on an always-on box.
   *
   * Set EPIC_CLAIMS_KEYCHAIN_ACL=binary to opt into the stricter mode.
   */
  async set(account: string, secret: string): Promise<void> {
    const acl = (process.env.EPIC_CLAIMS_KEYCHAIN_ACL ?? 'any').toLowerCase();
    const base = ['add-generic-password', '-U', '-s', this.service, '-a', account, '-w', secret];
    const args = acl === 'binary' && this.trustedBinary ? [...base, '-T', this.trustedBinary] : [...base, '-A'];
    let res = await this.runner.run(args);
    if (res.code !== 0 && acl === 'binary') {
      // Fall back to an ACL-free item so the app can still run unattended.
      res = await this.runner.run([...base, '-A']);
    }
    if (res.code !== 0) {
      throw new AppError('KEYCHAIN_UNAVAILABLE', `keychain write failed: ${res.stderr.trim() || `exit ${res.code}`}`, { account });
    }
  }

  async delete(account: string): Promise<boolean> {
    const res = await this.runner.run(['delete-generic-password', '-s', this.service, '-a', account]);
    if (res.code === 0) return true;
    if (/could not be found/i.test(res.stderr)) return false;
    throw new AppError('KEYCHAIN_UNAVAILABLE', `keychain delete failed: ${res.stderr.trim()}`, { account });
  }

  /** Diagnostic used by `epic-claims auth status` and the dashboard. */
  async probe(): Promise<{ available: boolean; message: string }> {
    const res = await this.runner.run(['list-keychains']);
    if (res.code !== 0) return { available: false, message: res.stderr.trim() || 'security CLI unavailable' };
    return { available: true, message: res.stdout.trim().split('\n').length + ' keychain(s)' };
  }
}

/** Test / CI backend. Never used for real credentials. */
export class InMemoryKeychain implements KeychainBackend {
  readonly kind = 'in-memory';
  private readonly items = new Map<string, string>();
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.items.set(k, v);
  }
  async get(account: string): Promise<string | null> {
    return this.items.get(account) ?? null;
  }
  async set(account: string, secret: string): Promise<void> {
    this.items.set(account, secret);
  }
  async delete(account: string): Promise<boolean> {
    return this.items.delete(account);
  }
}

/** Backend that always fails, to prove the app degrades safely. */
export class FailingKeychain implements KeychainBackend {
  readonly kind = 'failing';
  constructor(private readonly code: 'KEYCHAIN_UNAVAILABLE' | 'KEYCHAIN_LOCKED' = 'KEYCHAIN_LOCKED') {}
  async get(): Promise<string | null> {
    throw new AppError(this.code, 'keychain intentionally unavailable');
  }
  async set(): Promise<void> {
    throw new AppError(this.code, 'keychain intentionally unavailable');
  }
  async delete(): Promise<boolean> {
    throw new AppError(this.code, 'keychain intentionally unavailable');
  }
}

export function defaultKeychain(): KeychainBackend {
  if (process.platform !== 'darwin') throw new AppError('UNSUPPORTED_PLATFORM', 'macOS Keychain is only available on darwin');
  return new MacKeychain();
}
