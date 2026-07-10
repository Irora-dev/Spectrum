import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'

// Prettier dropdowns (owner 18:04): a bigger question face, a ringed chevron
// that lights cyan when open, and a soft open-state tint.
function Q({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group -mx-4 border-b border-white/[0.07] px-4 transition-colors open:bg-white/[0.02] last:border-0 sm:-mx-5 sm:px-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4.5 text-[15px] font-semibold text-ink transition-colors hover:text-cyan [&::-webkit-details-marker]:hidden">
        {q}
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/12 text-ink-faint transition-all duration-200 group-open:rotate-180 group-open:border-cyan/50 group-open:text-cyan">
          <svg
            viewBox="0 0 24 24"
            aria-hidden
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </summary>
      <div className="pb-5 pr-10 text-sm leading-relaxed text-ink-dim [&_a:hover]:underline [&_a]:text-cyan">
        {children}
      </div>
    </details>
  )
}

// The section titles read as real headings now (owner 18:04) with a spectral
// tick beside each.
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="h-5 w-1 rounded-full" style={{ background: 'linear-gradient(180deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }} />
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">{label}</h2>
      </div>
      <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 sm:px-5">{children}</div>
    </section>
  )
}

export function Faq() {
  return (
    <div className="mx-auto max-w-3xl space-y-10 py-6">
      <PageHeader
        eyebrow="FAQ"
        title={<>Questions &amp; answers</>}
        sub={
          <>
            How Spectrum works, in plain terms. For the longer version see{' '}
            <Link to="/learn" className="text-cyan hover:underline">Learn</Link>, and read the{' '}
            <Link to="/risk" className="text-cyan hover:underline">Risk Disclosure</Link> before interacting with
            any onchain asset.
          </>
        }
      />

      <Group label="Basics">
        <Q q="What is Spectrum?">
          <p>
            Software for creating and reading onchain basket tokens, built on Uniswap V4. A basket
            bundles a fixed set of tokens into a single ERC-20 that trades like any token. Each basket
            is its own Uniswap V4 hook and liquidity, so there is no separate vault or wrapper.
          </p>
        </Q>
        <Q q="What is a basket token?">
          <p>
            An ERC-20 (18 decimals) backed by a fixed set of constituent tokens at set weights. Buying
            it mints against the constituents; selling redeems them. Its value tracks the combined
            value of everything inside.
          </p>
        </Q>
        <Q q="Which network does it run on?">
          <p>Base, settled in canonical USDC. Each basket lives on one chain.</p>
        </Q>
        <Q q="How are baskets priced?">
          <p>
            At the live USD value of everything a basket holds, divided by supply. The V2
            contracts expose this as a static, non-reverting on-chain read; this app also
            cross-checks it against public market data. See the{' '}
            <Link to="/docs/valuation">valuation method</Link>.
          </p>
        </Q>
      </Group>

      <Group label="Mechanics &amp; fees">
        <Q q="How do mint and redeem work?">
          <p>
            Minting and redeeming a basket are mechanical, peer-to-contract swaps against its
            constituents at the value of the reserves backing it, settled on-chain through the
            basket&rsquo;s own V4 hook. This app is informational: it does not execute, route, or
            take custody of any transaction. You interact with the onchain contracts directly from
            your own wallet.
          </p>
        </Q>
        <Q q="What are the fees?">
          {/* Fee split is two-part: a fixed protocol burn + a creator-set remainder.
              The rate is per-basket, so never print a universal split. The "pool
              mint/redeem fees" qualifier is load-bearing: the in-kind exit's haircut
              stays with remaining holders, never the burn. */}
          <p>
            The fee rate varies per basket. For every basket the split is mostly fixed by the protocol:
            (a) a fixed 10% of every fee goes to an autonomous PRISM buy-and-burn, and fixed ~5%
            interface and ~5% launcher shares are carved off the rest only when a routing interface or a
            launcher is attached; and (b) of what remains, the creator takes a single share they fix at
            launch (0–30%, removable) and basket holders receive the rest. The creator sets only the fee
            rate and their own share, there is no creator-defined routing table. Every basket&rsquo;s
            page shows its exact fee and split, read live from its contract. Network (gas) costs apply
            separately.
          </p>
        </Q>
        <Q q="Does Spectrum charge a management fee?">
          <p>
            No. There is no management or subscription fee. The only fee is the per-basket
            mint/redeem/swap fee described above, set once by each basket&rsquo;s creator within
            protocol bounds.
          </p>
        </Q>
        <Q q="Can I always exit?">
          <p>
            Every basket has an unconditional in-kind exit: <code className="font-mono text-ink">redeemInKind</code>{' '}
            is a mechanical contract swap that returns the underlying constituents pro-rata, never
            touches any pool, and works even if every pool is dead. A per-leg mask lets you skip a
            frozen constituent explicitly.
          </p>
        </Q>
      </Group>

      <Group label="Launching">
        <Q q="Can anyone launch a basket?">
          <p>
            Yes. Launching is permissionless: pick the assets, weights and fee config, and the basket
            deploys through the factory. The deployer is recorded onchain as the basket&rsquo;s
            creator; the fee rate and creator share they fixed at launch apply forever.{' '}
            <Link to="/launch">Launch a Basket</Link>.
          </p>
        </Q>
        <Q q="What can go in a basket?">
          <p>
            Tokens with sufficient Uniswap liquidity (V4, V3, or V2). The launcher detects the deepest
            pool for each asset automatically. Tokens that only trade on venues without hooks (for
            example Aerodrome) can&rsquo;t be used as constituents.
          </p>
        </Q>
        <Q q="Can a launched basket be changed later?">
          <p>
            No. Baskets are immutable by design, constituents, weights, the fee rate and the creator
            share are fixed at deploy, and a basket has no privileged functions over its live state: not
            even its creator can change any fee parameter afterwards. The system evolves by deploying new
            baskets, not by mutating live ones.
          </p>
        </Q>
      </Group>

      <Group label="Pricing &amp; data">
        <Q q="How is a basket's displayed value calculated?">
          <p>
            Primarily from the basket&rsquo;s own static on-chain views (<code className="font-mono text-ink">exchangeRate()</code>),
            which are non-reverting and report whether every leg was priced. This app also
            reconstructs an aggregate-spot value, the sum of each constituent&rsquo;s held amount
            times its market price, divided by <code className="font-mono text-ink">effectiveSupply</code>,
            as a cross-check, and flags any meaningful divergence. See the{' '}
            <Link to="/docs/valuation">valuation method</Link>.
          </p>
        </Q>
        <Q q="Why isn't the price taken from the basket's own pool?">
          <p>
            A basket&rsquo;s internal V4 self-pool is hook-mediated, so its quoted price is effectively
            static and does not track value. Price comes from the on-chain value views or the
            reconstruction.
          </p>
        </Q>
      </Group>

      <Group label="Custody &amp; risk">
        <Q q="Does Spectrum hold my assets?">
          <p>
            No. Spectrum is non-custodial software. You connect a self-custodial wallet and interact
            directly with the contracts; nothing here holds your assets or transacts on your behalf.
          </p>
        </Q>
        <Q q="Are baskets vetted or endorsed?">
          <p>
            No. Anyone can deploy a basket, including low-quality, illiquid, or misleadingly named
            ones. Listing or display is not an endorsement or a recommendation. Do your own diligence.
          </p>
        </Q>
        <Q q="What are the risks?">
          <p>
            Onchain assets are volatile and you can lose some or all of what you put in. There is
            smart-contract risk, creator / issuer risk, and liquidity risk. Read the full{' '}
            <Link to="/risk">Risk Disclosure</Link> and <Link to="/terms">Terms</Link>.
          </p>
        </Q>
      </Group>
    </div>
  )
}
