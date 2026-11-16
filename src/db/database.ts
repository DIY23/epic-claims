import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../shared/errors.js';
import { MIGRATIONS, type Migration } from './migrations.js';
import type { Logger } from '../shared/logger.js';

export type Row = Record<string, unknown>;

export interface DatabaseOptions {
  file: string;
  logger?: Logger;
  /** In-memory database for tests (file: ':memory:'). */
  readonly?: boolean;
}

/**
 * Thin, synchronous SQLite wrapper over Node's built-in node:sqlite.
 * Chosen over a native addon so that updating the app never has to rebuild
 * native modules — the updater only replaces JavaScript.
 */
export class Database {
  private db: DatabaseSync | null = null;
  private depth = 0;

  constructor(private readonly opts: DatabaseOptions) {}

  get file(): string {
    return this.opts.file;
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  open(): void {
    if (this.db) return;
    const inMemory = this.opts.file === ':memory:';
    if (!inMemory) {
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(this.opts.file, { readOnly: this.opts.readonly === true && !inMemory });
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    if (!this.opts.readonly) {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* already closed */
      }
      this.db = null;
    }
  }

  private handle(): DatabaseSync {
    if (!this.db) this.open();
    return this.db!;
  }

  exec(sql: string): void {
    this.handle().exec(sql);
  }

  all<T = Row>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.handle().prepare(sql);
    return stmt.all(...(params as never[])) as unknown as T[];
  }

  get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
    const stmt = this.handle().prepare(sql);
    return stmt.get(...(params as never[])) as unknown as T | undefined;
  }

  run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number } {
    const stmt = this.handle().prepare(sql);
    const res = stmt.run(...(params as never[]));
    return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
  }

  /** BEGIN/COMMIT with nesting via savepoints; rolls back on throw. */
  transaction<T>(fn: () => T): T {
    this.handle();
    const isOuter = this.depth === 0;
    const savepoint = `sp_${this.depth}`;
    if (isOuter) this.exec('BEGIN IMMEDIATE');
    else this.exec(`SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      if (isOuter) this.exec('COMMIT');
      else this.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (e) {
      this.depth--;
      try {
        if (isOuter) this.exec('ROLLBACK');
        else this.exec(`ROLLBACK TO ${savepoint}`);
      } catch {
        /* the transaction may already be gone */
      }
      throw e instanceof AppError ? e : new AppError('DB_ERROR', (e as Error).message);
    }
  }

  schemaVersion(): number {
    try {
      const row = this.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations');
      return Number(row?.v ?? 0);
    } catch {
      return 0;
    }
  }

  /** Applies every migration newer than the current version. Returns applied versions. */
  migrate(migrations: Migration[] = MIGRATIONS): number[] {
    this.open();
    readEnsureMigrationsTable(this);
    const current = this.schemaVersion();
    const pending = [...migrations].filter((m) => m.version > current).sort((a, b) => a.version - b.version);
    const applied: number[] = [];
    for (const m of pending) {
      this.transaction(() => {
        this.exec(m.sql);
        this.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, new Date().toISOString()]);
      });
      applied.push(m.version);
      this.opts.logger?.info('migration applied', { version: m.version, name: m.name });
    }
    return applied;
  }

  /** Consistent point-in-time copy, safe while the app is running. */
  backupTo(destFile: string): void {
    fs.mkdirSync(path.dirname(destFile), { recursive: true, mode: 0o700 });
    if (fs.existsSync(destFile)) fs.rmSync(destFile);
    try {
      this.exec(`VACUUM INTO '${destFile.replace(/'/g, "''")}'`);
      fs.chmodSync(destFile, 0o600);
    } catch (e) {
      throw new AppError('DB_ERROR', `backup failed: ${(e as Error).message}`, { destFile });
    }
  }

  integrityCheck(): boolean {
    try {
      const row = this.get<{ integrity_check: string }>('PRAGMA integrity_check');
      return row?.integrity_check === 'ok';
    } catch {
      return false;
    }
  }

  stats(): { offers: number; claims: number; approvals: number; notifications: number; sizeBytes: number } {
    const num = (sql: string): number => Number(this.get<{ c: number }>(sql)?.c ?? 0);
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(this.opts.file).size;
    } catch {
      sizeBytes = 0;
    }
    return {
      offers: num('SELECT COUNT(*) AS c FROM offers'),
      claims: num('SELECT COUNT(*) AS c FROM claim_attempts'),
      approvals: num('SELECT COUNT(*) AS c FROM approvals'),
      notifications: num('SELECT COUNT(*) AS c FROM notifications'),
      sizeBytes,
    };
  }
}

function readEnsureMigrationsTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

export { DatabaseSync };
