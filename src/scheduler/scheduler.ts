import type { Clock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import type { Config } from '../config/schema.js';
import type { Repositories } from '../db/repositories.js';
import type { CycleSummary } from '../shared/types.js';
import type { ClaimEngine } from '../claim/claimEngine.js';
import { AppError } from '../shared/errors.js';
import { nextDailyOccurrence, nextReleaseScan, parseClock, systemTimeZone } from './daily.js';

export interface SchedulerDeps {
  engine: ClaimEngine;
  repos: Repositories;
  clock: Clock;
  logger: Logger;
  getConfig: () => Config;
  /** Runs after every cycle (used for approval sweeps and command polling). */
  afterCycle?: (summary: CycleSummary) => Promise<void>;
  /** Notification of scheduler state changes (dashboard refresh). */
  onStateChange?: (state: SchedulerState) => void;
  /** Test seam: overrides the configured cycle timeout in milliseconds. */
  cycleTimeoutMsOverride?: number;
}

export interface SchedulerState {
  running: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastSummary: CycleSummary | null;
  lastError: string | null;
}

const KEY_LAST_RUN = 'scheduler.last_run_at';
const KEY_NEXT_RUN = 'scheduler.next_run_at';
const KEY_LAST_SUMMARY = 'scheduler.last_summary';

/**
 * Deterministic scheduler.
 *
 * - never overlaps: a second trigger while one is running is refused
 * - recovers missed checks: if the process was down past the next run time, it
 *   runs once at startup instead of waiting a full interval
 * - persists last/next run in SQLite so a restart does not reset the schedule
 * - respects offer expiry through the claim engine (not here)
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private runInProgress = false;

  constructor(private readonly deps: SchedulerDeps) {}

  state(): SchedulerState {
    const { repos } = this.deps;
    return {
      running: this.started,
      lastRunAt: repos.state.get(KEY_LAST_RUN),
      nextRunAt: repos.state.get(KEY_NEXT_RUN),
      lastSummary: repos.state.getJson<CycleSummary>(KEY_LAST_SUMMARY),
      lastError: repos.state.get('scheduler.last_error'),
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { getConfig, repos, clock, logger } = this.deps;
    const config = getConfig();
    const lastRun = repos.state.get(KEY_LAST_RUN);

    logger.child('scheduler').info('scheduler started', {
      mode: config.scheduling.mode,
      ...(config.scheduling.mode === 'release'
        ? {
            releaseTime: config.scheduling.releaseTime,
            releaseTimeZone: config.scheduling.releaseTimeZone,
            scanOffsetMinutes: config.scheduling.scanOffsetMinutes,
            localTimeZone: systemTimeZone(),
          }
        : config.scheduling.mode === 'daily'
          ? { dailyTime: config.scheduling.dailyTime, timeZone: config.scheduling.timeZone || systemTimeZone() }
          : { intervalHours: config.scheduling.intervalHours }),
      lastRun,
    });

    if (config.scheduling.runOnStartup && lastRun === null) {
      logger.child('scheduler').info('running startup check', { reason: 'never-run' });
      void this.runNow('startup');
      return;
    }
    // Recover a schedule that elapsed while the process was down, then wait.
    this.scheduleNext(lastRun !== null && this.overdue(lastRun) ? { runImmediately: true } : {});
  }

  /** True when the last run is older than the most recent scheduled slot. */
  private overdue(lastRunIso: string): boolean {
    const { getConfig, clock } = this.deps;
    const s = getConfig().scheduling;
    const last = Date.parse(lastRunIso);
    if (!Number.isFinite(last)) return true;
    if (s.mode === 'interval') return clock.nowMs() - last >= s.intervalHours * 3_600_000;
    if (s.mode === 'release') {
      const release = parseClock(s.releaseTime) ?? { hour: 11, minute: 0 };
      const due = nextReleaseScan(new Date(last), release, s.releaseTimeZone, s.scanOffsetMinutes);
      return clock.nowMs() >= due.getTime();
    }
    const time = parseClock(s.dailyTime) ?? { hour: 17, minute: 30 };
    const due = nextDailyOccurrence(new Date(last), time, s.timeZone || systemTimeZone());
    return clock.nowMs() >= due.getTime();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Runs a cycle immediately (startup, CLI, dashboard). Refuses overlapping runs. */
  async runNow(trigger: CycleSummary['trigger'], opts: { bypassFirstRunGate?: boolean } = {}): Promise<CycleSummary> {
    if (this.runInProgress) {
      throw new AppError('CLAIM_IN_PROGRESS', 'a check is already running');
    }
    this.runInProgress = true;
    const { engine, repos, clock, logger, getConfig } = this.deps;
    const config = getConfig();
    const timeoutMs = this.deps.cycleTimeoutMsOverride ?? config.scheduling.cycleTimeoutMinutes * 60_000;
    const startedAt = clock.now().toISOString();
    try {
      const summary = await withTimeout(engine.runCycle(trigger, opts), timeoutMs, () => {
        logger.child('scheduler').error('cycle exceeded its timeout', { timeoutMs });
      });
      repos.state.set(KEY_LAST_RUN, clock.now().toISOString());
      repos.state.setJson(KEY_LAST_SUMMARY, summary);
      repos.state.delete('scheduler.last_error');
      this.deps.onStateChange?.(this.state());
      try {
        await this.deps.afterCycle?.(summary);
      } catch (e) {
        logger.child('scheduler').exception('after-cycle hook failed', e);
      }
      return summary;
    } catch (e) {
      const message = (e as Error).message;
      repos.state.set('scheduler.last_error', `${startedAt}: ${message}`);
      repos.state.set(KEY_LAST_RUN, clock.now().toISOString());
      this.deps.onStateChange?.(this.state());
      throw e;
    } finally {
      this.runInProgress = false;
      if (this.started) this.scheduleNext();
    }
  }

  private scheduleNext(opts: { runImmediately?: boolean } = {}): void {
    if (this.timer) clearTimeout(this.timer);
    const { getConfig, repos, clock, logger } = this.deps;
    const config = getConfig();

    if (opts.runImmediately) {
      // A slot was missed while the process was down: run once, right away.
      logger.child('scheduler').info('recovering a missed check');
      void this.runNow('scheduled').catch(() => undefined);
      return;
    }

    let next: number;
    if (config.scheduling.mode === 'release') {
      const release = parseClock(config.scheduling.releaseTime);
      if (!release) {
        logger.child('scheduler').error('invalid releaseTime, falling back to 11:00 America/New_York', {
          releaseTime: config.scheduling.releaseTime,
        });
      }
      const occurrence = nextReleaseScan(
        clock.now(),
        release ?? { hour: 11, minute: 0 },
        config.scheduling.releaseTimeZone || 'America/New_York',
        config.scheduling.scanOffsetMinutes,
      );
      next = occurrence.getTime();
    } else if (config.scheduling.mode === 'daily') {
      const time = parseClock(config.scheduling.dailyTime);
      if (!time) {
        logger.child('scheduler').error('invalid dailyTime, falling back to 17:30', { dailyTime: config.scheduling.dailyTime });
      }
      const occurrence = nextDailyOccurrence(clock.now(), time ?? { hour: 17, minute: 30 }, config.scheduling.timeZone || systemTimeZone());
      next = occurrence.getTime();
    } else {
      const intervalMs = config.scheduling.intervalHours * 3_600_000;
      const lastRun = repos.state.get(KEY_LAST_RUN);
      const base = lastRun ? Date.parse(lastRun) : clock.nowMs();
      next = base + intervalMs;
      if (next <= clock.nowMs()) next = clock.nowMs() + intervalMs; // clock moved backwards
    }

    repos.state.set(KEY_NEXT_RUN, new Date(next).toISOString());
    const delay = Math.max(1_000, next - clock.nowMs());
    this.timer = setTimeout(() => {
      void this.runNow('scheduled').catch(() => {
        /* the error is persisted and surfaced through state() */
      });
    }, delay);
    this.timer.unref?.();
    logger.child('scheduler').info('next check scheduled', { at: new Date(next).toISOString(), inHours: Math.round((delay / 3_600_000) * 10) / 10 });
    this.deps.onStateChange?.(this.state());
  }
}

/** Runs a promise with a hard timeout; the underlying work is asked to stop but never awaited twice. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new AppError('TIMEOUT', `operation exceeded ${Math.round(ms / 1000)}s`));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
