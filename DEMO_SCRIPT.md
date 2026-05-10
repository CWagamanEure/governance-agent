# Demo Script — Governance Agent

Rough flow. 4-6 minutes. The corpus, the editor, and the live sign-then-verify
loop do most of the work.

**Core message:** the system finds obvious autovote rules from your calibration
AND correctly defers on real proposals — both visible in the same editor — and
the TEE wallet signs a real, replayable artifact about a real proposal.

## Local prereqs (gitignored — don't check in)

- Frontend `VITE_BACKEND_URL` points at the deployed TEE on mainnet
  (currently `http://34.90.5.10:8000`). Confirm via the trust ribbon —
  "Attested in EigenCompute TEE" must be visible.
- Wallet connected via SIWE; sign in once before the talk starts so the nonce
  store is warm.
- Cache populated at `EXTRACTION_SCHEMA_VERSION='1'`:
  - 28 real Arbitrum proposals (`space=arbitrumfoundation.eth`)
  - 20 calibration fixtures (`space=calibration.gov-agent`)
- **CRITICAL: hit the demo-reset button before going on stage.** This wipes
  the user's prior policy versions and seeds the deterministic
  `DEMO_PROFILE` so ACT 2's four-step peel produces exactly 1 / 1 / 1 / 3
  flips. Verify with:
    ```bash
    npm run test:demo-peel
    ```
  Should print four ✓ lines and "Demo peel matches DEMO_SCRIPT.md ACT 2".

### Deploy checklist before the demo

The deployed TEE image must be at the latest commit for ACT 5 to work.
The seeded profile, `/decision/verify`, `/vote/submit`, AttestationCard,
and the rebuilt SignAndVerifyCard all live in commits since the last
deploy.

```bash
SHA=$(git rev-parse HEAD)
ecloud compute app upgrade 0xc9645B5C0A942e4dE16525513FE36D48DA7D911d \
  --env-file .env.deploy --log-visibility public --verifiable \
  --repo https://github.com/CWagamanEure/governance-agent --commit "$SHA"
```

Then verify the deployed env from a curl:
```bash
curl -sS http://34.90.5.10:8000/env | jq
# Expect MODEL_PUBLIC, MODEL_ROUTE_PUBLIC, GIT_COMMIT_PUBLIC matching $SHA.

curl -sS http://34.90.5.10:8000/submit-allowlist
# Expect {"spaces":["arbitrumfoundation.eth"]}.
```

### Active-proposal contingency for ACT 5c

ACT 5c (live Snapshot submit) only fires if Arbitrum has an active
Snapshot proposal at demo time AND the policy evaluates it as
FOR/AGAINST/ABSTAIN. Check 30 minutes before:

```bash
curl -sS https://hub.snapshot.org/graphql -H 'content-type: application/json' \
  -d '{"query":"{ proposals(first:5,where:{space:\"arbitrumfoundation.eth\",state:\"active\"},orderBy:\"end\",orderDirection:asc){id title end}}"}' | jq
```

If empty, narrate ACT 5c as: "today there are no open Arbitrum proposals
to submit to — the Submit button is disabled with a clear reason. On a
day when there is one, the wallet would post the signed envelope to
Snapshot in a single click and you would see the public URL render right
here." Sign + Verify + the Attestation card still carry the act.

## The exact data the demo relies on

**3 LCE_FLIP proposals** (only ones that change decision through the peel):

| Proposal | Corpus | Final state | Why it flips |
|---|---|---|---|
| **cal-010 doc translation $12k** | calibration | MANUAL_REVIEW → **FOR** (step 4) | GRANT under $500k cap with milestones; matches the GRANT FOR rule once SINGLE_RECIPIENT_TREASURY is removed |
| **cal-016 SDK maintenance $40k** | calibration | MANUAL_REVIEW → **FOR** (step 4) | Same shape as cal-010 |
| **0xd3d164… Code of Conduct** | real Arbitrum | MANUAL_REVIEW → **ABSTAIN** (step 1) | META_GOVERNANCE category default in saved profile is ABSTAIN |

**The cal-019 fixture stays flagged under every profile:**

| Proposal | Corpus | Why it stays MANUAL_REVIEW |
|---|---|---|
| **cal-019 mystery grant 500k ARB anon multisig** | calibration | overall extraction_confidence=0.67 → unconditional `low_conf_guard` (priority 980) fires |

**Three real Arbitrum examples that prove stacked safety:**

| Proposal | What stops autovote |
|---|---|
| **AIP: ArbOS 60 Elara** (CONTRACT_UPGRADE, conf=0.87) | `manual_review_contract_upgrade` — the operator never even removes CONTRACT_UPGRADE from manual_review_categories during the peel |
| **Living Documents Code of Conduct** (0xf78c…, META_GOVERNANCE, changes_permissions=true) | After step 1 unchecks META, this one *still* stays MANUAL_REVIEW via `review_ownership_or_permissions` — the sister Code of Conduct (0xd3d164…) flips to ABSTAIN, but this one doesn't |
| **ArbR&D Collective V2 Extension** ($865k GRANT) | `review_large_treasury_spend` ($500k floor) catches it even after step 4 |

---

## ACT 1 — Pitch (30s)

> "Most AI agents say 'trust me' when they vote. We make that an editable
> contract: write your values in plain language, the system compiles them
> into structured rules, and you see exactly what your AI will do — live,
> against your own past proposals — before any vote is cast. And when it
> does vote, the wallet signs a content-addressed artifact you can replay
> on commodity hardware to confirm the decision."

Open the app on the Policy page. ProfileCard shows the seeded DEMO_PROFILE.

> "Versioned, content-addressed. Every signed decision references this hash."

Click **"Edit rules"**.

## ACT 2 — Peel back the safety layers (2-3 min)

The editor opens. Diff panel shows 48 cached proposals (28 real Arbitrum + 20
onboarding calibration), zero flipped (draft equals baseline).

> "48 past proposals. 28 real ones from Arbitrum DAO over the last few months.
> 20 are the calibration set — clean cases the system uses to learn the
> obvious patterns from your values."

This act is the centerpiece. The seeded profile has stacked safety floors.
Each peel-back step shows one floor; the diff updates and the *binding rule
id* on each diff item is visible inline. Reviewers can read the cause without
hovering.

**Step 1 — uncheck `META_GOVERNANCE`** in "Always require my review"
(manual_review_categories grid).

Diff updates: **1 flip** — `REAL` *Updating the Code of Conduct* → ABSTAIN.
Binding rule: `category_default_meta_governance`.

> "Removing META_GOVERNANCE from the always-review list lets the Code of
> Conduct proposal fall through to my META_GOVERNANCE category default,
> which is ABSTAIN. Watch — the *other* Code of Conduct proposal, the
> Living Documents variant, doesn't flip. Why? Because it modifies
> permissions, and the OWNERSHIP_OR_PERMISSION_CHANGE flag catches it
> automatically. Same category, different rule fires. The system is
> doing the second-line check on its own."

**Step 2 — uncheck `GRANT`** in "Always require my review", and **add a
GRANT category default**: + Add rule → defaults to GRANT FOR under $500,000,
✓ milestones, ✓ reporting (the form pre-fills these so you don't have to type).

Diff stays at 1. *This is intentional* — it sets up the peel.

> "I've removed GRANT from the always-review list AND added an explicit
> autovote rule for grants under $500k with milestones and reporting.
> Watch — nothing else flips. Something else is binding."

**Step 3 — uncheck `NO_MILESTONES`** in manual_review_flags.

Diff stays at 1.

> "Maybe a milestone-related flag is in the way? Nope — and you can see
> in the binding-rule label that the grants are still being held by a
> *different* rule, even after I removed this one. There's another floor
> below."

**Step 4 — uncheck `SINGLE_RECIPIENT_TREASURY`** in manual_review_flags.

Diff updates: **3 flips total** — the two calibration grants flip to FOR
(binding rule: `category_default_grant`), plus the META_GOVERNANCE flip
from step 1.

> "Found it. The single-recipient flag was the binding floor. Both calibration
> grants — $12k doc translation and $40k SDK maintenance — go to one named
> recipient each. Once I consciously remove that flag, my GRANT autovote
> rule finally fires. Three of my last 48 proposals would have flipped.
> Two calibration grants autovote FOR; one real Arbitrum META proposal
> abstains."

**The framing for a reviewer:**

> "What you just saw isn't a bug. It's the editable trust contract working.
> My LLM-compiled policy had four stacked safety floors over my GRANT
> autovoting intent. The editor showed me each one with live feedback —
> the binding rule id is right there on every diff item. I made four
> conscious decisions to relax specific guardrails, and now the system
> will autovote on the kind of grants my calibration said I'd support.
> Every one of those four unchecks is a permanent record in my policy
> hash. Anyone can verify which floors I removed."

## ACT 3 — Refusal (45s)

Scroll the diff panel down to look for cal-019. *It's not in the diff* —
because nothing about it changes between baseline and draft.

> "Look what's NOT in the diff. There's a calibration fixture for the
> 'mystery grant' — 500k ARB to an anonymous multisig with no milestones,
> lump-sum. Every red flag. Even with my permissive settings, the system
> won't autovote on it."

Open a separate browser tab or `curl` to inspect cal-019:

```bash
TOKEN=…  # paste from localStorage 'gov-agent:auth'
curl -s -H "authorization: Bearer $TOKEN" \
  http://34.90.5.10:8000/proposals/cached | \
  jq '.items[] | select(.proposal.id == "cal-019-mystery-grant") | {confidence: .analysis.extraction_confidence, unclear: .analysis.analysis.beneficiaries.unclear_beneficiaries}'
```

Expected: `confidence: 0.67, unclear: true`.

> "The LLM saw the anonymous multisig and unclear deliverables, dropped its
> overall confidence below 0.75, and the system's *unconditional* safety
> floor — `low_conf_guard` at priority 980, not any user setting — kept
> it in human review. The user can't turn this off. That's a feature."

## ACT 4 — Stacked safety on real proposals (60s)

Click into the diff panel; the binding-rule id on each row makes this beat
read straight off the screen. Or narrate from the data table above.

> "Here's a real Arbitrum proposal: ArbOS 60 Elara, a contract upgrade. The
> LLM was confident — extraction_confidence 0.87. My category defaults
> don't matter. Contract upgrades always get human review, because there's
> a separate manual_review_categories list specifically for them, and I
> never removed it during the peel. I'd have to uncheck CONTRACT_UPGRADE
> explicitly, and even then there's a separate ownership/permission rule."

Toggle off `CONTRACT_UPGRADE` from manual_review_categories. The contract
upgrades still stay MANUAL_REVIEW (different rule fires:
`review_ownership_or_permissions` for the constitutional ones).

> "Same story for the $865k research grant. The LLM extracted it cleanly. My
> aggressive grant autovote rule could have applied to it. But $865k is over
> my $500k treasury threshold — different floor, different rule. The system
> has layered safety, not a single tunable knob. I can be aggressive on
> category defaults; I can't accidentally turn off treasury review."

## ACT 5 — Trust path: sign → verify → submit (90s)

Click Cancel back to the Policy page. Two new cards are now visible below
the ProfileCard: **Live sign · verify · submit** and **Attestation**.

### 5a. Sign

> "Every signed decision references the policy hash, the extraction hash,
> and the engine output. Let me show you that loop end to end."

The proposal dropdown is grouped: **Active on arbitrumfoundation.eth**
on top (live-fetched from Snapshot's GraphQL), **Cached (closed)** below.
Pick the highest active proposal. Click **"Sign decision (TEE)"**.

A signed blob appears with:
- the agent wallet's address (per-user wallet derived inside the TEE),
- the EIP-712 signature with a "signature recovered: yes" check,
- a "vote envelope: signed choice 3" line if the policy decided
  ABSTAIN (or FOR/AGAINST), or "not signed (MANUAL_REVIEW)" otherwise,
- four copyable content-addressed hashes.

> "The TEE-bound wallet signed an EIP-712 blob committing to those four
> hashes. The signing key never leaves the enclave. The vote envelope
> for Snapshot is signed in the same call — only when the policy
> produced an autovote-eligible decision."

### 5b. Verify

Click **"Verify (replay)"**.

A green "✓ verified" stamp appears with `replayed ABSTAIN in 4 ms · engine 0.2.2`.
Each individual hash check shows "match".

> "The verifier re-derived the rule set from the policy JSON, re-ran the
> deterministic engine on the cached extraction, and recomputed every
> hash. It matches what the TEE wallet signed. No LLM needed —
> extraction is hashed at source. Anyone with the blob can do this on
> commodity hardware."

### 5c. Submit (only on an open Arbitrum proposal)

If an active Arbitrum proposal exists at demo time AND it evaluated to
FOR/AGAINST/ABSTAIN, the **Submit to Snapshot** button is enabled.
Otherwise it stays disabled with a clear reason ("Policy decided
MANUAL_REVIEW — no autovote envelope to submit" or "This proposal is
closed").

If enabled, click **Submit to Snapshot**. A confirm dialog spells out
the space, proposal, and choice. Confirm.

A green "✓ accepted by Snapshot" stamp appears with a clickable URL
pointing at the public Snapshot record:
`https://snapshot.org/#/arbitrumfoundation.eth/proposal/0x...`

Click the URL. Snapshot's UI shows the vote — cast by the agent wallet,
labeled with the gov-agent app metadata.

> "That's a real Snapshot vote, on a real DAO proposal, signed by a
> wallet that is provably bound to attested code. The vote shows zero
> voting power because this demo wallet has no ARB — that's the safety
> property. The signature, the policy hash, the engine version — all
> public, all replayable."

### 5d. Attestation

Scroll to the **Attestation** card.

> "And here's the chain that makes the wallet itself trustworthy."

Walk down the rows:
- **Hardware**: GCP AMD SEV-SNP · secure boot · hardened image
- **Code**: pinned commit, with a "view source" link at exactly that commit
- **Container image**: GCP-signed digest (copyable)
- **Launch measurement**: SEV-SNP measurement (copyable)
- **Bound TPM evidence**: SHA256 of the request-scoped evidence
- **Identity**: app id, agent wallet, GCE project + zone

Click **"Verify on EigenCompute"** — opens the public verifier with the
deployed app id pre-filled.

> "Most AI agent products say 'trust the model.' We say: trust the
> wallet, the hash, the rules, and the attestation. The model is just a
> translator — and even its output is content-addressed."

## ACT 6 — Close (15s)

> "What you saw: a structured policy editor with live diff against real DAO
> proposals, the binding rule visible on every diff item, and a TEE-signed
> decision artifact you can replay in milliseconds without re-running the
> LLM. The fact that almost nothing autovotes on real Arbitrum is the
> safety story working — not failing."

---

## Q&A prep

**"Would you trust this with your real wallet?"**
Yes. The system autovotes on the kinds of proposals my calibration clearly
covered — and cal-019 shows it correctly refuses to autovote on red flags
even when my settings are permissive. Look how few real Arbitrum proposals
it autovotes on: zero through the four-step peel. That's the safety property,
not a limitation.

**"Why are so many proposals MANUAL_REVIEW?"**
Two answers. (1) Real Arbitrum proposals are mostly hard cases — that's why
they're proposals and not routine ops. (2) The system has stacked safety
floors that aren't user-controllable: low extraction confidence
(`low_conf_guard`), contract upgrades, ownership transfers, large treasury
spends. The user controls one set of flags; the rest are non-negotiable
floors.

**"What if the LLM hallucinates a field?"**
The extraction schema includes per-field confidence scores. Any
*policy-relevant* extracted field below 0.75 confidence auto-routes to
MANUAL_REVIEW (the `low_confidence_policy_inputs` rule, gated on a
user-toggleable flag). The user can opt out, but the editor shows them
exactly which proposals that affects before they save. The unconditional
`low_conf_guard` (priority 980) still catches anything below the
overall-confidence floor — that one isn't user-toggleable.

**"What happens if I write a policy that says 'autovote everything'?"**
You can't, in practice. Even with no manual_review_categories, no
manual_review_flags, and aggressive category_defaults, the system retains
hard-coded floors for contract upgrades, ownership transfers, and overall
extraction confidence. The cal-019 demo proves this — anonymous multisig
red-flag proposal stays in human review under every profile.

**"Why the TEE?"**
The wallet signs every decision blob inside the attested image, so the
signing key is provably bound to a known code build. Combined with the
sign-then-verify loop in ACT 5, you get a content-addressed audit trail:
the TEE attests to the *code*, the wallet signs the *decision*, and the
verifier confirms the *math* — three independent links you can check
without trusting any one of them.

**"What if my policy compiles wrong?"**
Compile is the onboarding shortcut. The editor is the source of truth. You
see the compiled rules, edit them directly, and the diff panel shows live
what your edits do to past proposals before saving — including the binding
rule id on each diff item.

---

## Demo-day checklist

- [ ] **Redeploy** to mainnet at the latest commit (see Deploy checklist
      above). Confirm `GIT_COMMIT_PUBLIC` matches `git rev-parse HEAD`.
- [ ] `npm run test:demo-peel` prints 4 × ✓ and "Demo peel matches".
- [ ] `npm run test:sign-verify` prints 6 × ✓ and "Sign-then-verify loop closed".
- [ ] Frontend trust ribbon shows "Attested in EigenCompute TEE".
- [ ] SIWE sign-in completed at least once before the demo.
- [ ] Hit "Reset demo" once; confirm Policy page shows version 1 of seeded
      DEMO_PROFILE (4 stated values, GRANT in manual_review_categories).
- [ ] Editor first paint shows "48 past proposals" and zero flipped.
- [ ] AttestationCard renders Hardware/Code/Image/Measurement/Evidence rows
      (not the "not running in TEE" fallback).
- [ ] Run sign-then-verify on stage hardware; confirm signature recovers
      and verify takes <100 ms.
- [ ] Check Snapshot for active arbitrumfoundation.eth proposals 30 min
      before the demo so you know whether ACT 5c can fire.

## Cost spent

Local backfill total: ~$1.30 (real $0.95 + calibration $0.30 + compiler
sanity ~$0.10). Plus a few small ad-hoc runs. Comfortably under $10.
