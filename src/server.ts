/**
 * EigenCompute hello-world for the governance-agent project.
 *
 * Validates three things on a real EigenCompute deployment before any
 * governance code gets wired in:
 *   1. Container builds, deploys, and serves HTTP.
 *   2. The MNEMONIC env var is injected and we can derive a wallet from it.
 *   3. The wallet can sign a message and the signature recovers correctly.
 */

import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

// Load .env if present (local dev). On EigenCompute the file isn't shipped
// in the image — env vars come from the platform, so this no-ops there.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

import { mnemonicToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { extractOne, pickModel, type ModelAlias } from './llm.js';
import {
  signVote,
  verifyEnvelope,
  submitVote,
  decisionToChoice,
  APP_NAME as SNAPSHOT_APP_NAME,
} from './snapshot.js';
import type { Decision } from './policy.js';
import { runPipeline, type SnapshotProposalRaw } from './pipeline.js';
import type { AnalysisForPolicy, PolicyProfileT } from './policy.js';

const VERSION = '0.1.0';
const WALLET_PATH = "m/44'/60'/0'/0/0"; // viem default, documented for responses

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

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const app = new Hono();

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
 *     profile?:    <PolicyProfileT, defaults to DEFAULT_PROFILE>,
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
  const profile = body?.profile as PolicyProfileT | undefined;
  const shouldSign = body?.sign === true;

  let account;
  if (shouldSign) {
    try {
      account = walletAccount();
    } catch (e: any) {
      return c.json({ error: `cannot sign: ${e.message}` }, 503);
    }
  }

  const result = await runPipeline({ proposal, analysis, profile, account });

  // bigint timestamps in vote envelopes don't JSON-serialize natively
  const safe = JSON.parse(
    JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)),
  );

  return c.json(safe);
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

app.get('/attestation', (c) => {
  let walletAddress: string | null = null;
  try {
    walletAddress = walletAccount().address;
  } catch {
    // intentionally ignored — attestation response is useful even without wallet
  }
  return c.json({
    status: 'stub',
    note: 'TDX quote retrieval not yet implemented. Pending EigenCompute runtime API confirmation.',
    public_env: publicEnv(),
    wallet_address: walletAddress,
  });
});

const port = Number(process.env.PORT ?? 8000);
console.log(`[governance-agent] starting on :${port}`);
serve({ fetch: app.fetch, port });
