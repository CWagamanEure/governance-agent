/**
 * EigenCompute backend for the verifiable governance-agent preview.
 *
 * Validates three things on a real EigenCompute deployment before any
 * governance code gets wired in:
 *   1. Container builds, deploys, and serves HTTP.
 *   2. The MNEMONIC env var is injected and we can derive a wallet from it.
 *   3. The wallet can sign a message and the signature recovers correctly.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';

// Load .env if present (local dev). On EigenCompute the file isn't shipped
// in the image — env vars come from the platform, so this no-ops there.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { mnemonicToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { AttestClient } from '@layr-labs/ecloud-sdk/attest';
import { extractOne, pickModel, EXTRACTION_SCHEMA_VERSION, type ModelAlias } from './llm.js';
import {
  signVote,
  verifyEnvelope,
  submitVote,
  decisionToChoice,
  APP_NAME as SNAPSHOT_APP_NAME,
} from './snapshot.js';
import type { Decision } from './policy.js';
import { runPipeline, type SnapshotProposalRaw } from './pipeline.js';
import {
  PolicyProfile as PolicyProfileSchema,
  compileProfileToRules,
  evaluate as evaluatePolicy,
  type AnalysisForPolicy,
  type PolicyProfileT,
} from './policy.js';
import {
  initDb,
  findOrCreateUser,
  saveProfile,
  getLatestProfile,
  listAudit,
  appendAudit,
  listCachedAnalyses,
} from './db.js';
import {
  generateNonce,
  verifySiwe,
  issueSession,
  readAuth,
  getAuthedAddress,
  requireAuth,
  AuthRequiredError,
} from './auth.js';
import { userWallet } from './wallets.js';
import { compileProfile } from './profile-compiler.js';
import { buildAttestationReport } from './attestation.js';

const VERSION = '0.2.0';
const WALLET_PATH = "m/44'/60'/0'/0/0"; // viem default, documented for responses
const FRONTEND_DIST_DIR = process.env.FRONTEND_DIST_DIR ?? 'frontend/dist';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function walletAccount() {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    throw new HttpError(
      503,
      'MNEMONIC env var not set. On EigenCompute this is auto-injected; locally set one in .env.',
    );
  }
  return mnemonicToAccount(mnemonic);
}

function publicEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.endsWith('_PUBLIC') && typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

async function serveFrontendFile(c: Context, relativePath: string) {
  const root = resolve(FRONTEND_DIST_DIR);
  const requested = resolve(root, relativePath);
  if (requested !== root && !requested.startsWith(root + sep)) {
    return c.json({ error: 'not found' }, 404);
  }

  try {
    const data = await readFile(requested);
    const contentType = MIME_TYPES[extname(requested)] ?? 'application/octet-stream';
    const headers = {
      'content-type': contentType,
      'cache-control': relativePath.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    };
    const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    return c.body(body, 200, headers);
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Initialize storage before any request can hit it.
initDb();

const app = new Hono();

// Open CORS for the demo. In a production product we'd lock this to known
// origins (the deployed frontend) and require SIWE-authenticated requests
// for the privileged endpoints.
app.use('/*', cors({ origin: '*', allowHeaders: ['content-type', 'authorization'] }));

// Populate c.get('user_address') from a Bearer token if present. Does not
// reject unauthed requests — handlers call requireAuth(c) when they need it.
app.use('/*', readAuth);

app.get('/health', (c) => c.json({ ok: true, version: VERSION }));

app.get('/env', (c) => c.json(publicEnv()));

app.get('/wallet', (c) => {
  try {
    const acct = walletAccount();
    return c.json({ address: acct.address, derivation_path: WALLET_PATH });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 503);
    throw e;
  }
});

app.post('/wallet/sign-test', async (c) => {
  let body: { message?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (typeof body.message !== 'string') {
    return c.json({ error: "body must include 'message' string" }, 400);
  }

  try {
    const acct = walletAccount();
    const signature = await acct.signMessage({ message: body.message });
    const matches = await verifyMessage({
      address: acct.address,
      message: body.message,
      signature,
    });
    return c.json({
      address: acct.address,
      message: body.message,
      signature,
      matches,
    });
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 503);
    throw e;
  }
});

/**
 * POST /extract-test
 *
 * Temporary endpoint for the deploy-path smoke test. Accepts a Snapshot
 * proposal JSON (either the raw proposal object or {proposal, model} wrapper)
 * and returns the structured analysis. Lets us verify the Eigen LLM proxy
 * works end-to-end inside the enclave without wiring the full pipeline first.
 *
 * In production this gets removed — extraction is triggered by the poller,
 * not by an HTTP endpoint.
 */
app.post('/extract-test', async (c) => {
  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const proposal = payload?.proposal ?? payload;
  const modelAlias: ModelAlias = (payload?.model ?? 'sonnet') as ModelAlias;

  if (!proposal || typeof proposal !== 'object' || typeof proposal.id !== 'string') {
    return c.json({ error: 'body must be a Snapshot proposal with an id field' }, 400);
  }

  // Print the route once per request so logs make the auth path obvious
  try {
    const { info } = pickModel(modelAlias);
    console.log(`[extract-test] route=${info.route} model=${info.modelId} proposal=${proposal.id.slice(0, 10)}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `no LLM route available: ${msg}` }, 503);
  }

  const result = await extractOne(proposal, modelAlias);
  return c.json(result, result.ok ? 200 : 500);
});

/**
 * POST /vote/sign
 *
 * Build + sign + (optionally) submit a Snapshot vote with the enclave wallet.
 *
 * Body:
 *   {
 *     space:        "arbitrumfoundation.eth",
 *     proposal_id:  "0x008f1907..." (32-byte hex),
 *     decision?:    "FOR" | "AGAINST" | "ABSTAIN",   // either this …
 *     choice?:      1 | 2 | 3,                         // … or this (1-indexed)
 *     reason?:      "free text included in the signed payload",
 *     submit?:      false                              // default false: sign only, do not POST to Snapshot
 *   }
 *
 * Response:
 *   {
 *     envelope:     { address, sig, data: { domain, types, primaryType, message } },
 *     verification: { recovered: true | false },
 *     submission:   null | { ok: true, receipt } | { ok: false, status, error }
 *   }
 *
 * Default is sign-without-submit so we can validate payload construction
 * without spamming Snapshot during development.
 */
app.post('/vote/sign', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const space = typeof body?.space === 'string' ? body.space : null;
  const proposalId = typeof body?.proposal_id === 'string' ? body.proposal_id : null;
  if (!space || !proposalId) {
    return c.json({ error: "body must include 'space' and 'proposal_id'" }, 400);
  }

  let choice: number | null = null;
  if (typeof body?.choice === 'number') {
    choice = body.choice;
  } else if (typeof body?.decision === 'string') {
    const d = body.decision as Decision;
    choice = decisionToChoice(d);
    if (choice === null) {
      return c.json(
        { error: `decision '${d}' cannot be auto-voted (use MANUAL_REVIEW path)` },
        400,
      );
    }
  } else {
    return c.json({ error: "body must include 'choice' or 'decision'" }, 400);
  }
  if (choice === null) {
    return c.json({ error: 'invalid vote choice' }, 400);
  }

  const reason = typeof body?.reason === 'string' ? body.reason : '';
  const shouldSubmit = body?.submit === true;

  let acct;
  try {
    acct = walletAccount();
  } catch (e: any) {
    return c.json({ error: e.message }, 503);
  }

  let envelope;
  try {
    envelope = await signVote({
      account: acct,
      space,
      proposalId: proposalId as `0x${string}`,
      choice,
      reason,
    });
  } catch (e: any) {
    return c.json({ error: `sign failed: ${e.message}` }, 400);
  }

  const recovered = await verifyEnvelope(envelope);

  let submission: unknown = null;
  if (shouldSubmit) {
    submission = await submitVote(envelope);
  }

  // Convert bigint timestamp for JSON response
  const safeEnvelope = JSON.parse(
    JSON.stringify(envelope, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)),
  );

  return c.json({
    envelope: safeEnvelope,
    verification: { recovered },
    submission,
    app: SNAPSHOT_APP_NAME,
  });
});

/**
 * POST /pipeline/run
 *
 * Run the full pipeline on a single proposal: optional LLM extraction →
 * deterministic policy evaluation → optional vote signing. Returns the
 * structured analysis, the evaluation (with triggered rules), an optional
 * signed-but-unsubmitted vote envelope, and a deterministic markdown rationale.
 *
 * Body:
 *   {
 *     proposal:    <full Snapshot proposal JSON>,
 *     analysis?:   <pre-built ProposalAnalysis to skip LLM extraction>,
 *     profile?:    <PolicyProfileT>,
 *     preview_default_policy?: false, // authenticated users must opt in to
 *                                    // default-policy preview when no saved
 *                                    // profile exists
 *     force_live_extraction?: false,  // bypass supplied analysis + DB cache
 *     extract_only?: false,           // return analysis/provenance only
 *     sign?:       false   // if true, sign with the enclave wallet when
 *                          // decision is FOR/AGAINST/ABSTAIN
 *   }
 *
 * Notes:
 *   - When `analysis` is supplied, the LLM is not called (useful while the
 *     gateway path is unavailable).
 *   - Signing is opt-in. The endpoint never auto-submits to Snapshot —
 *     submission still goes through POST /vote/sign with submit=true.
 */
app.post('/pipeline/run', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const proposal = body?.proposal as SnapshotProposalRaw | undefined;
  if (!proposal || typeof proposal.id !== 'string') {
    return c.json(
      { error: "body must include a Snapshot proposal object with 'id'" },
      400,
    );
  }

  const analysis = body?.analysis as AnalysisForPolicy | undefined;
  const bodyProfile = body?.profile as PolicyProfileT | undefined;
  const shouldSign = body?.sign === true;
  const previewDefaultPolicy = body?.preview_default_policy === true;
  const forceLiveExtraction = body?.force_live_extraction === true;
  const extractOnly = body?.extract_only === true;
  const rawOverride = body?.override_choice;
  const overrideChoice =
    rawOverride === 1 || rawOverride === 2 || rawOverride === 3 ? rawOverride : null;
  const submitToSnapshot = body?.submit === true;

  // If authenticated:
  //   - sign with the user's deterministically-derived per-user wallet
  //   - use the user's stored profile if the body didn't override it
  // If not authenticated:
  //   - sign with the app-wide default wallet (legacy curl-demo path)
  //   - use whatever profile the body provided (or DEFAULT_PROFILE downstream)
  const authedAddr = getAuthedAddress(c);

  let effectiveProfile: PolicyProfileT | undefined = bodyProfile;
  let missingAuthedProfile = false;
  if (authedAddr && !effectiveProfile) {
    const user = findOrCreateUser(authedAddr);
    const stored = getLatestProfile(user.id);
    if (stored) effectiveProfile = JSON.parse(stored.profile_json);
    else missingAuthedProfile = true;
  }

  if (missingAuthedProfile && !extractOnly) {
    if (!previewDefaultPolicy || shouldSign || submitToSnapshot) {
      return c.json(
        {
          error: 'no_profile',
          code: 'no_profile',
          message:
            'Authenticated users must save a policy before requesting recommendations. Use extract_only=true for live TEE extraction without policy evaluation, or preview_default_policy=true for an unsigned default-policy preview.',
        },
        409,
      );
    }
  }

  let decisionAccount;
  let voteAccount;
  try {
    decisionAccount = extractOnly ? undefined : authedAddr ? userWallet(authedAddr as `0x${string}`) : walletAccount();
    if (shouldSign) voteAccount = decisionAccount;
  } catch (e: any) {
    if (shouldSign) {
      return c.json({ error: `cannot sign: ${e.message}` }, 503);
    }
    console.warn(`[pipeline/run] decision blob unavailable: ${e?.message ?? String(e)}`);
  }

  const result = await runPipeline({
    proposal,
    analysis,
    profile: effectiveProfile,
    forceLiveExtraction,
    extractOnly,
    decisionAccount,
    voteAccount,
    userAddress: authedAddr as `0x${string}` | null,
    override_choice: overrideChoice,
    submit: submitToSnapshot,
  });

  // bigint timestamps in vote envelopes don't JSON-serialize natively
  const safe = JSON.parse(
    JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)),
  );

  return c.json(safe);
});

/**
 * POST /auth/siwe/nonce
 *
 * Issue a single-use nonce for a SIWE message. Client embeds it in the
 * EIP-4361 message it asks the wallet to sign.
 */
app.post('/auth/siwe/nonce', (c) => {
  return c.json({ nonce: generateNonce() });
});

/**
 * POST /auth/siwe/verify
 *
 * Body: { message: <full SIWE text>, signature: 0x... }
 * Returns: { address, token } — the JWT goes in `Authorization: Bearer <token>`.
 */
app.post('/auth/siwe/verify', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (typeof body?.message !== 'string' || typeof body?.signature !== 'string') {
    return c.json({ error: "body must include 'message' and 'signature' strings" }, 400);
  }
  try {
    const { address } = await verifySiwe({
      message: body.message,
      signature: body.signature as `0x${string}`,
    });
    findOrCreateUser(address); // ensure a user row exists
    const token = await issueSession(address);
    return c.json({
      address: address.toLowerCase(),
      token,
      expires_in: 7 * 24 * 60 * 60,
    });
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 401);
  }
});

/**
 * GET /auth/me
 *
 * Returns the authenticated user (from the Bearer token), or unauthenticated.
 * Used by the frontend to check session validity on page load.
 */
app.get('/auth/me', (c) => {
  const addr = getAuthedAddress(c);
  if (!addr) return c.json({ authenticated: false });
  return c.json({ authenticated: true, address: addr });
});

/**
 * POST /profile
 *
 * Save a versioned PolicyProfile for the authenticated user. The address is
 * taken from the Bearer token, NOT the request body — only the user can
 * write their own profile.
 *
 * Body: { profile: <PolicyProfileT> }
 */
app.post('/profile', async (c) => {
  let address: string;
  try {
    address = requireAuth(c);
  } catch (e) {
    return c.json({ error: 'authentication required' }, 401);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const parsed = PolicyProfileSchema.safeParse(body?.profile);
  if (!parsed.success) {
    return c.json({ error: 'invalid profile', issues: parsed.error.issues }, 400);
  }

  const user = findOrCreateUser(address);
  const rules = compileProfileToRules(parsed.data);
  const saved = saveProfile({ user_id: user.id, profile: parsed.data, rules });

  return c.json({
    user: { id: user.id, eth_address: user.eth_address },
    profile: {
      id: saved.id,
      version: saved.version,
      hash: saved.hash,
      created_at: saved.created_at,
    },
    compiled_rule_count: rules.length,
  });
});

/**
 * POST /profile/compile
 *
 * Take the user's free-text values + calibration votes and return a compiled
 * PolicyProfile for them to review BEFORE saving. Does not persist anything.
 *
 * Body:
 *   {
 *     stated_values_text: "free text...",
 *     calibration: [{ proposal_id, proposal_title, proposal_category,
 *                     user_choice: "FOR"|"AGAINST"|"ABSTAIN",
 *                     reason?, personal_not_policy? }]
 *   }
 */
app.post('/profile/compile', async (c) => {
  try {
    requireAuth(c);
  } catch {
    return c.json({ error: 'authentication required' }, 401);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const stated_values_text =
    typeof body?.stated_values_text === 'string' ? body.stated_values_text : '';
  const calibration = Array.isArray(body?.calibration) ? body.calibration : [];

  if (stated_values_text.trim().length < 10 && calibration.length === 0) {
    return c.json({ error: 'must provide stated_values_text or calibration votes' }, 400);
  }

  try {
    const result = await compileProfile({ stated_values_text, calibration });
    return c.json({
      profile: result.profile,
      source: result.source,
      warnings: result.warnings,
    });
  } catch (e: any) {
    return c.json({ error: e?.message ?? String(e) }, 500);
  }
});

/**
 * GET /profile
 *
 * Return the latest profile for the authenticated user (or 404 if no profile
 * has been saved yet).
 */
app.get('/profile', (c) => {
  let address: string;
  try {
    address = requireAuth(c);
  } catch {
    return c.json({ error: 'authentication required' }, 401);
  }

  const user = findOrCreateUser(address);
  const latest = getLatestProfile(user.id);
  if (!latest) {
    return c.json({ user: { id: user.id, eth_address: user.eth_address }, profile: null }, 404);
  }
  return c.json({
    user: { id: user.id, eth_address: user.eth_address },
    profile: {
      id: latest.id,
      version: latest.version,
      hash: latest.hash,
      created_at: latest.created_at,
      profile_json: JSON.parse(latest.profile_json),
      rules_json: JSON.parse(latest.rules_json),
    },
  });
});

/**
 * GET /proposals/cached
 *
 * Returns recent closed proposals along with their cached LLM extractions,
 * scoped to the current EXTRACTION_SCHEMA_VERSION. Backs the policy editor's
 * "what would have changed" diff feedback: the editor calls this once for
 * the corpus, then re-runs policy evaluation in-memory (or via
 * /policy/preview) as the user tweaks rules.
 *
 * No expensive work happens here — this is a DB read.
 *
 *   ?limit=N            — max rows (default 25, hard cap 200)
 *   ?space=...          — filter by Snapshot space id
 *
 * Auth: requires a SIWE session. The cache itself is shared (proposals are
 * public on Snapshot), but we gate on auth to avoid scraping and to keep
 * this endpoint inside the same trust surface as /profile.
 */
app.get('/proposals/cached', (c) => {
  try {
    requireAuth(c);
  } catch {
    return c.json({ error: 'authentication required' }, 401);
  }

  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 25, 1), 200) : 25;
  const space = c.req.query('space') || undefined;

  const items = listCachedAnalyses({
    schema_version: EXTRACTION_SCHEMA_VERSION,
    space,
    limit,
  });

  return c.json({
    schema_version: EXTRACTION_SCHEMA_VERSION,
    count: items.length,
    items: items.map(({ proposal, analysis }) => ({
      proposal: {
        id: proposal.id,
        space: proposal.space,
        title: proposal.title,
        author: proposal.author,
        state: proposal.state,
        end_ts: proposal.end_ts,
        // raw_json is the canonical Snapshot record; expose it so the editor
        // can show choices, body, etc. without an extra round-trip.
        raw: JSON.parse(proposal.raw_json),
      },
      analysis: {
        id: analysis.id,
        model_name: analysis.model_name,
        model_version: analysis.model_version,
        extraction_confidence: analysis.extraction_confidence,
        extraction_schema_version: analysis.extraction_schema_version,
        created_at: analysis.created_at,
        analysis: JSON.parse(analysis.analysis_json),
      },
    })),
  });
});

/**
 * POST /policy/preview
 *
 * Run policy evaluation across the entire cached-proposal corpus against a
 * draft PolicyProfile. The editor calls this on every edit and diffs the
 * result against the baseline (saved profile) to show "what would have
 * changed."
 *
 * No LLM, no signing — purely deterministic. Cheap to call repeatedly.
 *
 * Body: { profile: PolicyProfileT }
 * Response:
 *   {
 *     schema_version, count,
 *     decisions: [{ proposal_id, decision, confidence, triggered_rule_ids }]
 *   }
 */
app.post('/policy/preview', async (c) => {
  try {
    requireAuth(c);
  } catch {
    return c.json({ error: 'authentication required' }, 401);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const parsed = PolicyProfileSchema.safeParse(body?.profile);
  if (!parsed.success) {
    return c.json({ error: 'invalid profile', issues: parsed.error.issues }, 400);
  }
  const profile = parsed.data;
  const rules = compileProfileToRules(profile);

  const cached = listCachedAnalyses({
    schema_version: EXTRACTION_SCHEMA_VERSION,
    limit: 200,
  });

  const decisions = cached.map(({ proposal, analysis }) => {
    const a = JSON.parse(analysis.analysis_json) as AnalysisForPolicy;
    // The cached extraction confidence isn't part of the AnalysisForPolicy
    // shape inside the JSON; surface it from the analysis row.
    a.extraction_confidence = analysis.extraction_confidence;
    let raw: any = null;
    try { raw = JSON.parse(proposal.raw_json); } catch {}
    const evaluation = evaluatePolicy(a, profile, rules, {
      id: proposal.id,
      author_address: raw?.author ?? proposal.author ?? undefined,
      space: proposal.space,
    });
    return {
      proposal_id: proposal.id,
      proposal_title: proposal.title,
      decision: evaluation.decision,
      confidence: evaluation.confidence,
      triggered_rule_ids: evaluation.triggered_rules.map((r) => r.id),
    };
  });

  return c.json({
    schema_version: EXTRACTION_SCHEMA_VERSION,
    count: decisions.length,
    decisions,
  });
});

/**
 * GET /audit
 *
 * Hash-chained audit log. Optionally filter by user_id.
 *
 *   ?user_id=...        — only events for this user
 *   ?limit=100          — max rows (default 100, hard cap 1000)
 */
app.get('/audit', (c) => {
  const user_id = c.req.query('user_id') || undefined;
  const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : 100;
  return c.json({ items: listAudit({ user_id, limit }) });
});

/**
 * GET /debug/env-keys
 *
 * Temporary diagnostic. Returns the sorted list of all env var NAMES (no values).
 * Lets us see what the TEE runtime injected without leaking any secret. Remove
 * once the extraction pipeline is stable.
 */
app.get('/debug/env-keys', (c) => {
  const keys = Object.keys(process.env).sort();
  return c.json({ count: keys.length, keys });
});

/**
 * GET /debug/jwt
 *
 * Mints a fresh JWT via the EigenCompute attestation flow and returns the raw
 * token plus decoded header/payload. Disabled unless ENABLE_DEBUG_JWT=true.
 * Use only when debugging gateway verification with Eigen support.
 */
app.get('/debug/jwt', async (c) => {
  if (process.env.ENABLE_DEBUG_JWT !== 'true') {
    return c.json({ error: 'debug JWT endpoint disabled' }, 404);
  }
  const kmsServerURL = process.env.KMS_SERVER_URL;
  const kmsPublicKey = process.env.KMS_PUBLIC_KEY;
  if (!kmsServerURL || !kmsPublicKey) {
    return c.json({ error: 'KMS_SERVER_URL or KMS_PUBLIC_KEY not set' }, 503);
  }
  const audience = (c.req.query('audience') ?? 'llm-proxy').trim();
  try {
    const client = new AttestClient({ kmsServerURL, kmsPublicKey, audience });
    const jwt = await client.attest();
    const [h, p, s] = jwt.split('.');
    const decode = (seg: string) =>
      JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return c.json({
      jwt,
      header: h ? decode(h) : null,
      payload: p ? decode(p) : null,
      signature_b64url_len: s?.length ?? 0,
      kms_public_key_len: kmsPublicKey.length,
      audience,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/attestation', async (c) => {
  let walletAddress: string | null = null;
  try {
    walletAddress = walletAccount().address;
  } catch {
    // intentionally ignored — attestation response is useful even without wallet
  }
  const report = await buildAttestationReport({
    version: VERSION,
    walletAddress,
    publicEnv: publicEnv(),
    audience: c.req.query('audience') ?? 'llm-proxy',
  });
  return c.json(report);
});

if (existsSync(resolve(FRONTEND_DIST_DIR, 'index.html'))) {
  console.log(`[governance-agent] serving frontend from ${FRONTEND_DIST_DIR}`);

  app.get('/assets/*', (c) => serveFrontendFile(c, c.req.path.slice(1)));
  app.get('/favicon.ico', (c) => serveFrontendFile(c, 'favicon.ico'));
  app.get('/manifest.webmanifest', (c) => serveFrontendFile(c, 'manifest.webmanifest'));
  app.get('/', (c) => serveFrontendFile(c, 'index.html'));
  app.get('/*', (c) => serveFrontendFile(c, 'index.html'));
}

const port = Number(process.env.PORT ?? 8000);
console.log(`[governance-agent] starting on :${port}`);
serve({ fetch: app.fetch, port });
