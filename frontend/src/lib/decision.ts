import type { PolicyEvaluation } from '../api';

export type SuggestedVote = NonNullable<PolicyEvaluation['suggested_vote']>;

export function suggestedVoteLabel(suggested: SuggestedVote): string {
  const prefix =
    suggested.source === 'review_gate' && suggested.decision === 'AGAINST'
      ? 'Risk lean'
      : suggested.source === 'default_action'
        ? 'Fallback lean'
        : 'Lean';
  return `${prefix} ${suggested.decision}`;
}

export function suggestedVoteMeta(suggested: SuggestedVote): string {
  const confidence = `${Math.round(suggested.confidence * 100)}%`;
  if (suggested.source === 'review_gate') return `${confidence} review-gated`;
  if (suggested.source === 'default_action') return `${confidence} fallback`;
  return `${confidence} policy lean`;
}
