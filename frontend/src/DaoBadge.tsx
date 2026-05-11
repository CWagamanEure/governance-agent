/**
 * Small per-proposal label that identifies which Snapshot space a proposal
 * belongs to. Visual style matches the CAL/REAL badges in the editor diff
 * panel — small mono pill, dark text on a brand-tinted background, with the
 * full space id available as the hover title.
 *
 * Used in Activity, Proposals, AutopilotRunCard plan rows.
 *
 * Adding a new space: drop it in KNOWN_SPACES. Unknown spaces still render
 * with a stable fallback label (first chars of the space id) so the badge
 * never goes blank — but visually they get the neutral gray.
 */

const KNOWN_SPACES: Record<string, { label: string; color: string }> = {
  'arbitrumfoundation.eth': { label: 'ARB', color: '#62b8ff' },
  'gitcoindao.eth': { label: 'GTC', color: '#06d6a0' },
  'gnosis.eth': { label: 'SAFE', color: '#12ff80' },
  'kleros.eth': { label: 'PNK', color: '#9b6dff' },
};

function fallbackLabel(space: string): string {
  const base = space
    .replace(/\.eth$/, '')
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 4)
    .toUpperCase();
  return base || 'DAO';
}

export function DaoBadge({ space, title }: { space: string; title?: string }) {
  const known = KNOWN_SPACES[space];
  const label = known?.label ?? fallbackLabel(space);
  const style = known ? { background: known.color } : undefined;
  return (
    <span className="dao-badge" title={title ?? space} style={style}>
      {label}
    </span>
  );
}
