/**
 * Fetch Snapshot proposals for a space and save as JSON fixtures.
 *
 * Usage:
 *   npm run fetch:proposals
 *   npm run fetch:proposals -- --space arbitrumfoundation.eth --limit 50
 *   npm run fetch:proposals -- --state closed --limit 100
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const SNAPSHOT_HUB = 'https://hub.snapshot.org/graphql';
const BATCH_SIZE = 20;

const QUERY = `
query Proposals($space: String!, $first: Int!, $skip: Int!) {
  proposals(
    first: $first,
    skip: $skip,
    where: { space: $space },
    orderBy: "created",
    orderDirection: desc
  ) {
    id
    title
    body
    choices
    start
    end
    snapshot
    state
    author
    created
    type
    scores
    scores_total
    votes
    quorum
    discussion
    link
    ipfs
    space { id name }
  }
}`;

type Proposal = {
  id: string;
  title?: string;
  body?: string;
  state?: string;
  created?: number;
  end?: number;
  author?: string;
  type?: string;
  votes?: number;
};

async function fetchProposals(space: string, limit: number): Promise<Proposal[]> {
  const results: Proposal[] = [];
  let skip = 0;
  while (results.length < limit) {
    const want = Math.min(BATCH_SIZE, limit - results.length);
    const res = await fetch(SNAPSHOT_HUB, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: QUERY,
        variables: { space, first: want, skip },
      }),
    });
    if (!res.ok) {
      throw new Error(`Snapshot HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { data?: { proposals?: Proposal[] }; errors?: unknown };
    if (body.errors) {
      throw new Error(`Snapshot GraphQL error: ${JSON.stringify(body.errors)}`);
    }
    const batch = body.data?.proposals ?? [];
    if (batch.length === 0) break;
    results.push(...batch);
    skip += batch.length;
    console.error(`  fetched ${results.length}/${limit}...`);
    if (batch.length < want) break;
  }
  return results.slice(0, limit);
}

async function main() {
  const { values } = parseArgs({
    options: {
      space: { type: 'string', default: 'arbitrumfoundation.eth' },
      limit: { type: 'string', default: '30' },
      out: { type: 'string', default: 'data/proposals' },
      state: { type: 'string', default: 'all' },
    },
  });

  const space = values.space!;
  const limit = Number(values.limit);
  const outDir = values.out!;
  const state = values.state!;

  console.error(`Fetching up to ${limit} proposals from ${space}...`);
  let proposals = await fetchProposals(space, limit);

  if (state !== 'all') {
    const before = proposals.length;
    proposals = proposals.filter((p) => p.state === state);
    console.error(`Filtered state=${state}: ${before} -> ${proposals.length}`);
  }

  mkdirSync(outDir, { recursive: true });
  const index = proposals.map((p) => ({
    id: p.id,
    title: p.title,
    state: p.state,
    created: p.created,
    end: p.end,
    votes: p.votes,
    author: p.author,
    type: p.type,
  }));

  for (const p of proposals) {
    writeFileSync(join(outDir, `${p.id}.json`), JSON.stringify(p, null, 2) + '\n');
  }
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.error(`Wrote ${proposals.length} proposals to ${outDir}/`);

  // Summary
  const states: Record<string, number> = {};
  const types: Record<string, number> = {};
  const bodyLens: number[] = [];
  for (const p of proposals) {
    const s = p.state ?? 'unknown';
    const t = p.type ?? 'unknown';
    states[s] = (states[s] ?? 0) + 1;
    types[t] = (types[t] ?? 0) + 1;
    bodyLens.push((p.body ?? '').length);
  }

  console.error('');
  console.error(`Total:     ${proposals.length}`);
  console.error(`By state:  ${JSON.stringify(states)}`);
  console.error(`By type:   ${JSON.stringify(types)}`);
  if (bodyLens.length > 0) {
    const total = bodyLens.reduce((a, b) => a + b, 0);
    const avg = Math.floor(total / bodyLens.length);
    console.error(`Body avg:  ${avg} chars (min ${Math.min(...bodyLens)}, max ${Math.max(...bodyLens)})`);
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
