"""Fetch Snapshot proposals for a space and save as JSON fixtures.

These fixtures are the ground truth everything downstream uses:
  - LLM extraction prototyping  (scripts/extract.py, later)
  - Policy engine unit tests    (app/policy/tests/)
  - Decision-card calibration   (pre-digested onboarding)
  - Regression harness          (tests/integration/fixtures/proposals/)

Usage:
    python scripts/fetch_proposals.py
    python scripts/fetch_proposals.py --space arbitrumfoundation.eth --limit 50
    python scripts/fetch_proposals.py --state closed --limit 100
    python scripts/fetch_proposals.py --out data/proposals-snap-$(date +%F)
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
BATCH_SIZE = 20
TIMEOUT_S = 30.0

PROPOSALS_QUERY = """
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
}
"""


def fetch_proposals(space: str, limit: int) -> list[dict[str, Any]]:
    """Page through Snapshot's GraphQL API until we have `limit` proposals
    or the space is exhausted. Newest first."""
    results: list[dict[str, Any]] = []
    skip = 0
    with httpx.Client(timeout=TIMEOUT_S, headers={"Content-Type": "application/json"}) as client:
        while len(results) < limit:
            want = min(BATCH_SIZE, limit - len(results))
            payload = {
                "query": PROPOSALS_QUERY,
                "variables": {"space": space, "first": want, "skip": skip},
            }
            resp = client.post(SNAPSHOT_HUB, json=payload)
            resp.raise_for_status()
            body = resp.json()
            if "errors" in body:
                raise RuntimeError(f"Snapshot GraphQL error: {body['errors']}")
            batch = body.get("data", {}).get("proposals") or []
            if not batch:
                break
            results.extend(batch)
            skip += len(batch)
            print(f"  fetched {len(results)}/{limit}...", file=sys.stderr)
            if len(batch) < want:
                break
    return results[:limit]


def save_proposals(proposals: list[dict[str, Any]], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    index: list[dict[str, Any]] = []
    for p in proposals:
        pid = p["id"]
        path = out_dir / f"{pid}.json"
        path.write_text(json.dumps(p, indent=2, sort_keys=True) + "\n")
        index.append(
            {
                "id": pid,
                "title": p.get("title"),
                "state": p.get("state"),
                "created": p.get("created"),
                "end": p.get("end"),
                "votes": p.get("votes"),
                "author": p.get("author"),
                "type": p.get("type"),
            }
        )
    (out_dir / "index.json").write_text(json.dumps(index, indent=2) + "\n")


def summarize(proposals: list[dict[str, Any]]) -> None:
    states = Counter(p.get("state") for p in proposals)
    types = Counter(p.get("type") for p in proposals)
    body_lens = [len(p.get("body") or "") for p in proposals]
    avg_body = sum(body_lens) // max(len(body_lens), 1)
    print("", file=sys.stderr)
    print(f"Total:     {len(proposals)}", file=sys.stderr)
    print(f"By state:  {dict(states)}", file=sys.stderr)
    print(f"By type:   {dict(types)}", file=sys.stderr)
    print(f"Body avg:  {avg_body} chars (min {min(body_lens, default=0)}, max {max(body_lens, default=0)})", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else "")
    ap.add_argument("--space", default="arbitrumfoundation.eth", help="Snapshot space (default: arbitrumfoundation.eth)")
    ap.add_argument("--limit", type=int, default=30, help="Max proposals to fetch (default: 30)")
    ap.add_argument("--out", type=Path, default=Path("data/proposals"), help="Output directory")
    ap.add_argument(
        "--state",
        choices=["active", "closed", "pending", "all"],
        default="all",
        help="Filter by state AFTER fetching (default: all)",
    )
    args = ap.parse_args()

    print(f"Fetching up to {args.limit} proposals from {args.space}...", file=sys.stderr)
    proposals = fetch_proposals(args.space, args.limit)

    if args.state != "all":
        before = len(proposals)
        proposals = [p for p in proposals if p.get("state") == args.state]
        print(f"Filtered state={args.state}: {before} -> {len(proposals)}", file=sys.stderr)

    save_proposals(proposals, args.out)
    print(f"Wrote {len(proposals)} proposals to {args.out}/", file=sys.stderr)
    summarize(proposals)
    return 0


if __name__ == "__main__":
    sys.exit(main())
