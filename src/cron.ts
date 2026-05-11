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

import { appendAudit } from './db.js';

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
    // C2 will iterate users here. For now, the skeleton just logs and
    // records the tick. We deliberately do NOT touch any user state in
    // this commit so we can verify the timer mechanics in isolation.
    console.log(`[cron] tick #${state.ticks} at ${new Date(tick.startedAt).toISOString()}`);
    appendAudit({
      event_type: 'autopilot_poll_tick',
      payload: { tick_number: state.ticks, interval_ms: state.intervalMs },
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
