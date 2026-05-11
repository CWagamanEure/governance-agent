/**
 * Proposals page — list of active proposals across every allowlisted DAO,
 * with the agent's recommendation per row. Visible to both authed and
 * anonymous users. Anonymous users get a clearly labeled default-policy
 * preview; connected users must configure a policy before recommendations
 * run.
 *
 * Multi-DAO: scans the primary DAO + every fallback space in parallel
 * (Promise.allSettled, per-space rejections do not block others), then
 * caps the total number of rendered cards to keep live LLM extraction
 * cost bounded.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  fetchSnapshotProposal,
  fetchActiveProposals,
  runPipeline,
  type PipelineResult,
} from '../api';
import { getStoredToken } from '../lib/auth';
import { suggestedVoteLabel, suggestedVoteMeta } from '../lib/decision';
import { DaoBadge } from '../DaoBadge';
import { EmptyFollowsBanner } from '../EmptyFollowsBanner';
import { Card, ConnectGate, EmptyState, SectionHeading } from './Activity';

// Per-space cap on how many active proposals we scan. Snapshot's query
// limit per call, so worst case is ACTIVE_LIMIT_PER_SPACE × allowlisted
// DAOs cards on screen. We do not impose a separate render cap — the page
// scrolls. Each rendered card may kick off one live LLM extraction if no
// cache row exists.
const ACTIVE_LIMIT_PER_SPACE = 3;

// Match the shape Activity writes to localStorage. We pull submission too
// so the badge can distinguish "signed but not submitted" from "voted on
// Snapshot" without re-reading the entry.
type MinimalActivityEntry = {
  proposal_id: string;
  signed_choice: number;
  submission: { ok: boolean } | null;
};

function loadActivityFor(address: string | null): MinimalActivityEntry[] {
  if (!address) return [];
  try {
    const raw = localStorage.getItem(`gov-agent:recent-activity:${address.toLowerCase()}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r: any) => ({
        proposal_id: String(r?.proposal_id ?? ''),
        signed_choice: Number(r?.signed_choice ?? 0),
        submission: r?.submission ?? null,
      }))
      .filter((r) => r.proposal_id && r.signed_choice);
  } catch {
    return [];
  }
}

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authed'; address: string };

type ActiveItem = { space: string; id: string };

export function Proposals({
  auth,
  hasProfile,
  profileLoaded,
  followedSpacesCount,
  onSignIn,
  daoSpace,
  fallbackSpaces,
}: {
  auth: AuthState;
  hasProfile: boolean;
  profileLoaded: boolean;
  followedSpacesCount: number | null;
  onSignIn: () => void;
  daoSpace: string | null;
  fallbackSpaces: string[];
}) {
  const [activeItems, setActiveItems] = useState<ActiveItem[] | null>(null);
  const [activeError, setActiveError] = useState<string | null>(null);

  // Live-fetch active proposals across primary + every fallback space in
  // parallel. Per-space errors are isolated (.catch returns []) so one
  // slow or broken space does not blank the page.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const spacesToScan = [
        ...(daoSpace ? [daoSpace] : []),
        ...fallbackSpaces.filter((s) => s !== daoSpace),
      ];
      if (spacesToScan.length === 0) {
        if (!cancelled) setActiveItems([]);
        return;
      }
      try {
        const perSpace = await Promise.all(
          spacesToScan.map((space) =>
            fetchActiveProposals(space, ACTIVE_LIMIT_PER_SPACE)
              .then((items) => items.map((p) => ({ space, id: p.id })))
              .catch(() => [] as ActiveItem[]),
          ),
        );
        if (cancelled) return;
        // Round-robin across spaces so the first rendered cards aren't all
        // from the same DAO. No total cap — the page scrolls.
        const interleaved: ActiveItem[] = [];
        const maxPerSpace = Math.max(...perSpace.map((p) => p.length), 0);
        for (let i = 0; i < maxPerSpace; i++) {
          for (const slot of perSpace) {
            if (slot[i]) interleaved.push(slot[i]);
          }
        }
        setActiveItems(interleaved);
      } catch (e: any) {
        if (!cancelled) {
          setActiveError(e?.message ?? String(e));
          setActiveItems([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [daoSpace, fallbackSpaces.join(',')]);

  // Pull recent-activity entries for the authed user (if any) so each
  // ProposalCard can show "you signed X" if the user already acted on it
  // via the Activity tab.
  const userAddress = auth.status === 'authed' ? auth.address : null;
  const recommendationsEnabled = auth.status !== 'authed' || (profileLoaded && hasProfile);
  const recommendationMode =
    auth.status === 'anonymous' ? 'default' : recommendationsEnabled ? 'saved' : 'paused';
  const userSignedById = useMemo(() => {
    const entries = loadActivityFor(userAddress);
    const map: Record<string, MinimalActivityEntry> = {};
    for (const e of entries) {
      if (!map[e.proposal_id]) map[e.proposal_id] = e;
    }
    return map;
  }, [userAddress]);

  const scannedSpaces = useMemo(
    () => [
      ...(daoSpace ? [daoSpace] : []),
      ...fallbackSpaces.filter((s) => s !== daoSpace),
    ],
    [daoSpace, fallbackSpaces],
  );

  if (auth.status === 'anonymous') {
    return (
      <>
        <ConnectGate
          title="Connect wallet to use your own policy"
          description="Without sign-in, the agent uses its default policy and signs with the app-wide wallet. Connect to set your own preferences and have the agent sign with a wallet derived for you."
          onSignIn={onSignIn}
        />

        <SectionHeading>Live preview</SectionHeading>
        <ProposalsListNote
          activeItems={activeItems}
          activeError={activeError}
          recommendationMode={recommendationMode}
          scannedSpaces={scannedSpaces}
        />
        <div className="proposals">
          {(activeItems ?? []).map((p) => (
            <ProposalCard
              key={`${p.space}:${p.id}`}
              proposalId={p.id}
              space={p.space}
              authed={false}
              recommendationsEnabled={recommendationsEnabled}
              userSigned={null}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <EmptyFollowsBanner
        followedSpacesCount={followedSpacesCount}
        hasProfile={hasProfile}
      />
      <SectionHeading>Active proposals</SectionHeading>
      {auth.status === 'authed' && !profileLoaded && (
        <Card>
          <p className="muted tiny">Loading your policy before running recommendations…</p>
        </Card>
      )}
      {auth.status === 'authed' && profileLoaded && !hasProfile && (
        <Card>
          <EmptyState
            title="Set your policy before recommendations"
            description="The proposals below can still run live TEE extraction, but the agent will not present vote recommendations until your wallet has a saved policy."
            cta={<a className="btn primary" href="#/app/policy">Configure policy</a>}
          />
        </Card>
      )}
      <ProposalsListNote
        activeItems={activeItems}
        activeError={activeError}
        recommendationMode={recommendationMode}
        scannedSpaces={scannedSpaces}
      />
      <div className="proposals">
        {(activeItems ?? []).map((p) => (
          <ProposalCard
            key={`${p.space}:${p.id}`}
            proposalId={p.id}
            space={p.space}
            authed={auth.status === 'authed'}
            recommendationsEnabled={recommendationsEnabled}
            userSigned={userSignedById[p.id] ?? null}
          />
        ))}
      </div>
    </>
  );
}

function ProposalsListNote({
  activeItems,
  activeError,
  recommendationMode,
  scannedSpaces,
}: {
  activeItems: ActiveItem[] | null;
  activeError: string | null;
  recommendationMode: 'default' | 'saved' | 'paused';
  scannedSpaces: string[];
}) {
  if (scannedSpaces.length === 0) {
    return (
      <p className="muted tiny" style={{ marginTop: -4, marginBottom: 16 }}>
        No DAOs configured. Set DAO_SPACE_PUBLIC (and optionally SNAPSHOT_FALLBACK_SPACES_PUBLIC) to scan for active proposals.
      </p>
    );
  }
  if (activeItems === null) {
    return (
      <p className="muted tiny" style={{ marginTop: -4, marginBottom: 16 }}>
        Looking for active proposals across {scannedSpaces.length} DAO{scannedSpaces.length === 1 ? '' : 's'}…
      </p>
    );
  }
  if (activeError) {
    return (
      <p className="muted tiny" style={{ marginTop: -4, marginBottom: 16 }}>
        Snapshot fetch failed ({activeError}).
      </p>
    );
  }
  if (activeItems.length === 0) {
    return (
      <p className="muted tiny" style={{ marginTop: -4, marginBottom: 16 }}>
        No live active proposals across the {scannedSpaces.length} configured DAO{scannedSpaces.length === 1 ? '' : 's'} right now.
      </p>
    );
  }
  // Loaded with items: the cards speak for themselves. No explainer.
  return null;
}

// ---------------------------------------------------------------------------
// Proposal card (extracted from the old Dashboard)
// ---------------------------------------------------------------------------

function ProposalCard({
  proposalId,
  space,
  authed,
  recommendationsEnabled,
  userSigned,
}: {
  proposalId: string;
  space: string;
  authed: boolean;
  recommendationsEnabled: boolean;
  userSigned: MinimalActivityEntry | null;
}) {
  const [proposal, setProposal] = useState<any | null>(null);
  const [pipeline, setPipeline] = useState<PipelineResult | null>(null);
  const [signed, setSigned] = useState<PipelineResult | null>(null);
  const [liveRun, setLiveRun] = useState<PipelineResult | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showDecisionBlob, setShowDecisionBlob] = useState(false);
  const [showEnvelope, setShowEnvelope] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSnapshotProposal(proposalId)
      .then((p) => setProposal(p))
      .catch((e) => setError(`fetch from Snapshot failed: ${e}`));
  }, [proposalId]);

  useEffect(() => {
    if (!proposal || pipeline || !recommendationsEnabled) return;
    setLoading(true);
    runPipeline({
      proposal,
      token: authed ? getStoredToken() : null,
    })
      .then((r) => setPipeline(r))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [proposal, pipeline, authed, recommendationsEnabled]);

  async function runLiveInTee() {
    if (!proposal) return;
    setLiveLoading(true);
    setError(null);
    try {
      const live = await runPipeline({
        proposal,
        token: authed ? getStoredToken() : null,
        force_live_extraction: true,
        extract_only: !recommendationsEnabled,
        preview_default_policy: !recommendationsEnabled,
      });
      setLiveRun(live);
      setSigned(null);

      if (recommendationsEnabled) {
        setPipeline(live);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLiveLoading(false);
    }
  }

  async function castVote() {
    if (!proposal) return;
    setLoading(true);
    try {
      const r = await runPipeline({
        proposal,
        analysis: liveRun?.analysis,
        sign: true,
        token: authed ? getStoredToken() : null,
      });
      setSigned(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  if (error) {
    return (
      <div className="prop-card error">
        <h3>Proposal {proposalId.slice(0, 10)}…</h3>
        <p className="tiny">error: {error}</p>
      </div>
    );
  }
  if (!proposal) {
    return (
      <div className="prop-card">
        <h3 className="muted">{proposalId.slice(0, 10)}…</h3>
        <p className="muted tiny">fetching from Snapshot…</p>
      </div>
    );
  }

  const decision = pipeline?.evaluation?.decision;
  const conf = pipeline?.evaluation?.confidence ?? 0;
  const triggered = pipeline?.evaluation?.triggered_rules ?? [];
  const suggested = pipeline?.evaluation?.suggested_vote ?? null;
  const displayAnalysis = liveRun?.analysis ?? pipeline?.analysis;
  const liveExtraction = liveRun?.extraction;
  const liveOk = liveExtraction?.source === 'live' && !!liveRun?.analysis;
  const manualReviewGate = decision === 'MANUAL_REVIEW' ? triggered[0] : null;

  let actionPill: { label: string; title: string } | null = null;
  if (userSigned) {
    if (userSigned.submission?.ok === true) {
      actionPill = { label: 'voted', title: 'You signed and submitted to Snapshot via Activity' };
    } else if (userSigned.submission?.ok === false) {
      actionPill = { label: 'sign failed', title: 'Snapshot rejected the signed envelope' };
    } else {
      actionPill = { label: 'signed', title: 'You signed via Activity (sign-only, not submitted)' };
    }
  }

  // The multi-DAO scan threads the canonical space through `space`. Snapshot
  // also returns proposal.space?.id which serves as a fallback in case the
  // prop ever drifts.
  const badgeSpace = space || proposal.space?.id || '';

  return (
    <article className="prop-card">
      <header className="prop-head">
        <h3>
          {badgeSpace && <DaoBadge space={badgeSpace} />}{' '}
          {proposal.title ?? proposalId}
        </h3>
        <div className="prop-head-pills">
          {actionPill && (
            <span className="prop-signed" title={actionPill.title}>
              {actionPill.label}
            </span>
          )}
          <span className={`prop-state state-${proposal.state}`}>{proposal.state}</span>
        </div>
      </header>
      <div className="prop-meta">
        <code>{proposal.id.slice(0, 14)}…</code>
      </div>

      {displayAnalysis && (
        <p className="prop-summary">{displayAnalysis.summary}</p>
      )}

      {loading && !pipeline && <p className="muted tiny">running pipeline…</p>}
      {!recommendationsEnabled && !loading && (
        <p className="muted tiny">
          Policy not configured yet. Live TEE extraction is available; vote recommendations unlock after onboarding.
        </p>
      )}

      {liveRun && (
        <div className={`tee-run ${liveOk ? 'tee-run-ok' : 'tee-run-error'}`}>
          <div>
            <span className="dft-label">Live TEE inference</span>
            <div className="tee-run-meta">
              <code>{liveExtraction?.route ?? 'unknown route'}</code>
              <code>{liveExtraction?.modelId ?? 'unknown model'}</code>
              {liveExtraction?.usage?.totalTokens && (
                <code>{liveExtraction.usage.totalTokens} tokens</code>
              )}
            </div>
          </div>
          <span>{liveOk ? 'ok' : liveRun.extraction_error ?? 'no analysis'}</span>
        </div>
      )}

      {decision && pipeline?.evaluation && (
        <div className="prop-decision">
          <div className={`big-decision big-decision-${decision} ${suggested ? `big-decision-lean-${suggested.decision}` : ''}`}>
            <div className="big-decision-label">
              {decision === 'MANUAL_REVIEW' ? 'Manual review required' : 'Recommendation'}
            </div>
            <div className="big-decision-value">
              {decision === 'MANUAL_REVIEW' && suggested
                ? suggestedVoteLabel(suggested)
                : decision.replace('_', ' ')}
            </div>
            <div className="big-decision-meta">
              {decision === 'MANUAL_REVIEW' && suggested
                ? `${suggestedVoteMeta(suggested)} · ${triggered.length} rule${triggered.length === 1 ? '' : 's'}`
                : `${Math.round(conf * 100)}% confidence · ${triggered.length} rule${triggered.length === 1 ? '' : 's'}`}
            </div>
          </div>

          {decision === 'MANUAL_REVIEW' && (
            <div className="manual-review-note">
              {manualReviewGate && (
                <span>Gate <code>{manualReviewGate.id}</code></span>
              )}
              {suggested ? (
                <span>
                  {suggestedVoteLabel(suggested)}: {suggested.reason}
                </span>
              ) : (
                <span>No vote lean available for this review gate.</span>
              )}
            </div>
          )}

          <div className="rules-toggle">
            <button className="link-btn" onClick={() => setShowRules((v) => !v)}>
              {showRules ? '− hide' : '+ show'} {triggered.length} rule{triggered.length === 1 ? '' : 's'} that fired
            </button>
            {showRules && (
              <div className="rules-list">
                {triggered.length === 0 ? (
                  <p className="muted tiny">No rules matched.</p>
                ) : (
                  triggered.map((r) => (
                    <div key={r.id} className="rule">
                      <span className="id">{r.id}</span>
                      <span className="reason">— {r.reason}</span>
                      {r.contribution && (
                        <span className="contrib">
                          ({Object.entries(r.contribution).map(([k, v]) => `${k} +${v}`).join(', ')})
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <footer className="prop-actions">
        <button
          className="btn"
          onClick={runLiveInTee}
          disabled={liveLoading || !proposal}
          title="Re-runs the LLM extraction inside the attested TEE and replaces the cached score for this proposal."
        >
          {liveLoading ? 'Rescoring…' : 'Rescore'}
        </button>
        {decision === 'FOR' || decision === 'AGAINST' || decision === 'ABSTAIN' ? (
          <button
            className="btn primary"
            onClick={castVote}
            disabled={loading || !!signed}
          >
            {signed ? 'Signed in TEE ✓' : `Sign ${decision} inside enclave`}
          </button>
        ) : null}
      </footer>

      {pipeline?.decision_blob && (
        <div className="prop-envelope">
          <div className="prop-envelope-head">
            <span className="tiny muted">
              Decision blob signed by <code>{pipeline.decision_blob.signature.address}</code>{' '}
              ({pipeline.decision_blob.verification.recovered ? 'verified' : 'not verified'})
            </span>
            <button className="link-btn" onClick={() => setShowDecisionBlob((v) => !v)}>
              {showDecisionBlob ? 'hide blob' : 'show blob'}
            </button>
          </div>
          {showDecisionBlob && (
            <pre className="envelope-pre">{JSON.stringify(pipeline.decision_blob, null, 2)}</pre>
          )}
        </div>
      )}

      {pipeline?.decision_blob_error && (
        <p className="muted tiny">Decision blob unavailable: {pipeline.decision_blob_error}</p>
      )}

      {signed?.vote && (
        <div className="prop-envelope">
          <div className="prop-envelope-head">
            <span className="tiny muted">
              Signed by <code>{signed.vote.envelope.address}</code>{' '}
              ({authed ? 'your derived wallet' : 'app-wide wallet'})
            </span>
            <button className="link-btn" onClick={() => setShowEnvelope((v) => !v)}>
              {showEnvelope ? 'hide envelope' : 'show envelope'}
            </button>
          </div>
          {showEnvelope && (
            <pre className="envelope-pre">{JSON.stringify(signed.vote.envelope, null, 2)}</pre>
          )}
        </div>
      )}
    </article>
  );
}
