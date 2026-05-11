/**
 * Trust page — the verifiable sign / verify / submit loop.
 *
 * One screen, one purpose: show the user (or a stage reviewer) that
 * the TEE-bound wallet produces a signed decision blob that anyone
 * can independently replay off the cached extraction. This is the
 * demo's ACT 5 surface — kept on a dedicated tab so the Policy page
 * stays focused on "what your policy is" instead of mixing in the
 * cryptographic-proof loop.
 *
 * The actual sign/verify/submit UI lives in ../SignAndVerifyCard.
 * This page is a thin wrapper that supplies the same props the old
 * Policy-page mount did (token, profile, daoSpace, fallbackSpaces).
 */

import { type StoredProfile } from '../api';
import { getStoredToken } from '../lib/auth';
import { SignAndVerifyCard } from '../SignAndVerifyCard';
import { ConnectGate, EmptyState, SectionHeading, Card } from './Activity';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authed'; address: string };

export function Trust({
  auth,
  profile,
  profileLoaded,
  onSignIn,
  daoSpace,
  fallbackSpaces,
}: {
  auth: AuthState;
  profile: StoredProfile | null;
  profileLoaded: boolean;
  onSignIn: () => void;
  daoSpace: string | null;
  fallbackSpaces: string[];
}) {
  if (auth.status !== 'authed') {
    return (
      <ConnectGate
        title="Connect to use the trust loop"
        description="Signing happens inside the attested TEE with a wallet derived for your address. Sign in to drive the sign / verify / submit flow yourself."
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
        <SectionHeading>Trust path</SectionHeading>
        <Card>
          <EmptyState
            title="Set your policy first"
            description="The trust loop signs decisions against your saved policy hash. Configure your policy before running the sign / verify / submit demo."
            cta={
              <a className="btn primary" href="#/app/policy">
                Configure policy
              </a>
            }
          />
        </Card>
      </>
    );
  }

  const token = getStoredToken();
  if (!token) {
    return <p className="muted">Session expired — sign in again.</p>;
  }

  return (
    <>
      <SectionHeading>Trust path</SectionHeading>
      <SignAndVerifyCard
        token={token}
        profile={profile.profile}
        daoSpace={daoSpace}
        fallbackSpaces={fallbackSpaces}
      />
    </>
  );
}
