import { useEffect, useMemo, useRef, useState } from 'react'
import { showSymbol } from '../lib/spectrum/safe-copy'
import { createPortal } from 'react-dom'
import { SUPPORTED_CHAIN_IDS } from '../lib/chain/chains'
import { searchTokens, type TokenHit } from '../lib/spectrum/token-search'
import { assetKey, type AllocAsset } from '../lib/spectrum/allocation'
import { formatUsdCompact } from '../lib/spectrum/format'
import { demoCatalog } from './allocate/PortfolioFlow'
import { useDismissOnBack } from '../lib/use-dismiss-on-back'
import { AssetLogo } from './AssetLogo'
import { ChainBadge } from './ChainBadge'
import { CopyAddress } from './CopyAddress'

// ─────────────────────────────────────────────────────────────────────────────
// The on-page asset finder (owner 11:26: "the pop up of the search system …
// adds it into this actual weighting area so you don't have to leave the
// page"). Same search doctrine as the flow's picker: every network asked at
// once, same symbol merged on DEEPEST REAL LIQUIDITY (the no-chain-specifics
// law — the chain rides along as a label, never a control). A search that
// FAILED stays a retry, never a verdict.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  onPick: (asset: AllocAsset) => void
  onClose: () => void
  /** Keys (`chainId:address`) already in the allocation — shown, not pickable. */
  takenKeys: Set<string>
  full: boolean
  /** Stacking context — a host that is itself a fixed layer above z-50 (the
   *  thesis reshape modal) passes its own so the search paints over it. */
  zIndex?: number
}

const CHAIN_LABELS: Record<number, string> = { 8453: 'Base', 1: 'Ethereum', 4663: 'Robinhood' }

export function AssetSearchModal({ onPick, onClose, takenKeys, full, zIndex = 50 }: Props) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<AllocAsset[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  // the flow's own network pills (owner 15:00: "taken from the other flow")
  const [chainFilter, setChainFilter] = useState<number | 'all'>('all')
  // the flow's example catalog = the trending shelf when the query is empty
  const trending = useMemo(
    () => demoCatalog().filter((a) => chainFilter === 'all' || a.chainId === chainFilter),
    [chainFilter],
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // The back gesture closes the picker instead of leaving the page you were
  // weighting (QOL round 2026-08-05 #7: "on mobile that's the instinct, and it
  // currently navigates away from the page entirely"). This modal is mounted
  // only while it is open, so it is open for its whole life — hence the literal
  // true. First site to fly the shared hook; the rest follow after review.
  useDismissOnBack(true, onClose)

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      // focus trap: Tab cycles inside the dialog (PM review)
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      opener?.focus?.()
    }
  }, [onClose])

  useEffect(() => {
    const needle = q.trim()
    if (needle.length < 2) {
      setHits([])
      setBusy(false)
      setFailed(false)
      return
    }
    let stale = false
    setBusy(true)
    setFailed(false)
    const searchChains = chainFilter === 'all' ? SUPPORTED_CHAIN_IDS : [chainFilter]
    const t = window.setTimeout(() => {
      Promise.all(
        searchChains.map((chainId) =>
          searchTokens(needle, chainId)
            .then((rows: TokenHit[]) => rows.map((h) => ({ h, chainId })))
            .catch(() => null),
        ),
      )
        .then((all) => {
          if (stale) return
          // every chain errored → an unreadable answer, never "no results"
          if (all.every((r) => r === null)) {
            setFailed(true)
            setHits([])
            return
          }
          const bySym = new Map<string, { h: TokenHit; chainId: number }>()
          for (const row of all.filter(Boolean).flat() as { h: TokenHit; chainId: number }[]) {
            const k = row.h.symbol.toUpperCase()
            const prev = bySym.get(k)
            if (!prev || row.h.liquidityUsd > prev.h.liquidityUsd) bySym.set(k, row)
          }
          setHits(
            [...bySym.values()]
              .sort((a, b) => b.h.liquidityUsd - a.h.liquidityUsd)
              .slice(0, 10)
              .map(({ h, chainId }) => ({ chainId, address: h.address, symbol: h.symbol, depthUsd: h.liquidityUsd })),
          )
        })
        .finally(() => {
          if (!stale) setBusy(false)
        })
    }, 300)
    return () => {
      stale = true
      window.clearTimeout(t)
    }
  }, [q, chainFilter])

  // PORTALED to body (PM review): Yours' breakout wrapper carries a transform,
  // and a transformed ancestor becomes the containing block for fixed
  // descendants — inset-0 would span the PAGE column, centering the dialog at
  // half the page height instead of the viewport (same trap class InfoDot
  // already solved).
  return createPortal(
    /* wider on desktop; a tall bottom sheet on mobile (owner 15:00 — the full
       mobile sweep is its own coming round) */
    <div className="fixed inset-0 grid items-end justify-items-center p-0 sm:place-items-center sm:p-4" style={{ zIndex }} role="dialog" aria-modal="true" aria-label="Add an asset">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        ref={dialogRef}
        className="relative flex max-h-[88svh] w-full flex-col rounded-t-[1.75rem] border border-white/12 bg-panel p-6 shadow-[0_32px_96px_-32px_rgba(0,0,0,0.9)] sm:max-w-[640px] sm:rounded-[1.75rem]"
      >
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-base font-bold uppercase tracking-[0.08em] text-ink">Add an asset</h2>
          <button
            type="button"
            onClick={onClose}
            className="press grid h-8 w-8 place-items-center rounded-full border border-white/15 text-ink-dim hover:border-white/40 hover:text-ink"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search any token · name or symbol"
          className="mt-4 h-12 w-full rounded-xl border border-white/15 bg-white/[0.04] px-4 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-cyan/60 focus:outline-none"
        />
        {/* the flow's network pills */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(['all', ...SUPPORTED_CHAIN_IDS] as const).map((c) => (
            <button
              key={String(c)}
              type="button"
              aria-pressed={chainFilter === c}
              onClick={() => setChainFilter(c as number | 'all')}
              className={`press rounded-full border px-3.5 py-1.5 font-mono text-[10px] uppercase tracking-wide ${
                chainFilter === c ? 'border-cyan/60 bg-cyan/[0.1] text-ink' : 'border-white/15 text-ink-dim hover:border-white/35'
              }`}
            >
              {c === 'all' ? 'All' : CHAIN_LABELS[c as number] ?? String(c)}
            </button>
          ))}
        </div>
        <div className="mt-3 min-h-[280px] flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
          {q.trim().length < 2 ? (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">Trending · examples from the create flow</p>
              <ul className="mt-2 space-y-1">
                {trending.map((a) => {
                  const key = assetKey(a)
                  const taken = takenKeys.has(key)
                  const disabled = taken || full
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onPick(a)}
                        className="press flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left transition-colors hover:enabled:bg-white/[0.05] disabled:opacity-45"
                      >
                        <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={24} />
                        <span className="min-w-0 flex-1 truncate font-display text-sm font-bold text-ink">${showSymbol(a.symbol)}</span>
                        <ChainBadge chainId={a.chainId} />
                        <span className="w-14 shrink-0 text-right font-mono text-[9px] uppercase tracking-wide text-ink-faint">
                          {taken ? 'added' : full ? 'full' : 'add →'}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
              <p className="mt-3 text-center font-mono text-[10px] uppercase tracking-widest text-ink-faint">
                or type two letters to search every network
              </p>
            </div>
          ) : failed ? (
            <p className="pt-4 text-center font-mono text-[11px] uppercase tracking-widest text-amber-300/85">
              search couldn’t reach the markets; try again
            </p>
          ) : busy && hits.length === 0 ? (
            <p className="pt-4 text-center font-mono text-[11px] uppercase tracking-widest text-ink-faint" role="status">
              searching…
            </p>
          ) : hits.length === 0 ? (
            <p className="pt-4 text-center font-mono text-[11px] uppercase tracking-widest text-ink-faint">no routable market found</p>
          ) : (
            <ul className="space-y-1">
              {hits.map((a) => {
                const key = `${a.chainId}:${a.address.toLowerCase()}`
                const taken = takenKeys.has(key)
                const disabled = taken || (full && !taken)
                return (
                  <li key={key} className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onPick(a)}
                      className="press flex h-12 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 text-left transition-colors hover:enabled:bg-white/[0.05] disabled:opacity-45"
                    >
                      <AssetLogo address={a.address} symbol={a.symbol} chainId={a.chainId} size={24} />
                      <span className="min-w-0 flex-1 truncate font-display text-sm font-bold text-ink">${showSymbol(a.symbol)}</span>
                      <ChainBadge chainId={a.chainId} />
                      <span className="w-20 shrink-0 text-right font-num text-xs tabular-nums text-ink-dim sm:w-16">
                        {a.depthUsd != null ? formatUsdCompact(a.depthUsd) : '—'}
                      </span>
                      <span className="w-14 shrink-0 text-right font-mono text-[9px] uppercase tracking-wide text-ink-faint">
                        {taken ? 'added' : full ? 'full' : 'add →'}
                      </span>
                    </button>
                    {/* the contract behind the ticker, copyable without leaving
                        the search (QOL round 2026-08-05 #6). This list merges the
                        same symbol across networks on deepest liquidity, so the
                        address is how you tell the market you meant from a clone
                        wearing its ticker. Deliberately OUTSIDE the pick button:
                        a button inside a button is invalid, and the address is
                        worth checking on a row that is already added or full.
                        Hidden on the narrowest screens, where the row has no
                        width left to give and the ticker would lose it. */}
                    <span className="hidden shrink-0 sm:block">
                      <CopyAddress address={a.address} what={`${showSymbol(a.symbol)} address`} size="xs" />
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <p className="mt-3 border-t border-white/8 pt-3 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint">
          deepest real liquidity picks the network · depth shown per pick
        </p>
      </div>
    </div>,
    document.body,
  )
}
