/**
 * Cross-context clipboard write.
 *
 * navigator.clipboard is undefined on insecure contexts (HTTP without TLS,
 * which is exactly how the EigenCompute TEE is deployed today —
 * http://34.90.5.10:8000). The deprecated document.execCommand('copy') still
 * works there. Without this fallback, the hash-copy chips and the wallet
 * address copy button silently no-op (or throw TypeError) on stage.
 *
 * Returns true on success, false otherwise. Does not throw.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API exists but rejected (document not focused, permission
      // denied, etc.). Fall through to the legacy path.
    }
  }
  return execCommandCopy(text);
}

function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  // Off-screen and unfocusable so the page does not jump.
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.left = '-1000px';
  ta.style.opacity = '0';
  ta.setAttribute('readonly', '');
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
  }
  return ok;
}
