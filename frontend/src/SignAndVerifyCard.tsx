/**
 * Live sign → verify → submit demo.
 *
 * Three sequential beats for the demo's ACT 5:
 *   1. Sign     — TEE wallet produces a SignedDecisionBlob and (if the policy
 *                 evaluates FOR/AGAINST/ABSTAIN) a Snapshot vote envelope.
 *   2. Verify   — independently re-runs the engine off the signed blob's
 *                 inputs and confirms the recomputed evaluation hash matches.
 *   3. Submit   — POSTs the existing vote envelope to Snapshot's sequencer.
 *                 Only enabled when the proposal is currently OPEN on Snapshot
 *                 and the policy produced an autovote-eligible decision.
 *
 * Active Snapshot proposals (live-fetched via GraphQL) are preferred in the
 * dropdown over the cached, mostly-closed corpus. If none exist at demo time,
 * the operator falls back to a closed cached proposal — Sign + Verify still
 * work; Submit is disabled with a clear reason.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  fetchActiveProposals,
  fetchSnapshotProposal,
  getCachedProposals,
  runPipeline,
  submitVoteEnvelope,
  verifyDecisionBlob,
  type CachedProposalRow,
  type DecisionVerifyResult,
  type StoredProfile,
  type VoteSubmitResult,
} from './api';
import { HashCopyChip } from './HashCopyChip';

type Step =
  | 'idle'
  | 'signing'
  | 'signed'
  | 'verifying'
  | 'verified'
  | 'submitting'
  | 'submitted'
  | 'error';

type ProposalOption = {
  id: string;
  title: string;
  source: 'live-active' | 'cache';
  cached?: CachedProposalRow;
  endTs?: number;
};

type SignedState = {
  blob: any;
  analysis: any;
  evaluation: any;
  vote: { envelope: any; choice: number } | null;
};

export function SignAndVerifyCard({
  token,
  profile,
  daoSpace,
}: {
  token: string;
  profile: NonNullable<StoredProfile['profile']>;
  daoSpace: string | null;
}) {
  const [activeOptions, setActiveOptions] = useState<ProposalOption[]>([]);
  const [cachedOptions, setCachedOptions] = useState<ProposalOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('idle');
  const [signed, setSigned] = useState<SignedState | null>(null);
  const [verifyResult, setVerifyResult] = useState<DecisionVerifyResult | null>(null);
  const [submission, setSubmission] = useState<VoteSubmitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load both data sources in parallel. Live-fetched active proposals are
  // preferred for the demo because they're the only ones Snapshot will accept
  // a vote for. Cached proposals stay available for sign+verify-only paths.
  useEffect(() => {
    let cancelled = false;
    const cachedP = getCachedProposals({ token, limit: 50 })
      .then((r) => r.items.filter((it) => it.proposal.space !== 'calibration.gov-agent'))
      .catch(() => [] as CachedProposalRow[]);
    const activeP = daoSpace
      ? fetchActiveProposals(daoSpace, 8).catch(() => [])
      : Promise.resolve([] as Array<{ id: string; title: string; end: number }>);

    Promise.all([cachedP, activeP]).then(([cached, active]) => {
      if (cancelled) return;
      const cachedOpts: ProposalOption[] = cached.map((c) => ({
        id: c.proposal.id,
        title: c.proposal.title ?? c.proposal.id.slice(0, 14),
        source: 'cache',
        cached: c,
        endTs: c.proposal.end_ts ?? undefined,
      }));
      const activeOpts: ProposalOption[] = active.map((p) => ({
        id: p.id,
        title: p.title,
        source: 'live-active',
        endTs: p.end,
      }));
      setCachedOptions(cachedOpts);
      setActiveOptions(activeOpts);
      // Prefer the soonest-closing active proposal as the default selection.
      const defaultId = activeOpts[0]?.id ?? cachedOpts[0]?.id ?? null;
      setSelectedId((curr) => curr ?? defaultId);
    });
    return () => {
      cancelled = true;
    };
  }, [token, daoSpace]);

  const allOptions = useMemo(
    () => [...activeOptions, ...cachedOptions],
    [activeOptions, cachedOptions],
  );
  const selected = useMemo(
    () => allOptions.find((p) => p.id === selectedId) ?? null,
    [allOptions, selectedId],
  );

  function reset() {
    setSigned(null);
    setVerifyResult(null);
    setSubmission(null);
    setError(null);
    setStep('idle');
  }

  async function handleSign() {
    if (!selected) return;
    reset();
    setStep('signing');
    try {
      // Cached proposals carry the raw Snapshot record alongside; live-active
      // ones only have id/title — fetch the full proposal first so the
      // pipeline has body, choices, etc.
      let proposalRaw: any;
      if (selected.cached) {
        proposalRaw = selected.cached.proposal.raw;
      } else {
        proposalRaw = await fetchSnapshotProposal(selected.id);
        if (!proposalRaw) throw new Error('could not fetch active proposal from Snapshot');
      }

      const result = await runPipeline({
        token,
        proposal: proposalRaw,
        sign: true,
      });
      if (!result.decision_blob) {
        throw new Error(result.decision_blob_error ?? 'no decision_blob in pipeline response');
      }
      setSigned({
        blob: result.decision_blob,
        analysis: result.analysis,
        evaluation: result.evaluation,
        // result.vote is non-null only when the policy decided FOR/AGAINST/ABSTAIN.
        // MANUAL_REVIEW intentionally produces no envelope, which gates Submit.
        vote: result.vote,
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

  async function handleSubmit() {
    if (!signed?.vote) return;
    const ok = window.confirm(
      `Submit a real vote to Snapshot mainnet?\n\nSpace: ${selected?.id ? daoSpace : '(unknown)'}\nProposal: ${selected?.title}\nChoice: ${choiceLabel(signed.vote.choice)}\n\nThis is a public, permanent record signed by the TEE wallet. The vote will count against the wallet's voting power on this Snapshot strategy.`,
    );
    if (!ok) return;
    setStep('submitting');
    try {
      const r = await submitVoteEnvelope({ token, envelope: signed.vote.envelope });
      setSubmission(r);
      setStep(r.ok ? 'submitted' : 'error');
      if (!r.ok) setError(r.error ?? 'Snapshot rejected the vote');
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStep('error');
    }
  }

  const proposalIsActive = selected?.source === 'live-active';
  const submitDisabled =
    !signed?.vote ||
    !verifyResult?.ok ||
    !proposalIsActive ||
    step === 'submitting' ||
    step === 'submitted';
  const submitTooltip = !signed
    ? 'Sign first'
    : !verifyResult?.ok
      ? 'Verify first'
      : !signed.vote
        ? 'Policy decided MANUAL_REVIEW — no autovote envelope to submit'
        : !proposalIsActive
          ? 'This proposal is closed; pick an active one to submit'
          : 'Submit the signed envelope to Snapshot mainnet';

  return (
    <section className="card sign-verify-card" aria-label="Live sign and verify">
      <div className="sign-verify-head">
        <div>
          <div className="dft-label">Live sign &middot; verify &middot; submit</div>
          <strong>One decision, end-to-end</strong>
        </div>
        {step !== 'idle' && (
          <button className="link-btn" onClick={reset} title="Clear and start over">
            reset
          </button>
        )}
      </div>

      <p className="muted tiny" style={{ marginTop: 6 }}>
        The TEE-bound wallet signs an EIP-712 decision blob committing to the policy hash, the
        extraction hash, and the engine output. Verify replays the engine off those exact
        inputs. Submit posts the signed Snapshot vote to mainnet — only enabled when the
        proposal is open and the policy produced an autovote-eligible decision.
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
        disabled={step === 'signing' || step === 'verifying' || step === 'submitting'}
      >
        {allOptions.length === 0 && <option value="">(loading proposals&hellip;)</option>}
        {activeOptions.length > 0 && (
          <optgroup label={`Active on ${daoSpace ?? 'Snapshot'}`}>
            {activeOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {`[ACTIVE] ${p.title.slice(0, 80)}`}
              </option>
            ))}
          </optgroup>
        )}
        {cachedOptions.length > 0 && (
          <optgroup label="Cached (closed) — sign &amp; verify only">
            {cachedOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title.slice(0, 80)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {activeOptions.length === 0 && daoSpace && (
        <p className="muted tiny" style={{ marginTop: 4 }}>
          No active Snapshot proposals on <code>{daoSpace}</code>; submit will be disabled.
        </p>
      )}

      <div className="sv-buttons" style={{ marginTop: 14 }}>
        <button
          className="btn primary"
          onClick={handleSign}
          disabled={
            !selected || step === 'signing' || step === 'verifying' || step === 'submitting'
          }
        >
          {step === 'signing' ? 'Signing in TEE…' : 'Sign decision (TEE)'}
        </button>
        <button
          className="btn"
          onClick={handleVerify}
          disabled={
            !signed ||
            step === 'verifying' ||
            (verifyResult?.ok ?? false) ||
            step === 'submitting'
          }
          title={!signed ? 'Sign first' : 'Independently re-run the engine'}
        >
          {step === 'verifying'
            ? 'Verifying…'
            : verifyResult?.ok
              ? '✓ Verified'
              : 'Verify (replay)'}
        </button>
        <button
          className="btn submit-btn"
          onClick={handleSubmit}
          disabled={submitDisabled}
          title={submitTooltip}
        >
          {step === 'submitting'
            ? 'Posting to Snapshot…'
            : submission?.ok
              ? '✓ Submitted'
              : 'Submit to Snapshot'}
        </button>
      </div>

      {error && (
        <div className="modal-error" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      {signed && (
        <div className="sv-result" style={{ marginTop: 14 }}>
          <SignedSummary signed={signed} proposalActive={proposalIsActive} />
        </div>
      )}

      {verifyResult && <VerifySummary result={verifyResult} />}

      {submission && <SubmissionSummary result={submission} />}
    </section>
  );
}

function SignedSummary({
  signed,
  proposalActive,
}: {
  signed: SignedState;
  proposalActive: boolean;
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
          label="vote envelope"
          value={signed.vote ? `signed choice ${signed.vote.choice}` : 'not signed (MANUAL_REVIEW)'}
          mono
          good={!!signed.vote}
        />
      </div>
      <div className="dft-label" style={{ marginTop: 10 }}>
        Content-addressed inputs (click to copy)
      </div>
      <div className="sv-grid">
        <SvHashRow label="policy hash" hash={payload.hashes.policy} />
        <SvHashRow label="rules hash" hash={payload.hashes.rules} />
        <SvHashRow label="analysis hash" hash={payload.hashes.analysis} />
        <SvHashRow label="evaluation hash" hash={payload.hashes.evaluation} />
      </div>
      {!proposalActive && (
        <p className="muted tiny" style={{ marginTop: 8 }}>
          This is a closed proposal — Snapshot will reject a live submit. Pick an active one to
          demo the full sign → verify → submit loop.
        </p>
      )}
    </div>
  );
}

function SvHashRow({ label, hash }: { label: string; hash: string }) {
  return (
    <div className="sv-row">
      <span className="sv-row-label">{label}</span>
      <HashCopyChip hash={hash} prefixChars={10} label={label} />
    </div>
  );
}

function VerifySummary({ result }: { result: DecisionVerifyResult }) {
  return (
    <div className="sv-section" style={{ marginTop: 14 }}>
      <div className="dft-label">Replay verification</div>
      <div className={`sv-stamp ${result.ok ? 'sv-stamp-ok' : 'sv-stamp-bad'}`} role="status">
        {result.ok ? '✓ verified' : '✗ mismatch'}
        <span className="muted tiny" style={{ marginLeft: 8 }}>
          replayed {result.replayed_decision} in {result.elapsed_ms} ms · engine {result.engine_version}
        </span>
      </div>
      <div className="sv-grid" style={{ marginTop: 10 }}>
        {Object.entries(result.checks).map(([k, ok]) => (
          <SvRow key={k} label={k.replace(/_/g, ' ')} value={ok ? 'match' : 'MISMATCH'} good={ok} mono />
        ))}
      </div>
    </div>
  );
}

function SubmissionSummary({ result }: { result: VoteSubmitResult }) {
  return (
    <div className="sv-section" style={{ marginTop: 14 }}>
      <div className="dft-label">Snapshot submission</div>
      <div className={`sv-stamp ${result.ok ? 'sv-stamp-ok' : 'sv-stamp-bad'}`} role="status">
        {result.ok ? '✓ accepted by Snapshot' : '✗ rejected'}
        {!result.ok && (
          <span className="muted tiny" style={{ marginLeft: 8 }}>
            HTTP {result.status ?? '—'}
          </span>
        )}
      </div>
      <p className="muted tiny" style={{ marginTop: 8, wordBreak: 'break-all' }}>
        {result.ok ? (
          <>
            Public record:{' '}
            <a href={result.snapshot_url} target="_blank" rel="noreferrer" className="trust-link">
              {result.snapshot_url}
            </a>
          </>
        ) : (
          <>Snapshot returned: {result.error}</>
        )}
      </p>
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

function choiceLabel(choice: number): string {
  if (choice === 1) return 'FOR';
  if (choice === 2) return 'AGAINST';
  if (choice === 3) return 'ABSTAIN';
  return `choice ${choice}`;
}
