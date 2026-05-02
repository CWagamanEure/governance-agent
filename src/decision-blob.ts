/**
 * Signed decision artifact.
 *
 * This is intentionally separate from the Snapshot vote signature. The decision
 * blob commits to the evidence and deterministic policy output; the vote
 * envelope commits to the action sent to Snapshot. Reviewers can verify both.
 */

import { createHash } from 'node:crypto';
import { verifyTypedData, type Hex } from 'viem';
import type { Account } from 'viem/accounts';

import type { AnalysisForPolicy, Decision, PolicyEvaluation, Rule } from './policy.js';
import type { SnapshotProposalRaw } from './pipeline.js';

export const DECISION_BLOB_DOMAIN = {
  name: 'governance-agent-decision',
  version: '0.2.0',
} as const;

export const DECISION_BLOB_TYPES = {
  DecisionBlob: [
    { name: 'agent', type: 'address' },
    { name: 'user', type: 'address' },
    { name: 'space', type: 'string' },
    { name: 'proposalId', type: 'string' },
    { name: 'decision', type: 'string' },
    { name: 'choice', type: 'uint32' },
    { name: 'policyHash', type: 'bytes32' },
    { name: 'rulesHash', type: 'bytes32' },
    { name: 'proposalHash', type: 'bytes32' },
    { name: 'analysisHash', type: 'bytes32' },
    { name: 'evaluationHash', type: 'bytes32' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'pipelineVersion', type: 'string' },
    { name: 'engineVersion', type: 'string' },
    { name: 'createdAt', type: 'uint64' },
  ],
} as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export type DecisionBlobMessage = {
  agent: Hex;
  user: Hex;
  space: string;
  proposalId: string;
  decision: Decision;
  choice: number;
  policyHash: Hex;
  rulesHash: Hex;
  proposalHash: Hex;
  analysisHash: Hex;
  evaluationHash: Hex;
  evidenceHash: Hex;
  pipelineVersion: string;
  engineVersion: string;
  createdAt: bigint;
};

export type DecisionBlobPayload = {
  schema_version: 'decision-blob-v1';
  created_at: number;
  agent_address: Hex;
  user_address: Hex | null;
  proposal: {
    id: string;
    title?: string;
    space?: string;
    state?: string;
  };
  decision: Decision;
  choice: number | null;
  confidence: number;
  margin: number;
  triggered_rules: PolicyEvaluation['triggered_rules'];
  hashes: {
    policy: Hex;
    rules: Hex;
    proposal: Hex;
    analysis: Hex;
    evaluation: Hex;
    evidence: Hex;
  };
  pipeline_version: string;
  engine_version: string;
};

export type SignedDecisionBlob = {
  payload: DecisionBlobPayload;
  signature: {
    address: Hex;
    sig: Hex;
    data: {
      domain: typeof DECISION_BLOB_DOMAIN;
      types: typeof DECISION_BLOB_TYPES;
      primaryType: 'DecisionBlob';
      message: DecisionBlobMessage;
    };
  };
  verification: {
    recovered: boolean;
  };
};

export type SignDecisionBlobParams = {
  account: Account;
  userAddress?: Hex | null;
  proposal: SnapshotProposalRaw;
  policy: unknown;
  rules: Rule[];
  analysis: AnalysisForPolicy;
  evaluation: PolicyEvaluation;
  choice: number | null;
  pipelineVersion: string;
};

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((key) => obj[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(',')}}`;
}

export function sha256Bytes32(value: string): Hex {
  return `0x${createHash('sha256').update(value).digest('hex')}` as Hex;
}

export function hashJson(value: unknown): Hex {
  return sha256Bytes32(stableStringify(value));
}

export async function signDecisionBlob(
  params: SignDecisionBlobParams,
): Promise<SignedDecisionBlob> {
  if (!params.account.signTypedData) {
    throw new Error('account does not support EIP-712 typed-data signing');
  }

  const choice = params.choice ?? 0;
  const createdAt = BigInt(Math.floor(Date.now() / 1000));
  const user = params.userAddress ?? ZERO_ADDRESS;
  const space = params.proposal.space?.id ?? '';

  const policyHash = hashJson(params.policy);
  const rulesHash = hashJson(params.rules);
  const proposalHash = hashJson(params.proposal);
  const analysisHash = hashJson(params.analysis);
  const evaluationHash = hashJson(params.evaluation);
  const evidenceHash = hashJson({
    proposal_hash: proposalHash,
    policy_hash: policyHash,
    rules_hash: rulesHash,
    analysis_hash: analysisHash,
    evaluation_hash: evaluationHash,
    pipeline_version: params.pipelineVersion,
    engine_version: params.evaluation.engine_version,
  });

  const message: DecisionBlobMessage = {
    agent: params.account.address,
    user,
    space,
    proposalId: params.proposal.id,
    decision: params.evaluation.decision,
    choice,
    policyHash,
    rulesHash,
    proposalHash,
    analysisHash,
    evaluationHash,
    evidenceHash,
    pipelineVersion: params.pipelineVersion,
    engineVersion: params.evaluation.engine_version,
    createdAt,
  };

  const sig = await params.account.signTypedData({
    domain: DECISION_BLOB_DOMAIN,
    types: DECISION_BLOB_TYPES,
    primaryType: 'DecisionBlob',
    message,
  });

  const recovered = await verifyTypedData({
    address: params.account.address,
    domain: DECISION_BLOB_DOMAIN,
    types: DECISION_BLOB_TYPES,
    primaryType: 'DecisionBlob',
    message,
    signature: sig,
  });

  return {
    payload: {
      schema_version: 'decision-blob-v1',
      created_at: Number(createdAt),
      agent_address: params.account.address,
      user_address: params.userAddress ?? null,
      proposal: {
        id: params.proposal.id,
        title: params.proposal.title,
        space,
        state: params.proposal.state,
      },
      decision: params.evaluation.decision,
      choice: params.choice,
      confidence: params.evaluation.confidence,
      margin: params.evaluation.margin,
      triggered_rules: params.evaluation.triggered_rules,
      hashes: {
        policy: policyHash,
        rules: rulesHash,
        proposal: proposalHash,
        analysis: analysisHash,
        evaluation: evaluationHash,
        evidence: evidenceHash,
      },
      pipeline_version: params.pipelineVersion,
      engine_version: params.evaluation.engine_version,
    },
    signature: {
      address: params.account.address,
      sig,
      data: {
        domain: DECISION_BLOB_DOMAIN,
        types: DECISION_BLOB_TYPES,
        primaryType: 'DecisionBlob',
        message,
      },
    },
    verification: { recovered },
  };
}
