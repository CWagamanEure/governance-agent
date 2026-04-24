/**
 * Fetch a voter's Snapshot vote history, optionally scoped to a space.
 *
 * Powers the Phase 2 calibration flow — infer starting policy from past votes.
 *
 * Usage:
 *   npm run fetch:votes -- 0xYourAddress
 *   npm run fetch:votes -- 0x... --space arbitrumfoundation.eth --limit 200
 *   npm run fetch:votes -- 0x... --space all
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const SNAPSHOT_HUB = 'https://hub.snapshot.org/graphql';
const BATCH_SIZE = 100;

const QUERY = `
query Votes($voter: String!, $space: String, $first: Int!, $skip: Int!) {
  votes(
    first: $first,
    skip: $skip,
    where: { voter: $voter, space: $space },
    orderBy: "created",
    orderDirection: desc
  ) {
    id
    voter
    created
    choice
    vp
    reason
    proposal {
      id
      title
      choices
      state
      author
      type
      space { id }
    }
  }
}`;

async function fetchVotes(voter: string, space: string | null, limit: number) {
  const results: any[] = [];
  let skip = 0;
  while (results.length < limit) {
    const want = Math.min(BATCH_SIZE, limit - results.length);
    const res = await fetch(SNAPSHOT_HUB, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: QUERY,
        variables: { voter, space, first: want, skip },
      }),
    });
    if (!res.ok) {
      throw new Error(`Snapshot HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { data?: { votes?: any[] }; errors?: unknown };
    if (body.errors) {
      throw new Error(`Snapshot GraphQL error: ${JSON.stringify(body.errors)}`);
    }
    const batch = body.data?.votes ?? [];
    if (batch.length === 0) break;
    results.push(...batch);
    skip += batch.length;
    console.error(`  fetched ${results.length}/${limit}...`);
    if (batch.length < want) break;
  }
  return results.slice(0, limit);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      space: { type: 'string', default: 'arbitrumfoundation.eth' },
      limit: { type: 'string', default: '200' },
      out: { type: 'string', default: 'data/votes' },
    },
    allowPositionals: true,
  });

  const voter = positionals[0];
  if (!voter) {
    console.error('Usage: fetch-votes.ts <voter_address> [--space <space>] [--limit N]');
    process.exit(1);
  }

  const space: string | null = values.space === 'all' ? null : values.space!;
  const limit = Number(values.limit);
  const outDir = values.out!;

  const scope = space ? `in ${space}` : 'across all spaces';
  console.error(`Fetching up to ${limit} votes for ${voter} ${scope}...`);

  const votes = await fetchVotes(voter.toLowerCase(), space, limit);

  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${voter.toLowerCase()}.json`);
  writeFileSync(path, JSON.stringify(votes, null, 2) + '\n');
  console.error(`Wrote ${votes.length} votes to ${path}`);

  if (votes.length === 0) {
    console.error('No votes found.');
    return;
  }

  const spaces: Record<string, number> = {};
  const choices: Record<string, number> = {};
  for (const v of votes) {
    const s = v.proposal?.space?.id ?? 'unknown';
    spaces[s] = (spaces[s] ?? 0) + 1;
    const c = String(v.choice);
    choices[c] = (choices[c] ?? 0) + 1;
  }

  console.error('');
  console.error(`Total votes: ${votes.length}`);
  console.error(`By space:    ${JSON.stringify(spaces)}`);
  console.error(`By choice:   ${JSON.stringify(choices)}`);
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
