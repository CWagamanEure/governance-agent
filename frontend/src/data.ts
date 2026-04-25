/**
 * Demo data: which proposals to feature on the page, and a hand-built
 * analysis for each so the pipeline runs even while the LLM gateway is
 * still gated. When the gateway is unblocked, drop the `analysis` field
 * for any of these and the backend will extract live.
 */

export type DemoProposal = {
  id: string;             // Snapshot bytes32 id
  // Optional pre-built analysis. If supplied, the backend skips LLM extraction.
  analysis?: any;
};

export const FEATURED: DemoProposal[] = [
  {
    id: '0x008f190725018c3db0e6464bf31d44f09a4d7773fd1486dff0c52c27b8aba289',
    analysis: {
      category: 'META_GOVERNANCE',
      summary:
        'Updates the Delegate Incentive Program v1.7: adjusts KPI thresholds, reporting cadence, and minimum participation rules. Aimed at tightening accountability for paid delegates without changing the underlying budget.',
      tradeoffs: [
        {
          pro: 'Tighter accountability for paid delegates with measurable KPIs',
          con: 'Adds bureaucratic overhead; may discourage smaller delegates',
        },
        {
          pro: 'Clearer reporting cadence improves DAO transparency',
          con: 'More work for the program admin team',
        },
      ],
      affected_parties: [
        'delegates receiving incentives',
        'incentive program administrators',
        'DAO voters relying on delegate reports',
      ],
      flags: {
        treasury_spend_usd: null,
        requires_contract_upgrade: false,
        touches_ownership: false,
        has_milestones: true,
        reversible: true,
        time_sensitive: false,
      },
      value_alignment: {
        decentralization: 0.6,
        treasury_conservatism: 0.3,
        growth_vs_sustainability: 0.4,
        protocol_risk: 0.1,
      },
      uncertainty: { requires_human_judgment: false, ambiguity_notes: '' },
      extraction_confidence: 0.85,
    },
  },
];
