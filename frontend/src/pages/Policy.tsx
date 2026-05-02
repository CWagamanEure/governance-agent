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

function ProfileCard({
  profile,
  onEdit,
}: {
  profile: StoredProfile;
  onEdit: () => void;
}) {
  if (!profile.profile) return null;
  const p = profile.profile.profile_json;
  const hard = p.hard_rules ?? {};
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
    </div>
  );
}
