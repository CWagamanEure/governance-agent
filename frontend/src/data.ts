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
      proposer: {
        address: null,
        name: null,
        type: 'UNKNOWN',
        known_delegate: null,
      },
      financial: {
        treasury_spend_usd: null,
        treasury_percent: null,
        recurring_payment: false,
        payment_stream: false,
        recipient_count: null,
        single_recipient: null,
      },
      execution: {
        requires_contract_upgrade: false,
        touches_ownership: false,
        changes_permissions: false,
        creates_or_extends_council: false,
        has_milestones: true,
        has_reporting: true,
        has_clawback: false,
        reversible: true,
        time_sensitive: false,
      },
      economics: {
        emissions_change: 'NONE',
        fee_change: 'NONE',
        parameter_change: false,
      },
      governance: {
        constitutional_change: false,
        changes_voting_power: false,
        delegation_or_incentive_program: true,
      },
      beneficiaries: {
        primary_scope: 'SPECIFIC_TEAM',
        named_recipients: ['delegates receiving incentives'],
        unclear_beneficiaries: false,
      },
      signals: {
        delegate_votes: [],
      },
      uncertainty: {
        requires_human_judgment: false,
        ambiguity_notes: '',
        low_confidence_fields: [],
        field_confidence: {
          category: 0.95,
          'proposer.type': 0.8,
          'financial.treasury_spend_usd': 0.95,
          'financial.recipient_count': 0.95,
          'execution.requires_contract_upgrade': 0.95,
          'execution.reversible': 0.95,
          'governance.constitutional_change': 0.95,
          'beneficiaries.primary_scope': 0.9,
        },
      },
      extraction_confidence: 0.9,
    },
  },
];
