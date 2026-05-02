/**
 * Manual sanity check for the profile compiler. Not in CI — costs LLM tokens.
 *
 * Runs the compiler against three representative inputs and prints the
 * compiled PolicyProfile so you can eyeball whether autovote rules look
 * defensible (narrow conditions, supported by calibration evidence) or
 * sloppy (broad rules, weak evidence).
 *
 * Usage: npm run test:compiler
 */

try { (process as any).loadEnvFile('.env'); } catch {}

import { compileProfile, type CalibrationChoice } from '../src/profile-compiler.js';

const SCENARIOS: { name: string; stated_values_text: string; calibration: CalibrationChoice[] }[] = [
  {
    name: 'Accountability-focused user',
    stated_values_text: [
      'I support small open-source ecosystem grants under $50k that have milestones.',
      "I'm skeptical of recurring delegate compensation programs without clear KPIs.",
      'I prefer reversible decisions over irreversible ones.',
      "I'd rather see milestone-gated grants than lump-sum disbursements.",
    ].join(' '),
    calibration: [
      { proposal_id: 'cal-001-stip-extension',     proposal_category: 'TREASURY_SPEND',  user_choice: 'AGAINST', proposal_title: 'Extend STIP with 50M ARB' },
      { proposal_id: 'cal-003-pg-grant',           proposal_category: 'GRANT',           user_choice: 'FOR',     proposal_title: 'Protocol Guild grant $400k' },
      { proposal_id: 'cal-006-dip-update',         proposal_category: 'META_GOVERNANCE', user_choice: 'AGAINST', proposal_title: 'DIP v1.7 update' },
      { proposal_id: 'cal-010-doc-translation',    proposal_category: 'GRANT',           user_choice: 'FOR',     proposal_title: 'Doc translation $12k milestones' },
      { proposal_id: 'cal-011-analytics-tooling',  proposal_category: 'GRANT',           user_choice: 'FOR',     proposal_title: 'Analytics tooling $30k milestones' },
      { proposal_id: 'cal-016-sdk-maintenance',    proposal_category: 'GRANT',           user_choice: 'FOR',     proposal_title: 'SDK maintenance $40k milestones' },
      { proposal_id: 'cal-019-mystery-grant',      proposal_category: 'GRANT',           user_choice: 'AGAINST', proposal_title: '500k ARB to anonymous multisig' },
    ],
  },
  {
    name: 'Delegation-leaning user',
    stated_values_text: [
      'On technical parameter changes, I want to follow l2beat.eth unless they have not voted.',
      'I trust the foundation on routine operational decisions.',
      'Large treasury commitments should always come to me for review.',
    ].join(' '),
    calibration: [
      { proposal_id: 'cal-002-security-council',   proposal_category: 'PARAMETER_CHANGE', user_choice: 'ABSTAIN',  proposal_title: 'Security council 7-of-12' },
      { proposal_id: 'cal-015-fee-tweak',          proposal_category: 'PARAMETER_CHANGE', user_choice: 'FOR',      proposal_title: 'Sequencer fee -5%' },
      { proposal_id: 'cal-020-l2beat-followed-vote', proposal_category: 'PARAMETER_CHANGE', user_choice: 'FOR',    proposal_title: 'l2beat-followed param tweak' },
      { proposal_id: 'cal-001-stip-extension',     proposal_category: 'TREASURY_SPEND',  user_choice: 'ABSTAIN',  proposal_title: 'Extend STIP 50M ARB' },
    ],
  },
  {
    name: 'Manual-review-everything user',
    stated_values_text:
      'I want every proposal reviewed by hand. I do not trust automated voting yet, even for routine grants. Show me everything before any vote is cast.',
    calibration: [],
  },
];

function pretty(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function summarize(p: any) {
  console.log(`  default_action:           ${p.default_action}`);
  console.log(`  manual_review_categories: ${(p.manual_review_categories ?? []).join(', ') || '(none)'}`);
  console.log(`  manual_review_flags:      ${(p.manual_review_flags ?? []).join(', ') || '(none)'}`);
  console.log(`  large_treasury_usd:       ${p.large_treasury_usd ?? 'null'}`);
  console.log(`  hard_rules:               ${pretty(p.hard_rules)}`);
  console.log(`  delegation_rules:         ${pretty(p.delegation_rules)}`);
  console.log(`  category_defaults:        (${(p.category_defaults ?? []).length})`);
  for (const d of p.category_defaults ?? []) {
    const extras = [
      d.max_treasury_usd != null ? `max=$${d.max_treasury_usd.toLocaleString()}` : null,
      d.require_milestones ? 'milestones' : null,
      d.require_reporting ? 'reporting' : null,
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`    - ${d.category} → ${d.action} ${extras}  // ${d.reason ?? ''}`);
  }
  console.log(`  stated_values:            (${(p.stated_values ?? []).length})`);
  for (const v of p.stated_values ?? []) console.log(`    - ${v}`);
}

for (const s of SCENARIOS) {
  console.log('\n========================================');
  console.log(`SCENARIO: ${s.name}`);
  console.log('----------------------------------------');
  console.log(`Values: ${s.stated_values_text.slice(0, 200)}${s.stated_values_text.length > 200 ? '…' : ''}`);
  console.log(`Calibration: ${s.calibration.length} votes`);
  const r = await compileProfile(s);
  console.log(`Source:  ${r.source}${r.warnings ? ` (${r.warnings.join('; ')})` : ''}`);
  console.log('----------------------------------------');
  summarize(r.profile);
}
