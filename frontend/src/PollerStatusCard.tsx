/**
 * PollerStatusCard — visible evidence that the autopilot background
 * poller is running. Without this surface the cron is invisible
 * between user interactions; with it the demo can show "the system
 * just polled 4 minutes ago and submitted N votes on its own."
 *
 * Polls /poller/status every 30s. No auth needed — the status is
 * operational metadata, not per-user data.
 */

import { useEffect, useState } from 'react';
import { getPollerStatus, type PollerStatus } from './api';

const POLL_INTERVAL_MS = 30_000;

function relTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 0) return 'just now';
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatInterval(ms: number): string {
  if (ms <= 0) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

export function PollerStatusCard() {
  const [status, setStatus] = useState<PollerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await getPollerStatus();
        if (!cancelled) {
          setStatus(r);
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    }
    load();
    const handle = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  if (error) {
    return (
      <div className="card poller-card">
        <div className="poller-head">
          <h4>Background poller</h4>
        </div>
        <p className="editor-helper-empty">Could not reach /poller/status: {error}</p>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="card poller-card">
        <div className="poller-head">
          <h4>Background poller</h4>
        </div>
        <p className="editor-helper-empty">Loading…</p>
      </div>
    );
  }

  if (!status.enabled) {
    return (
      <div className="card poller-card poller-off">
        <div className="poller-head">
          <h4>Background poller</h4>
          <span className="poller-pill poller-pill-off">off</span>
        </div>
        <p className="editor-helper">
          The autopilot cron is disabled in this deploy. Manual Preview / Run
          autopilot batch still works from the card above.
        </p>
      </div>
    );
  }

  const last = status.lastTick;
  return (
    <div className="card poller-card poller-on">
      <div className="poller-head">
        <h4>Background poller</h4>
        <span className={`poller-pill ${status.inFlight ? 'poller-pill-busy' : 'poller-pill-on'}`}>
          {status.inFlight ? 'tick in progress' : 'on'}
        </span>
      </div>
      <p className="editor-helper">
        Polls every {formatInterval(status.intervalMs)}. {status.ticks} tick
        {status.ticks === 1 ? '' : 's'} since startup.
      </p>
      {last ? (
        <ul className="poller-stats">
          <li>
            <span>Last tick</span>
            <code>{relTime(last.startedAt)}</code>
          </li>
          <li>
            <span>Users scanned</span>
            <code>{last.userCount}</code>
          </li>
          <li>
            <span>Proposals scored</span>
            <code>{last.itemsScored}</code>
          </li>
          <li>
            <span>Votes submitted</span>
            <code>{last.itemsSubmitted}</code>
          </li>
          {last.errors.length > 0 && (
            <li className="poller-stats-error">
              <span>Errors</span>
              <code title={last.errors.map((e) => e.message).join('\n')}>
                {last.errors.length}
              </code>
            </li>
          )}
        </ul>
      ) : (
        <p className="editor-helper-empty">
          No tick yet — first one fires within the interval window.
        </p>
      )}
    </div>
  );
}
