import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { setActiveChainId, useActiveChain } from '../lib/chain/active-chain'
import { CHAINS, SUPPORTED_CHAIN_IDS, chainCfg } from '../lib/chain/chains'
import { fetchAssetHistory, type ChartRange } from '../lib/spectrum/history'
import { useAllBaskets } from '../lib/spectrum/hooks'
import { formatNav, formatPct, formatPrice, formatUsdCompact } from '../lib/spectrum/format'
import { tokenVisual } from '../lib/spectrum/token-meta'
import { BasketBuilder, resolveAsset, seedLaunchDraft, type BuilderAsset } from '../components/launch/BasketBuilder'
import { AssetSearch } from '../components/launch/AssetSearch'
import { PopularAssets } from '../components/launch/PopularAssets'
import { AssetLogo } from '../components/AssetLogo'
import { PageHeader } from '../components/PageHeader'
import { COMPOSER_TEMPLATES, resolveCuratedSymbols, type CuratedSet } from '../lib/spectrum/curated-tokens'

// ─────────────────────────────────────────────────────────────────────────────
// THE COMPOSER (/compose) — owner + R session 2026-07-07 17:19, tightened to
// the owner's 17:32 live test: composition FIRST (full launch-bar search:
// AssetSearch + PopularAssets — paste, ranks, the lot), the backtest below
// with Split ON by default from two assets, the blend priced AS A TOKEN
// ("started at $1.00 → $1.24"), forecast steppers matching the composition,
// spectral gradient dress on every card.
//
// Honesty rails (§9): the backtest is a weighted replay of real price history,
// labelled; the forecast is user-authored hypothesis, labelled louder. The
// money path stays single: Launch = seeding the builder's own draft.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ASSETS = 8
const RANGES: ChartRange[] = ['7D', '30D', 'ALL']

/** Map a deep-link `?chain=` value (name or numeric id) to a SUPPORTED chainId,
 *  or null. A basket is single-chain (one V2 factory per chain), so an inbound
 *  create link must name its chain. */
function parseChainParam(v: string | null): number | null {
  if (!v) return null
  const named: Record<string, number> = { eth: 1, ethereum: 1, mainnet: 1, base: 8453 }
  const id = named[v.trim().toLowerCase()] ?? Number(v)
  return Number.isInteger(id) && (SUPPORTED_CHAIN_IDS as readonly number[]).includes(id) ? id : null
}

interface ComposedAsset extends BuilderAsset {
  color: string
}

// spectral p-px dress (the auction-canvas idiom) — subtle, not neon
const CARD_GRAD = 'linear-gradient(135deg, rgba(53,224,255,0.35), rgba(164,139,255,0.18) 45%, rgba(255,77,184,0.28))'

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="rounded-3xl p-px" style={{ background: CARD_GRAD }}>
      <section className={`rounded-[calc(var(--radius-3xl)_-_1px)] bg-panel/92 backdrop-blur-md ${className}`}>{children}</section>
    </div>
  )
}

// ── weights: keep Σ=100, min 1, redistribute proportionally ────────────────
function rebalanceOthers(weights: number[], changed: number, next: number): number[] {
  const n = weights.length
  if (n === 1) return [100]
  const target = Math.min(100 - (n - 1), Math.max(1, Math.round(next)))
  const othersSum = weights.reduce((s, w, i) => (i === changed ? s : s + w), 0)
  const room = 100 - target
  const out = weights.map((w, i) => {
    if (i === changed) return target
    return othersSum > 0 ? Math.max(1, Math.round((w / othersSum) * room)) : Math.max(1, Math.round(room / (n - 1)))
  })
  let drift = 100 - out.reduce((s, w) => s + w, 0)
  while (drift !== 0) {
    let idx = -1
    let best = -1
    out.forEach((w, i) => {
      if (i !== changed && ((drift > 0 && w >= best) || (drift < 0 && w > 1 && (idx === -1 || w > out[idx])))) {
        best = w
        idx = i
      }
    })
    if (idx === -1) idx = changed
    out[idx] += drift > 0 ? 1 : -1
    drift += drift > 0 ? -1 : 1
  }
  return out
}

function equalWeights(n: number): number[] {
  const base = Math.floor(100 / n)
  const out = Array(n).fill(base)
  out[0] += 100 - base * n
  return out
}

// ── the forecast model (owner 17:53): dated price points ────────────────────
// "By this date I think this token will be at this price" — several dates per
// token if you like. The scenario path replays them through the mix; assets
// without a point hold flat. Hypothesis, never a prediction (§9).
interface ForecastPoint {
  id: string
  /** yyyy-mm-dd — the native date input's value */
  date: string
  /** target USD price, free-typed */
  price: string
}

let pointSeq = 0
const nextPointId = () => `fp${++pointSeq}`

const DAY_MS = 86_400_000
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const dateToUnix = (d: string): number | null => {
  const t = Date.parse(`${d}T00:00:00Z`)
  return Number.isFinite(t) ? t / 1000 : null
}

// Full-decimal price → input string (4 sig figs, never scientific notation —
// micro-caps must round-trip through the input unmangled).
function priceToInput(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return ''
  if (p >= 1) return p.toFixed(2)
  const m = p.toFixed(20).match(/^0\.(0*)([1-9]\d{0,3})/)
  return m ? `0.${m[1]}${m[2]}`.replace(/0+$/, '').replace(/\.$/, '') : String(p)
}

const shortMonthDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })

// ── natural-language forecast entry (owner 19:15: "just have a natural language
// search bar with suggestions — I think syrup will be this price on this date") ──
// Parse "SYRUP to $0.50 by Aug 30" into {asset, price, date}. Price must be
// $-prefixed or keyword-led (to/at/be/hit/reach/worth) so a bare number is never
// mistaken for the day; date handles ISO, "in N days/weeks/months", and
// "<month> <day> [year]" (a past day with no year rolls to next year).
const NL_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function parseDatePhrase(s: string, nowMs: number): string | null {
  const t = s.toLowerCase()
  const iso = t.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/)
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]))
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
  }
  const rel = t.match(/in\s+(\d+)\s*(day|week|month|year)/)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const mult = rel[2][0] === 'd' ? 1 : rel[2][0] === 'w' ? 7 : rel[2][0] === 'm' ? 30 : 365
    return isoDay(nowMs + n * mult * DAY_MS)
  }
  const mi = NL_MONTHS.findIndex((m) => t.includes(m))
  if (mi >= 0) {
    const day = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/)
    const yr = t.match(/\b(20\d{2})\b/)
    if (day) {
      const dd = parseInt(day[1], 10)
      if (dd < 1 || dd > 31) return null
      let year = yr ? parseInt(yr[1], 10) : new Date(nowMs).getUTCFullYear()
      if (!yr && Date.UTC(year, mi, dd) < nowMs) year += 1
      const dt = new Date(Date.UTC(year, mi, dd))
      return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10)
    }
  }
  return null
}

interface ParsedForecast {
  addr: string | null
  symbol: string | null
  price: number | null
  dateISO: string | null
}

function parseForecastEntry(text: string, assets: ComposedAsset[], nowMs: number): ParsedForecast {
  let work = ` ${text.toLowerCase()} `
  let addr: string | null = null
  let symbol: string | null = null
  for (const a of assets) {
    const re = new RegExp(`\\b${a.symbol.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    if (re.test(work)) {
      addr = a.address.toLowerCase()
      symbol = a.symbol
      work = work.replace(re, ' ')
      break
    }
  }
  let price: number | null = null
  const dollar = work.match(/\$\s*([0-9]*\.?[0-9]+)/)
  if (dollar) {
    price = parseFloat(dollar[1])
    work = work.replace(dollar[0], ' ')
  } else {
    const kw = work.match(/(?:to|at|be|hit|reach|worth)\s+\$?\s*([0-9]*\.?[0-9]+)/)
    if (kw) {
      price = parseFloat(kw[1])
      work = work.replace(kw[0], ' ')
    }
  }
  if (price != null && (!Number.isFinite(price) || price <= 0)) price = null
  // date parses from the REMAINDER (price already stripped, so its digits can't
  // be misread as the day).
  const dateISO = parseDatePhrase(work, nowMs)
  return { addr, symbol, price, dateISO }
}

function Stepper({ onStep, label }: { onStep: (d: number) => void; label: string }) {
  return (
    <>
      <button
        type="button"
        onClick={() => onStep(-5)}
        className="press grid h-7 w-7 place-items-center rounded-md border border-white/10 text-ink-dim hover:border-white/30 hover:text-ink"
        aria-label={`Decrease ${label}`}
      >
        −
      </button>
      <button
        type="button"
        onClick={() => onStep(5)}
        className="press grid h-7 w-7 place-items-center rounded-md border border-white/10 text-ink-dim hover:border-white/30 hover:text-ink"
        aria-label={`Increase ${label}`}
      >
        +
      </button>
    </>
  )
}

export function Composer({ embedded = false }: { embedded?: boolean } = {}) {
  const { chainId } = useActiveChain()
  const cfg = chainCfg(chainId)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { data: allBaskets } = useAllBaskets()

  const [assets, setAssets] = useState<ComposedAsset[]>([])
  const [weights, setWeights] = useState<number[]>([])
  const [range, setRange] = useState<ChartRange>('30D')
  // Split is the DEFAULT view (owner 17:32) — it only draws from 2 assets.
  const [split, setSplit] = useState(true)
  const [scenario, setScenario] = useState<Record<string, ForecastPoint[]>>({})
  // the natural-language forecast bar's text (owner 19:15)
  const [fcInput, setFcInput] = useState('')
  // the "what is this?" forecast explainer popup (owner 19:15)
  const [fcInfoOpen, setFcInfoOpen] = useState(false)
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  // Launch-in-a-popup (owner 17:53): the REAL BasketBuilder in a dialog, so
  // launching never leaves the composer. Seeding stays the single money path.
  const [launchOpen, setLaunchOpen] = useState(false)

  useEffect(() => {
    if (!launchOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [launchOpen])

  // Switching chains resets the composer (owner 2026-07-07): a mix's token
  // addresses belong to ONE chain, so carrying them to another is meaningless
  // (their history wouldn't resolve there anyway). Clear the composition, close
  // the launch dialog, and let the new chain's own trending suggestions fill in.
  // Fires only on an ACTUAL change (not first mount) and covers both the header
  // toggle and any external switch (the global network toggle).
  const prevChainRef = useRef(chainId)
  useEffect(() => {
    if (prevChainRef.current === chainId) return
    prevChainRef.current = chainId
    setAssets([])
    setWeights([])
    setScenario({})
    setName('')
    setSymbol('')
    setAddError(null)
    setLaunchOpen(false)
  }, [chainId])

  // the launch page's own popular-assets suggestions: constituents of live baskets
  const suggestions = useMemo(() => {
    const freq = new Map<string, { address: string; symbol: string; n: number }>()
    const usdc = cfg.usdc?.toLowerCase()
    const weth = cfg.weth?.toLowerCase()
    for (const ix of allBaskets ?? []) {
      if (ix.chainId !== chainId) continue
      for (const t of ix.top) {
        const k = t.address.toLowerCase()
        if (k === usdc || k === weth) continue
        const cur = freq.get(k)
        if (cur) cur.n += 1
        else freq.set(k, { address: t.address, symbol: t.symbol, n: 1 })
      }
    }
    return [...freq.values()].sort((a, b) => b.n - a.n).slice(0, 10)
  }, [allBaskets, chainId, cfg.usdc, cfg.weth])

  async function addAsset(address: string, knownSymbol?: string) {
    if (assets.length >= MAX_ASSETS || adding) return
    if (assets.some((a) => a.address.toLowerCase() === address.toLowerCase())) return
    setAdding(true)
    setAddError(null)
    try {
      const resolved = await resolveAsset(address, chainId, knownSymbol)
      const withColor: ComposedAsset = { ...resolved, color: tokenVisual(resolved.symbol, resolved.address).color }
      setAssets((prev) => [...prev, withColor])
      setWeights((prev) => equalWeights(prev.length + 1))
    } catch (e) {
      setAddError(e instanceof Error ? e.message.split('\n')[0].slice(0, 140) : 'Could not add that asset.')
    } finally {
      setAdding(false)
    }
  }

  // Start from a template (owner 2026-07-07): resolve the set's symbols to
  // canonical tokens on this chain, then REPLACE the (empty) mix with them at
  // equal weight. Only listed + routable tokens survive; nothing is guessed.
  async function applyTemplate(t: CuratedSet) {
    if (adding) return
    setAdding(true)
    setAddError(null)
    try {
      const cands = (await resolveCuratedSymbols(chainId, t.symbols)).slice(0, MAX_ASSETS)
      const resolved = await Promise.all(
        cands.map((c) =>
          resolveAsset(c.address, chainId, c.symbol)
            .then((r): ComposedAsset => ({ ...r, color: tokenVisual(r.symbol, r.address).color }))
            .catch(() => null),
        ),
      )
      const ok = resolved.filter((r): r is ComposedAsset => r != null)
      const uniq = ok.filter((a, i, arr) => arr.findIndex((x) => x.address.toLowerCase() === a.address.toLowerCase()) === i)
      if (uniq.length === 0) {
        setAddError(`None of the ${t.label} set is listed on ${cfg.name} yet — try search.`)
        return
      }
      setAssets(uniq)
      setWeights(equalWeights(uniq.length))
      setScenario({})
    } catch {
      setAddError('Could not load that template.')
    } finally {
      setAdding(false)
    }
  }

  // Deep-link pre-fill (Prismbeat /createbasket, 2026-07-08): open the composer
  // populated from ?tokens=<addr,addr,…> (comma-separated ERC-20s on ONE chain)
  // + optional ?chain=eth|base. Each resolves to a routable asset; any the app
  // can't trade are skipped and surfaced. The bot only validates + deep-links —
  // wallet + the create/sign tx are the app's job.
  async function seedFromAddresses(rawAddrs: string[], chain: number) {
    const addrs = [...new Set(rawAddrs.map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))].slice(0, MAX_ASSETS)
    if (addrs.length === 0) {
      setAddError('That create link had no valid token addresses.')
      return
    }
    setAdding(true)
    setAddError(null)
    try {
      const resolved = await Promise.all(
        addrs.map((a) =>
          resolveAsset(a, chain)
            .then((r): ComposedAsset => ({ ...r, color: tokenVisual(r.symbol, r.address).color }))
            .catch(() => null),
        ),
      )
      const ok = resolved.filter((r): r is ComposedAsset => r != null)
      if (ok.length === 0) {
        setAddError(`None of those tokens are tradeable on ${chainCfg(chain).name} yet.`)
        return
      }
      setAssets(ok)
      setWeights(equalWeights(ok.length))
      setScenario({})
      const dropped = addrs.length - ok.length
      if (dropped > 0) setAddError(`Added ${ok.length}. ${dropped} not tradeable on ${chainCfg(chain).name} — skipped.`)
    } catch {
      setAddError('Could not load the tokens from that link.')
    } finally {
      setAdding(false)
    }
  }

  // Run the deep-link ONCE on mount (standalone /createbasket + /compose only,
  // never the /creators-embedded instance).
  const deepLinkedRef = useRef(false)
  useEffect(() => {
    if (embedded || deepLinkedRef.current) return
    const raw = searchParams.get('tokens')
    if (!raw) return
    deepLinkedRef.current = true
    const wantChain = parseChainParam(searchParams.get('chain'))
    if (wantChain) setActiveChainId(wantChain)
    void seedFromAddresses(raw.split(','), wantChain ?? chainId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function removeAsset(i: number) {
    const dropped = assets[i]
    setAssets((prev) => prev.filter((_, k) => k !== i))
    setWeights((prev) => {
      const rest = prev.filter((_, k) => k !== i)
      const sum = rest.reduce((s, w) => s + w, 0)
      return sum > 0 ? rebalanceOthers(rest, 0, Math.round((rest[0] / sum) * 100)) : []
    })
    if (dropped) {
      setScenario((prev) => {
        const { [dropped.address.toLowerCase()]: _drop, ...keep } = prev
        return keep
      })
    }
  }

  // ── the backtest: real history per asset, combined into a weighted index ──
  const histories = useQueries({
    queries: assets.map((a) => ({
      queryKey: ['spectrum', 'assetHist', chainId, a.address.toLowerCase(), range],
      queryFn: () => fetchAssetHistory(chainId, a.address, range),
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    })),
  })
  const historiesKey = histories.map((h) => h.dataUpdatedAt).join(',')
  const loadingHist = histories.some((h) => h.isLoading)

  const { rows, perAssetPct, combinedPct, anchors } = useMemo(() => {
    const ready = assets
      .map((a, i) => ({ a, w: weights[i] ?? 0, s: histories[i]?.data ?? [] }))
      .filter((x) => x.s.length >= 2)
    if (ready.length === 0)
      return {
        rows: [] as Record<string, number>[],
        perAssetPct: new Map<string, number>(),
        combinedPct: null as number | null,
        anchors: new Map<string, { first: number; last: number }>(),
      }
    const anchor = ready.reduce((best, x) => (x.s.length > best.s.length ? x : best), ready[0]).s
    const n = anchor.length
    const sample = (s: { time: number; value: number }[], k: number) => s[Math.round((k / (n - 1)) * (s.length - 1))].value
    const wSum = ready.reduce((s, x) => s + x.w, 0) || 1
    const rows: Record<string, number>[] = []
    for (let k = 0; k < n; k++) {
      const r: Record<string, number> = { time: anchor[k].time }
      let idx = 0
      ready.forEach((x, j) => {
        const rel = sample(x.s, k) / (x.s[0].value || 1)
        idx += (x.w / wSum) * rel
        r[`a${j}`] = rel * 100
      })
      r.value = idx * 100
      rows.push(r)
    }
    const perAssetPct = new Map<string, number>()
    // real-price anchors per asset: `first` converts typed target prices into
    // the chart's rebased space, `last` is "now" for implied-% and impact math.
    const anchors = new Map<string, { first: number; last: number }>()
    ready.forEach((x) => {
      const first = x.s[0].value || 1
      const last = x.s[x.s.length - 1].value
      perAssetPct.set(x.a.address.toLowerCase(), (last / first - 1) * 100)
      anchors.set(x.a.address.toLowerCase(), { first, last })
    })
    const combinedPct = rows.length >= 2 ? rows[rows.length - 1].value - 100 : null
    return { rows, perAssetPct, combinedPct, anchors }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, weights, range, historiesKey])

  const readyAssets = useMemo(
    () => assets.filter((_, i) => (histories[i]?.data?.length ?? 0) >= 2),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assets, historiesKey],
  )
  const showSplit = split && readyAssets.length >= 2
  // The blend AS A TOKEN (owner 17:32): a basket token seeded at $1.00 at the
  // range start — the index rebased to dollars.
  const tokenPrice = rows.length >= 2 ? rows[rows.length - 1].value / 100 : null
  // The launch story (owner 19:15): "if you'd launched at $1.00 on <start date>,
  // it'd be $X now." The date is the first point of the shown range.
  const startDate =
    rows.length >= 2
      ? new Date(rows[0].time * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
      : null

  // ── the forecast: dated price points → a replayed scenario path ──
  const forecast = useMemo(() => {
    if (rows.length < 2 || readyAssets.length === 0) return null
    const lastRow = rows[rows.length - 1]
    const tLast = lastRow.time
    const wOf = (addr: string) => weights[assets.findIndex((a) => a.address.toLowerCase() === addr)] ?? 0
    const perAsset = readyAssets.map((a, j) => {
      const addr = a.address.toLowerCase()
      const anchor = anchors.get(addr)
      const first = anchor?.first || 1
      const relNow = (anchor?.last ?? first) / first
      const pts = (scenario[addr] ?? [])
        .map((p) => ({ t: dateToUnix(p.date), price: parseFloat(p.price) }))
        .filter((p): p is { t: number; price: number } => p.t != null && p.t > tLast && Number.isFinite(p.price) && p.price > 0)
        .sort((x, y) => x.t - y.t)
      return { addr, j, first, relNow, pts }
    })
    if (!perAsset.some((x) => x.pts.length > 0)) return null
    // Each asset walks its own points: linear between them, holding beyond the
    // last one; assets with no points hold flat — the blend states that.
    const relAt = (x: (typeof perAsset)[number], t: number): number => {
      let prevT = tLast
      let prevRel = x.relNow
      for (const p of x.pts) {
        const rel = p.price / x.first
        if (t <= p.t) return prevRel + (rel - prevRel) * ((t - prevT) / (p.t - prevT || 1))
        prevT = p.t
        prevRel = rel
      }
      return prevRel
    }
    const wSum = perAsset.reduce((s, x) => s + wOf(x.addr), 0) || 1
    const times = [...new Set(perAsset.flatMap((x) => x.pts.map((p) => p.t)))].sort((a, b) => a - b)
    const scenRows = times.map((t) => {
      const r: Record<string, number> = { time: t }
      let blend = 0
      for (const x of perAsset) {
        const rel = relAt(x, t)
        blend += (wOf(x.addr) / wSum) * rel
        if (x.pts.length > 0) r[`fca${x.j}`] = rel * 100
      }
      r.fc = blend * 100
      return r
    })
    const totalPct = (scenRows[scenRows.length - 1].fc / lastRow.value - 1) * 100
    const predictedIdx = perAsset.filter((x) => x.pts.length > 0).map((x) => x.j)
    return { scenRows, totalPct, endT: times[times.length - 1], predictedIdx }
  }, [rows, readyAssets, anchors, scenario, weights, assets])

  const chartRows = useMemo<Record<string, number>[]>(() => {
    if (!forecast || rows.length < 2) return rows
    const out: Record<string, number>[] = rows.map((r) => ({ ...r }))
    const last = rows[rows.length - 1]
    // connector row: the dashes join the solid lines at "now"
    const conn: Record<string, number> = { ...last, fc: last.value }
    for (const j of forecast.predictedIdx) conn[`fca${j}`] = last[`a${j}`]
    out[out.length - 1] = conn
    out.push(...forecast.scenRows)
    return out
  }, [rows, forecast])

  // A FIXED y-domain over every series drawn (blend + constituents + forecast),
  // independent of the split toggle. Recharts' default ['auto','auto'] refits to
  // only the visible series, so toggling Split (which shows/hides the wide-ranging
  // constituent lines) made the basket-token line jump vertically. Pinning the
  // domain keeps that line in the exact same place — only its styling changes
  // when you toggle (owner 2026-07-07 18:4x). Break-even (100) is folded in so the
  // reference line is always on-scale.
  const yDomain = useMemo<[number, number]>(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const r of chartRows) {
      for (const k in r) {
        if (k === 'time') continue
        const v = r[k]
        if (typeof v === 'number' && Number.isFinite(v)) {
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 100]
    lo = Math.min(lo, 100)
    hi = Math.max(hi, 100)
    if (lo === hi) return [lo - 1, hi + 1]
    const pad = (hi - lo) * 0.06
    return [lo - pad, hi + pad]
  }, [chartRows])

  // every scenario point across all assets, date-sorted — the readable list that
  // replaces the per-asset date pickers (owner 19:15).
  const activePoints = useMemo(
    () =>
      assets
        .flatMap((a) => (scenario[a.address.toLowerCase()] ?? []).map((pt) => ({ a, pt })))
        .sort((x, y) => (dateToUnix(x.pt.date) ?? 0) - (dateToUnix(y.pt.date) ?? 0)),
    [assets, scenario],
  )

  // Add a point parsed from the NL bar (owner 19:15). One point per (asset,date):
  // re-stating a date for the same asset overwrites, so editing = re-adding.
  function addParsedPoint(addr: string, dateISO: string, priceStr: string) {
    setScenario((prev) => {
      const rest = (prev[addr] ?? []).filter((p) => p.date !== dateISO)
      return { ...prev, [addr]: [...rest, { id: nextPointId(), date: dateISO, price: priceStr }] }
    })
  }
  function removePoint(addr: string, id: string) {
    setScenario((prev) => ({ ...prev, [addr]: (prev[addr] ?? []).filter((p) => p.id !== id) }))
  }

  const canLaunch = assets.length >= 2
  function launchIt() {
    if (!canLaunch) return
    seedLaunchDraft(chainId, { assets, weights, name: name.trim(), symbol: symbol.trim().toUpperCase() })
    setLaunchOpen(true)
  }

  return (
    <div className="relative">
      {/* embedded (owner 19:15: composer sits inside /creators above the launch
          section) drops the page masthead + ambient orbs and lets the global
          network toggle govern the chain. */}
      {!embedded && (
        <>
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-visible">
            <div className="absolute left-1/3 top-6 h-[380px] w-[380px] -translate-x-1/2 rounded-full bg-cyan/10 blur-[120px]" />
            <div className="absolute right-[8%] top-40 h-72 w-72 rounded-full bg-violet/12 blur-[130px]" />
            <div className="absolute bottom-0 left-[14%] h-64 w-64 rounded-full bg-magenta/10 blur-[120px]" />
          </div>

          <PageHeader
            className="mb-5 px-1"
            size="lg"
            title="Composer"
            actions={
              <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1">
                {[...SUPPORTED_CHAIN_IDS].reverse().map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setActiveChainId(id)}
                    aria-pressed={chainId === id}
                    className={`press rounded-full px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
                      chainId === id ? 'bg-white/10 text-ink' : 'text-ink-faint hover:text-ink-dim'
                    }`}
                  >
                    {CHAINS[id].name}
                  </button>
                ))}
              </div>
            }
          />
        </>
      )}

      {/* ── COMPOSITION FIRST (owner 17:32), streamlined 17:53: no heading, no
          counter (the page title says it), compact search + trending rail ── */}
      <Card className="p-4">
        <AssetSearch
          chainId={chainId}
          compact
          busy={adding || assets.length >= MAX_ASSETS}
          excludeAddresses={assets.map((a) => a.address)}
          onPick={(addr, sym) => void addAsset(addr, sym)}
        />
        <PopularAssets
          chainId={chainId}
          chainName={cfg.name}
          compact
          candidates={suggestions}
          excludeAddresses={assets.map((a) => a.address)}
          onPick={(addr, sym) => void addAsset(addr, sym)}
          busy={adding}
        />
        {/* templates — a starting point when the mix is empty (owner 2026-07-07) */}
        {assets.length === 0 && (
          <div className="mt-3.5 border-t border-white/8 pt-3.5">
            <div className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-wide text-ink-dim">
              <span className="h-1.5 w-1.5 rounded-full bg-violet" />
              Start from a template
            </div>
            <div className="flex flex-wrap gap-1.5">
              {COMPOSER_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  disabled={adding}
                  onClick={() => void applyTemplate(t)}
                  title={t.blurb}
                  className="press rounded-full border border-white/12 bg-white/[0.03] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim transition-colors hover:border-white/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {addError && <p className="mt-2 font-mono text-[11px] text-magenta">{addError}</p>}
      </Card>

      {/* ── the mix in a card of its own (owner 17:53): weights + steppers ── */}
      {assets.length > 0 && (
        <div className="enter mt-5">
        <Card className="p-4">
          <div className="space-y-3">
            <div className="grid gap-2 lg:grid-cols-2">
              {assets.map((a, i) => (
                <div key={a.address} className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2.5 transition-colors hover:border-white/15">
                  <span aria-hidden className="h-6 w-1 shrink-0 rounded-full" style={{ background: a.color }} />
                  <AssetLogo address={a.address} symbol={a.symbol} chainId={chainId} size={26} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-sm font-bold uppercase tracking-wide text-ink">{a.symbol}</span>
                    <span className="block font-mono text-[9px] text-ink-faint">
                      {perAssetPct.has(a.address.toLowerCase()) ? (
                        <span className={perAssetPct.get(a.address.toLowerCase())! >= 0 ? 'text-teal' : 'text-magenta'}>
                          {formatPct(perAssetPct.get(a.address.toLowerCase())!, 1)} {range}
                        </span>
                      ) : (
                        'loading…'
                      )}
                      {a.depthUsd != null && <span> · {formatUsdCompact(a.depthUsd)} pool</span>}
                    </span>
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Stepper label={`${a.symbol} weight`} onStep={(d) => setWeights((w) => rebalanceOthers(w, i, (w[i] ?? 0) + d))} />
                    <span className="flex items-center rounded-md border border-white/10 px-1.5 py-1">
                      <input
                        value={String(weights[i] ?? 0)}
                        onChange={(e) => {
                          const v = parseInt(e.target.value.replace(/[^0-9]/g, ''), 10)
                          if (Number.isFinite(v)) setWeights((w) => rebalanceOthers(w, i, v))
                        }}
                        inputMode="numeric"
                        aria-label={`${a.symbol} weight percent`}
                        className="w-9 bg-transparent text-right font-num text-sm tabular-nums text-ink outline-none"
                      />
                      <span className="ml-0.5 font-mono text-[10px] text-ink-faint">%</span>
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAsset(i)}
                    className="press ml-1 grid h-7 w-7 place-items-center rounded-md text-ink-faint hover:bg-white/8 hover:text-ink"
                    aria-label={`Remove ${a.symbol}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <div aria-hidden className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/5">
                {assets.map((a, i) => (
                  <div key={a.address} className="h-full transition-[width] duration-300" style={{ width: `${weights[i] ?? 0}%`, background: a.color }} />
                ))}
              </div>
              {assets.length > 1 && (
                <button
                  type="button"
                  onClick={() => setWeights(equalWeights(assets.length))}
                  className="press shrink-0 rounded-md border border-white/12 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-dim hover:border-white/30 hover:text-ink"
                >
                  Equal weight
                </button>
              )}
            </div>
          </div>
        </Card>
        </div>
      )}

      {/* ── the backtest: full width (owner 17:53) ── */}
      <div className="mt-5">
        <Card className="min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-3.5">
            <div className="flex items-baseline gap-3">
              <h2 className="font-display text-lg font-bold uppercase tracking-tight text-ink">Backtest</h2>
              {tokenPrice != null && (
                <span className="flex items-baseline gap-2">
                  <span className="font-num text-2xl font-semibold tabular-nums text-ink">${formatNav(tokenPrice, 4)}</span>
                  {combinedPct != null && (
                    <span className={`font-num text-sm tabular-nums ${combinedPct >= 0 ? 'text-teal' : 'text-magenta'}`}>
                      {formatPct(combinedPct, 1)}
                    </span>
                  )}
                  {startDate && (
                    <span className="font-mono text-[9px] uppercase tracking-wide text-ink-faint">
                      if launched at $1.00 · {startDate}
                    </span>
                  )}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {readyAssets.length >= 2 && (
                <button
                  type="button"
                  onClick={() => setSplit((v) => !v)}
                  aria-pressed={split}
                  className={`press rounded-lg px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide ${
                    split ? 'bg-cyan/15 text-cyan ring-1 ring-inset ring-cyan/30' : 'text-ink-faint ring-1 ring-inset ring-white/10 hover:text-ink'
                  }`}
                >
                  Split
                </button>
              )}
              {RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={`press rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wide ${
                    range === r ? 'bg-white/12 text-ink' : 'text-ink-faint hover:text-ink-dim'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="relative h-72 sm:h-80">
            {assets.length === 0 ? (
              <div className="relative grid h-full place-items-center px-8 text-center">
                {/* a blueprint of the chart that will draw here (owner 19:15:
                    "a blueprint of how the chart would look behind this text") */}
                <div aria-hidden className="pointer-events-none absolute inset-0 opacity-40">
                  <BacktestBlueprint />
                </div>
                <div className="relative">
                  <div className="font-display text-xl font-bold uppercase tracking-tight text-ink">Start with an asset</div>
                  <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-ink-dim">
                    Add a token and its real price history draws here. Two or more become a
                    backtestable basket token.
                  </p>
                </div>
              </div>
            ) : rows.length < 2 ? (
              <div className="grid h-full place-items-center font-mono text-[11px] uppercase tracking-widest text-ink-faint">
                {loadingHist ? 'Loading price history…' : 'No price history for this mix yet'}
              </div>
            ) : (
              <div className="absolute inset-0 px-2 py-2">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartRows} margin={{ top: 6, right: 2, bottom: 0, left: 2 }}>
                    <defs>
                      <linearGradient id="composer-line" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="var(--color-amber)" />
                        <stop offset="50%" stopColor="var(--color-magenta)" />
                        <stop offset="100%" stopColor="var(--color-cyan)" />
                      </linearGradient>
                      <linearGradient id="composer-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-cyan)" stopOpacity={0.16} />
                        <stop offset="55%" stopColor="var(--color-violet-bright)" stopOpacity={0.1} />
                        <stop offset="100%" stopColor="var(--color-violet-bright)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="time"
                      type="number"
                      scale="time"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(t) => new Date((t as number) * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                      tick={{ fill: 'var(--color-ink-faint)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                      axisLine={false}
                      tickLine={false}
                      minTickGap={48}
                    />
                    <YAxis domain={yDomain} allowDataOverflow hide />
                    <Tooltip
                      cursor={{ stroke: 'rgba(255,255,255,0.28)', strokeWidth: 1, strokeDasharray: '3 4' }}
                      content={<ComposerTooltip assets={readyAssets} split={showSplit} anchors={anchors} />}
                      isAnimationActive={false}
                    />
                    {/* break-even: the $1.00 the token started at (100 rebased) —
                        above the line the mix gained, below it lost. Quiet, but
                        it grounds every point on the chart. */}
                    <ReferenceLine
                      y={100}
                      stroke="rgba(255,255,255,0.16)"
                      strokeDasharray="2 5"
                      ifOverflow="extendDomain"
                      label={{
                        value: '$1.00',
                        position: 'insideLeft',
                        fill: 'var(--color-ink-faint)',
                        fontSize: 9,
                        fontFamily: 'var(--font-mono)',
                        dy: -6,
                      }}
                    />
                    {showSplit &&
                      readyAssets.map((a, j) => (
                        <Line
                          key={a.address}
                          type="monotone"
                          dataKey={`a${j}`}
                          stroke={a.color}
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 3, fill: a.color, stroke: 'var(--color-void)', strokeWidth: 1.5 }}
                          isAnimationActive={false}
                        />
                      ))}
                    {/* The blend/basket-token line: in SPLIT view it's WHITE +
                        SOLID so it stands out cleanly against the coloured
                        constituents (owner 2026-07-07 18:4x — SUPERSEDES the
                        17:53 "blend takes the gradient in split" call: the
                        gradient blend got lost among the coloured lines). With
                        split OFF it swaps back to the spectral gradient + fill.
                        Solid in both now — no dash. */}
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke={showSplit ? '#f4f4f8' : 'url(#composer-line)'}
                      strokeWidth={showSplit ? 2.5 : 3}
                      fill={showSplit ? 'transparent' : 'url(#composer-fill)'}
                      dot={false}
                      activeDot={{ r: 3.5, fill: showSplit ? '#f4f4f8' : 'var(--color-violet-bright)', stroke: 'var(--color-void)', strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                    {/* the scenario, on the split view too (owner 17:53): each
                        predicted asset extends dashed in its own color */}
                    {forecast &&
                      showSplit &&
                      forecast.predictedIdx.map((j) => (
                        <Line
                          key={`fca${j}`}
                          type="linear"
                          dataKey={`fca${j}`}
                          stroke={readyAssets[j]?.color}
                          strokeWidth={1.5}
                          strokeDasharray="4 5"
                          strokeOpacity={0.8}
                          dot={false}
                          activeDot={false}
                          isAnimationActive={false}
                        />
                      ))}
                    {forecast && (
                      <Line
                        type="linear"
                        dataKey="fc"
                        stroke="#ffb87a"
                        strokeWidth={2}
                        strokeDasharray="4 5"
                        dot={false}
                        activeDot={false}
                        isAnimationActive={false}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* owner 19:15 removed the "past performance…" line as clutter; the
              forecast's hypothetical legend stays (only shown when a scenario is
              drawn). NOTE (§9): the backtest is now an unqualified performance
              display — flagged for owner/counsel review. */}
          {forecast && (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 px-5 py-2.5">
              <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wide text-[#ffb87a]">
                <span aria-hidden className="h-0 w-4 border-t-2 border-dashed border-[#ffb87a]" />
                your hypothetical scenario
              </span>
            </div>
          )}
        </Card>

      </div>

      {/* ── below the backtest (owner 17:53): forecast appears with the first
          asset, launch with the second — forecast left, launch right ── */}
      {assets.length >= 1 && (
        <div className="enter mt-5 grid items-start gap-5 md:grid-cols-2">
          <Card className="p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-display text-lg font-bold uppercase tracking-tight text-ink">Forecast</h2>
              <button
                type="button"
                onClick={() => setFcInfoOpen(true)}
                aria-label="What is the forecast?"
                className="press grid h-6 w-6 place-items-center rounded-full border border-white/15 font-mono text-[11px] text-ink-faint transition-colors hover:border-cyan/50 hover:text-cyan"
              >
                ?
              </button>
            </div>
            <div className="mt-3 space-y-2">
              <ForecastBar assets={assets} anchors={anchors} value={fcInput} onChange={setFcInput} onAdd={addParsedPoint} />

              {/* the committed points, date-sorted — click to edit, ✕ to drop */}
              {activePoints.map(({ a, pt }) => {
                const addr = a.address.toLowerCase()
                const anchor = anchors.get(addr)
                const priceNum = parseFloat(pt.price)
                const implied =
                  anchor && Number.isFinite(priceNum) && priceNum > 0 ? (priceNum / anchor.last - 1) * 100 : null
                return (
                  <div
                    key={pt.id}
                    className="group flex items-center gap-2 rounded-xl border border-white/[0.07] bg-black/25 px-3 py-2 transition-colors hover:border-white/15"
                  >
                    <span aria-hidden className="h-4 w-1 shrink-0 rounded-full" style={{ background: a.color }} />
                    <button
                      type="button"
                      onClick={() => {
                        setFcInput(`${a.symbol} to $${pt.price} by ${shortMonthDay(pt.date)}`)
                        removePoint(addr, pt.id)
                      }}
                      className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
                      aria-label={`Edit ${a.symbol} forecast`}
                    >
                      <span className="font-display text-sm font-bold uppercase tracking-wide text-ink">{a.symbol}</span>
                      <span className="font-num text-sm tabular-nums text-ink-dim">${pt.price || '—'}</span>
                      <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">{shortMonthDay(pt.date)}</span>
                    </button>
                    {implied != null && (
                      <span className={`font-num text-[11px] tabular-nums ${implied >= 0 ? 'text-teal' : 'text-magenta'}`}>
                        {formatPct(implied, 1)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removePoint(addr, pt.id)}
                      className="press grid h-6 w-6 place-items-center rounded-md text-ink-faint hover:bg-white/8 hover:text-ink"
                      aria-label={`Remove ${a.symbol} forecast`}
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
              <div className="flex items-baseline justify-between border-t border-white/10 pt-2.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                  Basket impact
                  {forecast && (
                    <>
                      {' '}
                      · by {new Date(forecast.endT * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                    </>
                  )}
                </span>
                <span
                  className={`font-num text-2xl font-semibold tabular-nums ${
                    forecast == null ? 'text-ink-faint' : forecast.totalPct >= 0 ? 'text-teal' : 'text-magenta'
                  }`}
                >
                  {forecast == null ? '—' : formatPct(forecast.totalPct, 2)}
                </span>
              </div>
            </div>
          </Card>

          {canLaunch && (
          <Card className="relative overflow-hidden p-5">
            <div aria-hidden className="pointer-events-none absolute -right-14 -top-16 h-48 w-48 rounded-full bg-cyan/12 blur-[90px]" />
            <h2 className="relative font-display text-lg font-bold uppercase tracking-tight text-ink">Launch this basket</h2>
            <p className="relative mt-1.5 text-sm leading-relaxed text-ink-dim">
              The full launch flow opens right here, prefilled with your mix.
            </p>
            <div className="relative mt-3 space-y-2.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 42))}
                placeholder="Basket name"
                className="w-full rounded-xl border border-white/12 bg-black/30 px-3.5 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-cyan/50"
              />
              <div className="flex items-center rounded-xl border border-white/12 bg-black/30 px-3.5 transition-colors focus-within:border-cyan/50">
                <span aria-hidden className="font-num text-sm text-ink-dim">$</span>
                <input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11))}
                  placeholder="TICKER"
                  className="w-full bg-transparent py-2.5 pl-1 font-display text-sm font-bold uppercase tracking-wide text-ink outline-none placeholder:text-ink-faint"
                />
              </div>
              <button
                type="button"
                onClick={launchIt}
                className="press w-full rounded-xl py-3 font-display text-sm font-bold uppercase tracking-[0.15em] text-black transition-transform hover:scale-[1.01]"
                style={{ background: 'linear-gradient(90deg,var(--color-cyan),var(--color-violet-bright),var(--color-magenta))' }}
              >
                Launch this basket →
              </button>
            </div>
          </Card>
          )}
        </div>
      )}

      {/* ── the launch popup: the real builder, right here (owner 17:53) ──
          Portaled to <body> (no ancestor stacking-context surprises). No
          backdrop-click or Escape close — the builder runs a deploy flow and
          its own search uses Escape; the ✕ is the only way out. */}
      {launchOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[70] overflow-y-auto bg-black/70 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-label="Launch this basket"
          >
            <div className="mx-auto my-6 w-[min(64rem,calc(100vw-2rem))]">
              <div className="rounded-3xl p-px" style={{ background: CARD_GRAD }}>
                <div className="rounded-[calc(var(--radius-3xl)_-_1px)] bg-panel/[0.97] p-4 sm:p-6">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h2 className="font-display text-lg font-bold uppercase tracking-tight text-ink">Launch this basket</h2>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => navigate('/launch')}
                        className="press rounded-md border border-white/12 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-dim hover:border-white/30 hover:text-ink"
                      >
                        Open full page ↗
                      </button>
                      <button
                        type="button"
                        onClick={() => setLaunchOpen(false)}
                        aria-label="Close launch"
                        className="press grid h-8 w-8 place-items-center rounded-md text-ink-dim hover:bg-white/8 hover:text-ink"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <BasketBuilder />
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {fcInfoOpen && <ForecastInfoModal onClose={() => setFcInfoOpen(false)} />}
    </div>
  )
}

// ── the "what is the forecast?" explainer (owner 19:15): a worked example with
// the real chart idiom — a solid backtest line that continues dashed to a point
// you set, so people see how a forecast reads before they build one. ─────────
function ForecastInfoModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[70] grid place-items-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="What is the forecast?"
      onClick={onClose}
    >
      <div className="w-[min(30rem,100%)] rounded-3xl p-px" style={{ background: CARD_GRAD }} onClick={(e) => e.stopPropagation()}>
        <div className="rounded-[calc(var(--radius-3xl)_-_1px)] bg-panel/[0.97] p-5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-display text-lg font-bold uppercase tracking-tight text-ink">What is the forecast?</h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="press grid h-8 w-8 place-items-center rounded-md text-ink-dim hover:bg-white/8 hover:text-ink"
            >
              ✕
            </button>
          </div>

          {/* worked example: the solid backtest continues dashed to a set point */}
          <div className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-black/30 p-3">
            <svg viewBox="0 0 260 96" className="h-auto w-full" role="img" aria-label="Example: a backtest line continuing to a forecast point">
              <defs>
                <linearGradient id="fc-info-line" x1="0" y1="0" x2="100%" y2="0">
                  <stop offset="0%" stopColor="var(--color-amber)" />
                  <stop offset="50%" stopColor="var(--color-magenta)" />
                  <stop offset="100%" stopColor="var(--color-cyan)" />
                </linearGradient>
              </defs>
              <line x1="0" y1="66" x2="260" y2="66" stroke="rgba(255,255,255,0.14)" strokeWidth="1" strokeDasharray="2 3" />
              <text x="2" y="62" fill="var(--color-ink-faint)" fontSize="8" fontFamily="var(--font-mono)">$1.00</text>
              {/* the backtest so far — solid */}
              <polyline points="8,70 44,64 80,68 116,52 150,44" fill="none" stroke="url(#fc-info-line)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              {/* the forecast you set — dashed amber to your point */}
              <polyline points="150,44 200,30 244,16" fill="none" stroke="#ffb87a" strokeWidth="2" strokeDasharray="4 4" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="244" cy="16" r="3.5" fill="#ffb87a" stroke="var(--color-void)" strokeWidth="1.5" />
              <text x="150" y="86" fill="#7a7a88" fontSize="8" fontFamily="var(--font-mono)">backtest</text>
              <text x="196" y="86" fill="#ffb87a" fontSize="8" fontFamily="var(--font-mono)">your forecast →</text>
            </svg>
          </div>

          <div className="mt-4 space-y-2.5 text-sm leading-relaxed text-ink-dim">
            <p>
              The backtest replays your mix on real prices — the solid line. The{' '}
              <span className="text-[#ffb87a]">forecast</span> is the dashed part: you say where you think a
              token will trade and when, and we carry the line out to that point.
            </p>
            <p>
              Type it in plain words — <span className="text-ink">“SYRUP to $0.50 by Aug 30”</span> — add as
              many calls as you like, and the basket impact updates to what your mix would be worth then.
            </p>
            <p className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">
              It’s a hypothesis you draw, not a prediction.
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── the natural-language forecast bar (owner 19:15) ─────────────────────────
// Type "SYRUP to $0.50 by Aug 30"; a live read-back shows what's understood and
// the implied move, Enter (or Add) commits it. Focused-and-empty shows one
// editable template per asset so people build the forecast themselves.
function ForecastBar({
  assets,
  anchors,
  value,
  onChange,
  onAdd,
}: {
  assets: ComposedAsset[]
  anchors: Map<string, { first: number; last: number }>
  value: string
  onChange: (v: string) => void
  onAdd: (addr: string, dateISO: string, priceStr: string) => void
}) {
  const [focused, setFocused] = useState(false)
  const parsed = useMemo(() => parseForecastEntry(value, assets, Date.now()), [value, assets])
  const anchor = parsed.addr ? anchors.get(parsed.addr) : undefined
  const implied = anchor && parsed.price != null ? (parsed.price / anchor.last - 1) * 100 : null
  const dateFuture = parsed.dateISO != null && (dateToUnix(parsed.dateISO) ?? 0) * 1000 > Date.now()
  const ready = !!(parsed.addr && parsed.price != null && parsed.dateISO && dateFuture)

  const submit = () => {
    if (!ready) return
    onAdd(parsed.addr as string, parsed.dateISO as string, priceToInput(parsed.price as number))
    onChange('')
  }

  const suggestions = assets
    .filter((a) => anchors.has(a.address.toLowerCase()))
    .map((a) => ({
      symbol: a.symbol,
      color: a.color,
      text: `${a.symbol} to $${priceToInput(anchors.get(a.address.toLowerCase())!.last)} by ${shortMonthDay(isoDay(Date.now() + 30 * DAY_MS))}`,
    }))

  let hint: React.ReactNode = 'e.g. “SYRUP to $0.50 by Aug 30”'
  if (value.trim()) {
    if (!parsed.addr) hint = 'name a token from your mix'
    else if (parsed.price == null) hint = 'add a target price like $0.50'
    else if (!parsed.dateISO) hint = 'add a date, e.g. “by Aug 30”'
    else if (!dateFuture) hint = 'pick a future date'
    else
      hint = (
        <span className="text-ink-dim">
          <span className="font-bold text-ink">{parsed.symbol}</span> → ${priceToInput(parsed.price as number)} · {shortMonthDay(parsed.dateISO as string)}
          {implied != null && <span className={implied >= 0 ? 'text-teal' : 'text-magenta'}> · {formatPct(implied, 1)}</span>}
        </span>
      )
  }

  return (
    <div className="relative">
      <div className={`flex items-center gap-2 rounded-xl border bg-black/30 px-3 py-2 transition-colors ${ready ? 'border-cyan/45' : 'border-white/12 focus-within:border-white/25'}`}>
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-ink-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 17l6-6 4 4 8-8" />
          <path d="M17 7h4v4" />
        </svg>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Forecast a token to a price by a date…"
          aria-label="Forecast a token to a price by a date"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="button"
          disabled={!ready}
          onClick={submit}
          className={`press shrink-0 rounded-lg px-3 py-1 font-display text-[11px] font-bold uppercase tracking-[0.14em] transition-colors ${
            ready ? 'bg-cyan/15 text-cyan ring-1 ring-inset ring-cyan/30' : 'text-ink-faint ring-1 ring-inset ring-white/10'
          }`}
        >
          Add
        </button>
      </div>
      <div className="mt-1.5 px-1 font-mono text-[10px] tracking-wide text-ink-faint">{hint}</div>
      {focused && !value.trim() && suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s.symbol}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                onChange(s.text)
              }}
              className="press inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.03] py-1 pl-1.5 pr-2.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-dim hover:border-white/30 hover:text-ink"
            >
              <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.symbol}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── the empty-state blueprint (owner 19:15): a wireframe of the backtest chart
// — dashed grid, a break-even baseline, and a dashed spectral curve rising
// across it — so the empty panel reads as "your chart draws here". Decorative. ─
function BacktestBlueprint() {
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-full w-full" aria-hidden>
      <defs>
        <linearGradient id="composer-blueprint-line" x1="0" y1="0" x2="100%" y2="0">
          <stop offset="0%" stopColor="var(--color-amber)" />
          <stop offset="50%" stopColor="var(--color-magenta)" />
          <stop offset="100%" stopColor="var(--color-cyan)" />
        </linearGradient>
      </defs>
      {[8, 16, 24, 32].map((y) => (
        <line key={`h${y}`} x1="0" y1={y} x2="100" y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth="0.4" strokeDasharray="1.5 2.5" vectorEffect="non-scaling-stroke" />
      ))}
      {[25, 50, 75].map((x) => (
        <line key={`v${x}`} x1={x} y1="0" x2={x} y2="40" stroke="rgba(255,255,255,0.05)" strokeWidth="0.4" strokeDasharray="1.5 2.5" vectorEffect="non-scaling-stroke" />
      ))}
      {/* break-even baseline — the $1.00 the real chart marks */}
      <line x1="0" y1="30" x2="100" y2="30" stroke="rgba(255,255,255,0.16)" strokeWidth="0.6" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      <polyline
        points="0,31 12,28 24,32 36,25 48,22 60,24 72,15 84,18 96,9"
        fill="none"
        stroke="url(#composer-blueprint-line)"
        strokeWidth="1.6"
        strokeDasharray="3 3"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

// ── tooltip: the basket token ($ + %) + each asset's rebased move ────────────
function ComposerTooltip({
  active,
  payload,
  assets,
  split,
  anchors,
}: {
  active?: boolean
  payload?: { payload: Record<string, number> }[]
  assets: ComposedAsset[]
  split: boolean
  anchors: Map<string, { first: number; last: number }>
}) {
  if (!active || !payload || payload.length === 0) return null
  const p = payload[0].payload
  if (p.value == null && p.fc != null) {
    return (
      <div className="min-w-[11rem] rounded-lg border border-[#ffb87a]/40 bg-void/90 px-3 py-2 shadow-xl backdrop-blur">
        <div className="flex items-baseline justify-between gap-4">
          <span className="font-mono text-[9px] uppercase tracking-wide text-ink-faint">Basket token</span>
          <span className="font-num text-sm font-semibold tabular-nums text-[#ffb87a]">${formatNav(p.fc / 100, 4)}</span>
        </div>
        {split &&
          assets.map((a, j) => {
            const rel = p[`fca${j}`]
            const first = anchors.get(a.address.toLowerCase())?.first
            if (rel == null || first == null) return null
            return (
              <div key={a.address} className="mt-1 flex items-baseline justify-between gap-4">
                <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-dim">
                  <span aria-hidden className="h-1 w-3 rounded-full" style={{ background: a.color }} />
                  {a.symbol}
                </span>
                <span className="font-num text-[11px] tabular-nums text-ink">{formatPrice((rel / 100) * first)}</span>
              </div>
            )
          })}
        <div className="mt-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-faint">
          hypothetical · {new Date((p.time as number) * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
        </div>
      </div>
    )
  }
  return (
    <div className="min-w-[12rem] rounded-lg border border-white/15 bg-void/90 px-3.5 py-2.5 shadow-xl backdrop-blur">
      <div className="flex items-baseline justify-between gap-5">
        <span className="font-mono text-[9px] uppercase tracking-wide text-ink-faint">Basket token</span>
        <span className="flex items-baseline gap-2">
          <span className="font-num text-sm font-semibold tabular-nums text-ink">${formatNav(p.value / 100, 4)}</span>
          <span className={`font-num text-[11px] tabular-nums ${p.value >= 100 ? 'text-teal' : 'text-magenta'}`}>
            {formatPct(p.value - 100, 1)}
          </span>
        </span>
      </div>
      {split && assets.length > 0 && (
        <div className="mt-1.5 space-y-0.5 border-t border-white/10 pt-1.5">
          {assets.map((a, j) => (
            <div key={a.address} className="flex items-baseline justify-between gap-5">
              <span className="inline-flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-dim">
                <span aria-hidden className="h-1 w-3 rounded-full" style={{ background: a.color }} />
                {a.symbol}
              </span>
              <span className={`font-num text-[11px] tabular-nums ${(p[`a${j}`] ?? 100) >= 100 ? 'text-teal' : 'text-magenta'}`}>
                {p[`a${j}`] != null ? formatPct(p[`a${j}`] - 100, 1) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-faint">
        {new Date((p.time as number) * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  )
}
