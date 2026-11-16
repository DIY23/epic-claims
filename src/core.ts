import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from './db/database.js';
import { createRepositories, type Repositories } from './db/repositories.js';
import { ConfigStore } from './config/store.js';
import { Logger, consoleSink, type LogLevel } from './shared/logger.js';
import { systemClock, type Clock } from './shared/clock.js';
import { resolvePaths, type AppPaths } from './shared/paths.js';
import { defaultKeychain, type KeychainBackend } from './auth/keychain.js';
import { ApiTokenStore } from './api/auth.js';
import { EventBus } from './shared/events.js';
import { ClaimEngine } from './claim/claimEngine.js';
import { NotificationManager } from './notify/manager.js';
import { MacOSNotificationAdapter } from './notify/adapters/macos.js';
import { IMessageNotificationAdapter, chatDbPath } from './notify/adapters/imessage.js';
import { NotifierClient, locateHelper } from './notify/macos/helper.js';
import { MessagesDbReader, type MessageReader } from './notify/imessage/reader.js';
import { IMessageCommandService } from './notify/imessage/commands.js';
import { Scheduler } from './scheduler/scheduler.js';
import { LaunchdService } from './service/launchd.js';
import { Updater } from './update/installer.js';
import { createApiServer } from './api/server.js';
import { RotatingFileSink } from './logging/file-sink.js';
import { APP_VERSION } from './version.js';
import { AppError, toAppError } from './shared/errors.js';
import type { Config } from './config/schema.js';
import type { StoreProvider } from './providers/provider.js';
import type { CycleSummary, HealthReport } from './shared/types.js';
import type { FastifyInstance } from 'fastify';
import { createEpicProvider } from './providers/epic/index.js';
import { EpicAuthManager } from './auth/epicAuth.js';

export interface CoreOptions {
  paths?: { home?: string; logs?: string; install?: string };
  clock?: Clock;
  keychain?: KeychainBackend;
  fetchImpl?: typeof fetch;
  providerFactory?: (deps: { auth: EpicAuthManager; getConfig: () => Config; logger: Logger; clock: Clock; fetchImpl?: typeof fetch }) => StoreProvider;
  logLevel?: LogLevel;
  /** Skip the single-instance guard (used by tests and by one-shot CLI commands). */
  allowConcurrent?: boolean;
  messageReader?: MessageReader;
}

export interface RuntimePaths {
  cliEntry: string;
  runtimeDir: string;
  distDir: string;
}

/**
 * Locates the running program so launchd/update always point at a real file.
 *
 * This module compiles to <version>/dist/core.js, so:
 *   distDir    = <version>/dist          (dashboard assets live in dist/public)
 *   runtimeDir = <version>               (native helper lives in native/)
 *   cliEntry   = <version>/dist/cli/index.js
 */
export function locateRuntime(): RuntimePaths {
  const here = fileURLToPath(import.meta.url);
  const distDir = path.dirname(here);
  const runtimeDir = path.dirname(distDir);
  return { cliEntry: path.join(distDir, 'cli', 'index.js'), runtimeDir, distDir };
}

/**
 * Composition root. Every collaborator is injected so the whole application can
 * be exercised in tests without network, keychain or launchd.
 */
export class AppCore {
  readonly startedAt = new Date().toISOString();
  readonly paths: AppPaths;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly db: Database;
  readonly repos: Repositories;
  readonly configStore: ConfigStore;
  readonly keychain: KeychainBackend;
  readonly apiToken: ApiTokenStore;
  readonly bus: EventBus;
  readonly auth: EpicAuthManager;
  readonly provider: StoreProvider;
  readonly engine: ClaimEngine;
  readonly notifications: NotificationManager;
  readonly commandService: IMessageCommandService;
  readonly scheduler: Scheduler;
  readonly service: LaunchdService;
  readonly updater: Updater;
  readonly fileSink: RotatingFileSink;
  readonly assetsDir: string;
  readonly runtimePaths: RuntimePaths;

  private server: FastifyInstance | null = null;
  private commandTimer: NodeJS.Timeout | null = null;
  private pidLocked = false;
  private stopping = false;

  private constructor(private readonly opts: CoreOptions, built: BuildParts) {
    this.paths = built.paths;
    this.clock = built.clock;
    this.logger = built.logger;
    this.fileSink = built.fileSink;
    this.db = built.db;
    this.repos = built.repos;
    this.configStore = built.configStore;
    this.keychain = built.keychain;
    this.apiToken = built.apiToken;
    this.bus = built.bus;
    this.auth = built.auth;
    this.provider = built.provider;
    this.engine = built.engine;
    this.notifications = built.notifications;
    this.commandService = built.commandService;
    this.scheduler = built.scheduler;
    this.service = built.service;
    this.updater = built.updater;
    this.assetsDir = built.assetsDir;
    this.runtimePaths = built.runtimePaths;
  }

  static async create(opts: CoreOptions = {}): Promise<AppCore> {
    const clock = opts.clock ?? systemClock;
    const paths = resolvePaths(opts.paths ?? {});
    fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.logsDir, { recursive: true, mode: 0o755 });

    const configStore = new ConfigStore({ filePath: paths.configFile });
    const config = configStore.load();

    const logger = new Logger('app', opts.logLevel ?? config.logging.level);
    logger.addSink(consoleSink());
    const fileSink = new RotatingFileSink({
      dir: paths.logsDir,
      maxFileBytes: config.logging.maxFileMb * 1024 * 1024,
      maxFiles: config.logging.maxFiles,
    });
    logger.addSink(fileSink.sink);
    process.on('uncaughtException', (e) => logger.exception('uncaught exception', e));
    process.on('unhandledRejection', (e) => logger.exception('unhandled rejection', e));

    // --- database -----------------------------------------------------------
    const db = new Database({ file: paths.dbFile, logger: logger.child('db') });
    db.open();
    const existingVersion = db.schemaVersion();
    const pending = existingVersion === 0 ? 1 : 0;
    if (existingVersion > 0 && pending === 0) {
      // No pending migrations to pre-back up for; the updater backs up separately.
    }
    db.migrate();
    const repos = createRepositories(db);
    logger.addSink((record) => {
      try {
        repos.logs.insert({ ts: record.ts, level: record.level, scope: record.scope, message: record.msg, data: record.data });
      } catch {
        /* logging must never fail the caller */
      }
    });

    const abandoned = repos.claims.abandonInflight(clock.now().toISOString(), 'process restarted while a claim was in flight');
    if (abandoned > 0) logger.warn('abandoned interrupted claim attempts', { count: abandoned });

    // --- credentials & auth -------------------------------------------------
    const keychain = opts.keychain ?? defaultKeychain();
    const apiToken = new ApiTokenStore({ keychain, dataDir: paths.dataDir, filePath: paths.apiTokenFile });
    const getConfig = (): Config => configStore.load();

    const auth = new EpicAuthManager({
      keychain,
      clock,
      logger: logger.child('auth'),
      getConfig,
      repos,
      dataDir: paths.dataDir,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });

    const provider =
      opts.providerFactory?.({ auth, getConfig, logger, clock, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }) ??
      createEpicProvider({ auth, getConfig, logger, clock, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });

    // --- notifications ------------------------------------------------------
    const runtimePaths = locateRuntime();
    const { cliEntry, runtimeDir } = runtimePaths;
    const macos = new MacOSNotificationAdapter({
      helperCandidates: [
        path.join(runtimeDir, 'native', 'EpicClaimsNotifier.app'),
        path.join(paths.currentLink, 'native', 'EpicClaimsNotifier.app'),
        path.join(process.cwd(), 'native', 'EpicClaimsNotifier.app'),
      ],
      dataDir: paths.dataDir,
    });
    const imessage = new IMessageNotificationAdapter();

    const notifications = new NotificationManager({
      adapters: [macos, imessage],
      repos,
      clock,
      logger: logger.child('notify'),
      getConfig,
    });
    const bus = new EventBus();
    bus.subscribe(async (event) => {
      await notifications.dispatch(event);
    });

    const engine = new ClaimEngine({ provider, repos, bus, clock, logger: logger.child('engine'), getConfig });

    const reader = opts.messageReader ?? (process.platform === 'darwin' && getConfig().notifications.adapters.imessage.enabled ? new MessagesDbReader(chatDbPath(getConfig())) : new MessagesDbReader(chatDbPath(getConfig())));
    const commandService = new IMessageCommandService({
      reader,
      repos,
      clock,
      logger: logger.child('imessage'),
      getConfig,
      decide: (input) => engine.handleApprovalDecision({ shortCode: input.shortCode, decision: input.decision, decidedBy: input.decidedBy }),
      getTransport: () => {
        const cfg = getConfig().notifications.adapters.imessage;
        if (!cfg.enabled || !cfg.recipient) return null;
        try {
          return imessage.resolveTransport(getConfig());
        } catch {
          return null;
        }
      },
    });

    const scheduler = new Scheduler({
      engine,
      repos,
      clock,
      logger: logger.child('scheduler'),
      getConfig,
      afterCycle: async () => {
        await engine.expireApprovals();
        await commandService.poll().catch(() => undefined);
      },
    });

    const service = new LaunchdService({
      label: config.service.label,
      paths,
      nodePath: process.execPath,
      cliPath: cliEntry,
      keepAlive: config.service.keepAlive,
      startAtLogin: config.service.startAtLogin,
    });

    const updater = new Updater({
      paths,
      clock,
      logger: logger.child('update'),
      repos,
      getConfig,
      service,
      currentVersion: APP_VERSION,
      backupDb: (dest) => db.backupTo(dest),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });

    const assetsDir = path.join(runtimePaths.distDir, 'public');

    return new AppCore(opts, {
      paths,
      clock,
      logger,
      fileSink,
      db,
      repos,
      configStore,
      keychain,
      apiToken,
      bus,
      auth,
      provider,
      engine,
      notifications,
      commandService,
      scheduler,
      service,
      updater,
      assetsDir,
      runtimePaths,
    });
  }

  async runCheck(trigger: CycleSummary['trigger'] = 'manual', opts: { bypassFirstRunGate?: boolean } = {}): Promise<CycleSummary> {
    return this.scheduler.runNow(trigger, opts);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    const dbOk = this.db.isOpen && this.db.integrityCheck();
    const configOk = (() => {
      try {
        this.configStore.load();
        return true;
      } catch {
        return false;
      }
    })();
    let authOk = true;
    try {
      authOk = (await this.provider.authStatus()).authenticated;
    } catch {
      authOk = false;
    }
    const ok = dbOk && configOk;
    return {
      ok,
      detail: `${dbOk ? 'db ok' : 'db error'} · ${configOk ? 'config ok' : 'config invalid'} · ${authOk ? 'epic session ok' : 'epic session requires login'}`,
    };
  }

  healthReport(): Promise<HealthReport> {
    return (async () => {
      const h = await this.health();
      const st = this.scheduler.state();
      return {
        ok: h.ok,
        version: APP_VERSION,
        uptimeSec: Math.round(process.uptime()),
        dbOk: this.db.isOpen,
        authOk: h.detail.includes('session ok'),
        schedulerRunning: st.running,
        lastCycleAt: st.lastRunAt,
        nextCycleAt: st.nextRunAt,
        checkedAt: this.clock.now().toISOString(),
      };
    })();
  }

  /** Starts the HTTP API + dashboard. */
  async startApi(): Promise<{ port: number; host: string }> {
    const config = this.configStore.load();
    if (!config.api.enabled) throw new AppError('CONFIG_INVALID', 'the local API is disabled in configuration');
    this.server = await createApiServer({
      paths: this.paths,
      version: APP_VERSION,
      startedAt: this.startedAt,
      configStore: this.configStore,
      repos: this.repos,
      logger: this.logger,
      clock: this.clock,
      notifications: this.notifications,
      scheduler: this.scheduler,
      engine: this.engine,
      updater: this.updater,
      service: this.service,
      apiToken: this.apiToken,
      provider: this.provider,
      assetsDir: this.assetsDir,
      runCheck: (trigger) => this.runCheck(trigger),
      runCheckBypassingGate: (trigger) => this.runCheck(trigger, { bypassFirstRunGate: true }),
      health: () => this.health(),
      requestShutdown: () => {
        void this.stop();
      },
    });
    try {
      await this.server.listen({ port: config.api.port, host: config.api.host });
    } catch (e) {
      const err = toAppError(e);
      if (/EADDRINUSE/.test(err.message)) {
        throw new AppError('SERVICE_ERROR', `port ${config.api.port} is already in use — another instance is probably running`, {
          port: config.api.port,
        });
      }
      throw err;
    }
    this.logger.info('api listening', { host: config.api.host, port: config.api.port });
    return { port: config.api.port, host: config.api.host };
  }

  /**
   * Applies approval clicks that the helper already wrote to its durable log but
   * could not POST (for instance while the API was restarting). The helper also
   * posts directly, so this is belt and braces — decisions are single-use and
   * idempotent on the approval row.
   */
  async drainNotifierActions(): Promise<number> {
    try {
      const config = this.configStore.load();
      if (!config.notifications.adapters.macos.enabled) return 0;
      const client = new NotifierClient({
        location: locateHelper(
          [path.join(this.runtimePaths.runtimeDir, 'native', 'EpicClaimsNotifier.app'), path.join(this.paths.currentLink, 'native', 'EpicClaimsNotifier.app')],
          config.notifications.adapters.macos.helperPath,
        ),
        dataDir: this.paths.dataDir,
      });
      if (!client.available) return 0;
      const offsetFile = path.join(this.paths.dataDir, 'notifier', 'actions.offset');
      const actions = client.drainActions(offsetFile);
      let applied = 0;
      for (const action of actions) {
        if (action.action !== 'claim' && action.action !== 'skip') continue;
        if (!action.token) continue;
        const { sha256 } = await import('./shared/logger.js');
        const approval = this.repos.approvals.byTokenHash(sha256(action.token));
        if (!approval || approval.status !== 'pending') continue;
        const result = await this.engine.handleApprovalDecision({ approvalId: approval.id, decision: action.action, decidedBy: 'macos-notification' });
        if (result.ok) applied++;
      }
      return applied;
    } catch (e) {
      this.logger.child('notify').debug('action drain skipped', { error: (e as Error).message });
      return 0;
    }
  }

  /** Starts the scheduler and the inbound approval poller. */
  async startBackground(): Promise<void> {
    const config = this.configStore.load();
    await this.scheduler.start();
    const intervalMs = Math.max(10_000, config.notifications.adapters.imessage.replyPollSeconds * 1000);
    if (config.notifications.adapters.imessage.enabled) {
      this.commandTimer = setInterval(() => {
        void this.commandService.poll().catch((e) => this.logger.child('imessage').warn('command poll failed', { error: (e as Error).message }));
        void this.engine.expireApprovals().catch(() => undefined);
        void this.drainNotifierActions().catch(() => undefined);
      }, intervalMs);
      this.commandTimer.unref?.();
      this.logger.info('inbound approval polling enabled', { everySeconds: intervalMs / 1000 });
    }
  }

  /** Single-instance guard: one daemon per data directory. */
  acquirePidLock(): void {
    const pidFile = this.paths.pidFile;
    try {
      if (fs.existsSync(pidFile)) {
        const raw = fs.readFileSync(pidFile, 'utf8').trim();
        const pid = Number(raw);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
          try {
            process.kill(pid, 0);
            if (!this.opts.allowConcurrent) {
              throw new AppError('SERVICE_ERROR', `another instance is already running (pid ${pid})`, { pid, pidFile });
            }
          } catch (e) {
            if (e instanceof AppError) throw e;
            /* stale pid file, take it over */
          }
        }
      }
      fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
      this.pidLocked = true;
    } catch (e) {
      if (e instanceof AppError) throw e;
      this.logger.warn('cannot write the pid file', { error: (e as Error).message });
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.logger.info('shutting down');
    this.scheduler.stop();
    if (this.commandTimer) clearInterval(this.commandTimer);
    try {
      await this.server?.close();
    } catch {
      /* ignore */
    }
    if (this.pidLocked) {
      try {
        fs.rmSync(this.paths.pidFile, { force: true });
      } catch {
        /* ignore */
      }
    }
    try {
      const stats = this.db.stats();
      this.repos.state.set('db.stats', JSON.stringify(stats), this.clock.now().toISOString());
    } catch {
      /* ignore */
    }
    this.db.close();
    this.fileSink.close();
  }
}

interface BuildParts {
  paths: AppPaths;
  clock: Clock;
  logger: Logger;
  fileSink: RotatingFileSink;
  db: Database;
  repos: Repositories;
  configStore: ConfigStore;
  keychain: KeychainBackend;
  apiToken: ApiTokenStore;
  bus: EventBus;
  auth: EpicAuthManager;
  provider: StoreProvider;
  engine: ClaimEngine;
  notifications: NotificationManager;
  commandService: IMessageCommandService;
  scheduler: Scheduler;
  service: LaunchdService;
  updater: Updater;
  assetsDir: string;
  runtimePaths: RuntimePaths;
}
