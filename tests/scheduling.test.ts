import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSandbox, makeOffer, eventsOfType, type Sandbox } from './helpers.js';
import { nextDailyOccurrence, nextReleaseScan, parseClock, zonedParts, hasPassedToday, systemTimeZone, describeLocal } from '../src/scheduler/daily.js';
import { Scheduler } from '../src/scheduler/scheduler.js';

let box: Sandbox;

beforeEach(() => {
  box = makeSandbox();
});

afterEach(() => {
  box.cleanup();
});

const TZ = 'Europe/Brussels';
const SCAN = { hour: 17, minute: 30 };

describe('daily wall-clock scheduling', () => {
  it('parses a 24h clock and rejects nonsense', () => {
    expect(parseClock('17:30')).toEqual({ hour: 17, minute: 30 });
    expect(parseClock('00:05')).toEqual({ hour: 0, minute: 5 });
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('17:60')).toBeNull();
    expect(parseClock('5pm')).toBeNull();
  });

  it('schedules the next scan at 17:30 Brussels time, not an interval later', () => {
    // Tuesday 16/11/2026, 09:00 CET
    const from = new Date('2026-11-16T08:00:00.000Z');
    const next = nextDailyOccurrence(from, SCAN, TZ);
    expect(next.toISOString()).toBe('2026-11-16T16:30:00.000Z'); // 17:30 CET
  });

  it('rolls over to the next day when today’s slot has passed', () => {
    const from = new Date('2026-11-16T18:00:00.000Z'); // 19:00 CET
    const next = nextDailyOccurrence(from, SCAN, TZ);
    expect(zonedParts(next, TZ)).toMatchObject({ day: 17, hour: 17, minute: 30 });
  });

  it('follows the Thursday release: a Thursday 17:30 scan is 30 min after publishing', () => {
    // Thursday 19/11/2026: games publish 17:00 CET (16:00Z)
    const thursdayMorning = new Date('2026-11-19T06:00:00.000Z');
    const next = nextDailyOccurrence(thursdayMorning, SCAN, TZ);
    expect(next.toISOString()).toBe('2026-11-19T16:30:00.000Z');
    const publish = new Date('2026-11-19T16:00:00.000Z');
    expect(next.getTime() - publish.getTime()).toBe(30 * 60_000);
  });

  it('handles the DST switch (CET ↔ CEST)', () => {
    // 2026-03-29 02:00 CET -> 03:00 CEST. A 17:30 scan is 15:30Z after the switch.
    const afterSwitch = nextDailyOccurrence(new Date('2026-03-29T10:00:00.000Z'), SCAN, TZ);
    expect(afterSwitch.toISOString()).toBe('2026-03-29T15:30:00.000Z');
    // Before the switch it is 16:30Z.
    const beforeSwitch = nextDailyOccurrence(new Date('2026-03-28T10:00:00.000Z'), SCAN, TZ);
    expect(beforeSwitch.toISOString()).toBe('2026-03-28T16:30:00.000Z');
    // And in winter it is 16:30Z again.
    const winter = nextDailyOccurrence(new Date('2026-12-01T10:00:00.000Z'), SCAN, TZ);
    expect(winter.toISOString()).toBe('2026-12-01T16:30:00.000Z');
  });

  it('reports whether the wall clock has passed the slot', () => {
    expect(hasPassedToday(new Date('2026-11-16T16:29:00.000Z'), SCAN, TZ)).toBe(false);
    expect(hasPassedToday(new Date('2026-11-16T16:31:00.000Z'), SCAN, TZ)).toBe(true);
  });
});

describe('release-anchored scheduling (location independent)', () => {
  const RELEASE = { hour: 11, minute: 0 };
  const NY = 'America/New_York';

  it('scans 30 minutes after the publish instant, in winter', () => {
    // Monday 16/11/2026 09:00Z: 11:00 EST = 16:00Z
    const next = nextReleaseScan(new Date('2026-11-16T09:00:00.000Z'), RELEASE, NY, 30);
    expect(next.toISOString()).toBe('2026-11-16T16:30:00.000Z');
    // and on this machine that reads 17:30 in Brussels
    expect(zonedParts(next, 'Europe/Brussels')).toMatchObject({ hour: 17, minute: 30 });
  });

  it('scans 30 minutes after the publish instant, in summer (US DST)', () => {
    // Wednesday 15/07/2026: 11:00 EDT = 15:00Z
    const next = nextReleaseScan(new Date('2026-07-15T09:00:00.000Z'), RELEASE, NY, 30);
    expect(next.toISOString()).toBe('2026-07-15T15:30:00.000Z');
    expect(zonedParts(next, 'Europe/Brussels')).toMatchObject({ hour: 17, minute: 30 });
  });

  it('adapts during the window when EU and US DST are out of step', () => {
    // 12/03/2026: the US is already on EDT (publish 15:00Z) while Europe is still
    // on CET, so the scan is 16:30 local — not 17:30. Following the release
    // instant is the requirement; the local clock is a consequence.
    const next = nextReleaseScan(new Date('2026-03-12T09:00:00.000Z'), RELEASE, NY, 30);
    expect(next.toISOString()).toBe('2026-03-12T15:30:00.000Z');
    expect(zonedParts(next, 'Europe/Brussels')).toMatchObject({ hour: 16, minute: 30 });
    expect(zonedParts(next, NY)).toMatchObject({ hour: 11, minute: 30 });
  });

  it('fires at the same instant on a machine in any zone', () => {
    const from = new Date('2026-11-16T09:00:00.000Z');
    const instant = nextReleaseScan(from, RELEASE, NY, 30);
    expect(instant.toISOString()).toBe('2026-11-16T16:30:00.000Z');
    // Same instant, different local readings — no per-machine tuning needed.
    expect(zonedParts(instant, 'Asia/Tokyo')).toMatchObject({ hour: 1, minute: 30 });
    expect(zonedParts(instant, 'America/Los_Angeles')).toMatchObject({ hour: 8, minute: 30 });
    expect(zonedParts(instant, 'Australia/Sydney')).toMatchObject({ hour: 3, minute: 30 });
  });

  it('honours a custom offset', () => {
    const next = nextReleaseScan(new Date('2026-11-16T09:00:00.000Z'), RELEASE, NY, 0);
    expect(next.toISOString()).toBe('2026-11-16T16:00:00.000Z');
    const late = nextReleaseScan(new Date('2026-11-16T09:00:00.000Z'), RELEASE, NY, 120);
    expect(late.toISOString()).toBe('2026-11-16T18:00:00.000Z');
  });

  it('rolls to the next day once today’s scan has passed', () => {
    const next = nextReleaseScan(new Date('2026-11-16T17:00:00.000Z'), RELEASE, NY, 30);
    expect(zonedParts(next, NY)).toMatchObject({ day: 17, hour: 11, minute: 30 });
  });

  it('knows the machine time zone and renders instants in it', () => {
    expect(systemTimeZone().length).toBeGreaterThan(2);
    expect(describeLocal(new Date('2026-11-16T16:30:00.000Z'), 'Europe/Brussels')).toContain('17:30');
  });
});

describe('scheduler uses the release anchor', () => {
  it('schedules the next run at publish + 30 minutes by default', async () => {
    // FakeClock is 2026-11-16T12:00Z (13:00 CET); publish is 16:00Z.
    box.configStore.update({ scheduling: { runOnStartup: false } });
    box.repos.state.set('scheduler.last_run_at', '2026-11-16T09:00:00.000Z');
    const scheduler = new Scheduler({
      engine: box.engine,
      repos: box.repos,
      clock: box.clock,
      logger: box.logger,
      getConfig: () => box.configStore.load(),
    });
    await scheduler.start();
    expect(box.repos.state.get('scheduler.next_run_at')).toBe('2026-11-16T16:30:00.000Z');
    scheduler.stop();
  });
});

describe('scheduler uses the daily rule', () => {
  function makeScheduler(): Scheduler {
    return new Scheduler({
      engine: box.engine,
      repos: box.repos,
      clock: box.clock,
      logger: box.logger,
      getConfig: () => box.configStore.load(),
    });
  }

  it('persists the next run at the configured local time', async () => {
    box.configStore.update({ scheduling: { mode: 'daily', dailyTime: '17:30', timeZone: TZ, runOnStartup: false } });
    // FakeClock starts at 2026-11-16T12:00Z = 13:00 CET
    box.repos.state.set('scheduler.last_run_at', '2026-11-16T09:00:00.000Z');
    const scheduler = makeScheduler();
    await scheduler.start();
    expect(box.repos.state.get('scheduler.next_run_at')).toBe('2026-11-16T16:30:00.000Z');
    scheduler.stop();
  });

  it('does not run on every restart when the slot has not arrived', async () => {
    box.configStore.update({ claiming: { mode: 'auto' }, scheduling: { mode: 'daily', dailyTime: '17:30', timeZone: TZ, runOnStartup: true } });
    box.repos.state.set('scheduler.last_run_at', '2026-11-16T09:00:00.000Z'); // 10:00 CET, before 17:30
    box.provider.offers = [makeOffer({ storeOfferId: 'daily-1' })];
    const scheduler = makeScheduler();
    await scheduler.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(box.provider.claimCalls).toEqual([]);
    scheduler.stop();
  });

  it('recovers a scan missed while the process was down', async () => {
    box.configStore.update({ claiming: { mode: 'auto' }, scheduling: { mode: 'daily', dailyTime: '17:30', timeZone: TZ, runOnStartup: true } });
    // Last run two days ago: the 17:30 slot has passed since.
    box.repos.state.set('scheduler.last_run_at', '2026-11-14T09:00:00.000Z');
    box.provider.offers = [makeOffer({ storeOfferId: 'missed-1' })];
    const scheduler = makeScheduler();
    await scheduler.start();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && box.provider.claimCalls.length === 0) await new Promise((r) => setTimeout(r, 20));
    expect(box.provider.claimCalls).toEqual(['missed-1']);
    scheduler.stop();
  });
});

describe('first run gate', () => {
  beforeEach(() => {
    box.configStore.update({ claiming: { mode: 'auto', firstRun: 'discover_only' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'first-1', title: 'First Game' }), makeOffer({ storeOfferId: 'first-2', title: 'Second Game' })];
  });

  it('claims nothing on the very first scan, even in automatic mode', async () => {
    const summary = await box.engine.runCycle('startup');

    expect(summary.discovered).toBe(2);
    expect(summary.claimed).toBe(0);
    expect(box.provider.claimCalls).toEqual([]);
    expect(box.repos.offers.list({}).every((o) => o.status === 'discovered')).toBe(true);
    expect(box.repos.state.get('baseline.completed_at')).not.toBeNull();
  });

  it('sends exactly one summary notification instead of one per game', async () => {
    await box.engine.runCycle('startup');
    const summaries = eventsOfType(box.events, 'FIRST_RUN_SUMMARY');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.payload.freeCount).toBe(2);
    expect(eventsOfType(box.events, 'APPROVAL_REQUIRED')).toHaveLength(0);
  });

  it('applies the configured mode from the second scan onward', async () => {
    await box.engine.runCycle('startup');
    const second = await box.engine.runCycle('scheduled');
    expect(second.claimed).toBe(2);
    expect(box.provider.claimCalls.sort()).toEqual(['first-1', 'first-2']);
  });

  it('lets the user claim everything explicitly, bypassing the gate', async () => {
    const summary = await box.engine.runCycle('manual', { bypassFirstRunGate: true });
    expect(summary.claimed).toBe(2);
    expect(eventsOfType(box.events, 'FIRST_RUN_SUMMARY')).toHaveLength(0);
  });

  it('lets the user claim just one game from the dashboard or CLI', async () => {
    await box.engine.runCycle('startup');
    const offer = box.repos.offers.list({}).find((o) => o.storeOfferId === 'first-1')!;
    await box.engine.claimOffer(offer.id, 'dashboard');
    expect(box.provider.claimCalls).toEqual(['first-1']);
    const others = box.repos.offers.list({}).filter((o) => o.storeOfferId !== 'first-1');
    expect(others.every((o) => o.status === 'discovered')).toBe(true);
  });

  it('does not arm the gate when firstRun is normal', async () => {
    box.configStore.update({ claiming: { firstRun: 'normal' } });
    const summary = await box.engine.runCycle('startup');
    expect(summary.claimed).toBe(2);
  });

  it('leaves the baseline unset when the first scan found nothing', async () => {
    box.provider.offers = [];
    await box.engine.runCycle('startup');
    expect(box.repos.state.get('baseline.completed_at')).toBeNull();
    // A later scan with offers then shows the summary rather than claiming.
    box.provider.offers = [makeOffer({ storeOfferId: 'late-1' })];
    const next = await box.engine.runCycle('scheduled');
    expect(next.claimed).toBe(0);
    expect(eventsOfType(box.events, 'FIRST_RUN_SUMMARY')).toHaveLength(1);
  });
});
