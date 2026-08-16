import { useMemo, useState } from 'react'
import { showSymbol } from '../../lib/spectrum/safe-copy'
import { useQuery } from '@tanstack/react-query'
import { useAccount, useWriteContract } from 'wagmi'
import type { Address } from 'viem'
import { clientFor } from '../../lib/chain/rpc'
import {
  readStandingApprovals,
  rememberApprovalTokens,
  revokeCall,
  watchedApprovalTokens,
  type StandingApproval,
} from '../../lib/spectrum/allowances'
import { chainMeta } from '../ChainBadge'
import { InfoDot } from '../InfoDot'

// ─────────────────────────────────────────────────────────────────────────────
// THE APPROVALS PANEL (the owner ~21:5x: "a revoke system on the portfolio") —
// wallet hygiene as a portfolio surface. Shows what is STANDING on-chain for
// the tokens you hold against the spenders this product knows; one tap
// revokes (approve-to-zero — standard, moves no funds; the wallet still
// confirms). Scope stated in the ⓘ; self-hides when nothing stands and
// nothing failed to read. NO fixture rows ever — a fake standing approval is
// an alarming lie (the depeg law), so the preview identity simply sees
// nothing here.
// ─────────────────────────────────────────────────────────────────────────────

export function ApprovalsPanel({
  owner,
  held,
}: {
  owner: string | undefined
  /** The portfolio's held tokens + basket tokens, per chain. */
  held: { chainId: number; token: Address; symbol: string }[]
}) {
  const { address, isConnected } = useAccount()
  // revokes are REAL txs (fund-free): offered only when the viewer IS the
  // connected owner — never on the preview identity, never on a watched book
  const canRevoke = isConnected && !!address && !!owner && address.toLowerCase() === owner.toLowerCase()

  const heldSig = held.map((h) => `${h.chainId}:${h.token.toLowerCase()}`).sort().join('|')
  const query = useQuery({
    queryKey: ['spectrum', 'approvals', owner?.toLowerCase() ?? '', heldSig],
    enabled: !!owner && held.length > 0,
    staleTime: 60_000,
    retry: 0,
    queryFn: async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      const byChain = new Map<number, { token: Address; symbol: string }[]>()
      for (const h of held) {
        const list = byChain.get(h.chainId) ?? []
        list.push({ token: h.token, symbol: h.symbol })
        byChain.set(h.chainId, list)
      }
      // the zero-balance memory (battle-test half-2 finding 5): a token sold
      // to zero leaves the held read, but an approval that ever stood on it
      // stays spendable — the watch list keeps such tokens in every read
      for (const [chainId, tokens] of byChain) {
        const have = new Set(tokens.map((t) => t.token.toLowerCase()))
        for (const w of watchedApprovalTokens(owner as Address, chainId)) if (!have.has(w.token.toLowerCase())) tokens.push(w)
      }
      const results = await Promise.all(
        [...byChain.entries()].map(async ([chainId, tokens]) => {
          try {
            const res = await readStandingApprovals(clientFor(chainId), chainId, owner as Address, tokens, nowSec)
            rememberApprovalTokens(owner as Address, chainId, res.rows)
            return res
          } catch {
            return { rows: [], failed: tokens.length }
          }
        }),
      )
      return {
        rows: results.flatMap((r) => r.rows),
        failed: results.reduce((s, r) => s + r.failed, 0),
      }
    },
  })

  const { writeContract, isPending } = useWriteContract()
  const [revoking, setRevoking] = useState<string | null>(null)
  const rows = useMemo(() => query.data?.rows ?? [], [query.data])
  const failed = query.data?.failed ?? 0

  // self-hide: nothing standing, nothing unreadable, or nothing to read
  if (!owner || held.length === 0 || (!query.isLoading && rows.length === 0 && failed === 0)) return null

  const rowKey = (r: StandingApproval) => `${r.chainId}:${r.token}:${r.spender.address}:${r.via}`
  const revoke = (r: StandingApproval) => {
    if (!canRevoke) return
    const call = revokeCall(r)
    setRevoking(rowKey(r))
    writeContract(
      { ...call, chainId: r.chainId } as Parameters<typeof writeContract>[0],
      {
        onSettled: () => {
          setRevoking(null)
          void query.refetch()
        },
      },
    )
  }

  return (
    <div className="enter rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-display text-[13px] font-bold uppercase tracking-[0.18em] text-ink-dim">Approvals</h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          {/* scope said on the face (half-2 finding 7): this panel sits under
              a book that may MERGE several linked wallets, and approvals are
              per-wallet state — an unlabeled panel under a merged total reads
              as covering all of them */}
          what can spend from the connected wallet · one wallet, not the merged book
          <InfoDot>
            Live reads of the token allowances standing on-chain for what you hold, checked
            against the spenders this product knows (its own router, Permit2, the limit-order
            relayer, the bridge router). Approvals are per-wallet: this covers the connected
            wallet only, not the other members of a linked group — switch wallets to review
            theirs. Not a chain-wide scanner: an approval you granted some other app to some
            other contract will not appear here. Revoking sets the allowance to zero — a
            normal transaction that moves no funds.
          </InfoDot>
        </span>
      </div>
      {query.isLoading ? (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">reading allowances…</p>
      ) : (
        <>
          {rows.length > 0 && (
            /* CARDS, NOT A TEXT LIST (owner: "make it way prettier") — one
               mini-card per approval in the LP rows' own grammar: identity on
               top, the spender as its quiet middle line, the risk state as a
               colored chip on the shared bottom line beside the action. Two
               per row from sm, so a wallet with six approvals is three calm
               rows instead of a wall. */
            <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
              {rows.map((r) => {
                const busy = isPending && revoking === rowKey(r)
                return (
                  <div key={rowKey(r)} className="flex flex-col rounded-xl border border-white/10 bg-white/[0.02] p-4">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="min-w-0 truncate font-display text-sm font-bold uppercase tracking-wide text-ink">
                        ${showSymbol(r.symbol)}
                      </span>
                      <span
                        className="shrink-0 rounded-full border border-white/12 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em]"
                        style={{ color: chainMeta(r.chainId).color }}
                      >
                        {chainMeta(r.chainId).short}
                      </span>
                      <span
                        className={`ml-auto shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] ${
                          r.infinite ? 'border-magenta/40 bg-magenta/[0.08] text-magenta' : 'border-white/12 text-ink-faint'
                        }`}
                      >
                        {r.infinite ? 'unlimited' : 'exact'}
                      </span>
                    </div>
                    <p className="mt-2 min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                      {r.spender.label} · {r.spender.role}
                      {r.via === 'permit2' && ' · via permit2'}
                    </p>
                    <div className="mt-3 flex items-center justify-between gap-3 pt-1 [margin-top:auto]">
                      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                        {r.expiresAt != null
                          ? `expires ${new Date(r.expiresAt * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
                          : 'no expiry'}
                      </span>
                      {canRevoke && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => revoke(r)}
                          className="press rounded-full border border-white/15 px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim hover:border-magenta/60 hover:text-magenta disabled:opacity-50"
                        >
                          {busy ? 'revoking…' : 'revoke'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {rows.length === 0 && failed > 0 && (
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              nothing standing among what could be read
            </p>
          )}
          {failed > 0 && (
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-300/85">
              {failed} allowance read{failed === 1 ? '' : 's'} couldn&rsquo;t be checked — unreadable is not revoked
            </p>
          )}
        </>
      )}
    </div>
  )
}
