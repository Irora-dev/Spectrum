import { useEffect, useMemo, useRef, useState } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { createPortal } from 'react-dom'
import { formatUnits, isAddress, type Address } from 'viem'
import { useAccount } from 'wagmi'
import { chainCfg } from '../lib/chain/chains'
import { clientFor } from '../lib/chain/rpc'
import { stocksForChain } from '../lib/chain/stocks'
import brand from '../brand.config'
import { stocksEnabled } from '../theme/brand'
import { erc20BalanceAbi } from '../lib/spectrum/abis-v2'
import { asTokenDecimals, recentPayTokens, type Erc20PayToken } from '../lib/spectrum/pay-token'
import { verifiedTokens } from '../lib/spectrum/token-list'
import { hasFinePointer } from '../lib/wallet/mobile'
import { AssetLogo } from './AssetLogo'

// ─────────────────────────────────────────────────────────────────────────────
// The any-token picker for the swap console's pay side (owner 2026-07-29,
// ease-of-buying batch 2). Sources, cheapest-first:
//   · Recent — tokens this device paid with before (localStorage; the
//     indexer-free stand-in for "your tokens").
//   · The chain's own shelf — tokenized stocks on Robinhood Chain.
//   · The verified token list (Uniswap curated ∪ Coingecko) on Base/Ethereum.
//   · Paste-an-address — the universal path; resolves symbol/decimals on-chain
//     and is labelled unlisted so the buyer knows to check the address.
// Balances load lazily for the visible rows (the batching client folds the
// reads into ~one multicall); held tokens float to the top of the view.
// ─────────────────────────────────────────────────────────────────────────────

const SPECTRAL = 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))'
const VISIBLE_CAP = 50

const erc20MetaAbi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

interface Row {
  address: string
  symbol: string
  name: string
  /** null until resolved on-chain (stock shelf rows carry no decimals). */
  decimals: number | null
  source: 'recent' | 'stock' | 'list'
}

export function PayTokenPicker({
  chainId,
  exclude = [],
  onPick,
  onClose,
}: {
  chainId: number
  /** Addresses that are already first-class choices elsewhere (settlement,
   *  WETH, the selected basket) — offering them again here would only confuse. */
  exclude?: (string | undefined | null)[]
  onPick: (t: Erc20PayToken) => void
  onClose: () => void
}) {
  const { address: viewer } = useAccount()
  const [q, setQ] = useState('')
  const [listRows, setListRows] = useState<Row[]>([])
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map())
  const [decimalsMap, setDecimalsMap] = useState<Map<string, number>>(new Map())
  const [custom, setCustom] = useState<Row | null>(null)
  const [customState, setCustomState] = useState<'idle' | 'loading' | 'unreadable'>('idle')
  const [picking, setPicking] = useState<string | null>(null)
  // Rows whose pick-time decimals() read came back empty, by lowercased address.
  // A Set, not one slot: a second failing row must not silently erase the first
  // row's explanation while the user is still looking at it.
  const [unreadable, setUnreadable] = useState<Set<string>>(new Set())

  const excluded = useMemo(
    () => new Set(exclude.filter(Boolean).map((a) => (a as string).toLowerCase())),
    [exclude],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // ── sources ────────────────────────────────────────────────────────────────
  const recents = useMemo(() => recentPayTokens(chainId), [chainId])
  useEffect(() => {
    let stale = false
    // `stocks: false` means "hide every stock-specific SURFACE" — this picker
    // was the one place that ignored it, so an operator who switched stocks off
    // still got stock rows, badges and the 24/7 disclaimer in the swap console.
    const stocks: Row[] = (stocksEnabled(brand) ? stocksForChain(chainId) : []).map((s) => ({
      address: s.address,
      symbol: s.symbol,
      name: s.name,
      decimals: null,
      source: 'stock' as const,
    }))
    setListRows(stocks)
    void verifiedTokens(chainId).then((list) => {
      if (stale) return
      const seen = new Set(stocks.map((s) => s.address.toLowerCase()))
      const verified: Row[] = []
      for (const t of list) {
        const k = t.address.toLowerCase()
        if (seen.has(k)) continue
        seen.add(k)
        verified.push({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, source: 'list' })
      }
      setListRows([...stocks, ...verified])
    })
    return () => {
      stale = true
    }
  }, [chainId])

  // ── the view (search + exclusions + recents pinned + held-first) ───────────
  const view = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const recentRows: Row[] = recents
      .filter((r) => !excluded.has(r.address.toLowerCase()))
      .map((r) => ({ address: r.address, symbol: r.symbol, name: r.symbol, decimals: r.decimals, source: 'recent' as const }))
    const recentSet = new Set(recentRows.map((r) => r.address.toLowerCase()))
    const rest = listRows.filter(
      (r) => !excluded.has(r.address.toLowerCase()) && !recentSet.has(r.address.toLowerCase()),
    )
    const match = (r: Row) =>
      !needle ||
      r.symbol.toLowerCase().includes(needle) ||
      r.name.toLowerCase().includes(needle) ||
      r.address.toLowerCase() === needle
    const pool = [...recentRows, ...rest].filter(match)
    // Held tokens float up; within held/unheld the source order stays stable
    // (recent → stock shelf → verified list) so the list never jitters.
    const held = (r: Row) => {
      const b = balances.get(r.address.toLowerCase())
      return b != null && b > 0n
    }
    return [...pool.filter(held), ...pool.filter((r) => !held(r))].slice(0, VISIBLE_CAP)
  }, [q, listRows, recents, excluded, balances])

  // ── lazy balances + missing decimals for the visible rows ─────────────────
  const fetchedRef = useRef(new Set<string>())
  // audit #6: a wallet/account switch must invalidate everything fetched — the
  // Set marked rows as done, so the old account's balances (and held-first
  // ordering) survived the switch.
  useEffect(() => {
    fetchedRef.current = new Set()
    setBalances(new Map())
    setDecimalsMap(new Map())
    setUnreadable(new Set()) // a different chain is a different set of contracts
  }, [viewer, chainId])
  useEffect(() => {
    if (!viewer) return
    const client = clientFor(chainId)
    const want = view.filter((r) => !fetchedRef.current.has(r.address.toLowerCase()))
    if (want.length === 0) return
    for (const r of want) fetchedRef.current.add(r.address.toLowerCase())
    let stale = false
    void Promise.all(
      want.map(async (r) => {
        const addr = r.address as Address
        const [bal, dec] = await Promise.all([
          client
            .readContract({ address: addr, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [viewer] })
            .catch(() => null),
          r.decimals == null
            ? client.readContract({ address: addr, abi: erc20MetaAbi, functionName: 'decimals' }).catch(() => null)
            : Promise.resolve(null),
        ])
        return { key: r.address.toLowerCase(), bal, dec }
      }),
    ).then((out) => {
      if (stale) return
      setBalances((m) => {
        const next = new Map(m)
        for (const o of out) if (o.bal != null) next.set(o.key, o.bal as bigint)
        return next
      })
      setDecimalsMap((m) => {
        const next = new Map(m)
        for (const o of out) {
          const d = asTokenDecimals(o.dec)
          if (d != null) next.set(o.key, d)
        }
        return next
      })
    })
    return () => {
      stale = true
    }
  }, [view, viewer, chainId])

  // ── paste-an-address (unlisted tokens stay fully payable) ─────────────────
  const pasted = q.trim()
  const pastedIsAddr = isAddress(pasted)
  const pastedListed = useMemo(
    () =>
      pastedIsAddr &&
      (listRows.some((r) => r.address.toLowerCase() === pasted.toLowerCase()) ||
        recents.some((r) => r.address.toLowerCase() === pasted.toLowerCase())),
    [pastedIsAddr, pasted, listRows, recents],
  )
  useEffect(() => {
    setCustom(null)
    setCustomState('idle')
    if (!pastedIsAddr || pastedListed || excluded.has(pasted.toLowerCase())) return
    let stale = false
    setCustomState('loading')
    const client = clientFor(chainId)
    void Promise.all([
      client.readContract({ address: pasted as Address, abi: erc20MetaAbi, functionName: 'symbol' }),
      client.readContract({ address: pasted as Address, abi: erc20MetaAbi, functionName: 'decimals' }),
    ])
      .then(([sym, dec]) => {
        if (stale) return
        const d = asTokenDecimals(dec)
        if (d == null) {
          // a token claiming absurd decimals is unreadable, not payable (F-2)
          setCustomState('unreadable')
          return
        }
        setCustom({
          address: pasted,
          symbol: String(sym).slice(0, 24),
          name: 'Unlisted token',
          decimals: d,
          source: 'list',
        })
        setCustomState('idle')
      })
      .catch(() => {
        if (!stale) setCustomState('unreadable')
      })
    return () => {
      stale = true
    }
  }, [pasted, pastedIsAddr, pastedListed, excluded, chainId])

  const decimalsOf = (r: Row): number | null => r.decimals ?? decimalsMap.get(r.address.toLowerCase()) ?? null
  const balanceLabel = (r: Row): string | null => {
    const b = balances.get(r.address.toLowerCase())
    const d = decimalsOf(r)
    if (b == null || b === 0n || d == null) return null
    const n = Number(formatUnits(b, d))
    if (!Number.isFinite(n) || n <= 0) return null
    return n >= 10_000
      ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : n.toLocaleString('en-US', { maximumFractionDigits: 4 })
  }

  const pick = async (r: Row) => {
    let d = decimalsOf(r)
    if (d == null) {
      // Stock-shelf rows carry no decimals — one read resolves it at pick time.
      const key = r.address.toLowerCase()
      setUnreadable((s) => {
        if (!s.has(key)) return s
        const next = new Set(s)
        next.delete(key)
        return next
      })
      setPicking(key)
      d = await clientFor(chainId)
        .readContract({ address: r.address as Address, abi: erc20MetaAbi, functionName: 'decimals' })
        .then(asTokenDecimals)
        .catch(() => null)
      setPicking(null)
      // Still no guess — but say so on the row. Bailing out silently cleared the
      // spinner and left the picker exactly as it was, so an RPC hiccup read as
      // a dead button and people tapped it over and over (audit 2026-08-07).
      if (d == null) {
        setUnreadable((s) => new Set(s).add(key))
        return
      }
    }
    onPick({ kind: 'erc20', address: r.address as Address, symbol: r.symbol, decimals: d, chainId })
  }

  const hasStocks = stocksForChain(chainId).length > 0
  const cfg = chainCfg(chainId)

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[12vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-void/85 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Pay with any token"
        onClick={(e) => e.stopPropagation()}
        className="search-pop relative w-full max-w-md overflow-hidden rounded-3xl card-surface backdrop-blur-md"
      >
        <div aria-hidden className="h-1 w-full" style={{ background: SPECTRAL }} />
        <div className="p-4">
          <input
            // desktop only: on touch, autoFocus pops the keyboard over the very
            // list the user opened to browse (mobile UX review 11)
            autoFocus={hasFinePointer()}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a token, or paste an address"
            spellCheck={false}
            className="w-full rounded-xl border border-white/10 bg-void/40 px-3 py-2.5 font-mono text-sm text-ink outline-none placeholder:text-ink-faint focus:border-cyan/50"
          />

          <div className="mt-2 max-h-[46vh] space-y-1 overflow-y-auto pr-1">
            {/* pasted, unlisted token */}
            {customState === 'loading' && (
              <p className="px-2 py-4 text-center font-mono text-[11px] text-ink-faint">Reading token…</p>
            )}
            {customState === 'unreadable' && <UnreadableNote chainName={cfg.name} />}
            {custom && (
              <>
                <TokenRow row={custom} chainId={chainId} balance={balanceLabel(custom)} busy={false} onPick={() => void pick(custom)} />
                <p className="px-2 pb-1 font-mono text-[9px] uppercase leading-relaxed tracking-wider text-amber-200/80">
                  Unlisted token — make sure this is the exact address you mean.
                </p>
              </>
            )}

            {view.length === 0 && !custom && customState === 'idle' && (
              <p className="px-2 py-6 text-center font-mono text-[11px] text-ink-faint">
                {q ? `No tokens match “${q}”.` : 'No tokens to list on this network — paste an address.'}
              </p>
            )}
            {view.map((r) => (
              <div key={r.address}>
                <TokenRow
                  row={r}
                  chainId={chainId}
                  balance={balanceLabel(r)}
                  busy={picking === r.address.toLowerCase()}
                  onPick={() => void pick(r)}
                />
                {unreadable.has(r.address.toLowerCase()) && (
                  <UnreadableNote chainName={cfg.name} className="px-2 pb-1 text-left" />
                )}
              </div>
            ))}
          </div>

          <p className="mt-2 border-t border-white/[0.07] px-1 pt-2 font-mono text-[9px] uppercase leading-relaxed tracking-wider text-ink-faint">
            Any token converts to {cfg.usdcSymbol} through LiFi first; the basket buy itself is unchanged and
            keeps every protection.
            {hasStocks ? ' Stock tokens trade 24/7 — prices can drift from the last market close.' : ''}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** "This contract didn't answer" — defined once so a row whose decimals() read
 *  fails speaks in the same words as a pasted dud address, rather than getting a
 *  second wording invented for the same dead end. */
function UnreadableNote({ chainName, className = 'px-2 py-4 text-center' }: { chainName: string; className?: string }) {
  return (
    <p className={`font-mono text-[11px] text-ink-faint ${className}`}>
      That address doesn&rsquo;t answer as an ERC-20 on {chainName}.
    </p>
  )
}

function TokenRow({
  row,
  chainId,
  balance,
  busy,
  onPick,
}: {
  row: Row
  chainId: number
  balance: string | null
  busy: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onPick}
      className="press flex w-full items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left hover:bg-white/[0.05] disabled:opacity-60"
    >
      <AssetLogo address={row.address} symbol={row.symbol} chainId={chainId} size={32} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-display text-sm font-semibold text-ink">{showSymbol(row.symbol)}</span>
          {row.source === 'recent' && (
            <span className="rounded-md border border-white/10 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-ink-faint">
              recent
            </span>
          )}
          {row.source === 'stock' && (
            <span className="rounded-md border border-cyan/25 bg-cyan/[0.06] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-cyan/90">
              stock
            </span>
          )}
        </span>
        <span className="block truncate font-mono text-[10px] text-ink-faint">{row.name}</span>
      </span>
      {busy ? (
        <span className="animate-pulse font-mono text-[10px] text-ink-faint">…</span>
      ) : (
        balance && <span className="font-num text-sm tabular-nums text-ink-dim">{balance}</span>
      )}
    </button>
  )
}
