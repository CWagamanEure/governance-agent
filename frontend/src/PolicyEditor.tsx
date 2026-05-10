/**
 * Policy rules editor with live "what would have changed" diff feedback.
 *
 * Architecture:
 *   - User edits the saved policy directly (dropdowns, toggles, inputs).
 *   - Every edit triggers a debounced POST /policy/preview against the
 *     cached corpus of past proposals; the response is diffed against the
 *     baseline (saved profile) and the differences are surfaced inline.
 *   - The compile step is the onboarding shortcut. The editor is the source
 *     of truth for tuning.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getCachedProposals,
  previewPolicy,
  saveProfile,
  type CachedProposalRow,
  type Decision,
  type PolicyPreviewDecision,
  type StoredProfile,
} from './api';

// Mirrors policy.ts. Keep in sync — out-of-sync values just won't render
// editor controls, they don't break the saved profile shape.
const CATEGORIES = [
  'TREASURY_SPEND', 'PARAMETER_CHANGE', 'CONTRACT_UPGRADE', 'OWNERSHIP_TRANSFER',
  'GRANT', 'COUNCIL_APPOINTMENT', 'PARTNERSHIP', 'SOCIAL_SIGNAL',
  'PROTOCOL_RISK_CHANGE', 'TOKENOMICS', 'META_GOVERNANCE', 'OTHER',
] as const;
type Category = typeof CATEGORIES[number];

const ACTIONS: Decision[] = ['FOR', 'AGAINST', 'ABSTAIN', 'MANUAL_REVIEW'];

const FLAGS = [
  'LOW_CONFIDENCE_EXTRACTION',
  'UNKNOWN_TREASURY_AMOUNT',
  'LARGE_TREASURY_SPEND',
  'SINGLE_RECIPIENT_TREASURY',
  'CONTRACT_UPGRADE',
  'OWNERSHIP_OR_PERMISSION_CHANGE',
  'CONSTITUTIONAL_CHANGE',
  'UNCLEAR_BENEFICIARIES',
  'UNKNOWN_RECIPIENT',
  'NO_MILESTONES',
  'DELEGATE_SIGNAL_UNAVAILABLE',
] as const;
type Flag = typeof FLAGS[number];

type Profile = any; // schema-validated server-side

/**
 * Parse a USD-shaped input value. Accepts:
 *   ""              → null  (means "no cap" / "no threshold")
 *   "500000"        → 500000
 *   "$500,000"      → 500000  (strips $ and ,)
 *   "  500k "       → 500000  (k/m suffix)
 *   "0.5m"          → 500000
 * Rejects NaN, negatives, and non-finite values by returning the previous
 * value (so a paste of garbage doesn't silently disable a hard floor).
 */
function parseUsdInput(raw: string, previous: number | null): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const cleaned = trimmed.replace(/[$,\s]/g, '').toLowerCase();
  let multiplier = 1;
  let body = cleaned;
  if (cleaned.endsWith('k')) {
    multiplier = 1_000;
    body = cleaned.slice(0, -1);
  } else if (cleaned.endsWith('m')) {
    multiplier = 1_000_000;
    body = cleaned.slice(0, -1);
  }
  const parsed = Number(body) * multiplier;
  if (!Number.isFinite(parsed) || parsed < 0) return previous;
  return parsed;
}

function draftStorageKey(profileId: string): string {
  return `gov-agent:editor-draft:${profileId}`;
}

function readPersistedDraft(profileId: string, baseline: unknown): Profile | null {
  try {
    const raw = localStorage.getItem(draftStorageKey(profileId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Only treat as restorable if it differs from the saved baseline; otherwise
    // it's not a meaningful draft and we don't need the "restored edits" UI.
    if (deepEqual(parsed, baseline)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePersistedDraft(profileId: string, draft: Profile) {
  try {
    localStorage.setItem(draftStorageKey(profileId), JSON.stringify(draft));
  } catch {
    // Storage may be full / blocked. Persistence is a nice-to-have; the
    // editor still works without it.
  }
}

function clearPersistedDraft(profileId: string) {
  try {
    localStorage.removeItem(draftStorageKey(profileId));
  } catch {
    // ignore
  }
}

export function PolicyEditor({
  token,
  baseProfile,
  onSaved,
  onCancel,
}: {
  token: string;
  baseProfile: NonNullable<StoredProfile['profile']>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  // If the previous session left a draft in localStorage, restore it so a
  // mid-demo refresh (or accidental nav-away) doesn't wipe the four ACT-2
  // unchecks. We track restoration so we can surface a small banner.
  const [draft, setDraft] = useState<Profile>(() => {
    const restored = readPersistedDraft(baseProfile.id, baseProfile.profile_json);
    return restored ?? deepClone(baseProfile.profile_json);
  });
  const [restoredFromStorage, setRestoredFromStorage] = useState(() =>
    readPersistedDraft(baseProfile.id, baseProfile.profile_json) !== null,
  );
  const [cached, setCached] = useState<CachedProposalRow[] | null>(null);
  const [baselineDecisions, setBaselineDecisions] = useState<PolicyPreviewDecision[] | null>(null);
  const [draftDecisions, setDraftDecisions] = useState<PolicyPreviewDecision[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  // Initial load — corpus + baseline (saved profile's decisions).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cachedRes, baselineRes] = await Promise.all([
          getCachedProposals({ token, limit: 50 }),
          previewPolicy({ token, profile: baseProfile.profile_json }),
        ]);
        if (cancelled) return;
        setCached(cachedRes.items);
        setBaselineDecisions(baselineRes.decisions);
        setDraftDecisions(baselineRes.decisions); // initial draft = baseline
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [token, baseProfile.profile_json]);

  // Debounced re-preview on edit.
  useEffect(() => {
    if (!cached || !baselineDecisions) return;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      setPreviewing(true);
      try {
        const r = await previewPolicy({ token, profile: draft });
        setDraftDecisions(r.decisions);
        setError(null);
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        // On a 401 the displayed diff is stale — every keystroke is silently
        // failing. Clear draft results so the panel doesn't show a confidently-
        // wrong number while the user wonders why toggles do nothing.
        if (/\b401\b/.test(msg)) {
          setDraftDecisions(null);
          setError('session expired — sign in again to keep editing');
        } else {
          setError(msg);
        }
      } finally {
        setPreviewing(false);
      }
    }, 350);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [draft, token, cached, baselineDecisions]);

  // Diff between baseline and draft, keyed by proposal_id.
  const diffs = useMemo(() => {
    if (!baselineDecisions || !draftDecisions) return [];
    const baseMap = new Map(baselineDecisions.map((d) => [d.proposal_id, d]));
    // Look up each proposal's source corpus so the diff list can label
    // calibration vs. real Arbitrum entries — the calibration-vs-real
    // comparison is the most important moment in the demo.
    const corpusMap = new Map(
      (cached ?? []).map((c) => [
        c.proposal.id,
        c.proposal.space === 'calibration.gov-agent' ? 'calibration' : 'real',
      ] as const),
    );
    const out: { id: string; title: string | null; from: Decision; to: Decision; corpus: 'calibration' | 'real'; ruleIds: string[] }[] = [];
    for (const d of draftDecisions) {
      const b = baseMap.get(d.proposal_id);
      if (!b) continue;
      if (b.decision !== d.decision) {
        out.push({
          id: d.proposal_id,
          title: d.proposal_title,
          from: b.decision,
          to: d.decision,
          corpus: corpusMap.get(d.proposal_id) ?? 'real',
          ruleIds: d.triggered_rule_ids ?? [],
        });
      }
    }
    // Calibration-corpus flips first so the "find obvious patterns" arc is
    // visible in the panel itself; within each corpus, autovote outcomes
    // (FOR/AGAINST/ABSTAIN) before MANUAL_REVIEW so the autovote story leads.
    const decisionWeight = (d: Decision) => (d === 'MANUAL_REVIEW' ? 1 : 0);
    out.sort((a, b) => {
      if (a.corpus !== b.corpus) return a.corpus === 'calibration' ? -1 : 1;
      return decisionWeight(a.to) - decisionWeight(b.to);
    });
    return out;
  }, [baselineDecisions, draftDecisions, cached]);

  const isDirty = useMemo(() => !deepEqual(draft, baseProfile.profile_json), [draft, baseProfile.profile_json]);

  // Persist the draft to localStorage on every change so a mid-demo Cmd-R
  // doesn't lose the four-step peel setup. Keyed by profile id: when a new
  // version saves and baseProfile.id changes, the old draft entry is
  // orphaned (cleared on save below) and a fresh editor session starts clean.
  useEffect(() => {
    if (isDirty) {
      writePersistedDraft(baseProfile.id, draft);
    } else {
      clearPersistedDraft(baseProfile.id);
    }
  }, [draft, isDirty, baseProfile.id]);

  // Browser-level guard: if the user closes the tab or navigates away with
  // unsaved edits, prompt before discarding. The actual message is
  // browser-controlled in modern browsers; preventDefault + returnValue is
  // the contract.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await saveProfile({ token, profile: draft });
      // Persisted draft no longer applies — saving creates a new profile id.
      // Clear both the old key and any future-keyed leftovers.
      clearPersistedDraft(baseProfile.id);
      onSaved();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (isDirty) {
      const ok = window.confirm(
        'Discard your unsaved policy edits? They will not be saved.',
      );
      if (!ok) return;
    }
    clearPersistedDraft(baseProfile.id);
    onCancel();
  }

  function handleDiscardRestored() {
    setDraft(deepClone(baseProfile.profile_json));
    clearPersistedDraft(baseProfile.id);
    setRestoredFromStorage(false);
  }

  return (
    <div className="policy-editor">
      <div className="editor-head">
        <div>
          <h3 style={{ margin: 0 }}>Edit policy rules</h3>
          <p className="muted tiny" style={{ marginTop: 4 }}>
            Changes show what would have happened to your last {cached?.length ?? '…'} proposals — live.
          </p>
        </div>
        <div className="editor-actions">
          <button className="btn" onClick={handleCancel} disabled={saving}>Cancel</button>
          <button
            className="btn primary"
            onClick={handleSave}
            disabled={!isDirty || saving}
            title={!isDirty ? 'No changes to save' : 'Save as new version'}
          >
            {saving ? 'Saving…' : 'Save policy'}
          </button>
        </div>
      </div>

      {restoredFromStorage && (
        <div className="editor-restored-banner" role="status">
          <span>
            Restored unsaved edits from your last session.
          </span>
          <button className="link-btn" onClick={handleDiscardRestored}>
            Discard
          </button>
        </div>
      )}

      {error && <div className="modal-error" style={{ marginTop: 12 }}>{error}</div>}

      <div className="editor-grid">
        <div className="editor-form">
          <DefaultActionField draft={draft} setDraft={setDraft} />
          <LargeTreasuryField draft={draft} setDraft={setDraft} />
          <CategoryDefaultsField draft={draft} setDraft={setDraft} />
          <ManualReviewCategoriesField draft={draft} setDraft={setDraft} />
          <ManualReviewFlagsField draft={draft} setDraft={setDraft} />
          <HardRulesField draft={draft} setDraft={setDraft} />
          <ReadOnlySummary draft={draft} />
        </div>

        <DiffPanel
          previewing={previewing}
          baselineDecisions={baselineDecisions}
          draftDecisions={draftDecisions}
          diffs={diffs}
          cached={cached}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

function DefaultActionField({ draft, setDraft }: { draft: Profile; setDraft: (p: Profile) => void }) {
  return (
    <section className="editor-section">
      <h4>Default action</h4>
      <p className="muted tiny">What happens when no other rule matches.</p>
      <select
        value={draft.default_action ?? 'MANUAL_REVIEW'}
        onChange={(e) => setDraft({ ...draft, default_action: e.target.value })}
        className="editor-select"
      >
        {ACTIONS.map((a) => (
          <option key={a} value={a}>{a}</option>
        ))}
      </select>
    </section>
  );
}

function LargeTreasuryField({ draft, setDraft }: { draft: Profile; setDraft: (p: Profile) => void }) {
  return (
    <section className="editor-section">
      <h4>Large treasury review threshold</h4>
      <p className="muted tiny">
        Treasury spends above this dollar amount go to MANUAL_REVIEW regardless of category default.
      </p>
      <input
        type="text"
        inputMode="decimal"
        value={draft.large_treasury_usd ?? ''}
        onChange={(e) => {
          const v = parseUsdInput(e.target.value, draft.large_treasury_usd ?? null);
          setDraft({ ...draft, large_treasury_usd: v });
        }}
        placeholder="(no threshold)"
        className="editor-input"
      />
      {typeof draft.large_treasury_usd === 'number' && (
        <p className="muted tiny" style={{ marginTop: 4 }}>
          ${draft.large_treasury_usd.toLocaleString()}
        </p>
      )}
    </section>
  );
}

function CategoryDefaultsField({ draft, setDraft }: { draft: Profile; setDraft: (p: Profile) => void }) {
  const defaults: any[] = draft.category_defaults ?? [];
  function update(i: number, patch: any) {
    const next = defaults.map((d, j) => (j === i ? { ...d, ...patch } : d));
    setDraft({ ...draft, category_defaults: next });
  }
  function remove(i: number) {
    setDraft({ ...draft, category_defaults: defaults.filter((_, j) => j !== i) });
  }
  function add() {
    // Default to action=FOR so the dollar-cap and milestones/reporting controls
    // render immediately. ACT 2 of the demo wants the operator to add a single
    // GRANT FOR rule on stage; defaulting to MANUAL_REVIEW used to hide the
    // condition fields and force a follow-up dropdown change.
    setDraft({
      ...draft,
      category_defaults: [
        ...defaults,
        {
          category: 'GRANT',
          action: 'FOR',
          max_treasury_usd: 500_000,
          require_milestones: true,
          require_reporting: true,
          proposer_types: [],
          reason: 'manually added',
        },
      ],
    });
  }
  return (
    <section className="editor-section">
      <div className="editor-section-head">
        <h4>Category defaults (autovote rules)</h4>
        <button className="btn small" onClick={add}>+ Add rule</button>
      </div>
      <p className="muted tiny">
        Per-category default action. Use FOR/AGAINST for autovoting; MANUAL_REVIEW to flag every proposal in this category.
      </p>
      {defaults.length === 0 && (
        <p className="muted tiny" style={{ marginTop: 8 }}>
          No category defaults. Unmatched proposals fall through to default action.
        </p>
      )}
      {defaults.map((d, i) => (
        <div key={i} className="editor-rule">
          <div className="editor-rule-row">
            <select
              value={d.category}
              onChange={(e) => update(i, { category: e.target.value })}
              className="editor-select"
            >
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="editor-rule-arrow">→</span>
            <select
              value={d.action}
              onChange={(e) => update(i, { action: e.target.value })}
              className="editor-select"
            >
              {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <button className="btn small" onClick={() => remove(i)} title="Remove rule">×</button>
          </div>
          {(d.action === 'FOR' || d.action === 'AGAINST') && (
            <div className="editor-rule-conditions">
              <label className="editor-inline">
                under $
                <input
                  type="text"
                  inputMode="decimal"
                  value={d.max_treasury_usd ?? ''}
                  onChange={(e) => {
                    const v = parseUsdInput(e.target.value, d.max_treasury_usd ?? null);
                    update(i, { max_treasury_usd: v });
                  }}
                  placeholder="any"
                  className="editor-input small"
                />
                {typeof d.max_treasury_usd === 'number' && (
                  <span className="muted tiny" style={{ marginLeft: 4 }}>
                    ${d.max_treasury_usd.toLocaleString()}
                  </span>
                )}
              </label>
              <label className="editor-inline">
                <input
                  type="checkbox"
                  checked={!!d.require_milestones}
                  onChange={(e) => update(i, { require_milestones: e.target.checked })}
                /> milestones
              </label>
              <label className="editor-inline">
                <input
                  type="checkbox"
                  checked={!!d.require_reporting}
                  onChange={(e) => update(i, { require_reporting: e.target.checked })}
                /> reporting
              </label>
            </div>
          )}
          {d.reason && <div className="editor-rule-reason muted tiny">{d.reason}</div>}
        </div>
      ))}
    </section>
  );
}

function ManualReviewCategoriesField({ draft, setDraft }: { draft: Profile; setDraft: (p: Profile) => void }) {
  const set = new Set<string>(draft.manual_review_categories ?? []);
  function toggle(c: Category) {
    const next = new Set(set);
    if (next.has(c)) next.delete(c); else next.add(c);
    setDraft({ ...draft, manual_review_categories: [...next] });
  }
  return (
    <section className="editor-section">
      <h4>Always require my review</h4>
      <p className="muted tiny">
        Any proposal in these categories goes to MANUAL_REVIEW regardless of other rules.
      </p>
      <div className="editor-checkbox-grid">
        {CATEGORIES.map((c) => (
          <label key={c} className="editor-checkbox">
            <input type="checkbox" checked={set.has(c)} onChange={() => toggle(c)} />
            <span>{c}</span>
          </label>
        ))}
      </div>
    </section>
  );
}

function ManualReviewFlagsField({ draft, setDraft }: { draft: Profile; setDraft: (p: Profile) => void }) {
  const set = new Set<string>(draft.manual_review_flags ?? []);
  function toggle(f: Flag) {
    const next = new Set(set);
    if (next.has(f)) next.delete(f); else next.add(f);
    setDraft({ ...draft, manual_review_flags: [...next] });
  }
  return (
    <section className="editor-section">
      <h4>Manual review flags</h4>
      <p className="muted tiny">
        Situational triggers — promote any matching proposal to MANUAL_REVIEW.
      </p>
      <div className="editor-checkbox-grid">
        {FLAGS.map((f) => (
          <label key={f} className="editor-checkbox">
            <input type="checkbox" checked={set.has(f)} onChange={() => toggle(f)} />
            <span>{f}</span>
          </label>
        ))}
      </div>
    </section>
  );
}

function HardRulesField({ draft, setDraft }: { draft: Profile; setDraft: (p: Profile) => void }) {
  const hard = draft.hard_rules ?? {};
  function update(patch: any) {
    setDraft({ ...draft, hard_rules: { ...hard, ...patch } });
  }
  return (
    <section className="editor-section">
      <h4>Hard limits</h4>
      <p className="muted tiny">Global guardrails — applied before category defaults.</p>
      <label className="editor-inline">
        Single-recipient cap: $
        <input
          type="text"
          inputMode="decimal"
          value={hard.max_single_recipient_treasury_usd ?? ''}
          onChange={(e) => {
            const v = parseUsdInput(e.target.value, hard.max_single_recipient_treasury_usd ?? null);
            update({ max_single_recipient_treasury_usd: v });
          }}
          placeholder="(no cap)"
          className="editor-input small"
        />
        {typeof hard.max_single_recipient_treasury_usd === 'number' && (
          <span className="muted tiny" style={{ marginLeft: 4 }}>
            ${hard.max_single_recipient_treasury_usd.toLocaleString()}
          </span>
        )}
      </label>
      <label className="editor-inline" style={{ display: 'block', marginTop: 8 }}>
        <input
          type="checkbox"
          checked={!!hard.vote_against_emission_increases}
          onChange={(e) => update({ vote_against_emission_increases: e.target.checked })}
        /> Vote AGAINST emission increases
      </label>
      <label className="editor-inline" style={{ display: 'block', marginTop: 4 }}>
        <input
          type="checkbox"
          checked={!!hard.require_milestones_for_treasury}
          onChange={(e) => update({ require_milestones_for_treasury: e.target.checked })}
        /> Require milestones on treasury spends
      </label>
    </section>
  );
}

function ReadOnlySummary({ draft }: { draft: Profile }) {
  return (
    <section className="editor-section editor-readonly">
      <h4>Other settings</h4>
      <p className="muted tiny">
        Stated values, delegation rules, and author blocklist are managed separately. Edit them by redoing onboarding.
      </p>
      <div className="muted tiny" style={{ marginTop: 8 }}>
        <div>Stated values: {(draft.stated_values ?? []).length}</div>
        <div>Delegation rules: {(draft.delegation_rules ?? []).length}</div>
        <div>Author blocklist: {(draft.author_blocklist ?? []).length} addresses</div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Diff panel — the centerpiece feature
// ---------------------------------------------------------------------------

function decisionCounts(decisions: PolicyPreviewDecision[] | null): Record<Decision, number> {
  const counts: Record<Decision, number> = { FOR: 0, AGAINST: 0, ABSTAIN: 0, MANUAL_REVIEW: 0 };
  if (!decisions) return counts;
  for (const d of decisions) counts[d.decision]++;
  return counts;
}

function DiffPanel({
  previewing,
  baselineDecisions,
  draftDecisions,
  diffs,
  cached,
}: {
  previewing: boolean;
  baselineDecisions: PolicyPreviewDecision[] | null;
  draftDecisions: PolicyPreviewDecision[] | null;
  diffs: { id: string; title: string | null; from: Decision; to: Decision; corpus: 'calibration' | 'real'; ruleIds: string[] }[];
  cached: CachedProposalRow[] | null;
}) {
  const baseCounts = decisionCounts(baselineDecisions);
  const draftCounts = decisionCounts(draftDecisions);

  return (
    <div className="diff-panel">
      <div className="diff-head">
        <h4 style={{ margin: 0 }}>What would have changed</h4>
        <span className="muted tiny">
          {previewing ? 'recomputing…' : `${cached?.length ?? 0} past proposals`}
        </span>
      </div>

      <div className="diff-counts">
        {ACTIONS.map((a) => {
          const before = baseCounts[a];
          const after = draftCounts[a];
          const delta = after - before;
          return (
            <div key={a} className={`diff-count ${delta !== 0 ? 'diff-changed' : ''}`}>
              <div className="diff-count-label">{a}</div>
              <div className="diff-count-val">
                {after}
                {delta !== 0 && (
                  <span className={`diff-delta ${delta > 0 ? 'up' : 'down'}`}>
                    {delta > 0 ? '+' : ''}{delta}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="diff-list">
        {!draftDecisions ? (
          <p className="muted tiny">{previewing ? 'Recomputing…' : 'No live preview yet.'}</p>
        ) : diffs.length === 0 ? (
          <p className="muted tiny">
            {previewing
              ? 'Recomputing…'
              : 'No proposals would have changed under the current edits.'}
          </p>
        ) : (
          <>
            <div className="diff-list-head muted tiny">
              {diffs.length} proposal{diffs.length === 1 ? '' : 's'} would have changed:
            </div>
            {diffs.map((d) => (
              <div key={d.id} className={`diff-item diff-item-${d.corpus}`}>
                <div className="diff-item-title">
                  <span className={`corpus-badge corpus-${d.corpus}`}>
                    {d.corpus === 'calibration' ? 'CAL' : 'REAL'}
                  </span>
                  {d.title ?? d.id.slice(0, 14) + '…'}
                </div>
                <div className="diff-item-decision">
                  <span className={`diff-from action-${d.from}`}>{d.from}</span>
                  <span className="diff-arrow">→</span>
                  <span className={`diff-to action-${d.to}`}>{d.to}</span>
                </div>
                {d.ruleIds.length > 0 && (
                  <div className="diff-item-rule">
                    <span className="diff-rule-label">binding rule</span>
                    <code className="diff-rule-id">{d.ruleIds[0]}</code>
                    {d.ruleIds.length > 1 && (
                      <span
                        className="diff-rule-more"
                        title={`also fired:\n${d.ruleIds.slice(1).join('\n')}`}
                      >
                        +{d.ruleIds.length - 1}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
