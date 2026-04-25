/**
 * SQLite-backed storage for the multi-user governance agent.
 *
 * Lives on the EigenCompute persistent volume (USER_PERSISTENT_DATA_PATH).
 * Single-process, single-writer. WAL mode for read concurrency.
 *
 * Why SQLite-everything (vs. Redis/Postgres):
 *   - The trust boundary is the TEE. Any external DB leaks plaintext outside
 *     the attested image. SQLite-on-volume keeps state inside the boundary.
 *   - We're a single container, single process. Nothing to coordinate.
 *   - LLM calls are the latency floor (seconds). Sub-ms DB lookup buys nothing.
 *
 * Module layout:
 *   - SCHEMA + MIGRATIONS — applied once on init()
 *   - Connection           — exported `db`
 *   - Audit log            — hash-chained, load-bearing for the trust story
 *   - Users + profiles     — versioned PolicyProfile per wallet address
 *   (proposals/decisions/votes get helpers added when those endpoints are wired)
 */

import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveDbPath(): string {
  // EigenCompute exposes USER_PERSISTENT_DATA_PATH inside the enclave.
  const persistent = process.env.USER_PERSISTENT_DATA_PATH;
  if (persistent && existsSync(persistent)) {
    return join(persistent, 'app.sqlite');
  }
  // Local dev fallback. Lives under data/ which is gitignored.
  return join(process.cwd(), 'data', 'app.sqlite');
}

const DB_PATH = resolveDbPath();
mkdirSync(dirname(DB_PATH), { recursive: true });

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema + migrations
// ---------------------------------------------------------------------------

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_initial',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        eth_address  TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS policy_profiles (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id),
        version      INTEGER NOT NULL,
        profile_json TEXT NOT NULL,
        rules_json   TEXT NOT NULL,
        hash         TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        UNIQUE (user_id, version)
      );
      CREATE INDEX IF NOT EXISTS policy_profiles_latest
        ON policy_profiles (user_id, version DESC);

      CREATE TABLE IF NOT EXISTS proposals (
        id              TEXT PRIMARY KEY,
        space           TEXT NOT NULL,
        title           TEXT,
        body            TEXT,
        author          TEXT,
        type            TEXT,
        choices_json    TEXT,
        start_ts        INTEGER,
        end_ts          INTEGER,
        snapshot_block  INTEGER,
        state           TEXT,
        raw_json        TEXT NOT NULL,
        fetched_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS proposals_space_state ON proposals (space, state);
      CREATE INDEX IF NOT EXISTS proposals_end_ts      ON proposals (end_ts);

      CREATE TABLE IF NOT EXISTS proposal_analyses (
        id                    TEXT PRIMARY KEY,
        proposal_id           TEXT NOT NULL REFERENCES proposals(id),
        model_name            TEXT NOT NULL,
        model_version         TEXT NOT NULL,
        analysis_json         TEXT NOT NULL,
        extraction_confidence REAL NOT NULL,
        input_hash            TEXT NOT NULL,
        created_at            INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS proposal_analyses_proposal
        ON proposal_analyses (proposal_id);

      CREATE TABLE IF NOT EXISTS decisions (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users(id),
        proposal_id         TEXT NOT NULL REFERENCES proposals(id),
        policy_profile_id   TEXT NOT NULL REFERENCES policy_profiles(id),
        analysis_id         TEXT NOT NULL REFERENCES proposal_analyses(id),
        evaluation_json     TEXT NOT NULL,
        status              TEXT NOT NULL,
            -- pending_approval | approved | rejected | voted | expired | failed
        created_at          INTEGER NOT NULL,
        decided_at          INTEGER,
        voted_at            INTEGER,
        UNIQUE (user_id, proposal_id)
      );
      CREATE INDEX IF NOT EXISTS decisions_user_status
        ON decisions (user_id, status);

      CREATE TABLE IF NOT EXISTS votes (
        id                    TEXT PRIMARY KEY,
        decision_id           TEXT NOT NULL UNIQUE REFERENCES decisions(id),
        user_id               TEXT NOT NULL REFERENCES users(id),
        proposal_id           TEXT NOT NULL REFERENCES proposals(id),
        choice                INTEGER NOT NULL,
        signed_envelope_json  TEXT NOT NULL,
        snapshot_receipt_json TEXT,
        submitted_at          INTEGER NOT NULL,
        status                TEXT NOT NULL  -- submitted | failed
      );
      CREATE INDEX IF NOT EXISTS votes_user ON votes (user_id);

      CREATE TABLE IF NOT EXISTS audit_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        event_type   TEXT NOT NULL,
        user_id      TEXT,
        ref_id       TEXT,
        payload_json TEXT NOT NULL,
        prev_hash    TEXT NOT NULL,
        row_hash     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_log_user ON audit_log (user_id);
      CREATE INDEX IF NOT EXISTS audit_log_ref  ON audit_log (ref_id);
    `,
  },
];

function ensureMigrationsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `);
}

function applyMigrations() {
  ensureMigrationsTable();
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        m.id,
        Date.now(),
      );
    })();
    console.log(`[db] applied migration ${m.id}`);
  }
}

// Apply migrations at module init — must happen BEFORE prepared statements
// below compile, because prepare() validates the SQL against the live schema.
applyMigrations();
console.log(`[db] ready at ${DB_PATH}`);

// Kept exported for symmetry / future explicit init logic; currently a no-op
// because module load already migrated.
export function initDb() {}

// ---------------------------------------------------------------------------
// Hash-chained audit log
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

const ZERO_HASH = '0'.repeat(64);

const auditInsert = db.prepare(`
  INSERT INTO audit_log (ts, event_type, user_id, ref_id, payload_json, prev_hash, row_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const auditLatest = db.prepare(`SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`);

export type AuditEvent = {
  event_type: string;
  payload: unknown;
  user_id?: string;
  ref_id?: string;
};

export function appendAudit(evt: AuditEvent): { id: number; row_hash: string; ts: number } {
  const last = auditLatest.get() as { row_hash?: string } | undefined;
  const prev = last?.row_hash ?? ZERO_HASH;
  const ts = Date.now();
  const payloadJson = JSON.stringify(evt.payload);
  const row_hash = sha256Hex(`${prev}|${ts}|${evt.event_type}|${payloadJson}`);
  const result = auditInsert.run(
    ts,
    evt.event_type,
    evt.user_id ?? null,
    evt.ref_id ?? null,
    payloadJson,
    prev,
    row_hash,
  );
  return { id: Number(result.lastInsertRowid), row_hash, ts };
}

const auditPage = db.prepare(`
  SELECT id, ts, event_type, user_id, ref_id, payload_json, prev_hash, row_hash
  FROM audit_log
  WHERE (? IS NULL OR user_id = ?)
  ORDER BY id DESC
  LIMIT ?
`);

export function listAudit(opts: { user_id?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const rows = auditPage.all(opts.user_id ?? null, opts.user_id ?? null, limit) as Array<{
    id: number;
    ts: number;
    event_type: string;
    user_id: string | null;
    ref_id: string | null;
    payload_json: string;
    prev_hash: string;
    row_hash: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    event_type: r.event_type,
    user_id: r.user_id,
    ref_id: r.ref_id,
    payload: JSON.parse(r.payload_json),
    prev_hash: r.prev_hash,
    row_hash: r.row_hash,
  }));
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export type UserRow = {
  id: string;
  eth_address: string;
  created_at: number;
  last_seen_at: number | null;
};

const userByAddr = db.prepare(`SELECT * FROM users WHERE eth_address = ? COLLATE NOCASE`);
const userInsert = db.prepare(
  `INSERT INTO users (id, eth_address, created_at, last_seen_at) VALUES (?, ?, ?, ?)`,
);
const userTouch = db.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`);

export function findOrCreateUser(eth_address: string): UserRow {
  const existing = userByAddr.get(eth_address) as UserRow | undefined;
  const now = Date.now();
  if (existing) {
    userTouch.run(now, existing.id);
    return { ...existing, last_seen_at: now };
  }
  const id = randomUUID();
  userInsert.run(id, eth_address.toLowerCase(), now, now);
  appendAudit({
    event_type: 'USER_CREATED',
    user_id: id,
    payload: { eth_address: eth_address.toLowerCase() },
  });
  return { id, eth_address: eth_address.toLowerCase(), created_at: now, last_seen_at: now };
}

// ---------------------------------------------------------------------------
// Policy profiles (versioned, append-only)
// ---------------------------------------------------------------------------

const profileLatest = db.prepare(`
  SELECT * FROM policy_profiles
  WHERE user_id = ?
  ORDER BY version DESC
  LIMIT 1
`);
const profileInsert = db.prepare(`
  INSERT INTO policy_profiles (id, user_id, version, profile_json, rules_json, hash, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

export type ProfileRow = {
  id: string;
  user_id: string;
  version: number;
  profile_json: string;
  rules_json: string;
  hash: string;
  created_at: number;
};

export function getLatestProfile(user_id: string): ProfileRow | null {
  const row = profileLatest.get(user_id) as ProfileRow | undefined;
  return row ?? null;
}

export function saveProfile(args: {
  user_id: string;
  profile: unknown;
  rules: unknown;
}): ProfileRow {
  const latest = getLatestProfile(args.user_id);
  const version = (latest?.version ?? 0) + 1;
  const id = randomUUID();
  const profile_json = JSON.stringify(args.profile);
  const rules_json = JSON.stringify(args.rules);
  const hash = sha256Hex(profile_json);
  const created_at = Date.now();
  profileInsert.run(id, args.user_id, version, profile_json, rules_json, hash, created_at);
  appendAudit({
    event_type: 'PROFILE_SAVED',
    user_id: args.user_id,
    ref_id: id,
    payload: { version, hash },
  });
  return { id, user_id: args.user_id, version, profile_json, rules_json, hash, created_at };
}
