/**
 * SIWE (Sign-In With Ethereum, EIP-4361) auth + JWT bearer tokens.
 *
 * Flow:
 *   1. POST /auth/siwe/nonce        → server generates one-shot nonce
 *   2. Client builds SIWE message with that nonce, user signs it
 *   3. POST /auth/siwe/verify       → server verifies signature + consumes nonce,
 *                                     issues a JWT (HS256, 7-day expiry)
 *   4. Frontend stores JWT, sends `Authorization: Bearer <jwt>` on subsequent calls
 *
 * Security shape:
 *   - JWT signing key is HMAC-SHA256 derived from the platform-injected
 *     MNEMONIC, so it survives restarts and only exists inside the TEE. If
 *     the enclave is upgraded and MNEMONIC stays the same (we confirmed it
 *     does), tokens remain valid; if MNEMONIC ever rotates, all tokens
 *     invalidate, which is the correct failure mode.
 *   - Nonces are single-use, 5-minute TTL, in-memory (single-process app).
 *   - Tokens go in the Authorization header, not cookies — simpler CORS, no
 *     SameSite footgun. Trade-off is XSS would expose them; acceptable for
 *     a hackathon demo.
 */

import { randomBytes, createHmac } from 'node:crypto';
import { verifyMessage } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { SignJWT, jwtVerify } from 'jose';
import type { Context, Next } from 'hono';

// ---------------------------------------------------------------------------
// One-shot nonce store (in-memory, 5-min TTL)
// ---------------------------------------------------------------------------

const NONCE_TTL_MS = 5 * 60 * 1000;
const nonces = new Map<string, number>(); // nonce → issued_at

function pruneNonces() {
  const cutoff = Date.now() - NONCE_TTL_MS;
  for (const [k, t] of nonces) {
    if (t < cutoff) nonces.delete(k);
  }
}

export function generateNonce(): string {
  pruneNonces();
  // SIWE alphanumeric, 17+ chars
  const nonce = randomBytes(12).toString('base64url');
  nonces.set(nonce, Date.now());
  return nonce;
}

function consumeNonce(nonce: string): boolean {
  const t = nonces.get(nonce);
  if (!t) return false;
  nonces.delete(nonce);
  return Date.now() - t <= NONCE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Session secret (HMAC key derived from MNEMONIC)
// ---------------------------------------------------------------------------

let _secret: Uint8Array | null = null;
function sessionSecret(): Uint8Array {
  if (_secret) return _secret;
  const m = process.env.MNEMONIC;
  if (!m) throw new Error('MNEMONIC required to derive session secret');
  _secret = new Uint8Array(createHmac('sha256', m).update('siwe-session-v1').digest());
  return _secret;
}

// ---------------------------------------------------------------------------
// SIWE verification + token issuance
// ---------------------------------------------------------------------------

export type VerifiedSiwe = { address: `0x${string}` };

export async function verifySiwe(args: {
  message: string;
  signature: `0x${string}`;
}): Promise<VerifiedSiwe> {
  const fields = parseSiweMessage(args.message);
  if (!fields.address) throw new Error('SIWE message missing address');
  if (!fields.nonce) throw new Error('SIWE message missing nonce');

  if (!consumeNonce(fields.nonce)) {
    throw new Error('nonce invalid, expired, or already consumed');
  }

  const ok = await verifyMessage({
    address: fields.address as `0x${string}`,
    message: args.message,
    signature: args.signature,
  });
  if (!ok) throw new Error('signature does not recover to claimed address');

  return { address: fields.address as `0x${string}` };
}

export async function issueSession(address: string): Promise<string> {
  return await new SignJWT({ address: address.toLowerCase() })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(sessionSecret());
}

export async function readSession(token: string): Promise<{ address: string } | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret(), { algorithms: ['HS256'] });
    if (typeof payload.address === 'string' && /^0x[0-9a-f]{40}$/.test(payload.address)) {
      return { address: payload.address };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hono middleware
// ---------------------------------------------------------------------------

/**
 * Reads the Authorization header (if any), populates `c.get('user_address')`
 * when a valid token is present. Always proceeds — does NOT reject unauthed
 * requests. Use `requireAuth(c)` in handlers that need an address.
 */
export async function readAuth(c: Context, next: Next) {
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    const sess = await readSession(token);
    if (sess) c.set('user_address', sess.address);
  }
  await next();
}

export function getAuthedAddress(c: Context): string | null {
  const v = c.get('user_address');
  return typeof v === 'string' ? v : null;
}

export function requireAuth(c: Context): string {
  const addr = getAuthedAddress(c);
  if (!addr) {
    throw new AuthRequiredError();
  }
  return addr;
}

export class AuthRequiredError extends Error {
  status = 401 as const;
  constructor() {
    super('authentication required');
  }
}
