import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { SUPPORTED_CHAIN_IDS } from '../../lib/chain/chains'
import { useAccount } from 'wagmi'
import type { BasketSummary } from '../../lib/spectrum/basket-data'
import type { ChainNeed } from '../../lib/spectrum/funding-plan'
import { readThesisFunds } from '../../lib/spectrum/thesis-funding'
import {
  formatAssetFloor,
  readPayAssetOptions,
  setThesisPayChoice,
  thesisPayChoice,
  thesisPayKey,
  type PayAssetOption,
} from '../../lib/spectrum/thesis-pay-asset'
import { heldPosition } from '../../lib/spectrum/held-baskets'
import type { useHeldBaskets } from '../../lib/spectrum/use-held-baskets'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { SWAP_ENABLED } from '../../lib/config/features'
import { ChainBadge } from '../ChainBadge'
import { basketHref } from '../../lib/spectrum/short-url'
import { chainLabel, settlementLabel, usdCents } from './run-lanes'
import { PayAssetPicker } from './PayAssetPicker'
import type { ThesisRunMode } from './ThesisRunOverlay'

// ─────────────────────────────────────────────────────────────────────────────
// THE THESIS CONSOLE — the swap page's own grammar (owner 2026-08-09: "the
// actual nice buy/sell swap ui from the swap page in place of the current
// 500/1000 etc"), pointed at a whole thesis: a PAY panel, the flip, a RECEIVE
// panel, one CTA. The panels are the swap console's exact surfaces
// (`card-surface rounded-3xl`, the 10px mono eyebrow row, the 4xl font-num
// figure) so the two pages read as one product.
//
// It does NOT execute. The run overlay owns every signature; this console owns
// the amount and the honest preview. Its receive panel IS the split — computed
// from `thesisNeeds` by the page and passed down — so as the figure changes the
// per-network answer changes with it, which retires the old separate
// "preview the split" toggle.
//
// The pay balance is the wallet's settlement money summed across exactly the
// thesis's own chains (`readThesisFunds` — a failed chain is OMITTED there, so
// this figure is a floor, and the label says "spendable"). The 25/50/Max chips
// act on that floor, the same three verbs the swap console's balance row uses.
// ─────────────────────────────────────────────────────────────────────────────

type HeldIndex = ReturnType<typeof useHeldBaskets>

/** Basket-token estimate: whole tokens get cents-like precision, sub-token
 *  amounts keep enough digits to not read as zero. Display only — the real
 *  minimum is set at signing, and the copy under the panel says so. */
function fmtTokens(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null
  return n >= 1
    ? n.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

export function ThesisConsole({
  legs,
  needs,
  amount,
  setAmount,
  amountCents,
  isDemo,
  heldIndex,
  shareOf,
  onRun,
payNudge,
}: {
  /** increments to open the pay-asset picker from outside (the shortfall offer). */
  payNudge?: number
  legs: BasketSummary[]
  needs: ChainNeed[] | null
  amount: string
  setAmount: (v: string) => void
  amountCents: number
  isDemo: boolean
  heldIndex: HeldIndex
  shareOf: (leg: BasketSummary) => number | null
  onRun: (mode: ThesisRunMode) => void
}) {
  const { address, isConnected } = useAccount()
  const [dir, setDir] = useState<'buy' | 'sell'>('buy')
  const [flipped, setFlipped] = useState(false)

  const chainIds = useMemo(() => legs.map((l) => l.chainId), [legs])

  // The wallet's spendable settlement money on the thesis's own chains. Only
  // read when it can matter: a demo thesis never arms, and a disconnected
  // console shows the input without a balance row, exactly like the swap page.
  const { data: funds } = useQuery({
    queryKey: ['thesis-console-funds', address, [...new Set([...chainIds, ...SUPPORTED_CHAIN_IDS])].sort().join(',')],
    // the UNION read (the donor-chain fix, 2026-08-14): the preview must see
    // the same funding chains the run does, or its verdicts diverge
    queryFn: () => readThesisFunds([...new Set([...chainIds, ...SUPPORTED_CHAIN_IDS])], address as Address),
    enabled: SWAP_ENABLED && !isDemo && !!address && dir === 'buy' && chainIds.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  const spendableCents = useMemo(
    () => (funds ? funds.reduce((s, f) => s + f.usdcCents, 0) : null),
    [funds],
  )

  // ── the pay source (the owner 2026-08-13, ruling his own 2026-08-11 question:
  // "you should probably be able to select the asset you want to swap out of
  // here right?"). DEFAULT = null = settlement balances, today's flow byte for
  // byte. The choice travels to the run overlay through the leg-set-keyed
  // session store (thesis-pay-asset.ts) — this console and the overlay are
  // mounted by a page neither owns. Options are ONLY what the wallet
  // verifiably holds; the read never runs for demo/disconnected consoles.
  const payKey = useMemo(() => thesisPayKey(legs.map((l) => ({ chainId: l.chainId, address: l.address }))), [legs])
  const [pay, setPay] = useState<PayAssetOption | null>(() => thesisPayChoice(payKey))
  const [payOpen, setPayOpen] = useState(false)
  // the shortfall offer's landing (ThesisRunOverlay closes → this opens):
  // an incrementing signal so repeated offers re-open without prop games
  useEffect(() => {
    if (payNudge != null && payNudge > 0) setPayOpen(true)
  }, [payNudge])
  const pickPay = (opt: PayAssetOption | null) => {
    setPay(opt)
    setThesisPayChoice(payKey, opt)
    setPayOpen(false)
  }
  const { data: payOptions, isLoading: payLoading } = useQuery({
    queryKey: ['thesis-pay-options', address, [...chainIds].sort().join(',')],
    queryFn: () => readPayAssetOptions(chainIds, address as Address),
    enabled: SWAP_ENABLED && !isDemo && !!address && dir === 'buy' && chainIds.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  // A wallet switch invalidates the choice — another account's holdings are
  // not this one's. The ref-compare keeps a store-restored pick alive on mount.
  const prevAddr = useRef(address)
  useEffect(() => {
    if (prevAddr.current === address) return
    prevAddr.current = address
    if (thesisPayChoice(payKey) != null) pickPay(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])
  // A pick the fresh read no longer offers (balance gone/unreadable) resets to
  // the default rather than promising an asset we can no longer see.
  useEffect(() => {
    if (pay == null || payOptions == null) return
    const still = payOptions.find(
      (o) => o.chainId === pay.chainId && o.address.toLowerCase() === pay.address.toLowerCase(),
    )
    if (!still) pickPay(null)
    else if (still.balanceRaw !== pay.balanceRaw) {
      setPay(still)
      setThesisPayChoice(payKey, still)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payOptions])
  const settlementWords = useMemo(() => [...new Set(chainIds.map((id) => settlementLabel(id)))].join(' · '), [chainIds])

  const held = useMemo(
    () =>
      legs
        .map((leg) => ({ leg, pos: heldPosition(heldIndex, leg) }))
        .filter((r): r is { leg: BasketSummary; pos: NonNullable<ReturnType<typeof heldPosition>> } => r.pos != null),
    [legs, heldIndex],
  )

  const flip = () => {
    setDir((d) => (d === 'buy' ? 'sell' : 'buy'))
    setFlipped((f) => !f)
  }

  const setFromCents = (cents: number) => {
    const v = Math.floor(cents) / 100
    setAmount(v > 0 ? String(Math.round(v * 100) / 100) : '')
  }

  const buys = needs?.reduce((s, n) => s + n.buysCents, 0) ?? 0

  // ── the PAY face of each direction ─────────────────────────────────────────
  const payPanel =
    dir === 'buy' ? (
      <section className="relative rounded-3xl card-surface p-5 backdrop-blur-md transition-shadow focus-within:ring-1 focus-within:ring-cyan/25 sm:p-6">
        <div className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          <span>You pay</span>
          {/* the balance chips act on SETTLEMENT money, so they stand down when
              another pay asset is chosen — its own balance takes their place */}
          {pay == null && spendableCents != null && (
            <span className="flex items-center gap-1">
              <span className="mr-1 tabular-nums">{usdCents(spendableCents)}</span>
              {([25, 50] as const).map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setFromCents((spendableCents * pct) / 100)}
                  className="press relative rounded-md border border-white/10 px-1.5 py-0.5 after:absolute after:-inset-2.5 hover:border-cyan/40 hover:text-cyan"
                >
                  {pct}%
                </button>
              ))}
              <button
                type="button"
                onClick={() => setFromCents(spendableCents)}
                className="press relative rounded-md border border-cyan/30 px-1.5 py-0.5 text-cyan after:absolute after:-inset-2.5 hover:border-cyan/60"
              >
                Max
              </button>
            </span>
          )}
          {pay != null && (
            <span className="tabular-nums">
              {formatAssetFloor(pay.balanceRaw, pay.decimals)} {pay.symbol} held
            </span>
          )}
        </div>
        {/* a LABEL, so the whole bordered field focuses the input natively —
            the figure read as a static stat until the box said otherwise
            (owner 2026-08-10: "more obvious the usd number here is in a text
            field you can type in") */}
        <label className="mt-4 flex cursor-text items-center gap-3 rounded-xl border border-white/15 bg-black/25 px-4 py-2.5 transition-colors focus-within:border-cyan/60 focus-within:ring-1 focus-within:ring-cyan/25 sm:mt-3">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            onKeyDown={(e) => {
              // Enter = the primary, when armed. It opens the run overlay —
              // reversible; nothing signs without further, per-step consent.
              if (e.key === 'Enter' && !cta.disabled && cta.onClick) cta.onClick()
            }}
            inputMode="decimal"
            enterKeyHint="done"
            autoComplete="off"
            placeholder="0"
            size={1}
            aria-label="Amount to pay, in dollars, split across every network"
            className="min-w-0 flex-1 bg-transparent font-num text-4xl font-light tabular-nums text-ink outline-none placeholder:text-ink-faint"
          />
          <span className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-white/[0.06] px-3.5 font-display text-sm font-bold uppercase tracking-wide text-ink">
            USD
            <span className="font-mono text-[9px] font-normal uppercase tracking-[0.14em] text-ink-faint">
              {legs.length} {legs.length === 1 ? 'network' : 'networks'}
            </span>
          </span>
        </label>
        {/* THE PAY-SOURCE ROW (the owner 2026-08-13: "you should probably be able
            to select the asset you want to swap out of here right?"). The chip
            defaults to Settlement — today's flow untouched — and only ever
            offers what the wallet verifiably holds (PayAssetPicker). */}
        {(isDemo || SWAP_ENABLED) && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">pay from</span>
              <button
                type="button"
                onClick={() => setPayOpen(true)}
                aria-label="Choose what you pay from"
                className="press flex shrink-0 items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] py-1 pl-2.5 pr-2 hover:border-white/30"
              >
                <span className="font-display text-xs font-bold uppercase tracking-wide text-ink">
                  {pay == null ? 'Settlement' : `${pay.symbol} · ${chainLabel(pay.chainId)}`}
                </span>
                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-ink-faint" aria-hidden>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            </span>
            {pay == null && spendableCents != null && (
              <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                spendable across {funds?.length ?? 0} {(funds?.length ?? 0) === 1 ? 'network' : 'networks'}
              </span>
            )}
          </div>
        )}
        {pay != null && (
          <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
            sells {pay.symbol} into settlement first, quoted before you sign
          </p>
        )}
        {/* MORE THAN SETTLEMENT HOLDS is an OFFER, not a wall (owner
            2026-08-16: "it shouldnt refuse the user it should be there to
            help them" — sell another asset / bridge; the run composes both).
            The gap is stated in dollars and the button is the same picker the
            pay-from chip opens. Settlement money only: with a pay asset
            chosen, the run's plan states coverage in that asset's units. */}
        {pay == null && spendableCents != null && amountCents > spendableCents && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-cyan/25 bg-cyan/[0.05] px-3 py-2">
            <span className="font-mono text-[10px] tabular-nums leading-relaxed text-ink-dim">
              Needs {usdCents(amountCents - spendableCents)} more.
            </span>
            <button
              type="button"
              onClick={() => setPayOpen(true)}
              className="press font-mono text-[10px] uppercase tracking-[0.14em] text-cyan hover:underline"
            >
              Pay from another asset →
            </button>
          </div>
        )}
      </section>
    ) : (
      <section className="relative rounded-3xl card-surface p-5 backdrop-blur-md sm:p-6">
        <div className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          <span>You sell</span>
          {held.length > 0 && <span>{held.length} of {legs.length} {legs.length === 1 ? 'network' : 'networks'} held</span>}
        </div>
        {held.length > 0 ? (
          <div className="mt-4 space-y-2 sm:mt-3">
            {held.map(({ leg, pos }) => (
              <div key={`${leg.chainId}:${leg.address}`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <ChainBadge chainId={leg.chainId} size="md" />
                <span className="min-w-0 truncate font-display text-sm font-bold uppercase tracking-wide text-ink">
                  ${showSymbol(leg.symbol)}
                </span>
                <span className="flex-1" />
                {/* a held-but-unpriced leg still shows — "$0" beside a real
                    position is the one lie this row must never tell */}
                {pos.valueUsd != null && (
                  <span className="font-num text-xl font-light tabular-nums text-ink">
                    {usdCents(Math.round(pos.valueUsd * 100))}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm leading-relaxed text-ink-dim sm:mt-3">
            You hold no part of this bundle yet. Flip back to buy it, and this side fills in.
          </p>
        )}
      </section>
    )

  // ── the RECEIVE face ────────────────────────────────────────────────────────
  const receivePanel =
    dir === 'buy' ? (
      <section className="relative rounded-3xl card-surface p-5 backdrop-blur-md sm:p-6">
        <div className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          <span>You receive (est.)</span>
          {buys > 0 && <span className="tabular-nums">{usdCents(buys)} split</span>}
        </div>
        {needs && needs.length > 0 ? (
          <div className="mt-4 space-y-3 sm:mt-3">
            {needs.map((n) => {
              const leg = legs.find((l) => l.chainId === n.chainId)
              if (!leg) return null
              const pct = shareOf(leg)
              const est =
                Number.isFinite(leg.navPerToken) && leg.navPerToken > 0
                  ? fmtTokens(n.buysCents / 100 / leg.navPerToken)
                  : null
              // TWO CLUSTERS, one row: identity (wraps inside itself) and
              // money (pinned right). A single flex-wrap row strands the
              // amounts LEFT under the badge on a phone — a money figure that
              // changes sides is a money figure someone misreads.
              return (
                <div key={n.chainId} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <ChainBadge chainId={n.chainId} size="md" />
                    {/* the ticker IS the door to the leg's own page — the
                        list idiom (rows link), without crowding the money side */}
                    <Link
                      to={basketHref(leg)}
                      aria-label={`Open $${showSymbol(leg.symbol)}'s own page`}
                      className="press min-w-0 truncate font-display text-sm font-bold uppercase tracking-wide text-ink hover:text-cyan"
                    >
                      ${showSymbol(leg.symbol)}
                    </Link>
                    {pct != null && (
                      <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                        {pct.toFixed(0)}%
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-num text-xl font-light tabular-nums text-ink">
                      {est ? `≈ ${est}` : usdCents(n.buysCents)}
                    </span>
                    {est && (
                      <span className="block font-mono text-[10px] tabular-nums text-ink-faint">
                        {usdCents(n.buysCents)}
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="mt-4 font-num text-4xl font-light tabular-nums text-ink-faint sm:mt-2">0</div>
        )}
      </section>
    ) : (
      <section className="relative rounded-3xl card-surface p-5 backdrop-blur-md sm:p-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">You receive (est.)</div>
        {held.length > 0 ? (
          <>
            <div className="mt-4 flex items-center gap-3 sm:mt-2">
              <div className="min-w-0 flex-1 truncate font-num text-4xl font-light tabular-nums text-ink">
                {held.every((h) => h.pos.valueUsd != null)
                  ? usdCents(Math.round(held.reduce((s, h) => s + (h.pos.valueUsd ?? 0), 0) * 100))
                  : '—'}
              </div>
              <span className="inline-flex h-10 shrink-0 items-center rounded-xl border border-white/12 bg-black/25 px-3.5 font-display text-sm font-bold uppercase tracking-wide text-ink">
                USDC
              </span>
            </div>
            <div className="mt-1 font-mono text-[11px] leading-relaxed text-ink-faint">
              lands on each network where you sold — how much of it you sell is chosen in the next step
            </div>
          </>
        ) : (
          <div className="mt-4 font-num text-4xl font-light tabular-nums text-ink-faint sm:mt-2">0</div>
        )}
      </section>
    )

  // ── the one CTA ─────────────────────────────────────────────────────────────
  let cta: { label: string; onClick?: () => void; disabled: boolean }
  if (isDemo) {
    // LAUNCH PRESENTATION (owner 2026-08-10: "should not have demo text —
    // prep for the real launch"): the demo subject wears the REAL labels.
    // The guard is structural, not cosmetic — onRun('demo') drives the
    // walkthrough, and the run builder refuses to arm synthetic legs at
    // build AND at load, so no label change can move money.
    cta = { label: dir === 'buy' ? 'Buy the whole bundle' : 'Nothing held to sell', onClick: () => onRun('demo'), disabled: dir === 'sell' }
  } else if (!SWAP_ENABLED) {
    // plan-only deployment: the receive panel above IS the plan; the rail on
    // the plate's left says how to act. No dead verb pretending otherwise.
    cta = { label: `${dir === 'buy' ? 'Buying' : 'Selling'} is switched off on this deployment`, disabled: true }
  } else if (dir === 'buy') {
    if (!isConnected)
      cta = { label: 'Connect wallet to buy', onClick: () => window.dispatchEvent(new Event('spectrum:connect')), disabled: false }
    else if (amountCents <= 0) cta = { label: 'Enter an amount', disabled: true }
    else cta = { label: 'Buy the whole bundle', onClick: () => onRun('buy'), disabled: false }
  } else {
    if (!isConnected)
      cta = { label: 'Connect wallet to sell', onClick: () => window.dispatchEvent(new Event('spectrum:connect')), disabled: false }
    else if (held.length === 0) cta = { label: 'Nothing to sell yet', disabled: true }
    else cta = { label: 'Sell across all networks', onClick: () => onRun('sell'), disabled: false }
  }

  return (
    <div>
      {payPanel}

      {/* the flip — the swap console's own control, same size, same rotation */}
      <div className="relative z-10 -my-3 flex justify-center">
        <button
          type="button"
          onClick={flip}
          aria-label={dir === 'buy' ? 'Flip to selling' : 'Flip to buying'}
          className="press grid h-10 w-10 place-items-center rounded-xl border border-white/15 bg-panel text-ink-dim shadow-[0_8px_20px_rgba(0,0,0,0.5)] transition-transform duration-300 hover:border-cyan/50 hover:text-cyan"
          style={{ transform: flipped ? 'rotate(180deg)' : 'none' }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4v16m0 0l-5-5m5 5l5-5" />
          </svg>
        </button>
      </div>

      {receivePanel}

      <button
        type="button"
        disabled={cta.disabled}
        onClick={cta.onClick}
        className="spectral-btn press mt-4 inline-flex h-12 w-full items-center justify-center rounded-xl px-6 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-void disabled:cursor-not-allowed disabled:opacity-60"
      >
        {cta.label}
      </button>

      {/* THE ENFORCEMENT LINE, in the quietest tier (owner 2026-08-13: "way too
          much text here" — the plate's teaching went; what is ENFORCED stays).
          "one guided session" was the teaching half and is gone: the step spine
          above already says "a signature or two per network". This is now the
          only place the buy side states that the floor is checked where it
          actually binds, so it does not get trimmed again. The sell branch is
          untouched — that direction was not what was being reviewed. */}
      <p className="mt-3 px-1 text-center font-mono text-[10px] uppercase tracking-[0.14em] leading-relaxed text-ink-faint">
        {isDemo || dir === 'buy'
          ? 'minimums enforced at signing'
          : 'one sale per network · floors enforced at signing'}
      </p>

      {payOpen && (
        <PayAssetPicker
          options={payOptions ?? null}
          loading={payLoading}
          current={pay}
          spendableCents={spendableCents}
          networks={legs.length}
          settlementWords={settlementWords}
          demo={isDemo}
          onPick={pickPay}
          onClose={() => setPayOpen(false)}
        />
      )}
    </div>
  )
}
