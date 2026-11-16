import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, makeOffer, type Sandbox } from './helpers.js';
import { Database } from '../src/db/database.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { makeTempDir } from './helpers.js';

let box: Sandbox;

beforeEach(() => {
  box = makeSandbox();
});

afterEach(() => {
  box.cleanup();
});

describe('migrations', () => {
  it('applies the schema once and is idempotent', () => {
    expect(box.db.schemaVersion()).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    expect(box.db.migrate()).toEqual([]);
    expect(box.db.schemaVersion()).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
  });

  it('upgrades a database created by an older version without losing data', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'old.db');
    const db = new Database({ file });
    db.migrate([MIGRATIONS[0]!]);
    db.run(`INSERT INTO offers (store, store_offer_id, title, discovered_at, last_seen_at) VALUES ('epic','old-1','Old Game','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`);
    const applied = db.migrate();
    const rows = db.all<{ title: string }>('SELECT title FROM offers');
    expect(applied).toEqual([]);
    expect(rows).toHaveLength(1);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a version table that records what ran', () => {
    const rows = box.db.all<{ version: number; name: string }>('SELECT version, name FROM schema_migrations ORDER BY version');
    expect(rows[0]?.name).toBe('initial-schema');
  });
});

describe('offer persistence', () => {
  it('inserts once and updates in place', () => {
    const first = box.repos.offers.upsert(makeOffer({ storeOfferId: 'p1', title: 'Original' }), box.clock.now().toISOString());
    expect(first.created).toBe(true);
    box.clock.advance(60_000);
    const second = box.repos.offers.upsert(makeOffer({ storeOfferId: 'p1', title: 'Renamed' }), box.clock.now().toISOString());
    expect(second.created).toBe(false);
    expect(second.offer.title).toBe('Renamed');
    expect(box.repos.offers.list({})).toHaveLength(1);
  });

  it('does not overwrite known identifiers with nulls', () => {
    box.repos.offers.upsert(makeOffer({ storeOfferId: 'p2', catalogItemId: 'cat-9', namespace: 'ns-9' }), box.clock.now().toISOString());
    box.repos.offers.upsert(makeOffer({ storeOfferId: 'p2', catalogItemId: null, namespace: null }), box.clock.now().toISOString());
    const stored = box.repos.offers.getByStoreOfferId('epic', 'p2');
    expect(stored?.catalogItemId).toBe('cat-9');
    expect(stored?.namespace).toBe('ns-9');
  });

  it('filters by status and expiry', () => {
    box.repos.offers.upsert(makeOffer({ storeOfferId: 'a', endAt: '2026-11-17T00:00:00.000Z' }), box.clock.now().toISOString());
    box.repos.offers.upsert(makeOffer({ storeOfferId: 'b', endAt: '2026-11-30T00:00:00.000Z' }), box.clock.now().toISOString());
    const active = box.repos.offers.list({ activeOnly: true, now: box.clock.now().toISOString() });
    expect(active.map((o) => o.storeOfferId)).toEqual(['a', 'b']);
    const later = box.repos.offers.list({ activeOnly: true, now: '2026-11-20T00:00:00.000Z' });
    expect(later.map((o) => o.storeOfferId)).toEqual(['b']);
  });
});

describe('claim attempt invariants', () => {
  it('allows one in-flight attempt per offer, enforced by the database', () => {
    const { offer } = box.repos.offers.upsert(makeOffer({ storeOfferId: 'c1' }), box.clock.now().toISOString());
    box.repos.claims.beginAttempt({ offerId: offer.id, initiator: 'test', cycleId: null, now: box.clock.now().toISOString() });
    expect(() => box.repos.claims.beginAttempt({ offerId: offer.id, initiator: 'test', cycleId: null, now: box.clock.now().toISOString() })).toThrow();
  });

  it('allows only one successful attempt per offer, forever', () => {
    const { offer } = box.repos.offers.upsert(makeOffer({ storeOfferId: 'c2' }), box.clock.now().toISOString());
    const a = box.repos.claims.beginAttempt({ offerId: offer.id, initiator: 'test', cycleId: null, now: box.clock.now().toISOString() });
    box.repos.claims.finishAttempt(a.id, { status: 'succeeded', now: box.clock.now().toISOString(), verified: true });
    const b = box.repos.claims.beginAttempt({ offerId: offer.id, initiator: 'test', cycleId: null, now: box.clock.now().toISOString() });
    expect(() => box.repos.claims.finishAttempt(b.id, { status: 'succeeded', now: box.clock.now().toISOString(), verified: true })).toThrow();
    expect(box.repos.claims.hasSucceeded(offer.id)).toBe(true);
  });

  it('abandons in-flight attempts after a crash', () => {
    const { offer } = box.repos.offers.upsert(makeOffer({ storeOfferId: 'c3' }), box.clock.now().toISOString());
    box.repos.claims.beginAttempt({ offerId: offer.id, initiator: 'test', cycleId: null, now: box.clock.now().toISOString() });
    expect(box.repos.claims.abandonInflight(box.clock.now().toISOString())).toBe(1);
    expect(box.repos.claims.countInflight()).toBe(0);
  });

  it('keeps a full audit trail per offer', () => {
    const { offer } = box.repos.offers.upsert(makeOffer({ storeOfferId: 'c4' }), box.clock.now().toISOString());
    for (let i = 0; i < 3; i++) {
      const a = box.repos.claims.beginAttempt({ offerId: offer.id, initiator: 'test', cycleId: null, now: box.clock.now().toISOString() });
      box.repos.claims.finishAttempt(a.id, { status: 'failed', now: box.clock.now().toISOString(), errorCode: 'NETWORK', errorMessage: 'down' });
    }
    const history = box.repos.claims.history(10, offer.id);
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.attemptNo)).toEqual([3, 2, 1]);
  });
});

describe('approvals', () => {
  it('allows a single pending approval per offer', () => {
    const { offer } = box.repos.offers.upsert(makeOffer({ storeOfferId: 'a1' }), box.clock.now().toISOString());
    box.repos.approvals.create({ offerId: offer.id, tokenHash: 'h1', shortCode: 'aaaa1111', createdAt: box.clock.now().toISOString(), expiresAt: '2026-11-20T00:00:00.000Z', channel: null });
    expect(() =>
      box.repos.approvals.create({ offerId: offer.id, tokenHash: 'h2', shortCode: 'bbbb2222', createdAt: box.clock.now().toISOString(), expiresAt: '2026-11-20T00:00:00.000Z', channel: null }),
    ).toThrow();
  });

  it('permits a new approval after the previous one was decided', () => {
    const { offer } = box.repos.offers.upsert(makeOffer({ storeOfferId: 'a2' }), box.clock.now().toISOString());
    const first = box.repos.approvals.create({ offerId: offer.id, tokenHash: 'h1', shortCode: 'aaaa1111', createdAt: box.clock.now().toISOString(), expiresAt: '2026-11-20T00:00:00.000Z', channel: null });
    box.repos.approvals.decide(first.id, 'rejected', 'test', box.clock.now().toISOString());
    const second = box.repos.approvals.create({ offerId: offer.id, tokenHash: 'h2', shortCode: 'bbbb2222', createdAt: box.clock.now().toISOString(), expiresAt: '2026-11-20T00:00:00.000Z', channel: null });
    expect(second.status).toBe('pending');
  });

  it('cannot decide twice', () => {
    const { offer } = box.repos.offers.upsert(makeOffer({ storeOfferId: 'a3' }), box.clock.now().toISOString());
    const approval = box.repos.approvals.create({ offerId: offer.id, tokenHash: 'h1', shortCode: 'aaaa1111', createdAt: box.clock.now().toISOString(), expiresAt: '2026-11-20T00:00:00.000Z', channel: null });
    expect(box.repos.approvals.decide(approval.id, 'accepted', 'test', box.clock.now().toISOString())).toBe(true);
    expect(box.repos.approvals.decide(approval.id, 'accepted', 'test', box.clock.now().toISOString())).toBe(false);
  });

  it('finds approvals by token hash and short code', () => {
    const { offer } = box.repos.offers.upsert(makeOffer({ storeOfferId: 'a4' }), box.clock.now().toISOString());
    box.repos.approvals.create({ offerId: offer.id, tokenHash: 'hash-1', shortCode: 'cccc3333', createdAt: box.clock.now().toISOString(), expiresAt: '2026-11-20T00:00:00.000Z', channel: null });
    expect(box.repos.approvals.byTokenHash('hash-1')?.shortCode).toBe('cccc3333');
    expect(box.repos.approvals.byShortCode('cccc3333')?.tokenHash).toBe('hash-1');
    expect(box.repos.approvals.byShortCode('nope')).toBeUndefined();
  });
});

describe('state, logging and backups', () => {
  it('stores application state as JSON', () => {
    box.repos.state.setJson('scheduler.test', { a: 1 }, box.clock.now().toISOString());
    expect(box.repos.state.getJson<{ a: number }>('scheduler.test')).toEqual({ a: 1 });
    expect(box.repos.state.getNumber('missing')).toBeNull();
  });

  it('writes an auditable log and prunes old rows', () => {
    box.repos.logs.insert({ ts: '2020-01-01T00:00:00.000Z', level: 'error', scope: 'x', message: 'old failure' });
    box.repos.logs.insert({ ts: box.clock.now().toISOString(), level: 'info', scope: 'x', message: 'recent' });
    expect(box.repos.logs.recent(10, 'error')).toHaveLength(1);
    box.repos.logs.purgeOlderThan(30, box.clock.now().toISOString());
    expect(box.repos.logs.recent(10, 'debug')).toHaveLength(1);
  });

  it('produces a consistent backup that opens independently', () => {
    box.repos.offers.upsert(makeOffer({ storeOfferId: 'b1' }), box.clock.now().toISOString());
    const dir = makeTempDir();
    const dest = path.join(dir, 'backup.db');
    box.db.backupTo(dest);
    const copy = new Database({ file: dest });
    const rows = copy.all<{ c: number }>('SELECT COUNT(*) AS c FROM offers');
    expect(rows[0]?.c).toBe(1);
    copy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes an integrity check', () => {
    expect(box.db.integrityCheck()).toBe(true);
  });
});
