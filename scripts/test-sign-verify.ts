/**
 * Sign-then-verify smoke test.
 *
 * Picks one cached real-Arbitrum proposal, runs the full pipeline with the
 * agent wallet (signing the decision blob), then independently re-runs
 * evaluate() against the same inputs and confirms the recomputed
 * evaluationHash matches what was signed. Mirrors the demo's S2+S3 flow.
 *
 * Run with `npx tsx scripts/test-sign-verify.ts`. Requires MNEMONIC in env
 * (a deterministic test mnemonic is fine).
 */

import { mnemonicToAccount, generateMnemonic, english } from 'viem/accounts';
import {
  compileProfileToRules,
  evaluate as evaluatePolicy,
  type AnalysisForPolicy,
} from '../src/policy.js';
import { listCachedAnalyses } from '../src/db.js';
import { EXTRACTION_SCHEMA_VERSION } from '../src/llm.js';
import { runPipeline } from '../src/pipeline.js';
import {
  hashJson,
  DECISION_BLOB_DOMAIN,
  DECISION_BLOB_TYPES,
} from '../src/decision-blob.js';
import { verifyTypedData } from 'viem';
import { DEMO_PROFILE } from '../src/demo-profile.js';

async function main() {
  const cached = listCachedAnalyses({
    schema_version: EXTRACTION_SCHEMA_VERSION,
    limit: 200,
  });
  const realArb = cached.filter((c) => c.proposal.space === 'arbitrumfoundation.eth');
  if (realArb.length === 0) {
    console.error('No cached Arbitrum proposals — backfill the cache first.');
    process.exit(1);
  }
  const target = realArb[0];
  const proposalRaw = JSON.parse(target.proposal.raw_json);
  const mnemonic = process.env.MNEMONIC ?? generateMnemonic(english);
  const account = mnemonicToAccount(mnemonic);

  console.log(`Signing decision for: ${target.proposal.title?.slice(0, 60)} (${target.proposal.id.slice(0, 12)}…)`);
  console.log(`Agent wallet: ${account.address}`);

  const result = await runPipeline({
    proposal: proposalRaw,
    profile: DEMO_PROFILE,
    decisionAccount: account,
  });

  if (!result.decision_blob || !result.analysis || !result.evaluation) {
    console.error('Pipeline did not produce a decision blob.');
    console.error(result.decision_blob_error ?? '(no error)');
    process.exit(1);
  }

  console.log(`✓ Pipeline produced decision_blob: decision=${result.evaluation.decision}`);

  // Independent replay: re-derive rules + re-run engine + recompute hashes.
  const replayRules = compileProfileToRules(DEMO_PROFILE);
  const replayEval = evaluatePolicy(result.analysis as AnalysisForPolicy, DEMO_PROFILE, replayRules, {
    id: proposalRaw.id,
    space: proposalRaw.space?.id,
  });

  const replayedHashes = {
    policy: hashJson(DEMO_PROFILE),
    rules: hashJson(replayRules),
    analysis: hashJson(result.analysis),
    evaluation: hashJson(replayEval),
  };
  const signed = result.decision_blob.payload.hashes;

  function check(label: string, ok: boolean) {
    console.log(`${ok ? '✓' : '✗'} ${label}`);
    if (!ok) process.exitCode = 1;
  }

  check('decision matches', replayEval.decision === result.decision_blob.payload.decision);
  check('policy hash matches', replayedHashes.policy === signed.policy);
  check('rules hash matches', replayedHashes.rules === signed.rules);
  check('analysis hash matches', replayedHashes.analysis === signed.analysis);
  check('evaluation hash matches', replayedHashes.evaluation === signed.evaluation);

  const message = result.decision_blob.signature.data.message;
  const sigOk = await verifyTypedData({
    address: result.decision_blob.signature.address,
    domain: DECISION_BLOB_DOMAIN,
    types: DECISION_BLOB_TYPES,
    primaryType: 'DecisionBlob',
    message: { ...message, createdAt: BigInt(message.createdAt as unknown as string | number | bigint) },
    signature: result.decision_blob.signature.sig,
  });
  check('EIP-712 signature recovers', sigOk);

  if (process.exitCode === 1) {
    console.log('\n✗ Sign+verify regression — fix before the demo.');
  } else {
    console.log('\n✓ Sign-then-verify loop closed.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
