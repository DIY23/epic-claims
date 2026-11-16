import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeSandbox, makeOffer, type Sandbox } from './helpers.js';
import { Scheduler, withTimeout } from '../src/scheduler/scheduler.js';
import type { CycleSummary } from '../src/shared/types.js';

let box: Sandbox;
let afterCycleCalls: CycleSummary[];

function makeScheduler(extra: { cycleTimeoutMsOverride?: number } = {}): Scheduler {
  afterCycleCalls = [];
  return new Scheduler({
    ...extra,
    engine: box.engine,
    repos: box.repos,
    clock: box.clock,
    logger: box.logger,
    getConfig: () => box.configStore.load(),
    afterCycle: async (summary) => {
      afterCycleCalls.push(summary);
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('condition not met in time');
}

beforeEach(() => {
  box = makeSandbox();
  box.configStore.update({ claiming: { mode: 'auto' }, scheduling: { intervalHours: 12, runOnStartup: true } });
  box.provider.offers = [makeOffer({ storeOfferId: 'sched-1' })];
});

afterEach(() => {
  box.cleanup();
});

describe('scheduler', () => {
  it('runs a check at startup when there is no previous run', async () => {
    const scheduler = makeScheduler();
    await scheduler.start();
    await waitFor(() => box.repos.state.get('scheduler.last_run_at') !== null);

    expect(box.provider.claimCalls).toEqual(['sched-1']);
    expect(afterCycleCalls).toHaveLength(1);
    const state = scheduler.state();
    expect(state.lastRunAt).not.toBeNull();
    expect(state.nextRunAt).not.toBeNull();
    scheduler.stop();
  });

  it('recovers a missed check after downtime', async () => {
    box.repos.state.set('scheduler.last_run_at', '2026-11-10T00:00:00.000Z');
    const scheduler = makeScheduler();
    await scheduler.start();
    await waitFor(() => afterCycleCalls.length > 0);
    expect(afterCycleCalls).toHaveLength(1);
    scheduler.stop();
  });

  it('does not run on startup when the interval has not elapsed', async () => {
    box.repos.state.set('scheduler.last_run_at', new Date(box.clock.nowMs() - 3600_000).toISOString());
    const scheduler = makeScheduler();
    await scheduler.start();
    await new Promise((r) => setTimeout(r, 120));
    expect(afterCycleCalls).toHaveLength(0);
    expect(scheduler.state().nextRunAt).not.toBeNull();
    scheduler.stop();
  });

  it('refuses an overlapping run', async () => {
    const scheduler = makeScheduler();
    let release: (() => void) | null = null;
    box.provider.onClaim = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { httpStatus: 200, ok: true, entitlementNames: [], raw: {} };
    };
    const first = scheduler.runNow('manual');
    await new Promise((r) => setTimeout(r, 30));
    await expect(scheduler.runNow('manual')).rejects.toMatchObject({ code: 'CLAIM_IN_PROGRESS' });
    if (release) (release as () => void)();
    await first;
    scheduler.stop();
  });

  it('persists schedule state across restarts', async () => {
    const scheduler = makeScheduler();
    await scheduler.start();
    await waitFor(() => box.repos.state.get('scheduler.last_run_at') !== null);
    const next = box.repos.state.get('scheduler.next_run_at');
    scheduler.stop();

    const second = makeScheduler();
    await second.start();
    await new Promise((r) => setTimeout(r, 60));
    // Nothing new ran, and the persisted next-run survived.
    expect(afterCycleCalls).toHaveLength(0);
    expect(box.repos.state.get('scheduler.next_run_at')).toBe(next);
    second.stop();
  });

  it('records the last summary', async () => {
    const scheduler = makeScheduler();
    await scheduler.runNow('manual');
    const state = scheduler.state();
    expect(state.lastSummary?.claimed).toBe(1);
    scheduler.stop();
  });

  it('keeps a cycle error visible without dying', async () => {
    box.provider.discoverError = new Error('kaboom');
    const scheduler = makeScheduler();
    const summary = await scheduler.runNow('manual');
    expect(summary.errors.length).toBeGreaterThan(0);
    expect(scheduler.state().lastRunAt).not.toBeNull();
    scheduler.stop();
  });

  it('aborts a cycle that exceeds its timeout', async () => {
    box.provider.onClaim = async () => {
      await new Promise((r) => setTimeout(r, 500));
      return { httpStatus: 200, ok: true, entitlementNames: [], raw: {} };
    };
    const scheduler = makeScheduler({ cycleTimeoutMsOverride: 50 });
    await expect(scheduler.runNow('manual')).rejects.toMatchObject({ code: 'TIMEOUT' });
    scheduler.stop();
  });
});

describe('withTimeout', () => {
  it('resolves fast promises and rejects slow ones', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
    await expect(withTimeout(new Promise((r) => setTimeout(r, 200)), 20)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
