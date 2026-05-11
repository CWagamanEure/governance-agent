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
  {
    id: '002_extraction_cache_versioning',
    sql: `
      -- Tag every cached analysis with the extraction schema version that
      -- produced it. Lets us invalidate cleanly when the prompt/schema changes
      -- without nuking the whole table.
      ALTER TABLE proposal_analyses
        ADD COLUMN extraction_schema_version TEXT NOT NULL DEFAULT '1';

      -- Upsert key: one cached row per (proposal, schema version). Re-running
      -- extraction with a different model replaces the previous row at the
      -- same schema version (callers explicitly opt into that via
      -- INSERT OR REPLACE). Bumping schema version creates a new row.
      CREATE UNIQUE INDEX IF NOT EXISTS proposal_analyses_pid_schema_unique
        ON proposal_analyses (proposal_id, extraction_schema_version);
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

/**
 * List every user whose latest saved profile has autopilot.enabled = true.
 * Consumed by the background poller (src/cron.ts) so it can iterate
 * only the users who actually opted in.
 *
 * Returns the user row plus their latest profile row, joined. Implemented
 * as a SQL JOIN on the latest version-per-user via window function to
 * avoid an N+1 over getLatestProfile.
 *
 * Filtering by `autopilot.enabled = true` happens in SQL via json_extract
 * so a user whose policy lacks the field (legacy) is not returned. SQLite
 * has json_extract built in since 3.38; better-sqlite3 ships with a recent
 * build.
 */
const autopilotEnabledUsers = db.prepare(`
  WITH latest AS (
    SELECT
      p.*,
      ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY version DESC) AS rn
    FROM policy_profiles p
  )
  SELECT u.id AS user_id, u.eth_address, l.id AS profile_id, l.version, l.profile_json, l.rules_json, l.hash
  FROM users u
  JOIN latest l ON l.user_id = u.id AND l.rn = 1
  WHERE json_extract(l.profile_json, '$.autopilot.enabled') = 1
`);

export type AutopilotEnabledUserRow = {
  user_id: string;
  eth_address: string;
  profile_id: string;
  version: number;
  profile_json: string;
  rules_json: string;
  hash: string;
};

export function listAutopilotEnabledUsers(): AutopilotEnabledUserRow[] {
  return autopilotEnabledUsers.all() as AutopilotEnabledUserRow[];
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

// ---------------------------------------------------------------------------
// Demo reset — wipes a user's policy + voting history so the demo can be
// replayed from scratch. Audit-logged. Does not delete the user row itself
// (the SIWE session stays valid; the user just lands back at onboarding).
// ---------------------------------------------------------------------------

const deleteUserVotes = db.prepare('DELETE FROM votes WHERE user_id = ?');
const deleteUserDecisions = db.prepare('DELETE FROM decisions WHERE user_id = ?');
const deleteUserProfiles = db.prepare('DELETE FROM policy_profiles WHERE user_id = ?');

export function resetUserData(user_id: string): {
  votes: number;
  decisions: number;
  profiles: number;
} {
  return db.transaction(() => {
    const votes = deleteUserVotes.run(user_id).changes;
    const decisions = deleteUserDecisions.run(user_id).changes;
    const profiles = deleteUserProfiles.run(user_id).changes;
    appendAudit({
      event_type: 'DEMO_RESET',
      user_id,
      payload: { votes, decisions, profiles },
    });
    return { votes, decisions, profiles };
  })();
}

/**
 * Atomic wipe + reseed for /demo/reset. The previous shape (resetUserData
 * then a separate saveProfile) was a two-step transaction split: if the
 * second call ever throws (e.g. compileProfileToRules surfaces an unexpected
 * error, or the SQLite write fails), the user is left profileless and the
 * Reset Demo button on stage half-fails. Wrapping both in a single
 * transaction keeps the user either pre-reset or fully seeded.
 */
export function resetAndSeedUserData(args: {
  user_id: string;
  profile: unknown;
  rules: unknown;
}): {
  counts: { votes: number; decisions: number; profiles: number };
  profile: ProfileRow;
} {
  return db.transaction(() => {
    const votes = deleteUserVotes.run(args.user_id).changes;
    const decisions = deleteUserDecisions.run(args.user_id).changes;
    const profiles = deleteUserProfiles.run(args.user_id).changes;
    appendAudit({
      event_type: 'DEMO_RESET',
      user_id: args.user_id,
      payload: { votes, decisions, profiles },
    });
    const profile = saveProfile({
      user_id: args.user_id,
      profile: args.profile,
      rules: args.rules,
    });
    return {
      counts: { votes, decisions, profiles },
      profile,
    };
  })();
}

// ---------------------------------------------------------------------------
// Proposals (raw Snapshot records)
// ---------------------------------------------------------------------------

export type ProposalRow = {
  id: string;
  space: string;
  title: string | null;
  body: string | null;
  author: string | null;
  type: string | null;
  choices_json: string | null;
  start_ts: number | null;
  end_ts: number | null;
  snapshot_block: number | null;
  state: string | null;
  raw_json: string;
  fetched_at: number;
  updated_at: number;
};

const proposalUpsert = db.prepare(`
  INSERT INTO proposals (
    id, space, title, body, author, type, choices_json,
    start_ts, end_ts, snapshot_block, state, raw_json, fetched_at, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    space          = excluded.space,
    title          = excluded.title,
    body           = excluded.body,
    author         = excluded.author,
    type           = excluded.type,
    choices_json   = excluded.choices_json,
    start_ts       = excluded.start_ts,
    end_ts         = excluded.end_ts,
    snapshot_block = excluded.snapshot_block,
    state          = excluded.state,
    raw_json       = excluded.raw_json,
    updated_at     = excluded.updated_at
`);

const proposalById = db.prepare(`SELECT * FROM proposals WHERE id = ?`);
const proposalsByEnd = db.prepare(`
  SELECT * FROM proposals
  WHERE (? IS NULL OR space = ?)
    AND (? IS NULL OR state = ?)
  ORDER BY end_ts DESC
  LIMIT ?
`);

export type SnapshotProposalLike = {
  id: string;
  space?: string | { id?: string };
  title?: string | null;
  body?: string | null;
  author?: string | null;
  type?: string | null;
  choices?: unknown;
  start?: number | null;
  end?: number | null;
  snapshot?: number | string | null;
  state?: string | null;
};

function spaceId(p: SnapshotProposalLike): string {
  if (typeof p.space === 'string') return p.space;
  return p.space?.id ?? '';
}

export function upsertProposal(p: SnapshotProposalLike): ProposalRow {
  const now = Date.now();
  const space = spaceId(p);
  const choices_json = p.choices == null ? null : JSON.stringify(p.choices);
  const snapshot_block =
    p.snapshot == null ? null : typeof p.snapshot === 'string' ? Number(p.snapshot) || null : p.snapshot;
  const raw_json = JSON.stringify(p);
  proposalUpsert.run(
    p.id,
    space,
    p.title ?? null,
    p.body ?? null,
    p.author ?? null,
    p.type ?? null,
    choices_json,
    p.start ?? null,
    p.end ?? null,
    snapshot_block,
    p.state ?? null,
    raw_json,
    now,
    now,
  );
  return proposalById.get(p.id) as ProposalRow;
}

export function getProposal(id: string): ProposalRow | null {
  return (proposalById.get(id) as ProposalRow | undefined) ?? null;
}

export function listProposals(opts: { space?: string; state?: string; limit?: number } = {}): ProposalRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return proposalsByEnd.all(
    opts.space ?? null,
    opts.space ?? null,
    opts.state ?? null,
    opts.state ?? null,
    limit,
  ) as ProposalRow[];
}

// ---------------------------------------------------------------------------
// Proposal analyses (extraction cache)
//
// Cache key: (proposal_id, extraction_schema_version). Bump
// EXTRACTION_SCHEMA_VERSION in src/llm.ts when the schema or prompt changes
// in a way that invalidates prior rows.
// ---------------------------------------------------------------------------

export type AnalysisRow = {
  id: string;
  proposal_id: string;
  model_name: string;
  model_version: string;
  analysis_json: string;
  extraction_confidence: number;
  input_hash: string;
  created_at: number;
  extraction_schema_version: string;
};

const analysisUpsert = db.prepare(`
  INSERT INTO proposal_analyses (
    id, proposal_id, model_name, model_version, analysis_json,
    extraction_confidence, input_hash, created_at, extraction_schema_version
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(proposal_id, extraction_schema_version) DO UPDATE SET
    model_name            = excluded.model_name,
    model_version         = excluded.model_version,
    analysis_json         = excluded.analysis_json,
    extraction_confidence = excluded.extraction_confidence,
    input_hash            = excluded.input_hash,
    created_at            = excluded.created_at
`);

const analysisGet = db.prepare(`
  SELECT * FROM proposal_analyses
  WHERE proposal_id = ? AND extraction_schema_version = ?
`);

const analysisListJoin = db.prepare(`
  SELECT
    p.id            AS p_id,
    p.space         AS p_space,
    p.title         AS p_title,
    p.author        AS p_author,
    p.state         AS p_state,
    p.end_ts        AS p_end_ts,
    p.raw_json      AS p_raw_json,
    a.id            AS a_id,
    a.model_name    AS a_model_name,
    a.model_version AS a_model_version,
    a.analysis_json AS a_analysis_json,
    a.extraction_confidence AS a_confidence,
    a.input_hash    AS a_input_hash,
    a.created_at    AS a_created_at,
    a.extraction_schema_version AS a_schema_version
  FROM proposal_analyses a
  JOIN proposals p ON p.id = a.proposal_id
  WHERE a.extraction_schema_version = ?
    AND (? IS NULL OR p.space = ?)
  ORDER BY p.end_ts DESC NULLS LAST, a.created_at DESC
  LIMIT ?
`);

export function upsertAnalysis(args: {
  proposal_id: string;
  model_name: string;
  model_version: string;
  analysis: unknown;
  extraction_confidence: number;
  input_hash: string;
  schema_version: string;
}): AnalysisRow {
  const id = randomUUID();
  const now = Date.now();
  analysisUpsert.run(
    id,
    args.proposal_id,
    args.model_name,
    args.model_version,
    JSON.stringify(args.analysis),
    args.extraction_confidence,
    args.input_hash,
    now,
    args.schema_version,
  );
  return analysisGet.get(args.proposal_id, args.schema_version) as AnalysisRow;
}

export function getCachedAnalysis(proposal_id: string, schema_version: string): AnalysisRow | null {
  return (analysisGet.get(proposal_id, schema_version) as AnalysisRow | undefined) ?? null;
}

export type CachedProposalWithAnalysis = {
  proposal: ProposalRow;
  analysis: AnalysisRow;
};

export function listCachedAnalyses(opts: {
  schema_version: string;
  space?: string;
  limit?: number;
}): CachedProposalWithAnalysis[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = analysisListJoin.all(
    opts.schema_version,
    opts.space ?? null,
    opts.space ?? null,
    limit,
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    proposal: {
      id: r.p_id as string,
      space: r.p_space as string,
      title: (r.p_title as string | null) ?? null,
      body: null,
      author: (r.p_author as string | null) ?? null,
      type: null,
      choices_json: null,
      start_ts: null,
      end_ts: (r.p_end_ts as number | null) ?? null,
      snapshot_block: null,
      state: (r.p_state as string | null) ?? null,
      raw_json: r.p_raw_json as string,
      fetched_at: 0,
      updated_at: 0,
    },
    analysis: {
      id: r.a_id as string,
      proposal_id: r.p_id as string,
      model_name: r.a_model_name as string,
      model_version: r.a_model_version as string,
      analysis_json: r.a_analysis_json as string,
      extraction_confidence: r.a_confidence as number,
      input_hash: r.a_input_hash as string,
      created_at: r.a_created_at as number,
      extraction_schema_version: r.a_schema_version as string,
    },
  }));
}
