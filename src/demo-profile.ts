/**
 * Deterministic demo profile.
 *
 * The hand-tuned profile that the live demo restores via /demo/reset. Designed
 * so the four-step ACT-2 peel produces exactly 1 / 1 / 1 / 3 flips against the
 * cached corpus (27 real Arbitrum + 20 calibration). Trace via
 * `npx tsx scripts/trace-demo.ts` after any change to the engine or extractions.
 *
 * Stated values are the ones a reviewer would recognize as plausibly user-written.
 * Calibration evidence supports the META → ABSTAIN default and the SINGLE_RECIPIENT
 * floor.
 *
 * Why LCE is intentionally OFF: the cached extractions tag `proposer.type` as
 * low-confidence on most proposals, which would otherwise mask the cleaner
 * "category / flag" causality that ACT 2 reveals. The unconditional
 * `low_conf_guard` (priority 980, not user-toggleable) still catches cal-019.
 */

import type { PolicyProfileT } from './policy.js';

export const DEMO_PROFILE: PolicyProfileT = {
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
  // Autopilot OFF in the seeded profile — the demo turns it on live in
  // ACT 4.5 to show the slider beat. Conservative 0.85 floor so a reviewer
  // who toggles on without tweaking the slider only gets the highest-
  // signal autovotes.
  autopilot: {
    enabled: false,
    min_confidence: 0.85,
  },
  // Empty = autopilot falls back to the deploy allowlist. The seeded
  // demo user makes an explicit follow choice in onboarding rather than
  // pre-selecting one here, so the demo can show the per-user pick.
  followed_spaces: [],
  stated_values: [
    'I support small accountable grants for ecosystem work — under $500k, with milestones and reporting.',
    'META_GOVERNANCE proposals should default to ABSTAIN: I do not have a strong opinion on most procedure changes, but I do not want to autovote either way.',
    'Anything that touches contracts, ownership, tokenomics, or partnerships should always come to me for review.',
    'I want a $500k floor on single-recipient spends and on treasury actions overall.',
    'I do not want to autovote on grants until I have explicitly opened that up.',
  ],
};
