// In-chat REDEEM IN KIND (owner 2026-08-20 round): the unconditional exit as
// a chat card — burn shares, receive every leg pro-rata, touching no pool.
// This is the site's FIRST standalone redeem surface: until now the exit
// lived only inside the migrate flow and the MCP, while every docs page
// cited it. Call shape and discipline are the migrate flow's own, verbatim:
// simulate redeemInKind(shares, all-true mask, holder) first, then sign,
// then wait for the receipt.
import { useEffect, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { formatUnits, parseUnits, type Address } from 'viem'
import { basketAbi, erc20BalanceAbi } from '../../lib/spectrum/abis-v2'
import type { BasketData } from '../../lib/spectrum/basket-data'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { CHAINS } from '../../lib/chain/chains'
import { cheerSpecter } from './CopyRow'
import { playSfx } from './sfx'

const GRADIENT = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

export function RedeemCard({ chainId, data }: { chainId: number; data: BasketData }) {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const [balanceRaw, setBalanceRaw] = useState<bigint | null>(null)
  const [shares, setShares] = useState('')
  const [state, setState] = useState<'idle' | 'signing' | 'confirming' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [doneHash, setDoneHash] = useState<string | null>(null)
  const chainLabel = CHAINS[chainId]?.name ?? chainId

  // the holder's real balance seeds the input: "get me out" defaults to ALL
  useEffect(() => {
    let alive = true
    if (!address || !publicClient) {
      setBalanceRaw(null)
      return
    }
    void publicClient
      .readContract({ address: data.address as Address, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [address] })
      .then((v) => {
        if (!alive) return
        const raw = v as bigint
        setBalanceRaw(raw)
        if (raw > 0n) setShares(formatUnits(raw, 18))
      })
      .catch(() => {
        if (alive) setBalanceRaw(null)
      })
    return () => {
      alive = false
    }
  }, [address, publicClient, data.address])

  const sharesRaw = (() => {
    try {
      const v = parseUnits(shares.trim() || '0', 18)
      return v > 0n ? v : null
    } catch {
      return null
    }
  })()
  const overBalance = sharesRaw != null && balanceRaw != null && sharesRaw > balanceRaw

  async function redeem() {
    if (!address || !publicClient || sharesRaw == null || state === 'signing' || state === 'confirming') return
    setError(null)
    setState('signing')
    try {
      // every leg comes home: the mask is all-true (a partial mask is a
      // different product decision the chat must not make silently — the
      // MCP's own law on the same call)
      const mask = data.holdings.map(() => true)
      await publicClient.simulateContract({
        account: address,
        address: data.address as Address,
        abi: basketAbi,
        functionName: 'redeemInKind',
        args: [sharesRaw, mask, address],
      })
      const hash = await writeContractAsync({
        address: data.address as Address,
        abi: basketAbi,
        functionName: 'redeemInKind',
        args: [sharesRaw, mask, address],
        chainId,
      })
      setState('confirming')
      await publicClient.waitForTransactionReceipt({ hash })
      setDoneHash(hash)
      setState('done')
      cheerSpecter()
      playSfx('happy', 0.3)
    } catch (e) {
      setError(e instanceof Error ? ('shortMessage' in e && typeof e.shortMessage === 'string' ? e.shortMessage : e.message.split('\n')[0]) : String(e))
      setState('idle')
    }
  }

  if (state === 'done') {
    return (
      <div className="flex w-full min-w-0 flex-col gap-2 rounded-2xl border p-4" style={{ borderColor: 'color-mix(in srgb, var(--color-teal) 45%, transparent)' }}>
        <p className="text-sm font-semibold text-ink">
          Redeemed. {data.holdings.length} assets landed in your wallet, pro-rata, straight from ${showSymbol(data.symbol)}.
        </p>
        <p className="text-[12px] text-ink-dim">The receipt is the transaction itself. Ask &ldquo;what do I hold?&rdquo; for the fresh picture.</p>
        {doneHash && <p className="truncate font-mono text-[10px] text-ink-faint">{doneHash}</p>}
      </div>
    )
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2">
        <span className="min-w-0 truncate text-[13px] text-ink">
          ${showSymbol(data.symbol)} → {data.holdings.length} assets, pro-rata
        </span>
        <span className="shrink-0 font-mono text-[11px] text-ink-dim">
          {balanceRaw != null ? `you hold ${Number(formatUnits(balanceRaw, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })}` : 'balance unread'}
        </span>
      </div>
      <input
        type="text"
        inputMode="decimal"
        value={shares}
        onChange={(e) => setShares(e.target.value)}
        placeholder="shares to redeem"
        aria-label="Shares to redeem"
        className="w-full rounded-xl border border-white/[0.14] bg-white/[0.05] px-3 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-white/[0.3]"
      />
      {state === 'signing' && <p className="text-[13px] text-ink-dim">Check your wallet to sign. One signature, no approval needed: the shares are yours to burn.</p>}
      {state === 'confirming' && <p className="text-[13px] text-ink-dim">On its way. The chain confirms in a moment.</p>}
      {error && <p className="text-[13px]" style={{ color: 'var(--color-alert)' }}>{error}</p>}
      {overBalance && <p className="text-[12px] text-ink-faint">That is more than you hold.</p>}
      {/* buttons BELOW the info, always */}
      <button
        type="button"
        disabled={!isConnected || sharesRaw == null || overBalance || state !== 'idle'}
        onClick={() => void redeem()}
        className="w-fit rounded-full px-5 py-2.5 font-display text-[13px] font-bold text-void transition-transform enabled:hover:scale-[1.02] disabled:opacity-40"
        style={{ background: GRADIENT }}
      >
        {state === 'idle' ? `Redeem on ${chainLabel}, your wallet signs` : 'Working…'}
      </button>
      {!isConnected && <p className="text-[12px] text-ink-faint">Connect a wallet (top right) to redeem.</p>}
    </div>
  )
}
