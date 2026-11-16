export interface ApiError {
  error: string;
  message: string;
}

const TOKEN_KEY = 'epic-claims-token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    throw new ApiClientError(401, 'AUTH_FAILED', 'The API token is missing or no longer valid.');
  }
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = body as ApiError | null;
    throw new ApiClientError(res.status, err?.error ?? 'ERROR', err?.message ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const get = <T>(path: string): Promise<T> => api<T>(path);
export const post = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
export const put = <T>(path: string, body: unknown): Promise<T> => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });

export interface StatusResponse {
  version: string;
  uptimeSec: number;
  startedAt: string;
  store: { id: string; name: string; auth: { authenticated: boolean; accountName: string | null; detail: string; expiresAt: string | null } };
  mode: string;
  dryRun: boolean;
  scheduler: { running: boolean; lastCheckAt: string | null; nextCheckAt: string | null; intervalHours: number; lastError: string | null; lastSummary: Record<string, number> | null };
  counts: Record<string, number>;
  approvalsPending: number;
  service: { loaded: boolean; running: boolean; pid: number | null; detail: string } | null;
  updates: { installedVersion: string; lastCheckAt: string | null; lastAvailableVersion: string | null; lastInstallAt: string | null; preference: string; channel: string };
  notifications: Array<{ id: string; enabled: boolean; configured: boolean; detail: string; capabilities: { interactive: boolean; richText: boolean } }>;
  errors: Array<{ ts: string; level: string; scope: string; message: string }>;
}

export interface OfferRow {
  id: number;
  title: string;
  description: string;
  publisher: string;
  kind: string;
  status: string;
  url: string | null;
  imageUrl: string | null;
  startAt: string | null;
  endAt: string | null;
  discountPrice: number | null;
  currency: string | null;
  owned: boolean;
  pendingApproval: { id: number; expiresAt: string; shortCode: string } | null;
  lastAttempt: { status: string; errorCode: string | null; finishedAt: string | null } | null;
}

export interface MatrixEvent {
  event: string;
  label: string;
  toggles: { macos: boolean };
  variables: string[];
  templates: { macos: Template | null };
}

export interface Template {
  title?: string;
  subtitle?: string;
  body: string;
  approveLabel?: string;
  skipLabel?: string;
}

export interface Config {
  claiming: {
    mode: 'auto' | 'approval' | 'hybrid';
    dryRun: boolean;
    approvalExpiryHours: number;
    approvalExpiryAction: 'skip' | 'keep_pending';
    maxClaimsPerCycle: number;
    minSecondsBeforeExpiry: number;
    rules: Array<{ id: string; enabled: boolean; field: string; op: string; value: string; action: 'claim' | 'approval' | 'skip'; note?: string }>;
  };
  scheduling: {
    mode: 'release' | 'daily' | 'interval';
    releaseTime: string;
    releaseTimeZone: string;
    scanOffsetMinutes: number;
    dailyTime: string;
    timeZone: string;
    intervalHours: number;
    runOnStartup: boolean;
    expiringWarningHours: number;
  };
  notifications: {
    enabled: boolean;
    adapters: {
      macos: { enabled: boolean; sound: boolean; interactiveActions: boolean };
    };
  };
  api: { host: string; port: number; publicBaseUrl: string };
  updates: { preference: 'manual' | 'notify' | 'auto'; channel: 'stable' | 'beta'; checkIntervalHours: number; repo: string };
  epic: { country: string; locale: string; browserChannel: string };
  logging: { level: string };
}

export interface HistoryResponse {
  claims: Array<{ id: number; offerId: number; title?: string; status: string; verified: boolean; errorCode: string | null; errorMessage: string | null; startedAt: string; finishedAt: string | null; initiator: string }>;
  approvals: Array<{ id: number; title?: string; status: string; shortCode: string; createdAt: string; decidedAt: string | null; decidedBy: string | null; expiresAt: string }>;
  notifications: Array<{ id: number; event: string; adapter: string; status: string; subject: string | null; createdAt: string; errorCode: string | null }>;
  updates: Array<{ id: number; fromVersion: string | null; toVersion: string; status: string; rolledBack: boolean; startedAt: string }>;
  logs: Array<{ ts: string; level: string; scope: string; message: string }>;
}
