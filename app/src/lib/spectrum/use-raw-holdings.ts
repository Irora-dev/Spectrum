import { useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { SUPPORTED_CHAIN_IDS } from '../chain/chains'
import { isDevPreview } from './dev-preview'
import { fetchChainRawHoldings, type RawHolding, type RawHoldingsResult } from './raw-holdings'
import { manualAssetsFor, manualSig, subscribeManualAssets } from './manual-assets'
import type { Address } from 'viem'

/** The React face of raw-holdings — kept OUT of raw-holdings.ts so the
 *  analytical core stays React-free (extension spec, 2026-08-02).
 *
 *  Takes one address or a linked-wallet GROUP (wallet-links.ts). A group
 *  merges the read: the same asset held by two wallets becomes ONE row with
 *  summed amounts (it is one position in one book); a network counts failed
 *  once however many wallets it failed for. Single-address callers behave
 *  exactly as before. */
export function useRawHoldings(address: string | string[] | undefined) {
  const list = (Array.isArray(address) ? address : address ? [address] : [])
    .map((a) => a.toLowerCase())
    .filter((a, i, arr) => /^0x[0-9a-f]{40}$/.test(a) && arr.indexOf(a) === i)

  // HAND-ADDED assets ride the sweep (owner 2026-08-12, paste-to-add): the
  // union of every member's manual rows keys the query, so an add re-keys and
  // re-reads without a reload — and the pasted asset appears in the same book,
  // totals and exports as anything the sweep found itself.
  const manualKey = useSyncExternalStore(
    subscribeManualAssets,
    () => manualSig(list),
    () => '',
  )

  return useQuery<RawHoldingsResult>({
    queryKey: ['spectrum', 'raw-holdings', list.join('|'), manualKey],
    enabled: list.length > 0,
    staleTime: 120_000,
    // Linking a wallet CHANGES the key (solo → group) — without this the book
    // on screen vanished into skeletons and repopulated, exactly the reload
    // feel the bento's glide exists to avoid. The previous read stands in
    // while the merged one loads; animateLayout then glides the difference.
    // IDENTITY-GATED (audit F1/F2): the carry-over holds only when the old
    // and new address-sets OVERLAP (link/unlink — the same person's growing
    // book). An account SWITCH shares no address, and carrying A's book under
    // B's name showed A's holdings as B's — and let "Shape these weights"
    // persist A's assets into B's draft. Disjoint sets get the honest skeleton.
    placeholderData: (prev, prevQuery) => {
      if (!prev || !prevQuery) return undefined
      const prevSet = String(prevQuery.queryKey[2] ?? '').split('|').filter(Boolean)
      return prevSet.some((a) => list.includes(a)) ? prev : undefined
    },
    queryFn: async () => {
      // Per-(wallet, network) isolation: one throttled RPC must never blank
      // the rest. A chain is FAILED when any wallet's read of it failed — the
      // merged book cannot claim that network was fully read.
      const jobs = list.flatMap((owner) => SUPPORTED_CHAIN_IDS.map((chainId) => ({ owner, chainId })))
      // BOUNDED FAN-OUT (the 10+-wallet ask): owners × chains all at once was
      // fine at 1×3; at 12 wallets it is 36 simultaneous chain sweeps, each
      // with its own discovery HTTP call — a rate-limit storm on public
      // endpoints (the RPC audit's probe-contention lesson). Six at a time
      // keeps the merged read fast without stampeding anyone.
      // every member reads every hand-added address on its chain — a linked
      // wallet may hold the pasted token too, and the merged row should say so
      const manualByChain = new Map<number, string[]>()
      for (const m of manualAssetsFor(list)) {
        const arr = manualByChain.get(m.chainId) ?? []
        arr.push(m.address)
        manualByChain.set(m.chainId, arr)
      }
      const settled: PromiseSettledResult<Awaited<ReturnType<typeof fetchChainRawHoldings>>>[] = []
      for (let i = 0; i < jobs.length; i += 6) {
        settled.push(
          ...(await Promise.allSettled(
            jobs
              .slice(i, i + 6)
              .map((j) => fetchChainRawHoldings(j.owner as Address, j.chainId, manualByChain.get(j.chainId) ?? [])),
          )),
        )
      }
      const merged = new Map<string, RawHolding>()
      const failedChains = new Set<number>()
      const discoveryGapChains = new Set<number>()
      let unreadable = 0
      settled.forEach((s, i) => {
        if (s.status !== 'fulfilled') {
          failedChains.add(jobs[i].chainId)
          return
        }
        unreadable += s.value.unreadable
        if (s.value.discoveryGap) discoveryGapChains.add(jobs[i].chainId)
        for (const h of s.value.holdings) {
          const k = `${h.chainId}:${h.address.toLowerCase()}`
          const mine = { owner: jobs[i].owner, amount: h.amount, usd: h.usd }
          const prev = merged.get(k)
          if (!prev) {
            // Attribution rides only on GROUP reads — a solo read's rows stay
            // byte-identical to what they always were.
            merged.set(k, list.length > 1 ? { ...h, contributors: [mine] } : { ...h })
            continue
          }
          // One position in one book: amounts sum; USD sums only when BOTH
          // sides priced (null means "no routable pool" — never let a null
          // half vanish into a number that reads as the whole). WHO holds
          // what survives in `contributors`.
          merged.set(k, {
            ...prev,
            amount: prev.amount + h.amount,
            usd: prev.usd != null && h.usd != null ? prev.usd + h.usd : null,
            contributors: [...(prev.contributors ?? []), mine],
          })
        }
      })
      const holdings = [...merged.values()]
      // DEV-ONLY demo tokens, so the portfolio shows tokens alongside baskets
      // (owner 2026-08-02 18:51). Dynamic import behind import.meta.env.DEV —
      // the doctrine basket-data.ts already uses — so the fixture is not in a
      // production bundle at all, and it self-gates on VITE_DEV_FIXTURE inside.
      // A REAL holding always wins: the fixture only fills keys the chain did
      // not return, so it can never overwrite or inflate a real balance.
      // (Group note: the fixture is a set of ASSETS, not per-wallet balances,
      // so it joins the merged book once regardless of wallet count.)
      // PREVIEW-ONLY (owner report 2026-08-03 ~11:5x: a connected wallet still
      // showed "the default nvidia, syrup, aave"): the catalogue stands in for
      // the dev preview identity alone — a real wallet's read is real, and an
      // empty real wallet is allowed to LOOK empty.
      if (import.meta.env.DEV && isDevPreview(list)) {
        try {
          const { devRawHoldings } = await import('./dev-fixture')
          const have = new Set(holdings.map((h) => `${h.chainId}:${h.address.toLowerCase()}`))
          for (const c of SUPPORTED_CHAIN_IDS) {
            for (const d of devRawHoldings(c)) {
              if (!have.has(`${d.chainId}:${d.address.toLowerCase()}`)) holdings.push(d as RawHolding)
            }
          }
        } catch {
          /* fixture absent or failed to load — the real sweep stands alone */
        }
      }
      return {
        holdings,
        chainsFailed: failedChains.size,
        /** Chains whose unlisted-token DISCOVERY failed or truncated — their
         *  books may be missing tokens nobody listed (never silent: audit
         *  2026-08-06 #1/#2). */
        discoveryGaps: discoveryGapChains.size,
        // WHICH chain went dark, not just how many (per-chain breakdown,
        // 2026-08-06 12:53): a count can gate a page-wide caveat, but it cannot
        // tell a per-chain row whether ITS figure is a real zero or a silence.
        failedChainIds: [...failedChains],
        unreadable,
        unpriced: holdings.filter((h) => h.usd == null).length,
      }
    },
  })
}
