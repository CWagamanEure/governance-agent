/**
 * CLI driver for POST /pipeline/run.
 *
 * Loads a saved Snapshot proposal, optionally a hand-built analysis fixture
 * (useful while the LLM gateway is unavailable), and POSTs to the running
 * server. Pretty-prints the resulting markdown rationale and dumps the rest.
 *
 * Usage:
 *   npm run pipeline -- \
 *     --proposal data/proposals/0xabc.json \
 *     --analysis data/analyses-mock/0xabc.json \
 *     --sign
 *
 *   # against a deployed instance
 *   npm run pipeline -- --url http://34.34.16.46:8000 \
 *     --proposal data/proposals/0xabc.json \
 *     --analysis data/analyses-mock/0xabc.json \
 *     --sign
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://localhost:8000' },
      proposal: { type: 'string', short: 'p' },
      analysis: { type: 'string', short: 'a' },
      profile: { type: 'string' },
      sign: { type: 'boolean', default: false },
    },
  });

  if (!values.proposal) {
    console.error(
      'Usage: tsx scripts/run-pipeline.ts -p <proposal.json> [-a <analysis.json>] [--profile <profile.json>] [--sign] [--url <base>]',
    );
    process.exit(1);
  }

  const proposal = JSON.parse(readFileSync(values.proposal, 'utf-8'));
  const analysis = values.analysis ? JSON.parse(readFileSync(values.analysis, 'utf-8')) : undefined;
  const profile = values.profile ? JSON.parse(readFileSync(values.profile, 'utf-8')) : undefined;

  const body = JSON.stringify({ proposal, analysis, profile, sign: values.sign });

  console.error(`POST ${values.url}/pipeline/run`);
  console.error(`  proposal: ${values.proposal}`);
  if (values.analysis) console.error(`  analysis: ${values.analysis} (LLM extraction skipped)`);
  if (values.profile) console.error(`  profile:  ${values.profile}`);
  if (values.sign) console.error(`  sign:     true (will sign with enclave wallet if decision is auto-castable)`);
  console.error('');

  const res = await fetch(`${values.url}/pipeline/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const json = (await res.json()) as Record<string, unknown>;

  // Print the human-readable rationale up top
  if (typeof json.rationale_md === 'string') {
    console.log(json.rationale_md);
  }

  console.log('');
  console.log('--- raw response ---');
  const { rationale_md: _ignore, ...rest } = json;
  console.log(JSON.stringify(rest, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
