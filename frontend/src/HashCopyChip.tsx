/**
 * Click-to-copy chip for content-addressed hashes (policy hash, blob hashes,
 * etc.). The trust narrative repeatedly anchors on these — make them easy to
 * grab so a reviewer can paste one into Slack post-demo.
 */

import { useState } from 'react';

export function HashCopyChip({
  hash,
  prefixChars = 10,
  label,
}: {
  hash: string;
  prefixChars?: number;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(hash).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      type="button"
      className="hash-copy-chip"
      onClick={handleCopy}
      title={copied ? 'Copied' : `Copy ${label ?? 'hash'}: ${hash}`}
      aria-label={`Copy ${label ?? 'hash'}`}
    >
      <code>{hash.slice(0, prefixChars)}…</code>
      <span className="copy-icon">{copied ? '✓' : '⧉'}</span>
    </button>
  );
}
