/**
 * Thin API layer talking to the deployed governance-agent backend
 * (Hono running inside the EigenCompute TEE) and to Snapshot's GraphQL.
 */

export const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://34.34.16.46:8000';

export const SNAPSHOT_GQL = 'https://hub.snapshot.org/graphql';

// ---------------------------------------------------------------------------
// Backend types — mirror the server's response shapes.
// ---------------------------------------------------------------------------

export type Health = { ok: boolean; version: string };
export type WalletInfo = { address: string; derivation_path: string };
export type AttestationStub = {
  status: string;
  note: string;
  public_env: Record<string, string>;
  wallet_address: string | null;
};

export type Decision = 'FOR' | 'AGAINST' | 'ABSTAIN' | 'MANUAL_REVIEW';

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

export type PipelineResult = {
  proposal: { id: string; title?: string; space?: string; state?: string };
  analysis: any | null;
  extraction_skipped: boolean;
  extraction_error?: string;
  evaluation: PolicyEvaluation | null;
  vote: { envelope: SignedVoteEnvelope; choice: number } | null;
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
}): Promise<PipelineResult> {
  const r = await fetch(`${BACKEND_URL}/pipeline/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) {
    throw new Error(`pipeline error: ${r.status} ${await r.text()}`);
  }
  return r.json();
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
