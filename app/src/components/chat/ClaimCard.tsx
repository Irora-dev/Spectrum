// IN-CHAT FEE CLAIM (owner 2026-08-21, the one-button audit: claiming was the
// ONE money action with no card at all — the chat read your accrued fees off the
// contracts and then handed you a link out to the flush console to actually take
// them).
//
// One button claims every accrual on this chain. The sequencing, the
// simulate-before-every-prompt guard and the re-entrancy lock all live in
// useClaimAll, the same hook the portfolio's claims panel runs on — this card
// adds no money logic of its own, it only collects the items the chat already
// read and narrates the run in the thread's language.
//
// Boundary note: components/chat is unclassified by the portfolio/basket import
// guard, so this import adds no cross-boundary edge and the split's ratchet is
// untouched (verified against import-boundary.guard.test.ts).
import { useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import type { Address } from 'viem'
import { useClaimAll, type ClaimAllItem } from '../../lib/spectrum/use-fee-actions'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { CHAINS } from '../../lib/chain/chains'
import { useNetworkSwitch } from '../WrongNetwork'
import { SpectrumLoader } from '../SpectrumLoader'
import { CopyRow, cheerSpecter } from './CopyRow'
import { playSfx } from './sfx'

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

export interface ClaimRow {
  address: Address
  symbol: string
  pendingUsd: number
}

export function ClaimCard({
  chainId,
  rows,
  totalUsd,
  refLink,
}: {
  chainId: number
  rows: ClaimRow[]
  totalUsd: number
  /** the caller's referral link, so the card that pays them also helps them
   *  earn the next one (offered as a copy row, never a rival button) */
  refLink?: string | null
}) {
  const { isConnected, chainId: walletChainId } = useAccount()
  const sw = useNetworkSwitch(chainId)
  const { claimAll, running, total, done, failed, skippedOtherChain, error } = useClaimAll()
  const [fired, setFired] = useState(false)

  const items = useMemo<ClaimAllItem[]>(
    () => rows.map((r) => ({ address: r.address, chainId, kind: 'flush' as const })),
    [rows, chainId],
  )
  const chainLabel = (CHAINS[chainId]?.name ?? String(chainId)).replace(/\s*chain$/i, '')
  const wrongChain = isConnected && walletChainId !== chainId
  const settled = fired && !running && total > 0
  const allDone = settled && failed === 0

  if (allDone) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-2 rounded-2xl border p-4" style={{ borderColor: 'color-mix(in srgb, var(--color-teal) 45%, transparent)' }}>
        <p className="text-sm font-semibold text-ink">
          Claimed ${totalUsd.toFixed(2)} across {done} basket{done === 1 ? '' : 's'} on {chainLabel}.
        </p>
        <p className="text-[12px] text-ink-dim">It is in your wallet as settlement, not a balance on this site. Accruals build again with every trade.</p>
        {refLink && <CopyRow url={refLink} />}
      </div>
    )
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5 sm:min-w-[var(--chat-card-min,24rem)]">
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <div key={r.address} className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-display text-[13px] font-bold text-ink">${showSymbol(r.symbol)}</span>
            <span className="font-mono text-[12px] tabular-nums text-ink">${r.pendingUsd.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <p className="text-[13px] leading-snug text-ink-dim">
        ${totalUsd.toFixed(2)} accrued across {rows.length} basket{rows.length === 1 ? '' : 's'}. One press claims all of them, one
        signature each, and each is simulated before your wallet is asked.
      </p>
      {running && (
        <SpectrumLoader size={22} label={`Claiming ${done + 1} of ${total}. Check your wallet.`} />
      )}
      {settled && failed > 0 && (
        <p className="text-[13px]" style={{ color: 'var(--color-amber)' }}>
          {done} claimed, {failed} did not go through. The ones that failed are still accrued, so pressing again picks
          up exactly those.
        </p>
      )}
      {error && <p className="text-[13px]" style={{ color: 'var(--color-alert)' }}>{error}</p>}
      {skippedOtherChain > 0 && (
        <p className="text-[12px] text-ink-faint">{skippedOtherChain} accrual(s) live on another network. Switch there and ask again.</p>
      )}
      {/* buttons BELOW the info, always — and ONE of them */}
      <div className="flex flex-wrap items-center gap-2.5">
        {wrongChain ? (
          <button
            type="button"
            disabled={sw.switching}
            onClick={sw.switchNow}
            className="rounded-full px-5 py-2.5 font-display text-[13px] font-bold text-void transition-transform enabled:hover:scale-[1.02] disabled:opacity-50"
            style={{ background: GRADIENT }}
          >
            {sw.switching ? 'Check your wallet…' : `Switch wallet to ${chainLabel}`}
          </button>
        ) : (
          <button
            type="button"
            disabled={!isConnected || running || rows.length === 0}
            onClick={() => {
              setFired(true)
              void claimAll(items).then(() => {
                cheerSpecter()
                playSfx('happy', 0.3)
              })
            }}
            className="rounded-full px-5 py-2.5 font-display text-[13px] font-bold text-void transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
            style={{ background: GRADIENT }}
          >
            {running ? 'Claiming…' : settled && failed > 0 ? 'Claim the rest' : `Claim $${totalUsd.toFixed(2)}`}
          </button>
        )}
      </div>
      {!isConnected && <p className="text-[12px] text-ink-faint">Connect a wallet (top right) to claim.</p>}
      {sw.declined && <p className="text-[12px] text-ink-faint">Your wallet declined the switch.</p>}
    </div>
  )
}
