/**
 * Snapshot-space submission allowlist.
 *
 * Pulled out of server.ts so cron.ts (and any future submit-bearing
 * module) can import without creating a circular dep with server.ts.
 */

function normalizeSpace(s: string): string {
  return s.trim().toLowerCase();
}

function parseSpaceList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map(normalizeSpace).filter(Boolean);
}

export function getSubmitAllowlist(): string[] {
  // Three sources, all unioned so an operator can extend without overriding:
  //   - SUBMIT_ALLOWLIST: explicit override (comma-separated)
  //   - DAO_SPACE_PUBLIC: the primary DAO the demo is configured against
  //   - SNAPSHOT_FALLBACK_SPACES_PUBLIC: spaces shown in the SignAndVerifyCard
  //     active-proposal picker as fallback targets when the primary has none
  const explicit = parseSpaceList(process.env.SUBMIT_ALLOWLIST);
  const primary = process.env.DAO_SPACE_PUBLIC
    ? [normalizeSpace(process.env.DAO_SPACE_PUBLIC)]
    : [];
  const fallback = parseSpaceList(process.env.SNAPSHOT_FALLBACK_SPACES_PUBLIC);
  // Dedupe preserving primary-first ordering for nicer display.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...primary, ...explicit, ...fallback]) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export function isSpaceAllowedForSubmit(space: string): boolean {
  return getSubmitAllowlist().includes(normalizeSpace(space));
}
