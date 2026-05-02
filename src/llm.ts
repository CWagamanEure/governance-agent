/**
 * LLM layer: model picker + schemas + extraction.
 *
 * Call 1 of the pipeline (see PLAN.md §9): structured proposal extraction.
 * The LLM is a schema-bound translator here, not a decision-maker.
 *
 * Routing:
 *   - LLM_PROVIDER=auto: prefer Eigen when KMS auth is injected, otherwise
 *     fall back to direct Anthropic when ANTHROPIC_API_KEY is set.
 *   - LLM_PROVIDER=eigen: force Eigen gateway.
 *   - LLM_PROVIDER=anthropic: force direct Anthropic, useful if the Eigen
 *     gateway keyset is out of sync for a preview deployment.
 *   - LLM_PROVIDER=off: disable live LLM calls; fixture-backed demo paths still
 *     work, and profile compilation uses its heuristic fallback.
 *
 * Both paths produce a LanguageModel the AI SDK's generateObject() accepts.
 */

import { generateObject } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createEigenGateway } from '@layr-labs/ai-gateway-provider';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema — contract between the LLM and the policy engine.
// Keep it tight; every field should be useful to a deterministic rule.
// ---------------------------------------------------------------------------

export const Category = z.enum([
  'TREASURY_SPEND',
  'PARAMETER_CHANGE',
  'CONTRACT_UPGRADE',
  'OWNERSHIP_TRANSFER',
  'GRANT',
  'COUNCIL_APPOINTMENT',
  'PARTNERSHIP',
  'SOCIAL_SIGNAL',
  'PROTOCOL_RISK_CHANGE',
  'TOKENOMICS',
  'META_GOVERNANCE',
  'OTHER',
]);

export const Tradeoff = z.object({
  pro: z.string().max(300),
  con: z.string().max(300),
});

export const Flags = z.object({
  treasury_spend_usd: z
    .number()
    .nullable()
    .describe(
      'USD value being spent from the treasury, if explicitly stated OR convertible from stated token amounts + a price stated in the proposal. Null if unknown. NEVER invent a number.',
    ),
  requires_contract_upgrade: z.boolean(),
  touches_ownership: z.boolean(),
  has_milestones: z.boolean().describe('Are there measurable milestones or KPIs tied to disbursement?'),
  reversible: z
    .boolean()
    .describe('Can this be reversed by a future proposal without significant cost or permanent damage?'),
  time_sensitive: z.boolean(),
});

export const ValueAlignment = z.object({
  decentralization: z
    .number()
    .min(-1)
    .max(1)
    .describe('Does this increase (+) or decrease (-) decentralization? Range -1 to +1.'),
  treasury_conservatism: z
    .number()
    .min(-1)
    .max(1)
    .describe('Is this conservative (+) or aggressive (-) with treasury assets? Range -1 to +1.'),
  growth_vs_sustainability: z
    .number()
    .min(-1)
    .max(1)
    .describe('Does this favor long-term sustainability (+) or short-term growth (-)? Range -1 to +1.'),
  protocol_risk: z
    .number()
    .min(-1)
    .max(1)
    .describe('Does this decrease (+) or increase (-) protocol risk? Range -1 to +1.'),
});

export const Uncertainty = z.object({
  requires_human_judgment: z.boolean(),
  ambiguity_notes: z.string().max(500).default(''),
});

export const ProposalAnalysis = z.object({
  category: Category,
  summary: z
    .string()
    .max(600)
    .describe('One paragraph stating what the proposal does. No opinion, no argument for or against.'),
  tradeoffs: z.array(Tradeoff).max(5),
  affected_parties: z.array(z.string()).max(10),
  flags: Flags,
  value_alignment: ValueAlignment,
  uncertainty: Uncertainty,
});

export type ProposalAnalysisT = z.infer<typeof ProposalAnalysis>;

// ---------------------------------------------------------------------------
// Model picker
// ---------------------------------------------------------------------------

export type ModelAlias = 'sonnet' | 'opus' | 'haiku';

// Anthropic-direct IDs use dashes; Eigen proxy IDs use dots. Map both here.
const MODEL_IDS: Record<ModelAlias, { direct: string; eigen: string }> = {
  sonnet: { direct: 'claude-sonnet-4-6', eigen: 'anthropic/claude-sonnet-4.6' },
  opus: { direct: 'claude-opus-4-7', eigen: 'anthropic/claude-opus-4.7' },
  haiku: { direct: 'claude-haiku-4-5-20251001', eigen: 'anthropic/claude-haiku-4.5' },
};

export type RouteInfo = {
  route: 'eigen-proxy' | 'anthropic-direct';
  modelId: string;
};
type LlmProvider = 'auto' | 'eigen' | 'anthropic' | 'off';

// Sepolia/testnet apps must hit the dev gateway; mainnet apps hit the prod one.
// The KMS that signs JWTs and the gateway that verifies them must be from the
// same environment, otherwise RSA verification fails on the gateway.
const DEFAULT_EIGEN_GATEWAY_URL = 'https://ai-gateway-dev.eigencloud.xyz';

let loggedEigenEnv = false;
function logEigenEnvOnce() {
  if (loggedEigenEnv) return;
  loggedEigenEnv = true;
  const pk = process.env.KMS_PUBLIC_KEY;
  console.log('[eigen] gateway:', process.env.EIGEN_GATEWAY_URL ?? `(default ${DEFAULT_EIGEN_GATEWAY_URL})`);
  console.log('[eigen] KMS_SERVER_URL:', process.env.KMS_SERVER_URL ?? '(unset)');
  console.log('[eigen] KMS_PUBLIC_KEY:', pk ? `${pk.slice(0, 40)}… (${pk.length} chars)` : '(unset)');
  console.log('[eigen] KMS_AUTH_JWT:', process.env.KMS_AUTH_JWT ? '(present)' : '(unset)');
}

function requestedProvider(): LlmProvider {
  const value = (process.env.LLM_PROVIDER ?? 'auto').trim().toLowerCase();
  if (value === 'auto' || value === 'eigen' || value === 'anthropic' || value === 'off') {
    return value;
  }
  throw new Error(`Invalid LLM_PROVIDER '${process.env.LLM_PROVIDER}'. Use auto, eigen, anthropic, or off.`);
}

function anthropicModel(alias: ModelAlias) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY required when LLM_PROVIDER=anthropic');
  }
  const modelId = MODEL_IDS[alias].direct;
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return {
    model: anthropic(modelId),
    info: { route: 'anthropic-direct' as const, modelId },
  };
}

function eigenModel(alias: ModelAlias) {
  const hasJwt = !!process.env.KMS_AUTH_JWT;
  const hasAttest = !!process.env.KMS_SERVER_URL && !!process.env.KMS_PUBLIC_KEY;
  if (!hasJwt && !hasAttest) {
    throw new Error('KMS_AUTH_JWT or KMS_SERVER_URL+KMS_PUBLIC_KEY required when LLM_PROVIDER=eigen');
  }
  logEigenEnvOnce();
  const modelId = MODEL_IDS[alias].eigen;
  const baseURL = process.env.EIGEN_GATEWAY_URL ?? DEFAULT_EIGEN_GATEWAY_URL;
  const eigenGw = createEigenGateway({
    baseURL,
    jwt: process.env.KMS_AUTH_JWT,
    attestConfig: hasAttest
      ? {
          kmsServerURL: process.env.KMS_SERVER_URL!,
          kmsPublicKey: process.env.KMS_PUBLIC_KEY!,
          audience: 'llm-proxy',
        }
      : undefined,
    debug: process.env.EIGEN_DEBUG === 'true',
  });
  return {
    model: eigenGw(modelId),
    info: { route: 'eigen-proxy' as const, modelId },
  };
}

export function pickModel(alias: ModelAlias = 'sonnet'): { model: any; info: RouteInfo } {
  const provider = requestedProvider();
  if (provider === 'off') {
    throw new Error('LLM_PROVIDER=off; live LLM calls are disabled for this deployment');
  }
  if (provider === 'anthropic') return anthropicModel(alias);
  if (provider === 'eigen') return eigenModel(alias);

  // Eigen gateway can authenticate in two modes:
  //   (a) direct JWT via KMS_AUTH_JWT
  //   (b) attestation → JWT exchange via KMS_SERVER_URL + KMS_PUBLIC_KEY
  // Either one is sufficient; EigenCompute typically injects (b).
  const hasJwt = !!process.env.KMS_AUTH_JWT;
  const hasAttest = !!process.env.KMS_SERVER_URL && !!process.env.KMS_PUBLIC_KEY;

  if (hasJwt || hasAttest) return eigenModel(alias);
  if (process.env.ANTHROPIC_API_KEY) return anthropicModel(alias);
  throw new Error(
    'No LLM credentials: set KMS_AUTH_JWT or KMS_SERVER_URL+KMS_PUBLIC_KEY, set ANTHROPIC_API_KEY, or use LLM_PROVIDER=off for fixture-backed preview.',
  );
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const MAX_BODY_CHARS = 25_000;

function buildPrompt(p: {
  title?: string;
  author?: string;
  type?: string;
  choices?: unknown;
  body: string;
}): string {
  return `You are analyzing a DAO governance proposal. Return a precise structured analysis.

Hard rules:
- Categorize into exactly one enum value.
- treasury_spend_usd: set ONLY if the proposal explicitly states a dollar amount OR a token amount with a price conversion stated in the proposal. If you would have to guess, set to null and note it in uncertainty.ambiguity_notes. Never invent numbers.
- value_alignment axes are OBJECTIVE assessments of the proposal's direction, not personal preference.
- summary: state what the proposal does. Do not argue for or against it.
- Never add information not supported by the proposal text.
- If you cannot confidently determine a boolean flag, set uncertainty.requires_human_judgment=true and explain in ambiguity_notes.

PROPOSAL

Title: ${p.title ?? ''}
Author: ${p.author ?? ''}
Type: ${p.type ?? ''}
Choices: ${JSON.stringify(p.choices ?? [])}

Body:
${p.body}
`;
}

export type ExtractionResult =
  | {
      ok: true;
      analysis: ProposalAnalysisT;
      meta: {
        route: RouteInfo['route'];
        modelId: string;
        usage: unknown;
        bodyTruncated: boolean;
      };
    }
  | {
      ok: false;
      error: string;
      meta: {
        route?: RouteInfo['route'];
        modelId?: string;
        bodyTruncated: boolean;
      };
    };

export async function extractOne(
  proposal: {
    id: string;
    title?: string;
    author?: string;
    type?: string;
    choices?: unknown;
    body?: string;
  },
  modelAlias: ModelAlias = 'sonnet',
): Promise<ExtractionResult> {
  const fullBody = proposal.body ?? '';
  const bodyTruncated = fullBody.length > MAX_BODY_CHARS;
  const body = bodyTruncated ? fullBody.slice(0, MAX_BODY_CHARS) : fullBody;

  let info: RouteInfo | undefined;
  try {
    const picked = pickModel(modelAlias);
    info = picked.info;
    const result = await generateObject({
      model: picked.model,
      schema: ProposalAnalysis,
      prompt: buildPrompt({
        title: proposal.title,
        author: proposal.author,
        type: proposal.type,
        choices: proposal.choices,
        body,
      }),
      temperature: 0,
    });
    return {
      ok: true,
      analysis: result.object,
      meta: {
        route: info.route,
        modelId: info.modelId,
        usage: result.usage,
        bodyTruncated,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: msg,
      meta: {
        route: info?.route,
        modelId: info?.modelId,
        bodyTruncated,
      },
    };
  }
}
