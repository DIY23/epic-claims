/** Minimal semver: parse, compare, release ordering. No dependencies. */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  raw: string;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseSemver(input: string): SemVer | null {
  const m = SEMVER_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    raw: input.trim(),
  };
}

export function isValidSemver(input: string): boolean {
  return parseSemver(input) !== null;
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  // A version without a prerelease tag has higher precedence.
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn) {
      return -1; // numeric identifiers have lower precedence
    } else if (yn) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Returns -1, 0 or 1. Invalid input is treated as 0.0.0 and sorted lowest. */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

export function isPrerelease(v: string): boolean {
  const p = parseSemver(v);
  return !!p && p.prerelease.length > 0;
}

/** 1.2.3 -> {major:1,minor:2,patch:3} for the next bump. */
export function bump(version: string, kind: 'major' | 'minor' | 'patch'): string {
  const p = parseSemver(version);
  if (!p) return version;
  if (kind === 'major') return `${p.major + 1}.0.0`;
  if (kind === 'minor') return `${p.major}.${p.minor + 1}.0`;
  return `${p.major}.${p.minor}.${p.patch + 1}`;
}

/** Extracts the newest stable (or any, when includePrerelease) version from a list. */
export function maxVersion(versions: string[], includePrerelease = false): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!isValidSemver(v)) continue;
    if (!includePrerelease && isPrerelease(v)) continue;
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  return best;
}
