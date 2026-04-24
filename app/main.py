"""
EigenCompute hello-world for the governance-agent project.

Goal: prove three things on a real EigenCompute deployment before writing any
governance code:
  1. Container builds, deploys, and serves HTTP.
  2. The MNEMONIC env var is injected and we can derive a wallet from it.
  3. The wallet can sign a message and the signature recovers correctly.

Once these endpoints all return sensible values from a deployed instance,
the platform integration risk is resolved. Everything after is application work.
"""

from __future__ import annotations

import os
from functools import lru_cache

from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

Account.enable_unaudited_hdwallet_features()

WALLET_DERIVATION_PATH = "m/44'/60'/0'/0/0"

app = FastAPI(title="governance-agent / hello-world", version="0.1.0")


@lru_cache(maxsize=1)
def _wallet_account():
    mnemonic = os.environ.get("MNEMONIC")
    if not mnemonic:
        raise HTTPException(
            status_code=503,
            detail="MNEMONIC env var not set. On EigenCompute this is auto-injected; locally set one in .env.",
        )
    return Account.from_mnemonic(mnemonic, account_path=WALLET_DERIVATION_PATH)


def _public_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k.endswith("_PUBLIC")}


class HealthResponse(BaseModel):
    ok: bool
    version: str


class WalletResponse(BaseModel):
    address: str
    derivation_path: str


class SignRequest(BaseModel):
    message: str


class SignResponse(BaseModel):
    address: str
    message: str
    signature: str
    recovered_address: str
    matches: bool


class AttestationStub(BaseModel):
    status: str
    note: str
    public_env: dict[str, str]
    wallet_address: str | None


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(ok=True, version=app.version)


@app.get("/env", response_model=dict[str, str])
def env_public() -> dict[str, str]:
    """Return only env vars suffixed _PUBLIC.

    On EigenCompute these are the user-visible part of the deployment's
    configuration surface. If a key isn't here, it was kept private in the TEE.
    """
    return _public_env()


@app.get("/wallet", response_model=WalletResponse)
def wallet_address() -> WalletResponse:
    acct = _wallet_account()
    return WalletResponse(address=acct.address, derivation_path=WALLET_DERIVATION_PATH)


@app.post("/wallet/sign-test", response_model=SignResponse)
def sign_test(req: SignRequest) -> SignResponse:
    """Sign an arbitrary message with the app wallet and verify the signature
    recovers to the same address. Proof-of-life for the signing path. EIP-712
    typed-data signing for Snapshot votes will replace this in V0.2."""
    acct = _wallet_account()
    encoded = encode_defunct(text=req.message)
    signed = acct.sign_message(encoded)
    recovered = Account.recover_message(encoded, signature=signed.signature)
    return SignResponse(
        address=acct.address,
        message=req.message,
        signature=signed.signature.hex(),
        recovered_address=recovered,
        matches=(recovered == acct.address),
    )


@app.get("/attestation", response_model=AttestationStub)
def attestation_stub() -> AttestationStub:
    """STUB. Real implementation needs the EigenCompute TDX quote API, which
    is not yet wired in. Once we know the runtime API (HTTP endpoint, unix
    socket, or Python lib), this returns the actual quote alongside the
    code hash so a third party can verify the running image."""
    try:
        addr: str | None = _wallet_account().address
    except HTTPException:
        addr = None
    return AttestationStub(
        status="stub",
        note="TDX quote retrieval not yet implemented. Pending EigenCompute runtime API confirmation.",
        public_env=_public_env(),
        wallet_address=addr,
    )
