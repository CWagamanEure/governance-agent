/**
 * Wallet derivation.
 *
 * Two flavors:
 *   - appWallet():  the default-path wallet, used by single-user demo paths
 *                   and by anything that represents the agent's own identity.
 *   - userWallet(eth_address):  per-user deterministic derivation from the
 *                   platform-injected MNEMONIC + the user's eth_address.
 *                   Same TEE → same MNEMONIC → same derived wallet for a
 *                   given user. Nobody outside the enclave can compute these
 *                   addresses without the mnemonic; nobody inside can sign as
 *                   anyone but their derived self.
 *
 * The derivation path uses BIP-44 with coin type 60 (Ethereum). The address
 * index is a stable 31-bit integer derived from a sha256 of the user address,
 * so it survives upgrades and is collision-resistant for any practical N.
 */

import { createHash } from 'node:crypto';
import { mnemonicToAccount, type HDAccount } from 'viem/accounts';

const DEFAULT_PATH = "m/44'/60'/0'/0/0";

function requireMnemonic(): string {
  const m = process.env.MNEMONIC;
  if (!m) {
    throw new Error(
      'MNEMONIC env var not set. Auto-injected by EigenCompute in production; locally set one in .env.',
    );
  }
  return m;
}

export function appWallet(): HDAccount {
  return mnemonicToAccount(requireMnemonic());
}

/**
 * Derive a stable per-user wallet from the MNEMONIC and an Ethereum address.
 * Index range is [0, 2^31), well within BIP-44 valid range.
 */
export function userWallet(eth_address: `0x${string}` | string): HDAccount {
  const normalized = eth_address.toLowerCase().replace(/^0x/, '');
  const digest = createHash('sha256').update(normalized).digest();
  // Take 4 bytes, mask to 31 bits to stay within a non-hardened index.
  const idx = digest.readUInt32BE(0) & 0x7fffffff;
  const path = `m/44'/60'/0'/0/${idx}`;
  return mnemonicToAccount(requireMnemonic(), { path });
}

export const WALLET_PATHS = { default: DEFAULT_PATH };
