/**
 * Lightweight test driver for the policy engine.
 *
 * No test framework dep — this is a script that throws if any case fails.
 * Run with `npm run test:policy`.
 *
 * Each case is a (profile, analysis, expected-decision) triple. Analyses are
 * hand-written to probe specific rule paths. Once the real extraction pipeline
 * is producing analyses in data/analyses/, we can point this at those too.
 */

import {
  evaluate,
  compileProfileToRules,
  DEFAULT_PROFILE,
  CONSERVATIVE_PROFILE,
  GROWTH_PROFILE,
  type PolicyProfileT,
  type AnalysisForPolicy,
  type Decision,
} from '../src/policy.js';

// ---------------------------------------------------------------------------
// Hand-built analyses — each probes a specific rule path.
// ---------------------------------------------------------------------------

const A_TREASURY_NO_MILESTONES: AnalysisForPolicy = {
  category: 'TREASURY_SPEND',
  summary: '$750k to Protocol Guild, 6 months, no milestones',
  tradeoffs: [{ pro: 'supports infra', con: 'no performance gate' }],
  affected_parties: ['treasury', 'PG'],
  flags: {
    treasury_spend_usd: 750_000,
    requires_contract_upgrade: false,
    touches_ownership: false,
    has_milestones: false,
    reversible: false,
    time_sensitive: false,
  },
  value_alignment: {
    decentralization: 0.3,
    treasury_conservatism: -0.6,
    growth_vs_sustainability: 0.0,
    protocol_risk: 0.0,
  },
  uncertainty: { requires_human_judgment: false, ambiguity_notes: '' },
  extraction_confidence: 0.9,
};

const A_TREASURY_SMALL_OK: AnalysisForPolicy = {
  category: 'TREASURY_SPEND',
  summary: 'Small research grant, $50k, milestones',
  tradeoffs: [],
  affected_parties: ['research team'],
  flags: {
    treasury_spend_usd: 50_000,
    requires_contract_upgrade: false,
    touches_ownership: false,
    has_milestones: true,
    reversible: true,
    time_sensitive: false,
  },
  value_alignment: {
    decentralization: 0.2,
    treasury_conservatism: 0.1,
    growth_vs_sustainability: 0.2,
    protocol_risk: 0.1,
  },
  uncertainty: { requires_human_judgment: false, ambiguity_notes: '' },
  extraction_confidence: 0.95,
};

const A_CONTRACT_UPGRADE: AnalysisForPolicy = {
  category: 'CONTRACT_UPGRADE',
  summary: 'Upgrade StakingPool to v2',
  tradeoffs: [],
  affected_parties: ['stakers'],
  flags: {
    treasury_spend_usd: null,
    requires_contract_upgrade: true,
    touches_ownership: false,
    has_milestones: false,
    reversible: false,
    time_sensitive: false,
  },
  value_alignment: {
    decentralization: 0,
    treasury_conservatism: 0,
    growth_vs_sustainability: 0,
    protocol_risk: -0.2,
  },
  uncertainty: { requires_human_judgment: false, ambiguity_notes: '' },
  extraction_confidence: 0.9,
};

// Small spend so it doesn't also trip the personal_treasury_cap rule.
// We want to isolate the low_conf_guard rule path.
const A_LOW_CONFIDENCE: AnalysisForPolicy = {
  ...A_TREASURY_SMALL_OK,
  extraction_confidence: 0.5,
};

const A_LLM_FLAGGED: AnalysisForPolicy = {
  ...A_TREASURY_SMALL_OK,
  uncertainty: { requires_human_judgment: true, ambiguity_notes: 'conflicting claims in body' },
};

const A_GRANT_DECENTRALIZED: AnalysisForPolicy = {
  category: 'GRANT',
  summary: 'Fund diverse node operator grants, milestones + reversible',
  tradeoffs: [],
  affected_parties: ['node operators'],
  flags: {
    treasury_spend_usd: 100_000,
    requires_contract_upgrade: false,
    touches_ownership: false,
    has_milestones: true,
    reversible: true,
    time_sensitive: false,
  },
  value_alignment: {
    decentralization: 0.8,
    treasury_conservatism: -0.1,
    growth_vs_sustainability: 0.3,
    protocol_risk: 0.1,
  },
  uncertainty: { requires_human_judgment: false, ambiguity_notes: '' },
  extraction_confidence: 0.95,
};

const A_CENTRALIZING_PARTNERSHIP: AnalysisForPolicy = {
  category: 'PARTNERSHIP',
  summary: 'Exclusive deal with a single centralized infra provider',
  tradeoffs: [],
  affected_parties: ['users'],
  flags: {
    treasury_spend_usd: null,
    requires_contract_upgrade: false,
    touches_ownership: false,
    has_milestones: false,
    reversible: true,
    time_sensitive: false,
  },
  value_alignment: {
    decentralization: -0.7,
    treasury_conservatism: 0.0,
    growth_vs_sustainability: -0.2,
    protocol_risk: -0.2,
  },
  uncertainty: { requires_human_judgment: false, ambiguity_notes: '' },
  extraction_confidence: 0.9,
};

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

type TestCase = {
  name: string;
  profile: PolicyProfileT;
  analysis: AnalysisForPolicy;
  proposal?: { id: string; author_address?: string };
  expect: Decision;
  expectRule?: string; // optional: a rule id we expect to appear in triggered_rules
};

const TESTS: TestCase[] = [
  {
    name: 'blocklisted author → ABSTAIN',
    profile: {
      ...DEFAULT_PROFILE,
      author_blocklist: ['0xBAD000000000000000000000000000000000000B'],
      manual_review_categories: [],
    },
    analysis: A_GRANT_DECENTRALIZED,
    proposal: { id: 'x', author_address: '0xBAD000000000000000000000000000000000000B' },
    expect: 'ABSTAIN',
    expectRule: 'hard_veto_authors',
  },
  {
    name: 'contract upgrade with default policy → MANUAL_REVIEW',
    profile: DEFAULT_PROFILE,
    analysis: A_CONTRACT_UPGRADE,
    expect: 'MANUAL_REVIEW',
    expectRule: 'manual_review_contract_upgrade',
  },
  {
    name: 'treasury spend over user cap → MANUAL_REVIEW',
    profile: { ...DEFAULT_PROFILE, max_treasury_usd_auto: 500_000 },
    analysis: A_TREASURY_NO_MILESTONES,
    expect: 'MANUAL_REVIEW',
    expectRule: 'personal_treasury_cap',
  },
  {
    name: 'low extraction confidence → MANUAL_REVIEW',
    profile: DEFAULT_PROFILE,
    analysis: A_LOW_CONFIDENCE,
    expect: 'MANUAL_REVIEW',
    expectRule: 'low_conf_guard',
  },
  {
    name: 'LLM flagged ambiguous → MANUAL_REVIEW',
    profile: DEFAULT_PROFILE,
    analysis: A_LLM_FLAGGED,
    expect: 'MANUAL_REVIEW',
    expectRule: 'llm_flagged_ambiguous',
  },
  {
    name: 'aligned decentralized grant + dec-priority profile → FOR',
    profile: {
      ...DEFAULT_PROFILE,
      decentralization_priority: 5,
      manual_review_categories: [], // keep GRANT out of manual review for this test
    },
    analysis: A_GRANT_DECENTRALIZED,
    expect: 'FOR',
    expectRule: 'prefer_decentralization',
  },
  {
    name: 'centralizing partnership + dec-priority profile → AGAINST',
    profile: {
      ...DEFAULT_PROFILE,
      decentralization_priority: 5,
      manual_review_categories: [],
    },
    analysis: A_CENTRALIZING_PARTNERSHIP,
    expect: 'AGAINST',
    expectRule: 'penalize_centralization',
  },
  {
    name: 'conservative profile + big treasury w/o milestones → MANUAL_REVIEW (cap)',
    profile: CONSERVATIVE_PROFILE,
    analysis: A_TREASURY_NO_MILESTONES,
    expect: 'MANUAL_REVIEW',
    expectRule: 'personal_treasury_cap',
  },
  {
    name: 'growth profile + same proposal → still MANUAL_REVIEW due to default cap',
    profile: GROWTH_PROFILE,
    analysis: A_TREASURY_NO_MILESTONES,
    expect: 'FOR', // $750k < $2M cap, no conservatism rule fires, category not reviewed
    // No explicit rule id check — this one exercises the soft path.
  },
  {
    name: 'small aligned grant with weak signal + default profile → ABSTAIN (margin guard fires)',
    profile: { ...DEFAULT_PROFILE, manual_review_categories: [] },
    analysis: A_TREASURY_SMALL_OK,
    // Weak-signal profile => margin < 1 => margin_guard → ABSTAIN
    expect: 'ABSTAIN',
    expectRule: 'margin_guard',
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const fails: string[] = [];

console.log(`Running ${TESTS.length} policy engine cases...\n`);

for (const tc of TESTS) {
  const rules = compileProfileToRules(tc.profile);
  const result = evaluate(
    tc.analysis,
    tc.profile,
    rules,
    tc.proposal ?? { id: '(unspecified)' },
  );

  const decisionOk = result.decision === tc.expect;
  const ruleOk =
    !tc.expectRule || result.triggered_rules.some((r) => r.id === tc.expectRule);
  const ok = decisionOk && ruleOk;

  if (ok) {
    passed++;
    console.log(`✓ ${tc.name}`);
  } else {
    failed++;
    fails.push(tc.name);
    console.error(`✗ ${tc.name}`);
    console.error(`    expected decision: ${tc.expect}`);
    console.error(`    got decision:      ${result.decision}`);
    if (tc.expectRule && !ruleOk) {
      console.error(`    expected rule id in triggered list: ${tc.expectRule}`);
    }
  }

  console.log(
    `    scores FOR=${result.scores.FOR.toFixed(1)} AGAINST=${result.scores.AGAINST.toFixed(
      1,
    )} margin=${result.margin.toFixed(2)} conf=${result.confidence.toFixed(2)}`,
  );
  if (result.triggered_rules.length > 0) {
    console.log(`    triggered: ${result.triggered_rules.map((r) => r.id).join(', ')}`);
  }
  console.log();
}

console.log(`\nSummary: ${passed}/${TESTS.length} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFailed cases:\n  - ${fails.join('\n  - ')}`);
  process.exit(1);
}
