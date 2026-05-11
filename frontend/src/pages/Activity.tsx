/**
 * Activity page — pending approvals + recent activity.
 *
 *   - "Pending approvals" lists every active proposal where the agent
 *     recommended MANUAL_REVIEW. The user opens a modal, picks
 *     FOR/AGAINST/ABSTAIN, and the vote envelope is signed by their
 *     per-user wallet inside the backend. After signing, the item moves
 *     to "Recent activity".
 *   - "Recent activity" reads from localStorage (per-address). It's a
 *     session/browser-local queue of overrides, not server-persisted —
 *     keeps scope small, matches the rest of the local-first demo data.
 *
 * The deterministic engine + decision-blob signing already happen on
 * every pipeline call. Here we add one more thing on the user's
 * confirmation: a Snapshot vote envelope signed with the user's chosen
 * outcome.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  fetchActiveProposals,
  fetchSnapshotProposal,
  runPipeline,
  type Decision,
  type PipelineResult,
} from '../api';
import { getStoredToken } from '../lib/auth';
import { suggestedVoteLabel, suggestedVoteMeta, suggestedVoteReason } from '../lib/decision';
import { DaoBadge } from '../DaoBadge';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authed'; address: string };

// Per-space limit on active proposals scanned. With ~4 allowlisted spaces
// this caps the pending queue at ~12 items, plenty for the demo without
// blowing up the live LLM extraction load on first paint.
const ACTIVE_LIMIT_PER_SPACE = 5;
const RECENT_CAP = 50;
const LEGACY_DEFAULT_SPACE = 'arbitrumfoundation.eth';

type ChoiceLabel = 'FOR' | 'AGAINST' | 'ABSTAIN';
const CHOICE_LABELS: Record<number, ChoiceLabel> = { 1: 'FOR', 2: 'AGAINST', 3: 'ABSTAIN' };

type ActivityItem = {
  proposal_id: string;
  title: string | null;
  // Space is optional for backward compat with localStorage entries written
  // before multi-DAO support. RecentRow falls back to LEGACY_DEFAULT_SPACE
  // (arbitrumfoundation.eth) so existing rows still link to a valid
  // Snapshot URL.
  space?: string;
  signed_choice: number;
  signed_at: number;
  signed_by_address: string | null;
  submission:
    | { ok: true; sequencer_id: string | null }
    | { ok: false; status: number; error: string }
    | null;
};

type Pending = {
  proposalId: string;
  title: string | null;
  space: string;
  pipeline: PipelineResult;
  triggered_rule: string | null;
};

function recentKey(address: string): string {
  return `gov-agent:recent-activity:${address.toLowerCase()}`;
}

function loadRecent(address: string): ActivityItem[] {
  try {
    const raw = localStorage.getItem(recentKey(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Backfill the submission field for entries written before submission
    // was added — those rows were sign-only by definition. Space is also
    // backfilled to LEGACY_DEFAULT_SPACE for items predating multi-DAO.
    return (parsed as Array<Partial<ActivityItem>>).map((r) => ({
      proposal_id: String(r.proposal_id ?? ''),
      title: r.title ?? null,
      space: typeof r.space === 'string' ? r.space : undefined,
      signed_choice: Number(r.signed_choice ?? 0),
      signed_at: Number(r.signed_at ?? 0),
      signed_by_address: r.signed_by_address ?? null,
      submission: r.submission ?? null,
    }));
  } catch {
    return [];
  }
}

function saveRecent(address: string, items: ActivityItem[]) {
  try {
    localStorage.setItem(recentKey(address), JSON.stringify(items.slice(0, RECENT_CAP)));
  } catch {
    // Quota / disabled storage. Ignore — UI just won't persist.
  }
}

export function Activity({
  auth,
  hasProfile,
  onSignIn,
  daoSpace,
  fallbackSpaces,
}: {
  auth: AuthState;
  hasProfile: boolean;
  onSignIn: () => void;
  daoSpace: string | null;
  fallbackSpaces: string[];
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
    <ActivityAuthed
      address={auth.address}
      daoSpace={daoSpace}
      fallbackSpaces={fallbackSpaces}
    />
  );
}

function ActivityAuthed({
  address,
  daoSpace,
  fallbackSpaces,
}: {
  address: string;
  daoSpace: string | null;
  fallbackSpaces: string[];
}) {
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<ActivityItem[]>(() => loadRecent(address));
  const [openModalFor, setOpenModalFor] = useState<Pending | null>(null);

  // Reload recent when the address changes (wallet swap).
  useEffect(() => { setRecent(loadRecent(address)); }, [address]);

  // Live-fetch active proposals across primary + every fallback space,
  // then run the pipeline against each in parallel. Multi-DAO surface:
  // pending queue shows whatever your policy is currently flagging across
  // ALL allowlisted DAOs, with a DaoBadge per row. No FEATURED fakes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const spacesToScan = [
          ...(daoSpace ? [daoSpace] : []),
          ...fallbackSpaces.filter((s) => s !== daoSpace),
        ];
        if (spacesToScan.length === 0) {
          if (!cancelled) setPending([]);
          return;
        }

        // Step 1: fetch active proposal id+title from every space in parallel.
        // .catch returns [] per-space so one slow space does not block others.
        const perSpace = await Promise.all(
          spacesToScan.map((space) =>
            fetchActiveProposals(space, ACTIVE_LIMIT_PER_SPACE)
              .then((items) => items.map((p) => ({ space, id: p.id })))
              .catch(() => [] as Array<{ space: string; id: string }>),
          ),
        );
        const all = perSpace.flat();
        if (cancelled) return;

        // Step 2: for each id, fetch the full proposal body + run the
        // pipeline, all in parallel via Promise.allSettled. Rejections per
        // item just produce a null and get filtered out.
        const token = getStoredToken();
        const settled = await Promise.allSettled(
          all.map(async ({ space, id }) => {
            const proposal = await fetchSnapshotProposal(id);
            if (!proposal) return null;
            const pipeline = await runPipeline({ proposal, token });
            return { space, proposal, pipeline };
          }),
        );
        if (cancelled) return;

        const results: Pending[] = [];
        for (const r of settled) {
          if (r.status !== 'fulfilled' || !r.value) continue;
          const { space, proposal, pipeline } = r.value;
          if (!pipeline?.evaluation) continue;
          if (pipeline.evaluation.decision !== 'MANUAL_REVIEW') continue;
          const triggered_rule = pipeline.evaluation.triggered_rules[0]?.id ?? null;
          results.push({
            proposalId: proposal.id,
            title: proposal.title ?? null,
            space,
            pipeline,
            triggered_rule,
          });
        }
        if (!cancelled) setPending(results);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [daoSpace, fallbackSpaces.join(',')]);

  // Items already signed shouldn't show up in pending, even if the page
  // re-fetches them. Filter pending by the recent-activity ids.
  const visiblePending = useMemo(() => {
    if (!pending) return null;
    const signedIds = new Set(recent.map((r) => r.proposal_id));
    return pending.filter((p) => !signedIds.has(p.proposalId));
  }, [pending, recent]);

  async function handleOverride(p: Pending, choice: number) {
    setOpenModalFor(null);
    const token = getStoredToken();
    if (!token) return;
    const proposal = await fetchSnapshotProposal(p.proposalId).catch(() => null);
    if (!proposal) {
      setError(`could not re-fetch proposal ${p.proposalId.slice(0, 10)}…`);
      return;
    }
    try {
      const result = await runPipeline({
        proposal,
        token,
        sign: true,
        override_choice: choice,
        submit: true,
      });
      if (!result.vote) throw new Error('vote envelope was not signed');
      let submission: ActivityItem['submission'] = null;
      if (result.submission) {
        if (result.submission.ok) {
          const r: any = result.submission.receipt;
          // Snapshot's sequencer typically returns { id: "..." } on success.
          submission = { ok: true, sequencer_id: r?.id ?? null };
        } else {
          submission = {
            ok: false,
            status: result.submission.status,
            error: result.submission.error,
          };
        }
      }
      const newItem: ActivityItem = {
        proposal_id: p.proposalId,
        title: p.title,
        space: p.space,
        signed_choice: choice,
        signed_at: Date.now(),
        signed_by_address: result.vote.envelope.address ?? null,
        submission,
      };
      setRecent((prev) => {
        const next = [newItem, ...prev.filter((r) => r.proposal_id !== p.proposalId)];
        saveRecent(address, next);
        return next;
      });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  return (
    <>
      <SectionHeading>Pending approvals</SectionHeading>
      <p className="muted tiny activity-queue-note">
        Review-gated active and featured proposals appear here until you sign or submit a choice.
      </p>
      {error && <div className="modal-error" style={{ marginBottom: 12 }}>{error}</div>}
      {visiblePending === null ? (
        <Card>
          <p className="muted tiny">Looking for items needing your decision…</p>
        </Card>
      ) : visiblePending.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing pending"
            description="When the agent flags a live proposal for manual review, it will show up here. You'll be able to confirm a vote in one click."
          />
        </Card>
      ) : (
        <div className="activity-pending-list">
          {visiblePending.map((p) => (
            <PendingCard
              key={p.proposalId}
              pending={p}
              onDecide={() => setOpenModalFor(p)}
            />
          ))}
        </div>
      )}

      <SectionHeading>Recent activity</SectionHeading>
      {recent.length === 0 ? (
        <Card>
          <EmptyState
            title="No votes signed yet"
            description="Once you decide on a pending item above, the signed vote envelope will appear here with the choice you made and a verifiable signature."
          />
        </Card>
      ) : (
        <div className="activity-recent-list">
          {recent.map((r) => (
            <RecentRow key={r.proposal_id + r.signed_at} item={r} />
          ))}
        </div>
      )}

      {openModalFor && (
        <DecideModal
          pending={openModalFor}
          onCancel={() => setOpenModalFor(null)}
          onChoose={(choice) => handleOverride(openModalFor, choice)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Pending card
// ---------------------------------------------------------------------------

function PendingCard({
  pending,
  onDecide,
}: {
  pending: Pending;
  onDecide: () => void;
}) {
  const summary = pending.pipeline.analysis?.summary ?? '(no summary available)';
  const suggested = pending.pipeline.evaluation?.suggested_vote ?? null;
  const [expanded, setExpanded] = useState(false);
  const isLong = summary.length > 240;
  return (
    <article className="activity-pending">
      <header className="activity-pending-head">
        <div>
          <h3 className="activity-pending-title">
            <DaoBadge space={pending.space} />
            {pending.title ?? pending.proposalId.slice(0, 14) + '…'}
          </h3>
          <div className="muted tiny" style={{ marginTop: 2 }}>
            <code>{pending.proposalId.slice(0, 14)}…</code>
            {pending.triggered_rule && (
              <>
                {' · flagged by '}
                <code>{pending.triggered_rule}</code>
              </>
            )}
          </div>
        </div>
        <button className="btn primary" onClick={onDecide}>Decide</button>
      </header>
      <p className={`activity-pending-summary ${isLong && !expanded ? 'clamped' : ''}`}>
        {summary}
      </p>
      {isLong && (
        <button
          type="button"
          className="link-button tiny"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      {suggested && (
        <p className="activity-suggested">
          <span className={`decision-pill action-${suggested.decision}`}>
            {suggestedVoteLabel(suggested)}
          </span>
          <span className="muted"> · {suggestedVoteMeta(suggested)} · </span>
          {suggestedVoteReason(suggested)}
        </p>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Decide modal
// ---------------------------------------------------------------------------

function DecideModal({
  pending,
  onCancel,
  onChoose,
}: {
  pending: Pending;
  onCancel: () => void;
  onChoose: (choice: number) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const suggested = pending.pipeline.evaluation?.suggested_vote ?? null;
  const choices: { num: number; label: ChoiceLabel; desc: string }[] = [
    { num: 1, label: 'FOR', desc: 'Sign a vote in support.' },
    { num: 2, label: 'AGAINST', desc: 'Sign a vote opposing.' },
    { num: 3, label: 'ABSTAIN', desc: 'Sign a vote registering no preference.' },
  ];

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3 style={{ margin: 0 }}>Decide on this proposal</h3>
          <button className="btn small" onClick={onCancel} aria-label="close">×</button>
        </header>
        <p className="muted tiny" style={{ marginTop: 8 }}>
          Your agent flagged this for manual review. Pick how you want to vote — your wallet will sign the envelope inside the enclave. The decision blob will record this as a user override of the engine's MANUAL_REVIEW gate.
        </p>
        <div className="modal-proposal-title">{pending.title ?? pending.proposalId}</div>
        {suggested && (
          <div className="activity-suggested modal-suggested">
            <span className={`decision-pill action-${suggested.decision}`}>
              {suggestedVoteLabel(suggested)}
            </span>
            <span className="muted"> · {suggestedVoteMeta(suggested)} · </span>
            {suggestedVoteReason(suggested)}
          </div>
        )}

        <div className="decide-choices">
          {choices.map((c) => (
            <label key={c.num} className={`decide-choice ${picked === c.num ? 'selected' : ''}`}>
              <input
                type="radio"
                name="decide-choice"
                checked={picked === c.num}
                onChange={() => setPicked(c.num)}
              />
              <span className="decide-choice-label">{c.label}</span>
              <span className="decide-choice-desc">{c.desc}</span>
            </label>
          ))}
        </div>

        <footer className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button
            className="btn primary"
            disabled={picked === null || submitting}
            onClick={async () => {
              if (picked === null) return;
              setSubmitting(true);
              onChoose(picked);
            }}
          >
            {submitting ? 'Signing…' : picked ? `Sign ${CHOICE_LABELS[picked]}` : 'Sign'}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent activity row
// ---------------------------------------------------------------------------

function RecentRow({ item }: { item: ActivityItem }) {
  const choice = CHOICE_LABELS[item.signed_choice] ?? `choice ${item.signed_choice}`;
  const when = new Date(item.signed_at).toLocaleString();
  // Multi-DAO: link uses the space recorded on the item. Legacy items
  // written before multi-DAO support default to LEGACY_DEFAULT_SPACE
  // (arbitrumfoundation.eth) — all old votes were against Arbitrum.
  const space = item.space ?? LEGACY_DEFAULT_SPACE;

  let snapshotLine: ReactNode = null;
  if (item.submission == null) {
    snapshotLine = <span className="recent-status muted">sign-only · not submitted</span>;
  } else if (item.submission.ok) {
    const sid = item.submission.sequencer_id;
    snapshotLine = (
      <span className="recent-status recent-status-ok">
        submitted to Snapshot ✓
        {sid && (
          <>
            {' · '}
            <a
              href={`https://snapshot.org/#/${space}/proposal/${item.proposal_id}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              view
            </a>
            {' · '}
            <code>{sid.slice(0, 14)}…</code>
          </>
        )}
      </span>
    );
  } else {
    snapshotLine = (
      <span className="recent-status recent-status-fail" title={item.submission.error}>
        Snapshot rejected ({item.submission.status}): {item.submission.error.slice(0, 80)}
      </span>
    );
  }

  return (
    <div className="activity-recent">
      <div className="activity-recent-main">
        <div className="activity-recent-title">
          <DaoBadge space={space} />
          {item.title ?? item.proposal_id.slice(0, 14) + '…'}
        </div>
        <div className="muted tiny" style={{ marginTop: 2 }}>
          signed {when}
          {item.signed_by_address && (
            <>
              {' by '}<code>{item.signed_by_address.slice(0, 10)}…</code>
            </>
          )}
        </div>
        <div style={{ marginTop: 4 }}>{snapshotLine}</div>
      </div>
      <div className={`activity-recent-choice action-${choice}`}>{choice}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable bits
// ---------------------------------------------------------------------------

export function SectionHeading({ children }: { children: ReactNode }) {
  return <div className="section-heading">{children}</div>;
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
      <p className="muted">{description}</p>
      {cta && <div style={{ marginTop: 16 }}>{cta}</div>}
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
        cta={<button onClick={onSignIn} className="btn primary">Connect wallet</button>}
      />
    </Card>
  );
}

// Avoid unused-Decision warning in case future code ref'd it.
export type { Decision };
