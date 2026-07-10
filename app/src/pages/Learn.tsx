import type { ReactNode } from 'react'
import { PageHeader } from '../components/PageHeader'
import { Link } from 'react-router-dom'

function Section({ label, title, children }: { label: string; title: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-ink-faint">{label}</div>
      <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">{title}</h2>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-ink-dim">{children}</div>
    </section>
  )
}

export function Learn() {
  return (
    <div className="mx-auto max-w-3xl space-y-14 py-6">
      <PageHeader
        eyebrow="How it works"
        title={<>One token.<br /><span className="text-cyan">The whole basket.</span></>}
        sub="Spectrum is software for creating onchain basket tokens, built on Uniswap V4. Anyone can bundle a fixed set of tokens into a single token that trades as easily as any ERC-20."
      />

      <Section label="01 · Basket tokens" title="A whole basket, as one token">
        <p>
          A basket token holds many assets at fixed weights and trades as a single token. Buy one to
          hold the entire basket; sell it in one transaction. No bridging between a dozen positions,
          no rebalancing, the composition is fixed at launch and visible on-chain.
        </p>
      </Section>

      <Section label="02 · The mechanism" title="The token is the pool">
        <p>
          Each basket <em className="not-italic text-ink">is</em> its own Uniswap V4 hook and its own
          liquidity. Buying routes through a custom hook that mints against the underlying assets
          straight into the pool: no vault, no wrapper, no second transaction.
        </p>
        <p>
          Because the token is its own liquidity, the price always reflects the real units backing it:
          there is no separate liquidity provider to drain, and you hold a claim on the assets rather
          than an LP position exposed to impermanent loss.
        </p>
      </Section>

      <Section label="03 · The fee" title="The fee, and where it goes">
        {/* Per-basket rate, fixed protocol slices + a single capped creator
            share; holders get the rest. Never print a universal split for the
            rate. */}
        <p>
          Fees are set per basket, by its creator, at launch, once deployed they cannot be changed.
          The split is mostly fixed by the protocol:
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">Fixed protocol slices</div>
            <p className="mt-2 text-sm leading-relaxed">
              A fixed 10% of every fee goes to an autonomous PRISM buy-and-burn. Fixed ~5% interface
              and ~5% launcher shares are carved off the rest only when a routing interface or a
              launcher is attached, uniform on every basket, set by the protocol, not the creator.
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">Creator share + holders</div>
            <p className="mt-2 text-sm leading-relaxed">
              Of what remains, the creator takes a single share they fix at launch (0–30%, and they can
              take nothing); basket holders automatically receive the rest. Each basket&rsquo;s page
              shows its exact split, read live from chain.
            </p>
          </div>
        </div>
        <p>
          The holders&rsquo; share stays inside the basket and is claimable; it is not extracted by
          anyone, and when no interface or launcher is attached those slices flow to the creator and
          holders too. No one, including the people who wrote this software, can change a deployed
          basket&rsquo;s fee.
        </p>
      </Section>

      <Section label="04 · Why it's different" title="Built without the seam">
        <p>
          Every earlier basket-token design was two things stitched together: a vault that held the
          assets and a separate market that priced them. Every failure traced back to that seam:
          management fees, rented liquidity that walked away, persistent gaps between market price
          and the value of the underlying assets, impermanent loss.
        </p>
        <p>
          Spectrum removes the seam entirely. The token is the liquidity, valuation is unit-based, and
          there is nothing to rent, drift, or bleed.
        </p>
      </Section>

      <Section label="05 · Launch" title="Anyone can launch one">
        <p>
          Win a launch slot in the factory&rsquo;s Dutch auction, choose assets, weights and your fee
          config, and your basket deploys with a hook address mined in your browser. As the deployer
          you are recorded onchain as the basket&rsquo;s creator, and the fee rate and creator share you
          fixed at launch apply for as long as it trades. Pool routing, fees and tick spacing are
          detected automatically; you just pick the assets.
        </p>
        <Link
          to="/launch"
          className="mt-1 inline-block rounded-lg border border-white/20 bg-white/[0.04] px-5 py-2.5 font-mono text-xs uppercase tracking-[0.15em] text-ink press hover:border-cyan hover:text-cyan"
        >
          Launch a Basket →
        </Link>
      </Section>

      <Section label="06 · PRISM" title="The burn mechanism">
        {/* Mechanism-neutral wording — no "owns the machine", no value framing.
            Burn copy uses the routing form, never present-tense "burns"/"buys
            and burns", until one observed end-to-end burn exists ("wired and
            in-flight, not yet realised"). */}
        <p>
          Basket quotes read as plain dollar values, backed unit-for-unit by what each basket holds.
          A fixed share of every basket&rsquo;s pool mint/redeem fees is routed to an autonomous
          PRISM buy-and-burn path that anyone can execute, with no operator, a mechanical property
          of the contracts, stated here as fact, not as a reason to hold anything.
        </p>
      </Section>

      <div className="flex flex-wrap gap-3 border-t border-white/10 pt-8">
        <Link
          to="/"
          className="rounded-lg border border-white/20 bg-white/[0.04] px-5 py-2.5 font-mono text-xs uppercase tracking-[0.15em] text-ink press hover:border-cyan hover:text-cyan"
        >
          Explore baskets
        </Link>
        <Link
          to="/launch"
          className="rounded-lg border border-white/10 px-5 py-2.5 font-mono text-xs uppercase tracking-[0.15em] text-ink-dim press hover:text-ink"
        >
          Launch a Basket
        </Link>
      </div>
    </div>
  )
}
