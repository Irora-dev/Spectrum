import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount, useEnsName, usePublicClient, useWriteContract } from 'wagmi'
import { erc20Abi, formatUnits, type Address } from 'viem'
import { chainCfg } from '../lib/chain/chains'
import { clientFor } from '../lib/chain/rpc'
import { NOTE_KINDS, notesRegistryAbi } from '../lib/spectrum/profile-registry'
import {
  APPROVED_REACTIONS,
  encodeReactionJson,
  useBasketReactions,
  type ApprovedReaction,
} from '../lib/spectrum/notes-social'
import { fetchBlockClock, fetchHolderAges, formatAge } from '../lib/spectrum/holder-age'
import { BasketAvatar } from './BasketAvatar'
import { shortAddr } from '../lib/spectrum/format'

// ─────────────────────────────────────────────────────────────────────────────
// The holder wall (owner 2026-07-29): holders sign ONE emoji from the approved
// set onto the basket — no free text, so there is nothing to grief — and the
// wall renders it beside facts the chain proves: how long they've held (last
// 0→positive crossing of their own balance) and how much (LIVE balanceOf,
// re-checked at render; sell out and your entry leaves the wall). Write = one
// setNote tx; reads = topic-pinned logs + the token's own Transfer history.
// Renders nothing until the chain has a notes registry configured.
// ─────────────────────────────────────────────────────────────────────────────

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

interface WallEntry {
  holder: Address
  emoji: ApprovedReaction
  balance: number
  pctOfSupply: number | null
  ageSec: number | null
}

function EntryIdentity({ holder }: { holder: Address }) {
  // Same per-row pattern as the league standings: mainnet ENS, else short addr.
  const { data: ens } = useEnsName({ address: holder, chainId: 1 })
  return <span className="truncate font-mono text-xs font-semibold text-ink">{ens ?? shortAddr(holder)}</span>
}

export function HolderWall({
  basket,
  chainId,
  symbol,
  decimals,
  totalSupply,
}: {
  basket: Address
  chainId: number
  symbol: string
  decimals: number
  /** Whole-token supply (BasketData.totalSupply) — the % denominator. */
  totalSupply: number
}) {
  const cfg = chainCfg(chainId)
  const registry = cfg.notesRegistry
  const { address: viewer } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState<ApprovedReaction | 'clear' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reactions = useBasketReactions(chainId, basket)

  // Live facts for every reactor + the viewer, one batched pass (multicall):
  // balances gate the wall (holders only) and give "how much"; the Transfer
  // scan gives "since when". Ages may be null (capped RPC, no cache yet) —
  // the wall then shows without age chips rather than fabricating.
  const reactors = useMemo(
    () => (reactions.data ?? []).map((r) => r.holder),
    [reactions.data],
  )
  const facts = useQuery({
    // The key hashes the reactor set rather than joining every address (a spam
    // wave otherwise built a ~400KB query key).
    queryKey: [
      'spectrum',
      'wall-facts',
      chainId,
      basket.toLowerCase(),
      reactors.length,
      reactors[0]?.toLowerCase() ?? '',
      reactors[reactors.length - 1]?.toLowerCase() ?? '',
      viewer?.toLowerCase() ?? '',
    ],
    // No reactions ⇒ nothing to age or price: the full Transfer scan must NOT
    // run on every token page just to render an empty wall (audit H5).
    enabled: reactions.data != null && (reactions.data.length > 0 || !!viewer),
    staleTime: 30_000,
    queryFn: async () => {
      const client = clientFor(chainId)
      const who = [...new Set([...reactors, ...(viewer ? [viewer] : [])].map((a) => a.toLowerCase()))] as Address[]
      const [balances, ages, clock] = await Promise.all([
        Promise.all(
          who.map((a) =>
            client
              .readContract({ address: basket, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
              .catch(() => null),
          ),
        ),
        // Ages only matter when someone actually signed; the scan is the
        // expensive read on this page.
        reactors.length > 0 ? fetchHolderAges(client, chainId, basket) : Promise.resolve(null),
        reactors.length > 0 ? fetchBlockClock(client).catch(() => null) : Promise.resolve(null),
      ])
      const balanceOf = new Map<string, number | null>()
      who.forEach((a, i) => {
        const b = balances[i]
        balanceOf.set(a.toLowerCase(), b == null ? null : Number(formatUnits(b, decimals)))
      })
      const ageOf = (addr: string): number | null => {
        if (!ages || !clock) return null
        const hit = ages.get(addr.toLowerCase())
        return hit ? clock.ageOf(hit.sinceBlock) : null
      }
      return { balanceOf, ageOf }
    },
  })

  const entries: WallEntry[] = useMemo(() => {
    if (!reactions.data || !facts.data) return []
    const out: WallEntry[] = []
    for (const r of reactions.data) {
      const bal = facts.data.balanceOf.get(r.holder.toLowerCase())
      if (bal == null || bal <= 0) continue // holders only — sell out, leave the wall
      out.push({
        holder: r.holder,
        emoji: r.emoji,
        balance: bal,
        pctOfSupply: totalSupply > 0 ? (bal / totalSupply) * 100 : null,
        ageSec: facts.data.ageOf(r.holder),
      })
    }
    return out.sort((a, b) => b.balance - a.balance) // conviction first
  }, [reactions.data, facts.data, totalSupply])

  const counts = useMemo(() => {
    const m = new Map<ApprovedReaction, number>()
    for (const e of entries) m.set(e.emoji, (m.get(e.emoji) ?? 0) + 1)
    return m
  }, [entries])

  if (!registry) return null

  const viewerBal = viewer ? facts.data?.balanceOf.get(viewer.toLowerCase()) : null
  const viewerHolds = viewerBal != null && viewerBal > 0
  const mine = viewer ? entries.find((e) => e.holder.toLowerCase() === viewer.toLowerCase())?.emoji ?? null : null

  async function sign(emoji: ApprovedReaction | 'clear') {
    if (!publicClient || busy) return
    setBusy(emoji)
    setError(null)
    try {
      const h = await writeContractAsync({
        address: registry as Address,
        abi: notesRegistryAbi,
        functionName: 'setNote',
        args: [basket, NOTE_KINDS.react, emoji === 'clear' ? '' : encodeReactionJson(emoji)],
        chainId,
      })
      await publicClient.waitForTransactionReceipt({ hash: h })
      void queryClient.invalidateQueries({ queryKey: ['spectrum', 'reactions', chainId] })
    } catch (e) {
      setError(e instanceof Error ? (e.message.split('\n')[0] ?? 'Could not sign.') : 'Could not sign.')
    } finally {
      setBusy(null)
    }
  }

  const shown = entries.slice(0, 24)

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-2xl font-bold uppercase tracking-tight text-ink sm:text-3xl">
          Holder <span className="spectral-text">wall</span>
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          signed on-chain by wallets that hold ${symbol}
        </span>
      </div>

      {/* aggregate: which emojis carry the room */}
      {counts.size > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {APPROVED_REACTIONS.filter((e) => (counts.get(e) ?? 0) > 0).map((e) => (
            <span key={e} className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.03] px-3.5 py-1.5">
              <span className="text-xl leading-none">{e}</span>
              <span className="font-num text-sm font-semibold tabular-nums text-ink-dim">{counts.get(e)}</span>
            </span>
          ))}
        </div>
      )}

      {/* the wall */}
      {reactions.isLoading || (reactions.data != null && facts.isLoading) ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl border border-white/5 bg-white/[0.02]" />
          ))}
        </div>
      ) : shown.length > 0 ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((e) => (
            <div
              key={e.holder}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3"
            >
              <span className="text-2xl leading-none" aria-hidden>
                {e.emoji}
              </span>
              <span className="relative shrink-0 overflow-hidden rounded-lg ring-1 ring-white/15">
                <BasketAvatar address={e.holder} symbol={shortAddr(e.holder)} size={28} />
              </span>
              <span className="min-w-0 flex-1">
                <EntryIdentity holder={e.holder} />
                <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                  {e.ageSec != null && e.ageSec > 60 ? `holding ${formatAge(e.ageSec)} · ` : ''}
                  <span className="tabular-nums text-ink-dim">{compact.format(e.balance)}</span> ${symbol}
                  {e.pctOfSupply != null && e.pctOfSupply >= 0.1 && (
                    <span className="tabular-nums"> · {e.pctOfSupply.toFixed(1)}%</span>
                  )}
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 rounded-xl border border-dashed border-white/10 px-4 py-5 text-center font-mono text-xs text-ink-faint">
          No signatures yet. {viewerHolds ? 'Yours starts the wall.' : `Hold $${symbol} to sign the wall.`}
        </p>
      )}
      {entries.length > shown.length && (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
          and {entries.length - shown.length} more holders
        </p>
      )}

      {/* composer — holders only; one emoji, one signature */}
      {viewerHolds && (
        <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
              {mine ? 'Your signature' : 'Sign the wall'}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {APPROVED_REACTIONS.map((e) => (
                <button
                  key={e}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => (mine === e ? undefined : sign(e))}
                  aria-pressed={mine === e}
                  className={`press grid h-10 w-10 place-items-center rounded-lg border text-xl transition-colors disabled:opacity-50 ${
                    mine === e ? 'border-cyan/60 bg-cyan/15' : 'border-white/10 bg-white/[0.03] hover:border-white/30'
                  }`}
                >
                  {busy === e ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/20 border-t-cyan" /> : e}
                </button>
              ))}
            </div>
            {mine && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => sign('clear')}
                className="press ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:text-magenta disabled:opacity-50"
              >
                {busy === 'clear' ? 'Removing…' : 'Remove'}
              </button>
            )}
          </div>
          {error && <p className="mt-2 font-mono text-[11px] text-magenta">{error}</p>}
        </div>
      )}
    </div>
  )
}
