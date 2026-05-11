/**
 * test:autopilot-cron — exercises the data layer and tick mechanics
 * the background poller depends on, without making live LLM calls.
 *
 * Covers:
 *   - listAutopilotEnabledUsers() correctly includes opted-in users
 *     and excludes opted-out / unsaved ones.
 *   - getSubmittedProposalIdsForUser() reads the audit chain for
 *     dedup decisions.
 *   - pollerStatus() reflects manual trigger correctly.
 *   - triggerTickForTest() runs end-to-end on a fresh DB without
 *     incurring LLM cost when no users follow allowlisted DAOs.
 *
 * NOT covered: an actual live extraction triggered by the tick.
 * That is intentionally left to manual demo-day verification, since
 * a live test would either hit the real LLM (cost + flake) or
 * require a mocking layer we do not have today.
 *
 * Run with `npm run test:autopilot-cron`.
 */

import { randomUUID } from 'node:crypto';
import {
  appendAudit,
  findOrCreateUser,
  saveProfile,
  listAutopilotEnabledUsers,
  getSubmittedProposalIdsForUser,
} from '../src/db.js';
import { compileProfileToRules, DEFAULT_PROFILE, type PolicyProfileT } from '../src/policy.js';
import { pollerStatus, triggerTickForTest } from '../src/cron.js';

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean) {
  if (ok) {
    console.log(`✓ ${label}`);
    pass++;
  } else {
    console.log(`✗ ${label}`);
    fail++;
  }
}

// Unique test addresses so the test does not collide with real demo
// users in the local DB. Lowercased to match the storage convention.
const testTag = randomUUID().slice(0, 8);
const optedInAddr = `0x${'a'.repeat(38)}${testTag.slice(0, 2)}`.toLowerCase();
const optedOutAddr = `0x${'b'.repeat(38)}${testTag.slice(0, 2)}`.toLowerCase();
const noProfileAddr = `0x${'c'.repeat(38)}${testTag.slice(0, 2)}`.toLowerCase();

// ---------------------------------------------------------------------------
// Test 1: listAutopilotEnabledUsers filters correctly
// ---------------------------------------------------------------------------

function withAutopilot(enabled: boolean): PolicyProfileT {
  return {
    ...DEFAULT_PROFILE,
    autopilot: { enabled, min_confidence: 0.85 },
    // Empty followed_spaces so the cron tick exits without LLM work
    // when this user is iterated. Matches the test isolation goal.
    followed_spaces: [],
  };
}

const optedIn = findOrCreateUser(optedInAddr);
const optedInProfile = withAutopilot(true);
saveProfile({
  user_id: optedIn.id,
  profile: optedInProfile,
  rules: compileProfileToRules(optedInProfile),
});

const optedOut = findOrCreateUser(optedOutAddr);
const optedOutProfile = withAutopilot(false);
saveProfile({
  user_id: optedOut.id,
  profile: optedOutProfile,
  rules: compileProfileToRules(optedOutProfile),
});

// noProfileAddr exists as a user row but has no saved profile.
findOrCreateUser(noProfileAddr);

const enabledUsers = listAutopilotEnabledUsers();
const enabledIds = new Set(enabledUsers.map((u) => u.user_id));
check('opted-in user appears in listAutopilotEnabledUsers', enabledIds.has(optedIn.id));
check('opted-out user does NOT appear', !enabledIds.has(optedOut.id));
check('no-profile user does NOT appear', !enabledIds.has(findOrCreateUser(noProfileAddr).id));

// ---------------------------------------------------------------------------
// Test 2: getSubmittedProposalIdsForUser reads the audit chain
// ---------------------------------------------------------------------------

const submittedId = `0x${'1'.repeat(56)}submit`;
const failedId = `0x${'2'.repeat(56)}failed`;
const unrelatedId = `0x${'3'.repeat(56)}other`;

appendAudit({
  event_type: 'VOTE_SUBMITTED',
  user_id: optedIn.id,
  payload: { proposal: submittedId, ok: true, receipt: { id: 'snap-1' } },
});
appendAudit({
  event_type: 'VOTE_SUBMITTED',
  user_id: optedIn.id,
  payload: { proposal: failedId, ok: false, error: 'no voting power' },
});
appendAudit({
  event_type: 'VOTE_SUBMITTED',
  user_id: optedOut.id,
  payload: { proposal: unrelatedId, ok: true, receipt: { id: 'snap-2' } },
});

const submittedForOptedIn = getSubmittedProposalIdsForUser(optedIn.id);
check(
  'submitted proposal is in the dedup set',
  submittedForOptedIn.has(submittedId.toLowerCase()),
);
check(
  'failed proposal is also in the dedup set (no retries)',
  submittedForOptedIn.has(failedId.toLowerCase()),
);
check(
  'other user proposal is NOT in this user dedup set',
  !submittedForOptedIn.has(unrelatedId.toLowerCase()),
);

// ---------------------------------------------------------------------------
// Test 3: pollerStatus reflects manual trigger
// ---------------------------------------------------------------------------

const beforeTickStatus = pollerStatus();
const tickResult = await triggerTickForTest();
const afterTickStatus = pollerStatus();

check(
  'tick count increments after manual trigger',
  afterTickStatus.ticks === beforeTickStatus.ticks + 1,
);
check('tick result was returned (not null)', tickResult !== null);
check(
  'in-flight clears after tick completes',
  afterTickStatus.inFlight === false,
);

// ---------------------------------------------------------------------------
// Test 4: tick with users-but-no-followed-spaces does not throw
// ---------------------------------------------------------------------------

// Both opted-in test users have empty followed_spaces (set above), so the
// tick should iterate them, intersect with the allowlist (empty), and
// short-circuit without hitting Snapshot or the LLM. Errors here would
// indicate the per-user error isolation is broken.
check(
  'tick completed without errors for users with empty followed_spaces',
  (tickResult?.errors.length ?? 0) === 0,
);

console.log(`\nSummary: ${pass}/${pass + fail} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
