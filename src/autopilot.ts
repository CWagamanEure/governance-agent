/**
 * Autopilot batch runner — the shared core that both the HTTP endpoint
 * (/pipeline/autopilot-run) and the cron poller (src/cron.ts) call.
 *
 * Caller is responsible for:
 *   - authenticating the user
 *   - loading the user's policy + rules
 *   - assembling the proposal candidate list
 *
 * This function then:
 *   - verifies every proposal against the public Snapshot hub
 *   - filters out non-existent, space-mismatched, and non-followed items
 *   - runs the plan phase (cache-or-live extraction inside the TEE,
 *     per-item timeout, per-batch live-extraction budget)
 *   - on real run: signs + submits eligible items sequentially
 *   - returns the per-item plan and submission summary
 *
 * Pure caller responsibility — no HTTP, no auth, no rate limiting. The
 * HTTP layer wraps these; the cron layer iterates users and calls this.
 */

import type { Account } from 'viem/accounts';
import {
  evaluate as evaluatePolicy,
  isAutopilotEligible,
  type AnalysisForPolicy,
  type PolicyProfileT,
  type Rule,
} from './policy.js';
import { runPipeline, type SnapshotProposalRaw } from './pipeline.js';
import {
  decisionToChoice,
  signVote,
  submitVote,
  verifyProposalsByIds,
  type VerifiedProposal,
} from './snapshot.js';
import { signDecisionBlob } from './decision-blob.js';
import {
  appendAudit,
  getCachedAnalysis,
  getSubmittedProposalIdsForUser,
} from './db.js';

export type SubmitAuditInput = {
  user_id: string;
  space: string;
  proposal: string;
  choice: number;
  from: string;
  result: { ok: true; receipt: unknown } | { ok: false; status: number; error: string };
};

/**
 * Shared vote-submission audit helper. Both the HTTP autopilot endpoint
 * and the cron poller call this, so a Snapshot submit triggered by
 * /pipeline/run, /vote/submit, /pipeline/autopilot-run, OR the
 * background poller all land on the same audit chain with the same
 * event_type. Without a single helper, one of the four submit paths
 * would leave no audit trail and "every vote audited" would be a half-
 * truth.
 */
export function auditVoteSubmission(args: SubmitAuditInput): void {
  appendAudit({
    event_type: 'VOTE_SUBMITTED',
    user_id: args.user_id,
    payload: {
      space: args.space,
      proposal: args.proposal,
      choice: args.choice,
      from: args.from,
      ok: args.result.ok,
      receipt: args.result.ok ? args.result.receipt : undefined,
      error: args.result.ok ? undefined : args.result.error,
    },
  });
}
import { EXTRACTION_SCHEMA_VERSION } from './llm.js';

// Re-exported for callers (server.ts, cron.ts).
export type PlanItem = {
  proposal_id: string;
  title: string | null;
  space: string | null;
  decision: 'FOR' | 'AGAINST' | 'ABSTAIN' | 'MANUAL_REVIEW' | null;
  confidence: number | null;
  eligible: boolean;
  reason?: string;
  extraction_source?: string;
  submitted?: { ok: boolean; snapshot_url?: string; error?: string };
};

export type AutopilotBatchResult = {
  plan: PlanItem[];
  submitted_count: number;
  capped: boolean;
  fatal?: { code: string; message: string };
};

export type AutopilotBatchArgs = {
  /** DB user_id (UUID), used as the audit ref. */
  userId: string;
  /** 0x-prefixed eth address, used to derive the per-user wallet for signing. */
  userAddress: string;
  /** Parsed PolicyProfile from the user's latest saved row. */
  profile: PolicyProfileT;
  /** Compiled rule list (already produced by caller). */
  rules: Rule[];
  /** Latest saved policy hash, embedded in the audit log and the response. */
  policyHash: string;
  /** Caller-supplied proposal candidates. Will be verified before any work. */
  proposals: SnapshotProposalRaw[];
  /** dry_run=true => plan only, no signing or submission. */
  dryRun: boolean;
  /** Hard cap on how many eligible items get signed + submitted. */
  maxVotes: number;
  /** Per-item LLM extraction timeout in ms. */
  extractionTimeoutMs: number;
  /** Per-batch ceiling on live LLM calls (caller already clamped). */
  liveExtractionBudget: number;
  /** Wallet factory. Caller provides since wallet derivation is process-wide
   * (throws on misconfigured MNEMONIC). Lets us 503 cleanly without a stack. */
  acctFactory: () => Account;
  /** Where this batch was kicked off from. Reaches the audit log. */
  source: 'http' | 'cron';
  /** Submission allowlist gate; caller wires it from the server's
   * isSpaceAllowedForSubmit (which reads env). */
  isSpaceAllowedForSubmit: (space: string) => boolean;
  /** Vote-submission audit helper from server.ts. */
  auditVoteSubmission: (args: SubmitAuditInput) => void;
};

export async function runAutopilotBatch(args: AutopilotBatchArgs): Promise<AutopilotBatchResult> {
  const {
    userId,
    userAddress,
    profile,
    rules,
    policyHash,
    proposals,
    dryRun,
    maxVotes,
    extractionTimeoutMs,
    liveExtractionBudget,
    acctFactory,
    source,
    isSpaceAllowedForSubmit,
    auditVoteSubmission,
  } = args;

  const effectiveAutopilot = dryRun
    ? { ...profile.autopilot, enabled: true }
    : profile.autopilot;

  // Step 1 — verify against Snapshot hub.
  let verifiedById: Map<string, VerifiedProposal>;
  try {
    verifiedById = await verifyProposalsByIds(proposals.map((p) => p.id));
  } catch (e) {
    return {
      plan: [],
      submitted_count: 0,
      capped: false,
      fatal: {
        code: 'snapshot_verification_failed',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  // Step 2 — filter unverified / space-mismatched / non-followed /
  // already-voted items. The already-voted check guards against a
  // recurring cron tick re-attempting a vote the user (or a prior
  // tick) has already submitted. The audit chain is the source of
  // truth for submitted votes; this query reads it directly.
  //
  // followedSet is lowercased to match the canonical form written at
  // the /profile save boundary AND the lowercased actualSpace below.
  // Defense in depth: a profile saved by an older code path (before
  // F1 normalization) could still have mixed-case entries.
  const followedSet = new Set<string>(
    Array.isArray(profile.followed_spaces)
      ? profile.followed_spaces.map((s) => s.toLowerCase())
      : [],
  );
  const followedFilterActive = followedSet.size > 0;
  const alreadyVoted = getSubmittedProposalIdsForUser(userId);
  const verificationFailures: PlanItem[] = [];
  const verifiedProposals: SnapshotProposalRaw[] = [];
  for (const p of proposals) {
    const v = verifiedById.get(p.id.toLowerCase());
    if (!v) {
      verificationFailures.push({
        proposal_id: p.id,
        title: p.title ?? null,
        space: p.space?.id ?? null,
        decision: null,
        confidence: null,
        eligible: false,
        reason: 'proposal_not_found_on_snapshot',
      });
      continue;
    }
    const claimedSpace = (p.space?.id ?? '').toLowerCase();
    const actualSpace = v.space.id.toLowerCase();
    if (claimedSpace && claimedSpace !== actualSpace) {
      verificationFailures.push({
        proposal_id: p.id,
        title: v.title,
        space: actualSpace,
        decision: null,
        confidence: null,
        eligible: false,
        reason: `proposal_space_mismatch: caller_said_${claimedSpace}_hub_says_${actualSpace}`,
      });
      continue;
    }
    if (followedFilterActive && !followedSet.has(actualSpace)) {
      verificationFailures.push({
        proposal_id: p.id,
        title: v.title,
        space: actualSpace,
        decision: null,
        confidence: null,
        eligible: false,
        reason: `space_not_followed: ${actualSpace}`,
      });
      continue;
    }
    if (alreadyVoted.has(v.id.toLowerCase())) {
      verificationFailures.push({
        proposal_id: p.id,
        title: v.title,
        space: actualSpace,
        decision: null,
        confidence: null,
        eligible: false,
        reason: 'already_voted',
      });
      continue;
    }
    verifiedProposals.push({
      id: v.id,
      title: v.title,
      body: v.body,
      author: v.author,
      type: v.type,
      choices: v.choices,
      start: v.start,
      end: v.end,
      state: v.state,
      space: { id: v.space.id },
    });
  }

  // Step 3 — pre-classify cache hits vs misses; reserve live slots.
  const allowLive: boolean[] = new Array(verifiedProposals.length).fill(true);
  let liveSlotsRemaining = liveExtractionBudget;
  for (let i = 0; i < verifiedProposals.length; i++) {
    const hasCache = getCachedAnalysis(verifiedProposals[i].id, EXTRACTION_SCHEMA_VERSION) !== null;
    if (hasCache) continue;
    if (liveSlotsRemaining > 0) liveSlotsRemaining -= 1;
    else allowLive[i] = false;
  }

  // Step 4 — plan phase fan-out with per-item timeout.
  const settled = await Promise.allSettled(
    verifiedProposals.map(async (p, i) => {
      const space = p.space?.id ?? null;
      if (!allowLive[i]) {
        return {
          proposal_id: p.id,
          title: p.title ?? null,
          space,
          decision: null,
          confidence: null,
          eligible: false,
          reason: 'live_extraction_budget_exceeded',
          extraction_source: 'none',
        } satisfies PlanItem;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`extraction_timeout_${extractionTimeoutMs}ms`)),
          extractionTimeoutMs,
        );
      });
      let result;
      try {
        result = await Promise.race([
          runPipeline({ proposal: p, profile }),
          timeout,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!result.evaluation || !result.analysis) {
        return {
          proposal_id: p.id,
          title: p.title ?? null,
          space,
          decision: null,
          confidence: null,
          eligible: false,
          reason: result.extraction_error
            ? `extraction_failed: ${result.extraction_error}`
            : 'no_extraction',
          extraction_source: result.extraction.source,
        } satisfies PlanItem;
      }
      const evaluation = result.evaluation;
      const eligible = isAutopilotEligible(evaluation, effectiveAutopilot);
      let reason: string | undefined;
      if (!eligible) {
        if (evaluation.decision === 'MANUAL_REVIEW') reason = 'decision_manual_review';
        else if (evaluation.confidence < effectiveAutopilot.min_confidence) reason = 'below_confidence_floor';
        else reason = 'autopilot_disabled';
      }
      if (result.extraction.source === 'live') {
        appendAudit({
          event_type: 'autopilot_extracted_proposal',
          user_id: userId,
          ref_id: p.id,
          payload: {
            space,
            title: p.title ?? null,
            decision: evaluation.decision,
            confidence: evaluation.confidence,
            eligible,
            dry_run: dryRun,
            source,
            policy_hash: policyHash,
            extraction_route: result.extraction.route,
            extraction_model: result.extraction.modelId,
          },
        });
      }
      return {
        proposal_id: p.id,
        title: p.title ?? null,
        space,
        decision: evaluation.decision,
        confidence: evaluation.confidence,
        eligible,
        reason,
        extraction_source: result.extraction.source,
      } satisfies PlanItem;
    }),
  );
  const fanoutPlan: PlanItem[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const p = verifiedProposals[i];
    const errMsg = s.reason instanceof Error ? s.reason.message : String(s.reason);
    const isTimeout = errMsg.startsWith('extraction_timeout_');
    return {
      proposal_id: p.id,
      title: p.title ?? null,
      space: p.space?.id ?? null,
      decision: null,
      confidence: null,
      eligible: false,
      reason: isTimeout ? `extraction_timeout: ${errMsg}` : `pipeline_error: ${errMsg}`,
    };
  });
  const plan: PlanItem[] = [...verificationFailures, ...fanoutPlan];

  // Step 5 — dry_run stops here.
  if (dryRun) {
    const eligibleCount = plan.filter((p) => p.eligible).length;
    return {
      plan,
      submitted_count: 0,
      capped: eligibleCount > maxVotes,
    };
  }

  // Step 6 — sign + submit eligible items, sequentially with a small delay.
  const eligible = plan.filter((p) => p.eligible);
  const willSubmit = eligible.slice(0, maxVotes);
  const capped = eligible.length > maxVotes;
  let acct: Account;
  try {
    acct = acctFactory();
  } catch (e) {
    return {
      plan,
      submitted_count: 0,
      capped,
      fatal: {
        code: 'wallet_unavailable',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
  let submittedCount = 0;
  for (let i = 0; i < willSubmit.length; i++) {
    const item = willSubmit[i];
    const original = verifiedProposals.find((p) => p.id === item.proposal_id)!;
    const cached = getCachedAnalysis(item.proposal_id, EXTRACTION_SCHEMA_VERSION);
    if (!cached) {
      item.submitted = {
        ok: false,
        error: 'cache_lookup_failed_post_extraction',
      };
      continue;
    }
    const analysis = JSON.parse(cached.analysis_json) as AnalysisForPolicy;
    analysis.extraction_confidence = cached.extraction_confidence;
    const evaluation = evaluatePolicy(analysis, profile, rules, {
      id: item.proposal_id,
      author_address: original.author,
      space: item.space ?? undefined,
    });
    const choice = decisionToChoice(evaluation.decision);
    if (choice === null) {
      item.submitted = { ok: false, error: 'no choice mapping for decision' };
      continue;
    }
    const targetSpace = item.space ?? '';
    if (!isSpaceAllowedForSubmit(targetSpace)) {
      item.submitted = { ok: false, error: `space_not_allowed: ${targetSpace}` };
      continue;
    }
    try {
      await signDecisionBlob({
        account: acct,
        userAddress: userAddress as `0x${string}`,
        proposal: original,
        policy: profile,
        rules,
        analysis,
        evaluation,
        choice,
        pipelineVersion: source === 'cron' ? 'autopilot-cron-1' : 'autopilot-1',
      });
      const envelope = await signVote({
        account: acct,
        space: targetSpace,
        proposalId: item.proposal_id as `0x${string}`,
        choice,
        reason: `gov-agent autopilot v0.1 (${source}): ${evaluation.decision} (engine ${evaluation.engine_version}, confidence ${evaluation.confidence.toFixed(2)})`,
      });
      const submitResult = await submitVote(envelope);
      auditVoteSubmission({
        user_id: userId,
        space: targetSpace,
        proposal: item.proposal_id,
        choice,
        from: envelope.address,
        result: submitResult,
      });
      if (submitResult.ok) {
        item.submitted = {
          ok: true,
          snapshot_url: `https://snapshot.org/#/${targetSpace}/proposal/${item.proposal_id}`,
        };
        submittedCount += 1;
      } else {
        item.submitted = { ok: false, error: submitResult.error };
      }
    } catch (e) {
      item.submitted = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    if (i < willSubmit.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return { plan, submitted_count: submittedCount, capped };
}
