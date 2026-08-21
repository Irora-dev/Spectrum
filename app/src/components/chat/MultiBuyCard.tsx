// ONE FLOW FOR A MULTI-BUY (owner 2026-08-21, the one-button audit). "buy $25
// each of SVI and TRINITY" used to emit up to FOUR live trade cards in one
// reply — four armed primaries on screen at once, four signatures, and nothing
// orchestrating them. That is the multiple-options state, and the exact
// opposite of the one-button law he applied to launching.
//
// Same shape as the cross-chain launch: one entry press, then the flow walks
// itself and shows exactly ONE card at a time. Each leg is the app's REAL
// DexSwapCard over its real quoting and floors — no second money path — and the
// wallet still signs each buy, which is the consent boundary, not a step we
// forgot to automate. When a card reports its trade landed, the next one mounts.
import { useMemo, useState } from 'react'
import type { BasketData } from '../../lib/spectrum/basket-data'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { CHAINS } from '../../lib/chain/chains'
import { DexSwapCard } from '../DexSwapCard'
import { BasketAvatar } from '../BasketAvatar'
import { cheerSpecter } from './CopyRow'
import { playSfx } from './sfx'

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

function Tick({ size = 12 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--color-teal)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function MultiBuyCard({
  chainId,
  baskets,
  amountUsd,
  slippageBps,
}: {
  chainId: number
  baskets: BasketData[]
  amountUsd: number
  slippageBps?: number
}) {
  const [started, setStarted] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [skipped, setSkipped] = useState<Set<number>>(() => new Set())

  const chainLabel = (CHAINS[chainId]?.name ?? String(chainId)).replace(/\s*chain$/i, '')
  const total = useMemo(() => amountUsd * baskets.length, [amountUsd, baskets.length])
  const settled = cursor >= baskets.length
  const bought = cursor - skipped.size

  const advance = () => setCursor((c) => c + 1)

  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5 sm:min-w-[var(--chat-card-min,24rem)]">
      {/* the whole order, always visible, so nothing about it is a surprise */}
      <div className="flex flex-col gap-1.5">
        {baskets.map((b, i) => {
          const done = i < cursor && !skipped.has(i)
          const left = skipped.has(i)
          return (
            <div
              key={b.address}
              className="flex items-center gap-2.5 rounded-xl border px-3 py-2"
              style={{
                borderColor: done ? 'color-mix(in srgb, var(--color-teal) 40%, transparent)' : 'rgba(255,255,255,0.08)',
                background: i === cursor && started ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.03)',
              }}
            >
              <BasketAvatar address={b.address} symbol={b.symbol} size={26} />
              <span className="min-w-0 flex-1 truncate font-display text-[13px] font-bold text-ink">${showSymbol(b.symbol)}</span>
              <span className="font-mono text-[11px] tabular-nums text-ink-dim">${amountUsd}</span>
              <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.13em] text-ink-faint">
                {done ? (
                  <>
                    <Tick size={11} /> bought
                  </>
                ) : left ? (
                  'left out'
                ) : i === cursor && started ? (
                  'now'
                ) : (
                  'queued'
                )}
              </span>
            </div>
          )
        })}
      </div>

      {!started && (
        <>
          <p className="text-[13px] leading-snug text-ink-dim">
            ${amountUsd} into each of {baskets.length} on {chainLabel}, ${total.toLocaleString()} in total. They go one at a time
            and your wallet signs each, so you see every price before you take it.
          </p>
          {/* buttons BELOW the info, always — and ONE of them */}
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => setStarted(true)}
              className="rounded-full px-5 py-2.5 font-display text-[13px] font-bold text-void transition-transform hover:scale-[1.02]"
              style={{ background: GRADIENT }}
            >
              Buy all {baskets.length}, ${total.toLocaleString()}
            </button>
          </div>
        </>
      )}

      {started && !settled && (
        <>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            {bought} of {baskets.length} bought · now ${showSymbol(baskets[cursor].symbol)}
          </p>
          <div className="max-w-full overflow-hidden rounded-2xl">
            <DexSwapCard
              key={baskets[cursor].address}
              chainId={chainId}
              fixedBasket={baskets[cursor]}
              initialDir="buy"
              initialSlippageBps={slippageBps}
              defaultHub="USDC"
              stayHere
              initialAmount={String(amountUsd)}
              onTraded={(info) => {
                window.dispatchEvent(new CustomEvent('specter:traded', { detail: info }))
                cheerSpecter()
                playSfx('happy', 0.3)
                advance()
              }}
            />
          </div>
          {/* the way past a leg you have changed your mind about, as a link —
              never a button competing with the card's own armed Buy */}
          {cursor < baskets.length - 1 && (
            <button
              type="button"
              onClick={() => {
                setSkipped((prev) => new Set(prev).add(cursor))
                advance()
              }}
              className="w-fit text-[12px] text-ink-faint underline underline-offset-2 transition-colors hover:text-ink"
            >
              skip ${showSymbol(baskets[cursor].symbol)} and go to the next
            </button>
          )}
        </>
      )}

      {settled && (
        <div className="flex flex-col gap-1.5 rounded-2xl border p-3" style={{ borderColor: 'color-mix(in srgb, var(--color-teal) 45%, transparent)' }}>
          <p className="text-sm font-semibold text-ink">
            {bought} of {baskets.length} bought on {chainLabel}.
          </p>
          <p className="text-[12px] text-ink-dim">
            {skipped.size > 0
              ? `You left out ${[...skipped].map((i) => `$${showSymbol(baskets[i].symbol)}`).join(' and ')}. Ask again any time.`
              : 'Say “what do I hold?” for the fresh picture.'}
          </p>
        </div>
      )}
    </div>
  )
}
