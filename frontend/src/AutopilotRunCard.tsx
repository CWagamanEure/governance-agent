/**
 * Autopilot batch operationalization.
 *
 * Three states:
 *   - idle: shows the saved policy autopilot config + a "Preview" button.
 *   - previewed: shows the per-item plan (decision, confidence, eligible /
 *     reason). "Run live" enables only if any items are eligible AND the
 *     saved policy has autopilot.enabled.
 *   - running / done: per-item submission result with Snapshot URL or error.
 *
 * Proposals scanned: live-active from primary + fallback spaces UNION the
 * cached corpus (closed proposals show eligibility verdicts in dry-run but
 * Snapshot would reject them at submit time — expected, surfaced in the
 * result row).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchActiveProposals,
  fetchSnapshotProposal,
  getCachedProposals,
  runAutopilot,
  type AutopilotPlanItem,
  type AutopilotRunResult,
  type StoredProfile,
} from './api';

type Step = 'idle' | 'previewing' | 'previewed' | 'confirming' | 'running' | 'done' | 'error';

export function AutopilotRunCard({
  token,
  profile,
  daoSpace,
  fallbackSpaces,
}: {
  token: string;
  profile: NonNullable<StoredProfile['profile']>;
  daoSpace: string | null;
  fallbackSpaces: string[];
}) {
  const [step, setStep] = useState<Step>('idle');
  const [result, setResult] = useState<AutopilotRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef(0);

  const savedAutopilot = (profile.profile_json?.autopilot ?? {
    enabled: false,
    min_confidence: 0.85,
    decisions: ['FOR'],
  }) as { enabled: boolean; min_confidence: number; decisions: string[] };

  function reset() {
    runIdRef.current += 1;
    setResult(null);
    setError(null);
    setStep('idle');
  }

  /**
   * Build the proposal candidate list:
   *   - Live-active proposals from primary + every fallback space (the only
   *     ones Snapshot would actually accept a vote for).
   *   - The cached corpus (closed but in our extraction store) so the dry-run
   *     plan shows eligibility verdicts the operator recognizes from ACT 2.
   * We deduplicate by proposal id; live-active wins so the raw object is
   * the authoritative one.
   */
  async function gatherProposals(): Promise<any[]> {
    const spacesToScan = [
      ...(daoSpace ? [daoSpace] : []),
      ...fallbackSpaces.filter((s) => s !== daoSpace),
    ];
    const activeIdsBySpace = await Promise.all(
      spacesToScan.map((space) =>
        fetchActiveProposals(space, 8)
          .then((items) => items.map((p) => ({ space, ...p })))
          .catch(() => [] as Array<{ space: string; id: string; title: string; end: number }>),
      ),
    );
    const activeRaw = await Promise.all(
      activeIdsBySpace.flat().map((p) =>
        fetchSnapshotProposal(p.id).catch(() => null),
      ),
    );
    const cached = await getCachedProposals({ token, limit: 50 }).catch(() => ({
      items: [],
    }));
    const cachedRaw = cached.items
      .filter((it) => it.proposal.space !== 'calibration.gov-agent')
      .map((it) => it.proposal.raw);

    const seen = new Set<string>();
    const out: any[] = [];
    for (const p of activeRaw) {
      if (!p?.id || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
    for (const p of cachedRaw) {
      if (!p?.id || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
    return out;
  }

  async function handlePreview() {
    reset();
    setStep('previewing');
    const myRun = runIdRef.current;
    try {
      const proposals = await gatherProposals();
      if (runIdRef.current !== myRun) return;
      if (proposals.length === 0) {
        setError(
          'No proposals available to preview. Snapshot returned nothing active and the cache is empty.',
        );
        setStep('error');
        return;
      }
      const r = await runAutopilot({ token, proposals, dry_run: true });
      if (runIdRef.current !== myRun) return;
      setResult(r);
      setStep('previewed');
    } catch (e: any) {
      if (runIdRef.current !== myRun) return;
      setError(e?.message ?? String(e));
      setStep('error');
    }
  }

  async function handleRun() {
    if (!result) return;
    const eligibleCount = result.plan.filter((p) => p.eligible).length;
    if (eligibleCount === 0) return;
    const ok = window.confirm(
      `Run autopilot live?\n\n` +
        `${eligibleCount} proposal${eligibleCount === 1 ? '' : 's'} eligible at your saved policy ` +
        `(autopilot ${savedAutopilot.enabled ? 'enabled' : 'DISABLED'}, ` +
        `confidence floor ${savedAutopilot.min_confidence.toFixed(2)}, ` +
        `decisions: ${savedAutopilot.decisions.join(',')}).\n\n` +
        `Each eligible vote will be signed by the TEE wallet and posted to Snapshot mainnet. ` +
        `Public, permanent record per vote.`,
    );
    if (!ok) return;
    setStep('running');
    const myRun = runIdRef.current;
    try {
      // Re-gather so the live submit acts on the same proposal set the
      // preview showed (in practice they are the same; this keeps the path
      // self-contained in case the user reset between preview and run).
      const proposals = await gatherProposals();
      if (runIdRef.current !== myRun) return;
      const r = await runAutopilot({ token, proposals, dry_run: false });
      if (runIdRef.current !== myRun) return;
      setResult(r);
      setStep('done');
    } catch (e: any) {
      if (runIdRef.current !== myRun) return;
      setError(e?.message ?? String(e));
      setStep('error');
    }
  }

  const eligibleCount = useMemo(() => {
    return result ? result.plan.filter((p) => p.eligible).length : 0;
  }, [result]);
  const submittedCount = result?.submitted_count ?? 0;
  const ok = step === 'done' || step === 'previewed';

  return (
    <section className="card autopilot-run-card" aria-label="Autopilot batch run">
      <div className="sign-verify-head">
        <div>
          <div className="dft-label">Autopilot batch run</div>
          <strong>Process all currently-eligible proposals in one click</strong>
        </div>
        {step !== 'idle' && (
          <button className="link-btn" onClick={reset} title="Clear and start over">
            reset
          </button>
        )}
      </div>

      <p className="muted tiny" style={{ marginTop: 6 }}>
        Reads your saved policy autopilot block (currently{' '}
        <strong>{savedAutopilot.enabled ? 'enabled' : 'disabled'}</strong> at{' '}
        <code>{savedAutopilot.min_confidence.toFixed(2)}</code> confidence,{' '}
        <code>{savedAutopilot.decisions.join(',') || '(none)'}</code>), scans active proposals
        across your allowlisted spaces, applies the eligibility predicate, and either previews
        the plan (dry-run) or signs + submits eligible votes sequentially.
      </p>

      <div className="sv-buttons" style={{ marginTop: 14 }}>
        <button
          className="btn primary"
          onClick={handlePreview}
          disabled={step === 'previewing' || step === 'running'}
        >
          {step === 'previewing' ? 'Building plan…' : 'Preview autopilot batch'}
        </button>
        <button
          className="btn submit-btn"
          onClick={handleRun}
          disabled={
            !result ||
            eligibleCount === 0 ||
            !savedAutopilot.enabled ||
            step === 'running' ||
            step === 'done'
          }
          title={
            !result
              ? 'Preview first'
              : !savedAutopilot.enabled
                ? 'Saved policy has autopilot disabled — enable it in the editor and save'
                : eligibleCount === 0
                  ? 'No proposals eligible under your current autopilot config'
                  : `Submit ${eligibleCount} eligible vote${eligibleCount === 1 ? '' : 's'}`
          }
        >
          {step === 'running'
            ? 'Submitting…'
            : step === 'done'
              ? `✓ Submitted ${submittedCount}`
              : `Run live (${eligibleCount} eligible)`}
        </button>
      </div>

      {error && (
        <div className="modal-error" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      {result && ok && <PlanTable result={result} />}
    </section>
  );
}

function PlanTable({ result }: { result: AutopilotRunResult }) {
  return (
    <div className="autopilot-plan" style={{ marginTop: 14 }}>
      <div className="dft-label">
        Plan — {result.plan.length} proposal{result.plan.length === 1 ? '' : 's'} scanned
        {result.dry_run ? ' (dry run)' : ` (live · ${result.submitted_count} submitted)`}
        {result.capped && ' · CAPPED at max_votes'}
      </div>
      <div className="autopilot-plan-rows">
        {result.plan.map((p) => (
          <PlanRow key={p.proposal_id} item={p} dry={result.dry_run} />
        ))}
      </div>
    </div>
  );
}

function PlanRow({ item, dry }: { item: AutopilotPlanItem; dry: boolean }) {
  const decisionClass = item.decision ? `action-${item.decision}` : '';
  const confidenceText =
    item.confidence != null ? `${(item.confidence * 100).toFixed(0)}%` : '—';
  return (
    <div className={`autopilot-row ${item.eligible ? 'eligible' : 'ineligible'}`}>
      <div className="autopilot-row-title">
        {item.eligible && <span className="autopilot-badge">AUTO</span>}
        {item.title ?? item.proposal_id.slice(0, 14) + '…'}
      </div>
      <div className="autopilot-row-meta">
        {item.space && <code className="autopilot-row-space">{item.space}</code>}
        <span className={`autopilot-row-decision ${decisionClass}`}>
          {item.decision ?? '—'}
        </span>
        <span className="muted tiny">{confidenceText}</span>
        {!item.eligible && item.reason && (
          <span className="autopilot-row-reason muted tiny">{item.reason}</span>
        )}
      </div>
      {!dry && item.submitted && (
        <div className="autopilot-row-result">
          {item.submitted.ok ? (
            <a
              href={item.submitted.snapshot_url}
              target="_blank"
              rel="noreferrer"
              className="trust-link"
            >
              ✓ submitted ↗
            </a>
          ) : (
            <span className="autopilot-row-error muted tiny">
              ✗ {item.submitted.error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
