/**
 * Live sign-then-verify demo.
 *
 * Pick a real cached proposal, run the pipeline with sign=true so the
 * TEE-bound wallet produces a SignedDecisionBlob, then post the blob plus the
 * full inputs (policy + analysis) to /decision/verify and watch a green stamp
 * land in <100 ms. Demonstrates the trust loop end-to-end:
 *
 *   policy + analysis  ──hash──▶  decision blob (EIP-712, TEE-signed)
 *                                        │
 *                                  re-run engine
 *                                        │
 *                                        ▼
 *                                ✓ same evaluation hash
 *                                ✓ signature recovers
 */

import { useEffect, useMemo, useState } from 'react';
import {
  getCachedProposals,
  runPipeline,
  verifyDecisionBlob,
  type CachedProposalRow,
  type DecisionVerifyResult,
  type StoredProfile,
} from './api';

type Step = 'idle' | 'signing' | 'signed' | 'verifying' | 'verified' | 'error';

export function SignAndVerifyCard({
  token,
  profile,
}: {
  token: string;
  profile: NonNullable<StoredProfile['profile']>;
}) {
  const [proposals, setProposals] = useState<CachedProposalRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('idle');
  const [signed, setSigned] = useState<{ blob: any; analysis: any; evaluation: any } | null>(null);
  const [verifyResult, setVerifyResult] = useState<DecisionVerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCachedProposals({ token, limit: 50 })
      .then((r) => {
        if (cancelled) return;
        // Prefer real Arbitrum proposals — calibration fixtures don't tell the
        // "TEE signed something about a real DAO proposal" story as well.
        const real = r.items.filter((it) => it.proposal.space !== 'calibration.gov-agent');
        const list = real.length > 0 ? real : r.items;
        setProposals(list);
        setSelectedId((curr) => curr ?? list[0]?.proposal.id ?? null);
      })
      .catch((e) => setError(e?.message ?? String(e)));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const selected = useMemo(
    () => proposals.find((p) => p.proposal.id === selectedId) ?? null,
    [proposals, selectedId],
  );

  function reset() {
    setSigned(null);
    setVerifyResult(null);
    setError(null);
    setStep('idle');
  }

  async function handleSign() {
    if (!selected) return;
    reset();
    setStep('signing');
    try {
      const result = await runPipeline({
        token,
        proposal: selected.proposal.raw,
        sign: true,
      });
      if (!result.decision_blob) {
        throw new Error(result.decision_blob_error ?? 'no decision_blob in pipeline response');
      }
      setSigned({
        blob: result.decision_blob,
        analysis: result.analysis,
        evaluation: result.evaluation,
      });
      setStep('signed');
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStep('error');
    }
  }

  async function handleVerify() {
    if (!signed) return;
    setStep('verifying');
    try {
      const r = await verifyDecisionBlob({
        blob: signed.blob,
        policy: profile.profile_json,
        analysis: signed.analysis,
      });
      setVerifyResult(r);
      setStep(r.ok ? 'verified' : 'error');
      if (!r.ok) setError('Verification mismatch — see check details below.');
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStep('error');
    }
  }

  return (
    <section className="card sign-verify-card" aria-label="Live sign and verify">
      <div className="sign-verify-head">
        <div>
          <div className="dft-label">Live sign &amp; verify</div>
          <strong>Sign one decision, replay it locally to confirm</strong>
        </div>
        {step !== 'idle' && (
          <button className="link-btn" onClick={reset} title="Clear and start over">
            reset
          </button>
        )}
      </div>

      <p className="muted tiny" style={{ marginTop: 6 }}>
        The TEE-bound wallet signs an EIP-712 decision blob committing to the policy hash, the
        extraction hash, and the engine&apos;s output. Click <em>Verify</em> to re-run the
        deterministic engine against those exact inputs and confirm the signed evaluation.
      </p>

      <label className="muted tiny" style={{ display: 'block', marginTop: 12 }}>
        Proposal
      </label>
      <select
        value={selectedId ?? ''}
        onChange={(e) => {
          setSelectedId(e.target.value);
          reset();
        }}
        className="editor-select"
        style={{ width: '100%', marginTop: 4 }}
        disabled={step === 'signing' || step === 'verifying'}
      >
        {proposals.length === 0 && <option value="">(loading proposals…)</option>}
        {proposals.map((p) => (
          <option key={p.proposal.id} value={p.proposal.id}>
            {p.proposal.title?.slice(0, 80) ?? p.proposal.id.slice(0, 14)}
          </option>
        ))}
      </select>

      <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
        <button
          className="btn primary"
          onClick={handleSign}
          disabled={!selected || step === 'signing' || step === 'verifying'}
        >
          {step === 'signing' ? 'Signing in TEE…' : 'Sign decision (TEE)'}
        </button>
        <button
          className="btn"
          onClick={handleVerify}
          disabled={!signed || step === 'verifying' || step === 'verified'}
          title={!signed ? 'Sign first' : 'Independently re-run the engine to confirm the signed evaluation'}
        >
          {step === 'verifying'
            ? 'Verifying…'
            : step === 'verified'
              ? '✓ Verified'
              : 'Verify (replay)'}
        </button>
      </div>

      {error && (
        <div className="modal-error" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      {signed && (
        <div className="sv-result" style={{ marginTop: 14 }}>
          <SignedSummary signed={signed} />
        </div>
      )}

      {verifyResult && <VerifySummary result={verifyResult} />}
    </section>
  );
}

function SignedSummary({
  signed,
}: {
  signed: { blob: any; analysis: any; evaluation: any };
}) {
  const blob = signed.blob;
  const payload = blob.payload;
  return (
    <div className="sv-section">
      <div className="dft-label">Signed decision</div>
      <div className="sv-grid">
        <SvRow label="decision" value={payload.decision} mono />
        <SvRow
          label="agent (TEE wallet)"
          value={short(payload.agent_address)}
          title={payload.agent_address}
          mono
        />
        <SvRow
          label="signature recovered"
          value={blob.verification?.recovered ? 'yes' : 'no'}
          mono
          good={blob.verification?.recovered}
        />
        <SvRow
          label="EIP-712 sig"
          value={short(blob.signature.sig, 10, 6)}
          title={blob.signature.sig}
          mono
        />
      </div>
      <div className="dft-label" style={{ marginTop: 10 }}>
        Content-addressed inputs
      </div>
      <div className="sv-grid">
        <SvRow label="policy hash" value={short(payload.hashes.policy, 10, 6)} title={payload.hashes.policy} mono />
        <SvRow label="rules hash" value={short(payload.hashes.rules, 10, 6)} title={payload.hashes.rules} mono />
        <SvRow label="analysis hash" value={short(payload.hashes.analysis, 10, 6)} title={payload.hashes.analysis} mono />
        <SvRow label="evaluation hash" value={short(payload.hashes.evaluation, 10, 6)} title={payload.hashes.evaluation} mono />
      </div>
    </div>
  );
}

function VerifySummary({ result }: { result: DecisionVerifyResult }) {
  return (
    <div className="sv-section" style={{ marginTop: 14 }}>
      <div className="dft-label">Replay verification</div>
      <div
        className={`sv-stamp ${result.ok ? 'sv-stamp-ok' : 'sv-stamp-bad'}`}
        role="status"
      >
        {result.ok ? '✓ verified' : '✗ mismatch'}
        <span className="muted tiny" style={{ marginLeft: 8 }}>
          replayed {result.replayed_decision} in {result.elapsed_ms} ms · engine{' '}
          {result.engine_version}
        </span>
      </div>
      <div className="sv-grid" style={{ marginTop: 10 }}>
        {Object.entries(result.checks).map(([k, ok]) => (
          <SvRow
            key={k}
            label={k.replace(/_/g, ' ')}
            value={ok ? 'match' : 'MISMATCH'}
            good={ok}
            mono
          />
        ))}
      </div>
    </div>
  );
}

function SvRow({
  label,
  value,
  title,
  mono,
  good,
}: {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
  good?: boolean;
}) {
  return (
    <div className="sv-row" title={title}>
      <span className="sv-row-label">{label}</span>
      <code
        className={`sv-row-value ${mono ? 'mono' : ''} ${good === true ? 'good' : good === false ? 'bad' : ''}`}
      >
        {value}
      </code>
    </div>
  );
}

function short(s: string | undefined, head = 8, tail = 4): string {
  if (!s) return '—';
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
