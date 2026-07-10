// Integration page: a BD-shareable pitch up top (the /creators register),
// the routing docs below. One URL for both audiences. Copy stays
// mechanism-factual; every number here is a contract constant or a live read.
// House style: no em dashes anywhere on this page, including code comments.
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Callout, Checklist, CodeBlock, CopyChip, IC, InfoPop, Table } from '../components/DocKit'
import { AddrChips } from '../components/AddrChips'
import { BasketAvatar } from '../components/BasketAvatar'
import { BasketBento } from '../components/BasketBento'
import { CHAINS, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { useAllBaskets } from '../lib/spectrum/hooks'

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

// ── copyable snippets (short on purpose; the copy button carries the rest) ────
const DISCOVER = `// Keyless discovery: the factory is an append-only registry.
factory.allBasketsLength()          // how many baskets exist
factory.allBaskets(i)               // basket address
basket.selfKey()                    // the exact v4 PoolKey to route
// Indexers: use the FULL event signature (a shortened one is a different topic0):
event Launched(address indexed basket, address indexed deployer, string name,
  string symbol, uint160 startSqrtPriceX96, uint256 ethPaid, uint16 basketFeeBps)`

const QUOTE = `// The canonical v4 Quoter works as-is. Empty hookData. Quote == fill.
V4Quoter.quoteExactInputSingle({
  poolKey:     basket.selfKey(),
  zeroForOne:  zeroForOne,        // input currency is what you sell:
                                  //   BUY basket (USDC in):  zeroForOne = (USDC   == currency0)
                                  //   SELL basket (basket in): zeroForOne = (basket == currency0)
  exactAmount: amountIn,
  hookData:    ""
})
// Exact-input only (exact-output reverts). Gas: ~600-900k for 3 legs.`

const FILL = `// Fill through the Universal Router or any unlock executor:
swap(poolKey, { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96 }, "")
// Your settlement check owns slippage, exactly like any pool you route today.
// Buys also get in-protocol per-leg floors (immutable TWAP lens, max 3%).
// One exception: the very FIRST mint of a new basket needs the tagged payload.`

const EARN = `// Tag your fills and the protocol pays you, per contract constant:
hookData = abi.encode(
  uint256   minOut,     // your aggregate minimum (0 = your settlement check)
  uint256[] legMins,    // per-leg floors, one per constituent
  address   frontend    // YOUR address: this is the fee attribution
)
// INTERFACE_SHARE_BPS = 555: about 5% of every basket fee you route,
// claimable permissionlessly from the basket. No agreement, no allowlist.`

const PRICE = `// Price by NAV views, never by the curve (it is bypassed):
basket.exchangeRate()    // (rate1e18, fullyPriced)  USDC per token
basket.totalReserve()    // (usdcValue, fullyPriced) total backing
// Execution = NAV +/- basketFeeBps +/- the constituent legs' own impact.`

// ── small building blocks ─────────────────────────────────────────────────────
// Icon-led benefit card (the /creators treatment): icon, a headline stat, title,
// one line. The stat folds in the old StatTile numbers (owner 2026-07-07 19:15:
// "the 5% / 15 min / 0 should be blended with you-get-paid / value-accretive /
// zero-lift").
function WhyCard({
  icon,
  tint,
  title,
  stat,
  children,
}: {
  icon: ReactNode
  tint: string
  title: string
  stat?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-white/[0.18] bg-white/[0.07] p-6 text-center shadow-[inset_0_1px_0_0_rgba(255,255,255,0.09)] transition-colors hover:border-white/[0.3]">
      <div
        className="mx-auto grid h-12 w-12 place-items-center rounded-xl border border-white/[0.16]"
        style={{ color: tint, background: `color-mix(in srgb, ${tint} 14%, transparent)` }}
      >
        {icon}
      </div>
      {stat != null && <div className="mt-4 font-display text-4xl font-bold leading-none text-ink sm:text-[2.6rem]">{stat}</div>}
      <div className={`font-display font-bold uppercase tracking-tight text-ink ${stat != null ? 'mt-2 text-sm tracking-[0.14em]' : 'mt-3.5 text-xl'}`}>{title}</div>
      <p className="mx-auto mt-2 max-w-[18rem] text-[15px] leading-relaxed text-ink-dim">{children}</p>
    </div>
  )
}

// Compact "what a basket token is" showcase: the /creators AGENTS bento,
// smaller. Illustrative composition only; weights are the example card's.
const SHOWCASE = {
  symbol: 'AGENTS',
  name: 'AI Agents',
  address: '0xA6E4750000000000000000000000000000000000',
  chainId: 8453,
  items: [
    { symbol: 'VIRTUAL', address: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', weightPct: 20 },
    { symbol: 'VVV', address: '0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf', weightPct: 15 },
    { symbol: 'AEON', address: '0xbf8e8f0e8866a7052f948c16508644347c57aba3', weightPct: 18 },
    { symbol: 'REI', address: '0x6b2504a03ca4d43d0d73776f6ad46dab2f2a4cfd', weightPct: 17 },
    { symbol: 'BNKR', address: '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', weightPct: 16 },
    { symbol: 'POD', address: '0xed664536023d8e4b1640c394777d34abaff1df8f', weightPct: 14 },
  ],
}

function BentoShowcase() {
  const items = SHOWCASE.items.map((i) => ({ ...i, chainId: SHOWCASE.chainId }))
  return (
    <div className="relative w-full">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-6 -top-6 bottom-0 opacity-20 blur-3xl"
        style={{ background: 'radial-gradient(55% 60% at 50% 0%, var(--color-violet-bright), transparent 72%)' }}
      />
      <div className="relative overflow-hidden rounded-2xl border border-white/[0.18] bg-white/[0.06] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] backdrop-blur-md">
        <div aria-hidden className="h-1 w-full" style={{ background: GRADIENT }} />
        <div className="flex items-center justify-between gap-3 px-6 pt-5">
          <div className="flex items-center gap-3">
            <BasketAvatar address={SHOWCASE.address} symbol={SHOWCASE.symbol} size={44} />
            <div className="text-left">
              <div className="font-display text-2xl font-bold leading-none text-ink">${SHOWCASE.symbol}</div>
              <div className="mt-1 text-[13px] text-ink-dim">{SHOWCASE.name}</div>
            </div>
          </div>
          <span className="rounded-full border border-white/[0.16] bg-white/[0.06] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-dim">
            6 assets · 1 token
          </span>
        </div>
        <div className="p-5">
          <BasketBento items={items} aspect={2.6} className="w-full" />
        </div>
      </div>
      <p className="mt-3 text-center text-[13px] text-ink-faint">
        This is a basket token: one ERC-20 that holds, mints and redeems everything inside it.
      </p>
    </div>
  )
}


function StepHeading({ n, title }: { n: string; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-8 w-8 place-items-center rounded-lg font-display text-base font-bold text-void" style={{ background: GRADIENT }}>
        {n}
      </span>
      <h3 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">{title}</h3>
    </div>
  )
}

export function Integrate() {
  const { data: allBaskets } = useAllBaskets()
  const example = useMemo(() => (allBaskets && allBaskets.length > 0 ? allBaskets[0] : null), [allBaskets])
  const chains = SUPPORTED_CHAIN_IDS.map((id) => CHAINS[id]).filter(Boolean)

  return (
    <div className="pb-10">
      {/* ── HERO: the BD half ── */}
      <section className="relative pt-10 text-center sm:pt-16">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-80 max-w-3xl opacity-30 blur-3xl"
          style={{ background: 'radial-gradient(50% 60% at 50% 30%, var(--color-violet-bright), transparent 70%)' }}
        />
        <div className="relative">
          <div className="font-mono text-sm font-semibold uppercase tracking-[0.25em] text-ink-dim sm:text-base">
            For aggregators, solvers, wallets and bots
          </div>
          <h1 className="mt-6 font-display text-6xl font-bold uppercase leading-[0.92] tracking-tight text-ink sm:text-7xl md:text-8xl">
            Introducing
            <br />
            <span className="spectral-text">basket tokens</span>
          </h1>
          <p className="mx-auto mt-6 max-w-4xl text-balance text-lg leading-snug text-ink-dim sm:text-xl">
            A new way to trade many assets through one token, built as a new onchain primitive on
            Uniswap v4 hooks. Your router already speaks the language.
          </p>
        </div>

        {/* the 5% / <15 min / 0 stats used to sit here as their own tiles; blended
            into the WHY trio below (owner 19:15). */}
        <div className="mx-auto mt-10 flex max-w-md items-center justify-center gap-3">
          <a
            href="#steps"
            className="press rounded-full px-5 py-2.5 font-display text-sm font-bold uppercase tracking-[0.14em] text-void transition-opacity hover:opacity-90"
            style={{ background: GRADIENT }}
          >
            Integrate in 3 steps ↓
          </a>
          <Link
            to="/docs/valuation"
            className="press rounded-full border border-white/20 bg-white/[0.05] px-5 py-2.5 font-display text-sm font-bold uppercase tracking-[0.14em] text-ink hover:bg-white/[0.09]"
          >
            Full docs
          </Link>
        </div>
      </section>

      {/* ── WHY ── */}
      <section className="mx-auto mt-16 max-w-5xl">
        <div className="grid gap-4 md:grid-cols-3">
          <WhyCard
            tint="var(--color-cyan)"
            title="You get paid"
            stat={<span className="spectral-text">≈5%</span>}
            icon={
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 6.5v11M15.2 9c-.6-1-1.8-1.5-3.2-1.5-1.7 0-3 .9-3 2.1 0 2.9 6.3 1.5 6.3 4.3 0 1.2-1.4 2.1-3.3 2.1-1.5 0-2.8-.6-3.3-1.6" />
              </svg>
            }
          >
            of every basket fee you route, paid to your address onchain.
          </WhyCard>
          <WhyCard
            tint="var(--color-violet-bright)"
            title="Value accretive"
            stat="At NAV"
            icon={
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 17l6-6 4 4 8-9" />
                <path d="M15 6h6v6" />
              </svg>
            }
          >
            Fills settle at fair value; fees flow to creators, holders and a burn.
          </WhyCard>
          <WhyCard
            tint="var(--color-magenta)"
            title="Zero lift"
            stat="<15 min"
            icon={
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />
              </svg>
            }
          >
            Canonical v4 quoter and router, empty hookData. No custom adapters.
          </WhyCard>
        </div>
      </section>

      {/* ── WHAT A BASKET IS (visual, width matches the trio above) ── */}
      <section className="mx-auto mt-12 max-w-5xl">
        <BentoShowcase />
      </section>

      {/* ── 3 STEPS: the technical half ── */}
      <section id="steps" className="mx-auto mt-20 max-w-4xl scroll-mt-24 space-y-10">
        <h2 className="text-center font-display text-4xl font-bold uppercase tracking-tight text-ink sm:text-5xl">
          Integrate in <span className="spectral-text">three steps</span>
        </h2>

        <div className="space-y-3">
          <StepHeading n="1" title="Discover" />
          <AddrChips label="Factory" get={(c) => c.factory} />
          <CodeBlock code={DISCOVER} title="factory enumeration" tone="bright" />
          {example && (
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-dim">
              Live example on this deployment:
              <IC>{example.symbol}</IC>
              <CopyChip text={example.address} label={example.address} />
              <span className="text-ink-faint">chain {example.chainId}</span>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <StepHeading n="2" title="Quote" />
          <AddrChips label="V4 Quoter" get={(c) => c.v4Quoter} />
          <CodeBlock code={QUOTE} title="canonical V4Quoter" tone="bright" />
        </div>

        <div className="space-y-3">
          <StepHeading n="3" title="Fill" />
          <AddrChips label="Universal Router" get={(c) => c.universalRouter} />
          <AddrChips label="PoolManager" get={(c) => c.poolManager} />
          <CodeBlock code={FILL} title="bare fill" tone="bright" />
        </div>

        {/* The one integrators get wrong: big type on purpose (owner 13:32). */}
        <div className="rounded-2xl border border-violet-bright/45 bg-violet-bright/[0.09] p-6 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] sm:p-7">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-3xl">
              Read this before you ship
            </h3>
            <InfoPop>
              <b className="text-ink">Why liquidity reads zero.</b> A basket's reserves live inside
              the basket contract, not in the pool. On a swap, the hook mints or redeems against
              those reserves via <IC>beforeSwapReturnDelta</IC>, so the pool's curve and its
              in-range liquidity are never used. That is also why the pool cannot be drained or
              price-manipulated along a curve, and why depth scales with the constituents' own
              markets: a buy acquires the underlying legs on their pools, a sell unwinds them.
            </InfoPop>
          </div>
          <p className="mt-3 max-w-3xl text-[16px] leading-relaxed text-ink-dim">
            The self-pool reports <b className="text-ink">zero in-range liquidity, permanently, by design</b>:
            the hook fills swaps from basket reserves. Do not filter these pools on
            liquidity == 0, and do not price off the curve. Depth comes from the constituents'
            own markets.
          </p>
          <div className="mt-4">
            <CodeBlock code={PRICE} title="pricing views" tone="bright" />
          </div>
        </div>
      </section>

      {/* ── EARN ── */}
      <section className="mx-auto mt-20 max-w-4xl space-y-4">
        <h2 className="text-center font-display text-4xl font-bold uppercase tracking-tight text-ink sm:text-5xl">
          Get paid for <span className="spectral-text">your flow</span>
        </h2>
        <p className="mx-auto max-w-2xl text-center text-[15px] leading-relaxed text-ink-dim">
          Bare fills work with no setup. Tag fills with your address and the protocol pays you
          about 5% of every basket fee you route, with the total fee of 1-3% set by the creator
          at launch.
        </p>
        <CodeBlock code={EARN} title="tagged fill: fee attribution" />
      </section>

      {/* ── PER PLATFORM ── */}
      <section className="mx-auto mt-20 max-w-5xl space-y-4">
        <h2 className="text-center font-display text-4xl font-bold uppercase tracking-tight text-ink sm:text-5xl">
          Per-platform <span className="spectral-text">notes</span>
        </h2>
        <Table
          head={['Platform', 'What it takes', 'Where to start']}
          rows={[
            [<b key="0x">0x / Matcha</b>, 'Onboard the hook family once: one factory, identical hook bytecode per basket.', 'Steps 1-3 plus the safety list below.'],
            [<b key="1i">1inch</b>, 'AMM graph: add the pools. Fusion resolvers can fill today, permissionlessly.', 'Steps 2-3; tag fills to earn.'],
            [<b key="cow">CoW solvers</b>, 'No approval needed. Baskets are a surplus source competitors do not price yet.', 'Add the self-pool as a route candidate.'],
            [<b key="ux">UniswapX fillers</b>, 'Same as solvers: fill permissionlessly through the canonical stack.', 'Steps 2-3.'],
            [<b key="bots">Bots / custom routers</b>, 'Anything that can target an explicit v4 PoolKey works now.', 'Step 1 for the key, step 3 for the call.'],
            [<b key="scr">Screeners</b>, 'Pairs surface from swap events; liquidity fields read 0 by design.', 'Show totalReserve() as depth instead.'],
          ]}
        />
      </section>

      {/* ── SAFETY ── */}
      <section className="mx-auto mt-20 max-w-4xl space-y-4">
        <h2 className="text-center font-display text-4xl font-bold uppercase tracking-tight text-ink sm:text-5xl">
          For your <span className="spectral-text">risk team</span>
        </h2>
        <Checklist
          items={[
            <>Hook permissions: <IC>beforeSwap</IC> + <IC>beforeSwapReturnDelta</IC> only.</>,
            <>Immutable everything: no owner, no upgrade, no pause, no fee ratchet.</>,
            <><IC>nonReentrant</IC>, foreign pools rejected, exact-input only.</>,
            <>Anti-sandwich floors on bare buys come from an immutable TWAP lens, not an oracle key.</>,
            <>Holders always have a pool-independent exit (<IC>redeemInKind</IC>).</>,
            <>Source is verified on the explorers: start at the factory below.</>,
          ]}
        />
      </section>

      {/* ── ADDRESSES ── */}
      <section className="mx-auto mt-20 max-w-4xl space-y-4">
        <h2 className="text-center font-display text-4xl font-bold uppercase tracking-tight text-ink sm:text-5xl">
          Live <span className="spectral-text">addresses</span>
        </h2>
        {chains.some((c) => c.factory) ? (
          <Table
            head={['Chain', 'Factory', 'v4 PoolManager', 'v4 Quoter', 'Universal Router']}
            rows={chains
              .filter((c) => c.factory)
              .map((c) => [
                c.name,
                <CopyChip key={`f${c.chainId}`} text={c.factory!} label={`${c.factory!.slice(0, 8)}…${c.factory!.slice(-6)}`} />,
                c.poolManager ? <CopyChip key={`pm${c.chainId}`} text={c.poolManager} label={`${c.poolManager.slice(0, 8)}…${c.poolManager.slice(-6)}`} /> : 'n/a',
                c.v4Quoter ? <CopyChip key={`q${c.chainId}`} text={c.v4Quoter} label={`${c.v4Quoter.slice(0, 8)}…${c.v4Quoter.slice(-6)}`} /> : 'n/a',
                c.universalRouter ? <CopyChip key={`ur${c.chainId}`} text={c.universalRouter} label={`${c.universalRouter.slice(0, 8)}…${c.universalRouter.slice(-6)}`} /> : 'n/a',
              ])}
          />
        ) : (
          <Callout variant="note" title="No deployment configured">
            <p>This build ships without chain addresses; the operator's deployment fills this table.</p>
          </Callout>
        )}
        <Callout variant="warn" title="Verify, then trust">
          <p>
            Re-verify every address onchain, including the canonical v4 periphery from Uniswap's
            published deployments. A token the factory does not know (<IC>tokens(basket) == 0</IC>)
            is not a Spectrum basket.
          </p>
        </Callout>
      </section>

      <div className="mt-16 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-ink-faint">
        Deep mechanics: <Link className="text-cyan press" to="/docs/valuation">the basket docs</Link>
      </div>
    </div>
  )
}
