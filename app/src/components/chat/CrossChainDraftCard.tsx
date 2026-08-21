// THE CROSS-CHAIN DRAFT, ONE VISUAL (owner 2026-08-20, refined 2026-08-21:
// "as you build your basket it shouldnt show the compose bit, just show the
// assets in the total bundle and their weights you can toggle"). While the
// basket is still being BUILT this is a planning canvas: every pick across
// every chain in ONE weighted list, each weight adjustable with steppers. No
// per-chain compose doors here — deploying is a later step, triggered when the
// draft is done, not a control cluttering every row.
//
// House pieces only, never lookalikes: tokenVisual colours the tiles, AssetLogo
// draws the disc, showSymbol guards every ticker, ChainLogo names each asset's
// chain. Weights start equal and BIND (owner 2026-08-21 — they used to be a
// local planning view that never reached deploy, which made "set your weights"
// a false invitation): Finalize speaks them on the same channel spoken weights
// have always used, and the agent renormalises them PER CHAIN because each chain
// becomes its own basket. The REAL BundleCard is emitted separately by the agent
// once the chains deploy; this card only announces the wrap is ready.
import { useMemo, useState } from 'react'
import type { Address } from 'viem'
import type { AgentAction } from './agent'
import { AssetLogo } from '../AssetLogo'
import { ChainLogo } from '../ChainBadge'
import { chainCfg } from '../../lib/chain/chains'
import { tokenVisual } from '../../lib/spectrum/token-meta'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { CrossChainLaunchFlow } from './CrossChainLaunchFlow'

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

type CrossDraftAction = Extract<AgentAction, { kind: 'crossDraft' }>
type Leg = { address: Address; symbol: string; chainId: number }

/** the display short name ("Robinhood Chain" → "Robinhood") */
const shortName = (chainId: number) => chainCfg(chainId).name.replace(/\s*chain$/i, '')
const legKey = (l: Leg) => `${l.chainId}:${l.address.toLowerCase()}`

/** CreateAssetPicker's bento tile at chat scale: a plate in the asset's own
 *  colour, the white ticker pill, the logo disc bottom-right. */
function MiniTile({ leg }: { leg: Leg }) {
  const vis = tokenVisual(leg.symbol, leg.address)
  return (
    <span
      className="relative block h-10 w-10 shrink-0 overflow-hidden rounded-xl"
      style={{ background: vis.color, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.30), inset 0 -3px 7px rgba(0,0,0,0.22)' }}
    >
      <span aria-hidden className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0) 34%, rgba(0,0,0,0.16))' }} />
      <span aria-hidden className="absolute bottom-0.5 right-0.5 block">
        <AssetLogo address={leg.address} symbol={leg.symbol} chainId={leg.chainId} size={16} discColor={`color-mix(in srgb, ${vis.color} 55%, #000)`} />
      </span>
    </span>
  )
}

function Tick({ size = 12 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--color-teal)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function CrossChainDraftCard({
  action,
  onPick,
  onDeployed,
}: {
  action: CrossDraftAction
  onPick: (line: string) => void
  /** each chain's basket as the one-button flow lands it — the chat remembers */
  onDeployed?: (leg: { chainId: number; address: Address; symbol: string }) => void
}) {
  const finalized = action.mode === 'finalized'
  // flatten every bucket into one ordered leg list — the "total bundle"
  const legs = useMemo<Leg[]>(
    () => action.buckets.flatMap((b) => b.picks.map((p) => ({ address: p.address, symbol: p.symbol, chainId: b.chainId }))),
    [action.buckets],
  )
  const chains = useMemo(() => [...new Set(legs.map((l) => l.chainId))], [legs])
  const deployedIds = new Set(action.deployed.map((b) => b.chainId))

  // WEIGHTS, adjustable (owner "their weights you can toggle"). Raw units per
  // leg, equal to start; the DISPLAY is each leg's share of the running sum, so
  // it always totals 100 and a stepper never needs a re-normalise pass. These
  // are the numbers that DEPLOY: Finalize speaks them and the agent carries them
  // through, renormalised for each chain's own basket.
  const [raw, setRaw] = useState<Record<string, number>>({})
  const weightRaw = (l: Leg) => raw[legKey(l)] ?? 10
  const sum = legs.reduce((s, l) => s + weightRaw(l), 0) || 1
  const pctOf = (l: Leg) => Math.round((weightRaw(l) / sum) * 100)
  const bump = (l: Leg, d: number) => setRaw((r) => ({ ...r, [legKey(l)]: Math.max(1, Math.min(40, weightRaw(l) + d)) }))

  const isBundle = chains.length >= 2

  if (legs.length === 0) {
    return (
      <div className="flex w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-white/[0.12] bg-white/[0.04] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07)] sm:min-w-[var(--chat-card-min,24rem)]">
        <div aria-hidden className="h-px w-full" style={{ background: GRADIENT }} />
        <div className="flex flex-col gap-2 p-4">
          <h3 className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">Your bundle</h3>
          <p className="text-[12px] leading-snug text-ink-faint">Name assets, any chain. Each one joins the mix here with a weight you can set.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-white/[0.12] bg-white/[0.04] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07)] sm:min-w-[var(--chat-card-min,24rem)]">
      <div aria-hidden className="h-px w-full" style={{ background: GRADIENT }} />
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">
            {finalized ? 'What gets made where' : isBundle ? `Your bundle · ${legs.length} assets` : `Your basket · ${legs.length} assets`}
          </h3>
          {isBundle && (
            <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              {chains.map((c) => (
                <span key={c} title={shortName(c)} className="grid place-items-center">
                  <ChainLogo chainId={c} size={13} />
                </span>
              ))}
            </span>
          )}
        </div>

        {finalized ? (
          /* FINALIZED: what gets made where, then ONE flow that makes it.
             (owner 2026-08-21: "there should never be a time where a user has
             multiple options… one deploy flow with one button that takes the
             user through all the steps automatically".) The per-chain "Deploy
             on <chain>" doors that used to sit here WERE that multiple-options
             state; CrossChainLaunchFlow now walks deploy → first deposit (with
             the bridge when a chain is short) → wrap → share on its own. */
          <>
            <div className="flex flex-col gap-2">
              {action.buckets.map((b) => (
                <div key={b.chainId} className="flex flex-col gap-2 rounded-xl border border-white/[0.1] bg-white/[0.03] p-3">
                  <div className="flex items-center gap-1.5">
                    <ChainLogo chainId={b.chainId} size={16} />
                    <span className="font-display text-sm font-bold text-ink">{shortName(b.chainId)} basket</span>
                    <span className="ml-auto flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                      {deployedIds.has(b.chainId) ? (<><Tick size={11} /> deployed</>) : `${b.picks.length} asset${b.picks.length === 1 ? '' : 's'}`}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {b.picks.map((p) => (
                      <span key={p.address} className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.02] py-1 pl-1 pr-2">
                        <MiniTile leg={{ ...p, chainId: b.chainId }} />
                        <span className="font-display text-[12px] font-bold text-ink">${showSymbol(p.symbol)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <CrossChainLaunchFlow buckets={action.buckets} deployed={action.deployed} onDeployed={onDeployed} onPick={onPick} />
          </>
        ) : (
          /* BUILDING: the total bundle as one weighted list you can toggle */
          <>
            <div className="flex flex-col gap-1.5">
              {legs.map((l) => (
                <div key={legKey(l)} className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-2">
                  <MiniTile leg={l} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-display text-sm font-bold text-ink">${showSymbol(l.symbol)}</span>
                    <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                      <ChainLogo chainId={l.chainId} size={11} /> {shortName(l.chainId)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => bump(l, -1)}
                      aria-label={`Lower ${showSymbol(l.symbol)} weight`}
                      className="press grid h-6 w-6 place-items-center rounded-full border border-white/[0.14] text-ink-dim hover:border-white/[0.3] hover:text-ink"
                    >
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M5 12h14" /></svg>
                    </button>
                    <span className="w-10 text-center font-num text-sm font-bold tabular-nums text-ink">{pctOf(l)}%</span>
                    <button
                      type="button"
                      onClick={() => bump(l, 1)}
                      aria-label={`Raise ${showSymbol(l.symbol)} weight`}
                      className="press grid h-6 w-6 place-items-center rounded-full border border-white/[0.14] text-ink-dim hover:border-white/[0.3] hover:text-ink"
                    >
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <p className="px-0.5 text-[12px] leading-snug text-ink-faint">Keep adding assets and set your weights. Finalize when it looks right{isBundle ? '; assets across chains become a bundle' : ''}.</p>

            {/* THE FINALIZE BUTTON (owner 2026-08-21): reveals what gets made
                where and moves to deploying, in the chat. Below the info. */}
            <button
              type="button"
              disabled={legs.length < 2}
              onClick={() => {
                // THE STEPPERS NOW BIND (owner 2026-08-21: they were cosmetic —
                // the card invited you to set weights that never reached deploy).
                // They travel on the SPOKEN channel that already exists and is
                // driver-tested: parseInlineWeights reads "40% AAVE" into bySym,
                // so the finalize handler can carry them per chain. No new
                // transport, and a plain "finalize basket" still works.
                const spoken = legs.map((l) => `${pctOf(l)}% ${showSymbol(l.symbol)}`).join(' ')
                onPick(`finalize basket ${spoken}`)
              }}
              className="press w-full rounded-xl px-5 py-3 text-center font-display text-sm font-bold uppercase tracking-[0.06em] text-void transition-transform enabled:hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: GRADIENT }}
            >
              {legs.length < 2 ? 'Add at least 2 assets' : 'Finalize basket →'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
