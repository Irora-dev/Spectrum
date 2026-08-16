import { type ReactNode } from 'react'
import { chainCfg } from '../lib/chain/chains'
import { deploymentFor } from '../lib/chain/deployments'
import { useBasketFees } from '../lib/spectrum/use-basket-fees'
import { feeSplit } from '../lib/spectrum/fee-model'
import { INTERFACE_TAG_ADDRESS } from '../lib/config/operator'
import { shortAddr } from '../lib/spectrum/format'

// ─────────────────────────────────────────────────────────────────────────────
// Per-basket fee readout. Neutral and factual: every number is read from chain or
// derived from the protocol constants. Framed as protocol mechanics only — never
// as a reason to buy.
//
// The fee splits down a fixed waterfall: PRISM burn 25% off the top (D-R3); of the
// post-burn remainder a fixed interface slice (≈5%, per-tx, only when a tagging
// interface routes the trade) and a fixed launcher slice (≈5%, per-basket, only
// when the basket named a launcher); then the creator takes their chosen share
// (≤30%) of what is left and HOLDERS get the rest (≥70%). Unused interface/
// launcher slices stay in the remainder → creator + holders.
//
// Owner rule: the integrator slices are ALWAYS rows in the waterfall — with
// their exact value when they apply, or the reserved ≈5% quoted in the caption
// when they don't — so the readout never under-discloses where a fee can go.
// ─────────────────────────────────────────────────────────────────────────────

const fmtPct = (bps: number, dp = 2) => `${(bps / 100).toFixed(dp).replace(/\.?0+$/, '') || '0'}%`
/** A waterfall slice (fraction of the total fee) as a rough percent, e.g. 0.04995 → "5.0%". */
const fmtShare = (frac: number) => `${(frac * 100).toFixed(1).replace(/\.0$/, '')}%`

function Row({
  label,
  caption,
  value,
  href,
  tag,
}: {
  label: ReactNode
  caption?: string
  value: string
  href?: string
  tag?: string
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-t border-white/[0.06] py-2.5 first:border-t-0">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 font-mono text-[12px] text-ink">
          {tag && (
            <span className="rounded border border-white/15 px-1 py-px text-[9px] uppercase tracking-wide text-ink">
              {tag}
            </span>
          )}
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="truncate underline-offset-2 hover:text-cyan hover:underline"
            >
              {label}
            </a>
          ) : (
            <span className="truncate">{label}</span>
          )}
        </div>
        {caption && <div className="mt-1 text-[11px] leading-relaxed text-ink-faint">{caption}</div>}
      </div>
      <span className="shrink-0 font-num text-[15px] font-semibold tabular-nums text-ink">{value}</span>
    </div>
  )
}

export function FeePanel({ address, chainId }: { address: string; chainId: number }) {
  const { data: fees, isLoading } = useBasketFees(address, chainId)

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <div className="h-3 w-28 animate-pulse rounded bg-white/10" />
        <div className="mt-3 h-16 animate-pulse rounded bg-white/[0.04]" />
      </div>
    )
  }
  if (!fees) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Fees</div>
        <p className="font-mono text-[11px] leading-relaxed text-ink-faint">
          Fee config unavailable. Fees vary per basket and are read from the basket contract; this
          build could not read them.
        </p>
      </div>
    )
  }

  const explorer = chainCfg(chainId).explorer
  // The split for a trade through THIS interface: interface slice applies only
  // when this build carries a tag; launcher is a per-basket on-chain fact.
  const hasInterface = !!INTERFACE_TAG_ADDRESS
  const hasLauncher = !!fees.launcher
  // League slice: a per-chain lineage constant, and the contract skips it
  // entirely on a basket with no creatorPayout — mirror both, or the whole
  // split is overstated (kit audit).
  const leagueBps = deploymentFor(chainId).leagueShareBps
  const hasCreatorPayout = !!fees.creatorPayout
  const split = feeSplit(fees.creatorShareBps, { hasInterface, hasLauncher, leagueBps, hasCreatorPayout })
  // The protocol's reserved integrator slices (≈5% each) — quoted in the rows
  // even when they don't apply here, so the waterfall never hides a sink.
  const reserved = feeSplit(fees.creatorShareBps, {
    hasInterface: true,
    hasLauncher: true,
    leagueBps,
    hasCreatorPayout,
  })
  const hasCreator = fees.creatorShareBps > 0 && !!fees.creatorPayout

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Fees</span>
        <span className="rounded-full border border-white/12 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
          set at launch · can never change
        </span>
      </div>

      {/* the fee, big — one number, plain words */}
      <div className="flex items-baseline gap-3">
        <div className="font-num text-5xl font-light leading-none tabular-nums text-ink">{fmtPct(fees.basketFeeBps)}</div>
        <div className="font-mono text-[11px] text-ink-dim">on every buy, sell &amp; swap</div>
      </div>

      <div className="mt-5 border-t border-white/10 pt-3">
        <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-dim">
          Where it goes
        </div>

        {/* The league carve comes off the top BEFORE every other sink — hiding
            it would leave this waterfall 5% short of a whole (the same
            never-hide-a-sink rule as the integrator slices). Zero on non-league
            lineages and on baskets with no creator payout. */}
        {split.league > 0 && (
          <Row
            label="Creator league"
            caption="taken first · streams to the current league champion"
            value={fmtShare(split.league)}
          />
        )}

        <Row
          label="Burned"
          caption="buys & burns PRISM · identical on every basket"
          value={fmtShare(split.burn)}
        />

        {/* Integrator slices — ALWAYS listed (owner rule: the waterfall must
            mention the ≈5% swap-app and ≈5% launchpad shares even when they
            don't apply to this basket/build). */}
        {hasInterface ? (
          <Row
            label="App that routes the trade"
            caption="paid per trade made through an app like this one · nothing on direct contract trades"
            value={`≈${fmtShare(split.interface)}`}
          />
        ) : (
          <Row
            label="App that routes the trade"
            caption={`up to ≈${fmtShare(reserved.interface)} · this app doesn't collect it, so it goes to the creator & holders`}
            value="0%"
          />
        )}

        {hasLauncher ? (
          <Row
            label={shortAddr(fees.launcher!)}
            tag="launchpad"
            caption="the platform this basket was launched through"
            value={`≈${fmtShare(split.launcher)}`}
            href={`${explorer}/address/${fees.launcher}`}
          />
        ) : (
          <Row
            label="Launchpad"
            caption={`up to ≈${fmtShare(reserved.launcher)} · none named on this basket, so it goes to the creator & holders`}
            value="0%"
          />
        )}

        {hasCreator ? (
          <Row
            label="Basket creator"
            caption={`their chosen ${fmtPct(fees.creatorShareBps)} share of what remains`}
            value={`≈${fmtShare(split.creator)}`}
            href={`${explorer}/address/${fees.creatorPayout}`}
          />
        ) : (
          <Row label="Basket creator" caption="takes no fee on this basket" value="0%" />
        )}

        {/* Quarantine rule: never "holders earn / are paid". */}
        <Row
          label="Reserve for holders"
          caption="everything left · accrues per token beside NAV · claim yours on the fee console"
          value={`≈${fmtShare(split.holders)}`}
        />
      </div>

      {/* The integrator slices are disclosed in the rows above; this footnote only
          flags the live case where THIS build is the one collecting. */}
      {INTERFACE_TAG_ADDRESS && (
        <p className="mt-3 border-t border-white/10 pt-2.5 font-mono text-[10px] leading-relaxed text-ink-faint">
          This app receives ≈{fmtShare(split.interface)} of the fee on trades made through it. On
          direct contract trades that share goes to the creator and holders instead.
        </p>
      )}
    </div>
  )
}
