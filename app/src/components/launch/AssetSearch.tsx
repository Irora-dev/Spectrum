import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { isAddress } from 'viem'
import { chainCfg, SUPPORTED_CHAIN_IDS } from '../../lib/chain/chains'
import { setActiveChainId } from '../../lib/chain/active-chain'
import { AssetLogo } from '../AssetLogo'
import { searchTokens, type TokenHit } from '../../lib/spectrum/token-search'
import { stocksForChain } from '../../lib/chain/stocks'
import brand from '../../brand.config'
import { stocksEnabled } from '../../theme/brand'
import { coingeckoInfo } from '../../lib/spectrum/token-art'
import { formatUsdCompact, shortAddr } from '../../lib/spectrum/format'

const SPECTRAL = 'linear-gradient(90deg,var(--color-amber),var(--color-magenta),var(--color-cyan))'

function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  )
}

// Type-to-search asset picker for the basket builder: type a name/symbol → a
// dropdown of matching tokens on the active chain (ranked by liquidity); click or
// press Enter to add. Pasting a full 0x address still adds it directly.
export function AssetSearch({
  chainId,
  onPick,
  busy = false,
  excludeAddresses = [],
  compact = false,
}: {
  chainId: number
  onPick: (address: string, symbol?: string) => void
  busy?: boolean
  excludeAddresses?: string[]
  /** Tighter vertical rhythm (the composer's bar) — behavior identical. */
  compact?: boolean
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TokenHit[]>([])
  // Coingecko market-cap rank per address (top hits only, cached lookups) —
  // a strong authenticity signal layered onto rows after they render.
  const [ranks, setRanks] = useState<Record<string, number>>({})
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  // Keyed on the JOINED string, not array identity — the parent passes a fresh
  // array every render, which restarted the search debounce on every unrelated
  // re-render (typing the basket name starved the dropdown; sweep catch).
  const excludeKey = excludeAddresses.map((a) => a.toLowerCase()).sort().join(',')
  const exclude = useMemo(
    () => new Set(excludeKey ? excludeKey.split(',') : []),
    [excludeKey],
  )
  const trimmed = query.trim()
  const looksLikeAddress = isAddress(trimmed)
  const chainLabel = chainCfg(chainId).name
  const canAdd = !busy && trimmed.length > 0
  // The tokenized-stock shelf (owner 2026-07-29): on Robinhood Chain, surface
  // the official registry's stocks before the user types. Surfacing only —
  // findBestPool stays the routability judge, and the builder's thin-pool
  // warnings fire where a stock's depth lives USDG-side (AAPL/TSLA today).
  // The shelf FILTERS by the query rather than vanishing on the first keystroke
  // (sweep catch: typing "AAPL" on Robinhood showed "no matches" while AAPL sat
  // in the app's own curated list — search itself is unindexed there).
  const shelfQ = trimmed.toLowerCase()
  const stockShelf = stocksEnabled(brand) && !looksLikeAddress
    ? stocksForChain(chainId).filter(
        (t) =>
          !exclude.has(t.address.toLowerCase()) &&
          (shelfQ.length === 0 || t.symbol.toLowerCase().includes(shelfQ) || t.name.toLowerCase().includes(shelfQ)),
      )
    : []
  // Known tokenized stocks on ANOTHER chain matching the query (owner report
  // 2026-07-29: typing "nvda" on Base showed nothing while NVDA sits in the
  // app's OWN 4663 registry). The product knows the token — say where it lives
  // and offer the switch. Safe mid-build: drafts persist per chain.
  const crossChainStocks =
    stocksEnabled(brand) && !looksLikeAddress && shelfQ.length >= 2
      ? SUPPORTED_CHAIN_IDS.filter((id) => id !== chainId).flatMap((id) =>
          stocksForChain(id)
            .filter((t) => t.symbol.toLowerCase().includes(shelfQ) || t.name.toLowerCase().includes(shelfQ))
            .map((t) => ({ ...t, chainId: id })),
        )
      : []

  // Debounced search; aborts stale requests so fast typing never races.
  useEffect(() => {
    if (looksLikeAddress || trimmed.length < 2) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    const ctrl = new AbortController()
    const t = window.setTimeout(async () => {
      try {
        const hits = await searchTokens(trimmed, chainId, ctrl.signal)
        setResults(hits.filter((h) => !exclude.has(h.address.toLowerCase())))
        setActive(0)
        // Enrich the top hits with Coingecko's market-cap rank (cached, ~3
        // lookups max — respectful of the keyless rate limit). Non-blocking.
        for (const h of hits.slice(0, 3)) {
          void coingeckoInfo(h.address, chainId).then((info) => {
            if (ctrl.signal.aborted || info?.rank == null) return
            setRanks((r) => (r[`${chainId}:${h.address.toLowerCase()}`] === info.rank ? r : { ...r, [`${chainId}:${h.address.toLowerCase()}`]: info.rank! }))
          })
        }
      } catch {
        /* aborted / failed */
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => {
      ctrl.abort()
      window.clearTimeout(t)
    }
  }, [trimmed, chainId, looksLikeAddress, exclude])

  // Close on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // When the query has NO search hits but DOES match shelf stocks, the shelf is
  // the answer — the absolute "no matches" panel would paint over the very
  // chips its copy points at (verify pass: occluded + unclickable geometry).
  const shelfAnswers = !loading && results.length === 0 && shelfQ.length > 0 && stockShelf.length > 0
  const showDropdown = open && !looksLikeAddress && trimmed.length >= 2 && !shelfAnswers

  const pick = (h: TokenHit) => {
    onPick(h.address, h.symbol)
    setQuery('')
    setResults([])
    setOpen(false)
  }
  const submit = () => {
    if (looksLikeAddress) {
      onPick(trimmed)
      setQuery('')
      setOpen(false)
    } else if (results[active]) {
      pick(results[active])
    }
  }
  const clear = () => {
    setQuery('')
    setResults([])
    inputRef.current?.focus()
  }

  return (
    <div ref={rootRef} className="group relative">
      {/* prismatic focus halo */}
      <div
        aria-hidden
        className={`pointer-events-none absolute -inset-[3px] -z-10 opacity-0 blur-lg transition-opacity duration-300 group-focus-within:opacity-40 ${compact ? 'rounded-[20px]' : 'rounded-[26px]'}`}
        style={{ background: SPECTRAL }}
      />

      {/* search bar */}
      <div
        className={`relative flex items-center overflow-hidden border border-white/15 bg-void/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl transition-colors duration-200 focus-within:border-white/25 ${
          compact ? 'gap-3 rounded-2xl py-1.5 pl-4 pr-2' : 'gap-4 rounded-[22px] py-3 pl-6 pr-3'
        }`}
      >
        {loading ? (
          <span
            aria-hidden
            className={`shrink-0 animate-spin rounded-full border-2 border-cyan/30 border-t-cyan ${compact ? 'h-5 w-5' : 'h-6 w-6'}`}
          />
        ) : (
          <SearchIcon className={`shrink-0 text-ink-faint transition-[color,filter] duration-200 group-focus-within:text-cyan group-focus-within:drop-shadow-[0_0_8px_rgba(53,224,255,0.6)] ${compact ? 'h-5 w-5' : 'h-6 w-6'}`} />
        )}

        <label htmlFor="asset-search" className="sr-only">
          Search a token by name or symbol, or paste a contract address
        </label>
        <input
          id="asset-search"
          ref={inputRef}
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby="asset-help"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
              setActive((i) => Math.min(i + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
          placeholder="Search a token, name, symbol, or paste an address"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          className={`min-w-0 flex-1 bg-transparent font-mono text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-50 ${compact ? 'py-1.5 text-base' : 'py-2 text-lg'}`}
        />

        {query && !busy && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="press grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-faint hover:bg-white/10 hover:text-ink"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}

        <button
          type="button"
          disabled={!canAdd}
          onClick={submit}
          className={`shrink-0 font-display font-bold uppercase tracking-wide transition-[filter,scale] duration-150 active:scale-[0.96] disabled:cursor-not-allowed ${
            compact ? 'rounded-xl px-5 py-2 text-sm' : 'rounded-2xl px-7 py-3 text-base'
          } ${canAdd ? 'text-black hover:brightness-110 hover:saturate-150' : 'bg-white/[0.07] text-ink-faint'}`}
          style={canAdd ? { background: SPECTRAL } : undefined}
        >
          {busy ? 'Checking…' : 'Add'}
        </button>
      </div>

      {showDropdown && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Token search results"
          className="search-pop absolute z-30 mt-2.5 max-h-[26rem] w-full origin-top overflow-auto rounded-2xl border border-white/12 bg-panel/95 p-2 shadow-[0_30px_70px_-15px_rgba(0,0,0,0.8)] backdrop-blur-2xl"
        >
          <li className="flex items-center justify-between px-3 pb-2 pt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
            <span>
              {loading && results.length === 0
                ? `Searching ${chainLabel}…`
                : results.length > 0
                  ? `Tokens on ${chainLabel}`
                  : `No matches on ${chainLabel}`}
            </span>
            {results.length > 0 && <span className="text-ink-faint/70">ETH-paired · by liquidity</span>}
          </li>

          {!loading && results.length === 0 && (
            <li className="px-3 pb-2 font-mono text-xs leading-relaxed text-ink-dim">
              {chainCfg(chainId).dexscreenerSlug
                ? <>Only tokens with an ETH/WETH pool are listed (basket legs route through ETH venues). Paste the token&rsquo;s contract address (0x…) to add it directly.</>
                : <>No token by that name on {chainLabel}. Paste the token&rsquo;s contract address (0x…) to add it directly{stockShelf.length > 0 ? ', or pick from the stocks below' : ''}.</>}
            </li>
          )}

          {/* the query IS a token — on a different network (tokenized stocks) */}
          {!loading && results.length === 0 && crossChainStocks.length > 0 && (
            <>
              <li className="border-t border-white/[0.07] px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                Found on another network
              </li>
              {crossChainStocks.slice(0, 3).map((t) => (
                <li key={`${t.chainId}:${t.address}`}>
                  <button
                    type="button"
                    onClick={() => setActiveChainId(t.chainId)}
                    className="press flex w-full items-center gap-3.5 rounded-xl px-3 py-3 text-left hover:bg-white/[0.06]"
                  >
                    <AssetLogo address={t.address} symbol={t.symbol} chainId={t.chainId} size={38} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="font-display text-base font-bold uppercase tracking-wide text-ink">{t.symbol}</span>
                        <span className="truncate font-mono text-xs text-ink-dim">{t.name}</span>
                      </span>
                      <span className="mt-0.5 block font-mono text-[11px] text-ink-faint">
                        tokenized stock on {chainCfg(t.chainId).name}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-lg bg-cyan/15 px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-cyan">
                      Switch network
                    </span>
                  </button>
                </li>
              ))}
            </>
          )}

          {results.map((h, i) => (
            <li key={h.address} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(h)}
                className={`press flex w-full items-center gap-3.5 rounded-xl px-3 py-3 text-left ${
                  i === active ? 'bg-cyan/10 ring-1 ring-inset ring-cyan/30' : 'hover:bg-white/[0.06]'
                }`}
              >
                <AssetLogo address={h.address} symbol={h.symbol} chainId={chainId} size={38} preferredSrc={h.logoURI} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="font-display text-base font-bold uppercase tracking-wide text-ink">
                      {h.symbol}
                    </span>
                    {!h.verified && (
                      <span
                        title="Not on a canonical token list — check the contract address below against the issuer's own docs. Same-name impostors are cheap to deploy."
                        className="inline-flex shrink-0 translate-y-[1px] items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-amber-200"
                      >
                        Unverified
                      </span>
                    )}
                    {h.verified && (
                      <span
                        title="On a canonical token list (Uniswap Labs / Coingecko), the real address for this symbol"
                        className="inline-flex shrink-0 translate-y-[1px] items-center gap-1 rounded-full border border-cyan/30 bg-cyan/10 px-1.5 py-px font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-cyan"
                      >
                        <svg viewBox="0 0 24 24" className="h-2 w-2" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        Verified
                      </span>
                    )}
                    {h.name && <span className="truncate font-mono text-xs text-ink-dim">{h.name}</span>}
                  </span>
                  {/* Always show the contract address — it's the only fact that
                      distinguishes the real token from a same-name impostor. */}
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-faint">
                    {!chainCfg(chainId).dexscreenerSlug ? 'no liquidity data on this network · ' : ''}
                    {ranks[`${chainId}:${h.address.toLowerCase()}`] != null ? `#${ranks[`${chainId}:${h.address.toLowerCase()}`]} by mcap · ` : ''}
                    {h.marketCapUsd > 0 ? `${formatUsdCompact(h.marketCapUsd)} mcap · ` : ''}
                    {h.liquidityUsd > 0 ? `${formatUsdCompact(h.liquidityUsd)} liquidity · ` : ''}
                    {h.volumeH24Usd > 0 ? `${formatUsdCompact(h.volumeH24Usd)} 24h vol · ` : ''}
                    {shortAddr(h.address)}
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-lg px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wide transition-colors ${
                    i === active ? 'bg-cyan/20 text-cyan' : 'text-ink-faint'
                  }`}
                >
                  {i === active ? 'Add ↵' : 'Add'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ── the tokenized-stock shelf (Robinhood Chain; filters with the query) ── */}
      {stockShelf.length > 0 && (
        <div className={compact ? 'mt-2.5' : 'mt-3.5'}>
          <div className="flex items-baseline gap-2 px-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Tokenized stocks</span>
            <span className="font-mono text-[9px] text-ink-faint">
              issuer-backed tracking tokens · pools trade 24/7, markets do not
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {stockShelf.map((t) => (
              <button
                key={t.address}
                type="button"
                disabled={busy}
                onClick={() => onPick(t.address, t.symbol)}
                title={`${t.name} — add to the basket`}
                className="press inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] py-1 pl-1.5 pr-2.5 hover:border-cyan/50 disabled:opacity-50"
              >
                <AssetLogo address={t.address} symbol={t.symbol} chainId={chainId} size={18} />
                <span className="font-mono text-[11px] font-semibold text-ink">{t.symbol}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
