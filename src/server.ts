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
import { bodyLimit } from 'hono/body-limit';
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
  type SignedVoteEnvelope,
} from './snapshot.js';
import type { Decision } from './policy.js';
import { runPipeline, type SnapshotProposalRaw } from './pipeline.js';
import {
  PolicyProfile as PolicyProfileSchema,
  compileProfileToRules,
  evaluate as evaluatePolicy,
  isAutopilotEligible,
  normalizeProfile as normalizeProfileFn,
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
  getCachedAnalysis,
  resetUserData,
  resetAndSeedUserData,
} from './db.js';
import {
  generateNonce,
  verifySiwe,
  issueSession,
  readAuth,
  getAuthedAddress,
  requireAuth,
  AuthRequiredError,
  OperatorNotAllowlistedError,
} from './auth.js';
import { userWallet } from './wallets.js';
import { compileProfile } from './profile-compiler.js';
import { buildAttestationReport } from './attestation.js';
import { DEMO_PROFILE } from './demo-profile.js';
import {
  hashJson,
  DECISION_BLOB_DOMAIN,
  DECISION_BLOB_TYPES,
  signDecisionBlob,
  type DecisionBlobMessage,
  type SignedDecisionBlob,
} from './decision-blob.js';
import { verifyTypedData } from 'viem';

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

/**
 * True when operator-only diagnostic endpoints (/debug/env-keys,
 * /extract-test, /debug/jwt) are exposed. These can leak runtime details
 * (env var presence) or burn LLM tokens, so they default to OFF.
 *
 * Two env flags are honored for back-compat with EIGEN_GATEWAY_DEBUG.md:
 *   - ENABLE_DEBUG_ENDPOINTS=true (preferred; covers all)
 *   - ENABLE_DEBUG_JWT=true       (legacy; also unlocks all debug paths)
 */
function isDebugEnabled(): boolean {
  return (
    process.env.ENABLE_DEBUG_ENDPOINTS === 'true' ||
    process.env.ENABLE_DEBUG_JWT === 'true'
  );
}

function publicEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.endsWith('_PUBLIC') && typeof v === 'string') {
      out[k] = v;
    }
  }
  // Derived: expose the model id and route the pipeline would actually pick.
  // pickModel() is pure (env-only, no I/O), so this is cheap. The frontend
  // uses these to render the trust panel without hardcoding the model name —
  // when the deployed image switches sonnet→opus, the panel updates.
  // Honors any explicit MODEL_PUBLIC / MODEL_ROUTE_PUBLIC override from the
  // deploy env.
  if (!out.MODEL_PUBLIC || !out.MODEL_ROUTE_PUBLIC) {
    try {
      const { info } = pickModel('sonnet');
      if (!out.MODEL_PUBLIC) out.MODEL_PUBLIC = info.modelId;
      if (!out.MODEL_ROUTE_PUBLIC) out.MODEL_ROUTE_PUBLIC = info.route;
    } catch {
      // pickModel throws when no provider is configured (LLM_PROVIDER=off,
      // or local dev without credentials). Leave the keys unset; the
      // frontend falls back to "configured".
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
  // Signs an arbitrary caller-supplied message with the operator's
  // MNEMONIC-derived app wallet. Useful for local smoke tests of the
  // wallet plumbing, but a signature-minting oracle in production: a
  // visitor could attribute signatures to the operator's identity.
  // Gated behind isDebugEnabled() so production deploys 404 it.
  if (!isDebugEnabled()) {
    return c.json({ error: 'not found' }, 404);
  }
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
  // Operator-only smoke test: makes a paid LLM call. Hidden behind the debug
  // flag so a public TEE URL can't be used to drain budget.
  if (!isDebugEnabled()) {
    return c.json({ error: 'debug extraction endpoint disabled' }, 404);
  }
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

  // Submission is a public side effect (signed message lands in Snapshot's
  // sequencer with this app's identity attached). Gate with auth so the
  // audit log can attribute it; sign-only stays open for the legacy
  // curl-demo path that returns the envelope without posting it.
  let submitterUserId: string | null = null;
  if (shouldSubmit) {
    let address: string;
    try {
      address = requireAuth(c);
    } catch {
      return c.json({ error: 'authentication required for submit:true' }, 401);
    }
    if (!isSpaceAllowedForSubmit(space)) {
      return c.json(
        {
          error: 'space_not_allowed',
          message: `Refusing to submit to ${space}. Set SUBMIT_ALLOWLIST to allow it.`,
          allowlist: getSubmitAllowlist(),
        },
        403,
      );
    }
    submitterUserId = findOrCreateUser(address).id;
  }

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
  if (shouldSubmit && submitterUserId) {
    const result = await submitVote(envelope);
    submission = result;
    auditVoteSubmission({
      user_id: submitterUserId,
      space,
      proposal: envelope.data.message.proposal,
      choice: envelope.data.message.choice,
      from: envelope.address,
      result,
    });
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

  // Auth gate for any path that could hit the LLM. extractOne fires whenever
  // the caller did not supply analysis, OR force_live_extraction overrides
  // cache + supplied analysis. Without this gate, an unauthenticated visitor
  // could pound this endpoint with force_live_extraction:true and drain the
  // operator's LLM budget. The auth check itself is cheap (JWT verify).
  const llmCallPossible = !analysis || forceLiveExtraction;
  if (llmCallPossible) {
    try {
      requireAuth(c);
    } catch {
      return c.json(
        {
          error: 'authentication_required',
          message:
            'Authentication is required for any pipeline run that may trigger live LLM extraction. Sign in via SIWE, or supply an analysis object in the body to skip extraction.',
        },
        401,
      );
    }
  }

  // Submission is a public side effect on Snapshot. Gate on auth so the
  // audit log can attribute it; allowlist gate ensures we never POST to a
  // space we did not pre-approve. The proposal's space comes from the
  // supplied Snapshot proposal record.
  let submitterUserIdForPipeline: string | null = null;
  if (submitToSnapshot) {
    let submitAddress: string;
    try {
      submitAddress = requireAuth(c);
    } catch {
      return c.json({ error: 'authentication required for submit:true' }, 401);
    }
    const targetSpace = proposal.space?.id ?? '';
    if (!isSpaceAllowedForSubmit(targetSpace)) {
      return c.json(
        {
          error: 'space_not_allowed',
          message: `Refusing to submit to ${targetSpace}. Set SUBMIT_ALLOWLIST to allow it.`,
          allowlist: getSubmitAllowlist(),
        },
        403,
      );
    }
    submitterUserIdForPipeline = findOrCreateUser(submitAddress).id;
  }

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

  // Audit any actually-attempted Snapshot submission. The pipeline only
  // populates result.submission when it called submitVote, regardless of
  // whether Snapshot accepted; logging both ok and not-ok keeps the audit
  // chain complete.
  if (submitToSnapshot && submitterUserIdForPipeline && result.vote && result.submission) {
    auditVoteSubmission({
      user_id: submitterUserIdForPipeline,
      space: proposal.space?.id ?? '',
      proposal: proposal.id,
      choice: result.vote.choice,
      from: result.vote.envelope.address,
      result: result.submission,
    });
  }

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
    // OperatorNotAllowlistedError is a 403 with a clear message —
    // distinguish it from generic 401 so the frontend can render a
    // useful "this wallet is not authorized" UI instead of a generic
    // signature-rejected toast.
    if (e instanceof OperatorNotAllowlistedError) {
      return c.json(
        { error: 'operator_not_allowlisted', message: e.message },
        403,
      );
    }
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

  // Hard caps on input size: prevents a loop with max-size strings from
  // burning input tokens at the operator's expense. 10kB of values text +
  // 50 calibration items is far more than any honest user needs.
  if (stated_values_text.length > 10_000) {
    return c.json(
      {
        error: 'stated_values_text_too_long',
        message: 'stated_values_text exceeds 10,000 characters',
      },
      413,
    );
  }
  if (calibration.length > 50) {
    return c.json(
      { error: 'calibration_too_long', message: 'calibration must be ≤ 50 items' },
      413,
    );
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
 * POST /demo/reset
 *
 * Resets the authed user to the deterministic demo state: wipes votes,
 * decisions, and any saved policy versions, then installs the hand-tuned
 * DEMO_PROFILE so the four-step ACT-2 peel produces 1/1/1/3 flips against the
 * cached corpus. Audit-logged.
 *
 * Optional body { skip_seed: true } restores the previous "wipe to onboarding"
 * behavior — useful when you want to re-record the calibration session.
 */
app.post('/demo/reset', async (c) => {
  let address: string;
  try {
    address = requireAuth(c);
  } catch {
    return c.json({ error: 'authentication required' }, 401);
  }

  let body: { skip_seed?: boolean } = {};
  try {
    if (c.req.header('content-length') && Number(c.req.header('content-length')) > 0) {
      body = await c.req.json();
    }
  } catch {
    // tolerate empty bodies
  }

  const user = findOrCreateUser(address);

  if (body.skip_seed) {
    const counts = resetUserData(user.id);
    return c.json({ ok: true, seeded: false, ...counts });
  }

  // Atomic wipe + seed: if the seed insert fails, the wipe is rolled back
  // too, so the operator never lands in the half-state where the previous
  // policy is gone but the demo profile is not installed.
  const rules = compileProfileToRules(DEMO_PROFILE);
  const { counts, profile: seeded } = resetAndSeedUserData({
    user_id: user.id,
    profile: DEMO_PROFILE,
    rules,
  });

  return c.json({
    ok: true,
    seeded: true,
    ...counts,
    profile: {
      id: seeded.id,
      version: seeded.version,
      hash: seeded.hash,
      created_at: seeded.created_at,
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
 * Hash-chained audit log scoped to the authenticated user. The user_id
 * query parameter is intentionally ignored — only the wallet that signed in
 * can see its own events. (Cross-user audit access would require a separate
 * admin role this product does not yet have.)
 *
 *   ?limit=100          — max rows (default 100, hard cap 1000)
 */
app.get('/audit', (c) => {
  let address: string;
  try {
    address = requireAuth(c);
  } catch {
    return c.json({ error: 'authentication required' }, 401);
  }
  const user = findOrCreateUser(address);
  const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : 100;
  return c.json({ items: listAudit({ user_id: user.id, limit }) });
});

/**
 * GET /debug/env-keys
 *
 * Operator diagnostic: sorted list of env var NAMES (no values). Useful for
 * confirming what the TEE runtime injected. Hidden behind isDebugEnabled()
 * because enumerating keys also discloses presence of sensitive ones
 * (KMS_AUTH_JWT, MNEMONIC, etc.).
 */
app.get('/debug/env-keys', (c) => {
  if (!isDebugEnabled()) {
    return c.json({ error: 'debug env-keys endpoint disabled' }, 404);
  }
  const keys = Object.keys(process.env).sort();
  return c.json({ count: keys.length, keys });
});

/**
 * GET /debug/jwt
 *
 * Mints a fresh JWT via the EigenCompute attestation flow and returns the raw
 * token plus decoded header/payload. Use only when debugging gateway
 * verification with Eigen support.
 */
app.get('/debug/jwt', async (c) => {
  if (!isDebugEnabled()) {
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

/**
 * POST /vote/submit
 *
 * Submit a previously-signed Snapshot vote envelope to Snapshot's sequencer.
 * Decoupled from sign so the demo can pause between Sign → Verify → Submit
 * with the operator narrating each step.
 *
 * Safety guards:
 *   - SUBMIT_ALLOWLIST env var (comma-separated space ids). When set,
 *     submission is rejected for any space not on the list. Defaults to
 *     allowing the configured DAO_SPACE_PUBLIC space only.
 *   - Caller must be authenticated (the audit trail records who submitted).
 *   - The signature is re-verified locally before posting.
 *
 * Body: { envelope: SignedVoteEnvelope }
 */
app.post('/vote/submit', async (c) => {
  let address: string;
  try {
    address = requireAuth(c);
  } catch {
    return c.json({ error: 'authentication required' }, 401);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const envelope = body?.envelope as SignedVoteEnvelope | undefined;
  if (!envelope || !envelope.address || !envelope.sig || !envelope.data?.message) {
    return c.json({ error: 'body must include a signed vote envelope' }, 400);
  }

  const targetSpace = envelope.data.message.space;
  if (!isSpaceAllowedForSubmit(targetSpace)) {
    return c.json(
      {
        error: 'space_not_allowed',
        message: `Refusing to submit to ${targetSpace}. Set SUBMIT_ALLOWLIST to allow it.`,
        allowlist: getSubmitAllowlist(),
      },
      403,
    );
  }

  // The transport JSON-encodes bigints as numbers; coerce timestamp back so
  // local re-verification uses the same shape that was signed. Validate the
  // raw value first so a non-integer can never reach BigInt() (which would
  // throw RangeError / SyntaxError and produce an opaque 500).
  const rawTimestamp = envelope.data.message.timestamp as unknown;
  const ts = typeof rawTimestamp === 'string' ? Number(rawTimestamp) : rawTimestamp;
  if (typeof ts !== 'number' || !Number.isFinite(ts) || !Number.isInteger(ts) || ts < 0) {
    return c.json({ error: 'envelope.data.message.timestamp must be a non-negative integer' }, 400);
  }
  const restoredEnvelope: SignedVoteEnvelope = {
    ...envelope,
    data: {
      ...envelope.data,
      message: {
        ...envelope.data.message,
        timestamp: BigInt(ts),
      },
    },
  };

  // verifyEnvelope can throw InvalidAddressError from viem when address is
  // not a valid 20-byte hex (or when the typed-data shape is malformed).
  // Translate to a clean 400 instead of a bare 500 from the unhandled throw.
  let recovered: boolean;
  try {
    recovered = await verifyEnvelope(restoredEnvelope);
  } catch (e) {
    return c.json(
      {
        error: 'envelope_malformed',
        message: e instanceof Error ? e.message : String(e),
      },
      400,
    );
  }
  if (!recovered) {
    return c.json(
      { error: 'envelope signature does not recover to its declared address' },
      400,
    );
  }

  const result = await submitVote(restoredEnvelope);
  auditVoteSubmission({
    user_id: findOrCreateUser(address).id,
    space: targetSpace,
    proposal: envelope.data.message.proposal,
    choice: envelope.data.message.choice,
    from: envelope.address,
    result,
  });

  // Return both the raw result and a Snapshot UI link so the frontend can
  // open it directly. The UI URL pattern is `https://snapshot.org/#/{space}/proposal/{id}`.
  const snapshotUrl = `https://snapshot.org/#/${targetSpace}/proposal/${envelope.data.message.proposal}`;
  return c.json({
    ...result,
    space: targetSpace,
    proposal_id: envelope.data.message.proposal,
    snapshot_url: snapshotUrl,
  });
});

// Snapshot space ids are case-insensitive in the UI and Snapshot's GraphQL
// always returns them lowercase, so we normalize everywhere we touch them.
// Without this, an operator typo like SUBMIT_ALLOWLIST=ArbitrumFoundation.eth
// would silently reject every submit even though the displayed allowlist
// looks correct.
function normalizeSpace(s: string): string {
  return s.trim().toLowerCase();
}

function parseSpaceList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map(normalizeSpace).filter(Boolean);
}

function getSubmitAllowlist(): string[] {
  // Three sources, all unioned so an operator can extend without overriding:
  //   - SUBMIT_ALLOWLIST: explicit override (comma-separated)
  //   - DAO_SPACE_PUBLIC: the primary DAO the demo is configured against
  //   - SNAPSHOT_FALLBACK_SPACES_PUBLIC: spaces shown in the SignAndVerifyCard
  //     active-proposal picker as fallback targets when the primary has none
  const explicit = parseSpaceList(process.env.SUBMIT_ALLOWLIST);
  const primary = process.env.DAO_SPACE_PUBLIC
    ? [normalizeSpace(process.env.DAO_SPACE_PUBLIC)]
    : [];
  const fallback = parseSpaceList(process.env.SNAPSHOT_FALLBACK_SPACES_PUBLIC);
  // Dedupe preserving primary-first ordering for nicer display.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...primary, ...explicit, ...fallback]) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function isSpaceAllowedForSubmit(space: string): boolean {
  return getSubmitAllowlist().includes(normalizeSpace(space));
}

/**
 * Append a VOTE_SUBMITTED row to the audit log. Called from every code path
 * that POSTs a signed envelope to Snapshot's sequencer — without this, two
 * of three submit paths (/vote/sign, /pipeline/run) would leave no audit
 * trail and the trust narrative ("every vote audited") would be a half-truth.
 */
function auditVoteSubmission(args: {
  user_id: string;
  space: string;
  proposal: string;
  choice: number;
  from: string;
  result: { ok: true; receipt: unknown } | { ok: false; status: number; error: string };
}) {
  appendAudit({
    event_type: 'VOTE_SUBMITTED',
    user_id: args.user_id,
    payload: {
      space: args.space,
      proposal: args.proposal,
      choice: args.choice,
      from: args.from,
      ok: args.result.ok,
      receipt: args.result.ok ? args.result.receipt : undefined,
      error: args.result.ok ? undefined : args.result.error,
    },
  });
}

/**
 * GET /submit-allowlist
 *
 * Public read of the spaces the backend will accept submit requests for.
 * Lets the frontend render the allowlist near the Submit button so the
 * operator can confirm the target before casting a real Snapshot vote.
 */
app.get('/submit-allowlist', (c) => {
  return c.json({ spaces: getSubmitAllowlist() });
});

/**
 * POST /decision/verify
 *
 * Independently re-runs the deterministic policy engine against a signed
 * decision blob's inputs and confirms the result matches what was signed.
 * Demonstrates the trust path's load-bearing claim: anyone who has the
 * extraction + policy can replay the evaluation without re-running the LLM
 * and confirm what the TEE-bound wallet signed.
 *
 * Body:
 *   {
 *     blob:     SignedDecisionBlob,   // produced by /pipeline/run with sign=true
 *     policy:   PolicyProfileT,        // the policy that was evaluated
 *     analysis: ProposalAnalysisT      // the cached / live extraction
 *   }
 *
 * Returns: per-check verdicts plus an elapsed-ms timing.
 */
app.post(
  '/decision/verify',
  // Cap at 256 KB. Real decision blobs from the demo are < 50 KB; bigger
  // bodies would only be malicious or buggy callers and would otherwise be
  // free CPU + IO amplification on the single-process Hono server. Hono
  // returns a 413 with no body by default.
  bodyLimit({ maxSize: 256 * 1024 }),
  async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const blob = body?.blob as SignedDecisionBlob | undefined;
  const policyParsed = PolicyProfileSchema.safeParse(body?.policy);
  const analysis = body?.analysis as AnalysisForPolicy | undefined;
  // Optional: when supplied, we re-hash the proposal and confirm it matches
  // the proposalHash committed in the signed blob. Without this check,
  // a caller could swap analysis to one extracted from a different proposal
  // that happens to evaluate to the same decision under the same policy,
  // and the four content-addressed checks would still pass. New /vote/sign
  // pipeline supplies it; legacy callers can omit and the proposal_hash
  // check is reported as not_checked.
  const proposalRaw = body?.proposal as unknown;

  if (!blob || !blob.payload || !blob.signature || !policyParsed.success || !analysis) {
    return c.json({ error: "body must include 'blob', 'policy', and 'analysis'" }, 400);
  }
  const policy = policyParsed.data;

  const startNs = process.hrtime.bigint();

  // 1. Re-derive the deterministic rule set from the supplied policy and
  //    re-run the engine. No LLM call. No DB read. Pure replay.
  //    The engine accesses analysis.uncertainty.field_confidence and similar
  //    nested paths — a malformed analysis can throw uncaught at runtime.
  //    Catch and translate to 400 so the verify endpoint returns a clean
  //    error instead of a 500.
  const rules = compileProfileToRules(policy);
  let replayed;
  try {
    replayed = evaluatePolicy(analysis, policy, rules, {
      id: blob.payload.proposal.id,
      space: blob.payload.proposal.space,
    });
  } catch (e) {
    return c.json(
      {
        error: 'engine_error',
        message: e instanceof Error ? e.message : String(e),
      },
      400,
    );
  }

  // 2. Hash the supplied inputs the same way decision-blob.ts does at sign
  //    time. If anyone substituted a different policy or analysis, the hashes
  //    won't match the blob's commitments.
  const policyHash = hashJson(policy);
  const rulesHash = hashJson(rules);
  const analysisHash = hashJson(analysis);
  const evaluationHash = hashJson(replayed);
  const proposalHash = proposalRaw !== undefined ? hashJson(proposalRaw) : null;

  const policyMatches = policyHash === blob.payload.hashes.policy;
  const rulesMatch = rulesHash === blob.payload.hashes.rules;
  const analysisMatches = analysisHash === blob.payload.hashes.analysis;
  const evaluationMatches = evaluationHash === blob.payload.hashes.evaluation;
  const decisionMatches = replayed.decision === blob.payload.decision;
  // null means "caller did not supply proposal — check skipped". Present
  // in the response as `null` so the operator can see it was not asserted.
  const proposalMatches: boolean | null =
    proposalHash === null ? null : proposalHash === blob.payload.hashes.proposal;

  // 3. Re-verify the EIP-712 signature recovers to the agent address.
  let signatureRecovered = false;
  let signatureError: string | undefined;
  try {
    const message = blob.signature.data.message as DecisionBlobMessage;
    // The transport JSON-encodes bigints as numbers/strings; re-coerce.
    const normalized: DecisionBlobMessage = {
      ...message,
      createdAt: BigInt(message.createdAt as unknown as string | number | bigint),
    };
    signatureRecovered = await verifyTypedData({
      address: blob.signature.address,
      domain: DECISION_BLOB_DOMAIN,
      types: DECISION_BLOB_TYPES,
      primaryType: 'DecisionBlob',
      message: normalized,
      signature: blob.signature.sig,
    });
  } catch (e) {
    signatureError = e instanceof Error ? e.message : String(e);
  }

  // 4. Confirm the recovered signer is actually one of the agent wallets
  //    bound to this TEE. Without this check, anyone could fabricate a self-
  //    consistent blob signed by an arbitrary key and the verifier would
  //    return ok=true — turning the load-bearing claim of ACT 5 ("the TEE
  //    wallet signed this") into "you supplied self-consistent inputs".
  //
  //    Acceptable signers: the app-default wallet (legacy curl-demo path)
  //    and, when the caller is authed, that user's per-user wallet (the demo
  //    flow). Both are derived deterministically from the TEE-injected
  //    MNEMONIC, so any address outside this set was not produced by the
  //    enclave.
  const validAgents = new Set<string>();
  try {
    validAgents.add(walletAccount().address.toLowerCase());
  } catch {
    // No MNEMONIC: leave the set empty, every blob will fail the agent check.
  }
  const verifyAuthedAddr = getAuthedAddress(c);
  if (verifyAuthedAddr) {
    try {
      validAgents.add(userWallet(verifyAuthedAddr as `0x${string}`).address.toLowerCase());
    } catch {
      // user wallet derivation failed: skip; default-wallet check still applies
    }
  }
  const agentAddressOk = validAgents.has(blob.signature.address.toLowerCase());

  const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
  // proposalMatches is null when not asserted; treat null as "pass" for the
  // overall ok aggregate so legacy callers without the proposal field do
  // not regress to ok=false. The check value in the response makes the
  // skipped-vs-passed state legible.
  const ok =
    policyMatches &&
    rulesMatch &&
    analysisMatches &&
    evaluationMatches &&
    decisionMatches &&
    signatureRecovered &&
    agentAddressOk &&
    proposalMatches !== false;

  return c.json({
    ok,
    elapsed_ms: Math.round(elapsedMs * 100) / 100,
    engine_version: replayed.engine_version,
    replayed_decision: replayed.decision,
    signed_decision: blob.payload.decision,
    checks: {
      policy_hash: policyMatches,
      rules_hash: rulesMatch,
      analysis_hash: analysisMatches,
      evaluation_hash: evaluationMatches,
      decision: decisionMatches,
      signature: signatureRecovered,
      agent_address: agentAddressOk,
      proposal_hash: proposalMatches,
    },
    hashes: {
      policy: { signed: blob.payload.hashes.policy, replayed: policyHash },
      rules: { signed: blob.payload.hashes.rules, replayed: rulesHash },
      analysis: { signed: blob.payload.hashes.analysis, replayed: analysisHash },
      evaluation: { signed: blob.payload.hashes.evaluation, replayed: evaluationHash },
      proposal:
        proposalHash === null
          ? null
          : { signed: blob.payload.hashes.proposal, replayed: proposalHash },
    },
    signed_agent_address: blob.signature.address,
    accepted_agent_addresses: [...validAgents],
    signature_error: signatureError,
  });
});

/**
 * POST /pipeline/autopilot-run
 *
 * Batch entry point for autopilot. Frontend supplies a list of pre-fetched
 * Snapshot proposals; backend looks each up in the cached-extraction store,
 * evaluates against the user's saved policy, applies isAutopilotEligible,
 * and (when dry_run is false) signs + submits the eligible items
 * sequentially with a small inter-vote delay.
 *
 * Extraction: each item goes through runPipeline, which uses the DB cache
 * if a row exists at the current EXTRACTION_SCHEMA_VERSION and otherwise
 * calls the LLM live inside the TEE and writes through to the cache.
 * The plan phase runs items in parallel via Promise.allSettled so a single
 * slow or failing extraction does not block the rest of the batch.
 *
 * Body:
 *   {
 *     proposals: SnapshotProposalRaw[],
 *     dry_run: boolean,           // when true, builds plan but does not submit
 *     max_votes?: number,          // hard cap, default 10, max 25
 *   }
 *
 * Response:
 *   {
 *     policy_hash: string,         // commits the autopilot config to a
 *                                  // specific saved policy version
 *     autopilot: AutopilotT,
 *     plan: AutopilotPlanItem[],
 *     dry_run: boolean,
 *     submitted_count: number,
 *     capped: boolean,             // true if eligible items > max_votes
 *   }
 */
app.post(
  '/pipeline/autopilot-run',
  bodyLimit({ maxSize: 2 * 1024 * 1024 }), // 2 MB to fit ~50 raw Snapshot proposals
  async (c) => {
    let address: string;
    try {
      address = requireAuth(c);
    } catch {
      return c.json({ error: 'authentication required' }, 401);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const dryRun = body.dry_run === true;
    // Coerce max_votes defensively. Math.min(Math.max(NaN,1),25) = NaN, which
    // would silently turn slice(0,NaN) into [] and the loop into a no-op —
    // operator narrates "we just submitted 6 votes" while nothing went out.
    // Round to integer, clamp to [1,25], default 10 on any non-finite input.
    const rawMax = Number(body?.max_votes);
    const maxVotes = Number.isFinite(rawMax)
      ? Math.min(Math.max(Math.trunc(rawMax), 1), 25)
      : 10;
    // Per-item LLM call timeout. Cache hits should return in <10ms; live
    // extractions in 3-8s; 20s is a generous ceiling that catches truly
    // stuck calls without false positives. Body-overridable, clamped
    // [3s, 60s] so a misconfigured client cannot pin the batch open.
    const rawTimeout = Number(body?.extraction_timeout_ms);
    const extractionTimeoutMs = Number.isFinite(rawTimeout)
      ? Math.min(Math.max(Math.trunc(rawTimeout), 3_000), 60_000)
      : 20_000;
    // Soft cap on how many cache-miss items we will extract live in a
    // single batch. Bounds worst-case LLM cost when a DAO suddenly has
    // many active proposals. Items past the cap are surfaced as
    // not-eligible with reason live_extraction_budget_exceeded; a
    // follow-up batch picks them up (and the previously-extracted ones
    // are now cached and free). Body-overridable but server-side
    // clamped: real runs cap at 10, dry_run preview caps at 3 — a
    // preview click should be cheap and repeatable for the editor.
    const liveBudgetCeiling = dryRun ? 3 : 10;
    const rawBudget = Number(body?.live_extraction_budget);
    const liveExtractionBudget = Number.isFinite(rawBudget)
      ? Math.min(Math.max(Math.trunc(rawBudget), 0), liveBudgetCeiling)
      : liveBudgetCeiling;
    const proposals = Array.isArray(body.proposals) ? (body.proposals as SnapshotProposalRaw[]) : [];

    const user = findOrCreateUser(address);
    const stored = getLatestProfile(user.id);
    if (!stored) {
      return c.json(
        { error: 'no_profile', message: 'Save a policy before running autopilot.' },
        409,
      );
    }
    // safeParse instead of parse: a corrupt saved profile would otherwise
    // throw a ZodError as a 500 with the issues array as the body. Fall
    // through to normalizeProfile which already handles legacy shapes and
    // returns DEFAULT_PROFILE as a last resort.
    let profile: PolicyProfileT;
    try {
      const raw = JSON.parse(stored.profile_json);
      const parsed = PolicyProfileSchema.safeParse(raw);
      profile = parsed.success ? parsed.data : normalizeProfileFn(raw);
    } catch {
      return c.json(
        { error: 'profile_invalid', message: 'Saved policy could not be parsed; re-save from the editor.' },
        500,
      );
    }
    const policy = profile;
    const rules = compileProfileToRules(policy);

    // Live-submit gate: the user's saved policy must have autopilot.enabled.
    // Dry-run runs regardless so the editor can preview eligibility.
    //
    // For dry-run with autopilot disabled in the saved policy, force-evaluate
    // as if enabled=true so the editor preview is meaningful for the user's
    // most likely first interaction (they have not saved with enabled=true
    // yet). Without this, the dry-run plan returns all-eligible-false and
    // the operator cannot see what WOULD auto-vote.
    if (!policy.autopilot.enabled && !dryRun) {
      return c.json(
        {
          error: 'autopilot_disabled',
          message:
            'Your saved policy has autopilot disabled. Enable it in the editor and save before running autopilot live.',
        },
        400,
      );
    }
    const effectiveAutopilot = dryRun
      ? { ...policy.autopilot, enabled: true }
      : policy.autopilot;

    type PlanItem = {
      proposal_id: string;
      title: string | null;
      space: string | null;
      decision: 'FOR' | 'AGAINST' | 'ABSTAIN' | 'MANUAL_REVIEW' | null;
      confidence: number | null;
      eligible: boolean;
      reason?: string;
      // 'cache' | 'live' | 'none' — surfaces whether autopilot used a
      // pre-existing extraction or had to run the LLM live for this item.
      // Useful for cost reporting and for proving in the audit log that
      // the system extracted a brand-new proposal on its own initiative.
      extraction_source?: string;
      submitted?: { ok: boolean; snapshot_url?: string; error?: string };
    };

    // Plan phase setup: split proposals into cache-hits (free) and
    // cache-misses (each triggers one live LLM call). We pay the live cost
    // only up to liveExtractionBudget items per batch; the rest pass
    // through as not-eligible with a clear reason so the operator sees
    // them and a follow-up batch can drain them. allowLive=false on a
    // pre-classified miss makes runPipeline skip the LLM call.
    const allowLive: boolean[] = new Array(proposals.length).fill(true);
    let liveSlotsRemaining = liveExtractionBudget;
    for (let i = 0; i < proposals.length; i++) {
      const hasCache = getCachedAnalysis(proposals[i].id, EXTRACTION_SCHEMA_VERSION) !== null;
      if (hasCache) continue;
      if (liveSlotsRemaining > 0) {
        liveSlotsRemaining -= 1;
      } else {
        allowLive[i] = false;
      }
    }

    // Plan phase fan-out: each item runs through runPipeline behind a
    // per-item timeout race. runPipeline uses the cache when available
    // and otherwise calls the LLM live inside the TEE. allowLive=false
    // skips the LLM call entirely (budget exhausted). Per-item failures
    // and timeouts are isolated — they produce a single not-eligible row
    // instead of crashing the batch.
    const settled = await Promise.allSettled(
      proposals.map(async (p, i) => {
        const space = p.space?.id ?? null;
        // Budget-exceeded items: do not call the LLM. Cache hit still
        // works because runPipeline falls through to live only after
        // checking the cache; we short-circuit before that to surface a
        // clearer reason.
        if (!allowLive[i]) {
          return {
            proposal_id: p.id,
            title: p.title ?? null,
            space,
            decision: null,
            confidence: null,
            eligible: false,
            reason: 'live_extraction_budget_exceeded',
            extraction_source: 'none',
          } satisfies PlanItem;
        }
        // Per-item timeout. Math.race against a rejection so a hung LLM
        // call cannot stall the whole batch. The rejection bubbles to
        // Promise.allSettled and we surface a typed reason below.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`extraction_timeout_${extractionTimeoutMs}ms`)),
            extractionTimeoutMs,
          );
        });
        let result;
        try {
          result = await Promise.race([
            runPipeline({ proposal: p, profile: policy }),
            timeout,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (!result.evaluation || !result.analysis) {
          return {
            proposal_id: p.id,
            title: p.title ?? null,
            space,
            decision: null,
            confidence: null,
            eligible: false,
            reason: result.extraction_error
              ? `extraction_failed: ${result.extraction_error}`
              : 'no_extraction',
            extraction_source: result.extraction.source,
          } satisfies PlanItem;
        }
        const evaluation = result.evaluation;
        const eligible = isAutopilotEligible(evaluation, effectiveAutopilot);
        let reason: string | undefined;
        if (!eligible) {
          if (evaluation.decision === 'MANUAL_REVIEW') reason = 'decision_manual_review';
          else if (evaluation.confidence < effectiveAutopilot.min_confidence) reason = 'below_confidence_floor';
          else reason = 'autopilot_disabled';
        }
        return {
          proposal_id: p.id,
          title: p.title ?? null,
          space,
          decision: evaluation.decision,
          confidence: evaluation.confidence,
          eligible,
          reason,
          extraction_source: result.extraction.source,
        } satisfies PlanItem;
      }),
    );
    const plan: PlanItem[] = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      const p = proposals[i];
      const errMsg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      const isTimeout = errMsg.startsWith('extraction_timeout_');
      return {
        proposal_id: p.id,
        title: p.title ?? null,
        space: p.space?.id ?? null,
        decision: null,
        confidence: null,
        eligible: false,
        reason: isTimeout ? `extraction_timeout: ${errMsg}` : `pipeline_error: ${errMsg}`,
      };
    });

    if (dryRun) {
      const eligibleCount = plan.filter((p) => p.eligible).length;
      return c.json({
        policy_hash: stored.hash,
        autopilot: policy.autopilot,
        plan,
        dry_run: true,
        submitted_count: 0,
        capped: eligibleCount > maxVotes,
      });
    }

    // Live submit path. Sign + submit eligible items sequentially with a
    // 500ms inter-vote delay so a 10-vote batch does not look like a spike
    // to Snapshot's sequencer. Stop at maxVotes and mark capped if we did.
    const eligible = plan.filter((p) => p.eligible);
    const willSubmit = eligible.slice(0, maxVotes);
    const capped = eligible.length > maxVotes;
    // userWallet throws synchronously if MNEMONIC is missing. Catching here
    // means a misconfigured deploy returns a clean 503 instead of crashing
    // mid-batch with a stack trace in the body.
    let acct;
    try {
      acct = userWallet(address as `0x${string}`);
    } catch (e) {
      return c.json(
        {
          error: 'wallet_unavailable',
          message: e instanceof Error ? e.message : String(e),
        },
        503,
      );
    }
    const userIdForAudit = user.id;
    let submittedCount = 0;

    for (let i = 0; i < willSubmit.length; i++) {
      const item = willSubmit[i];
      const original = proposals.find((p) => p.id === item.proposal_id)!;
      // Re-grab cached for this proposal. Normally guaranteed to exist —
      // plan phase wrote through after a live extraction — but pipeline.ts
      // swallows cache-write failures (intentional: a write failure should
      // not poison the pipeline response). If the write silently failed,
      // the cache lookup here returns null. Defensive: mark the item as
      // submission-skipped with a clear reason instead of crashing the
      // whole endpoint via a non-null-assertion + null.analysis_json
      // TypeError that escapes the per-item try block below.
      const cached = getCachedAnalysis(item.proposal_id, EXTRACTION_SCHEMA_VERSION);
      if (!cached) {
        item.submitted = {
          ok: false,
          error: 'cache_lookup_failed_post_extraction',
        };
        continue;
      }
      const analysis = JSON.parse(cached.analysis_json) as AnalysisForPolicy;
      analysis.extraction_confidence = cached.extraction_confidence;
      const evaluation = evaluatePolicy(analysis, policy, rules, {
        id: item.proposal_id,
        author_address: original.author,
        space: item.space ?? undefined,
      });
      const choice = decisionToChoice(evaluation.decision);
      if (choice === null) {
        // Should never happen — eligibility already filters MANUAL_REVIEW.
        item.submitted = { ok: false, error: 'no choice mapping for decision' };
        continue;
      }

      // Allowlist gate per-proposal — defense-in-depth even though the
      // frontend constrains the dropdown to allowed spaces.
      const targetSpace = item.space ?? '';
      if (!isSpaceAllowedForSubmit(targetSpace)) {
        item.submitted = { ok: false, error: `space_not_allowed: ${targetSpace}` };
        continue;
      }

      try {
        // Sign decision blob first so the audit chain is complete even on
        // submit failure.
        await signDecisionBlob({
          account: acct,
          userAddress: address as `0x${string}`,
          proposal: original,
          policy,
          rules,
          analysis,
          evaluation,
          choice,
          pipelineVersion: 'autopilot-1',
        });

        const envelope = await signVote({
          account: acct,
          space: targetSpace,
          proposalId: item.proposal_id as `0x${string}`,
          choice,
          reason: `gov-agent autopilot v0.1: ${evaluation.decision} (engine ${evaluation.engine_version}, confidence ${evaluation.confidence.toFixed(2)})`,
        });

        const result = await submitVote(envelope);
        auditVoteSubmission({
          user_id: userIdForAudit,
          space: targetSpace,
          proposal: item.proposal_id,
          choice,
          from: envelope.address,
          result,
        });
        if (result.ok) {
          item.submitted = {
            ok: true,
            snapshot_url: `https://snapshot.org/#/${targetSpace}/proposal/${item.proposal_id}`,
          };
          submittedCount += 1;
        } else {
          item.submitted = { ok: false, error: result.error };
        }
      } catch (e) {
        item.submitted = {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }

      // Sleep between submissions; skip after the last one.
      if (i < willSubmit.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    return c.json({
      policy_hash: stored.hash,
      autopilot: policy.autopilot,
      plan,
      dry_run: false,
      submitted_count: submittedCount,
      capped,
    });
  },
);

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
