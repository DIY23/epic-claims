/**
 * Daily wall-clock scheduling without a date library.
 *
 * Free games publish on Thursdays at 17:00 CET, so the useful scan is "every
 * day at 17:30 local time". That is a wall-clock rule, not an interval: it must
 * survive DST changes and long uptimes.
 */

export interface DailyTime {
  hour: number;
  minute: number;
}

export function parseClock(value: string): DailyTime | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Wall-clock parts of an instant in a given zone. */
export function zonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // en-GB renders midnight as 24 in some ICU versions.
  const hour = get('hour') % 24;
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute'), second: get('second') };
}

/** Offset of a zone at a given instant, in milliseconds (east positive). */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Next instant at which the local clock in `timeZone` reads hour:minute.
 * Strictly after `from`. Handles DST by resolving the offset twice.
 */
export function nextDailyOccurrence(from: Date, time: DailyTime, timeZone: string): Date {
  const local = zonedParts(from, timeZone);
  // Candidate 1: today at hh:mm local.
  const build = (dayOffset: number): Date => {
    const naiveUtc = Date.UTC(local.year, local.month - 1, local.day + dayOffset, time.hour, time.minute, 0);
    // First guess uses the current offset, then corrects once (DST edge).
    let guess = new Date(naiveUtc - zoneOffsetMs(from, timeZone));
    guess = new Date(naiveUtc - zoneOffsetMs(guess, timeZone));
    return guess;
  };
  const today = build(0);
  if (today.getTime() > from.getTime()) return today;
  return build(1);
}

/** True when the instant is at or after the given wall-clock time on its own day. */
export function hasPassedToday(instant: Date, time: DailyTime, timeZone: string): boolean {
  const p = zonedParts(instant, timeZone);
  return p.hour * 60 + p.minute >= time.hour * 60 + time.minute;
}

/** The machine's own time zone, e.g. "Europe/Brussels" or "Asia/Tokyo". */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Next scan instant for a release-anchored schedule.
 *
 * The anchor is the *publisher's* clock (11:00 America/New_York), not the local
 * one: that is the only rule that stays "30 minutes after the games go live"
 * everywhere. Consequences, all intentional:
 *   - the store hands over games at 11:00 ET, i.e. 16:00Z in winter and 15:00Z
 *     in summer (US DST), so the scan is 16:30Z / 15:30Z respectively
 *   - on a machine in Brussels that reads 17:30 CET/CEST most of the year, but
 *     16:30 or 18:30 during the two-to-three weeks when EU and US DST transitions
 *     are out of step — correct, because the release instant is what matters
 *   - on a machine in Tokyo or Sydney it simply fires at whatever their local
 *     clock says at that instant
 */
export function nextReleaseScan(from: Date, releaseTime: DailyTime, releaseZone: string, offsetMinutes: number): Date {
  const slot = nextDailyOccurrence(from, releaseTime, releaseZone);
  const at = new Date(slot.getTime() + offsetMinutes * 60_000);
  if (at.getTime() > from.getTime()) return at;
  return new Date(slot.getTime() + 86_400_000 + offsetMinutes * 60_000);
}

/** How an instant reads on this machine, for status output. */
export function describeLocal(instant: Date, timeZone: string = systemTimeZone()): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(instant);
  } catch {
    return instant.toISOString();
  }
}
