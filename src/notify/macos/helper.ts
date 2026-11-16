import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError, errorMessage } from '../../shared/errors.js';

const execFileAsync = promisify(execFile);

export const HELPER_BUNDLE_NAME = 'EpicClaimsNotifier.app';
export const HELPER_EXECUTABLE = 'EpicClaimsNotifier';
export const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export interface HelperLocation {
  bundlePath: string;
  executable: string;
  present: boolean;
  signed: boolean;
}

export interface HelperStatus {
  ok: boolean;
  authorizationStatus: number;
  alertSetting: number;
  notificationCenterSetting: number;
  soundSetting: number;
  detail?: string;
}

export interface PostRequest {
  /** Stable identifier — re-posting the same id replaces the pending notification. */
  id: string;
  title: string;
  subtitle: string;
  body: string;
  sound: boolean;
  /** Interactive buttons; the helper POSTs the approval decision when clicked. */
  actions: Array<{ id: 'claim' | 'skip'; title: string }>;
  approvalToken: string;
  approvalBase: string;
}

export interface HelperAction {
  event: 'action';
  id: string;
  action: 'claim' | 'skip' | 'default' | 'dismiss';
  token: string;
  ts: number;
}

/**
 * Locates the native notification helper. It ships inside the installed version
 * directory (native/EpicClaimsNotifier.app), so an update replaces it together
 * with the JavaScript and the app can never run mismatched halves.
 */
/** PIDs of helper processes already bound to this socket path. */
export function helperPids(socketPath: string): number[] {
  try {
    const result = spawnSync('ps', ['-Ao', 'pid,command'], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .split('\n')
      .filter((line: string) => line.includes('EpicClaimsNotifier') && line.includes(`--socket ${socketPath}`))
      .map((line: string) => Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10))
      .filter((pid: number) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

export function locateHelper(candidates: Array<string | null | undefined>, explicitPath?: string | null): HelperLocation {
  const paths: string[] = [];
  if (explicitPath) paths.push(explicitPath);
  for (const c of candidates) if (c) paths.push(c);
  for (const p of paths) {
    const exe = path.join(p, 'Contents', 'MacOS', HELPER_EXECUTABLE);
    if (fs.existsSync(exe)) return { bundlePath: p, executable: exe, present: true, signed: checkSignature(p) };
  }
  return { bundlePath: paths[0] ?? '', executable: '', present: false, signed: false };
}

function checkSignature(bundle: string): boolean {
  try {
    return spawnSync('/usr/bin/codesign', ['-dv', bundle], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/** Registers the bundle with LaunchServices so a notification click can launch it. */
export async function registerBundle(bundlePath: string): Promise<boolean> {
  try {
    await execFileAsync(LSREGISTER, ['-f', bundlePath], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

export interface HelperPaths {
  socket: string;
  actionsLog: string;
}

export function helperPaths(dataDir: string): HelperPaths {
  const dir = path.join(dataDir, 'notifier');
  return { socket: path.join(dir, 'helper.sock'), actionsLog: path.join(dir, 'actions.log') };
}

/**
 * Client for the resident UserNotifications helper.
 *
 * The helper is a frozen, generic transport: it posts whatever JSON it is given
 * and reports clicks by posting the single-use approval token back to the local
 * API (and appending a durable line to actions.log). Keeping it behaviour-free
 * means releases rarely change the binary — which matters, because re-signing an
 * ad-hoc bundle resets the user's notification authorization.
 */
export class NotifierClient {
  private readonly paths: HelperPaths;

  constructor(
    private readonly opts: {
      location: HelperLocation;
      dataDir: string;
      startupTimeoutMs?: number;
      commandTimeoutMs?: number;
    },
  ) {
    this.paths = helperPaths(opts.dataDir);
  }

  get socketPath(): string {
    return this.paths.socket;
  }

  get actionsLogPath(): string {
    return this.paths.actionsLog;
  }

  get available(): boolean {
    return this.opts.location.present;
  }

  private async connect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.paths.socket });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new AppError('NOTIFICATION_FAILED', 'notification helper did not accept a connection in time'));
      }, 2000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  private async command(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = await this.connect();
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        let buffer = '';
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new AppError('NOTIFICATION_FAILED', 'notification helper did not reply in time'));
        }, this.opts.commandTimeoutMs ?? 10_000);
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          if (!buffer.includes('\n')) return;
          clearTimeout(timeout);
          const line = buffer.split('\n')[0] ?? '';
          socket.end();
          try {
            resolve(JSON.parse(line) as Record<string, unknown>);
          } catch (e) {
            reject(new AppError('NOTIFICATION_FAILED', `helper sent invalid JSON: ${(e as Error).message}`));
          }
        });
        socket.on('error', (e) => {
          clearTimeout(timeout);
          reject(new AppError('NOTIFICATION_FAILED', errorMessage(e)));
        });
        socket.write(`${JSON.stringify(payload)}\n`);
      });
    } finally {
      socket.destroy();
    }
  }

  /** Starts the helper through LaunchServices and waits for its socket. */
  async ensureRunning(): Promise<boolean> {
    if (!this.opts.location.present) return false;
    try {
      const socket = await this.connect();
      socket.destroy();
      return true;
    } catch {
      /* not running yet */
    }
    // Only one helper may own the socket: a second instance unlinks and rebinds it,
    // which silently steals deliveries from the running service (three helpers were
    // seen alive at once). If a process is already bound to this socket, wait for
    // it instead of starting another.
    const running = helperPids(this.paths.socket);
    if (running.length > 0) {
      for (let i = 0; i < 25; i += 1) {
        try {
          const socket = await this.connect();
          socket.destroy();
          return true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      // Bound but unresponsive: replace the stale instances.
      for (const pid of running) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    fs.mkdirSync(path.dirname(this.paths.socket), { recursive: true, mode: 0o700 });
    // Executing the binary inside the bundle is what actually works: `open -g -n -a
    // <bundle> --args …` reported success but the process never picked the arguments
    // up, so no socket appeared. LaunchServices registration (done once at install)
    // is what makes a notification *click* able to relaunch the helper.
    // Keep the helper's own output: when it refuses to start, its stderr is the
    // only evidence (silent failures are the norm for LSUIElement apps).
    let logFd: number | null = null;
    try {
      logFd = fs.openSync(path.join(path.dirname(this.paths.socket), 'helper.log'), 'a');
    } catch {
      logFd = null;
    }
    try {
      const child = spawn(this.opts.location.executable, ['--socket', this.paths.socket, '--actions-log', this.paths.actionsLog], {
        detached: true,
        stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      });
      child.unref();
    } catch (e) {
      if (logFd !== null) fs.closeSync(logFd);
      throw new AppError('NOTIFICATION_FAILED', `cannot start the notification helper: ${errorMessage(e)}`);
    } finally {
      if (logFd !== null) {
        // The child holds its own descriptor; close ours.
        try { fs.closeSync(logFd); } catch { /* ignore */ }
      }
    }
    const deadline = Date.now() + (this.opts.startupTimeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      try {
        const socket = await this.connect();
        socket.destroy();
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return false;
  }

  async status(): Promise<HelperStatus> {
    const reply = await this.command({ cmd: 'status' });
    return {
      ok: reply.ok === true,
      authorizationStatus: Number(reply.authorizationStatus ?? 0),
      alertSetting: Number(reply.alertSetting ?? 0),
      notificationCenterSetting: Number(reply.notificationCenterSetting ?? 0),
      soundSetting: Number(reply.soundSetting ?? 0),
      ...(typeof reply.error === 'string' ? { detail: reply.error } : {}),
    };
  }

  /** Requests authorization. May block behind an unanswered system prompt. */
  async authorize(timeoutMs = 30_000): Promise<{ granted: boolean; authorizationStatus: number }> {
    const socket = await this.connect();
    try {
      return await new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new AppError('TIMEOUT', 'the authorization prompt is still unanswered (a human must approve it once)'));
        }, timeoutMs);
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          if (!buffer.includes('\n')) return;
          clearTimeout(timer);
          socket.end();
          const reply = JSON.parse(buffer.split('\n')[0] ?? '{}') as Record<string, unknown>;
          resolve({ granted: reply.granted === true, authorizationStatus: Number(reply.authorizationStatus ?? 0) });
        });
        socket.on('error', (e) => {
          clearTimeout(timer);
          reject(new AppError('NOTIFICATION_FAILED', errorMessage(e)));
        });
        socket.write(`${JSON.stringify({ cmd: 'authorize' })}\n`);
      });
    } finally {
      socket.destroy();
    }
  }

  async post(request: PostRequest): Promise<{ ok: boolean; error?: string }> {
    const reply = await this.command({ cmd: 'post', ...request });
    return { ok: reply.ok === true, ...(typeof reply.error === 'string' ? { error: reply.error } : {}) };
  }

  /**
   * Reads new lines from the durable actions log. The helper appends before it
   * acts on a click, so nothing is lost when the application restarts.
   */
  drainActions(offsetFile: string): HelperAction[] {
    const actions: HelperAction[] = [];
    let offset = 0;
    try {
      offset = Number(fs.readFileSync(offsetFile, 'utf8').trim()) || 0;
    } catch {
      offset = 0;
    }
    try {
      const size = fs.statSync(this.paths.actionsLog).size;
      if (size < offset) offset = 0;
      if (size === offset) return actions;
      const fd = fs.openSync(this.paths.actionsLog, 'r');
      try {
        const length = size - offset;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, offset);
        for (const line of buffer.toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as HelperAction;
            if (parsed.event === 'action') actions.push(parsed);
          } catch {
            /* skip a torn line */
          }
        }
      } finally {
        fs.closeSync(fd);
      }
      fs.mkdirSync(path.dirname(offsetFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(offsetFile, String(size), { mode: 0o600 });
    } catch {
      /* missing log = no actions */
    }
    return actions;
  }
}

/** Plain notification with no actions, used when the helper is unavailable. */
export async function osascriptNotification(title: string, subtitle: string, body: string, sound: boolean): Promise<{ ok: boolean; message: string }> {
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const script = [
    `display notification "${esc(body)}"`,
    `with title "${esc(title)}"`,
    subtitle ? `subtitle "${esc(subtitle)}"` : '',
    sound ? 'sound name "default"' : '',
  ]
    .filter(Boolean)
    .join(' ');
  try {
    await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 10_000 });
    return { ok: true, message: 'delivered via osascript (no action buttons)' };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}

/** Human-readable authorization state for the dashboard and CLI. */
export function describeAuthorization(status: HelperStatus): string {
  const map: Record<number, string> = { 0: 'not determined (never approved)', 1: 'denied', 2: 'authorized', 3: 'provisional', 4: 'ephemeral' };
  const base = map[status.authorizationStatus] ?? `unknown (${status.authorizationStatus})`;
  if (status.authorizationStatus === 2 && status.alertSetting !== 2) return `${base}, but banners are off (Notification Center only)`;
  return base;
}
