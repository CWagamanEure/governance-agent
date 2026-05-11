/**
 * Autopilot background poller.
 *
 * Wakes every AUTOPILOT_POLL_INTERVAL_MS (default 15 min), iterates every
 * user with autopilot enabled in their saved policy, and runs the
 * autopilot pipeline against their followed_spaces. Disabled by default
 * (set AUTOPILOT_POLL_ENABLED=true to turn on).
 *
 * Singleton-process assumption: the TEE runs one server instance, so a
 * setInterval timer is sufficient — no distributed locking. If we ever
 * scale horizontally, switch to a queued job runner (or skip the
 * deploy-wide poller and let users trigger from the UI only).
 */

import { appendAudit, listAutopilotEnabledUsers } from './db.js';
import {
  PolicyProfile as PolicyProfileSchema,
  compileProfileToRules,
  normalizeProfile,
  type PolicyProfileT,
} from './policy.js';
import { fetchActiveProposalIdsInSpaces } from './snapshot.js';
import { userWallet } from './wallets.js';
import { runAutopilotBatch, auditVoteSubmission } from './autopilot.js';
import { getSubmitAllowlist, isSpaceAllowedForSubmit } from './submit-allowlist.js';
import type { SnapshotProposalRaw } from './pipeline.js';

export type PollTickStatus = {
  startedAt: number;
  finishedAt: number | null;
  userCount: number;
  itemsScored: number;
  itemsSubmitted: number;
  /**
   * Optional skip reason when the tick performed no per-user work.
   * Distinguishes:
   *   - 'no_allowlist'  — SUBMIT_ALLOWLIST empty; refused to act.
   *   - 'no_users'      — nobody opted in.
   *   - 'overlap'       — previous tick still running.
   * Absent on a normal successful tick.
   */
  skipped?: 'no_allowlist' | 'no_users' | 'overlap';
  errors: Array<{ user_id?: string; message: string }>;
};

const state: {
  intervalHandle: NodeJS.Timeout | null;
  timeoutHandle: NodeJS.Timeout | null; // initial jitter timeout (M1)
  enabled: boolean;
  intervalMs: number;
  ticks: number;
  lastTick: PollTickStatus | null;
  inFlight: boolean;
  /**
   * Per-user count of consecutive wallet_unavailable failures (M6).
   * After WALLET_FAIL_THRESHOLD consecutive failures we skip the user
   * for the rest of the process lifetime — MNEMONIC issues never
   * self-heal, so retrying every interval just spams the audit log.
   */
  walletFailures: Map<string, number>;
  permanentlySkipped: Set<string>;
} = {
  intervalHandle: null,
  timeoutHandle: null,
  enabled: false,
  intervalMs: 0,
  ticks: 0,
  lastTick: null,
  inFlight: false,
  walletFailures: new Map(),
  permanentlySkipped: new Set(),
};

const WALLET_FAIL_THRESHOLD = 3;

function readEnvBool(name: string): boolean {
  return process.env[name] === 'true';
}

function readEnvInt(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * One poll iteration. Wrapped in try/finally so a single bad tick
 * does not kill the timer AND so every tick records itself in the
 * audit log, even on the error path. Caller is the setInterval
 * timer; do not call directly.
 *
 * inFlight prevents an extra-long tick from overlapping with the
 * next scheduled tick — the late tick records an 'overlap' skip
 * row and exits.
 */
async function runPollTick(): Promise<void> {
  const tick: PollTickStatus = {
    startedAt: Date.now(),
    finishedAt: null,
    userCount: 0,
    itemsScored: 0,
    itemsSubmitted: 0,
    errors: [],
  };

  if (state.inFlight) {
    // M5: record the overlap rather than silently dropping the tick.
    tick.skipped = 'overlap';
    tick.finishedAt = Date.now();
    console.warn('[cron] previous tick still in flight, skipping this one');
    appendAudit({
      event_type: 'autopilot_poll_tick',
      payload: { tick_number: state.ticks, skipped: 'overlap' },
    });
    // Do NOT mutate state.lastTick for an overlap — the in-flight tick
    // is the meaningful one. But surface the skip via the audit chain.
    return;
  }

  state.inFlight = true;
  try {
    state.ticks += 1;
    console.log(`[cron] tick #${state.ticks} at ${new Date(tick.startedAt).toISOString()}`);

    // Outer security gate. If the deploy has no allowlisted spaces,
    // there is nothing autopilot could legally submit to — skip work.
    const allowlist = getSubmitAllowlist();
    if (allowlist.length === 0) {
      tick.skipped = 'no_allowlist';
      console.warn('[cron] no SUBMIT_ALLOWLIST configured; tick is a no-op');
      return;
    }

    // Step 1: who is opted in?
    const users = listAutopilotEnabledUsers();
    tick.userCount = users.length;
    if (users.length === 0) {
      tick.skipped = 'no_users';
      return;
    }

    // Step 2: for each user, intersect their followed_spaces with the
    // deploy allowlist, fetch active proposal ids in those spaces,
    // and run the autopilot batch. We do users sequentially so the
    // LLM-extraction load is predictable (no fan-out across users).
    for (const userRow of users) {
      // M6: skip users we've already given up on this process lifetime.
      if (state.permanentlySkipped.has(userRow.user_id)) continue;

      let profile: PolicyProfileT;
      try {
        const raw = JSON.parse(userRow.profile_json);
        const parsed = PolicyProfileSchema.safeParse(raw);
        profile = parsed.success ? parsed.data : normalizeProfile(raw);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        tick.errors.push({ user_id: userRow.user_id, message: `profile_parse_failed: ${message}` });
        continue;
      }
      // Lowercase the follow list to match the canonical form in the
      // allowlist (submit-allowlist.ts normalizes via normalizeSpace).
      // F1 normalizes at save time too, but defense-in-depth: a profile
      // saved before F1 could still have mixed-case entries.
      const followed = (
        Array.isArray(profile.followed_spaces) ? profile.followed_spaces : []
      ).map((s) => s.toLowerCase());
      const scanSpaces = followed.filter((s) => allowlist.includes(s));
      if (scanSpaces.length === 0) continue; // nothing to do for this user

      let activeItems: Array<{ id: string; space: string }>;
      try {
        activeItems = await fetchActiveProposalIdsInSpaces(scanSpaces, 10);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        tick.errors.push({ user_id: userRow.user_id, message: `snapshot_active_fetch_failed: ${message}` });
        continue;
      }
      if (activeItems.length === 0) continue;

      // Minimal SnapshotProposalRaw — runAutopilotBatch will replace
      // body/title/etc with the hub-authoritative copy during its
      // own verifyProposalsByIds pass.
      const proposals: SnapshotProposalRaw[] = activeItems.map((p) => ({
        id: p.id,
        space: { id: p.space },
      }));

      let rules;
      try {
        rules = compileProfileToRules(profile);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        tick.errors.push({ user_id: userRow.user_id, message: `rules_compile_failed: ${message}` });
        continue;
      }

      const result = await runAutopilotBatch({
        userId: userRow.user_id,
        userAddress: userRow.eth_address,
        profile,
        rules,
        policyHash: userRow.hash,
        proposals,
        dryRun: false,
        // Conservative caps for unattended runs — we are not at the
        // editor's elbow to recover from a runaway tick.
        maxVotes: 5,
        extractionTimeoutMs: 20_000,
        liveExtractionBudget: 5,
        acctFactory: () => userWallet(userRow.eth_address as `0x${string}`),
        source: 'cron',
        isSpaceAllowedForSubmit,
        auditVoteSubmission,
      });
      if (result.fatal) {
        tick.errors.push({ user_id: userRow.user_id, message: `${result.fatal.code}: ${result.fatal.message}` });
        // M6: wallet_unavailable cannot self-heal across ticks
        // (MNEMONIC missing or derivation broken). Count consecutive
        // failures per user and stop trying after the threshold.
        // Other fatal codes (snapshot_verification_failed) can be
        // transient and should keep retrying.
        if (result.fatal.code === 'wallet_unavailable') {
          const prev = state.walletFailures.get(userRow.user_id) ?? 0;
          const next = prev + 1;
          state.walletFailures.set(userRow.user_id, next);
          if (next >= WALLET_FAIL_THRESHOLD) {
            state.permanentlySkipped.add(userRow.user_id);
            console.warn(
              `[cron] user ${userRow.user_id} hit wallet_unavailable ${next} times; ` +
                `permanently skipping for this process lifetime`,
            );
            appendAudit({
              event_type: 'autopilot_user_permanently_skipped',
              user_id: userRow.user_id,
              payload: { reason: 'wallet_unavailable', consecutive_failures: next },
            });
          }
        }
        continue;
      }
      // Successful batch resets the wallet-failure counter — a flap
      // does not stack against the user's quota.
      state.walletFailures.delete(userRow.user_id);
      tick.itemsScored += result.plan.filter(
        (p) => p.decision !== null,
      ).length;
      tick.itemsSubmitted += result.submitted_count;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    tick.errors.push({ message });
    console.error('[cron] tick failed:', message);
  } finally {
    tick.finishedAt = Date.now();
    state.lastTick = tick;
    state.inFlight = false;
    // M3: write the audit row on every path. Even an empty / error /
    // skipped tick records itself in the audit chain so the operator
    // can prove the poller ran (and what it found) without trusting
    // wall-clock claims from outside the TEE.
    appendAudit({
      event_type: 'autopilot_poll_tick',
      payload: {
        tick_number: state.ticks,
        user_count: tick.userCount,
        items_scored: tick.itemsScored,
        items_submitted: tick.itemsSubmitted,
        error_count: tick.errors.length,
        ...(tick.skipped ? { skipped: tick.skipped } : {}),
      },
    });
  }
}

/**
 * Install the recurring timer. Called once at server startup. Safe to
 * call when AUTOPILOT_POLL_ENABLED is unset — returns without
 * scheduling anything.
 *
 * Jitter: the first tick fires after a random fraction of intervalMs
 * so a process-restart wave does not pile up at the top of every
 * minute. Subsequent ticks run at the regular interval.
 */
export function startAutopilotPoller(): void {
  // M1: guard against double-start. Either the timeout or interval
  // being non-null means the poller is already scheduled.
  if (state.timeoutHandle || state.intervalHandle) {
    console.warn('[cron] startAutopilotPoller called twice; ignoring');
    return;
  }
  state.enabled = readEnvBool('AUTOPILOT_POLL_ENABLED');
  if (!state.enabled) {
    console.log('[cron] AUTOPILOT_POLL_ENABLED is not "true"; poller stays off');
    return;
  }
  // 60s minimum keeps a misconfigured deploy from cooking the LLM
  // budget; 6h maximum keeps "I forgot to disable it before the demo"
  // from leaving a 24h gap between ticks.
  state.intervalMs = readEnvInt(
    'AUTOPILOT_POLL_INTERVAL_MS',
    15 * 60_000,
    60_000,
    6 * 60 * 60_000,
  );
  const jitterMs = Math.floor(Math.random() * state.intervalMs);
  console.log(
    `[cron] poller enabled, interval=${state.intervalMs}ms, first tick in ${jitterMs}ms`,
  );
  // First tick is jittered, subsequent ticks are fixed-interval. M1:
  // store the timeout handle so stopAutopilotPoller can cancel a
  // pending first tick on SIGTERM.
  state.timeoutHandle = setTimeout(() => {
    state.timeoutHandle = null;
    void runPollTick();
    state.intervalHandle = setInterval(() => {
      void runPollTick();
    }, state.intervalMs);
  }, jitterMs);
}

export function stopAutopilotPoller(): void {
  // M1: cancel both the pending first-tick setTimeout AND the
  // steady-state setInterval. Either may be live depending on whether
  // SIGTERM arrived during the jitter window or after.
  if (state.timeoutHandle) {
    clearTimeout(state.timeoutHandle);
    state.timeoutHandle = null;
  }
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
  }
  console.log('[cron] poller stopped');
}

/**
 * Inspect the poller state. Consumed by C4's status surface; useful
 * for tests and operator debugging too. Returns a snapshot, not a
 * live reference.
 */
export function pollerStatus(): {
  enabled: boolean;
  intervalMs: number;
  ticks: number;
  lastTick: PollTickStatus | null;
  inFlight: boolean;
} {
  return {
    enabled: state.enabled,
    intervalMs: state.intervalMs,
    ticks: state.ticks,
    lastTick: state.lastTick,
    inFlight: state.inFlight,
  };
}

/**
 * Test hook: manually trigger a tick. Bypasses the timer entirely.
 * Used by test:autopilot-cron (C5) and useful for the operator's
 * "Run a tick now" admin button. Not exposed via the HTTP layer
 * unless C4 adds an endpoint for it.
 */
export async function triggerTickForTest(): Promise<PollTickStatus | null> {
  await runPollTick();
  return state.lastTick;
}
