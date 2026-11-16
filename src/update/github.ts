import { httpJson } from '../shared/http.js';
import { AppError, toAppError } from '../shared/errors.js';
import { compareVersions, isPrerelease, isValidSemver, parseSemver } from '../shared/semver.js';

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  contentType: string;
  downloadCount: number;
}

export interface ReleaseInfo {
  tagName: string;
  version: string | null;
  name: string;
  prerelease: boolean;
  draft: boolean;
  publishedAt: string;
  notes: string;
  htmlUrl: string;
  assets: ReleaseAsset[];
}

interface RawRelease {
  tag_name?: string;
  name?: string;
  prerelease?: boolean;
  draft?: boolean;
  published_at?: string;
  body?: string;
  html_url?: string;
  assets?: Array<{ name?: string; browser_download_url?: string; size?: number; content_type?: string; download_count?: number }>;
}

export function normaliseTag(tag: string): string {
  return tag.replace(/^v/i, '').trim();
}

export function toReleaseInfo(raw: RawRelease): ReleaseInfo {
  const tag = raw.tag_name ?? '';
  const version = normaliseTag(tag);
  return {
    tagName: tag,
    version: isValidSemver(version) ? version : null,
    name: raw.name ?? tag,
    prerelease: raw.prerelease === true || (isValidSemver(version) && isPrerelease(version)),
    draft: raw.draft === true,
    publishedAt: raw.published_at ?? '',
    notes: raw.body ?? '',
    htmlUrl: raw.html_url ?? '',
    assets: (raw.assets ?? []).map((a) => ({
      name: a.name ?? '',
      url: a.browser_download_url ?? '',
      size: Number(a.size ?? 0),
      contentType: a.content_type ?? 'application/octet-stream',
      downloadCount: Number(a.download_count ?? 0),
    })),
  };
}

/**
 * Picks the newest release that matches the channel.
 * Stable channel ignores prereleases; beta channel accepts them but still
 * prefers a higher version number (a stable release always wins on version).
 */
export function selectRelease(releases: ReleaseInfo[], opts: { includePrerelease: boolean; currentVersion: string }): ReleaseInfo | null {
  let best: ReleaseInfo | null = null;
  for (const r of releases) {
    if (r.draft) continue;
    if (!r.version) continue;
    if (r.prerelease && !opts.includePrerelease) continue;
    if (compareVersions(r.version, opts.currentVersion) <= 0) continue;
    if (!best || !best.version || compareVersions(r.version, best.version) > 0) best = r;
  }
  return best;
}

export class GitHubReleases {
  constructor(
    private readonly opts: {
      repo: string;
      token?: string | undefined;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      apiBase?: string;
    },
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    };
    if (this.opts.token) h.authorization = `Bearer ${this.opts.token}`;
    return h;
  }

  async list(limit = 30): Promise<ReleaseInfo[]> {
    const base = this.opts.apiBase ?? 'https://api.github.com';
    try {
      const res = await httpJson<RawRelease[]>(`${base}/repos/${this.opts.repo}/releases?per_page=${limit}`, {
        headers: this.headers(),
        timeoutMs: this.opts.timeoutMs ?? 15_000,
        retries: 2,
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      });
      if (!Array.isArray(res.data)) throw new AppError('STORE_INVALID_RESPONSE', 'GitHub releases response was not an array');
      return res.data.map(toReleaseInfo);
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'NETWORK') throw new AppError('UPDATE_UNAVAILABLE', 'cannot reach the GitHub releases API (network unavailable)', { repo: this.opts.repo }, true);
      throw err;
    }
  }

  async latest(opts: { includePrerelease: boolean; currentVersion: string }): Promise<ReleaseInfo | null> {
    const releases = await this.list();
    return selectRelease(releases, opts);
  }

  /** Accepts "1.2.3", "v1.2.3". */
  static versionOf(release: ReleaseInfo): string | null {
    if (release.version) return release.version;
    const p = parseSemver(release.tagName);
    return p ? p.raw.replace(/^v/i, '') : null;
  }
}
