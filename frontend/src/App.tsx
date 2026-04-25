import { useEffect, useState } from 'react';
import {
  BACKEND_URL,
  fetchSnapshotProposal,
  getAttestation,
  getProfile,
  getPublicEnv,
  getWallet,
  runPipeline,
  type AttestationStub,
  type PipelineResult,
  type StoredProfile,
  type WalletInfo,
} from './api';
import {
  checkSession,
  clearStoredAuth,
  getStoredToken,
  signInWithEthereum,
} from './lib/auth';
import { FEATURED } from './data';
import { Onboarding } from './Onboarding';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authed'; address: string };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  // Resume session on page load if a token is stored.
  useEffect(() => {
    (async () => {
      const sess = await checkSession();
      if (sess) setAuth({ status: 'authed', address: sess.address });
      else setAuth({ status: 'anonymous' });
    })();
  }, []);

  // When authed, fetch the user's stored profile (or 404 → new user).
  useEffect(() => {
    if (auth.status !== 'authed') {
      setProfile(null);
      setProfileLoaded(false);
      return;
    }
    const token = getStoredToken();
    if (!token) return;
    getProfile(token)
      .then((p) => setProfile(p))
      .catch(() => setProfile(null))
      .finally(() => setProfileLoaded(true));
  }, [auth]);

  async function handleSignIn() {
    try {
      const { address } = await signInWithEthereum();
      setAuth({ status: 'authed', address });
    } catch (e: any) {
      alert(`Sign-in failed: ${e?.message ?? String(e)}`);
    }
  }

  function handleSignOut() {
    clearStoredAuth();
    setAuth({ status: 'anonymous' });
    setProfile(null);
    setProfileLoaded(false);
  }

  return (
    <div className="app">
      <h1 className="title">Governance Agent · Arbitrum DAO</h1>
      <p className="subtitle">
        A verifiable, policy-bound delegate running inside an EigenCompute TEE.
        Decisions are produced by deterministic rules anyone can audit; votes
        are signed by a key that lives only inside the attested image.
      </p>

      <TrustHeader auth={auth} onSignIn={handleSignIn} onSignOut={handleSignOut} />

      {auth.status === 'authed' && profileLoaded && !profile?.profile && (
        <>
          <h2 className="section-heading">Welcome — set your preferences</h2>
          <Onboarding
            onSaved={() => {
              const token = getStoredToken();
              if (token) getProfile(token).then((p) => setProfile(p));
            }}
          />
        </>
      )}

      {auth.status === 'authed' && profile?.profile && (
        <>
          <h2 className="section-heading">
            Your policy <span className="muted tiny">v{profile.profile.version}</span>
          </h2>
          <ProfileSummary profile={profile} onEdit={() => setProfile({ ...profile, profile: null })} />

          <h2 className="section-heading">Featured proposals</h2>
          {FEATURED.map((p) => (
            <ProposalCard key={p.id} proposalId={p.id} bundledAnalysis={p.analysis} authed={true} />
          ))}
        </>
      )}

      {auth.status === 'anonymous' && (
        <>
          <h2 className="section-heading">Sign in to set your preferences and vote</h2>
          <div className="card" style={{ textAlign: 'center', padding: 28 }}>
            <p className="muted" style={{ marginTop: 0 }}>
              The agent uses a deterministic rule engine. Your preferences are stored as a
              versioned profile and only the wallet you sign in with can update them.
            </p>
            <button className="primary" onClick={handleSignIn}>
              Connect Wallet
            </button>
          </div>

          <h2 className="section-heading">Sample (anonymous)</h2>
          <p className="muted tiny" style={{ marginBottom: 12 }}>
            Without sign-in, the agent uses its default profile and signs with the app-wide wallet.
          </p>
          {FEATURED.map((p) => (
            <ProposalCard key={p.id} proposalId={p.id} bundledAnalysis={p.analysis} authed={false} />
          ))}
        </>
      )}

      <p className="tiny" style={{ marginTop: 28, textAlign: 'center' }}>
        backend: {BACKEND_URL}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trust header
// ---------------------------------------------------------------------------

function TrustHeader({
  auth,
  onSignIn,
  onSignOut,
}: {
  auth: AuthState;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
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

        <div className="k">Session</div>
        <div className="v">
          {auth.status === 'loading' && <span className="muted">checking…</span>}
          {auth.status === 'anonymous' && (
            <button onClick={onSignIn}>Connect Wallet</button>
          )}
          {auth.status === 'authed' && (
            <span>
              <span style={{ color: 'var(--good)' }}>{auth.address}</span>{' '}
              <button onClick={onSignOut} style={{ marginLeft: 8 }}>
                Sign out
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile summary card
// ---------------------------------------------------------------------------

function ProfileSummary({
  profile,
  onEdit,
}: {
  profile: StoredProfile;
  onEdit: () => void;
}) {
  if (!profile.profile) return null;
  const p = profile.profile.profile_json;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div className="tiny">version {profile.profile.version} · hash <code>{profile.profile.hash.slice(0, 10)}…</code></div>
          <div style={{ fontSize: 14, marginTop: 8 }}>
            <span className="muted">Treasury:</span> {p.treasury_conservatism}/5{' '}
            <span className="muted" style={{ marginLeft: 12 }}>Decentralization:</span>{' '}
            {p.decentralization_priority}/5{' '}
            <span className="muted" style={{ marginLeft: 12 }}>Sustainability:</span>{' '}
            {p.growth_vs_sustainability}/5{' '}
            <span className="muted" style={{ marginLeft: 12 }}>Risk-aversion:</span>{' '}
            {p.protocol_risk_tolerance}/5
          </div>
          <div className="tiny" style={{ marginTop: 6 }}>
            Auto-approve cap: ${p.max_treasury_usd_auto?.toLocaleString() ?? '—'} ·{' '}
            Manual-review categories: {p.manual_review_categories.length}
          </div>
        </div>
        <button onClick={onEdit}>Edit</button>
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
  authed,
}: {
  proposalId: string;
  bundledAnalysis?: any;
  authed: boolean;
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
    runPipeline({
      proposal,
      analysis: bundledAnalysis,
      token: authed ? getStoredToken() : null,
    })
      .then((r) => setPipeline(r))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [proposal, pipeline, bundledAnalysis, authed]);

  async function castVote() {
    if (!proposal) return;
    setLoading(true);
    try {
      const r = await runPipeline({
        proposal,
        analysis: bundledAnalysis,
        sign: true,
        token: authed ? getStoredToken() : null,
      });
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

      {loading && !pipeline && <p className="muted tiny">running pipeline…</p>}

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
                      ({Object.entries(r.contribution).map(([k, v]) => `${k} +${v}`).join(', ')})
                    </span>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="row" style={{ marginTop: 16 }}>
            {decision === 'FOR' || decision === 'AGAINST' || decision === 'ABSTAIN' ? (
              <button
                className="primary"
                onClick={castVote}
                disabled={loading || !!signed}
              >
                {signed
                  ? 'Signed in TEE ✓'
                  : `Sign vote (${decision}) inside enclave${authed ? ' as your derived wallet' : ''}`}
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
                — {authed ? 'your enclave-derived wallet.' : 'the app-wide enclave wallet.'}{' '}
                Snapshot will accept this if the voting window is open and the
                wallet has voting power.
              </p>
              <pre>{JSON.stringify(signed.vote.envelope, null, 2)}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
