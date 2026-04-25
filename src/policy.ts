/**
 * Deterministic policy engine.
 *
 * Takes a user's PolicyProfile + an LLM-produced ProposalAnalysis and emits
 * a structured decision: FOR | AGAINST | ABSTAIN | MANUAL_REVIEW.
 *
 * Contract:
 *   - Pure function. Same inputs → same output. No randomness, no I/O, no LLM.
 *   - No import from ../src/llm beyond types — the engine never calls the LLM.
 *   - Every decision carries the list of rules that triggered it.
 *
 * Rule shape:
 *   { id, priority, when: <predicate>, then: { action? | score?, reason } }
 *
 * Resolution order:
 *   1. Hard rules with priority >= 500 evaluated in priority-descending order.
 *      First match short-circuits with its action.
 *   2. Soft rules (those with `score`) accumulated into {FOR, AGAINST, ABSTAIN}.
 *   3. Low-priority hard rules (< 500) evaluated using the computed margin.
 *   4. Winner = highest-score action. Ties → ABSTAIN.
 */

import { z } from 'zod';
import { Category, type ProposalAnalysisT } from './llm.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Decision = 'FOR' | 'AGAINST' | 'ABSTAIN' | 'MANUAL_REVIEW';

export const PolicyProfile = z.object({
  // Axis preferences — 1 (opposite direction) ... 5 (strongly this direction)
  treasury_conservatism: z.number().int().min(1).max(5),
  decentralization_priority: z.number().int().min(1).max(5),
  growth_vs_sustainability: z.number().int().min(1).max(5),
  protocol_risk_tolerance: z.number().int().min(1).max(5),

  // Hard constraints
  max_treasury_usd_auto: z.number().nullable(),
  author_blocklist: z.array(z.string()),
  manual_review_categories: z.array(Category),
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

export type PolicyEvaluation = {
  decision: Decision;
  confidence: number; // [0, 1]
  triggered_rules: TriggeredRule[];
  scores: Record<Decision, number>;
  margin: number;
  engine_version: string;
};

type Computed = {
  score_for: number;
  score_against: number;
  score_margin: number;
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

export const ENGINE_VERSION = '0.1.0';
const HARD_PRIORITY_THRESHOLD = 500;
const DEFAULT_EXTRACTION_CONFIDENCE = 0.9;

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
  if ('and' in pred) return pred.and.every((p) => predicateMatches(p, ctx));
  if ('or' in pred) return pred.or.some((p) => predicateMatches(p, ctx));
  if ('not' in pred) return !predicateMatches(pred.not, ctx);
  // PathPredicate — usually one key per object, but AND them if multiple
  for (const [path, cmp] of Object.entries(pred as PathPredicate)) {
    const value = getPath(ctx, path);
    if (!comparatorMatches(value, cmp)) return false;
  }
  return true;
}

export function evaluate(
  analysis: AnalysisForPolicy,
  profile: PolicyProfileT,
  rules: Rule[],
  proposal: ProposalMeta = { id: '(unspecified)' },
): PolicyEvaluation {
  const extractionConfidence = analysis.extraction_confidence ?? DEFAULT_EXTRACTION_CONFIDENCE;

  const ctx: EvalContext = { profile, analysis, proposal, computed: {} };
  const hardRules = rules.filter((r) => r.then.action).sort((a, b) => b.priority - a.priority);
  const softRules = rules.filter((r) => r.then.score);

  // Pass 1: high-priority hard rules (short-circuit)
  for (const rule of hardRules.filter((r) => r.priority >= HARD_PRIORITY_THRESHOLD)) {
    if (predicateMatches(rule.when, ctx)) {
      return {
        decision: rule.then.action!,
        confidence: extractionConfidence,
        triggered_rules: [{ id: rule.id, priority: rule.priority, reason: rule.then.reason }],
        scores: { FOR: 0, AGAINST: 0, ABSTAIN: 0, MANUAL_REVIEW: 0 },
        margin: 0,
        engine_version: ENGINE_VERSION,
      };
    }
  }

  // Pass 2: accumulate soft-rule scores
  const scores: Record<Decision, number> = { FOR: 0, AGAINST: 0, ABSTAIN: 0, MANUAL_REVIEW: 0 };
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

  const margin = Math.abs(scores.FOR - scores.AGAINST);
  ctx.computed = { score_for: scores.FOR, score_against: scores.AGAINST, score_margin: margin };

  // Pass 3: low-priority hard rules (margin guards, etc.)
  for (const rule of hardRules.filter((r) => r.priority < HARD_PRIORITY_THRESHOLD)) {
    if (predicateMatches(rule.when, ctx)) {
      return {
        decision: rule.then.action!,
        confidence: extractionConfidence * 0.9,
        triggered_rules: [
          ...triggeredSoft,
          { id: rule.id, priority: rule.priority, reason: rule.then.reason },
        ],
        scores,
        margin,
        engine_version: ENGINE_VERSION,
      };
    }
  }

  // Final: highest-scoring action
  const decision: Decision =
    scores.FOR > scores.AGAINST ? 'FOR' : scores.AGAINST > scores.FOR ? 'AGAINST' : 'ABSTAIN';

  const marginFactor = Math.min(1, margin / 3); // normalize: margin of 3 => full conf
  const confidence =
    decision === 'ABSTAIN' ? extractionConfidence * 0.5 : extractionConfidence * marginFactor;

  return {
    decision,
    confidence,
    triggered_rules: triggeredSoft,
    scores,
    margin,
    engine_version: ENGINE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Profile compilation — turn a PolicyProfile into a concrete rule list.
// This is the deterministic glue between user preferences and the engine.
// ---------------------------------------------------------------------------

export function compileProfileToRules(profile: PolicyProfileT): Rule[] {
  const rules: Rule[] = [];

  // --- HARD RULES ---

  // 1000: author blocklist (hard veto)
  if (profile.author_blocklist.length > 0) {
    rules.push({
      id: 'hard_veto_authors',
      priority: 1000,
      when: { 'proposal.author_address': { in: profile.author_blocklist } },
      then: { action: 'ABSTAIN', reason: 'author is on your blocklist' },
    });
  }

  // 900: manual-review categories
  for (const cat of profile.manual_review_categories) {
    rules.push({
      id: `manual_review_${cat.toLowerCase()}`,
      priority: 900,
      when: { 'analysis.category': { eq: cat } },
      then: {
        action: 'MANUAL_REVIEW',
        reason: `${cat} proposals require your manual review per profile`,
      },
    });
  }

  // 850: personal treasury cap
  if (profile.max_treasury_usd_auto !== null) {
    rules.push({
      id: 'personal_treasury_cap',
      priority: 850,
      when: {
        and: [
          { 'analysis.category': { eq: 'TREASURY_SPEND' } },
          { 'analysis.flags.treasury_spend_usd': { gt: profile.max_treasury_usd_auto } },
        ],
      },
      then: {
        action: 'MANUAL_REVIEW',
        reason: `treasury spend exceeds your auto-approve cap of $${profile.max_treasury_usd_auto.toLocaleString()}`,
      },
    });
  }

  // 700: low-confidence guard (always on)
  rules.push({
    id: 'low_conf_guard',
    priority: 700,
    when: { 'analysis.extraction_confidence': { lt: 0.75 } },
    then: {
      action: 'MANUAL_REVIEW',
      reason: 'extraction confidence below 0.75 — please review manually',
    },
  });

  // 600: requires_human_judgment flag from the LLM itself
  rules.push({
    id: 'llm_flagged_ambiguous',
    priority: 600,
    when: { 'analysis.uncertainty.requires_human_judgment': { eq: true } },
    then: {
      action: 'MANUAL_REVIEW',
      reason: 'LLM flagged this proposal as ambiguous; requires human judgment',
    },
  });

  // --- SOFT RULES (priority ~100) ---

  // Treasury conservatism axis
  if (profile.treasury_conservatism >= 4) {
    rules.push({
      id: 'conservative_treasury_no_milestones',
      priority: 100,
      when: {
        and: [
          { 'analysis.category': { eq: 'TREASURY_SPEND' } },
          { 'analysis.flags.has_milestones': { eq: false } },
        ],
      },
      then: { score: { AGAINST: 2.0 }, reason: 'treasury spend without milestones' },
    });
    rules.push({
      id: 'conservative_treasury_align',
      priority: 100,
      when: { 'analysis.value_alignment.treasury_conservatism': { lt: -0.3 } },
      then: {
        score: { AGAINST: 1.5 },
        reason: 'proposal conflicts with your conservative treasury stance',
      },
    });
  } else if (profile.treasury_conservatism <= 2) {
    rules.push({
      id: 'growth_treasury_align',
      priority: 100,
      when: { 'analysis.value_alignment.treasury_conservatism': { lt: -0.3 } },
      then: {
        score: { FOR: 1.0 },
        reason: 'aggressive treasury use fits your growth preference',
      },
    });
  }

  // Decentralization priority axis
  if (profile.decentralization_priority >= 4) {
    rules.push({
      id: 'prefer_decentralization',
      priority: 100,
      when: { 'analysis.value_alignment.decentralization': { gt: 0.5 } },
      then: { score: { FOR: 2.0 }, reason: 'aligns with your decentralization priority' },
    });
    rules.push({
      id: 'penalize_centralization',
      priority: 100,
      when: { 'analysis.value_alignment.decentralization': { lt: -0.3 } },
      then: { score: { AGAINST: 2.5 }, reason: 'conflicts with your decentralization priority' },
    });
  }

  // Growth vs sustainability axis
  if (profile.growth_vs_sustainability >= 4) {
    rules.push({
      id: 'prefer_sustainability',
      priority: 100,
      when: { 'analysis.value_alignment.growth_vs_sustainability': { gt: 0.3 } },
      then: { score: { FOR: 1.0 }, reason: 'favors sustainability per your preference' },
    });
  } else if (profile.growth_vs_sustainability <= 2) {
    rules.push({
      id: 'prefer_growth',
      priority: 100,
      when: { 'analysis.value_alignment.growth_vs_sustainability': { lt: -0.3 } },
      then: { score: { FOR: 1.0 }, reason: 'favors growth per your preference' },
    });
  }

  // Protocol risk tolerance axis
  if (profile.protocol_risk_tolerance <= 2) {
    rules.push({
      id: 'penalize_risk',
      priority: 100,
      when: { 'analysis.value_alignment.protocol_risk': { lt: -0.3 } },
      then: { score: { AGAINST: 2.0 }, reason: 'raises protocol risk beyond your tolerance' },
    });
    rules.push({
      id: 'irreversible_caution',
      priority: 100,
      when: {
        and: [
          { 'analysis.flags.reversible': { eq: false } },
          { 'analysis.flags.requires_contract_upgrade': { eq: true } },
        ],
      },
      then: {
        score: { AGAINST: 1.5 },
        reason: 'irreversible contract upgrade, low risk tolerance',
      },
    });
  }

  // --- MARGIN GUARD (low-priority hard rule) ---
  rules.push({
    id: 'margin_guard',
    priority: 50,
    when: { 'computed.score_margin': { lt: 1.0 } },
    then: { action: 'ABSTAIN', reason: 'insufficient decision margin — too close to call' },
  });

  return rules;
}

// ---------------------------------------------------------------------------
// Preset profiles — useful defaults; users can start from these and tweak.
// ---------------------------------------------------------------------------

export const DEFAULT_PROFILE: PolicyProfileT = {
  treasury_conservatism: 3,
  decentralization_priority: 4,
  growth_vs_sustainability: 3,
  protocol_risk_tolerance: 2,
  max_treasury_usd_auto: 500_000,
  author_blocklist: [],
  manual_review_categories: ['CONTRACT_UPGRADE', 'OWNERSHIP_TRANSFER'],
};

export const CONSERVATIVE_PROFILE: PolicyProfileT = {
  treasury_conservatism: 5,
  decentralization_priority: 5,
  growth_vs_sustainability: 5,
  protocol_risk_tolerance: 1,
  max_treasury_usd_auto: 100_000,
  author_blocklist: [],
  manual_review_categories: [
    'CONTRACT_UPGRADE',
    'OWNERSHIP_TRANSFER',
    'TOKENOMICS',
    'META_GOVERNANCE',
  ],
};

export const GROWTH_PROFILE: PolicyProfileT = {
  treasury_conservatism: 2,
  decentralization_priority: 3,
  growth_vs_sustainability: 2,
  protocol_risk_tolerance: 4,
  max_treasury_usd_auto: 2_000_000,
  author_blocklist: [],
  manual_review_categories: ['OWNERSHIP_TRANSFER'],
};
