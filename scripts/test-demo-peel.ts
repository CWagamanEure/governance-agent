/**
 * Regression test for the demo's four-step peel.
 *
 * Loads the cached corpus from data/app.sqlite, applies the seeded DEMO_PROFILE,
 * then walks ACT 2 of DEMO_SCRIPT.md step by step and asserts the flip count
 * matches what the script narrates.
 *
 * Demo-day blocker — if this fails, the editor will visibly contradict the
 * narration on stage. Run before every demo: `npx tsx scripts/test-demo-peel.ts`.
 */

import {
  compileProfileToRules,
  evaluate,
  type AnalysisForPolicy,
  type PolicyProfileT,
} from '../src/policy.js';
import { listCachedAnalyses } from '../src/db.js';
import { EXTRACTION_SCHEMA_VERSION } from '../src/llm.js';
import { DEMO_PROFILE } from '../src/demo-profile.js';

type DecisionRow = { id: string; decision: string };

function evalAll(profile: PolicyProfileT): DecisionRow[] {
  const cached = listCachedAnalyses({
    schema_version: EXTRACTION_SCHEMA_VERSION,
    limit: 200,
  });
  const rules = compileProfileToRules(profile);
  return cached.map((c) => {
    const a = JSON.parse(c.analysis.analysis_json) as AnalysisForPolicy;
    a.extraction_confidence = c.analysis.extraction_confidence;
    const ev = evaluate(a, profile, rules, {
      id: c.proposal.id,
      author_address: c.proposal.author ?? undefined,
      space: c.proposal.space,
    });
    return { id: c.proposal.id, decision: ev.decision };
  });
}

function diffCount(before: DecisionRow[], after: DecisionRow[]): number {
  const m = new Map(before.map((d) => [d.id, d.decision]));
  return after.reduce((n, d) => n + (m.get(d.id) !== d.decision ? 1 : 0), 0);
}

function withoutCategory(p: PolicyProfileT, cat: string): PolicyProfileT {
  return {
    ...p,
    manual_review_categories: p.manual_review_categories.filter((c) => c !== cat),
  };
}
function withoutFlag(p: PolicyProfileT, f: string): PolicyProfileT {
  return {
    ...p,
    manual_review_flags: p.manual_review_flags.filter((x) => x !== f) as PolicyProfileT['manual_review_flags'],
  };
}
function addGrantFor(p: PolicyProfileT): PolicyProfileT {
  return {
    ...p,
    category_defaults: [
      ...p.category_defaults,
      {
        category: 'GRANT',
        action: 'FOR',
        max_treasury_usd: 500_000,
        require_milestones: true,
        require_reporting: true,
        proposer_types: [],
        reason: 'autovote small accountable grants',
      },
    ],
  };
}

function assertFlips(label: string, expected: number, actual: number) {
  const ok = actual === expected;
  const tag = ok ? '✓' : '✗';
  console.log(`${tag} ${label}: expected ${expected} flips, got ${actual}`);
  if (!ok) process.exitCode = 1;
}

const baseline = evalAll(DEMO_PROFILE);
console.log(`Loaded ${baseline.length} cached extractions; baseline computed.`);

const step1 = withoutCategory(DEMO_PROFILE, 'META_GOVERNANCE');
assertFlips('Step 1 — uncheck META_GOVERNANCE', 1, diffCount(baseline, evalAll(step1)));

const step2 = addGrantFor(withoutCategory(step1, 'GRANT'));
assertFlips('Step 2 — uncheck GRANT + add GRANT FOR rule', 1, diffCount(baseline, evalAll(step2)));

const step3 = withoutFlag(step2, 'NO_MILESTONES');
assertFlips('Step 3 — uncheck NO_MILESTONES (looks relevant, not binding)', 1, diffCount(baseline, evalAll(step3)));

const step4 = withoutFlag(step3, 'SINGLE_RECIPIENT_TREASURY');
assertFlips('Step 4 — uncheck SINGLE_RECIPIENT_TREASURY', 3, diffCount(baseline, evalAll(step4)));

if (process.exitCode === 1) {
  console.log('\n✗ Demo peel regression — fix before the demo or rewrite the script.');
} else {
  console.log('\n✓ Demo peel matches DEMO_SCRIPT.md ACT 2 (1 / 1 / 1 / 3).');
}
