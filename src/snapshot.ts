/**
 * Snapshot vote signing + submission.
 *
 * Snapshot uses EIP-712 typed-data signatures cast off-chain (gas-free).
 * The flow is:
 *   1. Build the typed-data Vote message with the proposal id, choice, etc.
 *   2. Sign it with the user's (or app's) account → produces a signed envelope.
 *   3. POST that envelope to Snapshot's sequencer, which validates and stores it.
 *
 * The constants below match snapshot.js v0.x (current as of 2026-04). If
 * Snapshot rotates the typed-data domain version we'll need to bump it here.
 */

import { verifyTypedData, type Hex } from 'viem';
import type { Account } from 'viem/accounts';
import type { Decision } from './policy.js';

// ---------------------------------------------------------------------------
// Typed-data shape
// ---------------------------------------------------------------------------

export const SNAPSHOT_DOMAIN = {
  name: 'snapshot',
  version: '0.1.4',
} as const;

export const VOTE_TYPES = {
  Vote: [
    { name: 'from', type: 'address' },
    { name: 'space', type: 'string' },
    { name: 'timestamp', type: 'uint64' },
    { name: 'proposal', type: 'bytes32' },
    { name: 'choice', type: 'uint32' },
    { name: 'reason', type: 'string' },
    { name: 'app', type: 'string' },
    { name: 'metadata', type: 'string' },
  ],
} as const;

export const APP_NAME = 'governance-agent';
export const SNAPSHOT_SEQUENCER_URL = 'https://seq.snapshot.org';

// ---------------------------------------------------------------------------
// Decision → choice mapping
// ---------------------------------------------------------------------------

/**
 * For Snapshot 'basic' and 'single-choice' proposals (the common case in
 * Arbitrum DAO), choices are 1-indexed: 1=For, 2=Against, 3=Abstain.
 *
 * Returns null for MANUAL_REVIEW — that decision must never produce a signed
 * vote; it's a UI-side state meaning "ask the user."
 */
export function decisionToChoice(decision: Decision): number | null {
  if (decision === 'FOR') return 1;
  if (decision === 'AGAINST') return 2;
  if (decision === 'ABSTAIN') return 3;
  return null;
}

// ---------------------------------------------------------------------------
// Envelope shape — what we send to Snapshot's sequencer
// ---------------------------------------------------------------------------

type VoteMessage = {
  from: Hex;
  space: string;
  timestamp: bigint;
  proposal: Hex;
  choice: number;
  reason: string;
  app: string;
  metadata: string;
};

export type SignedVoteEnvelope = {
  address: Hex;
  sig: Hex;
  data: {
    domain: typeof SNAPSHOT_DOMAIN;
    types: typeof VOTE_TYPES;
    primaryType: 'Vote';
    message: VoteMessage;
  };
};

export type SignVoteParams = {
  account: Account;
  space: string;
  proposalId: Hex; // 0x-prefixed bytes32
  choice: number; // 1-indexed
  reason?: string;
  metadata?: string;
};

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

export async function signVote(params: SignVoteParams): Promise<SignedVoteEnvelope> {
  if (!params.proposalId.startsWith('0x') || params.proposalId.length !== 66) {
    throw new Error(
      `Snapshot proposal id must be a 0x-prefixed 32-byte hex string; got: ${params.proposalId}`,
    );
  }
  if (!Number.isInteger(params.choice) || params.choice < 1 || params.choice > 1000) {
    throw new Error(`Invalid choice index: ${params.choice}`);
  }

  const message: VoteMessage = {
    from: params.account.address,
    space: params.space,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    proposal: params.proposalId,
    choice: params.choice,
    reason: params.reason ?? '',
    app: APP_NAME,
    metadata: params.metadata ?? '',
  };

  const signature = await params.account.signTypedData({
    domain: SNAPSHOT_DOMAIN,
    types: VOTE_TYPES,
    primaryType: 'Vote',
    message,
  });

  return {
    address: params.account.address,
    sig: signature,
    data: {
      domain: SNAPSHOT_DOMAIN,
      types: VOTE_TYPES,
      primaryType: 'Vote',
      message,
    },
  };
}

// ---------------------------------------------------------------------------
// Local verification — recover signer to confirm the envelope is well-formed
// before submitting. Catches a class of bugs locally.
// ---------------------------------------------------------------------------

export async function verifyEnvelope(envelope: SignedVoteEnvelope): Promise<boolean> {
  return verifyTypedData({
    address: envelope.address,
    domain: envelope.data.domain,
    types: envelope.data.types,
    primaryType: 'Vote',
    message: envelope.data.message,
    signature: envelope.sig,
  });
}

// ---------------------------------------------------------------------------
// Submit to sequencer
// ---------------------------------------------------------------------------

export type SubmitResult =
  | { ok: true; receipt: unknown }
  | { ok: false; status: number; error: string };

export async function submitVote(envelope: SignedVoteEnvelope): Promise<SubmitResult> {
  // Snapshot's JSON API needs numeric timestamps; bigint doesn't serialize
  // natively. Convert in place during stringify.
  const body = JSON.stringify(envelope, (_k, v) =>
    typeof v === 'bigint' ? Number(v) : v,
  );

  const res = await fetch(SNAPSHOT_SEQUENCER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: text };
  }
  let receipt: unknown = text;
  try {
    receipt = JSON.parse(text);
  } catch {
    // leave as raw string
  }
  return { ok: true, receipt };
}
