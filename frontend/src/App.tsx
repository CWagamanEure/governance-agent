import { useEffect, useState } from 'react';
import {
  BACKEND_URL,
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
          <Proposals auth={auth} onSignIn={handleSignIn} />
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

      <DashFooter info={info} />
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

  return (
    <div className="trust-ribbon">
      <span className="t-dot" />
      <span>
        Attested in <strong>EigenCompute TEE</strong> · agent wallet{' '}
        <code>{shortAddr(info.wallet.address)}</code>
      </span>
      <a
        href="https://verify-sepolia.eigencloud.xyz/app/0xA2090Bc33B35E7b9dD1EEEA86Fc117263Bd1cd9D"
        target="_blank"
        rel="noreferrer"
        className="trust-link"
      >
        verify ↗
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function DashFooter({ info }: { info: BackendInfo | null }) {
  if (!info) return null;
  return (
    <footer className="dash-footer">
      <div className="dash-footer-grid">
        <div>
          <div className="dft-label">Agent wallet</div>
          <code>{info.wallet.address}</code>
        </div>
        <div>
          <div className="dft-label">Source</div>
          <a href="https://github.com/CWagamanEure/governance-agent" target="_blank" rel="noreferrer">
            github.com/CWagamanEure/governance-agent ↗
          </a>
        </div>
        <div>
          <div className="dft-label">Verify</div>
          <a
            href="https://verify-sepolia.eigencloud.xyz/app/0xA2090Bc33B35E7b9dD1EEEA86Fc117263Bd1cd9D"
            target="_blank"
            rel="noreferrer"
          >
            verify-sepolia.eigencloud.xyz ↗
          </a>
        </div>
      </div>
      <p className="tiny" style={{ textAlign: 'center', color: 'var(--fg-soft)', marginTop: 24 }}>
        Open source · alpha · not recommended for customer funds
      </p>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
