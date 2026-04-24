/**
 * Run structured LLM extraction on saved Snapshot proposals.
 *
 * Prototype for the production pipeline's Call 1 (see PLAN.md §9).
 *
 * Usage:
 *   # one proposal
 *   npm run extract -- data/proposals/0xabc123.json
 *
 *   # all fixtures
 *   npm run extract
 *
 *   # limit + skip already-done
 *   npm run extract -- --limit 5 --skip-existing
 *
 *   # choose model alias (sonnet | opus | haiku)
 *   npm run extract -- --model opus --limit 3
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { extractOne, pickModel, type ModelAlias } from '../src/llm.js';

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      'in-dir': { type: 'string', default: 'data/proposals' },
      'out-dir': { type: 'string', default: 'data/analyses' },
      model: { type: 'string', default: 'sonnet' },
      limit: { type: 'string', default: '0' },
      'skip-existing': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const inDir = values['in-dir']!;
  const outDir = values['out-dir']!;
  const modelAlias = values.model as ModelAlias;
  const limit = Number(values.limit);
  const skipExisting = values['skip-existing']!;

  // Print route upfront so mis-routing is visible immediately
  const { info } = pickModel(modelAlias);
  console.error(`Route: ${info.route}   Model: ${info.modelId}`);

  // Resolve input paths
  let paths: string[];
  if (positionals.length > 0) {
    paths = positionals;
  } else {
    paths = readdirSync(inDir)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .sort()
      .map((f) => join(inDir, f));
  }
  if (limit > 0) paths = paths.slice(0, limit);
  if (paths.length === 0) {
    console.error('No proposal files found.');
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]!;
    const proposal = JSON.parse(readFileSync(p, 'utf-8'));
    const pid: string = proposal.id;
    const outPath = join(outDir, `${pid}.json`);

    if (skipExisting && existsSync(outPath)) {
      console.error(`[${i + 1}/${paths.length}] SKIP   ${pid.slice(0, 10)}...`);
      skipped++;
      continue;
    }

    const title = String(proposal.title ?? '').replace(/\n/g, ' ').slice(0, 60);
    console.error(`[${i + 1}/${paths.length}] ...    ${pid.slice(0, 10)}  '${title}'`);

    const result = await extractOne(proposal, modelAlias);

    if (!result.ok) {
      console.error(`    FAIL   ${result.error.slice(0, 300)}`);
      writeFileSync(
        join(outDir, `${pid}.error.json`),
        JSON.stringify({ error: result.error, meta: result.meta }, null, 2) + '\n',
      );
      failed++;
      continue;
    }

    const usage: any = result.meta.usage ?? {};
    const inTok = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
    const outTok = Number(usage.outputTokens ?? usage.completionTokens ?? 0);
    totalIn += inTok;
    totalOut += outTok;

    const record = {
      proposal_id: pid,
      proposal_title: proposal.title,
      analysis: result.analysis,
      meta: result.meta,
    };
    writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');

    const extras: string[] = [];
    const spend = result.analysis.flags.treasury_spend_usd;
    if (spend !== null) extras.push(`$${Number(spend).toLocaleString()}`);
    if (result.analysis.uncertainty.requires_human_judgment) extras.push('HUMAN_JUDGMENT');
    const extraStr = extras.length > 0 ? `  [${extras.join(' | ')}]` : '';
    console.error(
      `    OK     category=${result.analysis.category.padEnd(22)} tokens=${inTok}/${outTok}${extraStr}`,
    );
    ok++;
  }

  console.error('');
  console.error(`Summary: ${ok} ok, ${failed} failed, ${skipped} skipped`);
  console.error(`Tokens:  ${totalIn} in, ${totalOut} out`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
