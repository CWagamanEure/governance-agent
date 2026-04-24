"""Run structured LLM extraction on saved Snapshot proposals.

This is the prototype for the production pipeline's Call 1 (see PLAN.md §9).
Purpose: force unstructured proposal prose into a typed ProposalAnalysis that
the deterministic policy engine can consume. The LLM is a schema-bound
translator here, not a decision-maker.

Usage:
    # single proposal
    python scripts/extract.py data/proposals/0xabc123.json

    # all fixtures
    python scripts/extract.py

    # limit + skip already-done
    python scripts/extract.py --limit 5 --skip-existing

    # use Opus instead of Sonnet default
    python scripts/extract.py --model claude-opus-4-7 --limit 3
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Literal

import anthropic
from pydantic import BaseModel, Field, ValidationError

# ---------------------------------------------------------------------------
# Schema — this is the contract between the LLM and the policy engine.
# Keep it tight. Every field should be useful to a deterministic rule.
# ---------------------------------------------------------------------------

Category = Literal[
    "TREASURY_SPEND",
    "PARAMETER_CHANGE",
    "CONTRACT_UPGRADE",
    "OWNERSHIP_TRANSFER",
    "GRANT",
    "COUNCIL_APPOINTMENT",
    "PARTNERSHIP",
    "SOCIAL_SIGNAL",
    "PROTOCOL_RISK_CHANGE",
    "TOKENOMICS",
    "META_GOVERNANCE",
    "OTHER",
]


class Tradeoff(BaseModel):
    pro: str = Field(max_length=300)
    con: str = Field(max_length=300)


class Flags(BaseModel):
    treasury_spend_usd: float | None = Field(
        default=None,
        description="USD value being spent from the treasury, if explicitly stated or convertible from stated token amounts+price. Null if unknown. NEVER invent a number.",
    )
    requires_contract_upgrade: bool
    touches_ownership: bool
    has_milestones: bool = Field(description="Are there measurable milestones or KPIs?")
    reversible: bool = Field(description="Can this be reversed by a future proposal without significant cost?")
    time_sensitive: bool


class ValueAlignment(BaseModel):
    """Objective assessment of the proposal's direction on each axis.
    Range: -1 (strongly conflicts with axis) to +1 (strongly aligns)."""

    decentralization: float = Field(ge=-1, le=1, description="Does this increase (+) or decrease (-) decentralization?")
    treasury_conservatism: float = Field(ge=-1, le=1, description="Is this conservative (+) or aggressive (-) with treasury assets?")
    growth_vs_sustainability: float = Field(ge=-1, le=1, description="Does this favor sustainability (+) or growth (-)?")
    protocol_risk: float = Field(ge=-1, le=1, description="Does this decrease (+) or increase (-) protocol risk?")


class Uncertainty(BaseModel):
    requires_human_judgment: bool
    ambiguity_notes: str = Field(default="", max_length=500)


class ProposalAnalysis(BaseModel):
    category: Category
    summary: str = Field(max_length=600, description="One paragraph stating what the proposal does. No opinion.")
    tradeoffs: list[Tradeoff] = Field(max_length=5)
    affected_parties: list[str] = Field(max_length=10)
    flags: Flags
    value_alignment: ValueAlignment
    uncertainty: Uncertainty


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

PROMPT_TEMPLATE = """You are analyzing a DAO governance proposal. Call the `record_analysis` tool with a precise structured analysis.

Hard rules:
- Categorize into exactly one enum value.
- `treasury_spend_usd`: set ONLY if the proposal explicitly states a dollar amount OR a token amount with a price conversion stated in the proposal. If you'd have to guess, leave it null and note it in `uncertainty.ambiguity_notes`. Never invent numbers.
- `value_alignment` axes are OBJECTIVE assessments of the proposal's direction, not personal preference.
- `summary`: state what the proposal does. Do not argue for or against it.
- Never add information not supported by the proposal text.
- If you cannot confidently determine a boolean flag, set `uncertainty.requires_human_judgment=true` and explain in `ambiguity_notes`.

PROPOSAL

Title: {title}
Author: {author}
Type: {type}
Choices: {choices}

Body:
{body}
"""


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-6"
MAX_BODY_CHARS = 25_000


def build_tool_schema() -> dict[str, Any]:
    """Pydantic -> JSON Schema for Anthropic's tools API.

    Anthropic accepts standard JSON Schema including $defs/$ref, so we
    pass Pydantic's output directly.
    """
    return ProposalAnalysis.model_json_schema()


def extract_one(
    proposal: dict[str, Any],
    client: anthropic.Anthropic,
    model: str,
) -> tuple[ProposalAnalysis | None, dict[str, Any]]:
    body = (proposal.get("body") or "")[:MAX_BODY_CHARS]
    prompt = PROMPT_TEMPLATE.format(
        title=proposal.get("title", ""),
        author=proposal.get("author", ""),
        type=proposal.get("type", ""),
        choices=proposal.get("choices", []),
        body=body,
    )

    response = client.messages.create(
        model=model,
        max_tokens=2000,
        temperature=0,
        tools=[
            {
                "name": "record_analysis",
                "description": "Record the structured analysis of the proposal.",
                "input_schema": build_tool_schema(),
            }
        ],
        tool_choice={"type": "tool", "name": "record_analysis"},
        messages=[{"role": "user", "content": prompt}],
    )

    meta: dict[str, Any] = {
        "model": model,
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "stop_reason": response.stop_reason,
        "body_truncated": len(proposal.get("body") or "") > MAX_BODY_CHARS,
    }

    tool_uses = [b for b in response.content if b.type == "tool_use"]
    if not tool_uses:
        meta["error"] = "no_tool_use"
        meta["raw_content"] = [b.model_dump() for b in response.content]
        return None, meta

    raw_args = tool_uses[0].input
    try:
        analysis = ProposalAnalysis.model_validate(raw_args)
    except ValidationError as e:
        meta["error"] = "validation_failed"
        meta["raw_args"] = raw_args
        meta["validation_errors"] = e.errors()
        return None, meta

    return analysis, meta


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else "")
    ap.add_argument("proposals", nargs="*", type=Path, help="Specific proposal JSON files (default: all in --in-dir)")
    ap.add_argument("--in-dir", type=Path, default=Path("data/proposals"))
    ap.add_argument("--out-dir", type=Path, default=Path("data/analyses"))
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--limit", type=int, default=0, help="Max proposals to process (0 = all)")
    ap.add_argument("--skip-existing", action="store_true", help="Skip proposals that already have an analysis file")
    args = ap.parse_args()

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ERROR: ANTHROPIC_API_KEY not set. Add it to .env and re-source.", file=sys.stderr)
        return 1

    # Resolve input paths
    if args.proposals:
        paths = [p for p in args.proposals if p.exists()]
    else:
        paths = sorted(p for p in args.in_dir.glob("*.json") if p.name != "index.json")
    if args.limit:
        paths = paths[: args.limit]
    if not paths:
        print("No proposal files found.", file=sys.stderr)
        return 1

    client = anthropic.Anthropic()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    ok = failed = skipped = 0
    total_in = total_out = 0

    for i, path in enumerate(paths, 1):
        proposal = json.loads(path.read_text())
        pid = proposal["id"]
        out_path = args.out_dir / f"{pid}.json"

        if args.skip_existing and out_path.exists():
            print(f"[{i}/{len(paths)}] SKIP   {pid[:10]}...", file=sys.stderr)
            skipped += 1
            continue

        title = (proposal.get("title") or "").replace("\n", " ")[:60]
        print(f"[{i}/{len(paths)}] ...    {pid[:10]}  '{title}'", file=sys.stderr)

        try:
            analysis, meta = extract_one(proposal, client, args.model)
        except anthropic.APIError as e:
            print(f"    API ERROR: {e}", file=sys.stderr)
            failed += 1
            continue

        total_in += meta.get("input_tokens", 0)
        total_out += meta.get("output_tokens", 0)

        if analysis is None:
            print(f"    FAIL   {meta.get('error')}", file=sys.stderr)
            (args.out_dir / f"{pid}.error.json").write_text(json.dumps(meta, indent=2) + "\n")
            failed += 1
            continue

        record = {
            "proposal_id": pid,
            "proposal_title": proposal.get("title"),
            "analysis": analysis.model_dump(),
            "meta": meta,
        }
        out_path.write_text(json.dumps(record, indent=2) + "\n")

        flags = analysis.flags
        extras = []
        if flags.treasury_spend_usd is not None:
            extras.append(f"${flags.treasury_spend_usd:,.0f}")
        if analysis.uncertainty.requires_human_judgment:
            extras.append("HUMAN_JUDGMENT")
        extra_str = f"  [{' | '.join(extras)}]" if extras else ""
        print(
            f"    OK     category={analysis.category:22} tokens={meta['input_tokens']}/{meta['output_tokens']}{extra_str}",
            file=sys.stderr,
        )
        ok += 1

    print("", file=sys.stderr)
    print(f"Summary: {ok} ok, {failed} failed, {skipped} skipped", file=sys.stderr)
    print(f"Tokens:  {total_in} in, {total_out} out", file=sys.stderr)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
