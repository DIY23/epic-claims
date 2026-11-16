import type { Database } from './database.js';
import type {
  Approval,
  ApprovalStatus,
  ClaimAttempt,
  ClaimMode,
  Offer,
  OfferKind,
  OfferStatus,
  OwnershipRecord,
  StoredOffer,
} from '../shared/types.js';
import type { AppEventType } from '../shared/events.js';

function n(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}
function s(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function rowToOffer(row: Record<string, unknown>): StoredOffer {
  return {
    id: Number(row.id),
    store: (s(row.store) ?? 'epic') as StoredOffer['store'],
    storeOfferId: String(row.store_offer_id),
    namespace: s(row.namespace),
    offerId: s(row.offer_id),
    catalogItemId: s(row.catalog_item_id),
    title: String(row.title),
    description: String(row.description ?? ''),
    publisher: String(row.publisher ?? ''),
    kind: (s(row.kind) ?? 'other') as OfferKind,
    productSlug: s(row.product_slug),
    pageSlug: s(row.page_slug),
    url: s(row.url),
    imageUrl: s(row.image_url),
    originalPrice: n(row.original_price),
    discountPrice: n(row.discount_price),
    currency: s(row.currency),
    startAt: s(row.start_at),
    endAt: s(row.end_at),
    discoveredAt: String(row.discovered_at),
    lastSeenAt: String(row.last_seen_at),
    status: (s(row.status) ?? 'discovered') as OfferStatus,
  };
}

export class OffersRepository {
  constructor(private readonly db: Database) {}

  /** Insert or refresh an offer. Returns whether it was newly discovered. */
  upsert(offer: Offer, now: string): { offer: StoredOffer; created: boolean } {
    const existing = this.getByStoreOfferId(offer.store, offer.storeOfferId);
    if (existing) {
      this.db.run(
        `UPDATE offers SET title=?, description=?, publisher=?, kind=?, namespace=COALESCE(?, namespace),
           offer_id=COALESCE(?, offer_id), catalog_item_id=COALESCE(?, catalog_item_id),
           product_slug=COALESCE(?, product_slug), page_slug=COALESCE(?, page_slug), url=COALESCE(?, url),
           image_url=COALESCE(?, image_url), original_price=COALESCE(?, original_price),
           discount_price=COALESCE(?, discount_price), currency=COALESCE(?, currency),
           start_at=COALESCE(?, start_at), end_at=COALESCE(?, end_at), last_seen_at=?, raw_json=?
         WHERE id=?`,
        [
          offer.title,
          offer.description,
          offer.publisher,
          offer.kind,
          offer.namespace,
          offer.offerId,
          offer.catalogItemId,
          offer.productSlug,
          offer.pageSlug,
          offer.url,
          offer.imageUrl,
          offer.originalPrice,
          offer.discountPrice,
          offer.currency,
          offer.startAt,
          offer.endAt,
          now,
          offer.raw ? JSON.stringify(offer.raw).slice(0, 200_000) : null,
          existing.id,
        ],
      );
      return { offer: { ...existing, ...offer, lastSeenAt: now }, created: false };
    }
    const res = this.db.run(
      `INSERT INTO offers (store, store_offer_id, namespace, offer_id, catalog_item_id, title, description, publisher,
        kind, product_slug, page_slug, url, image_url, original_price, discount_price, currency, start_at, end_at,
        status, discovered_at, last_seen_at, raw_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'discovered',?,?,?)`,
      [
        offer.store,
        offer.storeOfferId,
        offer.namespace,
        offer.offerId,
        offer.catalogItemId,
        offer.title,
        offer.description,
        offer.publisher,
        offer.kind,
        offer.productSlug,
        offer.pageSlug,
        offer.url,
        offer.imageUrl,
        offer.originalPrice,
        offer.discountPrice,
        offer.currency,
        offer.startAt,
        offer.endAt,
        now,
        now,
        offer.raw ? JSON.stringify(offer.raw).slice(0, 200_000) : null,
      ],
    );
    const created = this.get(res.lastInsertRowid);
    if (!created) throw new Error('offer insert failed');
    return { offer: created, created: true };
  }

  get(id: number): StoredOffer | undefined {
    const row = this.db.get('SELECT * FROM offers WHERE id = ?', [id]);
    return row ? rowToOffer(row) : undefined;
  }

  getByStoreOfferId(store: string, storeOfferId: string): StoredOffer | undefined {
    const row = this.db.get('SELECT * FROM offers WHERE store = ? AND store_offer_id = ?', [store, storeOfferId]);
    return row ? rowToOffer(row) : undefined;
  }

  list(filter: { status?: OfferStatus | OfferStatus[]; activeOnly?: boolean; now?: string; limit?: number } = {}): StoredOffer[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      const arr = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
    if (filter.activeOnly) {
      where.push('(end_at IS NULL OR end_at > ?)');
      params.push(filter.now ?? new Date().toISOString());
    }
    const sql = `SELECT * FROM offers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY end_at IS NULL, end_at ASC, id DESC LIMIT ?`;
    params.push(filter.limit ?? 200);
    return this.db.all(sql, params).map(rowToOffer);
  }

  listExpiringSoon(now: string, horizon: string, notified: boolean): StoredOffer[] {
    const rows = this.db.all(
      `SELECT * FROM offers
        WHERE end_at IS NOT NULL AND end_at > ? AND end_at <= ?
          AND status NOT IN ('expired','skipped','already_owned')
          AND ${notified ? 'expired_notified_at IS NOT NULL' : 'expired_notified_at IS NULL'}
        ORDER BY end_at ASC`,
      [now, horizon],
    );
    return rows.map(rowToOffer);
  }

  markExpiringNotified(id: number, at: string): void {
    this.db.run('UPDATE offers SET expired_notified_at = ? WHERE id = ? AND expired_notified_at IS NULL', [at, id]);
  }

  setStatus(id: number, status: OfferStatus): void {
    this.db.run('UPDATE offers SET status = ? WHERE id = ?', [status, id]);
  }

  countByStatus(): Record<string, number> {
    const rows = this.db.all<{ status: string; c: number }>('SELECT status, COUNT(*) AS c FROM offers GROUP BY status');
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.c);
    return out;
  }
}

export class ClaimsRepository {
  constructor(private readonly db: Database) {}

  /**
   * Starts an attempt. The partial unique index on (offer_id) WHERE status
   * = 'in_progress' makes a second concurrent attempt impossible at the
   * database level, not just in memory.
   */
  beginAttempt(input: { offerId: number; initiator: string; cycleId: string | null; now: string }): ClaimAttempt {
    const prev = this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM claim_attempts WHERE offer_id = ?', [input.offerId]);
    const attemptNo = Number(prev?.c ?? 0) + 1;
    const res = this.db.run(
      `INSERT INTO claim_attempts (offer_id, attempt_no, status, started_at, initiator, cycle_id)
       VALUES (?, ?, 'in_progress', ?, ?, ?)`,
      [input.offerId, attemptNo, input.now, input.initiator, input.cycleId],
    );
    this.db.run(`UPDATE offers SET status = 'claiming' WHERE id = ? AND status NOT IN ('claimed','already_owned')`, [input.offerId]);
    return {
      id: res.lastInsertRowid,
      offerId: input.offerId,
      attemptNo,
      status: 'in_progress',
      startedAt: input.now,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      verified: false,
      initiator: input.initiator,
    };
  }

  finishAttempt(
    id: number,
    result: {
      status: 'succeeded' | 'failed' | 'abandoned';
      now: string;
      verified?: boolean;
      errorCode?: string | null;
      errorMessage?: string | null;
      httpStatus?: number | null;
      verificationSource?: string | null;
    },
  ): void {
    this.db.run(
      `UPDATE claim_attempts SET status = ?, finished_at = ?, verified = ?, error_code = ?, error_message = ?, http_status = ?, verification_source = ?
       WHERE id = ?`,
      [
        result.status,
        result.now,
        result.verified ? 1 : 0,
        result.errorCode ?? null,
        result.errorMessage ? String(result.errorMessage).slice(0, 2000) : null,
        result.httpStatus ?? null,
        result.verificationSource ?? null,
        id,
      ],
    );
  }

  /** Called at startup: any attempt left 'in_progress' is from a crashed process. */
  abandonInflight(now: string, reason = 'interrupted by restart'): number {
    const res = this.db.run(
      `UPDATE claim_attempts SET status = 'abandoned', finished_at = ?, error_code = 'INTERRUPTED', error_message = ?
       WHERE status = 'in_progress'`,
      [now, reason],
    );
    return res.changes;
  }

  hasSucceeded(offerId: number): boolean {
    const row = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM claim_attempts WHERE offer_id = ? AND status = 'succeeded'`, [offerId]);
    return Number(row?.c ?? 0) > 0;
  }

  inflight(now: string, staleAfterMs = 30 * 60_000): Array<{ id: number; offer_id: number; started_at: string }> {
    const cutoff = new Date(Date.parse(now) - staleAfterMs).toISOString();
    return this.db.all(`SELECT id, offer_id, started_at FROM claim_attempts WHERE status = 'in_progress' AND started_at >= ?`, [cutoff]);
  }

  countInflight(): number {
    const row = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM claim_attempts WHERE status = 'in_progress'`);
    return Number(row?.c ?? 0);
  }

  latest(offerId: number): ClaimAttempt | undefined {
    const row = this.db.get(
      `SELECT * FROM claim_attempts WHERE offer_id = ? ORDER BY attempt_no DESC LIMIT 1`,
      [offerId],
    );
    return row ? mapAttempt(row) : undefined;
  }

  history(limit = 100, offerId?: number): Array<ClaimAttempt & { title?: string }> {
    const rows = offerId
      ? this.db.all(`SELECT a.*, o.title FROM claim_attempts a JOIN offers o ON o.id = a.offer_id WHERE a.offer_id = ? ORDER BY a.id DESC LIMIT ?`, [offerId, limit])
      : this.db.all(`SELECT a.*, o.title FROM claim_attempts a JOIN offers o ON o.id = a.offer_id ORDER BY a.id DESC LIMIT ?`, [limit]);
    return rows.map((r) => ({ ...mapAttempt(r), title: r.title ? String(r.title) : undefined }));
  }

  failedAttemptsSince(sinceIso: string): number {
    const row = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM claim_attempts WHERE status = 'failed' AND started_at >= ?`, [sinceIso]);
    return Number(row?.c ?? 0);
  }
}

function mapAttempt(row: Record<string, unknown>): ClaimAttempt {
  return {
    id: Number(row.id),
    offerId: Number(row.offer_id),
    attemptNo: Number(row.attempt_no),
    status: String(row.status) as ClaimAttempt['status'],
    startedAt: String(row.started_at),
    finishedAt: s(row.finished_at),
    errorCode: s(row.error_code),
    errorMessage: s(row.error_message),
    verified: Number(row.verified) === 1,
    initiator: String(row.initiator ?? 'scheduler'),
  };
}

export class OwnershipRepository {
  constructor(private readonly db: Database) {}

  upsert(record: { offerId: number; owned: boolean; entitlementName?: string | null; verifiedAt: string; source: OwnershipRecord['source'] }): void {
    this.db.run(
      `INSERT INTO ownership (offer_id, owned, entitlement_name, verified_at, source) VALUES (?,?,?,?,?)
       ON CONFLICT(offer_id) DO UPDATE SET owned=excluded.owned, entitlement_name=COALESCE(excluded.entitlement_name, ownership.entitlement_name),
         verified_at=excluded.verified_at, source=excluded.source`,
      [record.offerId, record.owned ? 1 : 0, record.entitlementName ?? null, record.verifiedAt, record.source],
    );
  }

  get(offerId: number): OwnershipRecord | undefined {
    const row = this.db.get('SELECT * FROM ownership WHERE offer_id = ?', [offerId]);
    if (!row) return undefined;
    return {
      offerId: Number(row.offer_id),
      owned: Number(row.owned) === 1,
      entitlementName: s(row.entitlement_name),
      verifiedAt: String(row.verified_at),
      source: (s(row.source) ?? 'unknown') as OwnershipRecord['source'],
    };
  }
}

export class ApprovalsRepository {
  constructor(private readonly db: Database) {}

  create(input: { offerId: number; tokenHash: string; shortCode: string; createdAt: string; expiresAt: string; channel: string | null }): Approval {
    const res = this.db.run(
      `INSERT INTO approvals (offer_id, token_hash, short_code, status, created_at, expires_at, channel)
       VALUES (?,?,?, 'pending', ?, ?, ?)`,
      [input.offerId, input.tokenHash, input.shortCode, input.createdAt, input.expiresAt, input.channel],
    );
    const a = this.get(res.lastInsertRowid);
    if (!a) throw new Error('approval insert failed');
    return a;
  }

  get(id: number): Approval | undefined {
    const row = this.db.get('SELECT * FROM approvals WHERE id = ?', [id]);
    return row ? mapApproval(row) : undefined;
  }

  pendingForOffer(offerId: number): Approval | undefined {
    const row = this.db.get(`SELECT * FROM approvals WHERE offer_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`, [offerId]);
    return row ? mapApproval(row) : undefined;
  }

  byTokenHash(tokenHash: string): Approval | undefined {
    const row = this.db.get('SELECT * FROM approvals WHERE token_hash = ?', [tokenHash]);
    return row ? mapApproval(row) : undefined;
  }

  byShortCode(shortCode: string): Approval | undefined {
    const row = this.db.get(`SELECT * FROM approvals WHERE short_code = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`, [shortCode.toLowerCase()]);
    return row ? mapApproval(row) : undefined;
  }

  decide(id: number, status: Exclude<ApprovalStatus, 'pending'>, decidedBy: string, now: string): boolean {
    const res = this.db.run(
      `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`,
      [status, now, decidedBy, id],
    );
    return res.changes > 0;
  }

  markExpired(id: number, now: string): boolean {
    const res = this.db.run(`UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'`, [now, id]);
    return res.changes > 0;
  }

  overdue(now: string): Approval[] {
    return this.db.all(`SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ?`, [now]).map(mapApproval);
  }

  pending(): Approval[] {
    return this.db.all(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY expires_at ASC`).map(mapApproval);
  }

  history(limit = 100): Array<Approval & { title?: string }> {
    const rows = this.db.all(
      `SELECT a.*, o.title FROM approvals a JOIN offers o ON o.id = a.offer_id ORDER BY a.id DESC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({ ...mapApproval(r), title: r.title ? String(r.title) : undefined }));
  }

  markDelivered(id: number, channel: string): void {
    const a = this.get(id);
    if (!a) return;
    const existing = this.db.get<{ delivered_channels: string | null }>('SELECT delivered_channels FROM approvals WHERE id = ?', [id]);
    const list = new Set((existing?.delivered_channels ?? '').split(',').filter(Boolean));
    list.add(channel);
    this.db.run('UPDATE approvals SET delivered_channels = ? WHERE id = ?', [[...list].join(','), id]);
  }
}

function mapApproval(row: Record<string, unknown>): Approval {
  return {
    id: Number(row.id),
    offerId: Number(row.offer_id),
    tokenHash: String(row.token_hash),
    shortCode: String(row.short_code),
    status: String(row.status) as ApprovalStatus,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    decidedAt: s(row.decided_at),
    decidedBy: s(row.decided_by),
    channel: s(row.channel),
  };
}

export interface NotificationRecord {
  id: number;
  event: AppEventType;
  adapter: string;
  status: 'delivered' | 'failed' | 'skipped' | 'duplicate';
  dedupeKey: string | null;
  subject: string | null;
  body: string | null;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export class NotificationsRepository {
  constructor(private readonly db: Database) {}

  /** Returns null when the dedupe key was already used (delivery suppressed). */
  insert(input: {
    event: string;
    adapter: string;
    status: NotificationRecord['status'];
    dedupeKey?: string | null;
    subject?: string | null;
    body?: string | null;
    createdAt: string;
    payload?: unknown;
  }): number | null {
    try {
      const res = this.db.run(
        `INSERT INTO notifications (event, adapter, status, dedupe_key, subject, body, created_at, payload_json)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          input.event,
          input.adapter,
          input.status,
          input.dedupeKey ?? null,
          input.subject ?? null,
          input.body ? input.body.slice(0, 4000) : null,
          input.createdAt,
          input.payload ? JSON.stringify(input.payload).slice(0, 8000) : null,
        ],
      );
      return res.lastInsertRowid;
    } catch (e) {
      if (/UNIQUE constraint failed/i.test((e as Error).message)) return null;
      throw e;
    }
  }

  markDelivered(id: number, at: string, attempts: number): void {
    this.db.run(`UPDATE notifications SET status = 'delivered', delivered_at = ?, attempts = ? WHERE id = ?`, [at, attempts, id]);
  }

  markFailed(id: number, errorCode: string, errorMessage: string, attempts: number): void {
    this.db.run(`UPDATE notifications SET status = 'failed', error_code = ?, error_message = ?, attempts = ? WHERE id = ?`, [
      errorCode,
      errorMessage.slice(0, 1000),
      attempts,
      id,
    ]);
  }

  recent(limit = 100): NotificationRecord[] {
    return this.db.all(`SELECT * FROM notifications ORDER BY id DESC LIMIT ?`, [limit]).map((r) => ({
      id: Number(r.id),
      event: String(r.event) as AppEventType,
      adapter: String(r.adapter),
      status: String(r.status) as NotificationRecord['status'],
      dedupeKey: s(r.dedupe_key),
      subject: s(r.subject),
      body: s(r.body),
      attempts: Number(r.attempts ?? 0),
      errorCode: s(r.error_code),
      errorMessage: s(r.error_message),
      createdAt: String(r.created_at),
      deliveredAt: s(r.delivered_at),
    }));
  }

  deliveredCountSince(since: string): number {
    const row = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM notifications WHERE status = 'delivered' AND created_at >= ?`, [since]);
    return Number(row?.c ?? 0);
  }
}

export class StateRepository {
  constructor(private readonly db: Database) {}

  get(key: string): string | null {
    const row = this.db.get<{ value: string }>('SELECT value FROM app_state WHERE key = ?', [key]);
    return row ? String(row.value) : null;
  }

  set(key: string, value: string, now = new Date().toISOString()): void {
    this.db.run(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, now],
    );
  }

  getJson<T>(key: string): T | null {
    const raw = this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown, now = new Date().toISOString()): void {
    this.set(key, JSON.stringify(value), now);
  }

  getNumber(key: string): number | null {
    const raw = this.get(key);
    if (raw === null) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  }

  delete(key: string): void {
    this.db.run('DELETE FROM app_state WHERE key = ?', [key]);
  }
}

export interface AuthStateRecord {
  accountId: string | null;
  displayName: string | null;
  sessionValid: boolean;
  lastValidatedAt: string | null;
  lastRefreshAt: string | null;
  expiresAt: string | null;
  error: string | null;
}

export class AuthRepository {
  constructor(private readonly db: Database) {}

  get(): AuthStateRecord {
    const row = this.db.get('SELECT * FROM auth_state WHERE id = 1');
    if (!row) {
      return { accountId: null, displayName: null, sessionValid: false, lastValidatedAt: null, lastRefreshAt: null, expiresAt: null, error: null };
    }
    return {
      accountId: s(row.account_id),
      displayName: s(row.display_name),
      sessionValid: Number(row.session_valid) === 1,
      lastValidatedAt: s(row.last_validated_at),
      lastRefreshAt: s(row.last_refresh_at),
      expiresAt: s(row.expires_at),
      error: s(row.error),
    };
  }

  set(patch: Partial<AuthStateRecord>, now: string): void {
    const cur = this.get();
    const next = { ...cur, ...patch };
    this.db.run(
      `INSERT INTO auth_state (id, account_id, display_name, session_valid, last_validated_at, last_refresh_at, expires_at, error, updated_at)
       VALUES (1,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, display_name=excluded.display_name, session_valid=excluded.session_valid,
         last_validated_at=excluded.last_validated_at, last_refresh_at=excluded.last_refresh_at, expires_at=excluded.expires_at,
         error=excluded.error, updated_at=excluded.updated_at`,
      [
        next.accountId,
        next.displayName,
        next.sessionValid ? 1 : 0,
        next.lastValidatedAt,
        next.lastRefreshAt,
        next.expiresAt,
        next.error,
        now,
      ],
    );
  }
}

export class LogsRepository {
  constructor(private readonly db: Database) {}

  insert(record: { ts: string; level: string; scope: string; message: string; data?: unknown }): void {
    this.db.run('INSERT INTO app_log (ts, level, scope, message, data_json) VALUES (?,?,?,?,?)', [
      record.ts,
      record.level,
      record.scope,
      record.message.slice(0, 2000),
      record.data ? JSON.stringify(record.data).slice(0, 4000) : null,
    ]);
  }

  recent(limit = 200, minLevel: 'debug' | 'info' | 'warn' | 'error' = 'info'): Array<{ ts: string; level: string; scope: string; message: string; data: unknown }> {
    const levels = minLevel === 'debug' ? ['debug', 'info', 'warn', 'error'] : minLevel === 'info' ? ['info', 'warn', 'error'] : minLevel === 'warn' ? ['warn', 'error'] : ['error'];
    const rows = this.db.all(
      `SELECT * FROM app_log WHERE level IN (${levels.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`,
      [...levels, limit],
    );
    return rows.map((r) => ({
      ts: String(r.ts),
      level: String(r.level),
      scope: String(r.scope),
      message: String(r.message),
      data: r.data_json ? safeJson(String(r.data_json)) : null,
    }));
  }

  purgeOlderThan(days: number, now: string): number {
    const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString();
    return this.db.run('DELETE FROM app_log WHERE ts < ?', [cutoff]).changes;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export class EventsRepository {
  constructor(private readonly db: Database) {}

  insert(ts: string, type: string, payload: unknown): void {
    this.db.run('INSERT INTO app_events (ts, type, payload_json) VALUES (?,?,?)', [ts, type, JSON.stringify(payload ?? null).slice(0, 8000)]);
  }

  recent(limit = 200, type?: string): Array<{ id: number; ts: string; type: string; payload: unknown }> {
    const rows = type
      ? this.db.all('SELECT * FROM app_events WHERE type = ? ORDER BY id DESC LIMIT ?', [type, limit])
      : this.db.all('SELECT * FROM app_events ORDER BY id DESC LIMIT ?', [limit]);
    return rows.map((r) => ({ id: Number(r.id), ts: String(r.ts), type: String(r.type), payload: r.payload_json ? safeJson(String(r.payload_json)) : null }));
  }
}

export class UpdateHistoryRepository {
  constructor(private readonly db: Database) {}

  start(from: string, to: string, now: string): number {
    return this.db.run(`INSERT INTO update_history (from_version, to_version, started_at, status) VALUES (?,?,?, 'running')`, [from, to, now]).lastInsertRowid;
  }

  finish(id: number, status: 'success' | 'failed' | 'rolled_back', detail: string, rolledBack: boolean, now: string): void {
    this.db.run('UPDATE update_history SET status = ?, detail = ?, rolled_back = ?, finished_at = ? WHERE id = ?', [
      status,
      detail.slice(0, 4000),
      rolledBack ? 1 : 0,
      now,
      id,
    ]);
  }

  list(limit = 50): Array<{ id: number; fromVersion: string | null; toVersion: string; startedAt: string; finishedAt: string | null; status: string; detail: string | null; rolledBack: boolean }> {
    return this.db.all('SELECT * FROM update_history ORDER BY id DESC LIMIT ?', [limit]).map((r) => ({
      id: Number(r.id),
      fromVersion: s(r.from_version),
      toVersion: String(r.to_version),
      startedAt: String(r.started_at),
      finishedAt: s(r.finished_at),
      status: String(r.status),
      detail: s(r.detail),
      rolledBack: Number(r.rolled_back) === 1,
    }));
  }
}

export interface Repositories {
  offers: OffersRepository;
  claims: ClaimsRepository;
  ownership: OwnershipRepository;
  approvals: ApprovalsRepository;
  notifications: NotificationsRepository;
  state: StateRepository;
  auth: AuthRepository;
  logs: LogsRepository;
  events: EventsRepository;
  updates: UpdateHistoryRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
    offers: new OffersRepository(db),
    claims: new ClaimsRepository(db),
    ownership: new OwnershipRepository(db),
    approvals: new ApprovalsRepository(db),
    notifications: new NotificationsRepository(db),
    state: new StateRepository(db),
    auth: new AuthRepository(db),
    logs: new LogsRepository(db),
    events: new EventsRepository(db),
    updates: new UpdateHistoryRepository(db),
  };
}

export type { ClaimMode };
