import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../shared/errors.js';
import { configSchema, describeIssues, type Config } from './schema.js';
import { defaultConfig, mergeConfig } from './defaults.js';

/**
 * Removes configuration belonging to adapters this version no longer ships
 * (iMessage was removed in 2.0.0). Strict validation would otherwise reject an
 * existing config.json, and an update must never break a running install.
 */
export function pruneLegacyAdapters(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const config = raw as Record<string, unknown>;
  const notifications = config.notifications as Record<string, unknown> | undefined;
  if (!notifications || typeof notifications !== 'object') return raw;
  const adapters = notifications.adapters as Record<string, unknown> | undefined;
  if (adapters) delete adapters.imessage;
  const templates = notifications.templates as Record<string, unknown> | undefined;
  if (templates) delete templates.imessage;
  const events = notifications.events as Record<string, Record<string, unknown>> | undefined;
  if (events) {
    for (const toggle of Object.values(events)) {
      if (toggle && typeof toggle === 'object') delete toggle.imessage;
    }
  }
  return config;
}

export interface ConfigStoreOptions {
  filePath: string;
  /** Create the file (and its directory) with defaults when missing. */
  createIfMissing?: boolean;
}

/**
 * config.json lives in the data directory and is never touched by the updater.
 * Writes are atomic (tmp + rename) with 0600 permissions.
 */
export class ConfigStore {
  private cached: Config | null = null;

  constructor(private readonly opts: ConfigStoreOptions) {}

  get path(): string {
    return this.opts.filePath;
  }

  load(): Config {
    if (this.transient) return this.transient;
    if (this.cached) return this.cached;
    if (!fs.existsSync(this.opts.filePath)) {
      if (this.opts.createIfMissing === false) {
        this.cached = configSchema.parse(defaultConfig());
        return this.cached;
      }
      const cfg = configSchema.parse(defaultConfig());
      this.write(cfg);
      this.cached = cfg;
      return cfg;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.opts.filePath, 'utf8'));
    } catch (e) {
      throw new AppError('CONFIG_INVALID', `cannot read ${this.opts.filePath}: ${(e as Error).message}`, { file: this.opts.filePath });
    }
    const pruned = pruneLegacyAdapters(raw) as Record<string, unknown>;
    const merged = mergeConfig(defaultConfig(), pruned);
    const parsed = configSchema.safeParse(merged);
    if (!parsed.success) {
      const issues = describeIssues(parsed.error);
      throw new AppError('CONFIG_INVALID', `config.json is invalid: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`, { issues });
    }
    this.cached = parsed.data;
    // If the file carried settings for adapters this version no longer ships,
    // write the cleaned form back so the on-disk file stops advertising them.
    if (JSON.stringify(pruned) !== JSON.stringify(raw)) {
      try {
        this.write(parsed.data);
      } catch {
        /* a read-only data dir must not break startup */
      }
    }
    return parsed.data;
  }

  /** Replace the whole configuration (validated first, then written atomically). */
  save(next: unknown): Config {
    const parsed = configSchema.safeParse(next);
    if (!parsed.success) {
      const issues = describeIssues(parsed.error);
      throw new AppError('CONFIG_INVALID', `refusing to save invalid config: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`, { issues });
    }
    this.write(parsed.data);
    this.cached = parsed.data;
    return parsed.data;
  }

  /** Shallow-merge a patch (arrays replace) and persist. */
  update(patch: unknown): Config {
    const current = this.load();
    const merged = mergeConfig(current, patch);
    return this.save(merged);
  }

  reset(): Config {
    const cfg = configSchema.parse(defaultConfig());
    this.write(cfg);
    this.cached = cfg;
    return cfg;
  }

  invalidate(): void {
    this.cached = null;
  }

  /**
   * Applies an in-memory override for the lifetime of `fn` (never written to
   * disk). Used by "check --dry-run"-style commands and by tests.
   */
  async withTransient<T>(patch: unknown, fn: () => Promise<T>): Promise<T> {
    const previous = this.transient;
    this.transient = configSchema.parse(mergeConfig(this.load(), patch));
    try {
      return await fn();
    } finally {
      this.transient = previous;
    }
  }

  private transient: Config | null = null;

  private write(cfg: Config): void {
    const dir = path.dirname(this.opts.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.opts.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.opts.filePath);
  }
}
