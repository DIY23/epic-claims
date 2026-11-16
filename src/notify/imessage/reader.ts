import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { errorMessage } from '../../shared/errors.js';
import { decodeAttributedBody } from './typedstream.js';

export interface IncomingMessage {
  rowid: number;
  guid: string;
  text: string;
  handle: string;
  service: string;
  receivedAt: string;
  isFromMe: boolean;
}

export type ApprovalCommand = { kind: 'claim' | 'skip'; code: string; raw: string };

const COMMAND_RE = /^\s*(claim|skip)\s+([a-z0-9]{6,16})\s*$/i;

/** Parses "CLAIM abc12345" / "SKIP abc12345". Anything else is ignored. */
export function parseApprovalCommand(text: string): ApprovalCommand | null {
  const m = COMMAND_RE.exec(text.replace(/\u00a0/g, ' '));
  if (!m || !m[1] || !m[2]) return null;
  return { kind: m[1].toLowerCase() as 'claim' | 'skip', code: m[2].toLowerCase(), raw: text.trim() };
}

export interface MessageReader {
  readonly kind: string;
  since(rowid: number, handle?: string | null, limit?: number): Promise<IncomingMessage[]>;
  maxRowid(): Promise<number>;
  ready(): Promise<{ ready: boolean; detail: string }>;
}

/** Apple's Core Data epoch is 2001-01-01T00:00:00Z; modern databases store nanoseconds. */
export function appleDateToIso(value: number | bigint | null): string {
  if (value === null || value === undefined) return new Date(0).toISOString();
  const asNumber = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(asNumber)) return new Date(0).toISOString();
  const seconds = asNumber > 1e12 ? asNumber / 1e9 : asNumber; // nanoseconds vs legacy seconds
  return new Date((978_307_200 + seconds) * 1000).toISOString();
}

/**
 * Reads Messages.app's SQLite database read-only (mode=ro semantics: no writes,
 * no WAL checkpoint, so Messages is not disturbed).
 *
 * On a stock Mac this needs Full Disk Access for the responsible binary. When it
 * is missing the reader reports exactly that, and the application keeps working:
 * approvals remain available through the dashboard, the CLI and the notification
 * action buttons.
 */
export class MessagesDbReader implements MessageReader {
  readonly kind = 'messages-chat-db';

  constructor(private readonly dbPath: string = path.join(os.homedir(), 'Library', 'Messages', 'chat.db')) {}

  resolvedPath(): string {
    return this.dbPath.startsWith('~') ? path.join(os.homedir(), this.dbPath.slice(1)) : this.dbPath;
  }

  private open(): DatabaseSync {
    return new DatabaseSync(this.resolvedPath(), { readOnly: true });
  }

  async ready(): Promise<{ ready: boolean; detail: string }> {
    const file = this.resolvedPath();
    if (!fs.existsSync(file)) return { ready: false, detail: `${file} not found (Messages.app never started?)` };
    let db: DatabaseSync | null = null;
    try {
      db = this.open();
      const row = db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS c FROM message').get() as { c: number } | undefined;
      return { ready: true, detail: `${Number(row?.c ?? 0)} messages visible` };
    } catch (e) {
      const msg = errorMessage(e);
      const denied = /unable to open database|authorization denied|Operation not permitted|EPERM|SQLITE_CANTOPEN/i.test(msg);
      return {
        ready: false,
        detail: denied ? `cannot read ${file} — grant Full Disk Access to the process running Epic Claims (${msg})` : msg,
      };
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  async maxRowid(): Promise<number> {
    let db: DatabaseSync | null = null;
    try {
      db = this.open();
      const row = db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS c FROM message').get() as { c: number } | undefined;
      return Number(row?.c ?? 0);
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  async since(rowid: number, handle?: string | null, limit = 200): Promise<IncomingMessage[]> {
    let db: DatabaseSync | null = null;
    try {
      db = this.open();
      const sql = `SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text, m.attributedBody AS attributedBody,
                          m.service AS service, m.date AS date, m.is_from_me AS is_from_me, h.id AS sender
                     FROM message m
                     LEFT JOIN handle h ON h.ROWID = m.handle_id
                    WHERE m.ROWID > ?
                      AND m.is_from_me = 0
                      AND m.associated_message_type = 0
                      AND m.item_type = 0
                      ${handle ? 'AND h.id = ?' : ''}
                    ORDER BY m.ROWID ASC
                    LIMIT ?`;
      const params = handle ? [rowid, handle, limit] : [rowid, limit];
      const rows = db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
      return rows.map((r) => {
        const rawText = r.text === null || r.text === undefined ? null : String(r.text);
        const decoded = rawText ?? decodeAttributedBody(r.attributedBody as Uint8Array | null);
        return {
          rowid: Number(r.rowid),
          guid: String(r.guid ?? ''),
          text: decoded ?? '',
          handle: String(r.sender ?? ''),
          service: String(r.service ?? ''),
          receivedAt: appleDateToIso(r.date as number | null),
          isFromMe: Number(r.is_from_me) === 1,
        };
      });
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Used by tests and by deployments where inbound iMessage is deliberately off. */
export class NullReader implements MessageReader {
  readonly kind = 'null';
  async since(): Promise<IncomingMessage[]> {
    return [];
  }
  async maxRowid(): Promise<number> {
    return 0;
  }
  async ready(): Promise<{ ready: boolean; detail: string }> {
    return { ready: false, detail: 'inbound reading is disabled' };
  }
}
