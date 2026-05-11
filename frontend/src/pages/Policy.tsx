/**
 * Policy page — view your saved policy, edit it directly with live diff
 * feedback, or redo onboarding from scratch.
 */

import { useState } from 'react';
import { type AttestationStub, type StoredProfile, type WalletInfo } from '../api';
import { getStoredToken } from '../lib/auth';
import { Onboarding } from '../Onboarding';
import { PolicyEditor } from '../PolicyEditor';
import { SignAndVerifyCard } from '../SignAndVerifyCard';
import { AutopilotRunCard } from '../AutopilotRunCard';
import { PollerStatusCard } from '../PollerStatusCard';
import { AttestationCard } from '../AttestationCard';
import { ConnectGate, SectionHeading } from './Activity';
import { HashCopyChip } from '../HashCopyChip';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authed'; address: string };

// Mirror of src/server.ts parseSpaceList. Comma-separated, trimmed,
// filters empties. Returns [] for undefined/null input.
function parseSpaceList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
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
    return (
      <>
        <SectionHeading>Set your preferences</SectionHeading>
        <Onboarding onSaved={onProfileSaved} />
      </>
    );
  }

  const token = getStoredToken();

  if (editing && token) {
    const primarySpace = publicEnv?.DAO_SPACE_PUBLIC ?? null;
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
      {token && profile.profile && (
        <div style={{ marginTop: 16 }}>
          <SignAndVerifyCard
            token={token}
            profile={profile.profile}
            daoSpace={publicEnv?.DAO_SPACE_PUBLIC ?? null}
            fallbackSpaces={parseSpaceList(
              publicEnv?.SNAPSHOT_FALLBACK_SPACES_PUBLIC,
            )}
          />
        </div>
      )}
      {token && profile.profile && (
        <div style={{ marginTop: 16 }}>
          <AutopilotRunCard
            token={token}
            profile={profile.profile}
            daoSpace={publicEnv?.DAO_SPACE_PUBLIC ?? null}
            fallbackSpaces={parseSpaceList(
              publicEnv?.SNAPSHOT_FALLBACK_SPACES_PUBLIC,
            )}
          />
        </div>
      )}
      {token && profile.profile && (
        <div style={{ marginTop: 16 }}>
          <PollerStatusCard />
        </div>
      )}
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

      {Array.isArray(p.stated_values) && p.stated_values.length > 0 && (
        <div className="review-section" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
          <div className="dft-label">Stated values</div>
          <ul className="review-values" style={{ marginTop: 6 }}>
            {(p.stated_values as string[]).map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="review-section">
        <div className="dft-label">Routine defaults</div>
        {(p.category_defaults ?? []).length === 0 ? (
          <p className="muted tiny">No category defaults. Unmatched proposals use {p.default_action ?? 'ABSTAIN'}.</p>
        ) : (
          <div className="rules-list" style={{ marginTop: 8 }}>
            {(p.category_defaults as any[]).map((d, i) => (
              <div key={`${d.category}-${i}`} className="rule">
                <span className="id">{d.category}</span>
                <span className="reason">— {d.action}</span>
                {d.max_treasury_usd != null && (
                  <span className="contrib"> under ${Number(d.max_treasury_usd).toLocaleString()}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="profile-meta">
        <div>
          <span className="muted tiny">Default action</span>
          <div className="profile-meta-val">{p.default_action ?? 'ABSTAIN'}</div>
        </div>
        <div>
          <span className="muted tiny">Large treasury review</span>
          <div className="profile-meta-val">
            {p.large_treasury_usd == null ? '—' : `$${Number(p.large_treasury_usd).toLocaleString()}`}
          </div>
        </div>
        <div>
          <span className="muted tiny">Manual review categories</span>
          <div className="profile-meta-val">
            {(p.manual_review_categories ?? []).length} categories
          </div>
        </div>
        <div>
          <span className="muted tiny">Author blocklist</span>
          <div className="profile-meta-val">
            {(p.author_blocklist ?? []).length} addresses
          </div>
        </div>
      </div>

      <div className="review-section">
        <div className="dft-label">Manual review flags</div>
        <p className="tiny muted" style={{ fontFamily: 'var(--mono)', lineHeight: 1.8 }}>
          {(p.manual_review_flags ?? []).join(' · ') || 'none'}
        </p>
      </div>

      {(p.delegation_rules ?? []).length > 0 && (
        <div className="review-section">
          <div className="dft-label">Delegation</div>
          <div className="rules-list" style={{ marginTop: 8 }}>
            {(p.delegation_rules as any[]).map((d, i) => (
              <div key={`${d.category}-${d.delegate}-${i}`} className="rule">
                <span className="id">{d.category}</span>
                <span className="reason">— follow {d.delegate}</span>
                <span className="contrib"> fallback {d.fallback}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="review-section">
        <div className="dft-label">Hard limits</div>
        <p className="tiny muted">
          Single recipient cap:{' '}
          {hard.max_single_recipient_treasury_usd == null
            ? '—'
            : `$${Number(hard.max_single_recipient_treasury_usd).toLocaleString()}`}
          {' · '}
          Emission increases: {hard.vote_against_emission_increases ? 'AGAINST' : 'allowed by defaults'}
        </p>
      </div>

      <AutopilotRow autopilot={p.autopilot} />
    </div>
  );
}

function AutopilotRow({
  autopilot,
}: {
  autopilot:
    | { enabled?: boolean; min_confidence?: number }
    | undefined;
}) {
  const enabled = autopilot?.enabled === true;
  const floor = typeof autopilot?.min_confidence === 'number' ? autopilot.min_confidence : 0.85;
  return (
    <div className="review-section">
      <div className="dft-label">Autopilot</div>
      <p className={`tiny ${enabled ? '' : 'muted'}`}>
        Status:{' '}
        <strong style={{ color: enabled ? 'var(--good, #6cd07a)' : 'var(--fg-soft)' }}>
          {enabled ? 'enabled' : 'disabled'}
        </strong>
        {' · '}
        Confidence floor: <code>{floor.toFixed(2)}</code>
      </p>
    </div>
  );
}
