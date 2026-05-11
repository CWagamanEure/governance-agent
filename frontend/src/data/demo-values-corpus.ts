/**
 * Shared demo onboarding inputs — the canonical source for both:
 *
 *   - frontend/src/Onboarding.tsx (Use example values + Use example
 *     calibration buttons)
 *   - scripts/test-compile-peel.ts (regression test that the
 *     compiled-from-these-inputs profile reproduces ACT 2 of
 *     DEMO_SCRIPT.md)
 *
 * Single source of truth so the test cannot silently drift from
 * what the demo actually uses. F6.
 */

/**
 * Sentences the demo "Use example values" button injects into the
 * stated_values textarea. Joined with a single space to form the
 * full submitted text.
 */
export const DEMO_VALUES_SENTENCES = [
  'I support funding public goods and developer infrastructure when the recipient is identifiable and the deliverables are measurable.',
  'Large recurring treasury programs should require milestones, transparent reporting, and clear evidence that prior tranches worked.',
  'I am cautious on irreversible contract upgrades and centralizing partnerships, even when the upside is real.',
  'For routine technical parameter changes, I am comfortable following l2beat.eth unless the proposal changes core governance power.',
];

/** Pre-joined form for direct textarea injection. */
export const DEMO_VALUES_TEXT = DEMO_VALUES_SENTENCES.join(' ');

export type DemoCalibrationChoice = 'FOR' | 'AGAINST' | 'ABSTAIN';

export type DemoCalibrationEntry = {
  proposal_id: string;
  user_choice: DemoCalibrationChoice;
  reason: string;
};

/**
 * Preselected calibration answers the demo "Use example calibration"
 * button applies. Each entry maps a calibration corpus proposal id to
 * the demo user's intended vote + a short reason.
 */
export const DEMO_CALIBRATION_LIST: DemoCalibrationEntry[] = [
  {
    proposal_id: 'cal-001-stip-extension',
    user_choice: 'AGAINST',
    reason: 'Large recurring incentives with weak measurement should not be automatic.',
  },
  {
    proposal_id: 'cal-003-pg-grant',
    user_choice: 'FOR',
    reason: 'Public goods funding with broad recipients and quarterly reporting.',
  },
  {
    proposal_id: 'cal-004-centralized-rpc',
    user_choice: 'AGAINST',
    reason: 'The exclusive default concentrates infrastructure power.',
  },
  {
    proposal_id: 'cal-006-dip-update',
    user_choice: 'FOR',
    reason: 'Paid delegate programs need accountability and public rationale.',
  },
  {
    proposal_id: 'cal-007-bridge-upgrade',
    user_choice: 'ABSTAIN',
    reason: 'Audited but irreversible, so not an automatic vote.',
  },
  {
    proposal_id: 'cal-010-doc-translation',
    user_choice: 'FOR',
    reason: 'Small scoped grant with milestones and a known contributor team.',
  },
  {
    proposal_id: 'cal-019-mystery-grant',
    user_choice: 'AGAINST',
    reason: 'Unidentified recipient, vague scope, no milestones, lump sum.',
  },
  {
    proposal_id: 'cal-020-l2beat-followed-vote',
    user_choice: 'FOR',
    reason: 'Routine reversible technical change aligned with a trusted delegate.',
  },
];

/**
 * Onboarding.tsx historically kept calibration as a Record keyed by
 * proposal_id for fast lookup in the "Use example calibration"
 * onClick. Provide that shape as a derived export so the UI code stays
 * unchanged.
 */
export const DEMO_CALIBRATION_BY_ID: Record<
  string,
  { choice: DemoCalibrationChoice; reason: string }
> = Object.fromEntries(
  DEMO_CALIBRATION_LIST.map((e) => [
    e.proposal_id,
    { choice: e.user_choice, reason: e.reason },
  ]),
);
