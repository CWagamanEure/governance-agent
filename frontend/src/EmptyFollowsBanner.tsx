/**
 * Banner rendered on Activity / Proposals when the authed user has a
 * saved policy but no DAOs in followed_spaces.
 *
 * The empty state is intentional (F2 removed the implicit pre-fill
 * that used to auto-watch every allowlisted DAO), so the user needs a
 * loud signal that autopilot will not do anything until they pick at
 * least one DAO in the policy editor.
 *
 * Rendered above the section content so it's the first thing the
 * user sees on either page. Hidden when followed_spaces is non-empty
 * or when the user hasn't saved a profile yet (the page already
 * routes those through ConnectGate / Onboarding).
 */

export function EmptyFollowsBanner({
  followedSpacesCount,
  hasProfile,
}: {
  followedSpacesCount: number | null;
  hasProfile: boolean;
}) {
  if (!hasProfile) return null;
  if (followedSpacesCount === null || followedSpacesCount > 0) return null;
  return (
    <div className="empty-follows-banner">
      <strong>You are not following any DAOs.</strong>{' '}
      Pick at least one in the policy editor so the agent can watch them.{' '}
      <a className="btn small primary" href="#/app/policy">
        Open policy
      </a>
    </div>
  );
}
