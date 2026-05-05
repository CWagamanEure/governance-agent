import { useEffect, useState } from 'react';
import {
  BACKEND_URL,
  EIGEN_APP_ID,
  getAttestation,
  getProfile,
  getPublicEnv,
  getWallet,
  type AttestationStub,
  type StoredProfile,
  type WalletInfo,
} from './api';
import {
  checkSession,
  clearStoredAuth,
  getStoredToken,
  signInWithEthereum,
} from './lib/auth';
import { Landing } from './Landing';
import { WalletButton } from './WalletButton';
import { DaoPicker } from './DaoPicker';
import { Activity } from './pages/Activity';
import { Proposals } from './pages/Proposals';
import { Policy } from './pages/Policy';

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type Tab = 'activity' | 'proposals' | 'policy';

function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

function tabFromHash(hash: string): Tab {
  if (hash.startsWith('#/app/proposals')) return 'proposals';
  if (hash.startsWith('#/app/policy')) return 'policy';
  return 'activity';
}

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authed'; address: string };

export function App() {
  const route = useHashRoute();
  const isApp = route.startsWith('#/app');
  if (!isApp) return <Landing />;
  return <Dashboard tab={tabFromHash(route)} />;
}

// ---------------------------------------------------------------------------
// Backend snapshot (used by top bar + trust ribbon)
// ---------------------------------------------------------------------------

type BackendInfo = {
  wallet: WalletInfo;
  env: Record<string, string>;
  attestation: AttestationStub;
};

function useBackendInfo() {
  const [info, setInfo] = useState<BackendInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([getWallet(), getPublicEnv(), getAttestation()])
      .then(([wallet, env, attestation]) => setInfo({ wallet, env, attestation }))
      .catch((e) => setError(String(e)));
  }, []);
  return { info, error };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function Dashboard({ tab }: { tab: Tab }) {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const { info, error } = useBackendInfo();

  useEffect(() => {
    (async () => {
      const sess = await checkSession();
      if (sess) setAuth({ status: 'authed', address: sess.address });
      else setAuth({ status: 'anonymous' });
    })();
  }, []);

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

  function handleProfileSaved() {
    const token = getStoredToken();
    if (token) getProfile(token).then((p) => setProfile(p));
  }

  function handleEditProfile() {
    if (profile) setProfile({ ...profile, profile: null });
  }

  return (
    <div className="dash">
      <TopBar
        auth={auth}
        onSignIn={handleSignIn}
        onSignOut={handleSignOut}
        info={info}
        currentTab={tab}
      />
      <TrustRibbon info={info} error={error} />

      <main className="dash-main">
        {auth.status === 'loading' && <p className="muted">Resuming session…</p>}

        {auth.status !== 'loading' && tab === 'activity' && (
          <Activity
            auth={auth}
            hasProfile={!!profile?.profile}
            onSignIn={handleSignIn}
          />
        )}

        {auth.status !== 'loading' && tab === 'proposals' && (
          <Proposals
            auth={auth}
            hasProfile={!!profile?.profile}
            profileLoaded={profileLoaded || auth.status === 'anonymous'}
            onSignIn={handleSignIn}
          />
        )}

        {auth.status !== 'loading' && tab === 'policy' && (
          <Policy
            auth={auth}
            profile={profile}
            profileLoaded={profileLoaded || auth.status === 'anonymous'}
            onProfileSaved={handleProfileSaved}
            onEdit={handleEditProfile}
            onSignIn={handleSignIn}
          />
        )}
      </main>

      <DashFooter info={info} error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top bar with nav tabs
// ---------------------------------------------------------------------------

const TABS: { id: Tab; label: string; href: string }[] = [
  { id: 'activity',  label: 'Activity',  href: '#/app/activity' },
  { id: 'proposals', label: 'Proposals', href: '#/app/proposals' },
  { id: 'policy',    label: 'Policy',    href: '#/app/policy' },
];

function TopBar({
  auth,
  onSignIn,
  onSignOut,
  info,
  currentTab,
}: {
  auth: AuthState;
  onSignIn: () => void;
  onSignOut: () => void;
  info: BackendInfo | null;
  currentTab: Tab;
}) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <a href="#/" className="brand-link">
            Governance Agent
          </a>
          {info?.env.DAO_SPACE_PUBLIC && (
            <DaoPicker selected={info.env.DAO_SPACE_PUBLIC} />
          )}
        </div>

        <nav className="dash-tabs">
          {TABS.map((t) => (
            <a
              key={t.id}
              href={t.href}
              className={`dash-tab ${t.id === currentTab ? 'active' : ''}`}
            >
              {t.label}
            </a>
          ))}
        </nav>

        <div className="topbar-right">
          <WalletButton auth={auth} onSignIn={onSignIn} onSignOut={onSignOut} />
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Trust ribbon
// ---------------------------------------------------------------------------

function TrustRibbon({ info, error }: { info: BackendInfo | null; error: string | null }) {
  if (error) {
    return (
      <div className="trust-ribbon trust-ribbon-error">
        <span>⚠ Cannot reach backend at {BACKEND_URL}</span>
      </div>
    );
  }
  if (!info) {
    return (
      <div className="trust-ribbon">
        <span className="muted">loading attestation…</span>
      </div>
    );
  }

  const machine = info.env.EIGEN_MACHINE_TYPE_PUBLIC;
  const isLocal = !machine;

  if (isLocal) {
    return (
      <div className="trust-ribbon trust-ribbon-dev">
        <span className="t-dot warn" />
        <span>
          <strong>Local dev backend</strong> · not running in a TEE · attestation disabled
        </span>
        <span className="muted" style={{ marginLeft: 'auto' }}>
          agent wallet <code>{shortAddr(info.wallet.address)}</code>
        </span>
      </div>
    );
  }

  const verifyUrl = eigenVerifyUrl(info.env);
  return (
    <div className="trust-ribbon">
      <span className="t-dot" />
      <span>
        Attested in <strong>EigenCompute TEE</strong> · agent wallet{' '}
        <code>{shortAddr(info.wallet.address)}</code>
      </span>
      <a
        href={verifyUrl}
        target="_blank"
        rel="noreferrer"
        className="trust-link"
      >
        verify ↗
      </a>
    </div>
  );
}

function TEEProofPanel({ info, error }: { info: BackendInfo | null; error: string | null }) {
  if (error) return null;

  const env = info?.env ?? {};
  const attestation = info?.attestation;
  const machine = env.EIGEN_MACHINE_TYPE_PUBLIC;
  const isTee = Boolean(machine);
  const evidenceOk = attestation?.bound_evidence?.ok;
  const kmsOk = attestation?.kms_jwt?.ok;
  const imageDigest = attestation?.kms_jwt?.decoded?.submods?.container?.image_digest;
  const appId = eigenAppId(env);
  const verifyUrl = eigenVerifyUrl(env);
  const attestationLabel = attestation
    ? `${attestation.status}${evidenceOk === false || kmsOk === false ? ' · check failed' : ' · evidence ok'}`
    : 'loading';

  return (
    <section className="tee-proof">
      <div className="tee-proof-inner">
        <div className="tee-proof-title">
          <span className={`t-dot ${isTee ? '' : 'warn'}`} />
          <div>
            <div className="dft-label">TEE proof</div>
            <strong>{isTee ? 'Eigen mainnet-alpha' : 'Local backend'}</strong>
          </div>
        </div>

        <div className="tee-proof-grid">
          <ProofItem label="App ID" value={shortAddr(appId)} title={appId} />
          <ProofItem label="Wallet" value={info?.wallet.address ? shortAddr(info.wallet.address) : 'loading'} title={info?.wallet.address} />
          <ProofItem label="Machine" value={machine ?? 'not attested'} />
          <ProofItem label="Commit" value={env.GIT_COMMIT_PUBLIC ? env.GIT_COMMIT_PUBLIC.slice(0, 10) : 'unknown'} title={env.GIT_COMMIT_PUBLIC} />
          <ProofItem label="Model route" value={isTee ? 'eigen-proxy' : 'backend default'} />
          <ProofItem label="Model" value={isTee ? 'claude-sonnet-4.6' : 'configured'} />
          <ProofItem label="Attestation" value={attestationLabel} title={imageDigest} />
          <a
            className="proof-item proof-item-link"
            href="https://github.com/CWagamanEure/governance-agent"
            target="_blank"
            rel="noreferrer"
          >
            <span>Source</span>
            <code>GitHub ↗</code>
          </a>
        </div>

        <a href={verifyUrl} target="_blank" rel="noreferrer" className="trust-link tee-proof-link">
          verify ↗
        </a>
      </div>
    </section>
  );
}

function ProofItem({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="proof-item" title={title}>
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function DashFooter({ info, error }: { info: BackendInfo | null; error: string | null }) {
  return (
    <footer className="dash-footer">
      <TEEProofPanel info={info} error={error} />
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function eigenAppId(env: Record<string, string>): string {
  return env.EIGEN_APP_ID_PUBLIC || EIGEN_APP_ID;
}

function eigenVerifyUrl(env: Record<string, string>): string {
  return `https://verify.eigencloud.xyz/app/${eigenAppId(env)}`;
}
