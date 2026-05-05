/**
 * Proposals page — list of proposals in the configured DAO with the
 * agent's recommendation per row. Visible to both authed and anonymous
 * users. Anonymous users get a clearly labeled default-policy preview;
 * connected users must configure a policy before recommendations run.
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
import { FEATURED } from '../data';
import { Card, ConnectGate, EmptyState, SectionHeading } from './Activity';

// Capped on purpose. Each rendered ProposalCard kicks off an LLM extraction
// for any proposal not already cached. 3 × ~$0.03 = ~$0.09 per page load
// is the worst case while the gateway is on direct Anthropic for local dev.
const ACTIVE_LIMIT = 3;
const DAO_SPACE = 'arbitrumfoundation.eth';

const CHOICE_LABELS: Record<number, 'FOR' | 'AGAINST' | 'ABSTAIN'> = {
  1: 'FOR', 2: 'AGAINST', 3: 'ABSTAIN',
};

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

export function Proposals({
  auth,
  hasProfile,
  profileLoaded,
  onSignIn,
  demoLivePending,
  onLiveTeeRun,
}: {
  auth: AuthState;
  hasProfile: boolean;
  profileLoaded: boolean;
  onSignIn: () => void;
  demoLivePending?: boolean;
  onLiveTeeRun?: () => void;
}) {
  const [activeIds, setActiveIds] = useState<string[] | null>(null);
  const [activeError, setActiveError] = useState<string | null>(null);
  const [selectedDemoId, setSelectedDemoId] = useState(FEATURED[0]?.id ?? '');

  useEffect(() => {
    fetchActiveProposals(DAO_SPACE, ACTIVE_LIMIT)
      .then((list) => setActiveIds(list.map((p) => p.id)))
      .catch((e) => {
        setActiveError(String(e));
        setActiveIds([]);
      });
  }, []);

  // While loading, fall back to the FEATURED list so the page doesn't flash
  // empty. After load: prefer live active proposals; if Snapshot returns
  // none, surface the FEATURED list with a clear note.
  const useActive = activeIds !== null && activeIds.length > 0;
  const baseIds: { id: string; analysis?: any }[] = useActive
    ? activeIds!.map((id) => ({ id }))
    : FEATURED;
  const selectedDemo = FEATURED.find((p) => p.id === selectedDemoId);
  const idsToRender: { id: string; analysis?: any }[] = selectedDemo
    ? [
        selectedDemo,
        ...baseIds.filter((p) => p.id !== selectedDemo.id),
      ]
    : baseIds;

  // Pull recent-activity entries for the authed user (if any) so each
  // ProposalCard can show "you signed X" if the user already acted on it
  // via the Activity tab. Read on mount; this is purely cosmetic.
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
          useActive={useActive}
          activeIds={activeIds}
          activeError={activeError}
          recommendationMode={recommendationMode}
        />
        <DemoShortcuts selectedId={selectedDemoId} onSelect={setSelectedDemoId} />
        <div className="proposals">
          {idsToRender.map((p, i) => (
            <ProposalCard
              key={p.id}
              proposalId={p.id}
              bundledAnalysis={p.analysis}
              authed={false}
              recommendationsEnabled={recommendationsEnabled}
              userSigned={null}
              demoFocus={demoLivePending === true && i === 0}
              onLiveTeeRun={onLiveTeeRun}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <>
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
        useActive={useActive}
        activeIds={activeIds}
        activeError={activeError}
        recommendationMode={recommendationMode}
      />
      <DemoShortcuts selectedId={selectedDemoId} onSelect={setSelectedDemoId} />
      <div className="proposals">
        {idsToRender.map((p, i) => (
          <ProposalCard
            key={p.id}
            proposalId={p.id}
            bundledAnalysis={p.analysis}
            authed={auth.status === 'authed'}
            recommendationsEnabled={recommendationsEnabled}
            userSigned={userSignedById[p.id] ?? null}
            demoFocus={demoLivePending === true && i === 0}
            onLiveTeeRun={onLiveTeeRun}
          />
        ))}
      </div>
    </>
  );
}

function DemoShortcuts({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="demo-shortcuts" aria-label="Demo proposal shortcuts">
      <span className="dft-label">Demo proposals</span>
      {FEATURED.map((p) => (
        <button
          key={p.id}
          className={`demo-chip ${selectedId === p.id ? 'active' : ''}`}
          onClick={() => onSelect(p.id)}
        >
          <span>{p.label ?? p.id.slice(0, 10)}</span>
          {p.tag && <code>{p.tag}</code>}
        </button>
      ))}
    </div>
  );
}

function ProposalsListNote({
  useActive,
  activeIds,
  activeError,
  recommendationMode,
}: {
  useActive: boolean;
  activeIds: string[] | null;
  activeError: string | null;
  recommendationMode: 'default' | 'saved' | 'paused';
}) {
  if (activeIds === null) {
    return (
      <p className="muted tiny" style={{ marginTop: -4, marginBottom: 16 }}>
        Looking for active proposals on {DAO_SPACE}…
      </p>
    );
  }
  if (activeError) {
    return (
      <p className="muted tiny" style={{ marginTop: -4, marginBottom: 16 }}>
        Snapshot fetch failed ({activeError}). Showing curated featured proposals instead.
      </p>
    );
  }
  if (useActive) {
    const recommendationCopy =
      recommendationMode === 'paused'
        ? 'Recommendations are paused until your policy is configured; live TEE extraction can still be run manually.'
        : recommendationMode === 'default'
          ? 'Each card runs the pipeline against the default preview policy.'
          : 'Each card runs the pipeline against your saved policy.';
    return (
      <p className="muted tiny" style={{ marginTop: -4, marginBottom: 16 }}>
        Showing {activeIds!.length} live active proposal{activeIds!.length === 1 ? '' : 's'} on {DAO_SPACE} (capped at {ACTIVE_LIMIT}). {recommendationCopy}
      </p>
    );
  }
  return (
    <p className="muted tiny" style={{ marginTop: -4, marginBottom: 16 }}>
      No live active proposals on {DAO_SPACE} right now. Showing curated featured proposals so the page isn't empty.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Proposal card (extracted from the old Dashboard)
// ---------------------------------------------------------------------------

function ProposalCard({
  proposalId,
  bundledAnalysis,
  authed,
  recommendationsEnabled,
  userSigned,
  demoFocus,
  onLiveTeeRun,
}: {
  proposalId: string;
  bundledAnalysis?: any;
  authed: boolean;
  recommendationsEnabled: boolean;
  userSigned: MinimalActivityEntry | null;
  demoFocus?: boolean;
  onLiveTeeRun?: () => void;
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
      analysis: bundledAnalysis,
      token: authed ? getStoredToken() : null,
    })
      .then((r) => setPipeline(r))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [proposal, pipeline, bundledAnalysis, authed, recommendationsEnabled]);

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
      if (live.extraction?.source === 'live' && live.analysis) {
        onLiveTeeRun?.();
      }

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
        analysis: liveRun?.analysis ?? bundledAnalysis,
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

  return (
    <article className="prop-card">
      <header className="prop-head">
        <h3>{proposal.title ?? proposalId}</h3>
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
        <span>·</span>
        <code>{proposal.space?.id}</code>
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
          className={`btn ${demoFocus && !liveRun ? 'demo-focus-action' : ''}`}
          onClick={runLiveInTee}
          disabled={liveLoading || !proposal}
        >
          {liveLoading ? 'Running live in TEE…' : 'Run live in TEE'}
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
