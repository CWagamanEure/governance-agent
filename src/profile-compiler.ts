/**
 * Profile compiler.
 *
 * Turns a user's free-text values + calibration votes into a structured
 * PolicyProfile. The LLM does this work at SETUP TIME — voting decisions
 * still come from the deterministic policy engine.
 *
 * If the LLM gateway is unavailable, falls back to a heuristic compiler so
 * the onboarding flow still works (lower-quality profile, but valid).
 */

import { generateObject } from 'ai';
import { PolicyProfile, type PolicyProfileT } from './policy.js';
import { pickModel } from './llm.js';

export type CalibrationChoice = {
  proposal_id: string;
  proposal_title?: string;
  proposal_summary?: string;
  proposal_category?: string;
  user_choice: 'FOR' | 'AGAINST' | 'ABSTAIN';
  reason?: string;
  personal_not_policy?: boolean;
};

export type CompileInput = {
  stated_values_text: string;
  calibration: CalibrationChoice[];
};

export type CompileResult = {
  profile: PolicyProfileT;
  source: 'llm' | 'fallback';
  warnings?: string[];
};

const SYSTEM = `You are compiling a user's governance preferences into a structured PolicyProfile.

The user has provided plain-text values and a set of calibration votes on real past proposals. Your job is to infer the structured profile that captures their intent — CONSERVATIVELY. The rules you generate will execute deterministically against future proposals; an autovote rule that fires on an adversarial proposal that "looks routine" is a real failure mode. Err toward MANUAL_REVIEW when calibration evidence is thin or values text is silent.

PRIORITY ORDER:
1. Stated values text takes precedence when explicit ("I want to follow l2beat on technical changes" → delegation_rule).
2. Calibration vote patterns refine where text is silent.
3. Conservative defaults fill the rest.

WHEN TO EMIT AN AUTOVOTE RULE (category_defaults with action FOR or AGAINST):
Only when ALL of these hold:
  (a) At least 2 calibration votes within the same category point the same direction, AND
  (b) The pattern is narrow enough to defeat adversarial proposals — autovote rules MUST include constraining conditions such as max_treasury_usd, require_milestones, require_reporting. "GRANT FOR" with no other conditions is never acceptable; "GRANT FOR under $X with milestones and reporting" is.
  (c) The user's stated values do not contradict the pattern. If user says "I'm skeptical of recurring spend" but voted FOR a recurring grant in calibration, the values text wins — do NOT autovote.

If conditions aren't met, leave that category off category_defaults entirely. The default_action will catch it.

EXAMPLES:

Example 1 — user wants accountable small grants:
  Values: "I support small open-source ecosystem grants under $50k that have milestones."
  Calibration: FOR on cal-010-doc-translation ($12k, milestones), FOR on cal-011-analytics-tooling ($30k, milestones), FOR on cal-016-sdk-maintenance ($40k, milestones).
  Pattern: GRANT under $50k with milestones is consistently FOR (3 votes, all same direction).
  =>  category_defaults: [{ category: 'GRANT', action: 'FOR', max_treasury_usd: 50000, require_milestones: true, require_reporting: true, reason: 'small accountable grants align with stated values and calibration' }]

Example 2 — user is skeptical, calibration is mixed:
  Values: "I'm skeptical of recurring spend without clear KPIs."
  Calibration: AGAINST on cal-001-stip-extension, ABSTAIN on cal-006-dip-update, FOR on cal-012-gas-rebate-extension.
  Pattern: mixed. Values text is conservative.
  =>  category_defaults: []  (no autovote — values text contradicts mixed calibration)
  =>  manual_review_categories includes TREASURY_SPEND, META_GOVERNANCE
  =>  manual_review_flags includes LARGE_TREASURY_SPEND, NO_MILESTONES

Example 3 — explicit delegation:
  Values: "On technical parameter changes, I want to follow l2beat.eth unless they have not voted."
  =>  delegation_rules: [{ category: 'PARAMETER_CHANGE', delegate: 'l2beat.eth', fallback: 'MANUAL_REVIEW' }]
  =>  do NOT also emit a PARAMETER_CHANGE category_default — the delegation rule is the policy.

Example 4 — user is conservative across the board:
  Values: "I want everything reviewed by hand. I don't trust automated voting yet."
  =>  default_action: 'MANUAL_REVIEW'
  =>  category_defaults: []
  =>  This is a valid output. Not every user wants autovoting.

CONSTRAINTS ON OTHER FIELDS:

- stated_values: each entry is one declarative sentence in the user's own voice, paraphrased only for clarity. Do NOT invent values they didn't express.
- default_action: 'MANUAL_REVIEW' unless the user explicitly wants ABSTAIN-as-default ("if you can't decide, just abstain").
- manual_review_categories: ALWAYS include 'CONTRACT_UPGRADE' and 'OWNERSHIP_TRANSFER'. Add 'TOKENOMICS' if user mentions emissions/buybacks/token supply. Add 'TREASURY_SPEND' if user mentions large/recurring spend skepticism. Add 'META_GOVERNANCE' if user mentions governance process or delegate compensation skepticism. Add 'PARTNERSHIP' if user mentions concentration/decentralization concerns.
- manual_review_flags: ALWAYS include 'LOW_CONFIDENCE_EXTRACTION', 'UNKNOWN_TREASURY_AMOUNT', 'LARGE_TREASURY_SPEND', 'CONTRACT_UPGRADE', 'OWNERSHIP_OR_PERMISSION_CHANGE', 'CONSTITUTIONAL_CHANGE', 'UNCLEAR_BENEFICIARIES', 'UNKNOWN_RECIPIENT'. Additionally include 'SINGLE_RECIPIENT_TREASURY' and 'NO_MILESTONES' if user mentions accountability or recipient-identifiability concerns.
- author_blocklist: empty unless the user named specific addresses.
- hard_rules:
    * max_single_recipient_treasury_usd: set if user expressed any cap-on-single-recipient preference, otherwise null.
    * vote_against_emission_increases: true unless user explicitly wants emission growth.
    * require_milestones_for_treasury: true unless user is explicitly permissive on milestones.

Calibration votes marked "personal_not_policy" are excluded entirely — do not generalize from them.`;

export async function compileProfile(input: CompileInput): Promise<CompileResult> {
  try {
    const profile = await compileViaLlm(input);
    return { profile, source: 'llm' };
  } catch (e) {
    const profile = fallbackCompile(input);
    const msg = e instanceof Error ? e.message : String(e);
    return {
      profile,
      source: 'fallback',
      warnings: [`LLM compilation unavailable (${msg}); used heuristic fallback.`],
    };
  }
}

async function compileViaLlm(input: CompileInput): Promise<PolicyProfileT> {
  const { model } = pickModel('sonnet');

  const usable = input.calibration.filter((c) => !c.personal_not_policy);
  const calibrationText = usable.length === 0
    ? '(no calibration votes provided)'
    : usable
        .map((c) => {
          const cat = c.proposal_category ? ` [${c.proposal_category}]` : '';
          const reason = c.reason ? `\n  Reason given: ${c.reason}` : '';
          return `- "${c.proposal_title ?? c.proposal_id}"${cat}\n  User voted: ${c.user_choice}${reason}`;
        })
        .join('\n\n');

  const prompt = `${SYSTEM}

USER'S STATED VALUES (verbatim):
${input.stated_values_text || '(none)'}

CALIBRATION VOTES:
${calibrationText}

Compile the PolicyProfile.`;

  const { object } = await generateObject({
    model,
    schema: PolicyProfile,
    prompt,
    temperature: 0,
  });

  return object;
}

// ---------------------------------------------------------------------------
// Heuristic fallback — keyword + voting-pattern based.
// Lower quality than LLM compile but always works.
// ---------------------------------------------------------------------------

function fallbackCompile(input: CompileInput): PolicyProfileT {
  const text = input.stated_values_text.toLowerCase();

  const stated = input.stated_values_text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);

  const hasDecent = /decentral|community.run|grass.?roots|distributed/.test(text);
  const dislikesCent = /corporate|centraliz|consolid/.test(text);
  const wantsSustain = /sustain|public good|long.?term|infrastructure/.test(text);
  const isConservative =
    /conservativ|skeptic|carefully|cautious|recurring spend|measurable|milestone/.test(text);
  const wantsGrowth = /aggressive|growth|move fast|ship/.test(text);
  const riskAverse = /risk.?averse|safe|reversible/.test(text);
  const wantsDelegation = /follow|delegate|l2beat|vitalik|expert/.test(text);

  const policyVotes = input.calibration.filter((c) => !c.personal_not_policy);
  const totalVotes = policyVotes.length;
  const againstRate = totalVotes > 0
    ? policyVotes.filter((c) => c.user_choice === 'AGAINST').length / totalVotes
    : 0;

  const cautious = isConservative || riskAverse || againstRate > 0.4;
  const grantCap = cautious ? 50_000 : wantsGrowth ? 250_000 : 100_000;
  const largeTreasury = cautious ? 100_000 : wantsGrowth ? 2_000_000 : 500_000;

  return {
    schema_version: 'policy-v2',
    default_action: cautious ? 'MANUAL_REVIEW' : 'ABSTAIN',
    category_defaults: [
      {
        category: 'GRANT',
        action: cautious ? 'MANUAL_REVIEW' : 'FOR',
        max_treasury_usd: grantCap,
        require_milestones: true,
        require_reporting: !wantsGrowth,
        proposer_types: [],
        reason: cautious
          ? 'review grants unless they are explicitly approved later'
          : `routine grant under $${grantCap.toLocaleString()} with accountability`,
      },
      ...(wantsGrowth
        ? [
            {
              category: 'PARTNERSHIP' as const,
              action: 'FOR' as const,
              max_treasury_usd: 100_000,
              require_milestones: false,
              require_reporting: true,
              proposer_types: ['FOUNDATION' as const, 'CORE_TEAM' as const, 'DELEGATE' as const],
              reason: 'support accountable growth partnerships from known actors',
            },
          ]
        : []),
    ],
    manual_review_categories: [
      'CONTRACT_UPGRADE',
      'OWNERSHIP_TRANSFER',
      ...(cautious ? (['TOKENOMICS', 'TREASURY_SPEND'] as const) : []),
    ],
    manual_review_flags: [
      'LOW_CONFIDENCE_EXTRACTION',
      'UNKNOWN_TREASURY_AMOUNT',
      'LARGE_TREASURY_SPEND',
      'CONTRACT_UPGRADE',
      'OWNERSHIP_OR_PERMISSION_CHANGE',
      'CONSTITUTIONAL_CHANGE',
      'UNCLEAR_BENEFICIARIES',
      'UNKNOWN_RECIPIENT',
      ...(cautious ? (['SINGLE_RECIPIENT_TREASURY', 'NO_MILESTONES'] as const) : []),
    ],
    large_treasury_usd: largeTreasury,
    author_blocklist: [],
    delegation_rules: wantsDelegation
      ? [
          {
            category: 'PARAMETER_CHANGE',
            delegate: /l2beat/.test(text) ? 'l2beat.eth' : /vitalik/.test(text) ? 'vitalik.eth' : 'trusted-delegate.eth',
            fallback: 'MANUAL_REVIEW',
            wait_until_hours_before_end: 6,
          },
        ]
      : [],
    hard_rules: {
      max_single_recipient_treasury_percent: cautious ? 0.25 : 0.5,
      max_single_recipient_treasury_usd: cautious ? 100_000 : 250_000,
      vote_against_emission_increases: !wantsGrowth,
      vote_for_emission_cuts: wantsSustain || hasDecent || dislikesCent,
      require_milestones_for_treasury: true,
    },
    stated_values: stated,
  };
}
