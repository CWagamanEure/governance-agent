/**
 * Policy page — view your saved policy or run onboarding if you haven't yet.
 */

import { type StoredProfile } from '../api';
import { Onboarding } from '../Onboarding';
import { ConnectGate, SectionHeading } from './Activity';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authed'; address: string };

export function Policy({
  auth,
  profile,
  profileLoaded,
  onProfileSaved,
  onEdit,
  onSignIn,
}: {
  auth: AuthState;
  profile: StoredProfile | null;
  profileLoaded: boolean;
  onProfileSaved: () => void;
  onEdit: () => void;
  onSignIn: () => void;
}) {
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

  return (
    <>
      <SectionHeading>Your policy</SectionHeading>
      <ProfileCard profile={profile} onEdit={onEdit} />
    </>
  );
}

const AXIS_LABELS: Record<string, string> = {
  treasury_conservatism: 'Treasury conservatism',
  decentralization_priority: 'Decentralization priority',
  growth_vs_sustainability: 'Sustainability bias',
  protocol_risk_tolerance: 'Risk-aversion',
};

function ProfileCard({
  profile,
  onEdit,
}: {
  profile: StoredProfile;
  onEdit: () => void;
}) {
  if (!profile.profile) return null;
  const p = profile.profile.profile_json;
  const cap = p.max_treasury_usd_auto;
  return (
    <div className="card profile-card">
      <div className="profile-head">
        <div>
          <div className="muted tiny">
            version {profile.profile.version} · hash{' '}
            <code>{profile.profile.hash.slice(0, 10)}…</code>
          </div>
        </div>
        <button onClick={onEdit} className="btn small">
          Edit
        </button>
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

      <div className="axes" style={{ marginTop: Array.isArray(p.stated_values) && p.stated_values.length > 0 ? 18 : 0 }}>
        {Object.entries(AXIS_LABELS).map(([k, label]) => (
          <AxisBar key={k} label={label} value={Number(p[k])} />
        ))}
      </div>

      <div className="profile-meta">
        <div>
          <span className="muted tiny">Auto-approve treasury cap</span>
          <div className="profile-meta-val">
            {cap == null ? '—' : `$${Number(cap).toLocaleString()}`}
          </div>
        </div>
        <div>
          <span className="muted tiny">Always require my review</span>
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
    </div>
  );
}

function AxisBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="axis-row">
      <span className="axis-label">{label}</span>
      <div className="axis-bar">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`axis-pip ${i <= value ? 'on' : ''}`} data-v={i} />
        ))}
      </div>
      <span className="axis-num">{value}/5</span>
    </div>
  );
}
