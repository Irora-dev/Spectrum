import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { Address } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { useActiveChain } from '../lib/chain/active-chain'
import { clientFor } from '../lib/chain/rpc'
import { CROWN_CLAIM_RULE, fetchOwed, leaguePoolAbi } from '../lib/spectrum/league'
import { TRADING_ENABLED } from '../lib/config/features'
import { PixelCrown } from './PixelCrown'
import { InfoDot } from './InfoDot'
import { useNetworkSwitch, WrongNetworkNotice } from './WrongNetwork'

// Crown earnings, withdrawable (owner 2026-07-30: "have we surfaced when crown
// rewards can be claimed on the earn / creator profile page?" — we had not).
//
// The league pays the crown-holder as a LIVE STREAM (contract f71ef4b): flow
// credited while you hold the crown is yours the moment it arrives, so `owed`
// is a REAL BALANCE, not a projection, and `withdraw()` is callable any time.
// There is no season to wait for and no claim window — so this component must
// never render a countdown or the word "claimable at close".
//
// Delivery is a pull by design: credit() never transfers, because USDG can
// freeze an address and a push would let one frozen champion revert every
// basket's league flush chain-wide. The button below IS the withdraw call.

const usd = (raw: bigint) =>
  `$${(Number(raw) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function CrownWinnings({ creator, className = '' }: { creator?: string; className?: string }) {
  const { chainId, cfg } = useActiveChain()
  const { address } = useAccount()
  // The league pays out on the chain it lives on, so that is the network this
  // withdrawal needs. One switch mutation: the Withdraw button performs it (it
  // does double duty while the network is wrong), the shared notice speaks for it
  // (the 2026-08-05 wrong-network consolidation — see WrongNetwork.tsx).
  const netSwitch = useNetworkSwitch(chainId)
  const wrongChain = netSwitch.mismatch
  const pool = cfg.leaguePool
  // Whose earnings: an explicit creator (their profile) else the viewer.
  const subject = (creator ?? address) as Address | undefined
  const isViewer = !!address && !!subject && address.toLowerCase() === subject.toLowerCase()

  const { data: owed } = useQuery({
    queryKey: ['spectrum', 'league-owed', chainId, subject?.toLowerCase()],
    queryFn: () => fetchOwed(clientFor(chainId), pool as Address, subject as Address),
    enabled: !!pool && !!subject,
    // it accrues continuously while they hold the crown, so keep it LIVE for
    // the one person who can act on it — the holder viewing their own page.
    // A VISITOR's copy rides the staleTime floor instead (RPC audit
    // 2026-08-06: this was the only measured standing idle drain — every
    // parked visitor tab on every creator profile ticked a 30s poll to
    // animate someone else's slowly-accruing balance).
    refetchInterval: isViewer ? 30_000 : false,
    staleTime: 15_000,
  })

  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!pool || owed == null || owed === 0n) return null

  async function withdraw() {
    if (!publicClient || busy) return
    // Every other write surface in the app offers a switch instead of letting
    // wagmi surface a raw ChainMismatchError the user can't act on (audit). The
    // switch is OFFERED, never taken: this only runs from the button's own click.
    // A declined switch is acknowledged by the notice below in plain words, so it
    // no longer needs a local error string of its own.
    if (wrongChain) {
      setError(null)
      netSwitch.switchNow()
      return
    }
    setBusy(true)
    setError(null)
    try {
      const hash = await writeContractAsync({
        address: pool as Address,
        abi: leaguePoolAbi,
        functionName: 'withdraw',
        chainId,
      })
      await publicClient.waitForTransactionReceipt({ hash })
      void queryClient.invalidateQueries({ queryKey: ['spectrum', 'league-owed', chainId] })
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : 'Withdraw failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`rounded-2xl border border-amber/30 bg-amber/[0.05] p-5 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <PixelCrown size={20} title="" />
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-amber">
              {/* "unwithdrawn balance", not "earned": owed zeroes on withdraw and
                  this self-hides at 0, so it is not a cumulative total (audit) */}
              {isViewer ? 'Crown earnings to withdraw' : 'Unwithdrawn crown balance'}
            </div>
            <div className="font-num text-2xl font-semibold tabular-nums text-ink">{usd(owed)}</div>
            <div className="font-mono text-[10px] text-ink-faint">
              yours now, no season to wait for
              <InfoDot>{CROWN_CLAIM_RULE}</InfoDot>
            </div>
          </div>
        </div>
        {isViewer && TRADING_ENABLED && (
          <button
            type="button"
            disabled={busy || netSwitch.switching}
            onClick={() => void withdraw()}
            className="press rounded-xl border border-amber/50 bg-amber/15 px-5 py-2.5 font-display text-[12px] font-bold uppercase tracking-[0.12em] text-amber hover:enabled:border-amber disabled:opacity-60"
          >
            {busy
              ? 'Withdrawing…'
              : netSwitch.switching
                ? 'Confirm in wallet…'
                : wrongChain
                  ? `Switch to ${cfg.name}`
                  : 'Withdraw'}
          </button>
        )}
      </div>
      {/* wrong network, in words, naming BOTH networks. The card is a single row,
          so it takes the compact form; the button above is the switch. */}
      {isViewer && TRADING_ENABLED && (
        <WrongNetworkNotice
          sw={netSwitch}
          requiredChainId={chainId}
          action="These earnings pay out"
          compact
          className="mt-2.5"
        />
      )}
      {error && <p className="mt-2 font-mono text-[10px] text-magenta">{error}</p>}
    </section>
  )
}
