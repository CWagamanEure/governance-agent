/**
 * One-shot demo tracer.
 *
 * For each proposal named in DEMO_SCRIPT.md, prints the policy-relevant
 * extracted fields plus the full evaluation under a candidate "demo" profile,
 * and the same evaluation after each of the four ACT-2 unchecks. Lets us
 * design a profile where the four-step peel produces the documented
 * 1 / 1 / 1 / 3 flips.
 */

import {
  compileProfileToRules,
  evaluate,
  normalizeProfile,
  type AnalysisForPolicy,
  type PolicyProfileT,
} from '../src/policy.js';
import { listCachedAnalyses } from '../src/db.js';
import { EXTRACTION_SCHEMA_VERSION } from '../src/llm.js';

const DEMO_IDS = new Set([
  'cal-010-doc-translation',
  'cal-016-sdk-maintenance',
  'cal-019-mystery-grant',
  '0xd3d164905fee7dfd8516db6150a97f7f91cf6f9377f614fa6a82333c4fb20546', // Code of Conduct
  '0xf78c223115031090b918ea09fa585d340718a426a21eb1556d81d19892e10b39', // Code of Conduct (Living Documents)
  '0x04d6219c392f3f6187779f609d6cad21e3b3d6091809355ad12ba6bb39b55834', // ArbOS 60 Elara
]);

function evalSummary(
  label: string,
  cached: ReturnType<typeof listCachedAnalyses>,
  profile: PolicyProfileT,
) {
  const rules = compileProfileToRules(profile);
  const results = cached.map((c) => {
    const a = JSON.parse(c.analysis.analysis_json) as AnalysisForPolicy;
    a.extraction_confidence = c.analysis.extraction_confidence;
    const ev = evaluate(a, profile, rules, {
      id: c.proposal.id,
      author_address: c.proposal.author ?? undefined,
      space: c.proposal.space,
    });
    const top = ev.triggered_rules[0];
    return {
      id: c.proposal.id,
      title: c.proposal.title,
      space: c.proposal.space,
      decision: ev.decision,
      gating_rule: top?.id ?? '(none)',
      conf: c.analysis.extraction_confidence,
    };
  });
  const counts: Record<string, number> = { FOR: 0, AGAINST: 0, ABSTAIN: 0, MANUAL_REVIEW: 0 };
  for (const r of results) counts[r.decision]++;
  console.log(`\n=== ${label} ===`);
  console.log(`Decisions: FOR=${counts.FOR} AGAINST=${counts.AGAINST} ABSTAIN=${counts.ABSTAIN} MANUAL_REVIEW=${counts.MANUAL_REVIEW}`);
  for (const r of results) {
    if (DEMO_IDS.has(r.id)) {
      const tag = r.space === 'calibration.gov-agent' ? 'CAL' : 'REAL';
      console.log(
        `  [${tag}] ${r.decision.padEnd(13)} ← ${r.gating_rule.padEnd(40)} | ${(r.title ?? '').slice(0, 60)}`,
      );
    }
  }
  return results;
}

function printExtractionFields(cached: ReturnType<typeof listCachedAnalyses>) {
  console.log('\n=== POLICY-RELEVANT EXTRACTED FIELDS ===');
  for (const c of cached) {
    if (!DEMO_IDS.has(c.proposal.id)) continue;
    const a = JSON.parse(c.analysis.analysis_json) as AnalysisForPolicy;
    const tag = c.proposal.space === 'calibration.gov-agent' ? 'CAL' : 'REAL';
    console.log(`\n[${tag}] ${c.proposal.id}`);
    console.log(`  title:        ${c.proposal.title}`);
    console.log(`  category:     ${a.category}`);
    console.log(`  proposer.type:${a.proposer.type}`);
    console.log(`  treasury_usd: ${a.financial?.treasury_spend_usd ?? 'null'}`);
    console.log(`  recipient_ct: ${a.financial?.recipient_count ?? 'null'}  single_recipient=${a.financial?.single_recipient ?? 'null'}`);
    console.log(`  has_milestones: ${a.execution?.has_milestones ?? 'null'}  has_reporting=${a.execution?.has_reporting ?? 'null'}`);
    console.log(`  contract_upgrade: ${a.execution?.requires_contract_upgrade ?? 'null'}  ownership=${a.execution?.touches_ownership ?? 'null'}  permissions=${a.execution?.changes_permissions ?? 'null'}`);
    console.log(`  constitutional: ${a.governance?.constitutional_change ?? 'null'}`);
    console.log(`  unclear_beneficiaries: ${a.beneficiaries?.unclear_beneficiaries ?? 'null'}  scope=${a.beneficiaries?.primary_scope ?? 'null'}`);
    console.log(`  extraction_confidence: ${c.analysis.extraction_confidence}`);
    console.log(`  low_confidence_fields: ${JSON.stringify(a.uncertainty?.low_confidence_fields ?? [])}`);
    console.log(`  requires_human_judgment: ${a.uncertainty?.requires_human_judgment}`);
  }
}

const SEED_PROFILE: PolicyProfileT = normalizeProfile({
  schema_version: 'policy-v2',
  default_action: 'MANUAL_REVIEW',
  category_defaults: [
    {
      category: 'META_GOVERNANCE',
      action: 'ABSTAIN',
      max_treasury_usd: null,
      require_milestones: false,
      require_reporting: false,
      proposer_types: [],
      reason: 'meta-governance defaults to abstain unless a specific rule applies',
    },
  ],
  // GRANT and META in manual_review_categories so the peel's first two steps
  // are visible toggles. LCE intentionally OFF — the user has already accepted
  // extraction confidence as a floor; the unconditional low_conf_guard at 980
  // still catches cal-019.
  manual_review_categories: [
    'CONTRACT_UPGRADE',
    'OWNERSHIP_TRANSFER',
    'TOKENOMICS',
    'META_GOVERNANCE',
    'PARTNERSHIP',
    'GRANT',
  ],
  manual_review_flags: [
    'UNKNOWN_TREASURY_AMOUNT',
    'LARGE_TREASURY_SPEND',
    'SINGLE_RECIPIENT_TREASURY',
    'NO_MILESTONES',
    'CONTRACT_UPGRADE',
    'OWNERSHIP_OR_PERMISSION_CHANGE',
    'CONSTITUTIONAL_CHANGE',
    'UNCLEAR_BENEFICIARIES',
    'UNKNOWN_RECIPIENT',
  ],
  large_treasury_usd: 500_000,
  author_blocklist: [],
  delegation_rules: [],
  hard_rules: {
    max_single_recipient_treasury_percent: 0.5,
    max_single_recipient_treasury_usd: 500_000,
    vote_against_emission_increases: true,
    vote_for_emission_cuts: false,
    require_milestones_for_treasury: true,
  },
  stated_values: [
    'I support small accountable grants for ecosystem work, under $500k with milestones and reporting.',
    'I want META_GOVERNANCE proposals to default to ABSTAIN, since I do not have a strong opinion on most procedure changes.',
    'Anything that touches contracts, ownership, tokenomics, or partnerships should always come to me for review.',
    'I want a $500k floor on single-recipient spends and on treasury actions overall.',
  ],
});

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
function addGrantRule(p: PolicyProfileT): PolicyProfileT {
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
        reason: 'autovote small accountable grants under $500k with milestones and reporting',
      },
    ],
  };
}

function diffCount(
  before: { id: string; decision: string }[],
  after: { id: string; decision: string }[],
): number {
  const beforeMap = new Map(before.map((d) => [d.id, d.decision]));
  let n = 0;
  for (const d of after) {
    if (beforeMap.get(d.id) !== d.decision) n++;
  }
  return n;
}

function main() {
  const cached = listCachedAnalyses({
    schema_version: EXTRACTION_SCHEMA_VERSION,
    limit: 200,
  });
  console.log(`Loaded ${cached.length} cached extractions at schema=${EXTRACTION_SCHEMA_VERSION}.`);

  printExtractionFields(cached);

  const baseline = evalSummary('BASELINE (saved demo profile)', cached, SEED_PROFILE);

  const step1 = withoutCategory(SEED_PROFILE, 'META_GOVERNANCE');
  const r1 = evalSummary('STEP 1 — uncheck META_GOVERNANCE', cached, step1);
  console.log(`Flips vs baseline: ${diffCount(baseline, r1)}`);

  const step2 = addGrantRule(withoutCategory(step1, 'GRANT'));
  const r2 = evalSummary('STEP 2 — uncheck GRANT + add GRANT FOR rule', cached, step2);
  console.log(`Flips vs baseline: ${diffCount(baseline, r2)}`);

  const step3 = withoutFlag(step2, 'NO_MILESTONES');
  const r3 = evalSummary('STEP 3 — uncheck NO_MILESTONES (looks relevant, isn\'t binding)', cached, step3);
  console.log(`Flips vs baseline: ${diffCount(baseline, r3)}`);

  const step4 = withoutFlag(step3, 'SINGLE_RECIPIENT_TREASURY');
  const r4 = evalSummary('STEP 4 — uncheck SINGLE_RECIPIENT_TREASURY', cached, step4);
  console.log(`Flips vs baseline: ${diffCount(baseline, r4)}`);
}

main();
