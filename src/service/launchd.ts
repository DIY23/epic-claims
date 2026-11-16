import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError, errorMessage } from '../shared/errors.js';
import type { AppPaths } from '../shared/paths.js';
import type { ServiceControl } from '../update/installer.js';

const execFileAsync = promisify(execFile);

export interface LaunchdOptions {
  label: string;
  paths: AppPaths;
  /** Absolute path of the node binary that runs the app. */
  nodePath: string;
  /** Absolute path of the CLI entry point (usually <install>/current/dist/cli/index.js). */
  cliPath: string;
  keepAlive: boolean;
  startAtLogin: boolean;
}

export interface ServiceStatus {
  label: string;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  pid: number | null;
  lastExitCode: number | null;
  plistPath: string;
  detail: string;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function run(cmd: string, args: string[], timeout = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

export function renderPlist(opts: LaunchdOptions): string {
  const { label, paths, nodePath, cliPath } = opts;
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodePath)}</string>
    <string>${esc(cliPath)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <${opts.startAtLogin ? 'true' : 'false'}/>
  <key>KeepAlive</key>
  <${opts.keepAlive ? 'true' : 'false'}/>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${esc(paths.dataDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EPIC_CLAIMS_HOME</key>
    <string>${esc(paths.dataDir)}</string>
    <key>EPIC_CLAIMS_LOGS</key>
    <string>${esc(paths.logsDir)}</string>
    <key>EPIC_CLAIMS_INSTALL_ROOT</key>
    <string>${esc(paths.installRoot)}</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${esc(path.join(paths.logsDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(path.join(paths.logsDir, 'launchd.err.log'))}</string>
</dict>
</plist>
`;
}

/**
 * launchd user agent management. A gui/$UID agent needs no elevation, starts at
 * login and keeps running while the screen is locked.
 */
export class LaunchdService implements ServiceControl {
  constructor(private readonly opts: LaunchdOptions) {}

  get label(): string {
    return this.opts.label;
  }

  get plistPath(): string {
    return this.opts.paths.servicePlist;
  }

  async isLoaded(): Promise<boolean> {
    const res = await run('/bin/launchctl', ['print', `${domain()}/${this.opts.label}`]);
    return res.code === 0;
  }

  async status(): Promise<ServiceStatus> {
    const installed = fs.existsSync(this.plistPath);
    const res = await run('/bin/launchctl', ['print', `${domain()}/${this.opts.label}`]);
    if (res.code !== 0) {
      return {
        label: this.opts.label,
        installed,
        loaded: false,
        running: false,
        pid: null,
        lastExitCode: null,
        plistPath: this.plistPath,
        detail: installed ? 'installed but not loaded (load it or log in again)' : 'not installed',
      };
    }
    const pidMatch = /\bpid = (\d+)/.exec(res.stdout);
    const stateMatch = /state = ([a-zA-Z]+)/.exec(res.stdout);
    const exitMatch = /last exit code = (-?\d+)/.exec(res.stdout);
    return {
      label: this.opts.label,
      installed,
      loaded: true,
      running: pidMatch !== null,
      pid: pidMatch?.[1] ? Number(pidMatch[1]) : null,
      lastExitCode: exitMatch?.[1] ? Number(exitMatch[1]) : null,
      plistPath: this.plistPath,
      detail: stateMatch?.[1] ?? (pidMatch ? 'running' : 'loaded, not running'),
    };
  }

  /** Writes the plist and loads the agent. Idempotent. */
  /** True when the on-disk plist does not match the desired arguments. */
  needsRewrite(): boolean {
    try {
      const current = fs.readFileSync(this.plistPath, 'utf8');
      return current !== renderPlist(this.opts);
    } catch {
      return true;
    }
  }

  /** Rewrites the plist when its rendered form differs from what is on disk. */
  async repairPlist(): Promise<boolean> {
    if (!fs.existsSync(this.plistPath)) return false;
    if (!this.needsRewrite()) return false;
    try {
      fs.writeFileSync(this.plistPath, renderPlist(this.opts), { mode: 0o644 });
      return true;
    } catch {
      return false;
    }
  }

  async install(): Promise<{ ok: boolean; message: string }> {
    try {
      fs.mkdirSync(path.dirname(this.plistPath), { recursive: true });
      fs.mkdirSync(this.opts.paths.logsDir, { recursive: true });
      fs.mkdirSync(this.opts.paths.dataDir, { recursive: true });
      fs.writeFileSync(this.plistPath, renderPlist(this.opts), { mode: 0o644 });
    } catch (e) {
      return { ok: false, message: `cannot write ${this.plistPath}: ${errorMessage(e)}` };
    }

    if (await this.isLoaded()) {
      await this.restart();
      return { ok: true, message: `reloaded ${this.opts.label}` };
    }
    const boot = await run('/bin/launchctl', ['bootstrap', domain(), this.plistPath]);
    if (boot.code !== 0) {
      return {
        ok: false,
        message: `launchctl bootstrap failed: ${boot.stderr.trim() || `exit ${boot.code}`}`,
      };
    }
    return { ok: true, message: `loaded ${this.opts.label}` };
  }

  async uninstall(): Promise<{ ok: boolean; message: string }> {
    if (await this.isLoaded()) {
      const out = await run('/bin/launchctl', ['bootout', `${domain()}/${this.opts.label}`]);
      if (out.code !== 0) return { ok: false, message: `launchctl bootout failed: ${out.stderr.trim()}` };
    }
    try {
      if (fs.existsSync(this.plistPath)) fs.rmSync(this.plistPath);
    } catch (e) {
      return { ok: false, message: `cannot remove ${this.plistPath}: ${errorMessage(e)}` };
    }
    return { ok: true, message: `unloaded and removed ${this.opts.label}` };
  }

  async start(): Promise<{ ok: boolean; message: string }> {
    if (!fs.existsSync(this.plistPath)) return { ok: false, message: 'service is not installed (run: epic-claims service install)' };
    if (!(await this.isLoaded())) {
      const boot = await run('/bin/launchctl', ['bootstrap', domain(), this.plistPath]);
      if (boot.code !== 0) return { ok: false, message: `launchctl bootstrap failed: ${boot.stderr.trim()}` };
    }
    const res = await run('/bin/launchctl', ['kickstart', '-k', `${domain()}/${this.opts.label}`]);
    return res.code === 0 ? { ok: true, message: 'started' } : { ok: false, message: res.stderr.trim() || `exit ${res.code}` };
  }

  async stop(): Promise<{ ok: boolean; message: string }> {
    if (!(await this.isLoaded())) return { ok: true, message: 'not running' };
    const res = await run('/bin/launchctl', ['bootout', `${domain()}/${this.opts.label}`]);
    return res.code === 0 ? { ok: true, message: 'stopped' } : { ok: false, message: res.stderr.trim() || `exit ${res.code}` };
  }

  /**
   * Restarts the agent.
   *
   * `kickstart -k` alone is a trap for updates: the new process can start while
   * the old one is still holding the API port, fail to bind, and be throttled by
   * KeepAlive — during which the health probe still sees the old version. A hard
   * restart unloads the job, waits for the process to disappear, then loads it
   * again, so the next process always sees the freshly flipped binary.
   */
  async restart(opts: { hard?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
    if (!fs.existsSync(this.plistPath)) {
      return { ok: false, message: 'service is not installed; the running process keeps the old binary until restarted manually' };
    }
    if (!opts.hard) {
      if (!(await this.isLoaded())) return this.start();
      const res = await run('/bin/launchctl', ['kickstart', '-k', `${domain()}/${this.opts.label}`]);
      if (res.code !== 0) return { ok: false, message: res.stderr.trim() || `exit ${res.code}` };
      return { ok: true, message: 'restarted' };
    }

    if (await this.isLoaded()) {
      await run('/bin/launchctl', ['bootout', `${domain()}/${this.opts.label}`]);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && (await this.isLoaded())) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (await this.isLoaded()) return { ok: false, message: 'could not stop the running agent' };
    }
    // Give the socket a moment to be released by the kernel.
    await new Promise((r) => setTimeout(r, 500));
    const boot = await run('/bin/launchctl', ['bootstrap', domain(), this.plistPath]);
    if (boot.code !== 0) return { ok: false, message: `launchctl bootstrap failed: ${boot.stderr.trim() || `exit ${boot.code}`}` };
    return { ok: true, message: 'restarted (hard)' };
  }

  /** Prints the plist to stdout for review. */
  preview(): string {
    return renderPlist(this.opts);
  }

  assertDarwin(): void {
    if (process.platform !== 'darwin') throw new AppError('UNSUPPORTED_PLATFORM', 'launchd is only available on macOS');
  }
}
