/**
 * Extract the 20 onboarding calibration fixtures into the same cache table
 * as the real Arbitrum proposals, tagged with space='calibration.gov-agent'
 * so they're distinguishable.
 *
 * Why: the real Arbitrum corpus proves the fall-through half of the design
 * ("most real proposals are hard, system correctly defers to humans"). The
 * calibration corpus is the find-obvious-rules half ("when proposals match
 * the patterns your calibration revealed, the system autovotes"). Both
 * matter for the demo. The honest framing is the gap between them.
 *
 * Idempotent — re-running skips anything already cached at the current
 * EXTRACTION_SCHEMA_VERSION.
 */

import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

try { (process as any).loadEnvFile('.env'); } catch {}

import {
  upsertProposal,
  getCachedAnalysis,
  upsertAnalysis,
  type SnapshotProposalLike,
} from '../src/db.js';
import {
  extractOne,
  pickModel,
  EXTRACTION_SCHEMA_VERSION,
  type ModelAlias,
} from '../src/llm.js';

// Mirrors frontend/src/data/calibration.ts. Kept in sync by hand — these are
// stable demo inputs and rarely change.
type Fixture = { id: string; title: string; category: string; summary: string; pro: string; con: string };

const CALIBRATION: Fixture[] = [
  { id: 'cal-001-stip-extension', title: 'Extend Short-Term Incentive Program (STIP) with 50M ARB', category: 'TREASURY_SPEND',
    summary: 'Allocate 50M ARB (~$60M) to extend the existing incentives program for another 6 months across DEX, lending, and perp protocols. No specific milestone gates; protocols self-report KPIs.',
    pro: 'Continued growth in TVL and ecosystem activity.',
    con: 'Large recurring spend with weak measurement; benefits skew to top 5 protocols.' },
  { id: 'cal-002-security-council', title: 'Reduce Security Council multisig threshold to 7-of-12', category: 'PARAMETER_CHANGE',
    summary: 'Currently 9-of-12. Proposal lowers to 7-of-12 for faster emergency response. Same council members; only the threshold changes.',
    pro: 'Faster response to live exploits.',
    con: 'Easier for a sub-coalition to push through emergency actions.' },
  { id: 'cal-003-pg-grant', title: 'Grant $400k to Protocol Guild for upstream Ethereum work', category: 'GRANT',
    summary: '6-month grant supporting Ethereum core infrastructure contributors. Recipients are 150+ verified core devs. Quarterly reporting to DAO.',
    pro: 'Funds public goods that benefit Arbitrum indirectly.',
    con: 'Recurring spend; some argue Arbitrum should fund Arbitrum-specific work first.' },
  { id: 'cal-004-centralized-rpc', title: 'Exclusive 12-month RPC partnership with single provider', category: 'PARTNERSHIP',
    summary: 'Sign exclusive deal with one large infra provider for default RPC endpoints in the official wallet. They cover bandwidth costs in exchange for being the only default.',
    pro: 'Cost savings for the foundation; improved baseline reliability.',
    con: 'Concentrates request flow with one operator and adds switching cost later.' },
  { id: 'cal-005-token-buyback', title: 'Treasury buyback of 5M ARB to be locked for 4 years', category: 'TOKENOMICS',
    summary: 'One-time market buyback of 5M ARB using stablecoin treasury. Tokens locked in a smart contract for 4 years, then re-enter circulation gradually.',
    pro: 'Reduces near-term supply; signals long-term commitment.',
    con: 'Spends real assets on a token-supply optic; locked tokens still re-enter eventually.' },
  { id: 'cal-006-dip-update', title: 'Update Delegate Incentive Program (DIP v1.7)', category: 'META_GOVERNANCE',
    summary: 'Tightens KPIs for paid delegates: minimum participation rates, mandatory rationale on each vote, quarterly reporting.',
    pro: 'Better accountability for paid delegates.',
    con: 'Adds bureaucratic overhead; could push out smaller part-time delegates.' },
  { id: 'cal-007-bridge-upgrade', title: 'Upgrade canonical bridge contracts to v3', category: 'CONTRACT_UPGRADE',
    summary: 'Replaces current bridge implementation with v3 (audited). Migration is irreversible. Includes a 14-day timelock.',
    pro: 'Lower fees and improved finality.',
    con: 'Irreversible; introduces new code paths that could carry latent bugs despite audit.' },
  { id: 'cal-008-dao-staff', title: 'Hire 3 full-time DAO operations staff via foundation', category: 'COUNCIL_APPOINTMENT',
    summary: '$600k/year for 3 ops roles (governance support, treasury management, communications). 1-year initial term with renewal vote.',
    pro: 'Professionalizes DAO operations; reduces volunteer load.',
    con: 'Concentrates operational power in foundation hires; recurring cost.' },
  { id: 'cal-009-audit-renewal', title: 'Renew annual security audit retainer with OpenZeppelin ($45k)', category: 'TREASURY_SPEND',
    summary: '12-month renewal of an existing relationship for routine review of in-scope contracts. Same firm, same scope, same price as last year. Quarterly deliverables.',
    pro: 'Continuity with a known auditor; predictable security coverage.',
    con: 'Sole-sourced; the DAO has not solicited competing bids.' },
  { id: 'cal-010-doc-translation', title: 'Grant $12k to translate developer docs into Spanish and Portuguese', category: 'GRANT',
    summary: 'One-shot grant to a known DAO contributor team. Deliverables enumerated by chapter; payment in two milestones (50% on draft, 50% on review).',
    pro: 'Small spend, narrow scope, milestones, verified recipient.',
    con: 'Translations may go stale faster than the DAO can fund updates.' },
  { id: 'cal-011-analytics-tooling', title: 'Fund $30k for an open-source treasury analytics dashboard', category: 'GRANT',
    summary: 'Established contributor team builds a public dashboard tracking DAO treasury flows. Code MIT-licensed, hosted by recipient. Single payment on delivery; 6-month support included.',
    pro: 'Transparency tooling; small one-shot cost; deliverable is verifiable.',
    con: 'No long-term maintenance commitment after the 6-month window.' },
  { id: 'cal-012-gas-rebate-extension', title: 'Extend existing gas rebate program by 3 months at current rate', category: 'TREASURY_SPEND',
    summary: 'Continue an in-flight rebate program at the same monthly cap ($25k/mo, $75k total). No parameter changes. Program has hit ~80% of cap consistently and produced monthly reports.',
    pro: 'Routine continuation of a working, reported-on program.',
    con: 'Rebates are recurring; renewals could become rubber-stamped.' },
  { id: 'cal-013-bug-bounty-payout', title: 'Authorize $20k payout for a verified medium-severity bug', category: 'TREASURY_SPEND',
    summary: 'Disclosed via Immunefi, triaged and patched. Payout follows the existing severity matrix the DAO already approved. Single recipient, fixed amount, no precedent change.',
    pro: 'Honors an existing program at its existing terms; encourages future disclosures.',
    con: 'None material — this is a contractual payout, not a discretionary spend.' },
  { id: 'cal-014-conf-sponsorship', title: 'Sponsor ETHDenver booth for $35k via foundation', category: 'TREASURY_SPEND',
    summary: 'Standard sponsorship tier at a major Ethereum conference. Foundation handles logistics and post-event report. Comparable to last three years of sponsorships.',
    pro: 'Routine ecosystem visibility spend at a known price point.',
    con: 'Marketing spend with hard-to-attribute returns.' },
  { id: 'cal-015-fee-tweak', title: 'Reduce sequencer fee by 5% to match competing L2 pricing', category: 'PARAMETER_CHANGE',
    summary: 'Small adjustment to match Optimism and Base on a high-traffic fee tier. Reversible at any time via the same governance path. No code change.',
    pro: 'Keeps Arbitrum fee-competitive without altering economics materially.',
    con: 'Marginal short-term revenue reduction for the sequencer operator.' },
  { id: 'cal-016-sdk-maintenance', title: 'Grant $40k for 6 months of SDK maintenance to original maintainer', category: 'GRANT',
    summary: 'Continued maintenance of a widely-used SDK by its original author. Deliverables: monthly release cadence, response SLA on issues, public changelog. Milestones tied to releases.',
    pro: 'Keeps essential developer infrastructure healthy at a small cost.',
    con: 'Single-maintainer dependency the DAO is now subsidizing.' },
  { id: 'cal-017-stablecoin-conversion', title: 'Convert $250k of ARB to USDC for 6 months of operating expenses', category: 'TREASURY_SPEND',
    summary: 'Foundation requests pre-funded operating budget at current price. Standard practice; matches prior quarterly conversions. Funds custodied at established custodian.',
    pro: 'Routine operational liquidity; avoids forced ARB sales mid-quarter.',
    con: 'Reduces ARB on balance sheet; locks in exchange rate at current price.' },
  { id: 'cal-018-grants-program-topup', title: 'Top up existing small-grants program with 200k ARB', category: 'TREASURY_SPEND',
    summary: 'Refills an established grants committee at current parameters: caps per grant unchanged, committee unchanged, reporting cadence unchanged. Committee has published outcomes for the prior tranche.',
    pro: 'Continues a program with a track record of public reporting.',
    con: 'Committee is the same actors; no re-evaluation of mandate.' },
  { id: 'cal-019-mystery-grant', title: 'Grant 500k ARB to a newly formed entity for "ecosystem development"', category: 'GRANT',
    summary: 'Recipient is a 3-week-old multisig with no public team disclosure. Deliverables described as "supporting builders." No milestones, single up-front disbursement.',
    pro: 'Some delegates argue speed-to-fund matters more than process.',
    con: 'Unidentified recipient, vague scope, no milestones, lump-sum — every red flag at once.' },
  { id: 'cal-020-l2beat-followed-vote', title: 'Routine technical parameter tweak in line with l2beat.eth recommendation', category: 'PARAMETER_CHANGE',
    summary: 'Small adjustment to a published Arbitrum risk parameter. l2beat.eth (an established technical delegate) has voted FOR with a public rationale. Reversible via standard governance.',
    pro: 'Aligns with a delegate the DAO trusts on technical matters.',
    con: 'Following any single delegate is a heuristic, not a principle.' },
];

function inputHash(p: SnapshotProposalLike): string {
  return createHash('sha256').update(JSON.stringify({
    id: p.id, title: p.title, body: p.body,
  })).digest('hex');
}

function meanFieldConfidence(analysis: any): number {
  const fc = analysis?.uncertainty?.field_confidence;
  if (!fc || typeof fc !== 'object') return 0;
  const vals = Object.values(fc).filter((v): v is number => typeof v === 'number');
  return vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;
}

function fixtureToProposal(f: Fixture): SnapshotProposalLike {
  // Synthesize a proposal-shaped body from the fixture's summary + pro/con.
  // The LLM extraction prompt expects a body; we give it a clean structured
  // version that mirrors what real proposal bodies look like (markdown).
  const body = [
    `# ${f.title}`,
    '',
    '## Summary',
    f.summary,
    '',
    '## Arguments for',
    f.pro,
    '',
    '## Arguments against',
    f.con,
  ].join('\n');

  return {
    id: f.id,
    title: f.title,
    body,
    author: '0xCAL00000000000000000000000000000000CAL00',
    type: 'single-choice',
    choices: ['For', 'Against', 'Abstain'],
    state: 'closed',
    space: { id: 'calibration.gov-agent' } as any,
    start: 1700000000,
    end: 1700604000,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', default: 'sonnet' },
      force: { type: 'boolean', default: false },
    },
  });
  const modelAlias = values.model as ModelAlias;
  const force = values.force!;

  const { info } = pickModel(modelAlias);
  console.error(`Route: ${info.route}   Model: ${info.modelId}`);
  console.error(`Schema version: ${EXTRACTION_SCHEMA_VERSION}`);
  console.error(`Extracting ${CALIBRATION.length} calibration fixtures into cache.\n`);

  let extracted = 0, cached = 0, failed = 0, totalIn = 0, totalOut = 0;

  for (let i = 0; i < CALIBRATION.length; i++) {
    const f = CALIBRATION[i]!;
    const tag = `[${i + 1}/${CALIBRATION.length}] ${f.id}`;
    const p = fixtureToProposal(f);
    upsertProposal(p);

    if (!force && getCachedAnalysis(f.id, EXTRACTION_SCHEMA_VERSION)) {
      console.error(`${tag} CACHED  ${f.title.slice(0, 60)}`);
      cached++;
      continue;
    }

    console.error(`${tag} ...     ${f.title.slice(0, 60)}`);
    const result = await extractOne(p as any, modelAlias);
    if (!result.ok) {
      console.error(`        FAIL    ${result.error.slice(0, 220)}`);
      failed++;
      continue;
    }

    const usage: any = result.meta.usage ?? {};
    const inTok = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
    const outTok = Number(usage.outputTokens ?? usage.completionTokens ?? 0);
    totalIn += inTok;
    totalOut += outTok;

    upsertAnalysis({
      proposal_id: f.id,
      model_name: info.route,
      model_version: result.meta.modelId,
      analysis: result.analysis,
      extraction_confidence: meanFieldConfidence(result.analysis),
      input_hash: inputHash(p),
      schema_version: EXTRACTION_SCHEMA_VERSION,
    });
    const conf = meanFieldConfidence(result.analysis).toFixed(2);
    const rhj = result.analysis.uncertainty.requires_human_judgment ? ' rhj' : '';
    console.error(`        OK      ${result.analysis.category.padEnd(20)} conf=${conf}${rhj} tokens=${inTok}/${outTok}`);
    extracted++;
  }

  console.error('');
  console.error(`Summary: ${extracted} extracted, ${cached} cached, ${failed} failed`);
  console.error(`Tokens:  ${totalIn} in, ${totalOut} out`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
