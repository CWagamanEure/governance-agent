/**
 * Proposals page — list of proposals in the configured DAO with the
 * agent's recommendation per row. Visible to both authed and anonymous
 * users (anonymous gets the default profile).
 */

import { useEffect, useState } from 'react';
import {
  fetchSnapshotProposal,
  fetchActiveProposals,
  runPipeline,
  type PipelineResult,
} from '../api';
import { getStoredToken } from '../lib/auth';
import { FEATURED } from '../data';
import { ConnectGate, SectionHeading } from './Activity';

// Capped on purpose. Each rendered ProposalCard kicks off an LLM extraction
// for any proposal not already cached. 3 × ~$0.03 = ~$0.09 per page load
// is the worst case while the gateway is on direct Anthropic for local dev.
const ACTIVE_LIMIT = 3;
const DAO_SPACE = 'arbitrumfoundation.eth';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authed'; address: string };

export function Proposals({
  auth,
  onSignIn,
}: {
  auth: AuthState;
  onSignIn: () => void;
}) {
  const [activeIds, setActiveIds] = useState<string[] | null>(null);
  const [activeError, setActiveError] = useState<string | null>(null);

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
  const idsToRender: { id: string; analysis?: any }[] = useActive
    ? activeIds!.map((id) => ({ id }))
    : FEATURED;

  if (auth.status === 'anonymous') {
    return (
      <>
        <ConnectGate
          title="Connect wallet to use your own policy"
          description="Without sign-in, the agent uses its default policy and signs with the app-wide wallet. Connect to set your own preferences and have the agent sign with a wallet derived for you."
          onSignIn={onSignIn}
        />

        <SectionHeading>Live preview</SectionHeading>
        <ProposalsListNote useActive={useActive} activeIds={activeIds} activeError={activeError} />
        <div className="proposals">
          {idsToRender.map((p) => (
            <ProposalCard
              key={p.id}
              proposalId={p.id}
              bundledAnalysis={p.analysis}
              authed={false}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <SectionHeading>Active proposals</SectionHeading>
      <ProposalsListNote useActive={useActive} activeIds={activeIds} activeError={activeError} />
      <div className="proposals">
        {idsToRender.map((p) => (
          <ProposalCard
            key={p.id}
            proposalId={p.id}
            bundledAnalysis={p.analysis}
            authed={auth.status === 'authed'}
          />
        ))}
      </div>
    </>
  );
}

function ProposalsListNote({
  useActive,
  activeIds,
  activeError,
}: {
  useActive: boolean;
  activeIds: string[] | null;
  activeError: string | null;
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
    return (
      <p className="muted tiny" style={{ marginTop: -4, marginBottom: 16 }}>
        Showing {activeIds!.length} live active proposal{activeIds!.length === 1 ? '' : 's'} on {DAO_SPACE} (capped at {ACTIVE_LIMIT}). Each card runs the pipeline against your saved policy.
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
}: {
  proposalId: string;
  bundledAnalysis?: any;
  authed: boolean;
}) {
  const [proposal, setProposal] = useState<any | null>(null);
  const [pipeline, setPipeline] = useState<PipelineResult | null>(null);
  const [signed, setSigned] = useState<PipelineResult | null>(null);
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
    if (!proposal || pipeline) return;
    setLoading(true);
    runPipeline({
      proposal,
      analysis: bundledAnalysis,
      token: authed ? getStoredToken() : null,
    })
      .then((r) => setPipeline(r))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [proposal, pipeline, bundledAnalysis, authed]);

  async function castVote() {
    if (!proposal) return;
    setLoading(true);
    try {
      const r = await runPipeline({
        proposal,
        analysis: bundledAnalysis,
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

  return (
    <article className="prop-card">
      <header className="prop-head">
        <h3>{proposal.title ?? proposalId}</h3>
        <span className={`prop-state state-${proposal.state}`}>{proposal.state}</span>
      </header>
      <div className="prop-meta">
        <code>{proposal.id.slice(0, 14)}…</code>
        <span>·</span>
        <code>{proposal.space?.id}</code>
      </div>

      {pipeline?.analysis && (
        <p className="prop-summary">{pipeline.analysis.summary}</p>
      )}

      {loading && !pipeline && <p className="muted tiny">running pipeline…</p>}

      {decision && pipeline?.evaluation && (
        <div className="prop-decision">
          <div className={`big-decision big-decision-${decision}`}>
            <div className="big-decision-label">Recommendation</div>
            <div className="big-decision-value">{decision.replace('_', ' ')}</div>
            <div className="big-decision-meta">
              {Math.round(conf * 100)}% confidence · {triggered.length} rule{triggered.length === 1 ? '' : 's'}
            </div>
          </div>

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
        {decision === 'FOR' || decision === 'AGAINST' || decision === 'ABSTAIN' ? (
          <button
            className="btn primary"
            onClick={castVote}
            disabled={loading || !!signed}
          >
            {signed ? 'Signed in TEE ✓' : `Sign ${decision} inside enclave`}
          </button>
        ) : decision === 'MANUAL_REVIEW' ? (
          <span className="muted tiny">
            Manual review required — would not auto-vote on this proposal.
          </span>
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
