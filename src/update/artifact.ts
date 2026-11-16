import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError } from '../shared/errors.js';

export const CHECKSUM_ASSET = 'SHA256SUMS';
export const SIGNATURE_ASSET = 'SHA256SUMS.sig';

export interface DownloadResult {
  file: string;
  sha256: string;
  bytes: number;
}

/** Streams a URL to disk while hashing it. Enforces a size ceiling. */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<DownloadResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBytes = opts.maxBytes ?? 250 * 1024 * 1024;
  const doFetch = opts.fetchImpl ?? fetch;
  await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      headers: { accept: 'application/octet-stream', 'user-agent': 'epic-claims-updater', ...opts.headers },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok || !res.body) {
      throw new AppError('UPDATE_UNAVAILABLE', `download failed with HTTP ${res.status}`, { url: redactUrl(url), status: res.status }, res.status >= 500);
    }
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(dest, { mode: 0o600 });
    const reader = res.body.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          throw new AppError('UPDATE_VERIFICATION_FAILED', `artifact exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
        }
        hash.update(value);
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((resolve, reject) => {
            out.once('drain', resolve);
            out.once('error', reject);
          });
        }
      }
    } finally {
      await new Promise<void>((resolve) => out.end(resolve));
    }
    return { file: dest, sha256: hash.digest('hex'), bytes };
  } catch (e) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    if ((e as Error).name === 'AbortError') throw new AppError('TIMEOUT', `download timed out after ${timeoutMs}ms`, { url: redactUrl(url) }, true);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

/** Parses a "sha256  filename" file. Tolerates \r\n and extra whitespace. */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-f0-9]{64})\s+\*?(\S+)$/i.exec(line);
    if (m && m[1] && m[2]) map.set(path.basename(m[2]), m[1].toLowerCase());
  }
  return map;
}

export function verifyChecksum(assetName: string, actualSha256: string, checksums: Map<string, string>): void {
  const expected = checksums.get(assetName);
  if (!expected) {
    throw new AppError('UPDATE_VERIFICATION_FAILED', `no checksum published for ${assetName}`, { assetName });
  }
  if (expected !== actualSha256.toLowerCase()) {
    throw new AppError('UPDATE_VERIFICATION_FAILED', `checksum mismatch for ${assetName}`, {
      assetName,
      expected,
      actual: actualSha256.toLowerCase(),
    });
  }
}

/** SPKI DER prefix for a raw ed25519 public key (32 bytes). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifySignature(data: Buffer, signatureBase64: string, publicKeyBase64: string): void {
  let key: crypto.KeyObject;
  try {
    const raw = Buffer.from(publicKeyBase64.replace(/\s/g, ''), 'base64');
    if (raw.length !== 32) throw new Error('expected a 32-byte ed25519 public key');
    key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch (e) {
    throw new AppError('UPDATE_VERIFICATION_FAILED', `invalid update public key: ${(e as Error).message}`);
  }
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureBase64.replace(/\s/g, ''), 'base64');
  } catch {
    throw new AppError('UPDATE_VERIFICATION_FAILED', 'signature is not valid base64');
  }
  const ok = crypto.verify(null, data, key, sig);
  if (!ok) throw new AppError('UPDATE_VERIFICATION_FAILED', 'artifact signature verification failed');
}

/**
 * Extracts a release archive with traversal protection.
 * The archive must contain a single top-level directory.
 */
export async function extractArchive(archive: string, destDir: string): Promise<void> {
  const tar = await import('tar');
  await fsp.mkdir(destDir, { recursive: true, mode: 0o700 });
  const root = path.resolve(destDir);
  try {
    await tar.x({
      file: archive,
      cwd: destDir,
      strip: 1,
      strict: true,
      filter: (entryPath: string) => {
        const normalised = entryPath.replace(/\\/g, '/');
        if (normalised.startsWith('/') || normalised.includes('..')) return false;
        if (normalised.includes('/../')) return false;
        return true;
      },
    });
  } catch (e) {
    throw new AppError('UPDATE_INSTALL_FAILED', `cannot extract archive: ${(e as Error).message}`);
  }
  // sanity: the extraction target must still be inside destDir
  if (!path.resolve(destDir).startsWith(root)) {
    throw new AppError('UPDATE_INSTALL_FAILED', 'archive extracted outside the target directory');
  }
}

export interface ArtifactValidation {
  ok: boolean;
  problems: string[];
  version: string | null;
}

/** Confirms the extracted tree looks like a release of the expected version. */
export async function validateExtractedTree(dir: string, expectedVersion: string): Promise<ArtifactValidation> {
  const problems: string[] = [];
  let version: string | null = null;
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    problems.push('package.json is missing from the artifact');
  } else {
    try {
      const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8')) as { version?: string; name?: string };
      version = pkg.version ?? null;
      if (pkg.name !== 'epic-claims') problems.push(`package.json name is "${pkg.name}", expected "epic-claims"`);
      if (version !== expectedVersion) problems.push(`artifact version ${version ?? 'unknown'} does not match the release tag ${expectedVersion}`);
    } catch (e) {
      problems.push(`package.json is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (!fs.existsSync(path.join(dir, 'dist', 'cli', 'index.js'))) problems.push('dist/cli/index.js is missing from the artifact');
  return { ok: problems.length === 0, problems, version };
}
