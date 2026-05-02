import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { AttestClient } from '@layr-labs/ecloud-sdk/attest';

import { stableStringify } from './decision-blob.js';

const DEFAULT_SOCKET_PATH = '/run/container_launcher/teeserver.sock';

type DecodedJwt = {
  header: unknown;
  payload: unknown;
  signature_b64url_len: number;
  token_sha256: string;
};

type BoundEvidence =
  | {
      ok: true;
      socket_path: string;
      challenge_b64: string;
      challenge_sha256: string;
      evidence_b64: string;
      evidence_sha256: string;
      evidence_bytes: number;
    }
  | {
      ok: false;
      socket_path: string;
      challenge_b64?: string;
      challenge_sha256?: string;
      error: string;
    };

type KmsJwtSummary =
  | {
      ok: true;
      source: 'KMS_AUTH_JWT' | 'attest-client';
      audience: string;
      decoded: DecodedJwt;
    }
  | {
      ok: false;
      source: 'none' | 'KMS_AUTH_JWT' | 'attest-client';
      audience: string;
      error: string;
    };

export type AttestationReport = {
  status: 'available' | 'unavailable';
  generated_at: number;
  app: {
    name: 'governance-agent';
    version: string;
    wallet_address: string | null;
    public_env: Record<string, string>;
  };
  runtime: {
    tee_socket_path: string;
    kms_server_url_present: boolean;
    kms_public_key_present: boolean;
    kms_auth_jwt_present: boolean;
  };
  bound_evidence: BoundEvidence;
  kms_jwt: KmsJwtSummary;
};

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function decodeJwt(token: string): DecodedJwt {
  const [h, p, s] = token.split('.');
  const decode = (seg: string) =>
    JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  return {
    header: h ? decode(h) : null,
    payload: p ? decode(p) : null,
    signature_b64url_len: s?.length ?? 0,
    token_sha256: sha256Hex(token),
  };
}

function getBoundEvidence(socketPath: string, challenge: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ challenge: challenge.toString('base64') });
    const req = http.request(
      {
        socketPath,
        path: '/v1/bound_evidence',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            reject(new Error(`TEE attestation failed (${res.statusCode}): ${data.toString()}`));
            return;
          }
          resolve(data);
        });
      },
    );
    req.on('error', (err) => reject(new Error(`TEE attestation request failed: ${err.message}`)));
    req.write(body);
    req.end();
  });
}

async function buildBoundEvidence(args: {
  socketPath: string;
  walletAddress: string | null;
  publicEnv: Record<string, string>;
  version: string;
}): Promise<BoundEvidence> {
  const challengeInput = stableStringify({
    purpose: 'governance-agent-attestation-v1',
    nonce: randomBytes(16).toString('hex'),
    wallet_address: args.walletAddress,
    public_env: args.publicEnv,
    version: args.version,
    ts: Date.now(),
  });
  const challenge = Buffer.from(sha256Hex(challengeInput), 'hex');
  const challenge_b64 = challenge.toString('base64');
  const challenge_sha256 = sha256Hex(challenge);

  if (!existsSync(args.socketPath)) {
    return {
      ok: false,
      socket_path: args.socketPath,
      challenge_b64,
      challenge_sha256,
      error: 'TEE bound-evidence socket not present in this runtime',
    };
  }

  try {
    const evidence = await getBoundEvidence(args.socketPath, challenge);
    return {
      ok: true,
      socket_path: args.socketPath,
      challenge_b64,
      challenge_sha256,
      evidence_b64: evidence.toString('base64'),
      evidence_sha256: sha256Hex(evidence),
      evidence_bytes: evidence.length,
    };
  } catch (e) {
    return {
      ok: false,
      socket_path: args.socketPath,
      challenge_b64,
      challenge_sha256,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function buildKmsJwtSummary(audience: string): Promise<KmsJwtSummary> {
  const injected = process.env.KMS_AUTH_JWT;
  if (injected) {
    try {
      return { ok: true, source: 'KMS_AUTH_JWT', audience, decoded: decodeJwt(injected) };
    } catch (e) {
      return {
        ok: false,
        source: 'KMS_AUTH_JWT',
        audience,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const kmsServerURL = process.env.KMS_SERVER_URL;
  const kmsPublicKey = process.env.KMS_PUBLIC_KEY;
  if (!kmsServerURL || !kmsPublicKey) {
    return {
      ok: false,
      source: 'none',
      audience,
      error: 'KMS_AUTH_JWT not present and KMS_SERVER_URL/KMS_PUBLIC_KEY are incomplete',
    };
  }

  try {
    const client = new AttestClient({ kmsServerURL, kmsPublicKey, audience });
    const jwt = await client.attest();
    return { ok: true, source: 'attest-client', audience, decoded: decodeJwt(jwt) };
  } catch (e) {
    return {
      ok: false,
      source: 'attest-client',
      audience,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function buildAttestationReport(args: {
  version: string;
  walletAddress: string | null;
  publicEnv: Record<string, string>;
  audience?: string;
}): Promise<AttestationReport> {
  const socketPath = process.env.TEE_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
  const audience = args.audience ?? 'llm-proxy';
  const boundEvidence = await buildBoundEvidence({
    socketPath,
    walletAddress: args.walletAddress,
    publicEnv: args.publicEnv,
    version: args.version,
  });
  const kmsJwt = await buildKmsJwtSummary(audience);

  return {
    status: boundEvidence.ok || kmsJwt.ok ? 'available' : 'unavailable',
    generated_at: Date.now(),
    app: {
      name: 'governance-agent',
      version: args.version,
      wallet_address: args.walletAddress,
      public_env: args.publicEnv,
    },
    runtime: {
      tee_socket_path: socketPath,
      kms_server_url_present: !!process.env.KMS_SERVER_URL,
      kms_public_key_present: !!process.env.KMS_PUBLIC_KEY,
      kms_auth_jwt_present: !!process.env.KMS_AUTH_JWT,
    },
    bound_evidence: boundEvidence,
    kms_jwt: kmsJwt,
  };
}
