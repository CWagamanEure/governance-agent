/**
 * Lightweight test driver for the policy engine.
 *
 * No test framework dep — this is a script that throws if any case fails.
 * Run with `npm run test:policy`.
 */

import {
  evaluate,
  compileProfileToRules,
  DEFAULT_PROFILE,
  GROWTH_PROFILE,
  type PolicyProfileT,
  type AnalysisForPolicy,
  type Decision,
} from '../src/policy.js';

const FIELD_CONFIDENCE = {
  category: 0.95,
  'proposer.type': 0.95,
  'financial.treasury_spend_usd': 0.95,
  'financial.recipient_count': 0.95,
  'execution.requires_contract_upgrade': 0.95,
  'execution.reversible': 0.95,
  'governance.constitutional_change': 0.95,
  'beneficiaries.primary_scope': 0.95,
};

const A_ROUTINE_GRANT: AnalysisForPolicy = {
  category: 'GRANT',
  summary: 'Milestone-gated ecosystem grant under the default auto-vote cap.',
  tradeoffs: [{ pro: 'funds useful ecosystem work', con: 'uses treasury funds' }],
  affected_parties: ['grant recipient', 'DAO treasury'],
  proposer: {
    address: '0x1111111111111111111111111111111111111111',
    name: 'Known delegate',
    type: 'DELEGATE',
    known_delegate: true,
  },
  financial: {
    treasury_spend_usd: 75_000,
    treasury_percent: 0.05,
    recurring_payment: false,
    payment_stream: false,
    recipient_count: 3,
    single_recipient: false,
  },
  execution: {
    requires_contract_upgrade: false,
    touches_ownership: false,
    changes_permissions: false,
    creates_or_extends_council: false,
    has_milestones: true,
    has_reporting: true,
    has_clawback: false,
    reversible: true,
    time_sensitive: false,
  },
  economics: {
    emissions_change: 'NONE',
    fee_change: 'NONE',
    parameter_change: false,
  },
  governance: {
    constitutional_change: false,
    changes_voting_power: false,
    delegation_or_incentive_program: false,
  },
  beneficiaries: {
    primary_scope: 'BROAD_ECOSYSTEM',
    named_recipients: ['recipient cohort'],
    unclear_beneficiaries: false,
  },
  signals: { delegate_votes: [] },
  uncertainty: {
    requires_human_judgment: false,
    ambiguity_notes: '',
    low_confidence_fields: [],
    field_confidence: FIELD_CONFIDENCE,
  },
  extraction_confidence: 0.95,
};

const A_CONTRACT_UPGRADE: AnalysisForPolicy = {
  ...A_ROUTINE_GRANT,
  category: 'CONTRACT_UPGRADE',
  summary: 'Upgrade core protocol contracts.',
  financial: {
    ...A_ROUTINE_GRANT.financial,
    treasury_spend_usd: null,
    treasury_percent: null,
    recipient_count: null,
    single_recipient: null,
  },
  execution: {
    ...A_ROUTINE_GRANT.execution,
    requires_contract_upgrade: true,
    reversible: false,
  },
};

const A_LARGE_TREASURY: AnalysisForPolicy = {
  ...A_ROUTINE_GRANT,
  category: 'TREASURY_SPEND',
  summary: 'Large treasury spend with milestones.',
  financial: {
    ...A_ROUTINE_GRANT.financial,
    treasury_spend_usd: 750_000,
    treasury_percent: 0.4,
    recipient_count: 4,
    single_recipient: false,
  },
};

const A_SINGLE_RECIPIENT_OVER_CAP: AnalysisForPolicy = {
  ...A_ROUTINE_GRANT,
  category: 'GRANT',
  summary: 'Single-recipient grant over the hard cap but below large-review threshold.',
  financial: {
    ...A_ROUTINE_GRANT.financial,
    treasury_spend_usd: 300_000,
    treasury_percent: 0.2,
    recipient_count: 1,
    single_recipient: true,
  },
};

const A_NO_MILESTONES: AnalysisForPolicy = {
  ...A_ROUTINE_GRANT,
  execution: {
    ...A_ROUTINE_GRANT.execution,
    has_milestones: false,
  },
};

const A_LOW_CONFIDENCE: AnalysisForPolicy = {
  ...A_ROUTINE_GRANT,
  extraction_confidence: 0.5,
};

const A_LOW_FIELD_CONFIDENCE: AnalysisForPolicy = {
  ...A_ROUTINE_GRANT,
  uncertainty: {
    requires_human_judgment: false,
    ambiguity_notes: 'recipient count is unclear',
    low_confidence_fields: ['financial.recipient_count'],
    field_confidence: {
      ...FIELD_CONFIDENCE,
      'financial.recipient_count': 0.4,
    },
  },
};

const A_LLM_FLAGGED: AnalysisForPolicy = {
  ...A_ROUTINE_GRANT,
  uncertainty: {
    ...A_ROUTINE_GRANT.uncertainty,
    requires_human_judgment: true,
    ambiguity_notes: 'proposal text contains conflicting recipient claims',
  },
};

const A_EMISSION_INCREASE: AnalysisForPolicy = {
  ...A_ROUTINE_GRANT,
  category: 'TOKENOMICS',
  summary: 'Increase token emissions.',
  financial: {
    ...A_ROUTINE_GRANT.financial,
    treasury_spend_usd: null,
    treasury_percent: null,
  },
  economics: {
    ...A_ROUTINE_GRANT.economics,
    emissions_change: 'INCREASE',
  },
};

const A_PARAMETER_WITH_DELEGATE: AnalysisForPolicy = {
  ...A_ROUTINE_GRANT,
  category: 'PARAMETER_CHANGE',
  summary: 'Routine protocol parameter update.',
  financial: {
    ...A_ROUTINE_GRANT.financial,
    treasury_spend_usd: null,
    treasury_percent: null,
  },
  economics: {
    ...A_ROUTINE_GRANT.economics,
    parameter_change: true,
  },
  signals: {
    delegate_votes: [{ delegate: 'l2beat.eth', choice: 'FOR', voted_at: 1777730000 }],
  },
};

const A_PARAMETER_WITHOUT_DELEGATE: AnalysisForPolicy = {
  ...A_PARAMETER_WITH_DELEGATE,
  signals: { delegate_votes: [] },
};

const A_DIP_META: AnalysisForPolicy = {
  ...A_ROUTINE_GRANT,
  category: 'META_GOVERNANCE',
  summary: 'Update delegate incentive reporting requirements without changing budget.',
  financial: {
    ...A_ROUTINE_GRANT.financial,
    treasury_spend_usd: null,
    treasury_percent: null,
    recipient_count: null,
    single_recipient: null,
  },
  governance: {
    ...A_ROUTINE_GRANT.governance,
    delegation_or_incentive_program: true,
  },
  beneficiaries: {
    primary_scope: 'SPECIFIC_TEAM',
    named_recipients: ['delegates receiving incentives'],
    unclear_beneficiaries: false,
  },
};

type TestCase = {
  name: string;
  profile: PolicyProfileT;
  analysis: AnalysisForPolicy;
  proposal?: { id: string; author_address?: string };
  expect: Decision;
  expectRule?: string;
  expectSuggested?: Exclude<Decision, 'MANUAL_REVIEW'> | null;
};

const TESTS: TestCase[] = [
  {
    name: 'blocklisted author -> ABSTAIN',
    profile: {
      ...DEFAULT_PROFILE,
      author_blocklist: ['0xBAD000000000000000000000000000000000000B'],
    },
    analysis: A_ROUTINE_GRANT,
    proposal: { id: 'x', author_address: '0xBAD000000000000000000000000000000000000B' },
    expect: 'ABSTAIN',
    expectRule: 'hard_veto_authors',
  },
  {
    name: 'contract upgrade with default policy -> MANUAL_REVIEW',
    profile: DEFAULT_PROFILE,
    analysis: A_CONTRACT_UPGRADE,
    expect: 'MANUAL_REVIEW',
    expectRule: 'manual_review_contract_upgrade',
    expectSuggested: 'ABSTAIN',
  },
  {
    name: 'large treasury spend -> MANUAL_REVIEW',
    profile: DEFAULT_PROFILE,
    analysis: A_LARGE_TREASURY,
    expect: 'MANUAL_REVIEW',
    expectRule: 'review_large_treasury_spend',
    expectSuggested: 'ABSTAIN',
  },
  {
    name: 'low extraction confidence -> MANUAL_REVIEW',
    profile: DEFAULT_PROFILE,
    analysis: A_LOW_CONFIDENCE,
    expect: 'MANUAL_REVIEW',
    expectRule: 'low_conf_guard',
    expectSuggested: 'ABSTAIN',
  },
  {
    name: 'low field confidence -> MANUAL_REVIEW',
    profile: DEFAULT_PROFILE,
    analysis: A_LOW_FIELD_CONFIDENCE,
    expect: 'MANUAL_REVIEW',
    expectRule: 'low_confidence_policy_inputs',
    expectSuggested: 'ABSTAIN',
  },
  {
    name: 'LLM flagged ambiguous -> MANUAL_REVIEW',
    profile: DEFAULT_PROFILE,
    analysis: A_LLM_FLAGGED,
    expect: 'MANUAL_REVIEW',
    expectRule: 'llm_flagged_ambiguous',
    expectSuggested: 'ABSTAIN',
  },
  {
    name: 'review-only default still exposes a provisional lean',
    profile: {
      ...DEFAULT_PROFILE,
      default_action: 'MANUAL_REVIEW',
      category_defaults: [],
      delegation_rules: [],
    },
    analysis: A_ROUTINE_GRANT,
    expect: 'MANUAL_REVIEW',
    expectRule: 'default_action',
    expectSuggested: 'ABSTAIN',
  },
  {
    name: 'manual-review gate still exposes lower vote rule lean',
    profile: {
      ...DEFAULT_PROFILE,
      manual_review_categories: [...DEFAULT_PROFILE.manual_review_categories, 'GRANT'],
    },
    analysis: A_ROUTINE_GRANT,
    expect: 'MANUAL_REVIEW',
    expectRule: 'manual_review_grant',
    expectSuggested: 'FOR',
  },
  {
    name: 'routine accountable grant -> FOR',
    profile: DEFAULT_PROFILE,
    analysis: A_ROUTINE_GRANT,
    expect: 'FOR',
    expectRule: 'category_default_grant',
  },
  {
    name: 'treasury grant without milestones -> MANUAL_REVIEW',
    profile: DEFAULT_PROFILE,
    analysis: A_NO_MILESTONES,
    expect: 'MANUAL_REVIEW',
    expectRule: 'hard_review_treasury_without_milestones',
    expectSuggested: 'ABSTAIN',
  },
  {
    name: 'single-recipient grant over hard cap -> AGAINST',
    profile: DEFAULT_PROFILE,
    analysis: A_SINGLE_RECIPIENT_OVER_CAP,
    expect: 'AGAINST',
    expectRule: 'hard_against_single_recipient_treasury_usd',
  },
  {
    name: 'emission increase -> AGAINST',
    profile: DEFAULT_PROFILE,
    analysis: A_EMISSION_INCREASE,
    expect: 'AGAINST',
    expectRule: 'hard_against_emission_increase',
  },
  {
    name: 'parameter change follows delegate signal -> FOR',
    profile: DEFAULT_PROFILE,
    analysis: A_PARAMETER_WITH_DELEGATE,
    expect: 'FOR',
    expectRule: 'delegate_parameter_change_for',
  },
  {
    name: 'parameter change without delegate signal -> MANUAL_REVIEW',
    profile: DEFAULT_PROFILE,
    analysis: A_PARAMETER_WITHOUT_DELEGATE,
    expect: 'MANUAL_REVIEW',
    expectRule: 'delegate_parameter_change_unavailable',
    expectSuggested: 'ABSTAIN',
  },
  {
    name: 'DIP-style meta governance defaults to ABSTAIN',
    profile: DEFAULT_PROFILE,
    analysis: A_DIP_META,
    expect: 'ABSTAIN',
    expectRule: 'category_default_meta_governance',
  },
  {
    name: 'growth profile supports accountable partnerships',
    profile: GROWTH_PROFILE,
    analysis: {
      ...A_ROUTINE_GRANT,
      category: 'PARTNERSHIP',
      proposer: { ...A_ROUTINE_GRANT.proposer, type: 'CORE_TEAM' },
      financial: { ...A_ROUTINE_GRANT.financial, treasury_spend_usd: 75_000 },
      execution: { ...A_ROUTINE_GRANT.execution, has_reporting: true },
    },
    expect: 'FOR',
    expectRule: 'category_default_partnership',
  },
];

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
  const suggestedOk =
    !('expectSuggested' in tc) ||
    (tc.expectSuggested === null
      ? result.suggested_vote === null
      : result.suggested_vote?.decision === tc.expectSuggested);
  const ok = decisionOk && ruleOk && suggestedOk;

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
    if (!suggestedOk) {
      console.error(`    expected suggested vote: ${tc.expectSuggested}`);
      console.error(`    got suggested vote:      ${result.suggested_vote?.decision ?? null}`);
    }
  }

  console.log(`    conf=${result.confidence.toFixed(2)}`);
  if (result.suggested_vote) {
    console.log(
      `    suggested=${result.suggested_vote.decision} (${result.suggested_vote.confidence.toFixed(2)}) via ${result.suggested_vote.rule_id ?? result.suggested_vote.source}`,
    );
  }
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
