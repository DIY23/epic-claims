/**
 * Schema migrations. Append-only: never edit an applied migration, add a new one.
 * Every migration must be safe to apply to an existing populated database and
 * must not drop user data.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
CREATE TABLE offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store TEXT NOT NULL,
  store_offer_id TEXT NOT NULL,
  namespace TEXT,
  offer_id TEXT,
  catalog_item_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'other',
  product_slug TEXT,
  page_slug TEXT,
  url TEXT,
  image_url TEXT,
  original_price REAL,
  discount_price REAL,
  currency TEXT,
  start_at TEXT,
  end_at TEXT,
  status TEXT NOT NULL DEFAULT 'discovered',
  discovered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expired_notified_at TEXT,
  raw_json TEXT,
  UNIQUE(store, store_offer_id)
);
CREATE INDEX offers_status_idx ON offers(status);
CREATE INDEX offers_end_at_idx ON offers(end_at);

CREATE TABLE claim_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  http_status INTEGER,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_source TEXT,
  initiator TEXT NOT NULL DEFAULT 'scheduler',
  cycle_id TEXT
);
CREATE UNIQUE INDEX claim_attempts_one_success ON claim_attempts(offer_id) WHERE status = 'succeeded';
CREATE UNIQUE INDEX claim_attempts_one_inflight ON claim_attempts(offer_id) WHERE status = 'in_progress';
CREATE INDEX claim_attempts_status_idx ON claim_attempts(status, started_at);

CREATE TABLE ownership (
  offer_id INTEGER PRIMARY KEY REFERENCES offers(id) ON DELETE CASCADE,
  owned INTEGER NOT NULL,
  entitlement_name TEXT,
  verified_at TEXT NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  short_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  channel TEXT,
  delivered_channels TEXT
);
CREATE UNIQUE INDEX approvals_one_pending ON approvals(offer_id) WHERE status = 'pending';
CREATE INDEX approvals_short_code_idx ON approvals(short_code);
CREATE INDEX approvals_status_idx ON approvals(status, expires_at);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  adapter TEXT NOT NULL,
  status TEXT NOT NULL,
  dedupe_key TEXT,
  subject TEXT,
  body TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  payload_json TEXT
);
CREATE UNIQUE INDEX notifications_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_event_idx ON notifications(event, created_at);

CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE auth_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_id TEXT,
  display_name TEXT,
  session_valid INTEGER NOT NULL DEFAULT 0,
  last_validated_at TEXT,
  last_refresh_at TEXT,
  expires_at TEXT,
  error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE app_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX app_log_ts_idx ON app_log(ts);

CREATE TABLE app_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT
);
CREATE INDEX app_events_type_idx ON app_events(type, ts);

CREATE TABLE update_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_version TEXT,
  to_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  rolled_back INTEGER NOT NULL DEFAULT 0
);

INSERT INTO app_state (key, value, updated_at) VALUES
  ('schema_ready', '1', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`,
  },
];
