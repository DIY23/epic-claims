import fs from 'node:fs';
import path from 'node:path';
import { randomToken, safeEqual } from '../shared/logger.js';
import { AppError } from '../shared/errors.js';
import type { KeychainBackend } from '../auth/keychain.js';

/**
 * The dashboard/API bearer token.
 *
 * Stored in a 0600 file inside the data directory, deliberately *not* in the
 * Keychain: every CLI invocation (status, check, update…) would otherwise touch
 * a Keychain item, and on macOS a Keychain read from a different process than
 * the one that created the item can raise a password prompt — fatal for an
 * unattended application. This is a local API secret, not an account
 * credential; Epic tokens never take this path.
 */
export class ApiTokenStore {
  constructor(private readonly opts: { dataDir: string; filePath: string; keychain?: KeychainBackend }) {}

  async get(): Promise<string> {
    const fromFile = this.readFile();
    if (fromFile) return fromFile;
    return this.rotate();
  }

  async rotate(): Promise<string> {
    const token = randomToken(32);
    this.writeFile(token);
    return token;
  }

  async verify(candidate: string | undefined | null): Promise<boolean> {
    if (!candidate) return false;
    const expected = await this.get();
    return safeEqual(candidate, expected);
  }

  private readFile(): string | null {
    try {
      const value = fs.readFileSync(this.opts.filePath, 'utf8').trim();
      return value.length >= 16 ? value : null;
    } catch {
      return null;
    }
  }

  private writeFile(token: string): void {
    fs.mkdirSync(path.dirname(this.opts.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.opts.filePath, `${token}\n`, { mode: 0o600 });
  }
}

export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() ?? null;
}

export function assertLoopback(ip: string | undefined): void {
  if (!ip) return;
  const normalised = ip.replace(/^::ffff:/, '');
  if (normalised === '127.0.0.1' || normalised === '::1') return;
  throw new AppError('AUTH_FAILED', 'approval links are only accepted from loopback', { ip });
}
