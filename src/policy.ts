/**
 * Deterministic policy engine.
 *
 * The LLM extracts concrete proposal features. This module applies a user's
 * explicit defaults, manual-review flags, delegation rules, and hard limits.
 *
 * Contract:
 *   - Pure function. Same inputs -> same output. No randomness, no I/O, no LLM.
 *   - The engine treats low-confidence extracted policy inputs as a reason for
 *     MANUAL_REVIEW, not as permission to guess.
 *   - Every decision carries the list of rules that triggered it.
 */

import { z } from 'zod';
import { Category, ProposerType, type ProposalAnalysisT } from './llm.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Decision = 'FOR' | 'AGAINST' | 'ABSTAIN' | 'MANUAL_REVIEW';
export type VoteDecision = Exclude<Decision, 'MANUAL_REVIEW'>;

const DecisionSchema = z.enum(['FOR', 'AGAINST', 'ABSTAIN', 'MANUAL_REVIEW']);

export const ManualReviewFlag = z.enum([
  'LOW_CONFIDENCE_EXTRACTION',
  'UNKNOWN_TREASURY_AMOUNT',
  'LARGE_TREASURY_SPEND',
  'SINGLE_RECIPIENT_TREASURY',
  'CONTRACT_UPGRADE',
  'OWNERSHIP_OR_PERMISSION_CHANGE',
  'CONSTITUTIONAL_CHANGE',
  'UNCLEAR_BENEFICIARIES',
  'UNKNOWN_RECIPIENT',
  'NO_MILESTONES',
  'DELEGATE_SIGNAL_UNAVAILABLE',
]);
export type ManualReviewFlagT = z.infer<typeof ManualReviewFlag>;

export const CategoryDefault = z.object({
  category: Category,
  action: DecisionSchema,
  max_treasury_usd: z.number().nullable().default(null),
  require_milestones: z.boolean().default(false),
  require_reporting: z.boolean().default(false),
  proposer_types: z.array(ProposerType).default([]),
  reason: z.string().default('category default'),
});
export type CategoryDefaultT = z.infer<typeof CategoryDefault>;

export const DelegationRule = z.object({
  category: Category,
  delegate: z.string(),
  fallback: z.enum(['MANUAL_REVIEW', 'CATEGORY_DEFAULT', 'ABSTAIN']).default('MANUAL_REVIEW'),
  wait_until_hours_before_end: z.number().min(0).max(168).default(6),
});
export type DelegationRuleT = z.infer<typeof DelegationRule>;

export const HardRules = z.object({
  max_single_recipient_treasury_percent: z.number().min(0).max(100).nullable(),
  max_single_recipient_treasury_usd: z.number().nullable(),
  vote_against_emission_increases: z.boolean(),
  vote_for_emission_cuts: z.boolean(),
  require_milestones_for_treasury: z.boolean(),
});
export type HardRulesT = z.infer<typeof HardRules>;

export const PolicyProfile = z.object({
  schema_version: z.literal('policy-v2').default('policy-v2'),
  default_action: DecisionSchema.default('ABSTAIN'),
  category_defaults: z.array(CategoryDefault).default([]),
  manual_review_categories: z.array(Category).default([]),
  manual_review_flags: z.array(ManualReviewFlag).default([]),
  large_treasury_usd: z.number().nullable().default(500_000),
  author_blocklist: z.array(z.string()).default([]),
  delegation_rules: z.array(DelegationRule).default([]),
  hard_rules: HardRules.default({
    max_single_recipient_treasury_percent: 0.5,
    max_single_recipient_treasury_usd: 250_000,
    vote_against_emission_increases: true,
    vote_for_emission_cuts: false,
    require_milestones_for_treasury: true,
  }),
  stated_values: z.array(z.string()).default([]),
});
export type PolicyProfileT = z.infer<typeof PolicyProfile>;

// Predicate language — a minimal JSON-serializable boolean expression.
type Comparator =
  | { eq: unknown }
  | { neq: unknown }
  | { gt: number }
  | { gte: number }
  | { lt: number }
  | { lte: number }
  | { in: unknown[] }
  | { not_in: unknown[] };

type PathPredicate = Record<string, Comparator>;

export type Predicate =
  | { and: Predicate[] }
  | { or: Predicate[] }
  | { not: Predicate }
  | PathPredicate;

export type Rule = {
  id: string;
  priority: number;
  when: Predicate;
  then: {
    action?: Decision;
    score?: Partial<Record<Decision, number>>;
    reason: string;
  };
};

// Analysis + optional meta used by the engine.
export type AnalysisForPolicy = ProposalAnalysisT & {
  extraction_confidence?: number;
};

export type ProposalMeta = {
  id: string;
  author_address?: string;
  space?: string;
};

export type TriggeredRule = {
  id: string;
  priority: number;
  reason: string;
  contribution?: Partial<Record<Decision, number>>;
};

export type SuggestedVote = {
  decision: VoteDecision;
  confidence: number; // [0, 1]
  reason: string;
  source: 'policy_rule' | 'score' | 'default_action' | 'review_gate';
  rule_id?: string;
};

export type PolicyEvaluation = {
  decision: Decision;
  confidence: number; // [0, 1]
  triggered_rules: TriggeredRule[];
  scores: Record<Decision, number>;
  margin: number;
  suggested_vote: SuggestedVote | null;
  engine_version: string;
};

type Computed = {
  always: boolean;
  extraction_confidence: number;
  low_confidence_policy_inputs: boolean;
  delegate_rule_applies: boolean;
  delegate_signal_available: boolean;
  delegate_choice: Decision | '';
};

type EvalContext = {
  profile: PolicyProfileT;
  analysis: AnalysisForPolicy;
  proposal: ProposalMeta;
  computed: Partial<Computed>;
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export const ENGINE_VERSION = '0.2.2';
const HARD_PRIORITY_THRESHOLD = 500;
const DEFAULT_EXTRACTION_CONFIDENCE = 0.9;
const LOW_CONFIDENCE_THRESHOLD = 0.75;
const VOTE_DECISIONS = ['FOR', 'AGAINST', 'ABSTAIN'] as const;

const POLICY_INPUT_FIELDS = [
  'category',
  'proposer.type',
  'financial.treasury_spend_usd',
  'financial.recipient_count',
  'execution.requires_contract_upgrade',
  'execution.reversible',
  'governance.constitutional_change',
  'beneficiaries.primary_scope',
];

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function comparatorMatches(value: unknown, cmp: Comparator): boolean {
  if ('eq' in cmp) return value === cmp.eq;
  if ('neq' in cmp) return value !== cmp.neq;
  if ('gt' in cmp) return typeof value === 'number' && value > cmp.gt;
  if ('gte' in cmp) return typeof value === 'number' && value >= cmp.gte;
  if ('lt' in cmp) return typeof value === 'number' && value < cmp.lt;
  if ('lte' in cmp) return typeof value === 'number' && value <= cmp.lte;
  if ('in' in cmp) return cmp.in.includes(value);
  if ('not_in' in cmp) return !cmp.not_in.includes(value);
  return false;
}

function predicateMatches(pred: Predicate, ctx: EvalContext): boolean {
  const compound = pred as {
    and?: Predicate[];
    or?: Predicate[];
    not?: Predicate;
  };
  if (Array.isArray(compound.and)) {
    return compound.and.every((p: Predicate) => predicateMatches(p, ctx));
  }
  if (Array.isArray(compound.or)) {
    return compound.or.some((p: Predicate) => predicateMatches(p, ctx));
  }
  if (compound.not) return !predicateMatches(compound.not, ctx);
  for (const [path, cmp] of Object.entries(pred as PathPredicate)) {
    const value = getPath(ctx, path);
    if (!comparatorMatches(value, cmp)) return false;
  }
  return true;
}

function confidenceFor(analysis: AnalysisForPolicy, field: string, fallback: number): number {
  return analysis.uncertainty.field_confidence[field] ?? fallback;
}

function lowConfidencePolicyInputs(analysis: AnalysisForPolicy, fallback: number): boolean {
  if (analysis.uncertainty.low_confidence_fields.length > 0) return true;
  return POLICY_INPUT_FIELDS.some(
    (field) => confidenceFor(analysis, field, fallback) < LOW_CONFIDENCE_THRESHOLD,
  );
}

function matchingDelegation(profile: PolicyProfileT, analysis: AnalysisForPolicy) {
  return profile.delegation_rules.find((r) => r.category === analysis.category);
}

function matchingDelegateChoice(profile: PolicyProfileT, analysis: AnalysisForPolicy): Decision | '' {
  const delegation = matchingDelegation(profile, analysis);
  if (!delegation) return '';
  const delegate = delegation.delegate.toLowerCase();
  const signal = analysis.signals.delegate_votes.find(
    (v) => v.delegate.toLowerCase() === delegate && v.choice,
  );
  return signal?.choice ?? '';
}

function isVoteDecision(decision: Decision | undefined): decision is VoteDecision {
  return decision === 'FOR' || decision === 'AGAINST' || decision === 'ABSTAIN';
}

function emptyScores(): Record<Decision, number> {
  return { FOR: 0, AGAINST: 0, ABSTAIN: 0, MANUAL_REVIEW: 0 };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function scoreSoftRules(
  softRules: Rule[],
  ctx: EvalContext,
): { scores: Record<Decision, number>; triggeredSoft: TriggeredRule[] } {
  const scores = emptyScores();
  const triggeredSoft: TriggeredRule[] = [];

  for (const rule of softRules) {
    if (predicateMatches(rule.when, ctx)) {
      const contribution: Partial<Record<Decision, number>> = {};
      for (const [k, v] of Object.entries(rule.then.score!) as [Decision, number][]) {
        scores[k] += v;
        contribution[k] = v;
      }
      triggeredSoft.push({
        id: rule.id,
        priority: rule.priority,
        reason: rule.then.reason,
        contribution,
      });
    }
  }

  return { scores, triggeredSoft };
}

function uncertaintyReviewGate(rule: Rule): boolean {
  return (
    rule.id === 'low_conf_guard' ||
    rule.id === 'low_confidence_policy_inputs' ||
    rule.id === 'llm_flagged_ambiguous' ||
    rule.id === 'review_unknown_treasury_amount' ||
    rule.id === 'review_unclear_beneficiaries' ||
    rule.id === 'review_unknown_recipient'
  );
}

function fallbackVoteForReviewGate(
  gateRule: Rule,
  ctx: EvalContext,
  extractionConfidence: number,
): SuggestedVote {
  const defaultAction = ctx.profile.default_action;
  const decision: VoteDecision = isVoteDecision(defaultAction)
    ? defaultAction
    : gateRule.id.includes('no_milestones') ||
        gateRule.id.includes('without_milestones') ||
        gateRule.id.includes('single_recipient')
      ? 'AGAINST'
      : 'ABSTAIN';
  const confidenceFactor = uncertaintyReviewGate(gateRule)
    ? 0.28
    : isVoteDecision(defaultAction)
      ? 0.5
      : 0.38;

  return {
    decision,
    confidence: clamp01(extractionConfidence * confidenceFactor),
    reason: uncertaintyReviewGate(gateRule)
      ? `review gate ${gateRule.id} fired; provisional ${decision} until extracted inputs are reviewed`
      : `review gate ${gateRule.id} fired; provisional ${decision} until reviewed`,
    source: 'review_gate',
    rule_id: gateRule.id,
  };
}

function treasuryLike(analysis: AnalysisForPolicy): boolean {
  return (
    analysis.category === 'TREASURY_SPEND' ||
    analysis.category === 'GRANT' ||
    (analysis.financial.treasury_spend_usd ?? 0) > 0
  );
}

function riskLeanAgainstForReviewGate(
  gateRule: Rule,
  ctx: EvalContext,
  extractionConfidence: number,
): SuggestedVote | null {
  const analysis = ctx.analysis;
  const reasons: string[] = [];
  const amount = analysis.financial.treasury_spend_usd;
  const largeThreshold = ctx.profile.large_treasury_usd;

  if (treasuryLike(analysis)) {
    if (amount == null && ctx.profile.manual_review_flags.includes('UNKNOWN_TREASURY_AMOUNT')) {
      reasons.push('treasury value is unknown');
    } else if (largeThreshold != null && amount != null && amount > largeThreshold) {
      reasons.push(`treasury value exceeds $${largeThreshold.toLocaleString()} review threshold`);
    }

    if (analysis.execution.has_milestones === false) {
      reasons.push('no milestone gate');
    }

    if (analysis.financial.recipient_count === 1 || analysis.financial.single_recipient === true) {
      reasons.push('single recipient or custodian');
    }

    if (analysis.execution.reversible === false && !analysis.execution.has_clawback) {
      reasons.push('irreversible with no clawback');
    }
  }

  if (
    analysis.beneficiaries.unclear_beneficiaries ||
    analysis.beneficiaries.primary_scope === 'UNKNOWN'
  ) {
    reasons.push('beneficiaries are unclear');
  }

  if (reasons.length === 0) return null;

  return {
    decision: 'AGAINST',
    confidence: clamp01(extractionConfidence * (uncertaintyReviewGate(gateRule) ? 0.42 : 0.56)),
    reason: `risk signals favor AGAINST pending review: ${reasons.slice(0, 3).join('; ')}`,
    source: 'review_gate',
    rule_id: gateRule.id,
  };
}

function suggestedVoteFromScores(
  scores: Record<Decision, number>,
  extractionConfidence: number,
): SuggestedVote | null {
  const ranked = VOTE_DECISIONS
    .map((decision) => ({ decision, score: scores[decision] }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const second = ranked[1];
  if (!best || !second || best.score <= 0 || best.score === second.score) return null;

  const margin = best.score - second.score;
  return {
    decision: best.decision,
    confidence: clamp01(extractionConfidence * Math.min(0.8, 0.45 + margin / 5)),
    reason: `soft policy scores favor ${best.decision}`,
    source: 'score',
  };
}

function suggestedVoteForManualReview(
  gateRule: Rule,
  hardRules: Rule[],
  softRules: Rule[],
  ctx: EvalContext,
  extractionConfidence: number,
): SuggestedVote | null {
  if (uncertaintyReviewGate(gateRule)) {
    return riskLeanAgainstForReviewGate(gateRule, ctx, extractionConfidence) ??
      fallbackVoteForReviewGate(gateRule, ctx, extractionConfidence);
  }

  for (const rule of hardRules) {
    const action = rule.then.action;
    if (rule.priority >= gateRule.priority) continue;
    if (!isVoteDecision(action)) continue;
    if (rule.id === 'default_action') continue;
    if (!predicateMatches(rule.when, ctx)) continue;

    const source = rule.id === 'default_action' ? 'default_action' : 'policy_rule';
    const confidenceFactor = source === 'default_action'
      ? 0.52
      : rule.priority >= HARD_PRIORITY_THRESHOLD
        ? 0.82
        : 0.68;

    return {
      decision: action,
      confidence: clamp01(extractionConfidence * confidenceFactor),
      reason: rule.then.reason,
      source,
      rule_id: rule.id,
    };
  }

  const riskLean = riskLeanAgainstForReviewGate(gateRule, ctx, extractionConfidence);
  if (riskLean) return riskLean;

  const { scores } = scoreSoftRules(softRules, ctx);
  return suggestedVoteFromScores(scores, extractionConfidence) ??
    fallbackVoteForReviewGate(gateRule, ctx, extractionConfidence);
}

export function evaluate(
  analysis: AnalysisForPolicy,
  profileInput: PolicyProfileT,
  rules: Rule[],
  proposal: ProposalMeta = { id: '(unspecified)' },
): PolicyEvaluation {
  const profile = normalizeProfile(profileInput);
  const extractionConfidence = analysis.extraction_confidence ?? DEFAULT_EXTRACTION_CONFIDENCE;
  const delegateChoice = matchingDelegateChoice(profile, analysis);

  const ctx: EvalContext = {
    profile,
    analysis,
    proposal,
    computed: {
      always: true,
      extraction_confidence: extractionConfidence,
      low_confidence_policy_inputs: lowConfidencePolicyInputs(analysis, extractionConfidence),
      delegate_rule_applies: Boolean(matchingDelegation(profile, analysis)),
      delegate_signal_available: delegateChoice !== '',
      delegate_choice: delegateChoice,
    },
  };

  const hardRules = rules.filter((r) => r.then.action).sort((a, b) => b.priority - a.priority);
  const softRules = rules.filter((r) => r.then.score);

  // Pass 1: high-priority hard rules. These include low-confidence extraction
  // and high-stakes manual-review guards, so they run before any vote action.
  for (const rule of hardRules.filter((r) => r.priority >= HARD_PRIORITY_THRESHOLD)) {
    if (predicateMatches(rule.when, ctx)) {
      const decision = rule.then.action!;
      return {
        decision,
        confidence: extractionConfidence,
        triggered_rules: [{ id: rule.id, priority: rule.priority, reason: rule.then.reason }],
        scores: emptyScores(),
        margin: 0,
        suggested_vote: decision === 'MANUAL_REVIEW'
          ? suggestedVoteForManualReview(rule, hardRules, softRules, ctx, extractionConfidence)
          : null,
        engine_version: ENGINE_VERSION,
      };
    }
  }

  // Pass 2: optional soft scores retained for compatibility, though v2 policy
  // primarily uses explicit action rules.
  const { scores, triggeredSoft } = scoreSoftRules(softRules, ctx);

  // Pass 3: low-priority hard rules. Category defaults and default actions live
  // here, after all manual-review and high-stakes rules have had first refusal.
  for (const rule of hardRules.filter((r) => r.priority < HARD_PRIORITY_THRESHOLD)) {
    if (predicateMatches(rule.when, ctx)) {
      const decision = rule.then.action!;
      return {
        decision,
        confidence: extractionConfidence * 0.9,
        triggered_rules: [
          ...triggeredSoft,
          { id: rule.id, priority: rule.priority, reason: rule.then.reason },
        ],
        scores,
        margin: 0,
        suggested_vote: decision === 'MANUAL_REVIEW'
          ? suggestedVoteForManualReview(rule, hardRules, softRules, ctx, extractionConfidence)
          : null,
        engine_version: ENGINE_VERSION,
      };
    }
  }

  const decision: Decision =
    scores.FOR > scores.AGAINST ? 'FOR' : scores.AGAINST > scores.FOR ? 'AGAINST' : 'ABSTAIN';
  const margin = Math.abs(scores.FOR - scores.AGAINST);
  const marginFactor = Math.min(1, margin / 3);
  const confidence =
    decision === 'ABSTAIN' ? extractionConfidence * 0.5 : extractionConfidence * marginFactor;

  return {
    decision,
    confidence,
    triggered_rules: triggeredSoft,
    scores,
    margin,
    suggested_vote: null,
    engine_version: ENGINE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Profile compilation — turn a PolicyProfile into a concrete rule list.
// ---------------------------------------------------------------------------

export function compileProfileToRules(profileInput: PolicyProfileT): Rule[] {
  const profile = normalizeProfile(profileInput);
  const rules: Rule[] = [];

  if (profile.author_blocklist.length > 0) {
    rules.push({
      id: 'hard_veto_authors',
      priority: 1000,
      when: { 'proposal.author_address': { in: profile.author_blocklist } },
      then: { action: 'ABSTAIN', reason: 'author is on your blocklist' },
    });
  }

  rules.push({
    id: 'low_conf_guard',
    priority: 980,
    when: { 'computed.extraction_confidence': { lt: LOW_CONFIDENCE_THRESHOLD } },
    then: {
      action: 'MANUAL_REVIEW',
      reason: 'overall extraction confidence below 0.75',
    },
  });

  if (profile.manual_review_flags.includes('LOW_CONFIDENCE_EXTRACTION')) {
    rules.push({
      id: 'low_confidence_policy_inputs',
      priority: 970,
      when: { 'computed.low_confidence_policy_inputs': { eq: true } },
      then: {
        action: 'MANUAL_REVIEW',
        reason: 'one or more policy-critical extracted fields has low confidence',
      },
    });

    // The LLM's own self-reported "this is ambiguous" flag. Same trust class
    // as low_confidence_policy_inputs — both are signals that extraction
    // didn't produce confident inputs for the rule engine. Gated on the
    // same user-controlled flag so the editor can actually surface diffs
    // when a user chooses to act despite ambiguity.
    rules.push({
      id: 'llm_flagged_ambiguous',
      priority: 960,
      when: { 'analysis.uncertainty.requires_human_judgment': { eq: true } },
      then: {
        action: 'MANUAL_REVIEW',
        reason: 'LLM flagged this proposal as ambiguous',
      },
    });
  }

  for (const cat of profile.manual_review_categories) {
    rules.push({
      id: `manual_review_${cat.toLowerCase()}`,
      priority: 930,
      when: { 'analysis.category': { eq: cat } },
      then: {
        action: 'MANUAL_REVIEW',
        reason: `${cat} proposals require your manual review`,
      },
    });
  }

  addManualReviewFlagRules(rules, profile);
  addHardLimitRules(rules, profile);
  addDelegationRules(rules, profile);
  addCategoryDefaultRules(rules, profile);

  rules.push({
    id: 'default_action',
    priority: 1,
    when: { 'computed.always': { eq: true } },
    then: {
      action: profile.default_action,
      reason: `no specific policy rule matched; default action is ${profile.default_action}`,
    },
  });

  return rules;
}

function addManualReviewFlagRules(rules: Rule[], profile: PolicyProfileT) {
  const has = (flag: ManualReviewFlagT) => profile.manual_review_flags.includes(flag);

  if (has('UNKNOWN_TREASURY_AMOUNT')) {
    rules.push({
      id: 'review_unknown_treasury_amount',
      priority: 910,
      when: {
        and: [
          { 'analysis.category': { eq: 'TREASURY_SPEND' } },
          { 'analysis.financial.treasury_spend_usd': { eq: null } },
        ],
      },
      then: { action: 'MANUAL_REVIEW', reason: 'treasury spend amount is unknown' },
    });
  }

  if (has('LARGE_TREASURY_SPEND') && profile.large_treasury_usd !== null) {
    rules.push({
      id: 'review_large_treasury_spend',
      priority: 905,
      when: { 'analysis.financial.treasury_spend_usd': { gt: profile.large_treasury_usd } },
      then: {
        action: 'MANUAL_REVIEW',
        reason: `treasury spend exceeds review threshold of $${profile.large_treasury_usd.toLocaleString()}`,
      },
    });
  }

  if (has('SINGLE_RECIPIENT_TREASURY')) {
    rules.push({
      id: 'review_single_recipient_treasury',
      priority: 900,
      when: {
        and: [
          { 'analysis.financial.treasury_spend_usd': { gt: 0 } },
          { 'analysis.financial.recipient_count': { eq: 1 } },
        ],
      },
      then: { action: 'MANUAL_REVIEW', reason: 'treasury spend goes to one recipient' },
    });
  }

  if (has('CONTRACT_UPGRADE')) {
    rules.push({
      id: 'review_contract_upgrade',
      priority: 895,
      when: { 'analysis.execution.requires_contract_upgrade': { eq: true } },
      then: { action: 'MANUAL_REVIEW', reason: 'proposal requires a contract upgrade' },
    });
  }

  if (has('OWNERSHIP_OR_PERMISSION_CHANGE')) {
    rules.push({
      id: 'review_ownership_or_permissions',
      priority: 890,
      when: {
        or: [
          { 'analysis.execution.touches_ownership': { eq: true } },
          { 'analysis.execution.changes_permissions': { eq: true } },
          { 'analysis.execution.creates_or_extends_council': { eq: true } },
        ],
      },
      then: { action: 'MANUAL_REVIEW', reason: 'proposal changes ownership, permissions, or council authority' },
    });
  }

  if (has('CONSTITUTIONAL_CHANGE')) {
    rules.push({
      id: 'review_constitutional_change',
      priority: 885,
      when: { 'analysis.governance.constitutional_change': { eq: true } },
      then: { action: 'MANUAL_REVIEW', reason: 'constitutional changes require review' },
    });
  }

  if (has('UNCLEAR_BENEFICIARIES')) {
    rules.push({
      id: 'review_unclear_beneficiaries',
      priority: 880,
      when: { 'analysis.beneficiaries.unclear_beneficiaries': { eq: true } },
      then: { action: 'MANUAL_REVIEW', reason: 'beneficiaries are unclear' },
    });
  }

  if (has('UNKNOWN_RECIPIENT')) {
    rules.push({
      id: 'review_unknown_recipient',
      priority: 875,
      when: { 'analysis.beneficiaries.primary_scope': { eq: 'UNKNOWN' } },
      then: { action: 'MANUAL_REVIEW', reason: 'recipient or beneficiary scope is unknown' },
    });
  }

  if (has('NO_MILESTONES')) {
    rules.push({
      id: 'review_no_milestones',
      priority: 870,
      when: {
        and: [
          { 'analysis.financial.treasury_spend_usd': { gt: 0 } },
          { 'analysis.execution.has_milestones': { eq: false } },
        ],
      },
      then: { action: 'MANUAL_REVIEW', reason: 'treasury spend has no milestones' },
    });
  }
}

function addHardLimitRules(rules: Rule[], profile: PolicyProfileT) {
  const hard = profile.hard_rules;

  if (hard.max_single_recipient_treasury_percent !== null) {
    rules.push({
      id: 'hard_against_single_recipient_treasury_percent',
      priority: 820,
      when: {
        and: [
          { 'analysis.financial.recipient_count': { eq: 1 } },
          { 'analysis.financial.treasury_percent': { gt: hard.max_single_recipient_treasury_percent } },
        ],
      },
      then: {
        action: 'AGAINST',
        reason: `single recipient receives more than ${hard.max_single_recipient_treasury_percent}% of treasury`,
      },
    });
  }

  if (hard.max_single_recipient_treasury_usd !== null) {
    rules.push({
      id: 'hard_against_single_recipient_treasury_usd',
      priority: 815,
      when: {
        and: [
          { 'analysis.financial.recipient_count': { eq: 1 } },
          { 'analysis.financial.treasury_spend_usd': { gt: hard.max_single_recipient_treasury_usd } },
        ],
      },
      then: {
        action: 'AGAINST',
        reason: `single recipient treasury spend exceeds $${hard.max_single_recipient_treasury_usd.toLocaleString()}`,
      },
    });
  }

  if (hard.vote_against_emission_increases) {
    rules.push({
      id: 'hard_against_emission_increase',
      priority: 810,
      when: { 'analysis.economics.emissions_change': { eq: 'INCREASE' } },
      then: { action: 'AGAINST', reason: 'policy votes against emission increases' },
    });
  }

  if (hard.vote_for_emission_cuts) {
    rules.push({
      id: 'hard_for_emission_cut',
      priority: 300,
      when: { 'analysis.economics.emissions_change': { eq: 'DECREASE' } },
      then: { action: 'FOR', reason: 'policy votes for emission cuts' },
    });
  }

  if (hard.require_milestones_for_treasury) {
    rules.push({
      id: 'hard_review_treasury_without_milestones',
      priority: 805,
      when: {
        and: [
          { 'analysis.financial.treasury_spend_usd': { gt: 0 } },
          { 'analysis.execution.has_milestones': { eq: false } },
        ],
      },
      then: { action: 'MANUAL_REVIEW', reason: 'treasury spend lacks milestones' },
    });
  }
}

function addDelegationRules(rules: Rule[], profile: PolicyProfileT) {
  for (const rule of profile.delegation_rules) {
    for (const action of ['FOR', 'AGAINST', 'ABSTAIN'] as Decision[]) {
      rules.push({
        id: `delegate_${rule.category.toLowerCase()}_${action.toLowerCase()}`,
        priority: 650,
        when: {
          and: [
            { 'analysis.category': { eq: rule.category } },
            { 'computed.delegate_choice': { eq: action } },
          ],
        },
        then: {
          action,
          reason: `following ${rule.delegate} on ${rule.category}; fallback deadline is ${rule.wait_until_hours_before_end}h before close`,
        },
      });
    }

    if (rule.fallback === 'MANUAL_REVIEW') {
      rules.push({
        id: `delegate_${rule.category.toLowerCase()}_unavailable`,
        priority: 640,
        when: {
          and: [
            { 'analysis.category': { eq: rule.category } },
            { 'computed.delegate_signal_available': { eq: false } },
          ],
        },
        then: {
          action: 'MANUAL_REVIEW',
          reason: `${rule.delegate} has not voted yet; delegation fallback is manual review`,
        },
      });
    } else if (rule.fallback === 'ABSTAIN') {
      rules.push({
        id: `delegate_${rule.category.toLowerCase()}_fallback_abstain`,
        priority: 640,
        when: {
          and: [
            { 'analysis.category': { eq: rule.category } },
            { 'computed.delegate_signal_available': { eq: false } },
          ],
        },
        then: {
          action: 'ABSTAIN',
          reason: `${rule.delegate} has not voted yet; delegation fallback is abstain`,
        },
      });
    }
  }
}

function addCategoryDefaultRules(rules: Rule[], profile: PolicyProfileT) {
  for (const def of profile.category_defaults) {
    const predicates: Predicate[] = [{ 'analysis.category': { eq: def.category } }];

    if (def.max_treasury_usd !== null) {
      predicates.push({ 'analysis.financial.treasury_spend_usd': { lte: def.max_treasury_usd } });
    }
    if (def.require_milestones) {
      predicates.push({ 'analysis.execution.has_milestones': { eq: true } });
    }
    if (def.require_reporting) {
      predicates.push({ 'analysis.execution.has_reporting': { eq: true } });
    }
    if (def.proposer_types.length > 0) {
      predicates.push({ 'analysis.proposer.type': { in: def.proposer_types } });
    }

    rules.push({
      id: `category_default_${def.category.toLowerCase()}`,
      priority: 100,
      when: { and: predicates },
      then: {
        action: def.action,
        reason: def.reason,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Preset profiles — concrete defaults, not abstract value axes.
// ---------------------------------------------------------------------------

export const DEFAULT_PROFILE: PolicyProfileT = {
  schema_version: 'policy-v2',
  default_action: 'ABSTAIN',
  category_defaults: [
    {
      category: 'GRANT',
      action: 'FOR',
      max_treasury_usd: 100_000,
      require_milestones: true,
      require_reporting: true,
      proposer_types: [],
      reason: 'routine grant under $100k with milestones and reporting',
    },
    {
      category: 'META_GOVERNANCE',
      action: 'ABSTAIN',
      max_treasury_usd: null,
      require_milestones: false,
      require_reporting: false,
      proposer_types: [],
      reason: 'meta-governance default is abstain unless a specific rule applies',
    },
  ],
  manual_review_categories: ['CONTRACT_UPGRADE', 'OWNERSHIP_TRANSFER'],
  manual_review_flags: [
    'LOW_CONFIDENCE_EXTRACTION',
    'UNKNOWN_TREASURY_AMOUNT',
    'LARGE_TREASURY_SPEND',
    'CONTRACT_UPGRADE',
    'OWNERSHIP_OR_PERMISSION_CHANGE',
    'CONSTITUTIONAL_CHANGE',
    'UNCLEAR_BENEFICIARIES',
    'UNKNOWN_RECIPIENT',
  ],
  large_treasury_usd: 500_000,
  author_blocklist: [],
  delegation_rules: [
    {
      category: 'PARAMETER_CHANGE',
      delegate: 'l2beat.eth',
      fallback: 'MANUAL_REVIEW',
      wait_until_hours_before_end: 6,
    },
  ],
  hard_rules: {
    max_single_recipient_treasury_percent: 0.5,
    max_single_recipient_treasury_usd: 250_000,
    vote_against_emission_increases: true,
    vote_for_emission_cuts: false,
    require_milestones_for_treasury: true,
  },
  stated_values: [],
};

export const CONSERVATIVE_PROFILE: PolicyProfileT = {
  ...DEFAULT_PROFILE,
  category_defaults: [
    {
      category: 'GRANT',
      action: 'MANUAL_REVIEW',
      max_treasury_usd: 50_000,
      require_milestones: true,
      require_reporting: true,
      proposer_types: [],
      reason: 'conservative profile reviews grants unless very small and accountable',
    },
  ],
  manual_review_categories: [
    'CONTRACT_UPGRADE',
    'OWNERSHIP_TRANSFER',
    'TOKENOMICS',
    'META_GOVERNANCE',
    'TREASURY_SPEND',
  ],
  manual_review_flags: [
    ...DEFAULT_PROFILE.manual_review_flags,
    'SINGLE_RECIPIENT_TREASURY',
    'NO_MILESTONES',
  ],
  large_treasury_usd: 100_000,
  hard_rules: {
    max_single_recipient_treasury_percent: 0.25,
    max_single_recipient_treasury_usd: 100_000,
    vote_against_emission_increases: true,
    vote_for_emission_cuts: true,
    require_milestones_for_treasury: true,
  },
};

export const GROWTH_PROFILE: PolicyProfileT = {
  ...DEFAULT_PROFILE,
  category_defaults: [
    {
      category: 'GRANT',
      action: 'FOR',
      max_treasury_usd: 250_000,
      require_milestones: true,
      require_reporting: false,
      proposer_types: [],
      reason: 'growth profile supports milestone-gated grants under $250k',
    },
    {
      category: 'PARTNERSHIP',
      action: 'FOR',
      max_treasury_usd: 100_000,
      require_milestones: false,
      require_reporting: true,
      proposer_types: ['FOUNDATION', 'CORE_TEAM', 'DELEGATE'],
      reason: 'growth profile supports accountable partnerships from known actors',
    },
  ],
  manual_review_categories: ['OWNERSHIP_TRANSFER'],
  large_treasury_usd: 2_000_000,
  hard_rules: {
    max_single_recipient_treasury_percent: 1.0,
    max_single_recipient_treasury_usd: 1_000_000,
    vote_against_emission_increases: false,
    vote_for_emission_cuts: false,
    require_milestones_for_treasury: true,
  },
};

export function normalizeProfile(input: unknown): PolicyProfileT {
  const parsed = PolicyProfile.safeParse(input);
  if (parsed.success) return parsed.data;

  if (input && typeof input === 'object') {
    const old = input as Record<string, unknown>;
    if (
      'treasury_conservatism' in old ||
      'decentralization_priority' in old ||
      'growth_vs_sustainability' in old ||
      'protocol_risk_tolerance' in old
    ) {
      return {
        ...DEFAULT_PROFILE,
        stated_values: Array.isArray(old.stated_values)
          ? old.stated_values.filter((v): v is string => typeof v === 'string')
          : [],
        author_blocklist: Array.isArray(old.author_blocklist)
          ? old.author_blocklist.filter((v): v is string => typeof v === 'string')
          : [],
      };
    }
  }

  return DEFAULT_PROFILE;
}
