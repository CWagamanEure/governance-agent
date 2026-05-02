/**
 * Backfill the proposal extraction cache from local Snapshot fixtures.
 *
 * Walks data/proposals/*.json, upserts each proposal into the DB, and runs
 * extractOne() for any (proposal_id, EXTRACTION_SCHEMA_VERSION) pair that
 * isn't already cached. Idempotent: re-running only fills gaps.
 *
 * Why this exists: the policy editor's "what would have changed" feedback
 * needs cached extractions so a rule edit triggers fast in-memory policy
 * re-eval, not 25+ LLM calls. Extraction is the expensive, non-deterministic
 * step; policy is fast and deterministic, so we cache only the extraction.
 *
 * Usage:
 *   npm run backfill:cache
 *   npm run backfill:cache -- --limit 25 --state closed
 *   npm run backfill:cache -- --model sonnet --in-dir data/proposals
 *   npm run backfill:cache -- --force          # re-extract even if cached
 *
 * The script will refuse to start without a working LLM provider. Either
 * set ANTHROPIC_API_KEY (local dev) or run inside the TEE where attestation
 * env vars are injected.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// Load .env for local runs. In the TEE this file doesn't exist; env vars
// are injected directly, so swallow the error.
try {
  (process as any).loadEnvFile('.env');
} catch {}

import {
  upsertProposal,
  getCachedAnalysis,
  upsertAnalysis,
  type SnapshotProposalLike,
} from '../src/db.js';
import {
  extractOne,
  pickModel,
  EXTRACTION_SCHEMA_VERSION,
  type ModelAlias,
} from '../src/llm.js';

function inputHash(p: SnapshotProposalLike): string {
  // Hash of the proposal fields the extraction prompt actually consumes.
  // Used as forensic metadata; cache key is (id, schema_version), not this.
  const payload = JSON.stringify({
    id: p.id,
    title: p.title,
    author: p.author,
    type: p.type,
    choices: p.choices,
    body: p.body,
  });
  return createHash('sha256').update(payload).digest('hex');
}

function meanFieldConfidence(analysis: any): number {
  const fc = analysis?.uncertainty?.field_confidence;
  if (!fc || typeof fc !== 'object') return 0;
  const vals = Object.values(fc).filter((v): v is number => typeof v === 'number');
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'in-dir': { type: 'string', default: 'data/proposals' },
      model: { type: 'string', default: 'sonnet' },
      limit: { type: 'string', default: '0' },
      state: { type: 'string', default: 'closed' },
      force: { type: 'boolean', default: false },
    },
  });

  const inDir = values['in-dir']!;
  const modelAlias = values.model as ModelAlias;
  const limit = Number(values.limit);
  const stateFilter = values.state!;
  const force = values.force!;

  // Surface routing upfront so misconfig is visible before we burn tokens.
  const { info } = pickModel(modelAlias);
  console.error(`Route: ${info.route}   Model: ${info.modelId}`);
  console.error(`Schema version: ${EXTRACTION_SCHEMA_VERSION}`);

  const files = readdirSync(inDir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .sort();

  let proposals: SnapshotProposalLike[] = files.map(
    (f) => JSON.parse(readFileSync(join(inDir, f), 'utf-8')) as SnapshotProposalLike,
  );

  if (stateFilter !== 'all') {
    const before = proposals.length;
    proposals = proposals.filter((p) => p.state === stateFilter);
    console.error(`Filtered state=${stateFilter}: ${before} -> ${proposals.length}`);
  }

  // Most recent first. Scripts/fetch-proposals already sorts by created desc
  // when it writes the fixtures, but we re-sort by `end` so the editor's diff
  // feedback prefers proposals whose vote outcome is most recent.
  proposals.sort((a: any, b: any) => (b.end ?? 0) - (a.end ?? 0));

  if (limit > 0) proposals = proposals.slice(0, limit);
  if (proposals.length === 0) {
    console.error('No proposals matched.');
    process.exit(1);
  }

  let extracted = 0;
  let cached = 0;
  let failed = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i]!;
    const pid = p.id;
    const title = String(p.title ?? '').replace(/\n/g, ' ').slice(0, 60);
    const tag = `[${i + 1}/${proposals.length}] ${pid.slice(0, 10)}`;

    // Always refresh proposal row — bodies/state can drift on closed
    // proposals if the fixture was re-fetched.
    upsertProposal(p);

    const existing = getCachedAnalysis(pid, EXTRACTION_SCHEMA_VERSION);
    if (existing && !force) {
      console.error(`${tag} CACHED  ${title}`);
      cached++;
      continue;
    }

    console.error(`${tag} ...     ${title}`);
    const result = await extractOne(p as Parameters<typeof extractOne>[0], modelAlias);
    if (!result.ok) {
      console.error(`        FAIL    ${result.error.slice(0, 240)}`);
      failed++;
      continue;
    }

    const usage: any = result.meta.usage ?? {};
    const inTok = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
    const outTok = Number(usage.outputTokens ?? usage.completionTokens ?? 0);
    totalIn += inTok;
    totalOut += outTok;

    upsertAnalysis({
      proposal_id: pid,
      model_name: info.route,
      model_version: result.meta.modelId,
      analysis: result.analysis,
      extraction_confidence: meanFieldConfidence(result.analysis),
      input_hash: inputHash(p),
      schema_version: EXTRACTION_SCHEMA_VERSION,
    });

    const decision = result.analysis.uncertainty.requires_human_judgment ? ' HUMAN_JUDGMENT' : '';
    const spend = result.analysis.financial.treasury_spend_usd;
    const spendStr = spend != null ? ` $${Number(spend).toLocaleString()}` : '';
    console.error(
      `        OK      category=${result.analysis.category.padEnd(22)} tokens=${inTok}/${outTok}${spendStr}${decision}`,
    );
    extracted++;
  }

  console.error('');
  console.error(`Summary: ${extracted} extracted, ${cached} cached, ${failed} failed`);
  console.error(`Tokens:  ${totalIn} in, ${totalOut} out`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
