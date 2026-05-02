# Eigen gateway 401 — follow-up message

For sending to your Eigen contact. Drop the original April 27 thread context
in or paste this as a fresh message — your call.

---

**Subject:** Following up on dev gateway RSA verification error — sepolia app `0xA2090...cd9D`

Hi —

Following up on the gateway 401 from April 27. Quick re-statement of the issue
plus an update on what we've built since, so you have full context:

**The issue (unchanged):**
- App: `0xA2090Bc33B35E7b9dD1EEEA86Fc117263Bd1cd9D` (sepolia, verifiable build)
- Dev gateway: `https://ai-gateway-dev.eigencloud.xyz`
- Error: `crypto/rsa: verification error`
- Confirmed JWT is well-formed: `alg: RS256`, `iss: eigenx-kms`, `aud: ["llm-proxy"]`, 4096-bit RSA signature, valid SEV-SNP attestation (hardened, secboot, project `tee-compute-sepolia-prod`).
- Diagnosis from our side: gateway is holding the wrong RSA public key for the `eigenx-kms` issuer on sepolia. Possible causes we considered: key-rotation drift, or gateway is keyed for `ecloud-kms` while sepolia TEE still mints `eigenx-kms` tokens.
- Reproducible end-to-end via `curl http://34.34.16.46:8000/debug/jwt` if you need a sample JWT or `/extract-test` if you want to see the failure live.

**What we've built since (so you can prioritize accordingly):**

The deterministic policy engine, structured policy editor, and signed
decision blob path are all working without the gateway. The demo's centerpiece
is the editor — users see a live diff of what each rule edit does to their
last 27 real proposals — and it doesn't depend on the in-TEE LLM call at all,
since we cached the extractions during a local-dev backfill (gated by
provenance — those extractions are tagged as `anthropic-direct` and not used
to serve real users).

The in-TEE LLM extraction is the remaining piece for the full attested-vote
story. It's needed for **one** demo proposal where we'd want to show the
end-to-end "fresh extraction → signed decision" path running attested. It's
not blocking the demo. Normal urgency.

**What would unblock us:** any of these would let us re-attest the LLM path
in time for the demo (no fixed deadline yet, but mid-late May target):

1. Confirmation that the dev gateway has been re-keyed for `eigenx-kms` (or
   that we should be issuing tokens for `ecloud-kms` instead, in which case
   we need the right `iss` value).
2. A pointer to whether mainnet gateway (`ai-gateway.eigencloud.xyz`) is
   currently working with sepolia-attested JWTs as a workaround.
3. A correct sample JWT format from a working app, so we can diff against
   ours.

Happy to DM a fresh JWT, run any debug calls you suggest, or jump on a 15-min
call. Whatever's lowest friction for you.

Thanks —
Cory
