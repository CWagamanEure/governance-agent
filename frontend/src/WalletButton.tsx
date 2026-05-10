/**
 * Wallet button + connect/disconnect modals.
 *
 * Two states:
 *  - Anonymous: gradient "Connect wallet" pill. On click, a modal asks the
 *    user to confirm — we only support browser-injected wallets (window.ethereum)
 *    today, so the modal has one option, but it's structured so we can add
 *    WalletConnect / others later.
 *  - Authed: pill with deterministic gradient avatar + truncated address.
 *    On click, a modal shows the full address (with copy) and a Disconnect
 *    button.
 */

import { useState, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authed'; address: string };

export function WalletButton({
  auth,
  onSignIn,
  onSignOut,
}: {
  auth: AuthState;
  onSignIn: () => Promise<void> | void;
  onSignOut: () => void;
}) {
  const [showConnect, setShowConnect] = useState(false);
  const [showAccount, setShowAccount] = useState(false);

  if (auth.status === 'loading') {
    return <div className="wallet-pill" aria-busy>…</div>;
  }

  if (auth.status === 'anonymous') {
    return (
      <>
        <button className="wallet-cta" onClick={() => setShowConnect(true)}>
          Connect wallet
        </button>
        {showConnect && (
          <ConnectModal
            onClose={() => setShowConnect(false)}
            onConnect={async () => {
              try {
                await onSignIn();
                setShowConnect(false);
              } catch {
                /* swallow — modal stays open and shows error via parent */
              }
            }}
          />
        )}
      </>
    );
  }

  return (
    <>
      <button className="wallet-pill" onClick={() => setShowAccount(true)}>
        <Avatar address={auth.address} size={20} />
        <span className="addr">{shortAddr(auth.address)}</span>
        <span className="caret">⌄</span>
      </button>
      {showAccount && (
        <AccountModal
          address={auth.address}
          onClose={() => setShowAccount(false)}
          onDisconnect={() => {
            onSignOut();
            setShowAccount(false);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function ConnectModal({
  onClose,
  onConnect,
}: {
  onClose: () => void;
  onConnect: () => Promise<void>;
}) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle() {
    setConnecting(true);
    setError(null);
    try {
      await onConnect();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setConnecting(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="wallet-modal">
        <div className="modal-head">
          <h3>Connect wallet</h3>
          <button className="modal-close" onClick={onClose} aria-label="close">×</button>
        </div>

        <button
          className="wallet-option primary-option"
          onClick={handle}
          disabled={connecting}
        >
          <span className="opt-name">
            {connecting ? 'Waiting for wallet…' : 'Browser wallet'}
          </span>
          <span className="opt-meta">MetaMask · Coinbase · Rabby · Brave</span>
        </button>

        <p className="modal-hint">
          You'll be asked to sign a message proving you control this address.
          The signature does not authorize any onchain action.
        </p>

        {error && <p className="modal-error">{error}</p>}

        <p className="modal-foot">
          Don't have a wallet?{' '}
          <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">
            Install MetaMask ↗
          </a>
        </p>
      </div>
    </ModalOverlay>
  );
}

function AccountModal({
  address,
  onClose,
  onDisconnect,
}: {
  address: string;
  onClose: () => void;
  onDisconnect: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const expiry = useStoredTokenExpiry();

  function copyAddress() {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="wallet-modal account-modal">
        <div className="modal-head">
          <h3>Connected</h3>
          <button className="modal-close" onClick={onClose} aria-label="close">×</button>
        </div>

        <div className="account-body">
          <Avatar address={address} size={88} />
          <button className="addr-copy" onClick={copyAddress} title="Copy address">
            <span className="addr-text">{midDottedAddr(address)}</span>
            <span className="copy-icon">{copied ? '✓' : '⧉'}</span>
          </button>
          <p className="muted tiny" style={{ margin: '4px 0 0' }}>
            Connected via browser wallet
          </p>
          {expiry && (
            <p
              className={`muted tiny ${expiry.urgent ? 'session-expiry-urgent' : ''}`}
              style={{ margin: '4px 0 0' }}
            >
              Session {expiry.label}
            </p>
          )}
        </div>

        <button className="wallet-option disconnect-option" onClick={onDisconnect}>
          <span className="opt-name">Disconnect</span>
        </button>
      </div>
    </ModalOverlay>
  );
}

// Decode the SIWE JWT's `exp` claim and return a friendly remaining-time
// label. We do NOT verify the signature here — this is purely for display.
// The backend re-validates on every authed request anyway.
function useStoredTokenExpiry(): { label: string; urgent: boolean } | null {
  const [expiry, setExpiry] = useState<{ label: string; urgent: boolean } | null>(null);
  useEffect(() => {
    const token = localStorage.getItem('gov-agent.token');
    if (!token) return;
    const parts = token.split('.');
    if (parts.length !== 3) return;
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (typeof payload.exp !== 'number') return;
      const expMs = payload.exp * 1000;
      const remainingMs = expMs - Date.now();
      if (remainingMs <= 0) {
        setExpiry({ label: 'expired — sign in again', urgent: true });
        return;
      }
      const remainingHours = remainingMs / (1000 * 60 * 60);
      if (remainingHours < 1) {
        setExpiry({
          label: `expires in ${Math.ceil(remainingMs / (1000 * 60))} min`,
          urgent: true,
        });
      } else if (remainingHours < 24) {
        setExpiry({
          label: `expires in ${Math.round(remainingHours)} hr`,
          urgent: remainingHours < 6,
        });
      } else {
        setExpiry({
          label: `expires in ${Math.round(remainingHours / 24)} days`,
          urgent: false,
        });
      }
    } catch {
      // Malformed JWT — surface nothing rather than confuse.
    }
  }, []);
  return expiry;
}

function ModalOverlay({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Render via portal at document.body — the top bar's `backdrop-filter`
  // creates a containing block, so a fixed-positioned overlay rendered as a
  // descendant gets clipped to the top bar's box. Portal escapes that.
  return createPortal(
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Avatar — deterministic gradient blob keyed off the address
// ---------------------------------------------------------------------------

function Avatar({ address, size = 24 }: { address: string; size?: number }) {
  const a = parseInt(address.slice(2, 8), 16);
  const b = parseInt(address.slice(8, 14), 16);
  const h1 = a % 360;
  const h2 = (h1 + 80 + (b % 60)) % 360;
  const bg = `linear-gradient(135deg, hsl(${h1}, 78%, 62%), hsl(${h2}, 78%, 45%))`;
  return (
    <span
      className="wallet-avatar"
      style={{ width: size, height: size, background: bg }}
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function midDottedAddr(addr: string): string {
  return `${addr.slice(0, 6)}••••${addr.slice(-4)}`;
}
