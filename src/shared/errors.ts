/** Domain error codes. Every failure that matters is a code, not a prose message. */
export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'AUTH_FAILED'
  | 'AUTH_INTERRUPTED'
  | 'KEYCHAIN_UNAVAILABLE'
  | 'KEYCHAIN_LOCKED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'HTTP_ERROR'
  | 'STORE_INVALID_RESPONSE'
  | 'OFFER_NOT_FREE'
  | 'OFFER_EXPIRED'
  | 'OFFER_NOT_FOUND'
  | 'ALREADY_OWNED'
  | 'CLAIM_REJECTED'
  | 'CLAIM_UNVERIFIED'
  | 'CLAIM_IN_PROGRESS'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_INVALID_TOKEN'
  | 'POLICY_SKIPPED'
  | 'CONFIG_INVALID'
  | 'DB_ERROR'
  | 'NOTIFICATION_FAILED'
  | 'UPDATE_UNAVAILABLE'
  | 'UPDATE_VERIFICATION_FAILED'
  | 'UPDATE_INSTALL_FAILED'
  | 'UPDATE_HEALTH_FAILED'
  | 'UPDATE_ROLLED_BACK'
  | 'UPDATE_BUSY'
  | 'SERVICE_ERROR'
  | 'UNSUPPORTED_PLATFORM'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly context: Record<string, unknown> = {},
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, retryable: this.retryable, ...this.context };
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function toAppError(e: unknown, fallback: ErrorCode = 'INTERNAL'): AppError {
  if (isAppError(e)) return e;
  if (e instanceof Error) {
    if (e.name === 'AbortError' || /timeout/i.test(e.message)) return new AppError('TIMEOUT', e.message, {}, true);
    if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(e.message)) return new AppError('NETWORK', e.message, {}, true);
    return new AppError(fallback, e.message);
  }
  return new AppError(fallback, String(e));
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
