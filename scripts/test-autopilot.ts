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
    decisions: ['FOR'],
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
  // MANUAL_REVIEW is always blocked
  {
    label: 'MANUAL_REVIEW with FOR allowlisted → not eligible',
    expected: false,
    e: ev('MANUAL_REVIEW', 0.99),
    a: ap({ decisions: ['FOR', 'AGAINST', 'ABSTAIN'] }),
  },
  // Decision allowlist
  {
    label: 'FOR allowed, decision=FOR, confidence above floor → eligible',
    expected: true,
    e: ev('FOR', 0.9),
    a: ap({ decisions: ['FOR'], min_confidence: 0.85 }),
  },
  {
    label: 'FOR-only allowlist, decision=AGAINST → not eligible',
    expected: false,
    e: ev('AGAINST', 0.99),
    a: ap({ decisions: ['FOR'] }),
  },
  {
    label: 'AGAINST in allowlist, decision=AGAINST, above floor → eligible',
    expected: true,
    e: ev('AGAINST', 0.9),
    a: ap({ decisions: ['FOR', 'AGAINST'] }),
  },
  {
    label: 'ABSTAIN not in allowlist → not eligible',
    expected: false,
    e: ev('ABSTAIN', 0.99),
    a: ap({ decisions: ['FOR', 'AGAINST'] }),
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
  // Empty decisions list = nothing eligible regardless of confidence
  {
    label: 'decisions=[] → not eligible',
    expected: false,
    e: ev('FOR', 1.0),
    a: ap({ decisions: [] }),
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
