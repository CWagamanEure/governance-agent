/**
 * Minimal onboarding form. Captures the four axis preferences (1-5) and
 * three hard-constraint settings, then POSTs to /profile.
 *
 * Not a 12-question wizard — we collapse the axes into sliders and the hard
 * constraints into a small block. Faster to fill, easier to scan, easier to
 * change. Calibration via past proposals is a separate Phase 2 flow.
 */

import { useState } from 'react';
import { saveProfile } from './api';
import { getStoredToken } from './lib/auth';

const CATEGORIES = [
  'TREASURY_SPEND',
  'PARAMETER_CHANGE',
  'CONTRACT_UPGRADE',
  'OWNERSHIP_TRANSFER',
  'GRANT',
  'COUNCIL_APPOINTMENT',
  'PARTNERSHIP',
  'SOCIAL_SIGNAL',
  'PROTOCOL_RISK_CHANGE',
  'TOKENOMICS',
  'META_GOVERNANCE',
  'OTHER',
] as const;

const AXIS_LABELS: Record<string, [string, string]> = {
  treasury_conservatism:     ['Spend freely',     'Conserve treasury'],
  decentralization_priority: ['Centralization OK', 'Highly decentralized'],
  growth_vs_sustainability:  ['Aggressive growth', 'Sustainability'],
  protocol_risk_tolerance:   ['Risk-tolerant',     'Risk-averse'],
};

export function Onboarding({ onSaved }: { onSaved: (version: number) => void }) {
  const [axes, setAxes] = useState({
    treasury_conservatism: 3,
    decentralization_priority: 4,
    growth_vs_sustainability: 3,
    protocol_risk_tolerance: 3,
  });
  const [maxTreasuryUsdAuto, setMaxTreasuryUsdAuto] = useState<number>(500_000);
  const [manualReviewCategories, setManualReviewCategories] = useState<Set<string>>(
    new Set(['CONTRACT_UPGRADE', 'OWNERSHIP_TRANSFER']),
  );
  const [authorBlocklist, setAuthorBlocklist] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setAxis(name: keyof typeof axes, value: number) {
    setAxes((a) => ({ ...a, [name]: value }));
  }

  function toggleCategory(cat: string) {
    setManualReviewCategories((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  }

  async function submit() {
    const token = getStoredToken();
    if (!token) {
      setError('Not authenticated.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const blocklist = authorBlocklist
        .split(/[,\n\s]+/)
        .map((s) => s.trim())
        .filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
      const profile = {
        ...axes,
        max_treasury_usd_auto: maxTreasuryUsdAuto,
        author_blocklist: blocklist,
        manual_review_categories: Array.from(manualReviewCategories),
      };
      const result = await saveProfile({ token, profile });
      onSaved(result.profile.version);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h3>Set your governance preferences</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: 0, marginBottom: 18 }}>
        Your answers compile into a deterministic rule set the agent will follow on every vote.
        You can change these any time — every save creates a new version.
      </p>

      {Object.entries(axes).map(([name, val]) => {
        const [low, high] = AXIS_LABELS[name];
        return (
          <div key={name} style={{ marginBottom: 14 }}>
            <div className="tiny" style={{ marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {name.replace(/_/g, ' ')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--fg-soft)' }}>{low}</span>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={val}
                onChange={(e) => setAxis(name as keyof typeof axes, Number(e.target.value))}
                style={{ flex: 2 }}
              />
              <span style={{ flex: 1, fontSize: 12, color: 'var(--fg-soft)', textAlign: 'right' }}>{high}</span>
              <span style={{ width: 24, textAlign: 'right', fontFamily: 'var(--mono)' }}>{val}</span>
            </div>
          </div>
        );
      })}

      <div className="section">
        <h4>Hard limits</h4>
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', marginBottom: 4 }} className="tiny">
            Auto-approve treasury spend up to
          </label>
          <input
            type="number"
            value={maxTreasuryUsdAuto}
            min={0}
            step={50000}
            onChange={(e) => setMaxTreasuryUsdAuto(Number(e.target.value))}
            style={{
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
              padding: '6px 10px',
              borderRadius: 4,
              fontFamily: 'var(--mono)',
              fontSize: 13,
              width: 200,
            }}
          />
          <span className="muted tiny" style={{ marginLeft: 8 }}>
            USD — anything larger flags for manual review
          </span>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', marginBottom: 4 }} className="tiny">
            Always require my review for these categories
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {CATEGORIES.map((cat) => {
              const checked = manualReviewCategories.has(cat);
              return (
                <button
                  key={cat}
                  onClick={() => toggleCategory(cat)}
                  style={{
                    background: checked ? 'var(--accent-dim)' : 'var(--bg-elev-2)',
                    color: checked ? 'var(--accent)' : 'var(--fg-dim)',
                    border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                    padding: '4px 10px',
                    fontSize: 12,
                    fontFamily: 'var(--mono)',
                  }}
                >
                  {cat}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', marginBottom: 4 }} className="tiny">
            Blocklist (one address per line, optional)
          </label>
          <textarea
            value={authorBlocklist}
            onChange={(e) => setAuthorBlocklist(e.target.value)}
            placeholder="0x..."
            rows={3}
            style={{
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--border)',
              color: 'var(--fg)',
              padding: 8,
              borderRadius: 4,
              fontFamily: 'var(--mono)',
              fontSize: 12,
              width: '100%',
              resize: 'vertical',
            }}
          />
        </div>
      </div>

      {error && (
        <p style={{ color: 'var(--bad)', fontSize: 13, marginTop: 12 }}>{error}</p>
      )}

      <div style={{ marginTop: 18 }}>
        <button className="primary" onClick={submit} disabled={submitting}>
          {submitting ? 'Saving…' : 'Save preferences'}
        </button>
      </div>
    </div>
  );
}
