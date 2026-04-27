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
- Axes are 1..5 integers. Default to 3 (neutral) when the user is silent on that axis.
  - treasury_conservatism: 5 = very conservative, 1 = spend freely
  - decentralization_priority: 5 = prioritize decentralization, 1 = centralization is OK
  - growth_vs_sustainability: 5 = sustainability/long-term, 1 = aggressive growth
  - protocol_risk_tolerance: 5 = risk-averse, 1 = risk-tolerant
- max_treasury_usd_auto: a USD number (or null). Default 500000 unless the user expresses a clear cap.
- manual_review_categories: include CONTRACT_UPGRADE and OWNERSHIP_TRANSFER by default. Add others if the user clearly wants to review them.
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

  const policyVotes = input.calibration.filter((c) => !c.personal_not_policy);
  const totalVotes = policyVotes.length;
  const againstRate = totalVotes > 0
    ? policyVotes.filter((c) => c.user_choice === 'AGAINST').length / totalVotes
    : 0;

  // Conservative if user said so OR votes AGAINST > 40% of the time.
  const conservatism = isConservative || againstRate > 0.4 ? 4 : wantsGrowth ? 2 : 3;
  const decentralization = hasDecent ? 5 : dislikesCent ? 4 : 3;
  const sustainability = wantsSustain ? 4 : wantsGrowth ? 2 : 3;
  const riskTolerance = riskAverse ? 4 : wantsGrowth ? 2 : 3;

  return {
    treasury_conservatism: conservatism,
    decentralization_priority: decentralization,
    growth_vs_sustainability: sustainability,
    protocol_risk_tolerance: riskTolerance,
    max_treasury_usd_auto: 500_000,
    author_blocklist: [],
    manual_review_categories: ['CONTRACT_UPGRADE', 'OWNERSHIP_TRANSFER'],
    stated_values: stated,
  };
}
