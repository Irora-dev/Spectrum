import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { fetchAssetHistory } from './history'
import { effectiveBets, movedTogether, planCounterfactual, sinceValue, weeklySwing } from './history-insights'
import type { NavPoint } from './basket-data'
import type { SavedPortfolio } from './allocation'
import { assetKey } from './allocation'

// React wiring for the history-derived facts (features 2 + 7): 30D per-asset
// histories through the SAME query keys the hero chart uses, handed to the
// pure module. Everything degrades to null — a card that can't be computed
// is absent, never approximated.

export interface HistAsset {
  chainId: number
  address: string
  symbol: string
  valueUsd: number
}

export interface HistoryFacts {
  planVs: { actualNowUsd: number; planNowUsd: number; atMs: number; skippedCount: number } | null
  together: { aSym: string; bSym: string; days: number; together: number } | null
  /** Feature 5: the effective-independent-bets measurement. */
  bets: { bets: number; included: number; considered: number; coveredSharePct: number } | null
  /** Feature 4: today's holdings priced at the caller's last-seen moment. */
  since: { thenUsd: number; nowUsd: number; coveredSharePct: number } | null
  /** Stress replay v1: the worst/best week of the last 30 days, replayed. */
  swing: { worstPct: number; bestPct: number; included: number; considered: number; coveredSharePct: number; days: number } | null
}

const keyOf = (a: HistAsset) => `${a.chainId}:${a.address.toLowerCase()}`

export function useHistoryInsights(assets: HistAsset[], saved: SavedPortfolio | null, sinceSec?: number | null): HistoryFacts {
  // fetch set: the WHOLE book by value ∪ the plan's legs we hold, under a
  // hard safety ceiling (owner ~17:1x: full-book reads for bets/since —
  // "do all of these"; one 30D query per asset, react-query cached 10min).
  // The ceiling only bites portfolios past 32 distinct assets, and every
  // consumer states its coverage, so the tail's absence is never silent.
  const wanted = useMemo(() => {
    const held = new Map(assets.filter((a) => a.valueUsd > 0).map((a) => [keyOf(a), a]))
    const top = [...held.values()].sort((a, b) => b.valueUsd - a.valueUsd).slice(0, 32)
    const planLegs = (saved?.targets ?? [])
      .map((t) => held.get(assetKey(t.asset)))
      .filter((a): a is HistAsset => !!a)
    const byKey = new Map<string, HistAsset>()
    for (const a of [...top, ...planLegs]) byKey.set(keyOf(a), a)
    return [...byKey.values()].slice(0, 32)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets.map((a) => `${keyOf(a)}:${Math.round(a.valueUsd)}`).join('|'), saved?.executedAt])

  const results = useQueries({
    queries: wanted.map((a) => ({
      queryKey: ['spectrum', 'assetHist', a.chainId, a.address.toLowerCase(), '30D'],
      queryFn: () => fetchAssetHistory(a.chainId, a.address.toLowerCase(), '30D', null),
      staleTime: 10 * 60_000,
      gcTime: 30 * 60_000,
      retry: 1,
    })),
  })
  const updatedKey = results.map((r) => r.dataUpdatedAt).join(',')

  return useMemo(() => {
    const histByKey: Record<string, NavPoint[]> = {}
    wanted.forEach((a, i) => {
      histByKey[keyOf(a)] = (results[i]?.data as NavPoint[] | undefined) ?? []
    })

    // feature 2 — the plan counterfactual
    let planVs: HistoryFacts['planVs'] = null
    if (saved && Number.isFinite(saved.executedAt) && saved.executedAt > 0) {
      const w = (saved.targets ?? []).reduce((s, t) => s + t.weight, 0)
      if (w > 0) {
        const planShares: Record<string, number> = {}
        const currentUsd: Record<string, number> = {}
        for (const t of saved.targets) {
          const k = assetKey(t.asset)
          const held = wanted.find((a) => keyOf(a) === k)
          if (!held) continue
          planShares[k] = (t.weight / w) * 100
          currentUsd[k] = held.valueUsd
        }
        const fact = planCounterfactual({ planShares, currentUsd, histByKey, atSec: saved.executedAt / 1000 })
        if (fact && fact.coveredKeys.length >= 2) {
          planVs = {
            actualNowUsd: fact.actualNowUsd,
            planNowUsd: fact.planNowUsd,
            atMs: saved.executedAt,
            skippedCount: fact.skippedKeys.length,
          }
        }
      }
    }

    // feature 7 — the strongest moved-together pair among real positions
    let together: HistoryFacts['together'] = null
    const total = wanted.reduce((s, a) => s + a.valueUsd, 0)
    const eligible = wanted.filter((a) => total > 0 && a.valueUsd / total >= 0.05)
    let bestShare = 0
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const f = movedTogether(histByKey[keyOf(eligible[i])] ?? [], histByKey[keyOf(eligible[j])] ?? [])
        if (!f || f.days < 6) continue
        const share = f.together / f.days
        if (share >= 0.8 && share > bestShare) {
          bestShare = share
          together = { aSym: eligible[i].symbol, bSym: eligible[j].symbol, days: f.days, together: f.together }
        }
      }
    }
    // feature 5 — diversification measured, over the same fetch set
    const weightsByKey: Record<string, number> = {}
    for (const a of wanted) weightsByKey[keyOf(a)] = a.valueUsd
    const bets = effectiveBets({ weightsByKey, histByKey })

    // feature 4 — since the caller's last look (constant-quantity read)
    const since =
      sinceSec != null && Number.isFinite(sinceSec)
        ? sinceValue({
            currentUsd: weightsByKey,
            histByKey,
            atSec: sinceSec,
            // coverage against the WHOLE book, not the fetched subset
            totalUsd: assets.reduce((s2, a) => s2 + a.valueUsd, 0),
          })
        : null

    const swing = weeklySwing({ weightsByKey, histByKey, totalUsd: assets.reduce((s2, a) => s2 + a.valueUsd, 0) })

    return {
      planVs,
      together,
      bets: bets ? { bets: bets.bets, included: bets.included, considered: bets.considered, coveredSharePct: bets.coveredSharePct } : null,
      since,
      swing,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, updatedKey, saved?.executedAt, sinceSec])
}
