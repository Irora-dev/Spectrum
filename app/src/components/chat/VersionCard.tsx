// NEW VERSION, IN THE CHAT (owner 2026-08-21, the one-button audit: creating a
// new version was not a fragmented flow, it was an ABSENT one — no action kind,
// no card, not even a link out, so anything the chat deployed was a fresh
// UNLINKED basket).
//
// An update is not an edit: a basket is immutable, so a new version is a fresh
// deploy LINKED as the successor, and holders migrate (his own correction,
// 2026-08-19). This card does exactly that and nothing else new:
//   · the legs and weights are seeded from the predecessor's OWN on-chain
//     holdings, through seedWeightsFromPredecessor — the builder's verbatim
//     weight recipe, not a second one written here.
//   · the deploy is the REAL DeployCard over useDeployBasket.
//   · the link is signed by useLineageSign, the same hook the reshape modal and
//     the builder use, armed once the successor is live. It is fire-once per
//     predecessor→successor pair, so no double sheet.
// The identity is prefilled but editable: the legs are a starting point you are
// expected to change, which is the entire reason to make a version.
import { useMemo, useState } from 'react'
import type { Address } from 'viem'
import type { BasketData } from '../../lib/spectrum/basket-data'
import { seedWeightsFromPredecessor } from '../../lib/spectrum/version-seed'
import { useLineageSign } from '../../lib/spectrum/use-lineage-sign'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { CHAINS } from '../../lib/chain/chains'
import { DeployCard } from './DeployCard'
import { SpectrumLoader } from '../SpectrumLoader'

/** "SVI" → "SVI2", "SVI2" → "SVI3". Kept to 11 chars, the symbol rule. */
export function bumpSymbol(sym: string): string {
  const m = /^(.*?)(\d+)$/.exec(sym)
  const next = m ? `${m[1]}${Number(m[2]) + 1}` : `${sym}2`
  return next.slice(0, 11).toUpperCase()
}

/** "Solid Value Index" → "Solid Value Index v2" (or v3, v4…). */
export function bumpName(name: string): string {
  const m = /^(.*?)\sv(\d+)$/i.exec(name.trim())
  return m ? `${m[1]} v${Number(m[2]) + 1}` : `${name.trim()} v2`
}

export function VersionCard({
  chainId,
  predecessor,
  onDeployed,
}: {
  chainId: number
  predecessor: BasketData
  /** the successor is live and linked — the chat remembers it */
  onDeployed?: (leg: { chainId: number; address: Address; symbol: string }) => void
}) {
  const [live, setLive] = useState<{ token: Address; symbol: string } | null>(null)

  const legs = useMemo(
    () => predecessor.holdings.map((h) => ({ address: h.asset as Address, symbol: h.symbol || h.asset.slice(0, 6) })),
    [predecessor.holdings],
  )
  const weights = useMemo(
    () => seedWeightsFromPredecessor(legs, predecessor.holdings.map((h) => ({ asset: h.asset, targetWeightPct: h.targetWeightPct }))),
    [legs, predecessor.holdings],
  )

  // ARMS ITSELF once the successor exists. No button: the user already asked
  // for a new VERSION, so linking it is the thing they asked for, not a second
  // decision to go and find.
  const lineage = useLineageSign({
    predecessor: predecessor.address as Address,
    chainId,
    newToken: live?.token ?? null,
    armed: !!live,
  })

  const chainLabel = (CHAINS[chainId]?.name ?? String(chainId)).replace(/\s*chain$/i, '')
  const sym = showSymbol(predecessor.symbol)

  if (live) {
    const signed = lineage.state === 'done'
    return (
      <div
        className="flex w-full min-w-0 flex-col gap-2 rounded-2xl border p-4"
        style={{ borderColor: signed ? 'color-mix(in srgb, var(--color-teal) 45%, transparent)' : 'rgba(255,255,255,0.12)' }}
      >
        <p className="text-sm font-semibold text-ink">
          ${showSymbol(live.symbol)} is live on {chainLabel}
          {signed ? `, and recorded as the next version of $${sym}.` : '.'}
        </p>
        {!signed && lineage.state === 'signing' && <SpectrumLoader size={22} label="Check your wallet: one signature records the version link." />}
        {lineage.state === 'refused' && (
          <>
            <p className="text-[13px]" style={{ color: 'var(--color-amber)' }}>
              The basket is live, but the version link did not record{lineage.error ? `: ${lineage.error}` : '.'}
            </p>
            <p className="text-[12px] text-ink-faint">It stands as its own basket meanwhile, and nothing is lost by trying again.</p>
            <button
              type="button"
              onClick={lineage.retry}
              className="w-fit rounded-full px-4 py-2 font-display text-[12px] font-bold text-void transition-transform hover:scale-[1.02]"
              style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
            >
              Record the version link
            </button>
          </>
        )}
        {signed && (
          <p className="text-[12px] text-ink-dim">
            Holders of ${sym} can migrate in kind now. Say &ldquo;migrate ${sym} into ${showSymbol(live.symbol)}&rdquo; to move yours.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5 sm:min-w-[var(--chat-card-min,24rem)]">
      <p className="text-[13px] leading-snug text-ink-dim">
        A basket is immutable, so a new version is a fresh deploy recorded as ${sym}&rsquo;s successor, and holders migrate in
        kind when they want to. I have carried across its {legs.length} legs and weights as a starting point, and changing them is
        the point of a version. One signature deploys it, one more records the link.
      </p>
      <DeployCard
        chainId={chainId}
        legs={legs}
        weights={weights}
        initialName={bumpName(predecessor.name || predecessor.symbol)}
        initialSymbol={bumpSymbol(predecessor.symbol)}
        onLive={(token, symbol) => {
          setLive({ token, symbol })
          onDeployed?.({ chainId, address: token, symbol })
        }}
      />
    </div>
  )
}
