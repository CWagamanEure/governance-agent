# Demo Script — Governance Agent

Rough flow. 5-8 minutes with the autopilot beat and a brief policy-build
opener. The editor and the sign-verify-submit-autopilot chain do most of
the work.

**Core message:** the user's policy is an editable, hashed, attestable
contract. The TEE signs decisions against that contract. The user can
opt into autonomous voting by setting a confidence floor in the same
contract — and watch live what would auto-vote at any threshold. Every
vote is traceable back to a specific saved policy version.

## Local prereqs (gitignored — don't check in)

- Frontend `VITE_BACKEND_URL` points at the deployed TEE on mainnet
  (currently `http://34.90.5.10:8000`). Confirm via the trust ribbon —
  "Attested in EigenCompute TEE" must be visible.
- Wallet connected via SIWE; sign in once before the talk starts so the nonce
  store is warm.
- Cache populated at `EXTRACTION_SCHEMA_VERSION='1'`:
  - 28 real Arbitrum proposals (`space=arbitrumfoundation.eth`)
  - 20 calibration fixtures (`space=calibration.gov-agent`)
- **Before going on stage: click Reset (topbar, authed only).** Reset
  now wipes votes + policy versions and returns you to onboarding — it
  no longer silently seeds a hidden profile. The demo opens by walking
  through the policy build itself using the **Use example values** and
  **Use example calibration** shortcuts, which produce a deterministic
  starter policy that ACT 2's four-step peel runs against.
- Validate the canonical peel against the reference profile any time:
    ```bash
    npm run test:demo-peel
    ```
  Should print four ✓ lines and "Demo peel matches DEMO_SCRIPT.md ACT 2".
  This validates the reference `DEMO_PROFILE` end-to-end; the
  on-stage profile compiled from example values is a close
  approximation but is allowed to drift slightly. If on-stage numbers
  diverge, re-tune the example values rather than re-introducing the
  hidden seed.

### Deploy checklist before the demo

The deployed TEE image must be at the latest commit for ACT 5 to work.
The multi-DAO fan-out, the rewired Reset flow, the cleaned-up dashboard,
the editor diff grouping, the new Followed-DAOs onboarding step, and
the cron poller all live in commits since the last deploy.

**Required `.env.deploy` entries before upgrade:**
```
DAO_SPACE_PUBLIC=arbitrumfoundation.eth
SNAPSHOT_FALLBACK_SPACES_PUBLIC=gitcoindao.eth,gnosis.eth,kleros.eth
GIT_COMMIT_PUBLIC=<git rev-parse HEAD value at deploy time>
OPERATOR_ADDRESS_ALLOWLIST=0xYourWallet,0xTeammateWallet
# AUTOPILOT_POLL_ENABLED=true   # optional; off-by-default keeps unattended runs safe
```

Then upgrade:
```bash
SHA=$(git rev-parse HEAD)
# Pin the commit hash in .env.deploy before running this:
sed -i.bak "s/^GIT_COMMIT_PUBLIC=.*/GIT_COMMIT_PUBLIC=$SHA/" .env.deploy
ecloud compute app upgrade 0xc9645B5C0A942e4dE16525513FE36D48DA7D911d \
  --env-file .env.deploy --log-visibility public --verifiable \
  --repo https://github.com/CWagamanEure/governance-agent --commit "$SHA"
```

**Post-upgrade smoke checks:**
```bash
curl -sS http://34.90.5.10:8000/env | jq
# Expect MODEL_PUBLIC, MODEL_ROUTE_PUBLIC, GIT_COMMIT_PUBLIC matching $SHA,
# and SNAPSHOT_FALLBACK_SPACES_PUBLIC listing the three fallback DAOs.

curl -sS http://34.90.5.10:8000/submit-allowlist
# Expect {"spaces":["arbitrumfoundation.eth","gitcoindao.eth","gnosis.eth","kleros.eth"]}.

# Warm the attestation cache. AttestClient has no client-side timeout;
# a cold /attestation call right at demo time could block. Hitting it
# once after upgrade primes the report so ACT 5d renders cleanly.
curl -sS http://34.90.5.10:8000/attestation | jq '.status'
# Expect "available". If "unavailable", retry every 5s — first call
# after a cold deploy can take 10-30s while KMS warms up.

curl -sS http://34.90.5.10:8000/poller/status | jq '.enabled'
# true if AUTOPILOT_POLL_ENABLED is on, false otherwise.
```

**LLM gateway fallback (operator hot-swap)**

The deployed image uses LLM_PROVIDER=auto, which prefers the Eigen gateway
when KMS env is injected (always true on mainnet TEE). If the gateway
returns 401 or other errors on demo day, hot-swap to direct Anthropic:

```bash
ecloud compute app upgrade 0xc9645B5C0A942e4dE16525513FE36D48DA7D911d \
  --env LLM_PROVIDER=anthropic --env ANTHROPIC_API_KEY=sk-ant-... \
  --commit "$SHA"
```

`test:compile-peel` validates that the heuristic fallback path (used
when both gateway and direct Anthropic are unavailable) also reproduces
the ACT 2 four-step peel — so even total LLM failure does not break the
demo, only the LLM-route narration in the trust ribbon.

### Active-proposal contingency for ACT 5c

ACT 5c (live Snapshot submit) requires (a) an active Snapshot proposal
in one of the configured spaces AND (b) the policy evaluates it as
FOR/AGAINST/ABSTAIN, not MANUAL_REVIEW.

The SignAndVerifyCard on the Trust tab scans the primary DAO + every
fallback space in parallel and surfaces all of them grouped in the
proposal dropdown. So the question is "any active proposal in any of
these four DAOs?" — much more likely to be yes than waiting on a
single DAO.

Check 30 minutes before:

```bash
curl -sS https://hub.snapshot.org/graphql -H 'content-type: application/json' \
  -d '{"query":"{ proposals(first:10,where:{space_in:[\"arbitrumfoundation.eth\",\"gitcoindao.eth\",\"gnosis.eth\",\"kleros.eth\"],state:\"active\"},orderBy:\"end\",orderDirection:asc){id title end space{id} type}}"}' | jq
```

Three branches for ACT 5c:

**(a) Active Arbitrum proposal exists.** Best case. The narrative stays
on Arbitrum — "the same DAO whose past 28 proposals we just walked
through. The TEE wallet just signed a vote on a real, currently-open
Arbitrum proposal."

**(b) No active Arbitrum, but a fallback DAO has one.** Pivot:
> "Arbitrum has nothing on the floor today, but here is an active
> Gitcoin proposal — the system has not seen Gitcoin before, but the
> policy evaluates it the same way and the same TEE wallet signs the
> envelope. The submit endpoint accepts any space the operator
> allowlisted; the deploy env included Gitcoin specifically so this
> demo path works whenever Arbitrum is quiet."

The pre-flight allowlist line in the card surfaces the four spaces so
the reviewer can verify the constraint before you click Submit.

**(c) Nothing active anywhere.** Worst case. The Submit button stays
disabled with a clear reason. Narrate it directly:
> "All four spaces are quiet right now. The submit step is gated; the
> button stays off. Sign and verify still complete end-to-end against
> a closed proposal — the math is the same, only Snapshot's sequencer
> would reject the late timestamp. Most demo days at least one of the
> four DAOs has something open."

Worth having a screen recording of (a) ready in either case.

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

## ACT 1 — Pitch + build the policy (60s)

> "Most AI agents say 'trust me' when they vote. We make that an editable
> contract: write your values in plain language, the system compiles them
> into structured rules, and you see exactly what your AI will do — live,
> against your own past proposals — before any vote is cast. And when it
> does vote, the wallet signs a content-addressed artifact you can replay
> on commodity hardware to confirm the decision."

Open the app on the Policy page. After Reset, the page is in onboarding
mode — a 4-step wizard (Values → Calibration → Follow → Review).

**Step 1 — Values.** A single text area at the top. Click
**"Use example values"**. The text area fills with four representative
stances (public goods funding, recurring program accountability,
irreversibility, parameter changes). Click **Continue to calibration**.

**Step 2 — Calibration.** A vertical stack of real past proposals,
each with FOR / AGAINST / ABSTAIN buttons. Click **"Use example
calibration"** to preselect 8 answers. Click **Continue to followed
DAOs**.

**Step 3 — Follow.** A checklist of every DAO this deploy supports,
all pre-checked. Leave all four ticked for the demo so autopilot has
something to watch. Click **Compile my policy**.

The compile step runs (LLM if available, deterministic fallback
otherwise — both paths are now validated by `npm run test:compile-peel`
to reproduce the ACT 2 four-step peel).

**Step 4 — Review.** Shows the compiled defaults, flags, hard limits,
followed DAOs, and any warnings. Click **Looks right — save policy**.
ProfileCard appears with version 1 and the content hash.

> "Two minutes of inputs, hashed and versioned. Every signed decision
> from now on references this exact hash."

Click **"Edit rules"**.

## ACT 2 — Peel back the safety layers (2-3 min)

The editor opens. Diff panel shows 48 cached proposals (28 real Arbitrum + 20
onboarding calibration), zero flipped (draft equals baseline). The diff list
is grouped into **Calibration set** and **Real proposals** sections so the
two corpora are visually separated; each real-proposal row also carries a
DaoBadge for which DAO it came from.

> "48 past proposals. 28 real ones from Arbitrum DAO over the last few months.
> 20 are the calibration set — clean cases the system uses to learn the
> obvious patterns from your values."

This act is the centerpiece. The compiled profile has stacked safety floors.
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

## ACT 4.5 — Autopilot dial (45s)

Still in the editor. Scroll down to the **Autopilot** section (it has a
distinct accent border to read as a tier of authority, not another tuning
knob).

> "Now the autonomy question. Most AI agent products say 'trust me to
> vote for you.' I want to authorize the system more precisely than that —
> on exactly the policy I just edited, with a confidence floor I pick."

Toggle **Autopilot** on. The summary line lights up:
> Autopilot would currently vote on **0** of 48 cached proposals at this
> configuration

> "Zero, because every cached proposal is MANUAL_REVIEW under my saved
> policy — that's the safety story working. Autopilot never fires on
> MANUAL_REVIEW, regardless of confidence. So my saved policy is its
> own safety floor."

Now jump back to a permissive draft state — uncheck `META_GOVERNANCE`
from manual_review_categories so the META proposal flips to ABSTAIN.
The editor re-runs the diff. The Autopilot summary updates:

> Autopilot would currently vote on **1** of 48 cached proposals

The **AUTO** badge appears next to the Code of Conduct row in the diff
panel.

> "Code of Conduct now evaluates to ABSTAIN with confidence 0.91. That
> clears my 0.85 floor, so autopilot would fire. The badge in the diff
> panel makes it visible per-proposal."

Drag the **Confidence floor** slider up from 0.85 → 0.95. The counter
ticks back to 0 and the AUTO badge disappears.

> "0.91 falls below my new 0.95 floor. The slider IS the trust
> contract — every position binds the wallet to those exact
> authorization conditions on save. Slide back down to 0.85, the badge
> returns."

> "When I save, this slider position hashes into the policy. The audit
> log can prove later: 'this autopilot vote happened because policy
> hash 0x... was active and the proposal scored 0.91 confidence against
> your 0.85 floor.' Two knobs — one master switch, one confidence floor.
> The policy itself decides FOR / AGAINST / ABSTAIN per proposal."

(Optional: Save the policy here so ACT 5 can run live autopilot.
Otherwise leave autopilot off and use ACT 5 only for single-proposal
sign + verify + submit.)

## ACT 5 — Trust path: sign → verify → submit (90s)

Click **Cancel** back to the Policy page. Now switch to the **Trust**
tab in the topbar — this is where the sign / verify / submit loop
lives. Policy stays focused on "what your policy is"; Trust is where
the cryptographic-proof story plays out.

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

### 5c. Submit (when a configured space has an open proposal)

The dropdown is grouped by Snapshot space: **Active on
arbitrumfoundation.eth** first, then **Active on gitcoindao.eth**,
**gnosis.eth**, **kleros.eth** as fallbacks. Whichever is open and
selected, the Submit button enables when (a) the proposal is active,
(b) verify succeeded, (c) the policy produced an autovote envelope.

The allowlist line below the picker shows the four spaces — submission
to anything else is hard-rejected by the backend.

Click **Submit to Snapshot**. A confirm dialog spells out the target
space, proposal, and choice. Confirm.

A green "✓ accepted by Snapshot" stamp appears with a clickable URL
pointing at the public Snapshot record:
`https://snapshot.org/#/<space>/proposal/0x...`

Click the URL. Snapshot's UI shows the vote — cast by the agent wallet,
labeled with the gov-agent app metadata.

> "That is a real Snapshot vote, on a real DAO proposal, signed by a
> wallet that is provably bound to attested code. The vote shows zero
> voting power because this demo wallet has no governance tokens on
> the configured strategy — that is the safety property. The
> signature, the policy hash, the engine version — all public, all
> replayable."

If the active proposal is from a fallback DAO (Gitcoin / Gnosis /
Kleros) instead of Arbitrum, briefly acknowledge:
> "We have not seen this DAO before — no calibration, no cached
> proposals. The policy still evaluates it the same way, the TEE
> wallet still signs the envelope, the allowlist gate still applies.
> The demo only works on the four DAOs the operator pre-allowlisted;
> there is no path for arbitrary write access."

### 5c.bis Autonomy beat (the cron)

There is no separate "Run autopilot batch" button anymore — the
autopilot cron in the deployed TEE does the operational work
automatically. Acknowledge it briefly:

> "The same machinery I just walked you through manually — extract,
> evaluate, eligibility-check, sign, submit — runs unattended every
> 15 minutes inside the TEE for any user with autopilot enabled.
> Each tick writes a hash-chained audit row. Nothing magical happens
> when nobody is at the keyboard; the same content-addressed trail I
> just showed you accumulates."

To prove the cron is real on stage, curl the audit log:
```bash
curl -sS http://34.90.5.10:8000/audit -H "Authorization: Bearer $TOKEN" \
  | jq '.[] | select(.event_type == "autopilot_poll_tick") | {ts, payload}' \
  | head -40
```

Each row shows tick number, user count scanned, items scored, items
submitted. The hash-chained `prev_hash` / `row_hash` columns prove
the chain is intact.

### 5d. Attestation

Switch back to the **Policy** tab. The Attestation card lives below
the policy summary.

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

**"How does the autonomous voting actually work? Is there a cron loop?"**
Yes. The deployed TEE runs a polling cron — every 15 minutes by default
(`AUTOPILOT_POLL_INTERVAL_MS`, set `AUTOPILOT_POLL_ENABLED=true` on the
deploy env to turn it on). Each tick: list every user with
`autopilot.enabled = true` in their saved policy, intersect their
followed_spaces with the deploy allowlist, fetch active proposals in
those spaces, extract (cache-first, live LLM in the TEE on miss),
evaluate the deterministic engine, sign + submit eligible items
through the per-user wallet, and write a hash-chained
`autopilot_poll_tick` audit row. Already-submitted proposals dedupe
against the audit chain so repeated ticks do not re-vote. Persistent
failures (MNEMONIC missing, etc.) trip a per-user
`permanentlySkipped` counter so the audit log does not spam.

**"What stops me from accidentally enabling broad autonomous voting?"**
Three layers, all visible in the editor before save.
(1) Autopilot defaults to `enabled: false` — flipping it on is a
deliberate act, hashed into the policy.
(2) The confidence floor defaults to 0.85 — most cached proposals do
not clear that, so the editor's live counter shows 0 even after
enabling. The slider lets the user dial up tighter.
(3) Autopilot unconditionally skips MANUAL_REVIEW. The user's policy
itself is the per-decision authorization — if a category should never
autovote, the user marks it as MANUAL_REVIEW. There is no parallel
"decisions" filter that could surprise.
On the backend: the SUBMIT_ALLOWLIST gate rejects any vote targeting a
space outside the explicit DAO_SPACE + fallback set. A misconfigured
policy cannot reach a non-allowlisted DAO.

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
- [ ] `npm run test:autopilot` prints "Summary: 10/10 passed".
- [ ] Frontend trust ribbon shows "Attested in EigenCompute TEE".
- [ ] SIWE sign-in completed at least once before the demo.
- [ ] Click **Reset** in the topbar once; confirm the Policy page lands
      on onboarding (no saved profile). Walk through **Use example
      values** → Continue → **Use example calibration** → Save. After
      save, the Policy page shows the ProfileCard with a status pill
      reading `AUTOPILOT disabled · floor 0.85 · 4 DAOs followed`
      and a two-column "How it votes" / "When it stops" body. Stated
      values collapse under a click-to-expand toggle. Autopilot
      "disabled · Confidence floor 0.85".
- [ ] Editor first paint shows "48 past proposals" and zero flipped; the
      diff list is grouped into "Calibration set" / "Real proposals".
- [ ] AttestationCard renders Hardware/Code/Image/Measurement/Evidence rows.
- [ ] Run sign-then-verify on stage hardware; confirm signature recovers
      and verify takes <100 ms.
- [ ] Open the Autopilot section in the editor and verify the slider
      drag updates the "X of N" counter live.
- [ ] curl /audit | jq for autopilot_poll_tick rows to confirm the cron
      is running on the deploy (set AUTOPILOT_POLL_ENABLED=true).
- [ ] Check Snapshot for active proposals across all four allowlisted
      spaces (arbitrumfoundation, gitcoindao, gnosis, kleros) 30 min
      before the demo so you know which branch ACT 5c will take.

## Cost spent

Local backfill total: ~$1.30 (real $0.95 + calibration $0.30 + compiler
sanity ~$0.10). Plus a few small ad-hoc runs. Comfortably under $10.
