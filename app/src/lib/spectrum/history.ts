import { chainCfg } from '../chain/chains'
import type { NavPoint } from './basket-data'

// ─────────────────────────────────────────────────────────────────────────────
// Real historical NAV reconstruction.
//
// The basket token itself isn't reliably priced by any feed (it's a V4 hook token
// and NAV isn't readable on-chain), so we rebuild NAV(t) from REAL per-asset price
// history: NAV(t) = navNow · Σ_i wᵢ · priceᵢ(t)/priceᵢ(t₀), anchored so the final
// point equals the current navPerToken.
//
// Source: Alchemy Prices API (historical, keyless from the bundle via the same
// VITE_ALCHEMY_API_KEY the RPC uses) with a keyless DefiLlama fallback. Per-asset
// series are fetched once and cached by React Query, so baskets that share assets
// (VVV, BNKR, …) collapse to a handful of unique calls across the whole page.
// ─────────────────────────────────────────────────────────────────────────────

export type ChartRange = '24H' | '7D' | '30D' | 'ALL'
export const CHART_RANGES: ChartRange[] = ['24H', '7D', '30D', 'ALL']

// One basket constituent's contribution to the basket NAV curve.
export interface NavInput {
  address: string
  weight: number
}

const ALCHEMY_KEY = import.meta.env.VITE_ALCHEMY_API_KEY as string | undefined

// Alchemy Prices API network identifiers (mirror the RPC subdomains).
function alchemyNetwork(chainId: number): string | null {
  if (chainId === 8453) return 'base-mainnet'
  if (chainId === 1) return 'eth-mainnet'
  return null
}

const HOUR = 3600
const DAY = 86400

// Per-range fetch plan. Alchemy interval max-ranges are 5m→7d, 1h→30d, 1d→1yr;
// we stay within them. `llama*` mirror the plan for the keyless fallback.
interface RangePlan {
  interval: '5m' | '1h' | '1d'
  seconds: number
  llamaPeriod: string
  llamaSpan: number
}

function planFor(range: ChartRange, ageSec: number | null): RangePlan {
  switch (range) {
    case '24H':
      return { interval: '5m', seconds: DAY, llamaPeriod: '1h', llamaSpan: 24 }
    case '7D':
      return { interval: '1h', seconds: 7 * DAY, llamaPeriod: '4h', llamaSpan: 42 }
    case '30D':
      return { interval: '1h', seconds: 30 * DAY, llamaPeriod: '1d', llamaSpan: 30 }
    case 'ALL': {
      const age = ageSec ?? 180 * DAY
      if (age <= 2 * DAY) {
        const s = Math.max(age, 2 * HOUR)
        return { interval: '5m', seconds: s, llamaPeriod: '1h', llamaSpan: Math.ceil(s / HOUR) }
      }
      if (age <= 30 * DAY)
        return { interval: '1h', seconds: age, llamaPeriod: '4h', llamaSpan: Math.ceil(age / (4 * HOUR)) }
      const s = Math.min(age, 365 * DAY)
      return { interval: '1d', seconds: s, llamaPeriod: '1d', llamaSpan: Math.min(Math.ceil(s / DAY), 365) }
    }
  }
}

// Which range tabs make sense for a basket this old (don't offer 30D for a
// day-old index). `null` age (unknown) → offer everything.
export function availableRanges(ageSec: number | null): ChartRange[] {
  if (ageSec == null) return CHART_RANGES
  const out: ChartRange[] = ['24H']
  if (ageSec >= 1.5 * DAY) out.push('7D')
  if (ageSec >= 8 * DAY) out.push('30D')
  out.push('ALL')
  return out
}

function normalize(pts: NavPoint[]): NavPoint[] {
  return pts
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value) && p.value > 0)
    .sort((a, b) => a.time - b.time)
}

// ── concurrency throttle ─────────────────────────────────────────────────────
// Cap simultaneous price requests so a homepage full of cards can't burst the
// Prices API into 429s.
const MAX_CONCURRENT = 6
let active = 0
const waiters: Array<() => void> = []
function acquire(): Promise<void> {
  return new Promise<void>((resolve) => {
    const attempt = () => {
      if (active < MAX_CONCURRENT) {
        active++
        resolve()
      } else {
        waiters.push(attempt)
      }
    }
    attempt()
  })
}
function release(): void {
  active = Math.max(0, active - 1)
  const next = waiters.shift()
  if (next) next()
}

// ── sources ──────────────────────────────────────────────────────────────────
interface AlchemyPoint {
  value: string
  timestamp: string
}

async function fetchAlchemy(network: string, address: string, plan: RangePlan): Promise<NavPoint[]> {
  if (!ALCHEMY_KEY) throw new Error('no-alchemy-key')
  const endTime = Math.floor(Date.now() / 1000)
  const startTime = endTime - plan.seconds
  const res = await fetch(`https://api.g.alchemy.com/prices/v1/${ALCHEMY_KEY}/tokens/historical`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ network, address, startTime, endTime, interval: plan.interval }),
  })
  if (!res.ok) throw new Error(`alchemy ${res.status}`)
  const json = (await res.json()) as { data?: AlchemyPoint[] }
  return normalize(
    (json.data ?? []).map((d) => ({
      time: Math.floor(Date.parse(d.timestamp) / 1000),
      value: parseFloat(d.value),
    })),
  )
}

async function fetchLlama(slug: string, address: string, plan: RangePlan): Promise<NavPoint[]> {
  const start = Math.floor(Date.now() / 1000) - plan.seconds
  const coinKey = `${slug}:${address}`
  const url = `https://coins.llama.fi/chart/${coinKey}?start=${start}&span=${plan.llamaSpan}&period=${plan.llamaPeriod}&searchWidth=600`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`llama ${res.status}`)
  const json = (await res.json()) as {
    coins?: Record<string, { prices?: { timestamp: number; price: number }[] }>
  }
  const coins = json.coins ?? {}
  const coin =
    coins[coinKey] ?? coins[`${slug}:${address.toLowerCase()}`] ?? Object.values(coins)[0]
  return normalize((coin?.prices ?? []).map((p) => ({ time: p.timestamp, value: p.price })))
}

// Single asset's USD price history for a range. Throttled + Alchemy⇄DefiLlama
// with an order switch. Meant to be wrapped by a React Query (keyed by
// chain/addr/range) so identical assets across baskets are fetched once.
//
// `preferKeyless` flips the source order (DefiLlama first, Alchemy fallback):
// decorative sparklines on list surfaces are the highest-volume Prices-API
// consumer (one metered request per unique asset per visitor per cache
// window), and DefiLlama's coarser series is indistinguishable at sparkline
// size. Detail-grade charts keep the keyed source first for resolution.
export async function fetchAssetHistory(
  chainId: number,
  address: string,
  range: ChartRange,
  ageSec: number | null = null,
  opts: { preferKeyless?: boolean } = {},
): Promise<NavPoint[]> {
  const plan = planFor(range, ageSec)
  const net = alchemyNetwork(chainId)
  const slug = chainCfg(chainId).dexscreenerSlug
  await acquire()
  try {
    if (opts.preferKeyless) {
      try {
        const l = await fetchLlama(slug, address, plan)
        if (l.length >= 2) return l
      } catch {
        /* fall through to the keyed source */
      }
    }
    if (ALCHEMY_KEY && net) {
      try {
        const a = await fetchAlchemy(net, address, plan)
        if (a.length >= 2) return a
      } catch {
        /* fall through to keyless source */
      }
    }
    if (opts.preferKeyless) return []
    try {
      return await fetchLlama(slug, address, plan)
    } catch {
      return []
    }
  } finally {
    release()
  }
}

// ── NAV reconstruction ───────────────────────────────────────────────────────

// Linear-interpolate a (sorted) series at time t, clamped at both ends.
function sampleAt(s: NavPoint[], t: number): number {
  if (s.length === 0) return NaN
  if (t <= s[0].time) return s[0].value
  const last = s[s.length - 1]
  if (t >= last.time) return last.value
  let lo = 0
  let hi = s.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (s[mid].time <= t) lo = mid
    else hi = mid
  }
  const a = s[lo]
  const b = s[hi]
  const f = b.time === a.time ? 0 : (t - a.time) / (b.time - a.time)
  return a.value + (b.value - a.value) * f
}

// Weight-driven, normalized basket index: idx(t0) = 1 and idx(t) = Σ wᵢ·priceᵢ(t)/priceᵢ(t0).
// Reference grid = the densest constituent's timestamps. Returns null if no usable
// constituent series. Used by the live NAV reconstruction (combineNavHistory anchors
// the END to the current navPerToken).
function weightedBasketIndex(
  assets: NavInput[],
  seriesByAddr: Map<string, NavPoint[]>,
): { times: number[]; idx: number[] } | null {
  const used = assets
    .map((a) => ({ weight: a.weight, s: seriesByAddr.get(a.address.toLowerCase()) ?? [] }))
    .filter((a) => a.s.length >= 2 && a.weight > 0)
  if (used.length === 0) return null

  const wsum = used.reduce((s, a) => s + a.weight, 0) || 1

  // Reference grid = the densest constituent's timestamps.
  let grid = used[0].s
  for (const a of used) if (a.s.length > grid.length) grid = a.s
  const times = grid.map((p) => p.time)
  if (times.length < 2) return null

  const refs = used.map((a) => {
    const r = sampleAt(a.s, times[0])
    return r > 0 ? r : a.s[0].value
  })

  const idx = times.map((t) => {
    let acc = 0
    for (let i = 0; i < used.length; i++) {
      const p = sampleAt(used[i].s, t)
      const ratio = refs[i] > 0 ? p / refs[i] : 1
      acc += (used[i].weight / wsum) * ratio
    }
    return acc
  })
  return { times, idx }
}

// Combine per-asset USD histories into a basket NAV curve, scaled so the final
// point equals the current navPerToken — so the curve is in USD terms and ends
// exactly where the live price reads.
export function combineNavHistory(
  assets: NavInput[],
  seriesByAddr: Map<string, NavPoint[]>,
  navPerTokenNow: number,
): NavPoint[] {
  if (!(navPerTokenNow > 0)) return []
  const r = weightedBasketIndex(assets, seriesByAddr)
  if (!r) return []
  const idxLast = r.idx[r.idx.length - 1] || 1
  const scale = idxLast > 0 ? navPerTokenNow / idxLast : navPerTokenNow
  return r.times.map((t, i) => ({ time: t, value: r.idx[i] * scale }))
}

export interface RangeReturn {
  range: ChartRange
  pct: number
}

// Multi-horizon returns from a single series. Skips horizons the series (or the
// basket's age) doesn't actually cover. Returns are ratios, so they're correct
// regardless of any absolute NAV scaling.
export function computeReturns(series: NavPoint[], ageSec: number | null): RangeReturn[] {
  if (series.length < 2) return []
  const last = series[series.length - 1]
  const first = series[0]
  const span = last.time - first.time
  const out: RangeReturn[] = []
  const horizons: [ChartRange, number][] = [
    ['24H', DAY],
    ['7D', 7 * DAY],
    ['30D', 30 * DAY],
  ]
  for (const [range, sec] of horizons) {
    if (span + 60 < sec) continue
    if (ageSec != null && ageSec + 60 < sec) continue
    const past = sampleAt(series, last.time - sec)
    if (past > 0) out.push({ range, pct: (last.value / past - 1) * 100 })
  }
  if (first.value > 0) out.push({ range: 'ALL', pct: (last.value / first.value - 1) * 100 })
  return out
}
