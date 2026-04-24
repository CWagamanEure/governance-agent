"""Fetch a voter's Snapshot vote history for a given space.

Powers the Phase 2 calibration flow: "we analyzed your voting pattern, here's
the policy we infer." Run this for your own address first to validate the
query shape, then for test users during onboarding.

Usage:
    python scripts/fetch_votes.py 0xYourAddress
    python scripts/fetch_votes.py 0x... --space arbitrumfoundation.eth --limit 200
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import httpx

SNAPSHOT_HUB = "https://hub.snapshot.org/graphql"
BATCH_SIZE = 100
TIMEOUT_S = 30.0

VOTES_QUERY = """
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
}
"""


def fetch_votes(voter: str, space: str | None, limit: int) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    skip = 0
    with httpx.Client(timeout=TIMEOUT_S, headers={"Content-Type": "application/json"}) as client:
        while len(results) < limit:
            want = min(BATCH_SIZE, limit - len(results))
            variables: dict[str, Any] = {"voter": voter, "first": want, "skip": skip}
            variables["space"] = space  # null ok; Snapshot accepts null
            resp = client.post(
                SNAPSHOT_HUB,
                json={"query": VOTES_QUERY, "variables": variables},
            )
            resp.raise_for_status()
            body = resp.json()
            if "errors" in body:
                raise RuntimeError(f"Snapshot GraphQL error: {body['errors']}")
            batch = body.get("data", {}).get("votes") or []
            if not batch:
                break
            results.extend(batch)
            skip += len(batch)
            print(f"  fetched {len(results)}/{limit}...", file=sys.stderr)
            if len(batch) < want:
                break
    return results[:limit]


def summarize(votes: list[dict[str, Any]]) -> None:
    if not votes:
        print("No votes found.", file=sys.stderr)
        return
    spaces = Counter(v["proposal"]["space"]["id"] for v in votes)
    choices = Counter(str(v.get("choice")) for v in votes)
    print("", file=sys.stderr)
    print(f"Total votes: {len(votes)}", file=sys.stderr)
    print(f"By space:    {dict(spaces.most_common(10))}", file=sys.stderr)
    print(f"By choice:   {dict(choices.most_common(10))}", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else "")
    ap.add_argument("voter", help="Ethereum address of the voter (0x...)")
    ap.add_argument("--space", default="arbitrumfoundation.eth", help="Space to scope to (or 'all' for every space)")
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--out", type=Path, default=Path("data/votes"))
    args = ap.parse_args()

    space_arg: str | None = None if args.space == "all" else args.space
    scope = f"in {args.space}" if space_arg else "across all spaces"
    print(f"Fetching up to {args.limit} votes for {args.voter} {scope}...", file=sys.stderr)

    votes = fetch_votes(args.voter.lower(), space_arg, args.limit)

    args.out.mkdir(parents=True, exist_ok=True)
    path = args.out / f"{args.voter.lower()}.json"
    path.write_text(json.dumps(votes, indent=2, sort_keys=True) + "\n")
    print(f"Wrote {len(votes)} votes to {path}", file=sys.stderr)
    summarize(votes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
