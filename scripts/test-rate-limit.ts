/**
 * test:rate-limit — sanity for the token-bucket logic in src/rate-limit.ts.
 *
 * Not exhaustive. Covers the cases most likely to regress:
 *   - First call passes; burst capacity exhausts after N calls.
 *   - Time advances → bucket refills, calls pass again.
 *   - Hourly cap blocks before burst when burst refill is fast.
 *   - Different keys don't share buckets.
 */

import { takeToken, _resetForTest } from '../src/rate-limit.js';

let pass = 0;
let fail = 0;

function check(label: string, actual: boolean, expected: boolean) {
  if (actual === expected) {
    console.log(`✓ ${label}`);
    pass++;
  } else {
    console.log(`✗ ${label} — expected ${expected}, got ${actual}`);
    fail++;
  }
}

// Test 1: burst capacity exhausts after the configured number of calls.
_resetForTest();
const cfg = {
  burstCapacity: 5,
  burstRefillPerMs: 5 / 60_000,
  hourlyCapacity: 100,
  hourlyRefillPerMs: 100 / (60 * 60_000),
};
const t0 = 1_000_000;
for (let i = 0; i < 5; i++) {
  const r = takeToken('user:a', cfg, t0);
  check(`burst call ${i + 1}/5 allowed`, r.allowed, true);
}
const sixth = takeToken('user:a', cfg, t0);
check('6th burst call rejected', sixth.allowed, false);
if (!sixth.allowed) {
  check('rejection window is burst', sixth.window === 'burst', true);
}

// Test 2: time advances → burst refills.
_resetForTest();
for (let i = 0; i < 5; i++) takeToken('user:b', cfg, t0);
// One full minute later: full refill.
const afterMinute = takeToken('user:b', cfg, t0 + 60_000);
check('after 60s, burst refills', afterMinute.allowed, true);

// Test 3: different keys do not share buckets.
_resetForTest();
for (let i = 0; i < 5; i++) takeToken('user:c', cfg, t0);
const otherUser = takeToken('user:d', cfg, t0);
check('different key has independent bucket', otherUser.allowed, true);

// Test 4: hourly cap dominates when burst refills faster.
_resetForTest();
const fastBurst = {
  burstCapacity: 100,
  burstRefillPerMs: 100 / 60_000,
  hourlyCapacity: 3,
  hourlyRefillPerMs: 3 / (60 * 60_000),
};
for (let i = 0; i < 3; i++) takeToken('user:e', fastBurst, t0);
const fourth = takeToken('user:e', fastBurst, t0);
check('hourly cap rejects 4th call', fourth.allowed, false);
if (!fourth.allowed) {
  check('rejection window is hourly', fourth.window === 'hourly', true);
}

// Test 5: retryAfterMs is positive and finite.
_resetForTest();
for (let i = 0; i < 5; i++) takeToken('user:f', cfg, t0);
const blocked = takeToken('user:f', cfg, t0);
if (!blocked.allowed) {
  check(
    'retryAfterMs > 0',
    blocked.retryAfterMs > 0 && Number.isFinite(blocked.retryAfterMs),
    true,
  );
}

console.log(`\nSummary: ${pass}/${pass + fail} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
