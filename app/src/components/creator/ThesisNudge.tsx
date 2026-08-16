import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi'
import type { Address } from 'viem'
import { chainCfg } from '../../lib/chain/chains'
import { clientFor } from '../../lib/chain/rpc'
import type { BasketSummary } from '../../lib/spectrum/basket-data'
import { resolveCreatorMeta } from '../../lib/spectrum/creator-metadata'
import { encodeBasketMetaJson, NOTE_KINDS, notesRegistryAbi } from '../../lib/spectrum/profile-registry'
import { dismissThesisNudge, seededNeedingThesis } from '../../lib/spectrum/unseeded-baskets'
import { chainLabel } from '../thesis/run-lanes'
import { ChainBadge } from '../ChainBadge'
import { showSymbol } from '../../lib/spectrum/safe-copy'

// ─────────────────────────────────────────────────────────────────────────────
// "STILL NEEDS ITS THESIS" (owner 2026-08-15 — the A-to-Z's last hole: close
// the tab after seeding and nothing prompts the words). The recovery banner's
// sibling: seeded baskets this wallet deployed with no thesis get one card per
// ticker — textarea + ON-CHAIN publishing (owner, same day: "it should always
// be onchain publishing so others can see it") — one SpectrumNotes setNote tx
// per basket, the exact mechanism ThesisEditor uses, live for every visitor
// the moment it confirms. Existing on-chain fields are MERGED, never wiped.
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'

export function ThesisNudge() {
  const { address } = useAccount()
  const qc = useQueryClient()
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const { data } = useQuery({
    queryKey: ['thesis-nudge', address],
    queryFn: () => seededNeedingThesis(address as Address),
    enabled: !!address,
    staleTime: 60_000,
    refetchInterval: 120_000,
  })
  const groups = useMemo(() => {
    const m = new Map<string, BasketSummary[]>()
    for (const b of data ?? []) m.set(b.symbol.toUpperCase(), [...(m.get(b.symbol.toUpperCase()) ?? []), b])
    return [...m.entries()]
  }, [data])
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [sign, setSign] = useState<Record<string, { done: number; total: number; error: string | null; on?: string }>>({})
  if (!address || groups.length === 0) return null

  const signAll = async (symbol: string, rows: BasketSummary[]) => {
    const text = (texts[symbol] ?? '').trim()
    if (!text) return
    setSign((st) => ({ ...st, [symbol]: { done: 0, total: rows.length, error: null } }))
    try {
      for (let i = 0; i < rows.length; i++) {
        const b = rows[i]
        const registry = chainCfg(b.chainId).notesRegistry
        if (!registry) throw new Error(`${chainLabel(b.chainId)} has no notes registry configured here — that basket keeps its words unpublished for now`)
        // merge with whatever this basket already carries on-chain — the
        // thesis JOINS the note, it never wipes a tagline written earlier
        setSign((st) => ({ ...st, [symbol]: { ...st[symbol], on: chainLabel(b.chainId) } }))
        const prev = await resolveCreatorMeta(b.address as Address, b.chainId).catch(() => null)
        try {
          await switchChainAsync({ chainId: b.chainId })
        } catch {
          /* already there, or the wallet prompts at signing */
        }
        const h = await writeContractAsync({
          address: registry as Address,
          abi: notesRegistryAbi,
          functionName: 'setNote',
          args: [
            b.address as Address,
            NOTE_KINDS.thesis,
            encodeBasketMetaJson({
              thesis: text,
              tagline: prev?.tagline ?? null,
              sectors: prev?.sectors ?? null,
              timeHorizon: prev?.timeHorizon ?? null,
              postUrl: prev?.postUrl ?? null,
            }),
          ],
          chainId: b.chainId,
        })
        await clientFor(b.chainId).waitForTransactionReceipt({ hash: h })
        setSign((st) => ({ ...st, [symbol]: { ...st[symbol], done: i + 1 } }))
      }
      void qc.invalidateQueries({ queryKey: ['thesis-nudge', address] })
      void qc.invalidateQueries({ queryKey: ['spectrum', 'creatorMeta'] })
    } catch (e) {
      setSign((st) => ({
        ...st,
        [symbol]: { ...st[symbol], error: e instanceof Error ? (e.message.split('\n')[0] ?? 'the transaction was declined') : 'the transaction was declined — your words are kept in the box, try again any time' },
      }))
    }
  }

  return (
    <div className="mt-6 space-y-4">
      {groups.map(([symbol, rows]) => {
        const st = sign[symbol]
        const busy = !!st && st.done < st.total && !st.error
        return (
          <div key={symbol} className="relative overflow-hidden rounded-3xl card-surface p-5">
            <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: SPECTRAL }} />
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan">seeded — still needs its thesis</div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="font-display text-xl font-bold tracking-tight text-ink">{showSymbol(symbol)}</span>
                  <span className="inline-flex items-center gap-1">
                    {rows.map((b) => (
                      <ChainBadge key={b.chainId} chainId={b.chainId} size="sm" />
                    ))}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  dismissThesisNudge(symbol)
                  void qc.invalidateQueries({ queryKey: ['thesis-nudge', address] })
                }}
                title="Dismiss — you can always write it from your creator page"
                aria-label={`Dismiss the thesis reminder for ${showSymbol(symbol)}`}
                className="press shrink-0 rounded-full border border-white/12 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint hover:border-white/30 hover:text-ink"
              >
                later
              </button>
            </div>
            <textarea
              value={texts[symbol] ?? ''}
              onChange={(e) => setTexts((t) => ({ ...t, [symbol]: e.target.value }))}
              rows={3}
              placeholder="Why this mix — published on-chain onto every basket…"
              aria-label={`Thesis for ${showSymbol(symbol)}`}
              className="mt-3 w-full resize-none rounded-xl border border-white/12 bg-black/30 p-3.5 text-[14px] leading-relaxed text-ink outline-none placeholder:text-ink-faint focus:border-white/30"
            />
            {st?.error && <p className="mt-2 font-mono text-[11px] leading-relaxed text-amber-200/90">{st.error}</p>}
            <button
              type="button"
              disabled={!(texts[symbol] ?? '').trim() || busy}
              onClick={() => void signAll(symbol, rows)}
              className="press mt-3 inline-flex h-12 w-full items-center justify-center rounded-xl font-display text-[13px] font-bold uppercase tracking-[0.14em] text-void disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: SPECTRAL }}
            >
              {busy
                ? `publishing on ${st?.on ?? 'its network'} — ${Math.min((st?.done ?? 0) + 1, st?.total ?? 1)} of ${st?.total} · check your wallet…`
                : `Publish onto ${rows.length === 1 ? 'the basket' : `all ${rows.length} baskets`} — one small transaction each · live for everyone`}
            </button>
          </div>
        )
      })}
    </div>
  )
}
