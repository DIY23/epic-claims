import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

const REDACT_KEYS = /^(access_?token|refresh_?token|authorization|cookie|password|secret|token|api_?token|signature|client_secret|set-cookie)$/i;

/** Recursively redacts obvious secrets so nothing sensitive can reach a log file. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length > 4096) return `${value.slice(0, 4096)}…[truncated]`;
    return value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export class Logger {
  private readonly sinks: LogSink[] = [];
  constructor(
    readonly scope: string,
    private level: LogLevel = 'info',
    private readonly extra: Record<string, unknown> = {},
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  child(scope: string, extra: Record<string, unknown> = {}): Logger {
    const l = new Logger(`${this.scope}.${scope}`, this.level, { ...this.extra, ...extra });
    for (const s of this.sinks) l.sinks.push(s);
    return l;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.write('debug', msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.write('info', msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.write('warn', msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.write('error', msg, data);
  }

  /** Structured error log that never leaks a stack trace's message twice. */
  exception(msg: string, err: unknown, data: Record<string, unknown> = {}): void {
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
    this.write('error', msg, { ...data, error_name: e.name, error_message: e.message });
  }

  private write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      msg,
      ...(data ? { data: { ...this.extra, ...(redact(data) as Record<string, unknown>) } } : Object.keys(this.extra).length ? { data: redact(this.extra) as Record<string, unknown> } : {}),
    };
    for (const sink of this.sinks) {
      try {
        sink(record);
      } catch {
        /* a broken sink must never break the caller */
      }
    }
  }
}

/** Console sink: human readable on a TTY, JSON lines when piped (launchd). */
export function consoleSink(stream: { write(s: string): boolean } = process.stderr, tty = process.stderr.isTTY === true): LogSink {
  return (r: LogRecord) => {
    if (tty) {
      const time = r.ts.slice(11, 19);
      const lvl = r.level.toUpperCase().padEnd(5);
      const data = r.data && Object.keys(r.data).length ? ` ${JSON.stringify(r.data)}` : '';
      stream.write(`${time} ${lvl} ${r.scope} ${r.msg}${data}\n`);
    } else {
      stream.write(`${JSON.stringify(r)}\n`);
    }
  };
}

export function memorySink(out: LogRecord[] = []): LogSink & { records: LogRecord[] } {
  const sink = ((r: LogRecord) => {
    out.push(r);
  }) as LogSink & { records: LogRecord[] };
  sink.records = out;
  return sink;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // constant-time-ish comparison on equal-length digests
    const ha = createHash('sha256').update(ab).digest();
    const hb = createHash('sha256').update(bb).digest();
    return timingSafeEqual(ha, hb);
  }
  return timingSafeEqual(ab, bb);
}
