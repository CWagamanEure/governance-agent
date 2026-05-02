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

The user has provided plain-text values and a set of calibration votes on real past proposals. Your job is to infer the structured profile that captures their intent.

Hard rules:
- Each entry in stated_values must be one declarative sentence in the user's own voice, paraphrased only as needed for clarity. Do not invent values they didn't express.
- Use concrete governance policy primitives, not abstract value scores.
- default_action should normally be ABSTAIN unless the user clearly wants MANUAL_REVIEW by default.
- category_defaults are routine autopilot rules. Use FOR only for low-stakes categories with clear safeguards such as max_treasury_usd, require_milestones, or require_reporting.
- manual_review_categories should include CONTRACT_UPGRADE and OWNERSHIP_TRANSFER by default. Add TOKENOMICS, TREASURY_SPEND, META_GOVERNANCE, or PARTNERSHIP if the user is cautious about them.
- manual_review_flags should include LOW_CONFIDENCE_EXTRACTION. Add flags that match the user's concerns.
- delegation_rules encode "follow delegate X on category Y". Use fallback MANUAL_REVIEW unless the user explicitly wants abstain/category default.
- hard_rules encode simple global limits: large single-recipient treasury caps, emission increase preference, and whether treasury spends need milestones.
- author_blocklist: empty unless the user named specific addresses.

Calibration votes that are marked "personal_not_policy" are excluded — only generalize from the rest.`;

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
