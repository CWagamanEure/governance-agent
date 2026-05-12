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
 *   - profile?:  PolicyProfile to evaluate against. Defaults to DEFAULT_PROFILE
 *                only when the API layer explicitly allows default preview.
 *   - account?:  viem account that will sign the resulting vote. Omit to
 *                produce a decision without signing.
 *   - forceLiveExtraction?: ignore caller analysis + DB cache and call the LLM.
 *   - extractOnly?: stop after extraction; returns analysis + provenance but
 *                   does not evaluate or sign a policy decision.
 *
 * Output: PipelineResult containing the analysis, the policy evaluation, an
 * optionally-signed vote envelope, and a deterministic markdown rationale that
 * cites every rule that triggered.
 */

import type { Account } from 'viem/accounts';
import type { Hex } from 'viem';

import { createHash } from 'node:crypto';
import { extractOne, EXTRACTION_SCHEMA_VERSION } from './llm.js';
import {
  evaluate,
  compileProfileToRules,
  DEFAULT_PROFILE,
  type AnalysisForPolicy,
  type PolicyEvaluation,
  type PolicyProfileT,
} from './policy.js';
import {
  upsertProposal,
  getCachedAnalysis,
  upsertAnalysis,
} from './db.js';
import {
  decisionToChoice,
  signVote,
  submitVote,
  type SignedVoteEnvelope,
  type SubmitResult,
} from './snapshot.js';
import { signDecisionBlob, type SignedDecisionBlob } from './decision-blob.js';

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
  forceLiveExtraction?: boolean;
  extractOnly?: boolean;
  decisionAccount?: Account;
  voteAccount?: Account;
  userAddress?: Hex | null;
  // Backward-compatible shorthand: if supplied, signs both decision blob and vote.
  account?: Account;
  // User override: if set, sign a vote with this Snapshot choice number
  // (1=FOR, 2=AGAINST, 3=ABSTAIN) regardless of evaluation.decision. Used by
  // the Activity tab when the user manually decides on a MANUAL_REVIEW item.
  // The decision blob still records the evaluation's outcome; the override
  // shows up in the rationale + vote envelope only.
  override_choice?: number | null;
  // Submit the signed vote envelope to Snapshot's sequencer. If false (the
  // default), we sign-only — useful for previews, audit trails, and demos
  // that shouldn't hit the live network. If true and submission fails (e.g.
  // the signing wallet has no voting power on the proposal's snapshot
  // block), the error surfaces in PipelineResult.submission.
  submit?: boolean;
};

export type PipelineProposalRef = {
  id: string;
  title?: string;
  space?: string;
  state?: string;
};

export type PipelineExtraction = {
  source: 'supplied' | 'cache' | 'live' | 'none';
  schema_version: string;
  route?: 'eigen-proxy' | 'anthropic-direct';
  modelId?: string;
  usage?: unknown;
  bodyTruncated?: boolean;
  cache?: {
    model_name: string;
    model_version: string;
    extraction_confidence: number;
    created_at: number;
  };
};

export type PipelineResult = {
  proposal: PipelineProposalRef;
  analysis: AnalysisForPolicy | null;
  extraction: PipelineExtraction;
  extraction_skipped: boolean;
  extraction_error?: string;
  evaluation: PolicyEvaluation | null;
  decision_blob: SignedDecisionBlob | null;
  decision_blob_error?: string;
  vote: { envelope: SignedVoteEnvelope; choice: number } | null;
  submission: SubmitResult | null;
  rationale_md: string;
  pipeline_version: string;
};

export const PIPELINE_VERSION = '0.2.0';

// The prompt requires the LLM to emit field_confidence for these 8 paths.
// Sonnet often adds many more optional sub-fields rated near-zero when they
// don't apply (e.g. economics.* on a non-financial proposal); averaging all
// reported fields drags every score down even for cleanly-structured
// proposals. Restricting the mean to these 8 keeps the score discriminating.
const REQUIRED_CONFIDENCE_FIELDS = [
  'category',
  'proposer.type',
  'financial.treasury_spend_usd',
  'financial.recipient_count',
  'execution.requires_contract_upgrade',
  'execution.reversible',
  'governance.constitutional_change',
  'beneficiaries.primary_scope',
] as const;

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

  // Step 1 — extraction. Three sources, in priority order:
  //   (a) caller-supplied analysis (FEATURED demo path / re-runs)
  //   (b) DB cache hit at the current EXTRACTION_SCHEMA_VERSION
  //   (c) fresh LLM call, then write through to cache
  //
  // forceLiveExtraction intentionally bypasses both (a) and (b). That gives
  // the UI a real "Run live in TEE" path without relying on the smoke-test
  // endpoint.
  let analysis: AnalysisForPolicy | null = input.forceLiveExtraction ? null : input.analysis ?? null;
  let extractionError: string | undefined;
  let extractionSkipped = analysis !== null;
  let extraction: PipelineExtraction = {
    source: analysis ? 'supplied' : 'none',
    schema_version: EXTRACTION_SCHEMA_VERSION,
  };

  if (!analysis && !input.forceLiveExtraction && input.proposal.id) {
    const cached = getCachedAnalysis(input.proposal.id, EXTRACTION_SCHEMA_VERSION);
    if (cached) {
      try {
        const parsed = JSON.parse(cached.analysis_json) as AnalysisForPolicy;
        // The cache row stores the mean field-confidence in its own column;
        // the policy engine reads it off the analysis object, so set it here.
        parsed.extraction_confidence = cached.extraction_confidence;
        analysis = parsed;
        extractionSkipped = true;
        extraction = {
          source: 'cache',
          schema_version: EXTRACTION_SCHEMA_VERSION,
          route: cached.model_name === 'eigen-proxy' || cached.model_name === 'anthropic-direct' ? cached.model_name : undefined,
          modelId: cached.model_version,
          cache: {
            model_name: cached.model_name,
            model_version: cached.model_version,
            extraction_confidence: cached.extraction_confidence,
            created_at: cached.created_at,
          },
        };
      } catch {
        // Bad JSON in cache shouldn't be possible, but if so, fall through
        // to a fresh extraction rather than 500.
      }
    }
  }

  if (!analysis) {
    const result = await extractOne(input.proposal as Parameters<typeof extractOne>[0], 'sonnet');
    if (result.ok) {
      analysis = result.analysis;
      extractionSkipped = false;
      extraction = {
        source: 'live',
        schema_version: EXTRACTION_SCHEMA_VERSION,
        route: result.meta.route,
        modelId: result.meta.modelId,
        usage: result.meta.usage,
        bodyTruncated: result.meta.bodyTruncated,
      };
      // Write through to the cache so subsequent visits are free. Best-effort:
      // the proposals table requires a row exist before we can insert into
      // proposal_analyses, so upsertProposal first.
      try {
        upsertProposal(input.proposal as any);
        const fc = result.analysis.uncertainty?.field_confidence ?? {};
        const vals = REQUIRED_CONFIDENCE_FIELDS
          .map((k) => fc[k])
          .filter((v): v is number => typeof v === 'number');
        const meanConf = vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;
        const inputHash = createHash('sha256')
          .update(JSON.stringify({
            id: input.proposal.id,
            title: input.proposal.title,
            author: input.proposal.author,
            type: input.proposal.type,
            choices: input.proposal.choices,
            body: input.proposal.body,
          }))
          .digest('hex');
        upsertAnalysis({
          proposal_id: input.proposal.id,
          model_name: result.meta.route,
          model_version: result.meta.modelId,
          analysis: result.analysis,
          extraction_confidence: meanConf,
          input_hash: inputHash,
          schema_version: EXTRACTION_SCHEMA_VERSION,
        });
      } catch {
        // Cache write failures don't fail the pipeline. The decision still
        // returns to the caller; we just won't get the perf win on next visit.
      }
    } else {
      extractionError = result.error;
      extraction = {
        source: 'none',
        schema_version: EXTRACTION_SCHEMA_VERSION,
        route: result.meta.route,
        modelId: result.meta.modelId,
        bodyTruncated: result.meta.bodyTruncated,
      };
    }
  }

  if (!analysis) {
    return {
      proposal: proposalRef,
      analysis: null,
      extraction,
      extraction_skipped: false,
      extraction_error: extractionError,
      evaluation: null,
      decision_blob: null,
      vote: null,
      submission: null,
      rationale_md: buildRationale({ proposal: proposalRef, analysis: null, evaluation: null, extractionError }),
      pipeline_version: PIPELINE_VERSION,
    };
  }

  if (input.extractOnly) {
    return {
      proposal: proposalRef,
      analysis,
      extraction,
      extraction_skipped: extractionSkipped,
      evaluation: null,
      decision_blob: null,
      vote: null,
      submission: null,
      rationale_md: buildRationale({ proposal: proposalRef, analysis, evaluation: null }),
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

  // Step 3 — sign a decision blob. This is separate from the Snapshot vote
  // envelope and commits to the exact evidence + deterministic evaluation.
  let decisionBlob: SignedDecisionBlob | null = null;
  let decisionBlobError: string | undefined;
  const decisionAccount = input.decisionAccount ?? input.account;
  const choice = decisionToChoice(evaluation.decision);
  if (decisionAccount) {
    try {
      decisionBlob = await signDecisionBlob({
        account: decisionAccount,
        userAddress: input.userAddress,
        proposal: input.proposal,
        policy: profile,
        rules,
        analysis,
        evaluation,
        choice,
        pipelineVersion: PIPELINE_VERSION,
      });
    } catch (e) {
      decisionBlobError = e instanceof Error ? e.message : String(e);
    }
  }

  // Step 4 — sign vote.
  //
  // Two paths:
  //   (a) Auto-cast: evaluation.decision is FOR/AGAINST/ABSTAIN, no override.
  //       The vote choice comes from the policy engine's decision.
  //   (b) User override: caller supplied input.override_choice (1=FOR,
  //       2=AGAINST, 3=ABSTAIN). Used by Activity-tab approvals where the
  //       user manually decides on a MANUAL_REVIEW item. The decision blob
  //       still records evaluation.decision (which would have been
  //       MANUAL_REVIEW), so the override is auditable as a deliberate
  //       human decision rather than rules-driven.
  const overrideChoice = input.override_choice ?? null;
  const isOverride = overrideChoice !== null;
  const finalChoice = isOverride ? overrideChoice : choice;
  let vote: PipelineResult['vote'] = null;
  let submission: SubmitResult | null = null;
  const voteAccount = input.voteAccount ?? input.account;
  if (voteAccount && finalChoice !== null && proposalRef.space) {
    const reason = isOverride
      ? `gov-agent ${PIPELINE_VERSION}: user override (engine recommended ${evaluation.decision}, user signed choice ${finalChoice})`
      : `gov-agent ${PIPELINE_VERSION}: ${evaluation.decision} (engine v${evaluation.engine_version})`;
    const envelope = await signVote({
      account: voteAccount,
      space: proposalRef.space,
      proposalId: input.proposal.id as Hex,
      choice: finalChoice,
      reason,
    });
    vote = { envelope, choice: finalChoice };

    // Step 5 — actually submit to Snapshot's sequencer if the caller asked
    // for it. Sign-only is the default to keep dev-loop runs from polluting
    // a real DAO's vote record. Errors surface in submission.error so the
    // UI can show "no voting power" / "duplicate vote" / etc. without
    // failing the whole pipeline.
    if (input.submit === true) {
      try {
        submission = await submitVote(envelope);
      } catch (e) {
        submission = {
          ok: false,
          status: 0,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
  }

  return {
    proposal: proposalRef,
    analysis,
    extraction,
    extraction_skipped: extractionSkipped,
    evaluation,
    decision_blob: decisionBlob,
    decision_blob_error: decisionBlobError,
    vote,
    submission,
    rationale_md: buildRationale({ proposal: proposalRef, analysis, evaluation, isOverride, overrideChoice }),
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
  isOverride?: boolean;
  overrideChoice?: number | null;
}): string {
  const md: string[] = [];

  md.push(`# ${args.proposal.title ?? args.proposal.id}`);
  md.push('');
  md.push(`- ID: \`${args.proposal.id}\``);
  if (args.proposal.space) md.push(`- Space: \`${args.proposal.space}\``);
  if (args.proposal.state) md.push(`- State: \`${args.proposal.state}\``);
  if (args.isOverride && args.overrideChoice != null) {
    const choiceLabel = args.overrideChoice === 1 ? 'FOR' : args.overrideChoice === 2 ? 'AGAINST' : args.overrideChoice === 3 ? 'ABSTAIN' : `choice ${args.overrideChoice}`;
    md.push(`- **User override**: signed ${choiceLabel} after agent flagged for manual review`);
  }

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
  md.push('## Extracted features');
  const financial = args.analysis.financial;
  const execution = args.analysis.execution;
  const governance = args.analysis.governance;
  const beneficiaries = args.analysis.beneficiaries;
  md.push(`- Category: \`${args.analysis.category}\``);
  md.push(`- Proposer type: \`${args.analysis.proposer.type}\``);
  if (financial.treasury_spend_usd != null) {
    md.push(`- Treasury spend: $${financial.treasury_spend_usd.toLocaleString()}`);
  }
  if (financial.treasury_percent != null) {
    md.push(`- Treasury percent: ${financial.treasury_percent}%`);
  }
  md.push(`- Recipient count: ${financial.recipient_count ?? 'unknown'}`);
  md.push(`- Beneficiary scope: \`${beneficiaries.primary_scope}\``);
  md.push(`- Has milestones: ${execution.has_milestones}`);
  md.push(`- Has reporting: ${execution.has_reporting}`);
  md.push(`- Reversible: ${execution.reversible}`);
  md.push(`- Time sensitive: ${execution.time_sensitive}`);
  md.push(`- Requires contract upgrade: ${execution.requires_contract_upgrade}`);
  md.push(`- Changes permissions: ${execution.changes_permissions}`);
  md.push(`- Constitutional change: ${governance.constitutional_change}`);
  md.push(`- Emissions change: \`${args.analysis.economics.emissions_change}\``);

  if (args.analysis.uncertainty.requires_human_judgment) {
    md.push('');
    md.push('## LLM uncertainty flag');
    md.push(`The LLM extracted this proposal with low confidence: ${args.analysis.uncertainty.ambiguity_notes || '(no notes)'}`);
    if (args.analysis.uncertainty.low_confidence_fields.length > 0) {
      md.push(`Low-confidence fields: ${args.analysis.uncertainty.low_confidence_fields.map((f) => `\`${f}\``).join(', ')}`);
    }
  }

  if (!args.evaluation) {
    return md.join('\n');
  }

  const e = args.evaluation;
  md.push('');
  md.push(`## Decision: **${e.decision}**`);
  md.push(`- Confidence: ${(e.confidence * 100).toFixed(0)}%`);
  if (e.decision === 'MANUAL_REVIEW' && e.suggested_vote) {
    md.push(
      `- Suggested vote for review: **${e.suggested_vote.decision}** ` +
      `(${(e.suggested_vote.confidence * 100).toFixed(0)}%): ${e.suggested_vote.reason}`,
    );
  }
  md.push(`- Engine version: \`${e.engine_version}\``);

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
