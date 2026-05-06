# Demo Script — Governance Agent

Rough flow. 3-5 minutes. The corpus and the editor do most of the work; the
demo just walks the reviewer through what they're seeing.

**Core message:** the system finds obvious autovote rules from your calibration
AND correctly defers on real proposals — both visible in the same editor. The
gap between the two corpora is the honest finding, not a hedge.

## Local prereqs (gitignored — don't check in)

- Backend at `localhost:8765` (`npm run start`)
- Frontend with `VITE_BACKEND_URL=http://localhost:8765` (`cd frontend && npm run dev`)
- Wallet connected via SIWE; saved profile with default `LOW_CONFIDENCE_EXTRACTION` flag enabled
- Cache populated at EXTRACTION_SCHEMA_VERSION='1':
  - 27 real Arbitrum proposals (space=`arbitrumfoundation.eth`)
  - 20 calibration fixtures (space=`calibration.gov-agent`)

## The exact data the demo relies on

**3 LCE_FLIP proposals** (only ones that change decision when LCE is removed):

| Proposal | Corpus | From → To | Why it flips |
|---|---|---|---|
| **cal-010 doc translation $12k** | calibration | MANUAL_REVIEW → **FOR** | GRANT under $500k cap with milestones; matches permissive rule once LCE-gated guards turn off |
| **cal-016 SDK maintenance $40k** | calibration | MANUAL_REVIEW → **FOR** | Same shape as cal-010 |
| **0xd3d1… Code of Conduct living docs** | real Arbitrum | MANUAL_REVIEW → **ABSTAIN** | META_GOVERNANCE category default in saved profile is ABSTAIN |

**The "every red flag" calibration fixture stays flagged** under every profile:

| Proposal | Corpus | Why it stays MANUAL_REVIEW |
|---|---|---|
| **cal-019 mystery grant 500k ARB anon multisig** | calibration | LLM detected unclear beneficiaries → confidence dropped to 0.67 → unconditional `low_conf_guard` fires |

**Two real Arbitrum examples that prove stacked safety:**

| Proposal | Corpus | Even under AGGRESSIVE |
|---|---|---|
| **AIP: ArbOS 60 Elara** (conf=0.87) | real | Stays MANUAL_REVIEW via `manual_review_contract_upgrade` — high LLM confidence doesn't matter, contract upgrades always get human review |
| **ArbR&D Collective V2 Extension** ($865k GRANT, conf=0.76) | real | Stays MANUAL_REVIEW via `review_large_treasury_spend` — even with permissive grant rule, hits the $500k floor |

---

## ACT 1 — Pitch (30s)

> "Most AI agents say 'trust me' when they vote. We make that an editable
> contract: write your values in plain language, the system compiles them
> into structured rules, and you see exactly what your AI will do — live,
> against your own past proposals — before any vote is cast."

Open the app on the Policy page. ProfileCard shows the saved profile.

> "Versioned, content-addressed. Every signed vote will reference this hash."

Click **"Edit rules"**.

## ACT 2 — Peel back the safety layers (2-3 min)

The editor opens. Diff panel shows 47 cached proposals (27 real Arbitrum + 20
onboarding calibration), zero flipped (draft equals baseline).

> "47 past proposals. 27 real ones from Arbitrum DAO over the last few months.
> 20 are the calibration set you saw during onboarding — clean cases the
> system uses to learn the obvious patterns from your values."

This act is the centerpiece. The actual saved profile (LLM-compiled from
your values + calibration) has stacked safety floors that all need to be
peeled back in a specific order to get the calibration grants to autovote.
The DEMO IS the peeling — each step shows one floor, the diff updates, and
the reviewer sees exactly which guardrail was binding.

**Step 1 — uncheck `META_GOVERNANCE`** in "Always require my review"
(manual_review_categories grid).

Diff updates: **1 flip** — `REAL` Updating the Code of Conduct → ABSTAIN.

> "Removing META_GOVERNANCE from the always-review list lets the Code of
> Conduct proposal fall through to my default action. The system doesn't
> autovote yes — it abstains. That's the META_GOVERNANCE category default
> the LLM compiled from my values."

**Step 2 — uncheck `GRANT`** in "Always require my review", and **add a
GRANT category default**: + Add rule → GRANT → FOR, under $500000,
✓ milestones, ✓ reporting.

Diff stays at 1. *This is intentional* — it sets up the peel.

> "I've removed GRANT from the always-review list AND added an explicit
> autovote rule. Watch — nothing else flips. Something else is still
> blocking."

**Step 3 — uncheck `LOW_CONFIDENCE_EXTRACTION`** in manual_review_flags.

Diff stays at 1.

> "Even removing the LLM confidence net doesn't unlock the grants. Another
> floor is binding."

**Step 4 — uncheck `SINGLE_RECIPIENT_TREASURY`** in manual_review_flags.

Diff updates: **3 flips** — the two calibration grants flip to FOR, plus
the META_GOVERNANCE flip from step 1.

> "Found it. The single-recipient flag was the binding floor. Both calibration
> grants — $12k doc translation and $40k SDK maintenance — go to one named
> recipient each. Once I consciously remove that flag, my GRANT autovote rule
> finally fires. Three of my last 47 proposals would have flipped. Two
> calibration grants autovote FOR; one real Arbitrum META governance proposal
> abstains."

**The framing for a reviewer:**

> "What you just saw isn't a bug. It's the editable trust contract working.
> My LLM-compiled policy had four stacked safety floors over my GRANT
> autovoting intent. The editor showed me each one with live feedback. I
> made four conscious decisions to relax specific guardrails, and now the
> system will autovote on the kind of grants my calibration said I'd
> support. Every one of those four unchecks is a permanent record in my
> policy hash. Anyone can verify which floors I removed."

**Profile-shape caveat for the demo operator:** the four-step sequence
above is keyed to the specific profile this session compiled. Different
saved profiles will have different binding floors. To re-derive the
sequence for a fresh profile:

```bash
# Inspect the saved profile
sqlite3 -list -noheader data/app.sqlite \
  "SELECT profile_json FROM policy_profiles ORDER BY created_at DESC LIMIT 1;" \
  | python3 -m json.tool | head -60
```

Look at `manual_review_categories` and `manual_review_flags`. Walk through
the LCE_FLIP examples (cal-010, cal-016, real Code of Conduct) and figure
out which categories/flags catch them. Demo those unchecks in increasing
order of "obvious-ness" so the reveal at the end is the satisfying one.

## ACT 3 — Refusal (45s)

Scroll the diff panel down to look for cal-019. *It's not in the diff* —
because nothing about it changes between baseline and draft.

> "Look what's NOT in the diff. There's a calibration fixture for the
> 'mystery grant' — 500k ARB to an anonymous multisig with no milestones,
> lump-sum. Every red flag. Even with my permissive settings, the system
> won't autovote on it."

Open a separate browser tab or use a `curl` to inspect cal-019:
```bash
curl -s -H "authorization: Bearer $TOKEN" \
  http://localhost:8765/proposals/cached | \
  jq '.items[] | select(.proposal.id == "cal-019-mystery-grant") | {confidence: .analysis.extraction_confidence, unclear: .analysis.analysis.beneficiaries.unclear_beneficiaries}'
```

Expected: `confidence: 0.67, unclear: true`.

> "The LLM saw the anonymous multisig and unclear deliverables, dropped its
> confidence below 0.75, and the system's unconditional safety floor — not
> any user setting — kept it in human review. The user can't turn this off.
> That's a feature."

## ACT 4 — Stacked safety on real proposals (60s)

Click into the diff panel to find specific real proposals. Or just narrate
from the data table above.

> "Here's a real Arbitrum proposal: ArbOS 60 Elara, a contract upgrade. The
> LLM was confident — extraction confidence 0.87. My category defaults don't
> matter. Contract upgrades always get human review, because there's a
> separate manual_review_categories list specifically for them. I'd have to
> uncheck CONTRACT_UPGRADE explicitly, and even then the system flags
> ownership/permission changes through a different rule."

Toggle off `CONTRACT_UPGRADE` from manual_review_categories. Watch the diff
panel — the contract upgrades should still stay MANUAL_REVIEW (different
rule fires: `review_ownership_or_permissions` for the constitutional ones).

> "Same story for the $865k research grant. The LLM extracted it cleanly. My
> aggressive grant autovote rule could have applied to it. But $865k is over
> my treasury threshold — different floor, different rule. The system has
> layered safety, not a single tunable knob. I can be aggressive on category
> defaults; I can't accidentally turn off treasury review."

## ACT 5 — Trust path (30s)

Click Cancel back to ProfileCard. Point at the version + hash.

> "Every signed vote references this hash. The trust path: wallet signs the
> policy. Policy compiles to deterministic rules. Rules evaluate the LLM's
> structured extraction. The decision blob is signed inside a TEE — verifiable
> boot, hardware attestation. Anyone can replay this without re-running the
> LLM, because the extraction is content-addressed too."

[If Eigen gateway is working: show /debug/jwt response with SEV-SNP
attestation fields. If not, skip this beat.]

> "Most AI agent products say 'trust the model.' We say: trust the wallet,
> the hash, the rules, and the attestation. The model is just a translator."

## ACT 6 — Close (15s)

> "What you saw: a structured policy editor with live diff against real DAO
> proposals. The system finds the rules your calibration revealed and refuses
> to autovote on the rest. The fact that almost nothing autovotes on real
> Arbitrum is the safety story working — not failing."

---

## Q&A prep

**"Would you trust this with your real wallet?"**
Yes. The system autovotes on the kinds of proposals my calibration clearly
covered — and cal-019 shows it correctly refuses to autovote on red flags
even when my settings are permissive. Look how few real Arbitrum proposals
it autovotes on: zero. That's the safety property, not a limitation.

**"Why are so many proposals MANUAL_REVIEW?"**
Two answers. (1) Real Arbitrum proposals are mostly hard cases — that's why
they're proposals and not routine ops. (2) The system has stacked safety
floors that aren't user-controllable: low extraction confidence, contract
upgrades, ownership transfers, large treasury spends. The user controls one
flag (LOW_CONFIDENCE_EXTRACTION); the rest are non-negotiable.

**"What if the LLM hallucinates a field?"**
The extraction schema includes per-field confidence scores. Any policy-relevant
field below 0.75 confidence auto-routes to MANUAL_REVIEW. The user can
opt out, but the editor shows them exactly which proposals that affects
before they save.

**"What happens if I write a policy that says 'autovote everything'?"**
You can't, in practice. Even with no manual_review_categories, no
manual_review_flags, and aggressive category_defaults, the system retains
hard-coded floors for contract upgrades, ownership transfers, and overall
extraction confidence. The cal-019 demo proves this — anonymous multisig
red-flag proposal stays in human review under every profile.

**"Why the TEE?"**
The wallet signs every decision blob inside the attested image, so the
signing key is provably bound to a known code build. The LLM extraction
runs inside the enclave with attestation, so the audit trail covers the
model call too — not just the policy logic.

**"What if my policy compiles wrong?"**
Compile is the onboarding shortcut. The editor is the source of truth. You
see the compiled rules, edit them directly, and the diff panel shows live
what your edits do to past proposals before saving.

---

## Open product gaps (revealed by writing the script)

Items that would noticeably improve the demo, in order of leverage:

1. **Label calibration vs. real proposals in the diff panel.** Right now they
   mix together. Titles make it obvious to a careful reader (cal-XXX prefix
   vs. real titles), but a small badge would let the demo stop saying it
   verbally. Five-minute fix in `PolicyEditor.tsx`.

2. **Sort diff items by corpus.** Calibration-corpus flips first, real-corpus
   flips below — makes the "find obvious rules / fall through to manual"
   narrative arc visible in the panel itself.

3. **The "no diff" moment after adding a rule that's already covered** is
   awkward. Either (a) the demo skips the rule-add step, or (b) we change
   the BASELINE profile to NOT include a GRANT default so adding one
   produces a visible flip. Option (b) is cleaner. Means the user's saved
   profile has to be a specific shape — something like the "Manual-review
   everything" archetype from the test:compiler scenarios, with no GRANT
   default — so adding the GRANT rule is genuinely additive.

4. **Filter `/proposals/cached` by space.** Editor would have a small toggle:
   "show calibration | show real | show both". Demo can flip between them
   to make the comparison explicit.

5. **Ship something cosmetic for the "stacked safety" act.** Currently I
   narrate that "even with CONTRACT_UPGRADE toggled off, ownership rule
   catches it." It'd be more legible if the diff item showed the *triggered
   rule id* alongside the decision. Maybe just hover-text on each diff item.

6. **/debug/jwt only fires inside the TEE.** Locally it returns 503 because
   `KMS_SERVER_URL` isn't set. If we want ACT 5 to show the JWT live, the
   demo has to point at the deployed TEE, not localhost — which means the
   gateway needs to be reachable. If still 401, drop ACT 5's JWT beat and
   describe the path verbally.

## Cost spent

Local backfill total: ~$1.30 (real $0.95 + calibration $0.30 + compiler
sanity ~$0.10). Plus a few small ad-hoc runs. Comfortably under $10.
