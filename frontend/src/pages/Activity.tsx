/**
 * Activity page — pending approvals + recent votes.
 *
 * Real data flows through this page once the background poller is wired
 * and per-user decisions persist. Today it's empty-state shapes that
 * communicate where activity will appear.
 */

import type { ReactNode } from 'react';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authed'; address: string };

export function Activity({
  auth,
  hasProfile,
  onSignIn,
}: {
  auth: AuthState;
  hasProfile: boolean;
  onSignIn: () => void;
}) {
  if (auth.status !== 'authed') {
    return (
      <ConnectGate
        title="Connect your wallet to see activity"
        description="Once you've connected and set your governance preferences, your agent's recommendations and cast votes will appear here."
        onSignIn={onSignIn}
      />
    );
  }

  if (!hasProfile) {
    return (
      <Card>
        <EmptyState
          title="Set your policy first"
          description="Your agent needs to know how you want to vote before it can produce recommendations. Head to Policy to configure your preferences — takes about a minute."
          cta={
            <a className="btn primary" href="#/app/policy">
              Configure policy
            </a>
          }
        />
      </Card>
    );
  }

  return (
    <>
      <SectionHeading>Pending approvals</SectionHeading>
      <Card>
        <EmptyState
          title="No pending decisions"
          description="When a new proposal arrives in your DAO, your agent will analyze it against your policy and post a recommendation here. You'll have until the voting window closes to approve, override, or skip."
        />
      </Card>

      <SectionHeading>Recent activity</SectionHeading>
      <Card>
        <EmptyState
          title="No votes cast yet"
          description="Each cast vote will show up here with the proposal title, your agent's decision, the rules that fired, and a link to the on-chain audit entry."
        />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reusable bits
// ---------------------------------------------------------------------------

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="section-heading">{children}</h2>;
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="card">{children}</div>;
}

export function EmptyState({
  title,
  description,
  cta,
}: {
  title: string;
  description: string;
  cta?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{description}</p>
      {cta && <div className="empty-cta">{cta}</div>}
    </div>
  );
}

export function ConnectGate({
  title,
  description,
  onSignIn,
}: {
  title: string;
  description: string;
  onSignIn: () => void;
}) {
  return (
    <Card>
      <EmptyState
        title={title}
        description={description}
        cta={
          <button className="btn primary" onClick={onSignIn}>
            Connect Wallet
          </button>
        }
      />
    </Card>
  );
}
