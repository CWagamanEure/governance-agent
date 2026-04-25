/**
 * Pipeline orchestrator: proposal → analysis → policy evaluation → (signed vote).
 *
 * This is the deterministic spine of the agent. The LLM does exactly one job
 * (Call 1: structured extraction) and then everything downstream is pure code.
 *
 * Inputs:
 *   - proposal:  raw Snapshot proposal (from the GraphQL fetch)
 *   - analysis?: optional pre-built ProposalAnalysis. If supplied, the LLM
 *                extraction is skipped. Useful when extraction is blocked
 *                (e.g. waiting on the gateway) or when re-running a decision.
 *   - profile?:  PolicyProfile to evaluate against. Defaults to DEFAULT_PROFILE.
 *   - account?:  viem account that will sign the resulting vote. Omit to
 *                produce a decision without signing.
 *
 * Output: PipelineResult containing the analysis, the policy evaluation, an
 * optionally-signed vote envelope, and a deterministic markdown rationale that
 * cites every rule that triggered.
 */

import type { Account } from 'viem/accounts';
import type { Hex } from 'viem';

import { extractOne } from './llm.js';
import {
  evaluate,
  compileProfileToRules,
  DEFAULT_PROFILE,
  type AnalysisForPolicy,
  type PolicyEvaluation,
  type PolicyProfileT,
} from './policy.js';
import { decisionToChoice, signVote, type SignedVoteEnvelope } from './snapshot.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SnapshotProposalRaw = {
  id: string;
  title?: string;
  body?: string;
  author?: string;
  type?: string;
  choices?: string[];
  start?: number;
  end?: number;
  state?: string;
  space?: { id: string };
};

export type PipelineInput = {
  proposal: SnapshotProposalRaw;
  analysis?: AnalysisForPolicy;
  profile?: PolicyProfileT;
  account?: Account;
};

export type PipelineProposalRef = {
  id: string;
  title?: string;
  space?: string;
  state?: string;
};

export type PipelineResult = {
  proposal: PipelineProposalRef;
  analysis: AnalysisForPolicy | null;
  extraction_skipped: boolean;
  extraction_error?: string;
  evaluation: PolicyEvaluation | null;
  vote: { envelope: SignedVoteEnvelope; choice: number } | null;
  rationale_md: string;
  pipeline_version: string;
};

export const PIPELINE_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const proposalRef: PipelineProposalRef = {
    id: input.proposal.id,
    title: input.proposal.title,
    space: input.proposal.space?.id,
    state: input.proposal.state,
  };

  // Step 1 — extraction (LLM Call 1) or pre-supplied analysis
  let analysis: AnalysisForPolicy | null = input.analysis ?? null;
  let extractionError: string | undefined;
  const extractionSkipped = analysis !== null;

  if (!analysis) {
    const result = await extractOne(input.proposal as Parameters<typeof extractOne>[0], 'sonnet');
    if (result.ok) {
      analysis = result.analysis;
    } else {
      extractionError = result.error;
    }
  }

  if (!analysis) {
    return {
      proposal: proposalRef,
      analysis: null,
      extraction_skipped: false,
      extraction_error: extractionError,
      evaluation: null,
      vote: null,
      rationale_md: buildRationale({ proposal: proposalRef, analysis: null, evaluation: null, extractionError }),
      pipeline_version: PIPELINE_VERSION,
    };
  }

  // Step 2 — deterministic policy evaluation
  const profile = input.profile ?? DEFAULT_PROFILE;
  const rules = compileProfileToRules(profile);
  const evaluation = evaluate(analysis, profile, rules, {
    id: input.proposal.id,
    author_address: input.proposal.author,
    space: input.proposal.space?.id,
  });

  // Step 3 — sign vote if (a) decision is auto-castable, (b) account provided,
  // (c) we know which space to vote in.
  let vote: PipelineResult['vote'] = null;
  const choice = decisionToChoice(evaluation.decision);
  if (input.account && choice !== null && proposalRef.space) {
    const envelope = await signVote({
      account: input.account,
      space: proposalRef.space,
      proposalId: input.proposal.id as Hex,
      choice,
      reason: `gov-agent ${PIPELINE_VERSION}: ${evaluation.decision} (engine v${evaluation.engine_version})`,
    });
    vote = { envelope, choice };
  }

  return {
    proposal: proposalRef,
    analysis,
    extraction_skipped: extractionSkipped,
    evaluation,
    vote,
    rationale_md: buildRationale({ proposal: proposalRef, analysis, evaluation }),
    pipeline_version: PIPELINE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Deterministic rationale builder
//
// No LLM. Every line is composed from the structured analysis + the policy
// engine's triggered_rules. The user can read this and recompute it locally.
// ---------------------------------------------------------------------------

function buildRationale(args: {
  proposal: PipelineProposalRef;
  analysis: AnalysisForPolicy | null;
  evaluation: PolicyEvaluation | null;
  extractionError?: string;
}): string {
  const md: string[] = [];

  md.push(`# ${args.proposal.title ?? args.proposal.id}`);
  md.push('');
  md.push(`- ID: \`${args.proposal.id}\``);
  if (args.proposal.space) md.push(`- Space: \`${args.proposal.space}\``);
  if (args.proposal.state) md.push(`- State: \`${args.proposal.state}\``);

  if (args.extractionError) {
    md.push('');
    md.push('## Extraction failed');
    md.push(`> ${args.extractionError}`);
    md.push('');
    md.push('No decision produced. Supply an `analysis` in the request body to skip the LLM and run policy evaluation directly.');
    return md.join('\n');
  }

  if (!args.analysis) {
    md.push('');
    md.push('No analysis available; cannot evaluate policy.');
    return md.join('\n');
  }

  md.push('');
  md.push('## What it does');
  md.push(args.analysis.summary);

  if (args.analysis.tradeoffs.length > 0) {
    md.push('');
    md.push('## Tradeoffs');
    for (const t of args.analysis.tradeoffs) {
      md.push(`- **Pro**: ${t.pro}`);
      md.push(`  **Con**: ${t.con}`);
    }
  }

  md.push('');
  md.push('## Flags');
  const f = args.analysis.flags;
  md.push(`- Category: \`${args.analysis.category}\``);
  if (f.treasury_spend_usd != null) md.push(`- Treasury spend: $${f.treasury_spend_usd.toLocaleString()}`);
  md.push(`- Has milestones: ${f.has_milestones}`);
  md.push(`- Reversible: ${f.reversible}`);
  md.push(`- Time sensitive: ${f.time_sensitive}`);
  md.push(`- Requires contract upgrade: ${f.requires_contract_upgrade}`);
  md.push(`- Touches ownership: ${f.touches_ownership}`);

  if (args.analysis.uncertainty.requires_human_judgment) {
    md.push('');
    md.push('## LLM uncertainty flag');
    md.push(`The LLM extracted this proposal with low confidence: ${args.analysis.uncertainty.ambiguity_notes || '(no notes)'}`);
  }

  if (!args.evaluation) {
    return md.join('\n');
  }

  const e = args.evaluation;
  md.push('');
  md.push(`## Decision: **${e.decision}**`);
  md.push(`- Confidence: ${(e.confidence * 100).toFixed(0)}%`);
  md.push(`- Engine version: \`${e.engine_version}\``);
  md.push(`- Scores: FOR=${e.scores.FOR.toFixed(1)}, AGAINST=${e.scores.AGAINST.toFixed(1)}, margin=${e.margin.toFixed(2)}`);

  md.push('');
  md.push('### Triggered rules');
  if (e.triggered_rules.length === 0) {
    md.push('_No rules matched. Default behavior applied._');
  } else {
    for (const r of e.triggered_rules) {
      let line = `- \`${r.id}\` (priority ${r.priority}): ${r.reason}`;
      if (r.contribution) {
        const parts = Object.entries(r.contribution).map(([k, v]) => `${k} +${v}`);
        if (parts.length > 0) line += ` — _${parts.join(', ')}_`;
      }
      md.push(line);
    }
  }

  return md.join('\n');
}
