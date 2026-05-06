import type { PolicyEvaluation } from '../api';

export type SuggestedVote = NonNullable<PolicyEvaluation['suggested_vote']>;

export function suggestedVoteLabel(suggested: SuggestedVote): string {
  return suggested.decision;
}

export function suggestedVoteMeta(suggested: SuggestedVote): string {
  return `${Math.round(suggested.confidence * 100)}%`;
}

// Backend builds review-gate reasons as
//   "risk signals favor <DECISION> pending review: <bullet>; <bullet>"
// The prefix is redundant with the "Risk lean <DECISION>" label that sits
// next to it in the UI — strip it so the visible reason is just the bullets.
export function suggestedVoteReason(suggested: SuggestedVote): string {
  return suggested.reason.replace(
    /^risk signals favor [A-Z_]+ pending review:\s*/i,
    '',
  );
}
