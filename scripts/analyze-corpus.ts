/**
 * Score every cached proposal under 4 candidate policy profiles and
 * classify each into demo archetypes. Used to choose 3-5 proposals for
 * the demo script.
 *
 * Archetypes:
 *   STRICT_LOCK     — MANUAL_REVIEW under ALL profiles (correct caution).
 *   LCE_FLIP        — flips when LOW_CONFIDENCE_EXTRACTION is removed.
 *   AUTOVOTE_FLIP   — flips when a permissive category_default is added.
 *   ALREADY_MOVES   — already non-MANUAL_REVIEW under the BASELINE.
 *
 * Output: a markdown table grouping proposals by archetype so we can
 * pick demo material with eyes open.
 *
 * Usage: npx tsx scripts/analyze-corpus.ts
 */

import { listCachedAnalyses } from '../src/db.js';
import {
  DEFAULT_PROFILE,
  evaluate,
  compileProfileToRules,
  type AnalysisForPolicy,
  type Decision,
  type PolicyProfileT,
} from '../src/policy.js';
import { EXTRACTION_SCHEMA_VERSION } from '../src/llm.js';

// -----------------------------------------------------------------------
// Candidate profiles
// -----------------------------------------------------------------------

const STRICT: PolicyProfileT = {
  ...DEFAULT_PROFILE,
  manual_review_categories: [
    'TREASURY_SPEND', 'PARAMETER_CHANGE', 'CONTRACT_UPGRADE', 'OWNERSHIP_TRANSFER',
    'GRANT', 'COUNCIL_APPOINTMENT', 'PARTNERSHIP', 'TOKENOMICS', 'META_GOVERNANCE',
  ],
  category_defaults: [],
};

const BASELINE: PolicyProfileT = DEFAULT_PROFILE;

const PERMISSIVE_NO_LCE: PolicyProfileT = {
  ...DEFAULT_PROFILE,
  manual_review_flags: DEFAULT_PROFILE.manual_review_flags.filter((f) => f !== 'LOW_CONFIDENCE_EXTRACTION'),
};

const AGGRESSIVE: PolicyProfileT = {
  ...DEFAULT_PROFILE,
  manual_review_flags: DEFAULT_PROFILE.manual_review_flags.filter((f) => f !== 'LOW_CONFIDENCE_EXTRACTION'),
  manual_review_categories: ['CONTRACT_UPGRADE', 'OWNERSHIP_TRANSFER'],
  category_defaults: [
    {
      category: 'GRANT',
      action: 'FOR',
      max_treasury_usd: 500_000,
      require_milestones: true,
      require_reporting: false,
      proposer_types: [],
      reason: 'permissive grant autovote',
    },
    {
      category: 'PARAMETER_CHANGE',
      action: 'FOR',
      max_treasury_usd: null,
      require_milestones: false,
      require_reporting: false,
      proposer_types: [],
      reason: 'permissive param-change autovote',
    },
    {
      category: 'META_GOVERNANCE',
      action: 'ABSTAIN',
      max_treasury_usd: null,
      require_milestones: false,
      require_reporting: false,
      proposer_types: [],
      reason: 'abstain on meta-gov by default',
    },
  ],
};

const PROFILES = { STRICT, BASELINE, PERMISSIVE_NO_LCE, AGGRESSIVE };

// -----------------------------------------------------------------------
// Score
// -----------------------------------------------------------------------

const cached = listCachedAnalyses({ schema_version: EXTRACTION_SCHEMA_VERSION, limit: 50 });

type Row = {
  id: string;
  title: string;
  category: string;
  conf: number;
  rhj: boolean;
  spend: number | null;
  milestones: boolean;
  single_recipient: boolean | null;
  unclear_beneficiaries: boolean;
  named_recipients_count: number;
  low_conf_count: number;
  decisions: Record<string, { decision: Decision; rules: string[] }>;
};

function rowFromCached(c: typeof cached[number]): Row {
  const a = JSON.parse(c.analysis.analysis_json) as AnalysisForPolicy;
  a.extraction_confidence = c.analysis.extraction_confidence;
  let raw: any = null;
  try { raw = JSON.parse(c.proposal.raw_json); } catch {}

  const decisions: Row['decisions'] = {};
  for (const [name, profile] of Object.entries(PROFILES)) {
    const rules = compileProfileToRules(profile);
    const ev = evaluate(a, profile, rules, {
      id: c.proposal.id,
      author_address: raw?.author ?? c.proposal.author ?? undefined,
      space: c.proposal.space,
    });
    decisions[name] = {
      decision: ev.decision,
      rules: ev.triggered_rules.map((r) => r.id),
    };
  }

  return {
    id: c.proposal.id,
    title: c.proposal.title ?? '(untitled)',
    category: a.category,
    conf: c.analysis.extraction_confidence,
    rhj: a.uncertainty.requires_human_judgment,
    spend: a.financial.treasury_spend_usd,
    milestones: a.execution.has_milestones,
    single_recipient: a.financial.single_recipient,
    unclear_beneficiaries: a.beneficiaries.unclear_beneficiaries,
    named_recipients_count: a.beneficiaries.named_recipients?.length ?? 0,
    low_conf_count: a.uncertainty.low_confidence_fields?.length ?? 0,
    decisions,
  };
}

const rows = cached.map(rowFromCached);

// -----------------------------------------------------------------------
// Classify
// -----------------------------------------------------------------------

type Archetype = 'STRICT_LOCK' | 'ALREADY_MOVES' | 'LCE_FLIP' | 'AUTOVOTE_FLIP' | 'AGGRESSIVE_FLIP' | 'OTHER';

function classify(r: Row): Archetype {
  const d = r.decisions;
  const isMR = (x: Decision) => x === 'MANUAL_REVIEW';
  const baseline = d.BASELINE.decision;
  const strict = d.STRICT.decision;
  const noLce = d.PERMISSIVE_NO_LCE.decision;
  const agg = d.AGGRESSIVE.decision;

  // Already non-manual under baseline — this proposal is already escaping
  // MANUAL_REVIEW with the conservative default profile.
  if (!isMR(baseline)) return 'ALREADY_MOVES';

  // Stays MANUAL_REVIEW under every profile. Best "system is appropriately
  // cautious" demo — shows the safety floor holding.
  if (isMR(strict) && isMR(baseline) && isMR(noLce) && isMR(agg)) return 'STRICT_LOCK';

  // Flips specifically when LCE is removed. Best "user has real control
  // over their risk tolerance" demo.
  if (isMR(baseline) && !isMR(noLce)) return 'LCE_FLIP';

  // Stays MANUAL_REVIEW even without LCE, but flips with permissive
  // autovote rules. Demonstrates category-default editing.
  if (isMR(noLce) && !isMR(agg)) return 'AUTOVOTE_FLIP';

  // Catches anything weird (e.g., changes between strict and baseline).
  return 'OTHER';
}

const grouped = new Map<Archetype, Row[]>();
for (const r of rows) {
  const a = classify(r);
  if (!grouped.has(a)) grouped.set(a, []);
  grouped.get(a)!.push(r);
}

// -----------------------------------------------------------------------
// Print report
// -----------------------------------------------------------------------

function fmt(d: { decision: Decision; rules: string[] }): string {
  const headRule = d.rules[0] ?? '';
  return `${d.decision.padEnd(14)} (${headRule})`;
}

function brief(r: Row): string {
  const spend = r.spend != null ? `$${r.spend.toLocaleString()}` : 'spend?';
  const flags: string[] = [];
  if (r.rhj) flags.push('rhj');
  if (r.milestones) flags.push('mile');
  if (r.single_recipient) flags.push('1recip');
  if (r.unclear_beneficiaries) flags.push('unclear');
  return `[conf=${r.conf.toFixed(2)} ${flags.join(',')} ${spend}]`;
}

const order: Archetype[] = ['ALREADY_MOVES', 'AUTOVOTE_FLIP', 'LCE_FLIP', 'OTHER', 'STRICT_LOCK'];
let demoCandidates = 0;

for (const a of order) {
  const list = grouped.get(a) ?? [];
  if (list.length === 0) continue;
  console.log(`\n## ${a}  (${list.length})`);
  console.log('-'.repeat(80));
  for (const r of list) {
    console.log(`\n${r.title.slice(0, 78)}`);
    console.log(`  ${r.id.slice(0, 14)}…  category=${r.category}  ${brief(r)}`);
    for (const [name, d] of Object.entries(r.decisions)) {
      console.log(`    ${name.padEnd(22)}: ${fmt(d)}`);
    }
  }
  if (a !== 'STRICT_LOCK') demoCandidates += list.length;
}

console.log('\n\n' + '='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
const total = rows.length;
for (const a of order) {
  const n = grouped.get(a)?.length ?? 0;
  console.log(`  ${a.padEnd(20)} ${n}/${total}`);
}
console.log(`\n  Demo-able non-trivial proposals: ${demoCandidates}/${total}`);
console.log(`  Above 0.75 conf:                  ${rows.filter((r) => r.conf >= 0.75).length}/${total}`);
console.log(`  Below 0.75 conf:                  ${rows.filter((r) => r.conf < 0.75).length}/${total}`);
console.log(`  rhj=true:                         ${rows.filter((r) => r.rhj).length}/${total}`);
