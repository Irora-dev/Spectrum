import { useEffect, useState } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { Link, Navigate, useSearchParams } from 'react-router'
import { SWAP_ENABLED } from '../lib/config/features'
import { setActiveChainId, useActiveChain } from '../lib/chain/active-chain'
import { CHAINS, SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { useAllBaskets, useCreatorMeta } from '../lib/spectrum/hooks'
import { formatNav, formatUsdCompact } from '../lib/spectrum/format'
import { DexSwapCard } from '../components/DexSwapCard'
import { PageHeader } from '../components/PageHeader'
import { BasketAvatar } from '../components/BasketAvatar'
import { BasketBento } from '../components/BasketBento'
import { PoweredByPrism } from '../components/PoweredByPrism'
import { TradePrism } from '../components/TradePrism'
import { BasketSpark } from '../components/BasketSpark'
import { BasketWash } from '../components/BasketWash'

// ─────────────────────────────────────────────────────────────────────────────
// /swap — the DEX-style console over the whole basket directory. The console
// itself is DexSwapCard (shared with the Token page's fixed-basket variant);
// this page is the roomy standalone frame: ambient aurora, header, the
// ?basket=&chain= deep link, and — from lg up — the IDENTITY PANEL beside the
// console (owner 2026-07-07 15:4x UX pass: you're buying a whole thesis, the
// page should show it: wash, constituents, NAV/TVL, the creator's tagline).
// It is also the one host that opts the console into `payFromHoldings` (owner QOL
// round 2026-08-05: the swap console should know what you hold) — see below.
// ─────────────────────────────────────────────────────────────────────────────

export function Swap() {
  if (!SWAP_ENABLED) return <Navigate to="/" replace />
  return <SwapPage />
}

function SwapPage() {
  const [params] = useSearchParams()
  const { chainId } = useActiveChain()
  const [selected, setSelected] = useState<string | null>(null)

  const paramBasket = params.get('basket')
  // quick-buy deep link: /swap?basket=…&chain=…&amt=100
  const paramAmount = params.get('amt')
  const paramChain = Number(params.get('chain'))
  useEffect(() => {
    if (paramChain && paramChain !== chainId) setActiveChainId(paramChain)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="relative">
      {/* ambient aurora */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-visible">
        <div className="absolute left-1/2 top-8 h-[420px] w-[420px] -translate-x-1/2 rounded-full bg-violet/12 blur-[130px]" />
        <div className="absolute left-[12%] top-40 h-64 w-64 rounded-full bg-cyan/10 blur-[110px]" />
        <div className="absolute right-[10%] top-64 h-64 w-64 rounded-full bg-magenta/10 blur-[120px]" />
      </div>

      <div className="mx-auto w-full max-w-5xl pt-4">
        {/* header (owner 13:46): "Trade" eyebrow gone, title at the Launch
            page's size, the sub is one plain line, and the chain chip grew
            into a real Ethereum ⇄ Base toggle.

            PHONE MASTHEAD (owner 2026-08-06 23:13, device-wall walk): the sub
            "needs to be centered" and "needs to be across two lines" — it was
            auto-wrapping after "WETH" and orphaning "or USDC." on its own line.
            So below sm the whole masthead centers (the TITLE goes with it: a
            centered paragraph under a left-aligned 5xl SWAP reads as a bug, not
            a composition) and the sub breaks at its own comma — the promise on
            line 1, the means on line 2. The break is an explicit `<br>`, so no
            `max-w-[NNch]` cap may ever be added here: a cap narrower than a
            hand-broken line re-wraps every one of them. `[text-wrap:balance]`
            is wrong for the same reason — the line COUNT is the spec here, not
            something to be chosen for us.
            `[&>div]:w-full` is load-bearing: PageHeader's text column is a
            flex item sized to its content, and hand-breaking the sub SHRINKS
            that content to the longest line — the "centered" block would then
            centre inside a 271px column sitting at the left edge, ~32px off the
            page's true centre. sm: reverts all of it; desktop is untouched. */}
        <PageHeader
          className="mb-6 px-1 max-sm:text-center max-sm:[&>div]:w-full"
          size="lg"
          title="Swap"
          sub={
            <>
              Any basket,{' '}
              <br className="sm:hidden" />
              straight from ETH, WETH or USDC.
            </>
          }
          actions={
            /* justify-center below sm: PageHeader gives this row the full phone
               width, so its three chips used to cluster at the left edge of a
               full-width pill — fine under a left-aligned masthead, visibly
               half-done under the centered one above (owner 2026-08-06 23:13). */
            <div className="flex items-center justify-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1 sm:justify-start">
              {[...SUPPORTED_CHAIN_IDS].reverse().map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveChainId(id)}
                  aria-pressed={chainId === id}
                  className={`press rounded-full px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
                    chainId === id ? 'bg-white/10 text-ink' : 'text-ink-faint hover:text-ink-dim'
                  }`}
                >
                  {CHAINS[id].name}
                </button>
              ))}
            </div>
          }
        />

        {/* console LEFT · what-you're-buying RIGHT (stacks on mobile, panel
            below the console so the money controls stay first) */}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)] lg:gap-8">
          <div className="min-w-0 space-y-6">
            {/* payFromHoldings — the console opens on what this wallet actually
                holds on this network, largest priced holding first, instead of a
                static ETH (owner QOL round 2026-08-05, his own idea that the swap
                page should know what you have). Opted in HERE only: it costs a
                wallet-wide holdings read, and this is the roomy standalone page
                where the pay side is the first decision. A suggestion, never a
                hijack — DexSwapCard yields to a pick, a remembered pick, a
                quick-buy link's amount and anything typed. */}
            <DexSwapCard
              chainId={chainId}
              initialBasket={paramBasket}
              initialAmount={paramAmount}
              large
              payFromHoldings
              onBasketChange={setSelected}
            />
            {/* Buy PRISM itself, right under the console (owner 2026-07-30) */}
            <TradePrism buyOnly />
          </div>
          <BasketContextPanel address={selected} chainId={chainId} />
        </div>

        {/* ecosystem credit — links out to PrismBeat (owner 2026-07-30) */}
        <div className="mt-10 flex justify-center">
          <PoweredByPrism />
        </div>
      </div>
    </div>
  )
}

// ── the identity panel: the thesis-first face of whatever the console is on ──
function BasketContextPanel({ address, chainId }: { address: string | null; chainId: number }) {
  const { data: all } = useAllBaskets()
  const { data: meta } = useCreatorMeta(address ?? undefined, chainId)
  const b = address
    ? (all ?? []).find((x) => x.chainId === chainId && x.address.toLowerCase() === address.toLowerCase())
    : undefined
  if (!b) return null

  const top = [...b.top].sort((a, y) => y.weightPct - a.weightPct)
  return (
    // Renders on EVERY width (was hidden lg:block — phone buyers got zero
    // thesis/composition context on /swap; mobile UX review 5). Below lg it
    // stacks under the console, exactly as the grid comment always promised.
    <aside className="relative overflow-hidden rounded-3xl border border-white/12 bg-white/[0.02] backdrop-blur-md lg:sticky lg:top-24">
      {/* the basket's own color field */}
      <BasketWash ix={b} side="right" opacity={0.3} />

      <div className="relative p-6">
        <div className="flex items-center gap-3">
          <BasketAvatar address={b.address} symbol={b.symbol} size={44} />
          <div className="min-w-0">
            <div className="truncate font-display text-xl font-bold uppercase tracking-tight text-ink">{b.name}</div>
            <div className="font-mono text-xs text-ink-dim">${showSymbol(b.symbol)}</div>
          </div>
        </div>

        {meta?.tagline && (
          <p className="mt-4 font-display text-lg font-semibold leading-snug text-ink">{meta.tagline}</p>
        )}

        {/* the selected basket's living trend (owner 2026-07-29: charts on the
            swap page) — the dither engine in its identity colour, hoverable */}
        <div className="mt-4 h-28 w-full">
          <BasketSpark
            chainId={b.chainId}
            assets={top.map((h) => ({ address: h.address, weight: h.weightPct }))}
            navPerToken={b.navPerToken}
            fallback={b.navSeries}
            range="7D"
            address={b.address}
            symbol={b.symbol}
            legs={top.map((h) => ({ symbol: h.symbol, address: h.address, weightPct: h.weightPct }))}
            withRanges
            bloom="low"
          />
        </div>

        {/* the facts row — NAV · 24h · TVL, spread across the width (owner 15:32) */}
        <div className="mt-4 flex items-end justify-between gap-6 border-t border-white/10 pt-4 pr-2 sm:pr-6">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">NAV</div>
            <div className="mt-1 font-num text-xl font-light tabular-nums text-ink">${formatNav(b.navPerToken)}</div>
          </div>
          {b.change24hPct != null && (
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">24h</div>
              <div className={`mt-1 font-num text-xl font-light tabular-nums ${b.change24hPct >= 0 ? 'text-teal' : 'text-magenta'}`}>
                {b.change24hPct >= 0 ? '+' : ''}
                {b.change24hPct.toFixed(1)}%
              </div>
            </div>
          )}
          <div>
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">TVL</div>
            <div className="mt-1 font-num text-xl font-light tabular-nums text-ink">{formatUsdCompact(b.aumUsd)}</div>
          </div>
        </div>

        {/* what's inside — the bento, not a text list (owner 15:32: "the
            little bento grid there instead, rather than more text") */}
        <div className="mt-4 border-t border-white/10 pt-4">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-faint">Holds</div>
          <div className="mt-2.5">
            <BasketBento
              items={top.map((h) => ({ symbol: h.symbol, address: h.address, weightPct: h.weightPct, chainId: b.chainId }))}
              aspect={1.7}
            />
          </div>
        </div>

        <Link
          to={`/token?addr=${b.address}&chain=${b.chainId}`}
          className="press mt-5 block rounded-xl border border-white/15 py-2.5 text-center font-mono text-[11px] uppercase tracking-[0.16em] text-ink-dim transition-colors hover:border-cyan/50 hover:text-cyan"
        >
          View the basket →
        </Link>
      </div>
    </aside>
  )
}
