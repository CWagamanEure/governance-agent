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
 *
 * Skeleton: this module installs the timer and exposes a status getter.
 * The actual per-user work happens in runPollTick (C2), already-voted
 * dedup (C3), and the status surface (C4) consumes lastTickStatus().
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
  errors: Array<{ user_id?: string; message: string }>;
};

const state: {
  intervalHandle: NodeJS.Timeout | null;
  enabled: boolean;
  intervalMs: number;
  ticks: number;
  lastTick: PollTickStatus | null;
  inFlight: boolean;
} = {
  intervalHandle: null,
  enabled: false,
  intervalMs: 0,
  ticks: 0,
  lastTick: null,
  inFlight: false,
};

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
 * One poll iteration. Per-user iteration lives in C2 — this skeleton
 * just records that a tick happened and updates state. Caller is the
 * setInterval timer; do not call directly.
 *
 * Wrapped in try/catch so a single bad tick does not kill the timer.
 * Sets inFlight to true for the duration so an extra-long tick cannot
 * overlap with the next scheduled tick (we just skip the new tick).
 */
async function runPollTick(): Promise<void> {
  if (state.inFlight) {
    console.warn('[cron] previous tick still in flight, skipping this one');
    return;
  }
  state.inFlight = true;
  const tick: PollTickStatus = {
    startedAt: Date.now(),
    finishedAt: null,
    userCount: 0,
    itemsScored: 0,
    itemsSubmitted: 0,
    errors: [],
  };
  try {
    state.ticks += 1;
    console.log(`[cron] tick #${state.ticks} at ${new Date(tick.startedAt).toISOString()}`);

    // Outer security gate. If the deploy has no allowlisted spaces,
    // there is nothing autopilot could legally submit to — skip work.
    const allowlist = getSubmitAllowlist();
    if (allowlist.length === 0) {
      console.warn('[cron] no SUBMIT_ALLOWLIST configured; tick is a no-op');
      appendAudit({
        event_type: 'autopilot_poll_tick',
        payload: { tick_number: state.ticks, skipped: 'no_allowlist' },
      });
      return;
    }

    // Step 1: who is opted in?
    const users = listAutopilotEnabledUsers();
    tick.userCount = users.length;
    if (users.length === 0) {
      appendAudit({
        event_type: 'autopilot_poll_tick',
        payload: { tick_number: state.ticks, user_count: 0 },
      });
      return;
    }

    // Step 2: for each user, intersect their followed_spaces with the
    // deploy allowlist, fetch active proposal ids in those spaces,
    // and run the autopilot batch. We do users sequentially so the
    // LLM-extraction load is predictable (no fan-out across users).
    for (const userRow of users) {
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
        continue;
      }
      tick.itemsScored += result.plan.filter(
        (p) => p.decision !== null,
      ).length;
      tick.itemsSubmitted += result.submitted_count;
    }

    appendAudit({
      event_type: 'autopilot_poll_tick',
      payload: {
        tick_number: state.ticks,
        user_count: tick.userCount,
        items_scored: tick.itemsScored,
        items_submitted: tick.itemsSubmitted,
        error_count: tick.errors.length,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    tick.errors.push({ message });
    console.error('[cron] tick failed:', message);
  } finally {
    tick.finishedAt = Date.now();
    state.lastTick = tick;
    state.inFlight = false;
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
  if (state.intervalHandle) {
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
  // First tick is jittered, subsequent ticks are fixed-interval. We use
  // setTimeout for the first one, then setInterval for the steady state.
  setTimeout(() => {
    void runPollTick();
    state.intervalHandle = setInterval(() => {
      void runPollTick();
    }, state.intervalMs);
  }, jitterMs);
}

export function stopAutopilotPoller(): void {
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
    console.log('[cron] poller stopped');
  }
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
