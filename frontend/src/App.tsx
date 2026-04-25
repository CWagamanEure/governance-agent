import { useEffect, useState } from 'react';
import {
  BACKEND_URL,
  fetchSnapshotProposal,
  getAttestation,
  getPublicEnv,
  getWallet,
  runPipeline,
  type AttestationStub,
  type Decision,
  type PipelineResult,
  type WalletInfo,
} from './api';
import { FEATURED } from './data';

export function App() {
  return (
    <div className="app">
      <h1 className="title">Governance Agent · Arbitrum DAO</h1>
      <p className="subtitle">
        A verifiable, policy-bound delegate running inside an EigenCompute TEE.
        Decisions are produced by deterministic rules anyone can audit; votes
        are signed by a key that lives only inside the attested image.
      </p>

      <TrustHeader />

      <h2 style={{ fontSize: 13, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '24px 0 12px' }}>
        Featured proposals
      </h2>

      {FEATURED.map((p) => (
        <ProposalCard key={p.id} proposalId={p.id} bundledAnalysis={p.analysis} />
      ))}

      <p className="tiny" style={{ marginTop: 28, textAlign: 'center' }}>
        backend: {BACKEND_URL}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trust header — wallet, public env, attestation status
// ---------------------------------------------------------------------------

function TrustHeader() {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [env, setEnv] = useState<Record<string, string> | null>(null);
  const [attestation, setAttestation] = useState<AttestationStub | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getWallet(), getPublicEnv(), getAttestation()])
      .then(([w, e, a]) => {
        setWallet(w);
        setEnv(e);
        setAttestation(a);
      })
      .catch((err) => setError(String(err)));
  }, []);

  if (error) {
    return (
      <div className="trust error">
        <h2>Trust surface</h2>
        <p>Could not reach backend at <code>{BACKEND_URL}</code>: {error}</p>
      </div>
    );
  }

  if (!wallet || !env) {
    return (
      <div className="trust">
        <h2>Trust surface</h2>
        <p className="muted">loading…</p>
      </div>
    );
  }

  const dao = env.DAO_SPACE_PUBLIC ?? '(unknown)';
  const engineVersion = env.POLICY_ENGINE_VERSION_PUBLIC ?? '(unknown)';
  const machine = env.EIGEN_MACHINE_TYPE_PUBLIC ?? '(unknown)';

  return (
    <div className="trust">
      <h2>
        Trust surface <span className="badge">EigenCompute TEE</span>
      </h2>
      <div className="trust-grid">
        <div className="k">App wallet</div>
        <div className="v address">{wallet.address}</div>

        <div className="k">DAO space</div>
        <div className="v">{dao}</div>

        <div className="k">Policy engine</div>
        <div className="v">v{engineVersion}</div>

        <div className="k">Instance</div>
        <div className="v">{machine}</div>

        <div className="k">Attestation</div>
        <div className="v">
          {attestation?.status === 'stub' ? (
            <span className="muted">stub (TDX quote API not yet wired)</span>
          ) : (
            'live'
          )}
          {' · '}
          <a
            href="https://verify-sepolia.eigencloud.xyz/app/0xA2090Bc33B35E7b9dD1EEEA86Fc117263Bd1cd9D"
            target="_blank"
            rel="noreferrer"
          >
            verify on dashboard ↗
          </a>
        </div>

        <div className="k">Source</div>
        <div className="v">
          <a
            href="https://github.com/CWagamanEure/governance-agent"
            target="_blank"
            rel="noreferrer"
          >
            github.com/CWagamanEure/governance-agent ↗
          </a>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proposal card — fetches the live Snapshot proposal, runs the pipeline,
// renders the deterministic decision + lets you sign with the enclave wallet.
// ---------------------------------------------------------------------------

function ProposalCard({
  proposalId,
  bundledAnalysis,
}: {
  proposalId: string;
  bundledAnalysis?: any;
}) {
  const [proposal, setProposal] = useState<any | null>(null);
  const [pipeline, setPipeline] = useState<PipelineResult | null>(null);
  const [signed, setSigned] = useState<PipelineResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSnapshotProposal(proposalId)
      .then((p) => setProposal(p))
      .catch((e) => setError(`fetch from Snapshot failed: ${e}`));
  }, [proposalId]);

  useEffect(() => {
    if (!proposal || pipeline) return;
    setLoading(true);
    runPipeline({ proposal, analysis: bundledAnalysis })
      .then((r) => setPipeline(r))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [proposal, pipeline, bundledAnalysis]);

  async function castVote() {
    if (!proposal) return;
    setLoading(true);
    try {
      const r = await runPipeline({ proposal, analysis: bundledAnalysis, sign: true });
      setSigned(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  if (error) {
    return (
      <div className="card error">
        <h3>Proposal {proposalId.slice(0, 10)}…</h3>
        <p className="tiny">error: {error}</p>
      </div>
    );
  }

  if (!proposal) {
    return (
      <div className="card">
        <h3>{proposalId.slice(0, 10)}…</h3>
        <p className="muted tiny">fetching from Snapshot…</p>
      </div>
    );
  }

  const decision = pipeline?.evaluation?.decision;
  const conf = pipeline?.evaluation?.confidence;

  return (
    <div className="card">
      <h3>{proposal.title ?? proposalId}</h3>
      <div className="meta">
        {proposal.space?.id} · {proposal.state} · {proposal.id.slice(0, 10)}…
      </div>

      {pipeline?.analysis && (
        <p style={{ margin: '6px 0 14px', fontSize: 14 }}>
          {pipeline.analysis.summary}
        </p>
      )}

      {loading && !pipeline && (
        <p className="muted tiny">running pipeline…</p>
      )}

      {decision && pipeline?.evaluation && (
        <>
          <div className="row">
            <span className={`decision decision-${decision}`}>
              Decision: {decision}
            </span>
            <span className="muted tiny">
              confidence {Math.round((conf ?? 0) * 100)}% · margin{' '}
              {pipeline.evaluation.margin.toFixed(2)} · engine v
              {pipeline.evaluation.engine_version}
            </span>
          </div>

          <div className="section">
            <h4>Triggered rules</h4>
            {pipeline.evaluation.triggered_rules.length === 0 ? (
              <p className="muted tiny">No rules matched.</p>
            ) : (
              pipeline.evaluation.triggered_rules.map((r) => (
                <div key={r.id} className="rule">
                  <span className="id">{r.id}</span>
                  <span className="reason">— {r.reason}</span>
                  {r.contribution && (
                    <span className="contrib">
                      (
                      {Object.entries(r.contribution)
                        .map(([k, v]) => `${k} +${v}`)
                        .join(', ')}
                      )
                    </span>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="row" style={{ marginTop: 16 }}>
            {decision === 'FOR' || decision === 'AGAINST' || decision === 'ABSTAIN' ? (
              <button className="primary" onClick={castVote} disabled={loading || !!signed}>
                {signed ? 'Signed in TEE ✓' : `Sign vote (${decision}) inside enclave`}
              </button>
            ) : (
              <span className="muted tiny">
                Manual review required — would not auto-vote.
              </span>
            )}
          </div>

          {signed?.vote && (
            <div className="section">
              <h4>Signed vote envelope</h4>
              <p className="tiny" style={{ margin: '0 0 8px' }}>
                Signed by{' '}
                <span style={{ color: 'var(--accent)' }}>
                  {signed.vote.envelope.address}
                </span>{' '}
                — the enclave-bound app wallet. Snapshot will accept this if
                the voting window is open and the wallet has voting power.
              </p>
              <pre>{JSON.stringify(signed.vote.envelope, null, 2)}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
