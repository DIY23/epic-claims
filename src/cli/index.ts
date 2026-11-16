import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { AppCore } from '../core.js';
import { APP_VERSION, buildInfo } from '../version.js';
import { AppError, errorMessage, toAppError } from '../shared/errors.js';
import { formatDate } from '../shared/clock.js';
import { validateRule } from '../claim/policy.js';
import { EVENT_LABELS, EVENT_TYPES, makeEvent } from '../shared/events.js';
import { validateTemplate } from '../notify/template-vars.js';
import { describeCheck } from '../update/installer.js';
import { isPrerelease } from '../shared/semver.js';
import { buildExampleEvent } from '../api/server.js';
import type { CycleSummary } from '../shared/types.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_AUTH_REQUIRED = 3;
export const EXIT_BLOCKED = 4;

const useColour = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = {
  dim: (s: string): string => (useColour ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string): string => (useColour ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string): string => (useColour ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string): string => (useColour ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string): string => (useColour ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string): string => (useColour ? `\x1b[36m${s}\x1b[0m` : s),
};

export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  if (all.length === 0) return '';
  const widths = all[0]!.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  return all
    .map((row, idx) => {
      const line = row.map((cell, i) => (cell ?? '').padEnd(widths[i] ?? 0)).join('  ').trimEnd();
      if (idx === 0 && headers) return c.bold(line);
      return line;
    })
    .join('\n');
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function withCore<T>(fn: (core: AppCore) => Promise<T>, opts: { allowConcurrent?: boolean } = {}): Promise<T> {
  const core = await AppCore.create({ allowConcurrent: true, ...(opts.allowConcurrent !== undefined ? { allowConcurrent: opts.allowConcurrent } : {}) });
  try {
    return await fn(core);
  } finally {
    await core.stop().catch(() => undefined);
  }
}

function exitFor(error: unknown): never {
  const err = toAppError(error);
  process.stderr.write(`${c.red('error')} ${err.code}: ${err.message}\n`);
  if (Object.keys(err.context).length > 0) process.stderr.write(`  ${JSON.stringify(err.context)}\n`);
  if (err.code === 'AUTH_REQUIRED' || err.code === 'AUTH_EXPIRED') process.exit(EXIT_AUTH_REQUIRED);
  if (err.code === 'CLAIM_IN_PROGRESS' || err.code === 'UPDATE_BUSY') process.exit(EXIT_BLOCKED);
  if (err.code === 'CONFIG_INVALID') process.exit(EXIT_USAGE);
  process.exit(EXIT_ERROR);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('epic-claims')
    .description('Autonomous Epic Games Store free-game claimer for macOS')
    .version(APP_VERSION, '--version', 'print the version and exit')
    .addOption(new Option('--json', 'machine-readable output').default(false))
    .showHelpAfterError('(run "epic-claims --help" for usage)');

  const json = (): boolean => program.opts().json === true;

  // ---------------------------------------------------------------- status
  program
    .command('status')
    .description('show application, authentication and scheduler status')
    .action(async () => {
      try {
        await withCore(async (core) => {
          const config = core.configStore.load();
          const auth = await core.provider.authStatus().catch((e: unknown) => ({ authenticated: false, accountName: null, accountId: null, expiresAt: null, detail: errorMessage(e) }));
          const scheduler = core.scheduler.state();
          const service = await core.service.status().catch(() => null);
          const counts = core.repos.offers.countByStatus();
          const pending = core.repos.approvals.pending();
          const updateState = core.updater.readState();
          if (json()) {
            printJson({ version: APP_VERSION, config, auth, scheduler, service, counts, approvalsPending: pending.length, updates: updateState });
            return;
          }
          out(c.bold('Epic Claims ') + c.dim(`v${APP_VERSION} (${buildInfo().platform})`));
          out(`  store          ${core.provider.displayName}`);
          out(`  epic session   ${auth.authenticated ? c.green('authenticated') + c.dim(auth.accountName ? ` as ${auth.accountName}` : '') : c.yellow('not authenticated')}${auth.authenticated ? '' : c.dim(` — ${auth.detail}`)}`);
          out(`  claim mode     ${config.claiming.mode}${config.claiming.dryRun ? c.yellow(' (dry run)') : ''}`);
          out(`  scheduler      ${scheduler.running ? 'running' : 'idle'} · last ${formatDate(scheduler.lastRunAt)} · next ${formatDate(scheduler.nextRunAt)}`);
          out(`  service        ${service ? `${service.loaded ? 'loaded' : 'not loaded'}${service.pid ? ` pid ${service.pid}` : ''}` : 'unknown'}`);
          out(`  offers         ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ') || 'none'}`);
          out(`  approvals      ${pending.length} pending`);
          out(`  database       ${core.db.file} ${c.dim(`(${Math.round(fs.existsSync(core.db.file) ? fs.statSync(core.db.file).size / 1024 : 0)} KB)`)}`);
          out(`  install        ${core.paths.installRoot}`);
          out(`  data           ${core.paths.dataDir}`);
          out(`  logs           ${core.paths.logsDir}`);
          out(`  last update    ${updateState.lastInstallAt ? formatDate(updateState.lastInstallAt) : 'never'} · check ${updateState.lastCheckAt ? formatDate(updateState.lastCheckAt) : 'never'}`);
        });
      } catch (e) {
        exitFor(e);
      }
    });

  // ---------------------------------------------------------------- check
  program
    .command('check')
    .description('run a discovery/claim cycle now')
    .option('--claim', 'also redeem offers that policy allows (otherwise it only reports)')
    .action(async (opts: { claim?: boolean }) => {
      try {
        await withCore(async (core) => {
          const config = core.configStore.load();
          const run = async (): Promise<CycleSummary> => core.runCheck('manual', { bypassFirstRunGate: true });
          const summary =
            !opts.claim && config.claiming.mode !== 'approval'
              ? // A plain "check" must never redeem: run the cycle with dry-run forced on.
                await core.configStore.withTransient({ claiming: { dryRun: true } }, run)
              : await run();
          if (!opts.claim && config.claiming.mode !== 'approval') out(c.dim('dry run: nothing was redeemed (pass --claim to redeem)'));
          if (json()) {
            printJson(summary);
            return;
          }
          out(`cycle ${summary.trigger} ${formatDate(summary.startedAt)} → ${formatDate(summary.finishedAt)}`);
          out(
            `  discovered ${summary.discovered} · claimed ${summary.claimed} · owned ${summary.alreadyOwned} · pending ${summary.pendingApproval} · skipped ${summary.skipped} · failed ${summary.failed}`,
          );
          if (summary.authRequired) out(c.yellow('  authentication required: run "epic-claims auth login"'));
          for (const err of summary.errors) out(c.red(`  ${err}`));
          if (summary.claimed > 0) process.exit(EXIT_OK);
        });
      } catch (e) {
        exitFor(e);
      }
    });

  // ---------------------------------------------------------------- claim
  program
    .command('claim')
    .description('claim a specific offer, or every eligible offer')
    .argument('[offerId]', 'offer id (see "epic-claims history" or the dashboard)')
    .option('--all', 'claim every offer that policy allows, right now')
    .action(async (offerId: string | undefined, opts: { all?: boolean }) => {
      try {
        await withCore(async (core) => {
          if (opts.all) {
            // Explicit opt-in: this is the only path that may skip the first-run gate.
            const summary = await core.runCheck('manual', { bypassFirstRunGate: true });
            if (json()) printJson(summary);
            else out(`claimed ${summary.claimed} · pending approval ${summary.pendingApproval} · failed ${summary.failed}`);
            return;
          }
          if (!offerId) {
            process.stderr.write('error: pass an offer id or --all\n');
            process.exit(EXIT_USAGE);
          }
          const id = Number(offerId);
          if (!Number.isInteger(id) || id <= 0) {
            process.stderr.write('error: offer id must be a positive integer\n');
            process.exit(EXIT_USAGE);
          }
          const outcome = await core.engine.claimOffer(id, 'cli');
          if (json()) printJson(outcome);
          else {
            switch (outcome.status) {
              case 'claimed':
                out(c.green(`claimed offer ${id} and verified ownership`));
                break;
              case 'already_owned':
                out(c.dim(`offer ${id} is already owned`));
                break;
              case 'pending_approval':
                out(c.yellow(`offer ${id} is waiting for approval (approval #${outcome.approvalId})`));
                break;
              case 'failed':
                out(c.red(`claim failed: ${outcome.errorCode} — ${outcome.errorMessage}`));
                process.exit(EXIT_ERROR);
                break;
              default:
                out(c.dim(`nothing to do (${outcome.status}${'reason' in outcome ? `: ${outcome.reason}` : ''})`));
            }
          }
        });
      } catch (e) {
        exitFor(e);
      }
    });

  // ---------------------------------------------------------------- history
  program
    .command('history')
    .description('show discovered offers, claim attempts and approvals')
    .option('-n, --limit <n>', 'rows to show', '20')
    .option('--kind <kind>', 'offers|claims|approvals|notifications|events|updates|logs', 'claims')
    .action(async (opts: { limit: string; kind: string }) => {
      try {
        const limit = Math.max(1, Number(opts.limit) || 20);
        await withCore(async (core) => {
          const repos = core.repos;
          if (json()) {
            const payload: Record<string, unknown> = {};
            payload[opts.kind] =
              opts.kind === 'offers'
                ? repos.offers.list({ limit })
                : opts.kind === 'claims'
                  ? repos.claims.history(limit)
                  : opts.kind === 'approvals'
                    ? repos.approvals.history(limit)
                    : opts.kind === 'notifications'
                      ? repos.notifications.recent(limit)
                      : opts.kind === 'events'
                        ? repos.events.recent(limit)
                        : opts.kind === 'updates'
                          ? repos.updates.list(limit)
                          : repos.logs.recent(limit, 'debug');
            printJson(payload);
            return;
          }
          switch (opts.kind) {
            case 'offers': {
              const rows = repos.offers.list({ limit }).map((o) => [String(o.id), o.title.slice(0, 42), o.kind, o.status, formatDate(o.endAt)]);
              out(table(rows, ['id', 'title', 'kind', 'status', 'expires']));
              break;
            }
            case 'claims': {
              const rows = repos.claims.history(limit).map((a) => [
                String(a.id),
                String(a.offerId),
                (a.title ?? '').slice(0, 36),
                a.status,
                a.verified ? 'yes' : 'no',
                a.errorCode ?? '',
                formatDate(a.startedAt),
              ]);
              out(table(rows, ['id', 'offer', 'title', 'status', 'verified', 'error', 'started']));
              break;
            }
            case 'approvals': {
              const rows = repos.approvals.history(limit).map((a) => [String(a.id), (a.title ?? '').slice(0, 36), a.status, a.decidedBy ?? '', formatDate(a.expiresAt)]);
              out(table(rows, ['id', 'title', 'status', 'decided by', 'expires']));
              break;
            }
            case 'notifications': {
              const rows = repos.notifications.recent(limit).map((nNr) => [String(nNr.id), nNr.event, nNr.adapter, nNr.status, nNr.errorCode ?? '', formatDate(nNr.createdAt)]);
              out(table(rows, ['id', 'event', 'adapter', 'status', 'error', 'at']));
              break;
            }
            case 'events': {
              const rows = repos.events.recent(limit).map((ev) => [String(ev.id), ev.type, formatDate(ev.ts)]);
              out(table(rows, ['id', 'type', 'at']));
              break;
            }
            case 'updates': {
              const rows = repos.updates.list(limit).map((u) => [String(u.id), u.fromVersion ?? '—', u.toVersion, u.status, u.rolledBack ? 'yes' : 'no', formatDate(u.startedAt)]);
              out(table(rows, ['id', 'from', 'to', 'status', 'rolled back', 'started']));
              break;
            }
            default: {
              const rows = repos.logs.recent(limit, 'debug').map((l) => [l.ts.slice(0, 19), l.level, l.scope, l.message.slice(0, 60)]);
              out(table(rows, ['time', 'level', 'scope', 'message']));
            }
          }
        });
      } catch (e) {
        exitFor(e);
      }
    });

  // ---------------------------------------------------------------- auth
  const auth = program.command('auth').description('Epic authentication');
  auth
    .command('login')
    .description('open a browser window and sign in to Epic Games')
    .option('--headless', 'attempt a headless sign-in (only works when a session already exists)')
    .action(async (opts: { headless?: boolean }) => {
      try {
        await withCore(async (core) => {
          const result = await core.auth.login({ headless: opts.headless === true });
          if (json()) printJson(result);
          else {
            out(c.green(`signed in${result.accountName ? ` as ${result.accountName}` : ''}`));
            if (result.detail) out(c.dim(result.detail));
          }
        });
      } catch (e) {
        exitFor(e);
      }
    });
  auth
    .command('status')
    .description('show the current Epic session state')
    .action(async () => {
      try {
        await withCore(async (core) => {
          const status = await core.auth.status();
          if (json()) printJson(status);
          else {
            out(`${status.authenticated ? c.green('authenticated') : c.yellow('not authenticated')}${status.accountName ? ` as ${status.accountName}` : ''}`);
            if (status.expiresAt) out(`  token expires ${formatDate(status.expiresAt)}`);
            out(`  ${status.detail}`);
          }
        });
      } catch (e) {
        exitFor(e);
      }
    });
  auth
    .command('logout')
    .description('remove the stored Epic session from the Keychain')
    .action(async () => {
      try {
        await withCore(async (core) => {
          await core.auth.logout();
          out('signed out; credentials removed from the Keychain');
        });
      } catch (e) {
        exitFor(e);
      }
    });

  // ---------------------------------------------------------------- approvals
  const approvals = program.command('approvals').description('manage pending approval requests');
  approvals
    .command('list')
    .description('list pending approvals')
    .action(async () => {
      try {
        await withCore(async (core) => {
          const pending = core.repos.approvals.pending();
          if (json()) {
            printJson(pending);
            return;
          }
          if (pending.length === 0) {
            out(c.dim('no pending approvals'));
            return;
          }
          const rows = pending.map((a) => [String(a.id), (core.repos.offers.get(a.offerId)?.title ?? '?').slice(0, 40), a.shortCode, formatDate(a.expiresAt)]);
          out(table(rows, ['id', 'title', 'code', 'expires']));
        });
      } catch (e) {
        exitFor(e);
      }
    });
  for (const verb of ['approve', 'skip'] as const) {
    approvals
      .command(`${verb} <idOrCode>`)
      .description(`${verb} a pending approval by id or short code`)
      .action(async (idOrCode: string) => {
        try {
          await withCore(async (core) => {
            const numeric = Number(idOrCode);
            const result = await core.engine.handleApprovalDecision({
              ...(Number.isInteger(numeric) && numeric > 0 ? { approvalId: numeric } : { shortCode: idOrCode.toLowerCase() }),
              decision: verb === 'approve' ? 'claim' : 'skip',
              decidedBy: 'cli',
            });
            if (json()) printJson(result);
            else out(result.ok ? c.green(`${verb}d: ${result.decision}`) : c.yellow(`not applied: ${result.decision}`));
            if (!result.ok) process.exit(EXIT_ERROR);
          });
        } catch (e) {
          exitFor(e);
        }
      });
  }

  // ---------------------------------------------------------------- notifications
  const notify = program.command('notifications').description('notification adapters and templates');
  notify
    .command('list')
    .alias('status')
    .description('show adapters, their state and the event matrix')
    .action(async () => {
      try {
        await withCore(async (core) => {
          const config = core.configStore.load();
          const adapters = await core.notifications.status();
          if (json()) {
            printJson({ adapters, events: config.notifications.events });
            return;
          }
          out(c.bold('adapters'));
          for (const a of adapters) {
            out(`  ${a.id.padEnd(10)} ${a.enabled ? 'enabled ' : 'disabled'} ${a.configured ? c.green('ready') : c.yellow('not ready')}  ${c.dim(a.detail)}`);
          }
          out('');
          out(c.bold('event matrix') + c.dim('   macOS / iMessage'));
          for (const e of EVENT_TYPES) {
            const t = (config.notifications.events as unknown as Record<string, Record<string, { enabled: boolean }>>)[e];
            out(`  ${EVENT_LABELS[e].padEnd(28)} ${t?.['macos']?.enabled ? c.green('on ') : c.dim('off')}     ${t?.['imessage']?.enabled ? c.green('on ') : c.dim('off')}`);
          }
        });
      } catch (e) {
        exitFor(e);
      }
    });
  notify
    .command('test')
    .description('send a test notification through one adapter')
    .requiredOption('--adapter <adapter>', 'macos|imessage')
    .option('--event <event>', 'event to render', 'GAME_DISCOVERED')
    .action(async (opts: { adapter: string; event: string }) => {
      try {
        await withCore(async (core) => {
          const event = buildExampleEvent(opts.event, new Date().toISOString());
          const report = await core.notifications.test(event, opts.adapter);
          if (json()) printJson(report);
          else out(report.status === 'delivered' ? c.green(`delivered via ${opts.adapter}`) : c.red(`failed via ${opts.adapter}: ${report.errorCode} ${report.errorMessage ?? ''}`));
          if (report.status !== 'delivered') process.exit(EXIT_ERROR);
        });
      } catch (e) {
        exitFor(e);
      }
    });
  notify
    .command('authorize')
    .description('register the macOS notification helper and request permission (approve the prompt)')
    .option('--timeout <seconds>', 'how long to wait for the prompt', '120')
    .action(async (opts: { timeout: string }) => {
      try {
        await withCore(async (core) => {
          const adapter = core.notifications.getAdapter('macos') as unknown as {
            authorize?: (config: import('../config/schema.js').Config, timeoutMs?: number) => Promise<{ ok: boolean; detail: string; authorizationStatus: number }>;
          };
          if (!adapter?.authorize) {
            process.stderr.write('the macOS adapter is not available\n');
            process.exit(EXIT_USAGE);
          }
          const res = await adapter.authorize(core.configStore.load(), (Number(opts.timeout) || 120) * 1000);
          if (json()) printJson(res);
          else out(res.ok ? c.green(`macOS notifications ready (${res.detail})`) : c.yellow(`not authorized yet: ${res.detail} — approve the system prompt, then re-run`));
          if (!res.ok) process.exit(EXIT_ERROR);
        });
      } catch (e) {
        exitFor(e);
      }
    });

  notify
    .command('photon <spaceId>')
    .description('route iMessage notifications through the local Photon gateway and enable the channel')
    .option('--base-url <url>', 'gateway base URL', 'http://127.0.0.1:8789')
    .option('--test', 'send a test message immediately')
    .action(async (spaceId: string, opts: { baseUrl: string; test?: boolean }) => {
      try {
        await withCore(async (core) => {
          core.configStore.update({
            notifications: {
              adapters: {
                imessage: { enabled: true, transport: 'photon', photon: { baseUrl: opts.baseUrl, spaceId } },
              },
            },
          });
          out(c.green(`iMessage channel now uses the Photon gateway (${opts.baseUrl}, space ${spaceId})`));
          if (opts.test) {
            const report = await core.notifications.test(buildExampleEvent('APPROVAL_REQUIRED', new Date().toISOString()), 'imessage');
            out(report.status === 'delivered' ? c.green('test message sent') : c.red(`test failed: ${report.errorCode} ${report.errorMessage ?? ''}`));
            if (report.status !== 'delivered') process.exit(EXIT_ERROR);
          }
        });
      } catch (e) {
        exitFor(e);
      }
    });

  notify
    .command('show')
    .description('print the templates for one adapter')
    .requiredOption('--adapter <adapter>', 'macos|imessage')
    .option('--event <event>', 'only this event')
    .action(async (opts: { adapter: string; event?: string }) => {
      try {
        await withCore(async (core) => {
          const templates = core.configStore.load().notifications.templates as unknown as Record<string, Record<string, unknown>>;
          const set = templates[opts.adapter];
          if (!set) {
            process.stderr.write(`unknown adapter ${opts.adapter}\n`);
            process.exit(EXIT_USAGE);
          }
          printJson(opts.event ? { [opts.event]: set[opts.event] } : set);
        });
      } catch (e) {
        exitFor(e);
      }
    });

  // ---------------------------------------------------------------- service
  const service = program.command('service').description('launchd background service');
  service
    .command('install')
    .description('install and start the launchd user agent')
    .option('--print', 'print the plist instead of installing it')
    .action(async (opts: { print?: boolean }) => {
      try {
        await withCore(async (core) => {
          if (opts.print) {
            out(core.service.preview());
            return;
          }
          const res = await core.service.install();
          out(res.ok ? c.green(res.message) : c.red(res.message));
          if (!res.ok) process.exit(EXIT_ERROR);
        });
      } catch (e) {
        exitFor(e);
      }
    });
  for (const verb of ['start', 'stop', 'restart'] as const) {
    service
      .command(verb)
      .description(`${verb} the background service`)
      .action(async () => {
        try {
          await withCore(async (core) => {
            const res = await core.service[verb]();
            out(res.ok ? c.green(res.message) : c.red(res.message));
            if (!res.ok) process.exit(EXIT_ERROR);
          });
        } catch (e) {
          exitFor(e);
        }
      });
  }
  service
    .command('status')
    .description('show the launchd service state')
    .action(async () => {
      try {
        await withCore(async (core) => {
          const status = await core.service.status();
          if (json()) printJson(status);
          else {
            out(`label     ${status.label}`);
            out(`installed ${status.installed ? 'yes' : 'no'} (${status.plistPath})`);
            out(`loaded    ${status.loaded ? 'yes' : 'no'}`);
            out(`running   ${status.running ? `yes (pid ${status.pid})` : 'no'}`);
            out(`detail    ${status.detail}`);
          }
        });
      } catch (e) {
        exitFor(e);
      }
    });
  service
    .command('uninstall')
    .description('stop and remove the launchd user agent (data and credentials are kept)')
    .action(async () => {
      try {
        await withCore(async (core) => {
          const res = await core.service.uninstall();
          out(res.ok ? c.green(res.message) : c.red(res.message));
          if (!res.ok) process.exit(EXIT_ERROR);
        });
      } catch (e) {
        exitFor(e);
      }
    });

  // ---------------------------------------------------------------- update
  const update = program.command('update').description('install the latest release');
  update
    .command('check')
    .description('check for a newer release without installing it')
    .option('--beta', 'include prereleases')
    .action(async (opts: { beta?: boolean }) => {
      try {
        await withCore(async (core) => {
          const result = await core.updater.check({ includePrerelease: opts.beta === true });
          if (json()) printJson(result);
          else out(describeCheck(result));
        });
      } catch (e) {
        exitFor(e);
      }
    });
  update
    .command('install', { isDefault: true })
    .description('download, verify, install and restart the latest release')
    .option('--beta', 'allow a prerelease')
    .option('--dry-run', 'download and verify only')
    .option('--version <version>', 'install a specific release version')
    .action(async (opts: { beta?: boolean; dryRun?: boolean; version?: string }) => {
      try {
        await withCore(async (core) => {
          const check = await core.updater.check({ includePrerelease: opts.beta === true });
          let release = check.release;
          if (opts.version) {
            const { GitHubReleases } = await import('../update/github.js');
            const gh = new GitHubReleases({ repo: core.configStore.load().updates.repo });
            const releases = await gh.list();
            release = releases.find((r) => r.version === opts.version) ?? null;
            if (!release) {
              process.stderr.write(`no release found for version ${opts.version}\n`);
              process.exit(EXIT_USAGE);
            }
          }
          if (!release) {
            if (json()) printJson({ updateAvailable: false, currentVersion: APP_VERSION });
            else out(c.green(`already up to date (${APP_VERSION})`));
            return;
          }
          if (release.prerelease && !opts.beta) {
            process.stderr.write(`release ${release.version} is a prerelease; pass --beta to install it\n`);
            process.exit(EXIT_USAGE);
          }
          out(c.dim(`installing ${release.version} (currently ${APP_VERSION})…`));
          const result = await core.updater.install(release, { dryRun: opts.dryRun === true });
          if (json()) printJson(result);
          else {
            out(result.ok ? c.green(result.detail) : c.red(`update failed: ${result.detail}`));
            if (result.migrationsApplied?.length) out(c.dim(`migrations applied: ${result.migrationsApplied.join(', ')}`));
            if (result.rolledBack) out(c.yellow(`rolled back to ${result.fromVersion}`));
          }
          if (!result.ok) process.exit(EXIT_ERROR);
        });
      } catch (e) {
        exitFor(e);
      }
    });
  update
    .command('status')
    .description('show update state and history')
    .action(async () => {
      try {
        await withCore(async (core) => {
          const state = core.updater.readState();
          const history = core.repos.updates.list(10);
          if (json()) {
            printJson({ state, history, preference: core.configStore.load().updates.preference });
            return;
          }
          out(`installed   ${state.installedVersion} (running ${APP_VERSION})`);
          out(`channel     ${core.configStore.load().updates.channel}`);
          out(`preference  ${core.configStore.load().updates.preference}`);
          out(`last check  ${formatDate(state.lastCheckAt)}`);
          out(`last update ${formatDate(state.lastInstallAt)}`);
          if (history.length > 0) {
            out('');
            out(table(history.map((h) => [h.fromVersion ?? '—', h.toVersion, h.status, h.rolledBack ? 'yes' : 'no', formatDate(h.startedAt)]), ['from', 'to', 'status', 'rolled back', 'started']));
          }
        });
      } catch (e) {
        exitFor(e);
      }
    });

  // ---------------------------------------------------------------- version
  program
    .command('version')
    .description('print version and build information')
    .action(() => {
      const info = buildInfo();
      if (json()) printJson(info);
      else {
        out(`epic-claims ${info.version}`);
        out(`  node      ${info.node}`);
        out(`  platform  ${info.platform}`);
        out(`  built     ${info.buildTime}`);
        out(`  install   ${process.execPath}`);
      }
    });

  // ---------------------------------------------------------------- config
  const config = program.command('config').description('read and change configuration');
  config
    .command('path')
    .description('print config, data and log locations')
    .action(async () => {
      await withCore(async (core) => {
        const payload = { config: core.paths.configFile, data: core.paths.dataDir, database: core.db.file, logs: core.paths.logsDir, install: core.paths.installRoot };
        if (json()) printJson(payload);
        else for (const [k, v] of Object.entries(payload)) out(`${k.padEnd(9)} ${v}`);
      }).catch(exitFor);
    });
  config
    .command('show')
    .description('print the effective configuration')
    .action(async () => {
      await withCore(async (core) => printJson(core.configStore.load())).catch(exitFor);
    });
  config
    .command('set <path> <value>')
    .description('set a configuration value, e.g. claiming.mode approval')
    .action(async (keyPath: string, value: string) => {
      try {
        await withCore(async (core) => {
          const cfg = core.configStore.load() as unknown as Record<string, unknown>;
          const segments = keyPath.split('.');
          let cursor: Record<string, unknown> = cfg;
          for (let i = 0; i < segments.length - 1; i++) {
            const seg = segments[i]!;
            const next = cursor[seg];
            if (typeof next !== 'object' || next === null) {
              process.stderr.write(`error: unknown config path ${keyPath}\n`);
              process.exit(EXIT_USAGE);
            }
            cursor = next as Record<string, unknown>;
          }
          const leaf = segments[segments.length - 1]!;
          if (!(leaf in cursor)) {
            process.stderr.write(`error: unknown config key ${keyPath}\n`);
            process.exit(EXIT_USAGE);
          }
          cursor[leaf] = coerce(value, cursor[leaf]);
          core.configStore.save(cfg);
          out(c.green(`set ${keyPath} = ${JSON.stringify(cursor[leaf])}`));
          const ruleIssues = core.configStore.load().claiming.rules.flatMap((r) => validateRule(r));
          for (const issue of ruleIssues) out(c.yellow(`rule ${issue.ruleId}: ${issue.message}`));
        });
      } catch (e) {
        exitFor(e);
      }
    });
  config
    .command('reset')
    .description('restore the default configuration (data and history are kept)')
    .option('--yes', 'skip the confirmation')
    .action(async (opts: { yes?: boolean }) => {
      if (!opts.yes) {
        process.stderr.write('refusing to reset without --yes\n');
        process.exit(EXIT_USAGE);
      }
      await withCore(async (core) => {
        core.configStore.reset();
        out('configuration reset to defaults');
      }).catch(exitFor);
    });
  config
    .command('token')
    .description('print the local API token (for the dashboard or curl)')
    .option('--rotate', 'generate a new token')
    .action(async (opts: { rotate?: boolean }) => {
      try {
        await withCore(async (core) => {
          const token = opts.rotate ? await core.apiToken.rotate() : await core.apiToken.get();
          out(token);
        });
      } catch (e) {
        exitFor(e);
      }
    });

  // ---------------------------------------------------------------- db
  const db = program.command('db').description('database maintenance');
  db.command('migrate')
    .description('apply pending migrations (used by the updater)')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      try {
        await withCore(async (core) => {
          const version = core.db.schemaVersion();
          if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, version, applied: [] })}\n`);
          else out(c.green(`database is at schema version ${version}`));
        });
      } catch (e) {
        if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, error: errorMessage(e) })}\n`);
        exitFor(e);
      }
    });
  db.command('backup')
    .description('write a consistent copy of the database')
    .option('--out <file>', 'destination file')
    .action(async (opts: { out?: string }) => {
      try {
        await withCore(async (core) => {
          const dest = opts.out ?? path.join(core.paths.backupsDir, 'db', `${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
          core.db.backupTo(dest);
          out(c.green(`backup written to ${dest}`));
        });
      } catch (e) {
        exitFor(e);
      }
    });
  db.command('stats')
    .description('row counts and file size')
    .action(async () => {
      await withCore(async (core) => {
        const stats = core.db.stats();
        if (json()) printJson(stats);
        else for (const [k, v] of Object.entries(stats)) out(`${k.padEnd(14)} ${k === 'sizeBytes' ? `${Math.round(Number(v) / 1024)} KB` : v}`);
      }).catch(exitFor);
    });

  // ---------------------------------------------------------------- serve
  program
    .command('serve')
    .description('run the API, dashboard, scheduler and approval poller in the foreground')
    .action(async () => {
      try {
        const core = await AppCore.create({});
        core.acquirePidLock();
        const { port, host } = await core.startApi();
        await core.startBackground();
        const token = await core.apiToken.get();
        out(c.bold(`Epic Claims v${APP_VERSION}`));
        out(`  dashboard  http://${host}:${port}/`);
        out(`  api token  ${token}`);
        out(c.dim('  press Ctrl+C to stop'));
        const shutdown = async (signal: string): Promise<void> => {
          out(c.dim(`\n${signal} received, shutting down…`));
          await core.stop();
          process.exit(EXIT_OK);
        };
        process.on('SIGINT', () => void shutdown('SIGINT'));
        process.on('SIGTERM', () => void shutdown('SIGTERM'));
        // keep the process alive
        await new Promise<void>(() => undefined);
      } catch (e) {
        exitFor(e);
      }
    });

  // ---------------------------------------------------------------- logs
  program
    .command('logs')
    .description('show the tail of the structured log')
    .option('-n, --lines <n>', 'lines to show', '40')
    .action(async (opts: { lines: string }) => {
      try {
        await withCore(async (core) => {
          const lines = core.fileSink.tail(Math.max(1, Number(opts.lines) || 40));
          for (const line of lines) {
            try {
              const rec = JSON.parse(line) as { ts: string; level: string; scope: string; msg: string };
              out(`${rec.ts.slice(11, 19)} ${rec.level.toUpperCase().padEnd(5)} ${rec.scope} ${rec.msg}`);
            } catch {
              out(line);
            }
          }
        });
      } catch (e) {
        exitFor(e);
      }
    });

  program.addHelpText(
    'after',
    `
Examples:
  epic-claims auth login                  # one-time Epic sign-in (opens a browser)
  epic-claims service install             # run in the background via launchd
  epic-claims status                      # what is happening right now
  epic-claims check --claim               # discover and redeem now
  epic-claims notifications test --adapter macos
  epic-claims update                      # download, verify, install, restart

Exit codes: 0 ok · 1 error · 2 usage · 3 authentication required · 4 busy/blocked
Documentation: https://github.com/DIY23/epic-claims
`,
  );

  return program;
}

function coerce(value: string, current: unknown): unknown {
  if (typeof current === 'boolean') return value === 'true' || value === '1' || value === 'yes';
  if (typeof current === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new AppError('CONFIG_INVALID', `expected a number, got "${value}"`);
    return n;
  }
  if (Array.isArray(current)) {
    try {
      return JSON.parse(value);
    } catch {
      throw new AppError('CONFIG_INVALID', 'value for an array setting must be JSON');
    }
  }
  return value;
}

async function main(): Promise<void> {
  // Compare *real* paths: the installed CLI is reached through the
  // "current" symlink (…/install/current/dist/cli/index.js), and Node resolves
  // that symlink for import.meta.url but not for argv[1].
  const entry = process.argv[1];
  if (entry === undefined) return;
  let isDirectRun = false;
  try {
    isDirectRun = fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    isDirectRun = path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  }
  if (!isDirectRun) return;
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((e) => {
  exitFor(e);
});

export { c as colours, out };
