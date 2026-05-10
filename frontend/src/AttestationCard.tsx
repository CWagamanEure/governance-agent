/**
 * Rich attestation panel for ACT 5 of the demo.
 *
 * Renders the proof axes that the Eigen audience recognizes:
 *   - Hardware: SEV-SNP + secure boot + hardened image
 *   - Code:     pinned git commit, with link to source at that commit
 *   - Image:    GCP-signed container image digest
 *   - Launch:   the SEV-SNP measurement (the hash GCP attests to)
 *   - Evidence: SHA256 of bound TPM evidence (specific to this challenge)
 *   - Identity: app id, agent wallet, GCE project + zone + instance
 *
 * Local dev fallback: shows a single "not running in TEE" line. The card
 * makes no claims it cannot back up.
 */

import type { AttestationStub } from './api';
import { HashCopyChip } from './HashCopyChip';

const GITHUB_REPO_URL = 'https://github.com/CWagamanEure/governance-agent';

export function AttestationCard({
  attestation,
  publicEnv,
  walletAddress,
  verifyUrl,
}: {
  attestation: AttestationStub | null;
  publicEnv: Record<string, string>;
  walletAddress: string | null;
  verifyUrl: string;
}) {
  const machineType = publicEnv.EIGEN_MACHINE_TYPE_PUBLIC;
  const isTee = Boolean(machineType);

  if (!attestation || !isTee) {
    return (
      <section className="card attestation-card attestation-card-local">
        <div className="dft-label">Attestation</div>
        <p className="muted tiny" style={{ marginTop: 6 }}>
          {isTee
            ? 'Attestation report not available yet.'
            : 'Not running in a TEE — local backend. Deploy with ecloud compute app upgrade --verifiable to get the full proof chain.'}
        </p>
      </section>
    );
  }

  const payload = attestation.kms_jwt?.decoded?.payload;
  const sevsnp = payload?.sevsnp;
  const container = payload?.submods?.container;
  const gce = payload?.gce;
  const evidence = attestation.bound_evidence;
  const commit = publicEnv.GIT_COMMIT_PUBLIC;
  const appId = payload?.app_id ?? publicEnv.EIGEN_APP_ID_PUBLIC ?? null;
  const evidenceKb =
    evidence?.evidence_bytes != null
      ? `${(evidence.evidence_bytes / 1024).toFixed(1)} KB`
      : null;

  return (
    <section className="card attestation-card" aria-label="Attestation proof">
      <div className="attestation-head">
        <div>
          <div className="dft-label">Attestation</div>
          <strong>What the TEE proves</strong>
        </div>
        <a href={verifyUrl} target="_blank" rel="noreferrer" className="trust-link">
          Verify on EigenCompute ↗
        </a>
      </div>

      <ProofRow
        label="Hardware"
        body={
          <>
            <span className="att-pill">{payload?.hwmodel ?? 'unknown hwmodel'}</span>
            {payload?.secboot && <span className="att-pill att-pill-on">secure boot</span>}
            {payload?.hardened && <span className="att-pill att-pill-on">hardened image</span>}
            {machineType && <span className="att-pill att-pill-soft">{machineType}</span>}
          </>
        }
      />

      <ProofRow
        label="Code"
        body={
          commit ? (
            <>
              <code className="att-mono">commit {commit.slice(0, 10)}</code>
              <a
                href={`${GITHUB_REPO_URL}/tree/${commit}`}
                target="_blank"
                rel="noreferrer"
                className="trust-link att-inline-link"
              >
                view source ↗
              </a>
            </>
          ) : (
            <span className="muted tiny">no GIT_COMMIT_PUBLIC set</span>
          )
        }
      />

      <ProofRow
        label="Container image"
        body={
          container?.image_digest ? (
            <>
              <HashCopyChip
                hash={container.image_digest}
                prefixChars={20}
                label="image digest"
              />
              {container.image_reference && (
                <span className="muted tiny att-image-ref" title={container.image_reference}>
                  {container.image_reference.split('@')[0]}
                </span>
              )}
            </>
          ) : (
            <span className="muted tiny">image digest not in attestation</span>
          )
        }
      />

      <ProofRow
        label="Launch measurement (SEV-SNP)"
        body={
          sevsnp?.measurement ? (
            <HashCopyChip
              hash={sevsnp.measurement}
              prefixChars={20}
              label="SEV-SNP measurement"
            />
          ) : (
            <span className="muted tiny">no SEV-SNP measurement</span>
          )
        }
      />

      <ProofRow
        label="Bound TPM evidence"
        body={
          evidence?.ok && evidence.evidence_sha256 ? (
            <>
              <HashCopyChip
                hash={evidence.evidence_sha256}
                prefixChars={20}
                label="evidence sha256"
              />
              {evidenceKb && <span className="muted tiny">{evidenceKb}</span>}
            </>
          ) : (
            <span className="muted tiny">
              {evidence?.error ?? 'TEE socket not present'}
            </span>
          )
        }
      />

      <ProofRow
        label="Identity"
        body={
          <div className="att-identity">
            {appId && (
              <span>
                <span className="muted tiny att-tag">app</span>
                <code className="att-mono" title={appId}>
                  {short(appId, 8, 6)}
                </code>
              </span>
            )}
            {walletAddress && (
              <span>
                <span className="muted tiny att-tag">wallet</span>
                <code className="att-mono" title={walletAddress}>
                  {short(walletAddress, 8, 6)}
                </code>
              </span>
            )}
            {gce?.project_id && (
              <span>
                <span className="muted tiny att-tag">gce</span>
                <code className="att-mono">
                  {gce.project_id}
                  {gce.zone ? ` · ${gce.zone}` : ''}
                </code>
              </span>
            )}
          </div>
        }
      />
    </section>
  );
}

function ProofRow({ label, body }: { label: string; body: React.ReactNode }) {
  return (
    <div className="att-row">
      <div className="att-row-label">
        <span className="att-dot" /> {label}
      </div>
      <div className="att-row-body">{body}</div>
    </div>
  );
}

function short(s: string, head: number, tail: number): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}
