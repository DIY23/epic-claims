import { AppError, toAppError } from './errors.js';

export interface RetryOptions {
  attempts?: number; // total attempts, >=1
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Return false to stop retrying immediately (e.g. a 401 that will not fix itself). */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof AppError) {
    if (err.code === 'RATE_LIMITED') return true;
    if (err.retryable) return true;
    return false;
  }
  return true;
}

/** Exponential backoff with full jitter. Deterministic when jitter is false. */
export function backoffDelay(attempt: number, baseDelayMs = 500, maxDelayMs = 30_000, jitter = true): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
  if (!jitter) return exp;
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const sleepFn = opts.sleep ?? sleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const canRetry = attempt < attempts && (opts.shouldRetry ?? defaultShouldRetry)(e, attempt);
      if (!canRetry) break;
      const delay = backoffDelay(attempt, opts.baseDelayMs ?? 500, opts.maxDelayMs ?? 30_000, opts.jitter ?? true);
      opts.onRetry?.(e, attempt, delay);
      await sleepFn(delay);
    }
  }
  throw toAppError(lastErr);
}

export interface HttpJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  /** Number of times to retry on HTTP 429 / 5xx beyond the initial attempt. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: RetryOptions['onRetry'];
}

export interface HttpJsonResponse<T> {
  status: number;
  headers: Headers;
  data: T;
  attempts: number;
}

/**
 * JSON over HTTP with hard timeouts, bounded retries and explicit error mapping.
 * Never throws a bare fetch error: callers get an AppError with a code.
 */
export async function httpJson<T>(url: string, opts: HttpJsonOptions = {}): Promise<HttpJsonResponse<T>> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const retries = opts.retries ?? 2;
  let attempts = 0;

  const run = async (attempt: number): Promise<HttpJsonResponse<T>> => {
    attempts = attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const outerSignal = opts.signal;
    const onAbort = () => controller.abort();
    outerSignal?.addEventListener('abort', onAbort);
    try {
      const res = await doFetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '0');
        throw new AppError('RATE_LIMITED', `rate limited by ${new URL(url).host}`, { retryAfterSec: retryAfter, status: 429 }, true);
      }
      if (res.status >= 500) {
        throw new AppError('HTTP_ERROR', `server error ${res.status} from ${new URL(url).host}`, { status: res.status }, true);
      }
      if (!res.ok) {
        const text = await safeText(res);
        throw new AppError('HTTP_ERROR', `HTTP ${res.status} from ${new URL(url).pathname}`, { status: res.status, body: text.slice(0, 500) });
      }
      const text = await res.text();
      let data: unknown = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new AppError('STORE_INVALID_RESPONSE', 'response was not valid JSON', { preview: text.slice(0, 200) });
        }
      }
      return { status: res.status, headers: res.headers, data: data as T, attempts };
    } catch (e) {
      if (e instanceof AppError) throw e;
      const name = (e as Error)?.name;
      if (name === 'AbortError') throw new AppError('TIMEOUT', `request to ${new URL(url).host} timed out after ${timeoutMs}ms`, {}, true);
      throw toAppError(e, 'NETWORK');
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onAbort);
    }
  };

  return retry(run, {
    attempts: retries + 1,
    baseDelayMs: 750,
    maxDelayMs: 15_000,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.onRetry ? { onRetry: opts.onRetry } : {}),
    shouldRetry: (err) => defaultShouldRetry(err) || (err instanceof AppError && err.code === 'HTTP_ERROR' && Number(err.context.status ?? 0) >= 500),
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
