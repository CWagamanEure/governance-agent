/**
 * Wallet connect + SIWE flow + bearer-token storage for the frontend.
 *
 * - Uses window.ethereum (any injected EVM wallet — MetaMask, Rainbow, etc.).
 * - SIWE message constructed with viem's helper.
 * - JWT stored in localStorage under TOKEN_KEY.
 * - All authenticated calls flow through authedFetch().
 */

import { createWalletClient, custom, type Address } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { BACKEND_URL } from '../api';

const TOKEN_KEY = 'gov-agent.token';
const ADDRESS_KEY = 'gov-agent.address';

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredAddress(): Address | null {
  return (localStorage.getItem(ADDRESS_KEY) as Address | null) ?? null;
}

export function setStoredAuth(address: string, token: string) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ADDRESS_KEY, address.toLowerCase());
}

export function clearStoredAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ADDRESS_KEY);
}

// ---------------------------------------------------------------------------
// Authed fetch
// ---------------------------------------------------------------------------

export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getStoredToken();
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

// ---------------------------------------------------------------------------
// Wallet connect — returns the connected EOA address
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    ethereum?: any;
  }
}

// Wallet UX timeout. requestAddresses() and signMessage() depend on the
// extension's own popup, which can be dismissed by the OS / extension chrome
// without ever firing back to the page. Without this, an aborted SIWE flow
// hangs the demo silently. 45s is generous enough for the user to actually
// click but short enough to surface a clear error before it's awkward.
const WALLET_OP_TIMEOUT_MS = 45_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `${label} timed out after ${Math.round(ms / 1000)}s — the wallet popup may have been closed or dismissed. Try again.`,
          ),
        ),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function connectWallet(): Promise<Address> {
  if (!window.ethereum) {
    throw new Error('No injected wallet found. Install MetaMask or another EVM wallet.');
  }
  const wallet = createWalletClient({ transport: custom(window.ethereum) });
  const [address] = await withTimeout(
    wallet.requestAddresses(),
    WALLET_OP_TIMEOUT_MS,
    'Wallet connect',
  );
  if (!address) throw new Error('Wallet did not return an address.');
  return address;
}

// ---------------------------------------------------------------------------
// Full SIWE flow — connect → fetch nonce → sign message → POST verify → store token
// ---------------------------------------------------------------------------

export async function signInWithEthereum(): Promise<{ address: Address; token: string }> {
  if (!window.ethereum) {
    throw new Error('No injected wallet found. Install MetaMask or another EVM wallet.');
  }

  const wallet = createWalletClient({ transport: custom(window.ethereum) });
  const [address] = await withTimeout(
    wallet.requestAddresses(),
    WALLET_OP_TIMEOUT_MS,
    'Wallet connect',
  );
  if (!address) throw new Error('Wallet did not return an address.');

  // 1. Fetch a fresh nonce from the backend
  const nonceRes = await fetch(`${BACKEND_URL}/auth/siwe/nonce`, { method: 'POST' });
  if (!nonceRes.ok) throw new Error(`nonce request failed: ${nonceRes.status}`);
  const { nonce } = (await nonceRes.json()) as { nonce: string };

  // 2. Build the SIWE message
  const message = createSiweMessage({
    domain: window.location.host,
    address,
    statement: 'Sign in to the verifiable governance agent. This signature does not authorize any onchain action.',
    uri: window.location.origin,
    version: '1',
    chainId: 1,
    nonce,
    issuedAt: new Date(),
  });

  // 3. Ask the wallet to sign it
  const signature = await withTimeout(
    wallet.signMessage({ account: address, message }),
    WALLET_OP_TIMEOUT_MS,
    'Sign-in signature',
  );

  // 4. POST to /auth/siwe/verify
  const verifyRes = await fetch(`${BACKEND_URL}/auth/siwe/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
  if (!verifyRes.ok) {
    const err = await verifyRes.text();
    throw new Error(`SIWE verify failed: ${verifyRes.status} ${err}`);
  }
  const { token, address: returnedAddress } = (await verifyRes.json()) as {
    token: string;
    address: string;
  };

  setStoredAuth(returnedAddress, token);
  return { address: returnedAddress as Address, token };
}

export async function checkSession(): Promise<{ address: string } | null> {
  const token = getStoredToken();
  if (!token) return null;
  const res = await fetch(`${BACKEND_URL}/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { authenticated: boolean; address?: string };
  if (j.authenticated && j.address) return { address: j.address };
  // token rejected — clear it
  clearStoredAuth();
  return null;
}
