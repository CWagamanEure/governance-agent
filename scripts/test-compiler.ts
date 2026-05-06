/**
 * Manual sanity check for the profile compiler. Not in CI — costs LLM tokens.
 *
 * Runs the compiler against three representative inputs and prints the
 * compiled PolicyProfile so you can eyeball whether autovote rules look
 * defensible (narrow conditions, supported by calibration evidence) or
 * sloppy (broad rules, weak evidence).
 *
 * Usage: npm run test:compiler
 */

try { (process as any).loadEnvFile('.env'); } catch {}

import { compileProfile, type CalibrationChoice } from '../src/profile-compiler.js';
import { initDb, getCachedAnalysis } from '../src/db.js';
import { EXTRACTION_SCHEMA_VERSION, ProposalAnalysis } from '../src/llm.js';
import {
  compileProfileToRules,
  evaluate,
  type AnalysisForPolicy,
  type PolicyProfileT,
} from '../src/policy.js';

initDb();

const SCENARIOS: { name: string; stated_values_text: string; calibration: CalibrationChoice[] }[] = [
  {
    name: 'Accountability-focused user',
    stated_values_text: [
      'I support small open-source ecosystem grants under $50k that have milestones.',
      "I'm skeptical of recurring delegate compensation programs without clear KPIs.",
      'I prefer reversible decisions over irreversible ones.',
      "I'd rather see milestone-gated grants than lump-sum disbursements.",
    ].join(' '),
    calibration: [
      { proposal_id: 'cal-001-stip-extension',     proposal_category: 'TREASURY_SPEND',  user_choice: 'AGAINST', proposal_title: 'Extend STIP with 50M ARB' },
      { proposal_id: 'cal-003-pg-grant',           proposal_category: 'GRANT',           user_choice: 'FOR',     proposal_title: 'Protocol Guild grant $400k' },
      { proposal_id: 'cal-006-dip-update',         proposal_category: 'META_GOVERNANCE', user_choice: 'AGAINST', proposal_title: 'DIP v1.7 update' },
      { proposal_id: 'cal-010-doc-translation',    proposal_category: 'GRANT',           user_choice: 'FOR',     proposal_title: 'Doc translation $12k milestones' },
      { proposal_id: 'cal-011-analytics-tooling',  proposal_category: 'GRANT',           user_choice: 'FOR',     proposal_title: 'Analytics tooling $30k milestones' },
      { proposal_id: 'cal-016-sdk-maintenance',    proposal_category: 'GRANT',           user_choice: 'FOR',     proposal_title: 'SDK maintenance $40k milestones' },
      { proposal_id: 'cal-019-mystery-grant',      proposal_category: 'GRANT',           user_choice: 'AGAINST', proposal_title: '500k ARB to anonymous multisig' },
    ],
  },
  {
    name: 'Delegation-leaning user',
    stated_values_text: [
      'On technical parameter changes, I want to follow l2beat.eth unless they have not voted.',
      'I trust the foundation on routine operational decisions.',
      'Large treasury commitments should always come to me for review.',
    ].join(' '),
    calibration: [
      { proposal_id: 'cal-002-security-council',   proposal_category: 'PARAMETER_CHANGE', user_choice: 'ABSTAIN',  proposal_title: 'Security council 7-of-12' },
      { proposal_id: 'cal-015-fee-tweak',          proposal_category: 'PARAMETER_CHANGE', user_choice: 'FOR',      proposal_title: 'Sequencer fee -5%' },
      { proposal_id: 'cal-020-l2beat-followed-vote', proposal_category: 'PARAMETER_CHANGE', user_choice: 'FOR',    proposal_title: 'l2beat-followed param tweak' },
      { proposal_id: 'cal-001-stip-extension',     proposal_category: 'TREASURY_SPEND',  user_choice: 'ABSTAIN',  proposal_title: 'Extend STIP 50M ARB' },
    ],
  },
  {
    name: 'Manual-review-everything user',
    stated_values_text:
      'I want every proposal reviewed by hand. I do not trust automated voting yet, even for routine grants. Show me everything before any vote is cast.',
    calibration: [],
  },
];

function pretty(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function summarize(p: any) {
  console.log(`  default_action:           ${p.default_action}`);
  console.log(`  manual_review_categories: ${(p.manual_review_categories ?? []).join(', ') || '(none)'}`);
  console.log(`  manual_review_flags:      ${(p.manual_review_flags ?? []).join(', ') || '(none)'}`);
  console.log(`  large_treasury_usd:       ${p.large_treasury_usd ?? 'null'}`);
  console.log(`  hard_rules:               ${pretty(p.hard_rules)}`);
  console.log(`  delegation_rules:         ${pretty(p.delegation_rules)}`);
  console.log(`  category_defaults:        (${(p.category_defaults ?? []).length})`);
  for (const d of p.category_defaults ?? []) {
    const extras = [
      d.max_treasury_usd != null ? `max=$${d.max_treasury_usd.toLocaleString()}` : null,
      d.require_milestones ? 'milestones' : null,
      d.require_reporting ? 'reporting' : null,
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`    - ${d.category} → ${d.action} ${extras}  // ${d.reason ?? ''}`);
  }
  console.log(`  stated_values:            (${(p.stated_values ?? []).length})`);
  for (const v of p.stated_values ?? []) console.log(`    - ${v}`);
}

// Run the compiled policy against the same calibration items the user voted
// on. Each item gets bucketed by what the test reveals about compiler quality:
//
//   AGREE          — policy reproduces the user's vote exactly. Compiler win.
//
//   ENGINE_FLOOR   — policy emits MANUAL_REVIEW because of a non-negotiable
//                    engine safety property (currently just `low_conf_guard`,
//                    which fires when overall extraction confidence < 0.75).
//                    Uncatchable by autovote regardless of compiler output.
//                    Doesn't reflect on the compiler at all.
//
//   COMPILER_FLAG  — policy emits MANUAL_REVIEW because of a flag/category/
//                    cap the compiler put on the profile. The user can peel
//                    these off in the editor. Whether to add them by default
//                    is a product judgment, not a bug.
//
//   COMPILER_BUG   — policy autovotes a different decision than the user
//                    (e.g. user FOR, policy AGAINST). The only outcome that
//                    signals an actual compiler problem. Expect 0.
//
//   NO_EXTRACTION  — calibration item has no cached LLM extraction (run
//                    backfill-calibration). Test is meaningless on this row.
type CheckOutcome = 'AGREE' | 'ENGINE_FLOOR' | 'COMPILER_FLAG' | 'COMPILER_BUG' | 'NO_EXTRACTION';

// Rule IDs the engine adds unconditionally regardless of the compiled
// profile. If one of these is the first-triggered rule, the review is an
// engine floor — outside compiler control.
const ENGINE_FLOOR_RULE_IDS = new Set(['low_conf_guard']);

type CheckResult = {
  proposal_id: string;
  user: CalibrationChoice['user_choice'];
  policy: string;
  rules: string[];
  outcome: CheckOutcome;
};

function checkConsistency(
  profile: PolicyProfileT,
  calibration: CalibrationChoice[],
): CheckResult[] {
  const rules = compileProfileToRules(profile);
  const out: CheckResult[] = [];
  for (const c of calibration) {
    const cached = getCachedAnalysis(c.proposal_id, EXTRACTION_SCHEMA_VERSION);
    if (!cached) {
      out.push({
        proposal_id: c.proposal_id,
        user: c.user_choice,
        policy: '-',
        rules: [],
        outcome: 'NO_EXTRACTION',
      });
      continue;
    }
    const parsed = ProposalAnalysis.parse(JSON.parse(cached.analysis_json));
    const analysis: AnalysisForPolicy = {
      ...parsed,
      extraction_confidence: cached.extraction_confidence,
    };
    const r = evaluate(analysis, profile, rules, { id: c.proposal_id });
    const ruleIds = r.triggered_rules.map((x) => x.id);
    let outcome: CheckOutcome;
    if (r.decision === c.user_choice) {
      outcome = 'AGREE';
    } else if (r.decision === 'MANUAL_REVIEW') {
      // Use the first triggered rule (highest-priority that fired) to decide
      // who's responsible for the review — engine or compiler.
      outcome = ENGINE_FLOOR_RULE_IDS.has(ruleIds[0] ?? '') ? 'ENGINE_FLOOR' : 'COMPILER_FLAG';
    } else {
      outcome = 'COMPILER_BUG';
    }
    out.push({
      proposal_id: c.proposal_id,
      user: c.user_choice,
      policy: r.decision,
      rules: ruleIds,
      outcome,
    });
  }
  return out;
}

function summarizeCheck(results: CheckResult[]) {
  if (results.length === 0) {
    console.log('  (no calibration items to check)');
    return;
  }
  const counts: Record<CheckOutcome, number> = {
    AGREE: 0,
    ENGINE_FLOOR: 0,
    COMPILER_FLAG: 0,
    COMPILER_BUG: 0,
    NO_EXTRACTION: 0,
  };
  for (const r of results) counts[r.outcome]++;
  const total = results.length;
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  console.log(
    `  ${counts.AGREE}/${total} AGREE (${pct(counts.AGREE)})\n` +
      `  ${counts.ENGINE_FLOOR} ENGINE_FLOOR    (uncatchable, by design)\n` +
      `  ${counts.COMPILER_FLAG} COMPILER_FLAG   (peelable in editor)\n` +
      `  ${counts.COMPILER_BUG} COMPILER_BUG    (autovote contradicts user)` +
      (counts.NO_EXTRACTION > 0 ? `\n  ${counts.NO_EXTRACTION} NO_EXTRACTION   (run backfill-calibration)` : ''),
  );

  const bugs = results.filter((r) => r.outcome === 'COMPILER_BUG');
  if (bugs.length > 0) {
    console.log('\n  ⚠ COMPILER_BUG (autovote contradicts user — investigate):');
    for (const r of bugs) {
      console.log(`    - ${r.proposal_id}: user=${r.user} policy=${r.policy} via [${r.rules.join(', ')}]`);
    }
  }
  const flags = results.filter((r) => r.outcome === 'COMPILER_FLAG');
  if (flags.length > 0) {
    console.log('\n  · COMPILER_FLAG (compiler-added safety, peelable in editor):');
    for (const r of flags) {
      console.log(`    - ${r.proposal_id}: user=${r.user} → MANUAL_REVIEW via [${r.rules.join(', ')}]`);
    }
  }
  const floors = results.filter((r) => r.outcome === 'ENGINE_FLOOR');
  if (floors.length > 0) {
    console.log('\n  · ENGINE_FLOOR (engine-mandatory, not under compiler control):');
    for (const r of floors) {
      console.log(`    - ${r.proposal_id}: user=${r.user} → MANUAL_REVIEW via [${r.rules.join(', ')}]`);
    }
  }
  const missing = results.filter((r) => r.outcome === 'NO_EXTRACTION');
  if (missing.length > 0) {
    console.log(`\n  ! NO_EXTRACTION (run backfill-calibration first): ${missing.map((r) => r.proposal_id).join(', ')}`);
  }
}

// Strip LOW_CONFIDENCE_EXTRACTION from manual_review_flags so the user-
// controlled LCE safety floor doesn't dominate the consistency signal.
// Items below the engine's unconditional 0.75 extraction-confidence floor
// (low_conf_guard) still route to MANUAL_REVIEW — that floor is a non-
// negotiable engine property, not a compiler choice. This relaxed pass
// answers: "ignoring the safety floor the compiler always adds, do the
// category_defaults the compiler chose actually reproduce calibration?"
function relaxLce(profile: PolicyProfileT): PolicyProfileT {
  return {
    ...profile,
    manual_review_flags: (profile.manual_review_flags ?? []).filter(
      (f) => f !== 'LOW_CONFIDENCE_EXTRACTION',
    ),
  };
}

for (const s of SCENARIOS) {
  console.log('\n========================================');
  console.log(`SCENARIO: ${s.name}`);
  console.log('----------------------------------------');
  console.log(`Values: ${s.stated_values_text.slice(0, 200)}${s.stated_values_text.length > 200 ? '…' : ''}`);
  console.log(`Calibration: ${s.calibration.length} votes`);
  const r = await compileProfile(s);
  console.log(`Source:  ${r.source}${r.warnings ? ` (${r.warnings.join('; ')})` : ''}`);
  console.log('----------------------------------------');
  summarize(r.profile);
  console.log('----------------------------------------');
  console.log('STRICT pass (saved profile as-is):');
  summarizeCheck(checkConsistency(r.profile, s.calibration));
  console.log('\nRELAXED pass (LOW_CONFIDENCE_EXTRACTION flag removed):');
  summarizeCheck(checkConsistency(relaxLce(r.profile), s.calibration));
}
