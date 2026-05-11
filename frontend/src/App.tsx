import { useEffect, useState } from 'react';
import {
  BACKEND_URL,
  EIGEN_APP_ID,
  getAttestation,
  getProfile,
  resetDemo,
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

// Parse a comma-separated space list from a public env var. Same shape as
// the helper in pages/Policy.tsx and the backend's parseSpaceList — kept
// inline here to avoid a shared util file for a 4-line function.
function parseSpaceList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

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
  wallet: WalletInfo | null;
  env: Record<string, string> | null;
  attestation: AttestationStub | null;
};

type BackendErrors = {
  wallet?: string;
  env?: string;
  attestation?: string;
};

function useBackendInfo() {
  const [info, setInfo] = useState<BackendInfo | null>(null);
  const [errors, setErrors] = useState<BackendErrors>({});
  const [version, setVersion] = useState(0);
  // Each backend probe is independent — attestation is the most likely to
  // fail (TEE bring-up issues), and we don't want one failure to blank the
  // wallet + env panels too. Promise.allSettled lets each piece settle
  // independently; consumers handle nulls.
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([getWallet(), getPublicEnv(), getAttestation()]).then(
      ([walletR, envR, attR]) => {
        if (cancelled) return;
        const nextErrors: BackendErrors = {};
        if (walletR.status === 'rejected') nextErrors.wallet = String(walletR.reason);
        if (envR.status === 'rejected') nextErrors.env = String(envR.reason);
        if (attR.status === 'rejected') nextErrors.attestation = String(attR.reason);
        setErrors(nextErrors);
        setInfo({
          wallet: walletR.status === 'fulfilled' ? walletR.value : null,
          env: envR.status === 'fulfilled' ? envR.value : null,
          attestation: attR.status === 'fulfilled' ? attR.value : null,
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  // Backward compatible single-string error: only set when EVERY probe failed
  // (true reachability problem). Partial failures surface via `errors`.
  const allFailed = !!errors.wallet && !!errors.env && !!errors.attestation;
  const error = allFailed ? `Cannot reach backend at ${BACKEND_URL}` : null;

  return { info, error, errors, retry: () => setVersion((v) => v + 1) };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function Dashboard({ tab }: { tab: Tab }) {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [demoProgress, setDemoProgress] = useState(() => readDemoProgress());
  const [demoResetVersion, setDemoResetVersion] = useState(0);
  const { info, error, errors, retry } = useBackendInfo();

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

  function markLiveInferenceRun() {
    setDemoProgress((prev) => {
      const next = { ...prev, liveInferenceRun: true };
      writeDemoProgress(next);
      return next;
    });
  }

  async function resetDemoProgress() {
    const confirmed = window.confirm(
      'Reset demo? This wipes your votes and policy versions, then seeds the demo profile (DEMO_PROFILE) so the four-step ACT 2 peel produces deterministic flips. Your wallet session stays signed in.',
    );
    if (!confirmed) return;

    const next = { liveInferenceRun: false };
    writeDemoProgress(next);
    if (auth.status === 'authed') {
      clearRecentActivity(auth.address);
      const token = getStoredToken();
      if (token) {
        try {
          await resetDemo(token);
          const fresh = await getProfile(token);
          setProfile(fresh);
        } catch (e: any) {
          alert(`Demo reset failed: ${e?.message ?? String(e)}`);
          return;
        }
      }
    }
    setDemoProgress(next);
    setDemoResetVersion((v) => v + 1);
  }

  const hasProfile = !!profile?.profile;
  const profileReady = profileLoaded || auth.status === 'anonymous';
  const attestationReady = info?.attestation?.status === 'available';

  // Derived once and threaded to every consumer that needs to fan across
  // the allowlisted DAOs (Activity, Proposals, Policy → SignAndVerifyCard,
  // Policy → AutopilotRunCard). publicEnv exposes the primary DAO directly
  // and the comma-separated fallback list.
  const primaryDaoSpace = info?.env?.DAO_SPACE_PUBLIC ?? null;
  const fallbackDaoSpaces = parseSpaceList(info?.env?.SNAPSHOT_FALLBACK_SPACES_PUBLIC);

  return (
    <div className="dash">
      <TopBar
        auth={auth}
        onSignIn={handleSignIn}
        onSignOut={handleSignOut}
        info={info}
        currentTab={tab}
      />
      <TrustRibbon info={info} error={error} errors={errors} onRetry={retry} />

      <main className="dash-main">
        <DemoGuide
          auth={auth}
          hasProfile={hasProfile}
          profileLoaded={profileReady}
          liveInferenceRun={demoProgress.liveInferenceRun}
          attestationReady={attestationReady}
          currentTab={tab}
          verifyUrl={eigenVerifyUrl(info?.env ?? {})}
          onSignIn={handleSignIn}
          onReset={resetDemoProgress}
        />

        {auth.status === 'loading' && <p className="muted">Resuming session…</p>}

        {auth.status !== 'loading' && tab === 'activity' && (
          <Activity
            key={`activity-${demoResetVersion}`}
            auth={auth}
            hasProfile={hasProfile}
            onSignIn={handleSignIn}
            daoSpace={primaryDaoSpace}
            fallbackSpaces={fallbackDaoSpaces}
          />
        )}

        {auth.status !== 'loading' && tab === 'proposals' && (
          <Proposals
            key={`proposals-${demoResetVersion}`}
            auth={auth}
            hasProfile={hasProfile}
            profileLoaded={profileReady}
            onSignIn={handleSignIn}
            demoLivePending={!demoProgress.liveInferenceRun}
            onLiveTeeRun={markLiveInferenceRun}
            daoSpace={primaryDaoSpace}
            fallbackSpaces={fallbackDaoSpaces}
          />
        )}

        {auth.status !== 'loading' && tab === 'policy' && (
          <Policy
            auth={auth}
            profile={profile}
            profileLoaded={profileReady}
            onProfileSaved={handleProfileSaved}
            onEdit={handleEditProfile}
            onSignIn={handleSignIn}
            attestation={info?.attestation ?? null}
            publicEnv={info?.env ?? null}
            agentWallet={info?.wallet ?? null}
            verifyUrl={eigenVerifyUrl(info?.env ?? {})}
          />
        )}
      </main>

      <DashFooter info={info} error={error} />
    </div>
  );
}

type DemoProgress = {
  liveInferenceRun: boolean;
};

const DEMO_PROGRESS_KEY = 'gov-agent:demo-progress:v1';

function recentActivityKey(address: string): string {
  return `gov-agent:recent-activity:${address.toLowerCase()}`;
}

function readDemoProgress(): DemoProgress {
  try {
    const parsed = JSON.parse(localStorage.getItem(DEMO_PROGRESS_KEY) ?? '{}');
    return { liveInferenceRun: parsed?.liveInferenceRun === true };
  } catch {
    return { liveInferenceRun: false };
  }
}

function writeDemoProgress(progress: DemoProgress) {
  try {
    localStorage.setItem(DEMO_PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Demo progress is cosmetic; ignore storage failures.
  }
}

function clearRecentActivity(address: string) {
  try {
    localStorage.removeItem(recentActivityKey(address));
  } catch {
    // Demo reset is cosmetic; ignore storage failures.
  }
}

function DemoGuide({
  auth,
  hasProfile,
  profileLoaded,
  liveInferenceRun,
  attestationReady,
  currentTab,
  verifyUrl,
  onSignIn,
  onReset,
}: {
  auth: AuthState;
  hasProfile: boolean;
  profileLoaded: boolean;
  liveInferenceRun: boolean;
  attestationReady: boolean;
  currentTab: Tab;
  verifyUrl: string;
  onSignIn: () => void;
  onReset: () => void;
}) {
  const walletDone = auth.status === 'authed';
  const policyDone = walletDone && profileLoaded && hasProfile;
  const liveDone = liveInferenceRun;
  const proofDone = liveDone && attestationReady;
  const doneCount = [walletDone, policyDone, liveDone, proofDone].filter(Boolean).length;

  const steps = [
    {
      label: 'Connect wallet',
      detail: auth.status === 'authed' ? shortAddr(auth.address) : 'SIWE session required',
      done: walletDone,
      action: !walletDone && auth.status !== 'loading'
        ? <button className="btn small primary" onClick={onSignIn}>Connect</button>
        : null,
    },
    {
      label: 'Save policy',
      detail: policyDone ? 'wallet policy active' : walletDone ? 'values + calibration' : 'after wallet connect',
      done: policyDone,
      action: walletDone && !policyDone
        ? <a className="btn small primary" href="#/app/policy">{currentTab === 'policy' ? 'Finish' : 'Open policy'}</a>
        : null,
    },
    {
      label: 'Run live TEE inference',
      detail: liveDone ? 'Eigen proxy call observed' : policyDone ? 'use first proposal card' : 'after policy save',
      done: liveDone,
      action: policyDone && !liveDone
        ? <a className="btn small primary" href="#/app/proposals">{currentTab === 'proposals' ? 'Run on card' : 'Open proposals'}</a>
        : null,
    },
    {
      label: 'Show proof',
      detail: proofDone
        ? 'attestation + image digest ready'
        : liveDone
          ? 'attestation pending'
          : 'after live run',
      done: proofDone,
      // Only surface the Verify link once the attestation report is available;
      // showing it earlier risks the operator clicking through to a verifier
      // that has not yet seen the deployed image digest.
      action: proofDone
        ? <a className="btn small" href={verifyUrl} target="_blank" rel="noreferrer">Verify</a>
        : null,
    },
  ];

  return (
    <section className="demo-guide" aria-label="Demo path">
      <div className="demo-guide-head">
        <div>
          <div className="dft-label">Demo path</div>
          <strong>{doneCount}/4 ready</strong>
        </div>
        <button
          className="link-btn demo-reset"
          onClick={onReset}
          title="Wipe saved policy + voting history and re-run onboarding from scratch"
        >
          Reset demo
        </button>
      </div>
      <div className="demo-guide-steps">
        {steps.map((step, i) => (
          <div
            key={step.label}
            className={`demo-step ${step.done ? 'done' : doneCount === i ? 'current' : 'blocked'}`}
          >
            <span className="demo-step-index">{step.done ? '✓' : i + 1}</span>
            <div className="demo-step-main">
              <span>{step.label}</span>
              <code>{step.detail}</code>
            </div>
            {step.action && <div className="demo-step-action">{step.action}</div>}
          </div>
        ))}
      </div>
    </section>
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
          {info?.env?.DAO_SPACE_PUBLIC && (
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

function TrustRibbon({
  info,
  error,
  errors,
  onRetry,
}: {
  info: BackendInfo | null;
  error: string | null;
  errors: BackendErrors;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="trust-ribbon trust-ribbon-error">
        <span>⚠ Cannot reach backend at {BACKEND_URL}</span>
        <button className="link-btn" onClick={onRetry} style={{ marginLeft: 'auto' }}>
          retry
        </button>
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

  const env = info.env ?? {};
  const wallet = info.wallet;
  const machine = env.EIGEN_MACHINE_TYPE_PUBLIC;
  const isLocal = !machine;
  const partial = errors.wallet || errors.env || errors.attestation;
  const partialBadge = partial ? (
    <span className="muted tiny" style={{ marginLeft: 8 }}>
      {[
        errors.wallet && 'wallet',
        errors.env && 'env',
        errors.attestation && 'attestation',
      ]
        .filter(Boolean)
        .join(' · ')}{' '}
      unavailable ·{' '}
      <button className="link-btn" onClick={onRetry}>
        retry
      </button>
    </span>
  ) : null;

  if (isLocal) {
    return (
      <div className="trust-ribbon trust-ribbon-dev">
        <span className="t-dot warn" />
        <span>
          <strong>Local dev backend</strong> · not running in a TEE · attestation disabled
        </span>
        <span className="muted" style={{ marginLeft: 'auto' }}>
          agent wallet <code>{wallet ? shortAddr(wallet.address) : '—'}</code>
        </span>
        {partialBadge}
      </div>
    );
  }

  const verifyUrl = eigenVerifyUrl(env);
  return (
    <div className="trust-ribbon">
      <span className="t-dot" />
      <span>
        Attested in <strong>EigenCompute TEE</strong> · agent wallet{' '}
        <code>{wallet ? shortAddr(wallet.address) : '—'}</code>
      </span>
      {partialBadge}
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
  // The decoded JWT payload nests submods.container.image_digest one level
  // deeper than the legacy type declared. Older code read it from
  // decoded.submods which always returned undefined silently.
  const imageDigest = attestation?.kms_jwt?.decoded?.payload?.submods?.container?.image_digest;
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
          <ProofItem label="Wallet" value={info?.wallet?.address ? shortAddr(info.wallet.address) : 'loading'} title={info?.wallet?.address} />
          <ProofItem label="Machine" value={machine ?? 'not attested'} />
          <ProofItem label="Commit" value={env.GIT_COMMIT_PUBLIC ? env.GIT_COMMIT_PUBLIC.slice(0, 10) : 'unknown'} title={env.GIT_COMMIT_PUBLIC} />
          <ProofItem label="Model route" value={modelRoute(env, isTee)} />
          <ProofItem label="Model" value={modelLabel(env, isTee)} title={env.MODEL_PUBLIC} />
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

// MODEL_PUBLIC and MODEL_ROUTE_PUBLIC come from the backend's /env response.
// The server derives them from pickModel() at request time, so they always
// reflect what the pipeline would actually use. Local dev with no LLM
// credentials returns nothing — fall back to a neutral label.
function modelLabel(env: Record<string, string>, isTee: boolean): string {
  if (env.MODEL_PUBLIC) return env.MODEL_PUBLIC;
  return isTee ? 'unconfigured' : 'configured';
}

function modelRoute(env: Record<string, string>, isTee: boolean): string {
  if (env.MODEL_ROUTE_PUBLIC) return env.MODEL_ROUTE_PUBLIC;
  return isTee ? 'eigen-proxy' : 'backend default';
}
