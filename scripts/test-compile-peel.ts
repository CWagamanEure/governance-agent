/**
 * test:compile-peel — does the profile produced by onboarding (example
 * values + example calibration) actually reproduce DEMO_SCRIPT ACT 2's
 * 1 / 1 / 1 / 3 peel?
 *
 * Why this exists: DEMO_SCRIPT's ACT 1 walks the demonstrator through
 * onboarding via the Use example values / Use example calibration
 * shortcuts. ACT 2 then peels four manual_review settings off the
 * resulting profile and expects 1 / 1 / 1 / 3 flips. The existing
 * test:demo-peel only validates the hand-tuned DEMO_PROFILE — NOT
 * what the onboarding shortcuts actually produce on stage.
 *
 * This test runs against the heuristic fallback compiler. The LLM
 * path requires a working gateway and an API call we do not want
 * inside a regression test. If the gateway is up on stage, the LLM
 * compile will produce a different (likely closer-to-DEMO_PROFILE)
 * shape — that is the better case. If the gateway is down, the
 * fallback fires and THIS test tells us whether the demo will work.
 *
 * Failure here means the demonstrator must either:
 *   1. Ensure the LLM gateway is healthy before the demo, OR
 *   2. Manually edit the policy after onboarding to match
 *      DEMO_PROFILE before ACT 2, OR
 *   3. Update DEMO_SCRIPT ACT 2 to a flip pattern the fallback
 *      profile actually produces.
 */

import {
  compileProfileToRules,
  evaluate,
  type AnalysisForPolicy,
  type PolicyProfileT,
} from '../src/policy.js';
import { listCachedAnalyses } from '../src/db.js';
import { EXTRACTION_SCHEMA_VERSION } from '../src/llm.js';

// Source of truth for the demo onboarding inputs. The frontend
// Onboarding.tsx imports the SAME module, so this test cannot drift
// from what the demo actually uses (F6).
import {
  DEMO_VALUES_TEXT as DEMO_VALUES,
  DEMO_CALIBRATION_LIST as DEMO_CALIBRATION,
} from '../frontend/src/data/demo-values-corpus.js';

// Import the fallback compiler directly. We do not call compileProfile()
// from the API surface — that would attempt the LLM first.
import { _internal_fallbackCompile_for_test } from '../src/profile-compiler.js';

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
  return { ...p, manual_review_categories: p.manual_review_categories.filter((c) => c !== cat) };
}
function withoutFlag(p: PolicyProfileT, f: string): PolicyProfileT {
  return { ...p, manual_review_flags: p.manual_review_flags.filter((x) => x !== f) as PolicyProfileT['manual_review_flags'] };
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

// ---------------------------------------------------------------------------
// Compile the example onboarding inputs via the FALLBACK path
// ---------------------------------------------------------------------------

const compiled = _internal_fallbackCompile_for_test({
  stated_values_text: DEMO_VALUES,
  calibration: DEMO_CALIBRATION,
});

// ---------------------------------------------------------------------------
// Structural pre-flight: the peel manipulates four keys. If any are
// missing from the compiled profile, the peel cannot produce flips.
// ---------------------------------------------------------------------------

const peelKeys = {
  meta_governance_in_review_categories: compiled.manual_review_categories.includes('META_GOVERNANCE'),
  grant_in_review_categories: compiled.manual_review_categories.includes('GRANT'),
  no_milestones_flag: compiled.manual_review_flags.includes('NO_MILESTONES'),
  single_recipient_flag: compiled.manual_review_flags.includes('SINGLE_RECIPIENT_TREASURY'),
};

console.log('Compiled profile (fallback path) — peel-relevant fields:');
for (const [k, v] of Object.entries(peelKeys)) {
  console.log(`  ${v ? '✓' : '✗'} ${k}: ${v}`);
}

const missingKeys = Object.entries(peelKeys).filter(([, v]) => !v).map(([k]) => k);
if (missingKeys.length > 0) {
  console.log(
    `\n⚠ Fallback profile is missing: ${missingKeys.join(', ')}.\n` +
      '  Those peel steps will produce 0 flips against this profile.\n',
  );
}

// ---------------------------------------------------------------------------
// Run the four-step peel and report flip counts
// ---------------------------------------------------------------------------

function assertFlips(label: string, expected: number, actual: number) {
  const ok = actual === expected;
  const tag = ok ? '✓' : '✗';
  console.log(`${tag} ${label}: expected ${expected} flips, got ${actual}`);
  if (!ok) process.exitCode = 1;
}

const baseline = evalAll(compiled);
console.log(`\nLoaded ${baseline.length} cached extractions; fallback baseline computed.`);

const step1 = withoutCategory(compiled, 'META_GOVERNANCE');
assertFlips('Step 1 — uncheck META_GOVERNANCE', 1, diffCount(baseline, evalAll(step1)));

const step2 = addGrantFor(withoutCategory(step1, 'GRANT'));
assertFlips('Step 2 — uncheck GRANT + add GRANT FOR rule', 1, diffCount(baseline, evalAll(step2)));

const step3 = withoutFlag(step2, 'NO_MILESTONES');
assertFlips('Step 3 — uncheck NO_MILESTONES', 1, diffCount(baseline, evalAll(step3)));

const step4 = withoutFlag(step3, 'SINGLE_RECIPIENT_TREASURY');
assertFlips('Step 4 — uncheck SINGLE_RECIPIENT_TREASURY', 3, diffCount(baseline, evalAll(step4)));

if (process.exitCode === 1) {
  console.log(
    '\n✗ Compile-peel drift detected. The fallback compiler produces a profile that\n' +
      '  cannot reproduce DEMO_SCRIPT ACT 2 (1 / 1 / 1 / 3). On demo day either:\n' +
      '    a) ensure the LLM gateway is healthy so compileProfile takes the LLM path, OR\n' +
      '    b) manually adjust the policy after onboarding to add the missing keys, OR\n' +
      '    c) update DEMO_SCRIPT ACT 2 to a flip pattern that matches the fallback.',
  );
} else {
  console.log('\n✓ Compile-peel matches DEMO_SCRIPT ACT 2 against the fallback profile.');
}
