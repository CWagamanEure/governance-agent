/**
 * Thin API layer talking to the deployed governance-agent backend
 * (Hono running inside the EigenCompute TEE) and to Snapshot's GraphQL.
 */

const DEFAULT_BACKEND_URL =
  typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'http://127.0.0.1:8000';

export const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? DEFAULT_BACKEND_URL;

export const EIGEN_APP_ID = '0xc9645B5C0A942e4dE16525513FE36D48DA7D911d';
export const EIGEN_VERIFY_URL = `https://verify.eigencloud.xyz/app/${EIGEN_APP_ID}`;

export const SNAPSHOT_GQL = 'https://hub.snapshot.org/graphql';

// ---------------------------------------------------------------------------
// Backend types — mirror the server's response shapes.
// ---------------------------------------------------------------------------

export type Health = { ok: boolean; version: string };
export type WalletInfo = { address: string; derivation_path: string };
// Mirror of src/attestation.ts AttestationReport — every field that the
// AttestationCard renders should be declared here so the component reads
// it without `any` casts. Keep in sync with attestation.ts when fields
// change.
export type AttestationStub = {
  status: 'available' | 'unavailable' | string;
  note?: string;
  generated_at?: number;
  public_env?: Record<string, string>;
  wallet_address?: string | null;
  app?: {
    name?: string;
    version?: string;
    wallet_address?: string | null;
    public_env?: Record<string, string>;
  };
  runtime?: {
    tee_socket_path?: string;
    kms_server_url_present?: boolean;
    kms_public_key_present?: boolean;
    kms_auth_jwt_present?: boolean;
  };
  bound_evidence?: {
    ok?: boolean;
    socket_path?: string;
    challenge_b64?: string;
    challenge_sha256?: string;
    evidence_b64?: string;
    evidence_sha256?: string;
    evidence_bytes?: number;
    error?: string;
  };
  kms_jwt?: {
    ok?: boolean;
    source?: 'KMS_AUTH_JWT' | 'attest-client' | 'none' | string;
    audience?: string;
    error?: string;
    decoded?: {
      header?: { alg?: string; typ?: string };
      payload?: {
        app_id?: string;
        sub?: string;
        iss?: string;
        aud?: string[];
        exp?: number;
        iat?: number;
        hardened?: boolean;
        secboot?: boolean;
        hwmodel?: string;
        sevsnp?: {
          measurement?: string;
          host_data?: string;
          guest_svn?: number;
          current_tcb?: number;
          reported_tcb?: number;
          committed_tcb?: number;
        };
        submods?: {
          container?: {
            image_digest?: string;
            image_reference?: string;
            image_id?: string;
            restart_policy?: string;
            args?: string[];
            env?: Record<string, string>;
          };
        };
        gce?: {
          project_id?: string;
          project_number?: string;
          zone?: string;
          instance_name?: string;
          instance_id?: string;
        };
      };
      signature_b64url_len?: number;
      token_sha256?: string;
    };
  };
};

export type Decision = 'FOR' | 'AGAINST' | 'ABSTAIN' | 'MANUAL_REVIEW';
export type VoteDecision = Exclude<Decision, 'MANUAL_REVIEW'>;

export type TriggeredRule = {
  id: string;
  priority: number;
  reason: string;
  contribution?: Partial<Record<Decision, number>>;
};

export type PolicyEvaluation = {
  decision: Decision;
  confidence: number;
  triggered_rules: TriggeredRule[];
  scores: Record<Decision, number>;
  margin: number;
  suggested_vote: {
    decision: VoteDecision;
    confidence: number;
    reason: string;
    source: 'policy_rule' | 'score' | 'default_action' | 'review_gate';
    rule_id?: string;
  } | null;
  engine_version: string;
};

export type SignedVoteEnvelope = {
  address: string;
  sig: string;
  data: {
    domain: { name: string; version: string };
    types: { Vote: { name: string; type: string }[] };
    primaryType: 'Vote';
    message: {
      from: string;
      space: string;
      timestamp: number;
      proposal: string;
      choice: number;
      reason: string;
      app: string;
      metadata: string;
    };
  };
};

export type SubmissionResult =
  | { ok: true; receipt: any }
  | { ok: false; status: number; error: string };

export type PipelineResult = {
  proposal: { id: string; title?: string; space?: string; state?: string };
  analysis: any | null;
  extraction: {
    source: 'supplied' | 'cache' | 'live' | 'none';
    schema_version: string;
    route?: 'eigen-proxy' | 'anthropic-direct';
    modelId?: string;
    usage?: any;
    bodyTruncated?: boolean;
    cache?: {
      model_name: string;
      model_version: string;
      extraction_confidence: number;
      created_at: number;
    };
  };
  extraction_skipped: boolean;
  extraction_error?: string;
  evaluation: PolicyEvaluation | null;
  decision_blob: any | null;
  decision_blob_error?: string;
  vote: { envelope: SignedVoteEnvelope; choice: number } | null;
  submission: SubmissionResult | null;
  rationale_md: string;
  pipeline_version: string;
};

// ---------------------------------------------------------------------------
// Backend calls
// ---------------------------------------------------------------------------

export async function getHealth(): Promise<Health> {
  const r = await fetch(`${BACKEND_URL}/health`);
  return r.json();
}

export async function getWallet(): Promise<WalletInfo> {
  const r = await fetch(`${BACKEND_URL}/wallet`);
  return r.json();
}

export async function getPublicEnv(): Promise<Record<string, string>> {
  const r = await fetch(`${BACKEND_URL}/env`);
  return r.json();
}

export async function getAttestation(): Promise<AttestationStub> {
  const r = await fetch(`${BACKEND_URL}/attestation`);
  return r.json();
}

export async function runPipeline(args: {
  proposal: any;
  analysis?: any;
  profile?: any;
  sign?: boolean;
  token?: string | null;
  // Bypass caller analysis and DB cache, then call the configured model route.
  force_live_extraction?: boolean;
  // Return extraction + provenance without policy evaluation/signing.
  extract_only?: boolean;
  // Authenticated no-profile users must opt into default-policy preview.
  preview_default_policy?: boolean;
  // Optional Snapshot choice number (1=FOR, 2=AGAINST, 3=ABSTAIN). When set
  // and sign=true, the backend signs the vote with this choice instead of
  // the policy engine's recommendation. Used by the Activity tab to record
  // a user override on a MANUAL_REVIEW item.
  override_choice?: number;
  // When true, the backend POSTs the signed vote envelope to Snapshot's
  // sequencer. Default is sign-only — useful for previews and demos that
  // shouldn't pollute live DAO records.
  submit?: boolean;
}): Promise<PipelineResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (args.token) headers.authorization = `Bearer ${args.token}`;
  const { token: _t, ...body } = args;
  const r = await fetch(`${BACKEND_URL}/pipeline/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    let message = `pipeline error: ${r.status} ${text}`;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message ?? parsed.error ?? `pipeline error: ${r.status}`;
    } catch {
      // Keep the raw text fallback.
    }
    throw new Error(message);
  }
  return r.json();
}

// ---------------------------------------------------------------------------
// Profile (authed)
// ---------------------------------------------------------------------------

export type StoredProfile = {
  user: { id: string; eth_address: string };
  profile: {
    id: string;
    version: number;
    hash: string;
    created_at: number;
    profile_json: any;
    rules_json: any[];
  } | null;
};

export async function getProfile(token: string): Promise<StoredProfile | null> {
  const r = await fetch(`${BACKEND_URL}/profile`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.status === 404) {
    const j = (await r.json()) as StoredProfile;
    return j;
  }
  if (!r.ok) throw new Error(`profile fetch failed: ${r.status}`);
  return r.json();
}

export async function saveProfile(args: {
  token: string;
  profile: any;
}): Promise<{
  user: { id: string; eth_address: string };
  profile: { id: string; version: number; hash: string; created_at: number };
  compiled_rule_count: number;
}> {
  const r = await fetch(`${BACKEND_URL}/profile`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({ profile: args.profile }),
  });
  if (!r.ok) throw new Error(`profile save failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function resetDemo(token: string): Promise<{ ok: true; votes: number; decisions: number; profiles: number }> {
  // skip_seed wipes the user back to a fresh onboarding state instead of
  // installing the hand-tuned DEMO_PROFILE. This is what the Reset button
  // does now: the user re-runs onboarding (with the "Use example values"
  // and "Use example calibration" shortcuts to keep it fast).
  const r = await fetch(`${BACKEND_URL}/demo/reset`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ skip_seed: true }),
  });
  if (!r.ok) throw new Error(`reset failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export type CompiledProfileResponse = {
  profile: any;
  source: 'llm' | 'fallback';
  warnings?: string[];
};

export async function compileProfile(args: {
  token: string;
  stated_values_text: string;
  calibration: Array<{
    proposal_id: string;
    proposal_title?: string;
    proposal_category?: string;
    proposal_summary?: string;
    user_choice: 'FOR' | 'AGAINST' | 'ABSTAIN';
    reason?: string;
    personal_not_policy?: boolean;
  }>;
}): Promise<CompiledProfileResponse> {
  const r = await fetch(`${BACKEND_URL}/profile/compile`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({
      stated_values_text: args.stated_values_text,
      calibration: args.calibration,
    }),
  });
  if (!r.ok) throw new Error(`profile compile failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Cached proposals + policy preview (editor diff feedback)
// ---------------------------------------------------------------------------

export type CachedProposalRow = {
  proposal: {
    id: string;
    space: string;
    title: string | null;
    author: string | null;
    state: string | null;
    end_ts: number | null;
    raw: any;
  };
  analysis: {
    id: string;
    model_name: string;
    model_version: string;
    extraction_confidence: number;
    extraction_schema_version: string;
    created_at: number;
    analysis: any;
  };
};

export async function getCachedProposals(args: {
  token: string;
  limit?: number;
}): Promise<{ schema_version: string; count: number; items: CachedProposalRow[] }> {
  const url = new URL(`${BACKEND_URL}/proposals/cached`);
  if (args.limit) url.searchParams.set('limit', String(args.limit));
  const r = await fetch(url, { headers: { authorization: `Bearer ${args.token}` } });
  if (!r.ok) throw new Error(`cached proposals failed: ${r.status}`);
  return r.json();
}

export type PolicyPreviewDecision = {
  proposal_id: string;
  proposal_title: string | null;
  decision: Decision;
  confidence: number;
  triggered_rule_ids: string[];
};

export async function previewPolicy(args: {
  token: string;
  profile: any;
}): Promise<{ schema_version: string; count: number; decisions: PolicyPreviewDecision[] }> {
  const r = await fetch(`${BACKEND_URL}/policy/preview`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({ profile: args.profile }),
  });
  if (!r.ok) throw new Error(`policy preview failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Decision blob verify — independent replay of a signed evaluation
// ---------------------------------------------------------------------------

export type DecisionVerifyResult = {
  ok: boolean;
  elapsed_ms: number;
  engine_version: string;
  replayed_decision: Decision;
  signed_decision: Decision;
  checks: {
    policy_hash: boolean;
    rules_hash: boolean;
    analysis_hash: boolean;
    evaluation_hash: boolean;
    decision: boolean;
    signature: boolean;
    // Confirms the blob was signed by an agent wallet derived from the TEE-
    // injected MNEMONIC, not an arbitrary key. Without this, a self-
    // consistent forged blob would verify ok.
    agent_address: boolean;
    // null when the caller did not supply the proposal in the verify body
    // (legacy callers); true/false when supplied and re-hashed.
    proposal_hash: boolean | null;
  };
  hashes: {
    policy: { signed: string; replayed: string };
    rules: { signed: string; replayed: string };
    analysis: { signed: string; replayed: string };
    evaluation: { signed: string; replayed: string };
    // null when the caller did not supply the proposal.
    proposal: { signed: string; replayed: string } | null;
  };
  signed_agent_address?: string;
  accepted_agent_addresses?: string[];
  signature_error?: string;
};

export async function verifyDecisionBlob(args: {
  blob: any;
  policy: any;
  analysis: any;
  // Optional: when supplied, the backend re-hashes the proposal and asserts
  // it matches the proposalHash committed in the signed blob. Strengthens
  // the verify guarantee from "internally consistent" to "the analysis
  // belongs to the proposal that was signed".
  proposal?: any;
  // Optional bearer token. When present the backend can derive the
  // caller's per-user wallet and accept signatures from it; without it
  // only the app-default wallet is in the valid-agents set, so per-user
  // signed blobs report AGENT_ADDRESS mismatch even when otherwise valid.
  token?: string;
}): Promise<DecisionVerifyResult> {
  const { token, ...rest } = args;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BACKEND_URL}/decision/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify(rest),
  });
  if (!r.ok) throw new Error(`verify failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Snapshot vote submission — post a previously-signed envelope live
// ---------------------------------------------------------------------------

export type VoteSubmitResult = {
  ok: boolean;
  status?: number;
  error?: string;
  receipt?: any;
  space: string;
  proposal_id: string;
  snapshot_url: string;
};

export async function fetchSubmitAllowlist(): Promise<string[]> {
  const r = await fetch(`${BACKEND_URL}/submit-allowlist`);
  if (!r.ok) return [];
  const j = (await r.json()) as { spaces?: string[] };
  return j.spaces ?? [];
}

// ---------------------------------------------------------------------------
// Autopilot batch run (dry-run preview + live submit)
// ---------------------------------------------------------------------------

export type AutopilotPlanItem = {
  proposal_id: string;
  title: string | null;
  space: string | null;
  decision: 'FOR' | 'AGAINST' | 'ABSTAIN' | 'MANUAL_REVIEW' | null;
  confidence: number | null;
  eligible: boolean;
  reason?: string;
  // Whether autopilot used a pre-existing cache or scored this proposal
  // live in the TEE. 'live' means the system extracted a brand-new
  // proposal on its own initiative.
  extraction_source?: 'cache' | 'live' | 'supplied' | 'none';
  submitted?: { ok: boolean; snapshot_url?: string; error?: string };
};

export type AutopilotRunResult = {
  policy_hash: string;
  autopilot: {
    enabled: boolean;
    min_confidence: number;
    decisions: Array<'FOR' | 'AGAINST' | 'ABSTAIN'>;
  };
  plan: AutopilotPlanItem[];
  dry_run: boolean;
  submitted_count: number;
  capped: boolean;
};

export async function runAutopilot(args: {
  token: string;
  proposals: any[];
  dry_run: boolean;
  max_votes?: number;
}): Promise<AutopilotRunResult> {
  const r = await fetch(`${BACKEND_URL}/pipeline/autopilot-run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({
      proposals: args.proposals,
      dry_run: args.dry_run,
      max_votes: args.max_votes,
    }),
  });
  const text = await r.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`autopilot-run failed: ${r.status} ${text}`);
  }
  if (!r.ok) {
    throw new Error(body?.message ?? body?.error ?? `autopilot-run failed: ${r.status}`);
  }
  return body;
}

export async function submitVoteEnvelope(args: {
  token: string;
  envelope: any;
}): Promise<VoteSubmitResult> {
  const r = await fetch(`${BACKEND_URL}/vote/submit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({ envelope: args.envelope }),
  });
  // Backend returns the SubmitResult shape (ok=false carries a status field)
  // wrapped in 200 even when Snapshot rejected — except for our own 400/401/403
  // gates where the envelope was malformed or the space wasn't allowed.
  const text = await r.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`vote submit failed: ${r.status} ${text}`);
  }
  if (!r.ok) {
    throw new Error(body?.message ?? body?.error ?? `vote submit failed: ${r.status}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Snapshot — fetch a single proposal by id
// ---------------------------------------------------------------------------

const PROPOSAL_QUERY = `
query Proposal($id: String!) {
  proposal(id: $id) {
    id title body author type choices state created end snapshot
    space { id name }
  }
}`;

export async function fetchSnapshotProposal(id: string): Promise<any> {
  const r = await fetch(SNAPSHOT_GQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: PROPOSAL_QUERY, variables: { id } }),
  });
  const json = await r.json();
  return json?.data?.proposal ?? null;
}

const ACTIVE_PROPOSALS_QUERY = `
query Active($space: String!, $first: Int!) {
  proposals(
    first: $first,
    where: { space: $space, state: "active" },
    orderBy: "end",
    orderDirection: asc
  ) {
    id title state end
  }
}`;

export async function fetchActiveProposals(space: string, first = 3): Promise<{ id: string; title: string; end: number }[]> {
  const r = await fetch(SNAPSHOT_GQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: ACTIVE_PROPOSALS_QUERY, variables: { space, first } }),
  });
  const json = await r.json();
  return json?.data?.proposals ?? [];
}
