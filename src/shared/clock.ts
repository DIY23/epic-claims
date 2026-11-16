/** Injectable clock — every time-dependent decision goes through this. */
export interface Clock {
  now(): Date;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Deterministic clock for tests. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string | number = '2026-01-01T00:00:00.000Z') {
    this.t = typeof start === 'number' ? start : new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  nowMs(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(date: Date | string | number): void {
    this.t = typeof date === 'number' ? date : new Date(date).getTime();
  }
}

export function iso(d: Date): string {
  return d.toISOString();
}

export function hoursFromNow(clock: Clock, hours: number): string {
  return new Date(clock.nowMs() + hours * 3_600_000).toISOString();
}

export function isExpired(isoDate: string | null | undefined, clock: Clock): boolean {
  if (!isoDate) return false;
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return false;
  return t <= clock.nowMs();
}

export function formatDate(isoDate: string | null | undefined, locale = 'en-GB'): string {
  if (!isoDate) return '—';
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
