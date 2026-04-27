/**
 * Multi-step onboarding flow.
 *
 *   1. Values     — user writes 3-5 sentences in plain language
 *   2. Calibration — vote on real past proposals; mark personal-not-policy
 *   3. Review     — LLM-compiled PolicyProfile shown for accept / re-do
 *
 * The deterministic policy engine still owns voting decisions. The LLM only
 * shapes the policy at setup time; user reviews and approves before save.
 */

import { useState } from 'react';
import { compileProfile, saveProfile } from './api';
import { getStoredToken } from './lib/auth';
import { CALIBRATION, type CalibrationProposal } from './data/calibration';

type Step = 'values' | 'calibration' | 'review';

type Choice = 'FOR' | 'AGAINST' | 'ABSTAIN';

type CalEntry = {
  proposal: CalibrationProposal;
  choice: Choice | null;
  reason: string;
  personal_not_policy: boolean;
};

const VALUE_EXAMPLES = [
  'I care about funding upstream Ethereum infrastructure, even when it benefits other chains.',
  "I'm skeptical of recurring delegate compensation programs without clear KPIs.",
  'I want this DAO to feel community-run, not corporate.',
  'I prefer reversible decisions over irreversible ones.',
  "I'd rather see milestone-gated grants than lump-sum disbursements.",
];

export function Onboarding({ onSaved }: { onSaved: (version: number) => void }) {
  const [step, setStep] = useState<Step>('values');
  const [statedValues, setStatedValues] = useState('');
  const [calibration, setCalibration] = useState<CalEntry[]>(
    CALIBRATION.map((p) => ({
      proposal: p,
      choice: null,
      reason: '',
      personal_not_policy: false,
    })),
  );
  const [compiled, setCompiled] = useState<any | null>(null);
  const [compileSource, setCompileSource] = useState<'llm' | 'fallback'>('fallback');
  const [compileWarnings, setCompileWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="onboarding">
      <Stepper step={step} />
      {error && <div className="modal-error" style={{ marginBottom: 12 }}>{error}</div>}

      {step === 'values' && (
        <ValuesStep
          value={statedValues}
          onChange={setStatedValues}
          onContinue={() => {
            setError(null);
            setStep('calibration');
          }}
        />
      )}

      {step === 'calibration' && (
        <CalibrationStep
          entries={calibration}
          onUpdate={setCalibration}
          onBack={() => setStep('values')}
          onContinue={async () => {
            setError(null);
            setBusy(true);
            try {
              const token = getStoredToken();
              if (!token) throw new Error('not authenticated');
              const r = await compileProfile({
                token,
                stated_values_text: statedValues,
                calibration: calibration
                  .filter((e) => e.choice !== null)
                  .map((e) => ({
                    proposal_id: e.proposal.id,
                    proposal_title: e.proposal.title,
                    proposal_category: e.proposal.category,
                    proposal_summary: e.proposal.summary,
                    user_choice: e.choice as Choice,
                    reason: e.reason || undefined,
                    personal_not_policy: e.personal_not_policy,
                  })),
              });
              setCompiled(r.profile);
              setCompileSource(r.source);
              setCompileWarnings(r.warnings ?? []);
              setStep('review');
            } catch (e: any) {
              setError(e?.message ?? String(e));
            } finally {
              setBusy(false);
            }
          }}
          submitting={busy}
        />
      )}

      {step === 'review' && compiled && (
        <ReviewStep
          profile={compiled}
          source={compileSource}
          warnings={compileWarnings}
          onBackToValues={() => setStep('values')}
          onBackToCalibration={() => setStep('calibration')}
          onAccept={async () => {
            setError(null);
            setBusy(true);
            try {
              const token = getStoredToken();
              if (!token) throw new Error('not authenticated');
              const r = await saveProfile({ token, profile: compiled });
              onSaved(r.profile.version);
            } catch (e: any) {
              setError(e?.message ?? String(e));
            } finally {
              setBusy(false);
            }
          }}
          submitting={busy}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

const STEP_LABELS: { id: Step; label: string }[] = [
  { id: 'values',      label: 'Values' },
  { id: 'calibration', label: 'Calibration' },
  { id: 'review',      label: 'Review' },
];

function Stepper({ step }: { step: Step }) {
  const idx = STEP_LABELS.findIndex((s) => s.id === step);
  return (
    <div className="stepper">
      {STEP_LABELS.map((s, i) => (
        <div
          key={s.id}
          className={`stepper-step ${i === idx ? 'active' : ''} ${i < idx ? 'done' : ''}`}
        >
          <span className="stepper-num">{i + 1}</span>
          <span className="stepper-label">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Values
// ---------------------------------------------------------------------------

function ValuesStep({
  value,
  onChange,
  onContinue,
}: {
  value: string;
  onChange: (v: string) => void;
  onContinue: () => void;
}) {
  const wordCount = value.trim().length === 0 ? 0 : value.trim().split(/\s+/).length;
  const okToContinue = value.trim().length >= 30;

  return (
    <div className="card onboarding-card">
      <h3>What matters to you in DAO governance?</h3>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 6 }}>
        In your own words, write a few sentences about what you care about. Don't worry about
        formatting — the agent uses this to interpret each proposal in your terms. You can edit later.
      </p>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={6}
        placeholder="e.g. I care about funding public goods, especially upstream Ethereum work. I'm skeptical of recurring delegate compensation. I want this DAO to feel community-run, not corporate."
        className="onboarding-textarea"
      />

      <div className="onboarding-meta">
        <span className="muted tiny">{wordCount} words · ~30 word minimum</span>
      </div>

      <div className="onboarding-examples">
        <div className="muted tiny" style={{ marginBottom: 6 }}>
          Examples to insert (click to add):
        </div>
        {VALUE_EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            className="example-chip"
            onClick={() => {
              const sep = value && !value.trimEnd().match(/[.!?]$/) ? '. ' : value ? ' ' : '';
              onChange(value + sep + ex);
            }}
          >
            + {ex}
          </button>
        ))}
      </div>

      <div className="onboarding-actions">
        <button className="btn primary" disabled={!okToContinue} onClick={onContinue}>
          Continue to calibration →
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Calibration
// ---------------------------------------------------------------------------

function CalibrationStep({
  entries,
  onUpdate,
  onBack,
  onContinue,
  submitting,
}: {
  entries: CalEntry[];
  onUpdate: (next: CalEntry[]) => void;
  onBack: () => void;
  onContinue: () => void;
  submitting: boolean;
}) {
  const answered = entries.filter((e) => e.choice !== null).length;
  const okToContinue = answered >= 3;

  function update(i: number, patch: Partial<CalEntry>) {
    const next = [...entries];
    next[i] = { ...next[i], ...patch };
    onUpdate(next);
  }

  return (
    <div className="card onboarding-card">
      <h3>How would you have voted?</h3>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 6, marginBottom: 16 }}>
        Real past proposals. For each, pick how you would have voted. If a vote was personal —
        about the people involved rather than the policy — toggle "personal" so we don't
        generalize from it. Skip any you'd rather not answer.
      </p>

      <div className="calibration-stack">
        {entries.map((e, i) => (
          <CalibrationCard key={e.proposal.id} entry={e} onChange={(p) => update(i, p)} />
        ))}
      </div>

      <div className="onboarding-meta" style={{ marginTop: 16 }}>
        <span className="muted tiny">
          {answered}/{entries.length} answered · need at least 3
        </span>
      </div>

      <div className="onboarding-actions">
        <button className="btn" onClick={onBack} disabled={submitting}>
          ← Back
        </button>
        <button
          className="btn primary"
          disabled={!okToContinue || submitting}
          onClick={onContinue}
        >
          {submitting ? 'Compiling…' : 'Compile my policy →'}
        </button>
      </div>
    </div>
  );
}

function CalibrationCard({
  entry,
  onChange,
}: {
  entry: CalEntry;
  onChange: (patch: Partial<CalEntry>) => void;
}) {
  return (
    <div className="cal-card">
      <div className="cal-head">
        <span className="cal-cat">{entry.proposal.category.replace('_', ' ')}</span>
      </div>
      <div className="cal-title">{entry.proposal.title}</div>
      <div className="cal-summary">{entry.proposal.summary}</div>
      <div className="cal-tradeoff">
        <div><span className="muted tiny">PRO</span> {entry.proposal.pro}</div>
        <div><span className="muted tiny">CON</span> {entry.proposal.con}</div>
      </div>

      <div className="cal-choices">
        {(['FOR', 'AGAINST', 'ABSTAIN'] as Choice[]).map((c) => (
          <button
            key={c}
            type="button"
            className={`cal-choice cal-choice-${c} ${entry.choice === c ? 'selected' : ''}`}
            onClick={() => onChange({ choice: entry.choice === c ? null : c })}
          >
            {c}
          </button>
        ))}
      </div>

      {entry.choice && (
        <div className="cal-extras">
          <input
            type="text"
            className="cal-reason"
            placeholder="Optional: why? (one line)"
            value={entry.reason}
            onChange={(e) => onChange({ reason: e.target.value })}
          />
          <label className="cal-personal">
            <input
              type="checkbox"
              checked={entry.personal_not_policy}
              onChange={(e) => onChange({ personal_not_policy: e.target.checked })}
            />
            <span>This was personal, not policy — don't generalize from it</span>
          </label>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Review
// ---------------------------------------------------------------------------

const AXIS_LABELS: Record<string, string> = {
  treasury_conservatism: 'Treasury conservatism',
  decentralization_priority: 'Decentralization priority',
  growth_vs_sustainability: 'Sustainability bias',
  protocol_risk_tolerance: 'Risk-aversion',
};

function ReviewStep({
  profile,
  source,
  warnings,
  onBackToValues,
  onBackToCalibration,
  onAccept,
  submitting,
}: {
  profile: any;
  source: 'llm' | 'fallback';
  warnings: string[];
  onBackToValues: () => void;
  onBackToCalibration: () => void;
  onAccept: () => void;
  submitting: boolean;
}) {
  return (
    <div className="card onboarding-card">
      <h3>Here's the policy compiled from your input</h3>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 6, marginBottom: 16 }}>
        {source === 'llm'
          ? 'Compiled by the LLM running in the enclave. Review and accept, or go back to revise.'
          : 'Compiled by the heuristic fallback (LLM gateway unavailable). Lower fidelity than the LLM compile, but valid. Review and accept, or go back to revise.'}
      </p>

      {warnings.length > 0 && (
        <div className="modal-error" style={{ marginBottom: 14 }}>
          {warnings.join(' · ')}
        </div>
      )}

      <div className="review-section">
        <div className="dft-label">Stated values</div>
        {(profile.stated_values ?? []).length === 0 ? (
          <p className="muted tiny">(none extracted)</p>
        ) : (
          <ul className="review-values">
            {(profile.stated_values as string[]).map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="review-section">
        <div className="dft-label">Inferred axes</div>
        <div className="axes" style={{ marginTop: 4 }}>
          {Object.entries(AXIS_LABELS).map(([k, label]) => (
            <div key={k} className="axis-row">
              <span className="axis-label">{label}</span>
              <div className="axis-bar">
                {[1, 2, 3, 4, 5].map((i) => (
                  <span
                    key={i}
                    className={`axis-pip ${i <= Number(profile[k]) ? 'on' : ''}`}
                  />
                ))}
              </div>
              <span className="axis-num">{profile[k]}/5</span>
            </div>
          ))}
        </div>
      </div>

      <div className="review-section">
        <div className="dft-label">Hard limits</div>
        <div className="profile-meta" style={{ marginTop: 6 }}>
          <div>
            <span className="muted tiny">Auto-approve treasury cap</span>
            <div className="profile-meta-val">
              {profile.max_treasury_usd_auto == null
                ? '—'
                : `$${Number(profile.max_treasury_usd_auto).toLocaleString()}`}
            </div>
          </div>
          <div>
            <span className="muted tiny">Always require my review</span>
            <div className="profile-meta-val">
              {(profile.manual_review_categories ?? []).length} categories
              {(profile.manual_review_categories ?? []).length > 0 && (
                <div className="tiny muted" style={{ marginTop: 2, fontFamily: 'var(--mono)' }}>
                  {(profile.manual_review_categories as string[]).join(' · ')}
                </div>
              )}
            </div>
          </div>
          <div>
            <span className="muted tiny">Author blocklist</span>
            <div className="profile-meta-val">
              {(profile.author_blocklist ?? []).length} addresses
            </div>
          </div>
        </div>
      </div>

      <div className="onboarding-actions">
        <button className="btn" onClick={onBackToValues} disabled={submitting}>
          ← Edit values
        </button>
        <button className="btn" onClick={onBackToCalibration} disabled={submitting}>
          Redo calibration
        </button>
        <button className="btn primary" onClick={onAccept} disabled={submitting}>
          {submitting ? 'Saving…' : 'Looks right — save policy'}
        </button>
      </div>
    </div>
  );
}
