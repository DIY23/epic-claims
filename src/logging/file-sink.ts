import fs from 'node:fs';
import path from 'node:path';
import type { LogRecord, LogSink } from '../shared/logger.js';

export interface FileSinkOptions {
  dir: string;
  filename?: string;
  maxFileBytes?: number;
  maxFiles?: number;
}

/**
 * Append-only JSON-lines log with size-based rotation.
 * Never throws: a full disk must not take the claim engine down.
 */
export class RotatingFileSink {
  readonly sink: LogSink;
  private stream: fs.WriteStream | null = null;
  private currentSize = 0;
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(private readonly opts: FileSinkOptions) {
    this.file = path.join(opts.dir, opts.filename ?? 'epic-claims.log');
    this.maxBytes = opts.maxFileBytes ?? 10 * 1024 * 1024;
    this.maxFiles = opts.maxFiles ?? 7;
    this.open();
    this.sink = (record: LogRecord) => this.write(record);
  }

  get path(): string {
    return this.file;
  }

  private open(): void {
    try {
      fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o755 });
      this.currentSize = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      this.stream = fs.createWriteStream(this.file, { flags: 'a', mode: 0o644 });
      this.stream.on('error', () => {
        this.stream = null;
      });
    } catch {
      this.stream = null;
    }
  }

  private write(record: LogRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    try {
      if (!this.stream) this.open();
      if (!this.stream) return;
      this.stream.write(line);
      this.currentSize += Buffer.byteLength(line);
      if (this.currentSize >= this.maxBytes) this.rotate();
    } catch {
      /* never propagate */
    }
  }

  private rotate(): void {
    try {
      this.stream?.end();
      this.stream = null;
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
        const to = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      // Delete everything beyond the retention window.
      const extra = `${this.file}.${this.maxFiles}`;
      if (fs.existsSync(extra)) fs.rmSync(extra, { force: true });
      this.currentSize = 0;
      this.open();
    } catch {
      /* ignore rotation failures, the next write retries */
    }
  }

  close(): void {
    try {
      this.stream?.end();
    } catch {
      /* ignore */
    }
    this.stream = null;
  }

  /** Reads the last N lines across rotated files, newest last. */
  tail(lines = 200): string[] {
    const out: string[] = [];
    for (let i = this.maxFiles - 1; i >= 0; i--) {
      const file = i === 0 ? this.file : `${this.file}.${i}`;
      try {
        if (!fs.existsSync(file)) continue;
        const content = fs.readFileSync(file, 'utf8').trim();
        if (content) out.push(...content.split('\n'));
      } catch {
        /* ignore */
      }
    }
    return out.slice(-lines);
  }
}
