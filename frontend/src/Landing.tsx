/**
 * Marketing / explanation page. Default route — describes what the product
 * is, what makes it different, and how it works. The dashboard lives at
 * #/app for users who want to actually use it.
 */

export function Landing() {
  return (
    <div className="landing">
      <Hero />
      <Problem />
      <HowItWorks />
      <WhyDifferent />
      <BuiltOn />
      <Footer />
    </div>
  );
}

function Hero() {
  return (
    <section className="hero">
      <div className="hero-inner">
        <span className="badge">EigenCompute · alpha</span>
        <h1 className="hero-title">Your delegate, verified.</h1>
        <p className="hero-sub">
          A governance delegate that votes by <em>your rules</em> — running inside
          hardware-isolated compute, with every decision audited and every vote
          signed by a key only the attested code can use.
        </p>
        <div className="hero-ctas">
          <a
            className="btn primary"
            href="#/app"
            target="_blank"
            rel="noopener noreferrer"
          >
            Launch app ↗
          </a>
          <a
            className="btn"
            href="https://github.com/CWagamanEure/governance-agent"
            target="_blank"
            rel="noreferrer"
          >
            View source ↗
          </a>
        </div>
        <p className="hero-tag">
          Open source · runs on EigenCompute · attestable on-chain
        </p>
      </div>
    </section>
  );
}

function Problem() {
  return (
    <section className="block">
      <h2 className="block-title">DAO governance is broken in three ways</h2>
      <div className="cols-3">
        <div>
          <div className="num">01</div>
          <h3>Voter apathy</h3>
          <p>
            Most token holders never vote. Reading and analyzing every proposal
            is demanding, and the marginal influence of a single vote is small.
          </p>
        </div>
        <div>
          <div className="num">02</div>
          <h3>Delegation by trust</h3>
          <p>
            The common fix is to hand voting power to a stranger whose values
            you can only infer from social posts. You hope they vote in line
            with your interests. There is no enforcement.
          </p>
        </div>
        <div>
          <div className="num">03</div>
          <h3>Black-box AI delegates</h3>
          <p>
            "Let an AI vote for you" sounds appealing until you ask: which AI?
            Running where? With what prompt? Does it actually obey the limits
            you set?
          </p>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="block alt">
      <h2 className="block-title">How it works</h2>
      <div className="steps">
        <Step
          num="1"
          title="Set your policy"
          body="Answer a few questions — treasury caps, decentralization preference, which categories you always want to review yourself. Your answers compile into a deterministic, versioned rule set that anyone can read in our public source."
        />
        <Step
          num="2"
          title="Delegate voting power"
          body="You delegate your DAO tokens to a wallet whose private key lives only inside an attested EigenCompute TEE. The key is bound to a specific Docker image hash — change the code, lose the key. Nobody (including us) can extract it."
        />
        <Step
          num="3"
          title="Let the delegate work"
          body="When a new proposal appears, the agent extracts the structured facts (category, treasury impact, who's affected). The deterministic rule engine takes those facts plus your policy and produces a decision. You approve, override, or auto-vote on categories you've marked safe."
        />
        <Step
          num="4"
          title="Verify everything"
          body="Every vote cites the exact code commit that produced it. The image hash is on-chain. The audit log is hash-chained — tamper any entry and the chain breaks. Rebuild the image from the public repo and confirm it matches what's running."
        />
      </div>
    </section>
  );
}

function Step({ num, title, body }: { num: string; title: string; body: string }) {
  return (
    <div className="step">
      <div className="step-num">{num}</div>
      <div className="step-body">
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
    </div>
  );
}

function WhyDifferent() {
  return (
    <section className="block">
      <h2 className="block-title">Why this is different</h2>
      <p className="block-sub">
        A normal "AI delegate" is a black box: an LLM decides, a centralized server
        signs, and you trust the operator. We invert each of those.
      </p>
      <div className="diff">
        <Diff
          title="The LLM doesn't decide."
          body="It only extracts structured facts from the proposal text. A typed, deterministic rule engine — visible at line N of policy.ts — produces the actual FOR/AGAINST/ABSTAIN/MANUAL_REVIEW decision. Same inputs always produce the same output."
        />
        <Diff
          title="The signing key lives in hardware no one controls."
          body="It's derived inside an Intel TDX / AMD SEV-SNP TEE from a mnemonic that only the attested image can read. Upgrading the code requires re-attesting; downgrading it changes the derivation."
        />
        <Diff
          title="The audit log is tamper-evident."
          body="Every event — profile saved, proposal analyzed, vote signed — is appended with the SHA-256 of the previous entry. Any modification anywhere in the chain is detectable by anyone who walks it."
        />
        <Diff
          title="Your preferences are explicit and versioned."
          body="Stored as JSON, not learned weights. Every change creates a new version. The agent never silently adapts to your behavior — if it ever votes differently than you expect, the rules that produced that decision are right there."
        />
      </div>
    </section>
  );
}

function Diff({ title, body }: { title: string; body: string }) {
  return (
    <div className="diff-item">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function BuiltOn() {
  return (
    <section className="block alt">
      <h2 className="block-title">Built on EigenCompute</h2>
      <p className="block-sub" style={{ maxWidth: 720 }}>
        EigenCompute is a verifiable cloud from Eigen Labs. It runs Dockerized
        apps inside Intel TDX or AMD SEV-SNP TEEs and binds each app's identity
        to a cryptographically-verifiable build. Our entire trust story rests on
        these primitives — without them this would just be another "AI agent"
        you'd have to trust on faith.
      </p>
      <div className="primitives">
        <div>
          <h4>TEE</h4>
          <p>Memory encrypted at the hardware level. Operator can't read it.</p>
        </div>
        <div>
          <h4>App wallet</h4>
          <p>Per-image signing key, derived inside the enclave, never exported.</p>
        </div>
        <div>
          <h4>Attestation</h4>
          <p>Signed proof of which exact image hash is running, right now.</p>
        </div>
        <div>
          <h4>Verifiable build</h4>
          <p>Image digest is bound to a specific GitHub commit, on-chain.</p>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <section className="footer">
      <div className="footer-inner">
        <div>
          <h2 className="block-title" style={{ marginBottom: 8 }}>Try it</h2>
          <p style={{ marginTop: 0, color: 'var(--fg-dim)' }}>
            Currently configured for Arbitrum DAO. Your existing ARB delegation
            isn't required to browse — you only need it to actually cast a vote.
          </p>
        </div>
        <a
          className="btn primary"
          href="#/app"
          target="_blank"
          rel="noopener noreferrer"
        >
          Launch app ↗
        </a>
      </div>
      <p className="tiny" style={{ marginTop: 32, textAlign: 'center', color: 'var(--fg-soft)' }}>
        Open source · alpha software · not recommended for customer funds
      </p>
    </section>
  );
}
