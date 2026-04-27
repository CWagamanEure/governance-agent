/**
 * DAO selector in the top bar.
 *
 * Currently the agent only ships with Arbitrum support — the other DAOs are
 * shown as "coming soon" so users see the roadmap without us claiming
 * functionality we don't have. When we add multi-DAO support, just flip
 * `available: true` on the relevant rows.
 */

import { useState, useRef, useEffect } from 'react';

type Dao = { id: string; name: string; available: boolean; tag?: string };

const DAOS: Dao[] = [
  { id: 'arbitrumfoundation.eth', name: 'Arbitrum DAO', available: true },
  { id: 'uniswapgovernance.eth', name: 'Uniswap',       available: false, tag: 'soon' },
  { id: 'ens.eth',               name: 'ENS',           available: false, tag: 'soon' },
  { id: 'opcollective.eth',      name: 'Optimism',      available: false, tag: 'soon' },
  { id: 'aave.eth',              name: 'Aave',          available: false, tag: 'soon' },
  { id: 'lido-snapshot.eth',     name: 'Lido',          available: false, tag: 'soon' },
  { id: 'comp-vote.eth',         name: 'Compound',      available: false, tag: 'soon' },
  { id: 'gitcoindao.eth',        name: 'Gitcoin',       available: false, tag: 'soon' },
];

export function DaoPicker({ selected }: { selected: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current =
    DAOS.find((d) => d.id === selected) ??
    ({ id: selected, name: selected, available: true } as Dao);

  return (
    <div className="dao-picker" ref={ref}>
      <button
        className="dao-chip-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>{current.name}</span>
        <span className="dao-caret">⌄</span>
      </button>

      {open && (
        <div className="dao-dropdown" role="listbox">
          <div className="dao-dropdown-head">Select DAO</div>
          {DAOS.map((d) => (
            <button
              key={d.id}
              className={[
                'dao-option',
                d.id === selected ? 'selected' : '',
                !d.available ? 'disabled' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              disabled={!d.available}
              onClick={() => {
                if (d.available) setOpen(false);
              }}
              title={d.available ? d.id : 'Cross-DAO support not yet wired'}
            >
              <span className="dao-name">{d.name}</span>
              <span className="dao-id">{d.id}</span>
              {!d.available && <span className="dao-tag">soon</span>}
              {d.id === selected && d.available && <span className="dao-check">✓</span>}
            </button>
          ))}
          <div className="dao-foot">
            Multi-DAO support is on the roadmap. Subscribe to additional DAOs
            once they're enabled — same trust model, no redeploy.
          </div>
        </div>
      )}
    </div>
  );
}
