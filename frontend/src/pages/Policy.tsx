/**
 * Policy page — view your saved policy, edit it directly with live diff
 * feedback, or redo onboarding from scratch.
 */

import { useState } from 'react';
import { type AttestationStub, type StoredProfile, type WalletInfo } from '../api';
import { getStoredToken } from '../lib/auth';
import { Onboarding } from '../Onboarding';
import { PolicyEditor } from '../PolicyEditor';
import { AttestationCard } from '../AttestationCard';
import { ConnectGate, SectionHeading } from './Activity';
import { HashCopyChip } from '../HashCopyChip';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authed'; address: string };

// Mirror of src/submit-allowlist.ts parseSpaceList. Comma-separated,
// trimmed + lowercased to match the canonical space-id form the
// backend uses everywhere (SUBMIT_ALLOWLIST is normalized this way,
// and /profile save lowercases followed_spaces). Returns [] for
// undefined/null input.
function parseSpaceList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function Policy({
  auth,
  profile,
  profileLoaded,
  onProfileSaved,
  onEdit,
  onSignIn,
  attestation,
  publicEnv,
  agentWallet,
  verifyUrl,
}: {
  auth: AuthState;
  profile: StoredProfile | null;
  profileLoaded: boolean;
  onProfileSaved: () => void;
  onEdit: () => void;
  onSignIn: () => void;
  attestation: AttestationStub | null;
  publicEnv: Record<string, string> | null;
  agentWallet: WalletInfo | null;
  verifyUrl: string;
}) {
  const [editing, setEditing] = useState(false);

  if (auth.status !== 'authed') {
    return (
      <ConnectGate
        title="Connect to set your governance policy"
        description="Your policy is stored as a versioned profile keyed to your wallet. Only the wallet you sign in with can update it."
        onSignIn={onSignIn}
      />
    );
  }

  if (!profileLoaded) {
    return <p className="muted">Loading…</p>;
  }

  if (!profile?.profile) {
    const primarySpace = publicEnv?.DAO_SPACE_PUBLIC
      ? publicEnv.DAO_SPACE_PUBLIC.trim().toLowerCase()
      : null;
    const fallbackSpaces = parseSpaceList(publicEnv?.SNAPSHOT_FALLBACK_SPACES_PUBLIC);
    const allowlistedSpaces = [
      ...(primarySpace ? [primarySpace] : []),
      ...fallbackSpaces.filter((s) => s !== primarySpace),
    ];
    return (
      <>
        <SectionHeading>Set your preferences</SectionHeading>
        <Onboarding
          onSaved={onProfileSaved}
          allowlistedSpaces={allowlistedSpaces}
        />
      </>
    );
  }

  const token = getStoredToken();

  if (editing && token) {
    const primarySpace = publicEnv?.DAO_SPACE_PUBLIC
      ? publicEnv.DAO_SPACE_PUBLIC.trim().toLowerCase()
      : null;
    const fallbackSpaces = parseSpaceList(publicEnv?.SNAPSHOT_FALLBACK_SPACES_PUBLIC);
    const allowlistedSpaces = [
      ...(primarySpace ? [primarySpace] : []),
      ...fallbackSpaces.filter((s) => s !== primarySpace),
    ];
    return (
      <>
        <SectionHeading>Edit policy</SectionHeading>
        <PolicyEditor
          // Force a fresh editor instance whenever the saved profile id
          // changes so stale draft, banner, or preview state from the prior
          // version cannot leak across a save. Today the parent flips
          // `editing` to false on save so this is defensive; if the editor
          // ever stays mounted across saves, this prevents drift.
          key={profile.profile.id}
          token={token}
          baseProfile={profile.profile}
          allowlistedSpaces={allowlistedSpaces}
          onSaved={() => {
            setEditing(false);
            onProfileSaved();
          }}
          onCancel={() => setEditing(false)}
        />
      </>
    );
  }

  return (
    <>
      <SectionHeading>Your policy</SectionHeading>
      <ProfileCard
        profile={profile}
        onEditRules={() => setEditing(true)}
        onRecompile={onEdit}
      />
      <div style={{ marginTop: 16 }}>
        <AttestationCard
          attestation={attestation}
          publicEnv={publicEnv ?? {}}
          walletAddress={agentWallet?.address ?? null}
          verifyUrl={verifyUrl}
        />
      </div>
    </>
  );
}

function ProfileCard({
  profile,
  onEditRules,
  onRecompile,
}: {
  profile: StoredProfile;
  onEditRules: () => void;
  onRecompile: () => void;
}) {
  if (!profile.profile) return null;
  const p = profile.profile.profile_json;
  const hard = p.hard_rules ?? {};

  const ap = p.autopilot ?? { enabled: false, min_confidence: 0.85 };
  const apEnabled = ap.enabled === true;
  const apFloor = typeof ap.min_confidence === 'number' ? ap.min_confidence : 0.85;

  const followed = Array.isArray(p.followed_spaces) ? (p.followed_spaces as string[]) : [];
  const stated = Array.isArray(p.stated_values) ? (p.stated_values as string[]) : [];
  const categoryDefaults = Array.isArray(p.category_defaults) ? (p.category_defaults as any[]) : [];
  const delegationRules = Array.isArray(p.delegation_rules) ? (p.delegation_rules as any[]) : [];
  const reviewCats = Array.isArray(p.manual_review_categories) ? (p.manual_review_categories as string[]) : [];
  const reviewFlags = Array.isArray(p.manual_review_flags) ? (p.manual_review_flags as string[]) : [];

  return (
    <div className="card profile-card">
      <div className="profile-head">
        <div className="profile-head-meta">
          <span className="profile-version-pill">v{profile.profile.version}</span>
          <span className="muted tiny">hash</span>
          <HashCopyChip hash={profile.profile.hash} label="policy hash" />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onRecompile} className="btn small" title="Restart onboarding from your values">
            Redo onboarding
          </button>
          <button onClick={onEditRules} className="btn small primary" title="Edit rules directly with live diff feedback">
            Edit rules
          </button>
        </div>
      </div>

      <div className={`profile-autopilot-pill ${apEnabled ? 'on' : 'off'}`}>
        <span className="profile-autopilot-pill-label">AUTOPILOT</span>
        <strong>{apEnabled ? 'enabled' : 'disabled'}</strong>
        <span className="profile-autopilot-pill-sep">·</span>
        <span>
          floor <code>{apFloor.toFixed(2)}</code>
        </span>
        <span className="profile-autopilot-pill-sep">·</span>
        <span>
          {followed.length} DAO{followed.length === 1 ? '' : 's'} followed
        </span>
      </div>

      <div className="profile-columns">
        <div className="profile-column">
          <h5 className="profile-column-head">How it votes</h5>
          <div className="profile-row">
            <span className="profile-row-label">Default action</span>
            <span className="profile-row-val">{p.default_action ?? 'ABSTAIN'}</span>
          </div>
          <div className="profile-row profile-row-block">
            <span className="profile-row-label">
              Routine defaults ({categoryDefaults.length})
            </span>
            {categoryDefaults.length === 0 ? (
              <span className="profile-row-empty">none</span>
            ) : (
              <ul className="profile-rule-list">
                {categoryDefaults.map((d, i) => (
                  <li key={`${d.category}-${i}`}>
                    <code>{d.category}</code> → {d.action}
                    {d.max_treasury_usd != null && (
                      <span className="muted"> under ${Number(d.max_treasury_usd).toLocaleString()}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="profile-row profile-row-block">
            <span className="profile-row-label">
              Delegation ({delegationRules.length})
            </span>
            {delegationRules.length === 0 ? (
              <span className="profile-row-empty">none</span>
            ) : (
              <ul className="profile-rule-list">
                {delegationRules.map((d, i) => (
                  <li key={`${d.category}-${d.delegate}-${i}`}>
                    <code>{d.category}</code> → follow {d.delegate}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="profile-column">
          <h5 className="profile-column-head">When it stops</h5>
          <div className="profile-row">
            <span className="profile-row-label">Manual review</span>
            <span
              className="profile-row-val"
              title={`Categories: ${reviewCats.join(', ') || 'none'}\nFlags: ${reviewFlags.join(', ') || 'none'}`}
            >
              {reviewCats.length} categories · {reviewFlags.length} flags
            </span>
          </div>
          <div className="profile-row">
            <span className="profile-row-label">Large treasury threshold</span>
            <span className="profile-row-val">
              {p.large_treasury_usd == null
                ? '—'
                : `$${Number(p.large_treasury_usd).toLocaleString()}`}
            </span>
          </div>
          <div className="profile-row">
            <span className="profile-row-label">Single-recipient cap</span>
            <span className="profile-row-val">
              {hard.max_single_recipient_treasury_usd == null
                ? '—'
                : `$${Number(hard.max_single_recipient_treasury_usd).toLocaleString()}`}
            </span>
          </div>
          <div className="profile-row">
            <span className="profile-row-label">Emission increases</span>
            <span className="profile-row-val">
              {hard.vote_against_emission_increases ? 'AGAINST' : 'allowed by defaults'}
            </span>
          </div>
        </div>
      </div>

      {stated.length > 0 && (
        <details className="profile-values-toggle">
          <summary>
            {stated.length} stated value{stated.length === 1 ? '' : 's'}
          </summary>
          <ul className="profile-values-list">
            {stated.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
