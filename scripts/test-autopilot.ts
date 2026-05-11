/**
 * Lock the eligibility semantics of isAutopilotEligible.
 *
 * Failure here is demo-day-relevant: the autopilot batch path uses this
 * predicate to decide what to auto-submit. Any drift in the boundary
 * conditions could cast a vote the user did not intend.
 *
 * Run with `npm run test:autopilot`.
 */

import { isAutopilotEligible, type AutopilotT, type PolicyEvaluation } from '../src/policy.js';

function ev(decision: PolicyEvaluation['decision'], confidence: number): PolicyEvaluation {
  return {
    decision,
    confidence,
    triggered_rules: [],
    scores: { FOR: 0, AGAINST: 0, ABSTAIN: 0, MANUAL_REVIEW: 0 },
    margin: 0,
    suggested_vote: null,
    engine_version: 'test',
  };
}

function ap(overrides: Partial<AutopilotT> = {}): AutopilotT {
  return {
    enabled: true,
    min_confidence: 0.85,
    ...overrides,
  };
}

const cases: Array<{ label: string; expected: boolean; e: PolicyEvaluation; a: AutopilotT }> = [
  // Off switch dominates everything
  {
    label: 'enabled=false → never eligible',
    expected: false,
    e: ev('FOR', 0.99),
    a: ap({ enabled: false }),
  },
  // MANUAL_REVIEW is always blocked — even at full confidence
  {
    label: 'MANUAL_REVIEW at 0.99 confidence → not eligible',
    expected: false,
    e: ev('MANUAL_REVIEW', 0.99),
    a: ap(),
  },
  // Predicate respects whatever decision the policy produced
  {
    label: 'decision=FOR above floor → eligible',
    expected: true,
    e: ev('FOR', 0.9),
    a: ap({ min_confidence: 0.85 }),
  },
  {
    label: 'decision=AGAINST above floor → eligible (no decisions filter)',
    expected: true,
    e: ev('AGAINST', 0.9),
    a: ap({ min_confidence: 0.85 }),
  },
  {
    label: 'decision=ABSTAIN above floor → eligible (no decisions filter)',
    expected: true,
    e: ev('ABSTAIN', 0.9),
    a: ap({ min_confidence: 0.85 }),
  },
  // Confidence floor
  {
    label: 'confidence below floor → not eligible',
    expected: false,
    e: ev('FOR', 0.5),
    a: ap({ min_confidence: 0.85 }),
  },
  {
    label: 'confidence equals floor → eligible (>=, not strict >)',
    expected: true,
    e: ev('FOR', 0.85),
    a: ap({ min_confidence: 0.85 }),
  },
  {
    label: 'confidence just below floor → not eligible',
    expected: false,
    e: ev('FOR', 0.8499),
    a: ap({ min_confidence: 0.85 }),
  },
  // Floor at the extremes
  {
    label: 'min_confidence=1.0, confidence=1.0 → eligible',
    expected: true,
    e: ev('FOR', 1.0),
    a: ap({ min_confidence: 1.0 }),
  },
  {
    label: 'min_confidence=0, confidence=0 → eligible',
    expected: true,
    e: ev('FOR', 0),
    a: ap({ min_confidence: 0 }),
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = isAutopilotEligible(c.e, c.a);
  const ok = got === c.expected;
  console.log(`${ok ? '✓' : '✗'} ${c.label} (got ${got}, expected ${c.expected})`);
  if (ok) pass++;
  else fail++;
}

console.log(`\nSummary: ${pass}/${pass + fail} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
