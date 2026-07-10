import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { encodeFunctionData, parseAbi, parseEventLogs, type Address, type Hex } from 'viem'
import { useQueryClient } from '@tanstack/react-query'
import { chainCfg } from '../chain/chains'
import { deploymentFor } from '../chain/deployments'
import { clientFor } from '../chain/rpc'
import { ZERO_ADDRESS } from '../chain/constants'
import { MIGRATE_REBALANCE_ENABLED, TRADING_ENABLED } from '../config/features'
import { INTERFACE_TAG_ADDRESS } from '../config/operator'
import { getStoredRef } from './referral'
import { basketAbi, erc20ApproveAbi, erc20BalanceAbi } from './abis-v2'
import { friendlyRevert } from './decode-revert'
import { gasWithHeadroom } from './gas'
import type { ResidueToken } from './use-sweep'
import {
  bestExactInTier,
  bestExactOutTier,
  encodeV3Path,
  maxInFor,
  minOutFor,
  quoteExactInPath,
  splitAmountByBudgets,
  splitPotByWeight,
  swapRouter02Abi,
} from './delta-trade'
import {
  approvalPlan,
  maxSharesOverFunded,
  mulDivDown,
  planMint,
  planRebalance,
  planRedeem,
  recvForShares,
  BPS,
  DRIFT_BUFFER_BPS,
  MIN_SHARES_SLIPPAGE_BPS,
  REBALANCE_MIN_GAIN_BPS,
  type LegReserve,
  type MintPlan,
  type RebalanceLegInput,
  type RebalancePlan,
  type RedeemPlan,
} from './migrate-math'

// ─────────────────────────────────────────────────────────────────────────────
// LIVE in-kind migration between two immutable baskets, client-orchestrated on
// the deployed primitives (no migration router exists — this is the honest
// sequenced form of the same mechanics):
//
//   1. from.redeemInKind(amount, all-true mask, holder)  — burn v1, receive
//      every constituent pro-rata (fee haircut stays with remaining holders)
//   2. THE DELTA TRADE (only when the new version changed assets): sell the
//      legs it dropped → WETH, buy the legs it added with the proceeds — via
//      the canonical Uniswap V3 SwapRouter02/QuoterV2 (best fee tier by quote;
//      see delta-trade.ts). Skipped entirely for reweight/drop-only versions.
//   3. exact-amount approve of each v2 constituent → the v2 BASKET
//   4. to.mintInKind(amounts, minShares, holder, INTERFACE_TAG)
//
// Contract constraints the flow enforces up front (SpectrumBasket.sol):
//   • no-skip min-rule — EVERY v2 leg needs a non-zero proportional deposit;
//     the delta trade exists to fund the legs the redemption can't.
//   • supply > 0 — a freshly deployed version must be seeded by a first
//     swap-mint (buy) before in-kind entry opens (C-1).
//   • deposits are priced against LIVE reserves — amounts are recomputed from
//     fresh reads AFTER the redeem lands, and every tx is simulated pre-sign.
//
// Availability semantics (deliberate + shown in the plan panel before any
// signature): wallet balances of v2 constituents count toward the deposit, so
// a holder who already owns an added leg funds it from their wallet instead of
// buying. Sells are sized to what the redeem delivered (measured), falling
// back to the wallet balance of a dropped leg on a resumed run.
// Gated by TRADING_ENABLED with a hard guard in the send path.
// ─────────────────────────────────────────────────────────────────────────────

const erc20SymbolAbi = parseAbi(['function symbol() view returns (string)'])
const mintedInKindEvent = parseAbi([
  'event MintedInKind(address indexed to, address indexed frontend, uint256 shares, uint256 feeUsdc)',
])[0]

export type MigrateTxStatus = 'idle' | 'signing' | 'confirming' | 'success' | 'error'
export interface MigrateTxState {
  status: MigrateTxStatus
  hash: Hex | null
  error: string | null
}
const TX_IDLE: MigrateTxState = { status: 'idle', hash: null, error: null }

export type SnapLeg = LegReserve & { weight: number }

export interface BasketSnapshot {
  address: Address
  decimals: number
  effectiveSupply: bigint
  feeBps: number
  legs: SnapLeg[]
}

export interface DeltaSellPreview {
  leg: SnapLeg
  /** Amount to sell (projected redeem output at plan time; measured at execution). */
  amountIn: bigint
  fee: number
  quotedWeth: bigint
}
export interface DeltaBuyPreview {
  leg: SnapLeg
  /** WETH budget allocated to this leg (its weight share of the pot). */
  budget: bigint
  fee: number
  /** Expected leg amount acquired. */
  quotedOut: bigint
  mode: 'exact-out' | 'exact-in'
}
export interface DeltaPreview {
  sells: DeltaSellPreview[]
  buys: DeltaBuyPreview[]
  /** Projected WETH pot funding the buys (sell quotes + dropped WETH). */
  potWeth: bigint
  /** Full priced value of the migration's proceeds (WETH-wei) — rebalance only.
   *  With potWeth it yields the in-kind vs swapped split shown in review. */
  totalValueWeth?: bigint
}

export interface MigratePlanView {
  from: BasketSnapshot
  to: BasketSnapshot
  /** Holder's v1 share balance (raw, v1 decimals). */
  fromBalance: bigint
  redeem: RedeemPlan
  mint: MintPlan
  /** Non-null when the version diff needs (and can auto-route) a delta trade. */
  delta: DeltaPreview | null
  /** Which delta the plan chose: 'rebalance' = balanced-target across every leg
   *  (new); 'legacy' = dropped→added only; undefined = no delta needed. */
  deltaKind?: 'rebalance' | 'legacy'
  /** v1 legs the new version dropped (projected redeem outputs). */
  dropped: { leg: SnapLeg; out: bigint }[]
}

export type MigratePhase = 'idle' | 'planning' | 'blocked' | 'ready' | 'running' | 'done' | 'error'

export type MigrateBlocker =
  | { kind: 'no-balance' }
  | { kind: 'zero-supply' } // v2 needs its first swap-mint (buy) before in-kind entry
  | { kind: 'missing-legs'; legs: LegReserve[] } // nothing to fund the added legs with
  | { kind: 'no-delta-config'; legs: LegReserve[] } // added legs need the Uniswap router/quoter configured
  | { kind: 'no-route'; legs: LegReserve[] } // no V3/WETH pool found for these legs
  | { kind: 'dust' }

export type MigrateStage = 'redeem' | 'delta' | 'approve' | 'mint'

export interface MigrateResult {
  shares: bigint
  mintHash: Hex
}

export function useMigrate(fromAddr: string, toAddr: string, chainId: number, open: boolean) {
  const cfg = chainCfg(chainId)
  const dep = deploymentFor(chainId)
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()

  const [phase, setPhase] = useState<MigratePhase>('idle')
  const [blocker, setBlocker] = useState<MigrateBlocker | null>(null)
  const [plan, setPlan] = useState<MigratePlanView | null>(null)
  const [amount, setAmountState] = useState<bigint>(0n)
  const [stage, setStage] = useState<MigrateStage>('redeem')
  const [approveProgress, setApproveProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 })
  const [deltaProgress, setDeltaProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 })
  const [txs, setTxs] = useState<Record<string, MigrateTxState>>({})
  const [result, setResult] = useState<MigrateResult | null>(null)
  // Constituents still in the wallet after the mint (overlap excess, delta
  // rounding, WETH dust) — the leftover the sweep offers to clear. Measured once
  // at done from the same before/after balance machinery, never re-derived.
  const [residue, setResidue] = useState<ResidueToken[]>([])
  const [error, setError] = useState<string | null>(null)

  // DEV fixture pair → the plan is a synthesized display-only preview (no
  // contracts exist to read or migrate). Blocks execute; the modal says so.
  const [preview, setPreview] = useState(false)
  const previewRef = useRef(false)

  // Redeem survives a failed later step — resume skips it (shares already burned).
  const redeemDoneRef = useRef(false)
  // Measured per-leg redeem deliveries for EVERY v1 leg (lowercased asset → raw
  // delta). Dropped legs read it for sell sizing; the rebalance delta reads the
  // overlap legs for its migration-scoped budget.
  const redeemReceivedRef = useRef<Map<string, bigint> | null>(null)
  // Wallet balances of every involved constituent BEFORE the flow's first tx —
  // scopes the done-state residue to what THIS migration left behind, so the
  // sweep never offers pre-existing holdings by default (owner decision
  // 2026-07-05). Captured once per flow; survives resume.
  const preFlowBalancesRef = useRef<Map<string, bigint> | null>(null)
  const deltaDoneRef = useRef(false)
  const planRef = useRef<MigratePlanView | null>(null)
  const runningRef = useRef(false)

  const walletReady = isConnected && walletChainId === chainId
  const enabled = TRADING_ENABLED && walletReady

  const patchTx = useCallback((key: string, p: Partial<MigrateTxState>) => {
    setTxs((s) => ({ ...s, [key]: { ...(s[key] ?? TX_IDLE), ...p } }))
  }, [])
  const txOf = useCallback((key: string): MigrateTxState => txs[key] ?? TX_IDLE, [txs])

  const readSnapshot = useCallback(
    async (basket: Address): Promise<BasketSnapshot> => {
      const client = clientFor(chainId)
      const [len, decimals, effectiveSupply, feeBps] = await Promise.all([
        client.readContract({ address: basket, abi: basketAbi, functionName: 'basketLength' }),
        client.readContract({ address: basket, abi: basketAbi, functionName: 'decimals' }),
        client.readContract({ address: basket, abi: basketAbi, functionName: 'effectiveSupply' }),
        client.readContract({ address: basket, abi: basketAbi, functionName: 'basketFeeBps' }),
      ])
      const entries = await Promise.all(
        Array.from({ length: Number(len) }, (_, i) =>
          client.readContract({ address: basket, abi: basketAbi, functionName: 'basket', args: [BigInt(i)] }),
        ),
      )
      const legs = await Promise.all(
        // BASKET_ENTRY tuple order: (asset, venue, ethPool, v3Fee, v2Pair, weight, decimals)
        entries.map(async (e): Promise<SnapLeg> => {
          const asset = e[0] as Address
          const [held, symbol] = await Promise.all([
            client.readContract({ address: basket, abi: basketAbi, functionName: 'idleHeld', args: [asset] }),
            client
              .readContract({ address: asset, abi: erc20SymbolAbi, functionName: 'symbol' })
              .catch(() => asset.slice(0, 6)),
          ])
          return { asset, symbol, decimals: Number(e[6]), idleHeld: held, weight: Number(e[5]) }
        }),
      )
      return { address: basket, decimals: Number(decimals), effectiveSupply, feeBps: Number(feeBps), legs }
    },
    [chainId],
  )

  const walletBalances = useCallback(
    async (holder: Address, assets: Address[]): Promise<Map<string, bigint>> => {
      const client = clientFor(chainId)
      const balances = await Promise.all(
        assets.map((a) =>
          client.readContract({ address: a, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [holder] }),
        ),
      )
      return new Map(assets.map((a, i) => [a.toLowerCase(), balances[i]]))
    },
    [chainId],
  )

  /** Quote the delta trade for the plan preview: sell each dropped leg → WETH,
   *  split the pot by the added legs' target weights, quote each buy. Returns
   *  the preview + augmented availability, or the legs that couldn't route. */
  const quoteDelta = useCallback(
    async (
      to: BasketSnapshot,
      dropped: { leg: SnapLeg; out: bigint }[],
      missing: LegReserve[],
      available: Map<string, bigint>,
    ): Promise<{ delta: DeltaPreview; available: Map<string, bigint> } | { unroutable: LegReserve[] }> => {
      const client = clientFor(chainId)
      const weth = dep.weth!
      const quoter = dep.uniV3Quoter!
      const wethLow = weth.toLowerCase()

      const unroutable: LegReserve[] = []
      const sells: DeltaSellPreview[] = []
      let pot = 0n

      for (const { leg, out } of dropped) {
        if (out === 0n) continue
        if (leg.asset.toLowerCase() === wethLow) {
          pot += out // already the hub — no swap
          continue
        }
        const q = await bestExactInTier(client, quoter, leg.asset, weth, out)
        if (!q) {
          unroutable.push(leg)
          continue
        }
        sells.push({ leg, amountIn: out, fee: q.fee, quotedWeth: q.amount })
        pot += q.amount
      }

      // How much of each added leg the mint actually needs: sized off the legs
      // the redemption CAN fund (the funded-side max), minus the drift buffer.
      const funded = maxSharesOverFunded(to.legs, to.effectiveSupply, to.feeBps, available)
      const target = mulDivDown(funded, BPS - DRIFT_BUFFER_BPS, BPS)
      if (target === 0n) return { unroutable: missing }

      const missingSnap = to.legs.filter((l) => missing.some((m) => m.asset.toLowerCase() === l.asset.toLowerCase()))
      const budgets = splitPotByWeight(pot, missingSnap.map((l) => l.weight))
      const buys: DeltaBuyPreview[] = []
      const augmented = new Map(available)

      for (const [i, leg] of missingSnap.entries()) {
        const budget = budgets[i]
        if (leg.asset.toLowerCase() === wethLow) {
          // The added leg IS the hub — its pot share needs no swap.
          augmented.set(wethLow, (augmented.get(wethLow) ?? 0n) + budget)
          continue
        }
        if (budget === 0n) {
          unroutable.push(leg)
          continue
        }
        const needed = recvForShares(target, to.feeBps, to.effectiveSupply, leg.idleHeld)
        const outQ = needed > 0n ? await bestExactOutTier(client, quoter, weth, leg.asset, needed) : null
        if (outQ && maxInFor(outQ.amount) <= budget) {
          buys.push({ leg, budget, fee: outQ.fee, quotedOut: needed, mode: 'exact-out' })
          augmented.set(leg.asset.toLowerCase(), (augmented.get(leg.asset.toLowerCase()) ?? 0n) + needed)
          continue
        }
        const inQ = await bestExactInTier(client, quoter, weth, leg.asset, budget)
        if (!inQ) {
          unroutable.push(leg)
          continue
        }
        buys.push({ leg, budget, fee: inQ.fee, quotedOut: inQ.amount, mode: 'exact-in' })
        augmented.set(leg.asset.toLowerCase(), (augmented.get(leg.asset.toLowerCase()) ?? 0n) + inQ.amount)
      }

      if (unroutable.length > 0) return { unroutable }
      return { delta: { sells, buys, potWeth: pot }, available: augmented }
    },
    [chainId, dep.uniV3Quoter, dep.weth],
  )

  /** Quote + plan the REBALANCE delta (the generalized delta trade): price every
   *  v2 leg to WETH, size each deposit to the balanced target across ALL the
   *  migration's proceeds, and derive the physical sells/buys the one-tx multihop
   *  batch executes. MIGRATION-SCOPED by design — `proceeds` is what the redeem
   *  delivered per v2 leg (never the holder's broader wallet balance), and the
   *  dropped legs' sale value joins as the extra WETH budget. Returns null when
   *  any leg can't be priced/planned — the caller falls back to the legacy
   *  dropped→added delta, so this path can only improve on it, never strand it. */
  const quoteRebalance = useCallback(
    async (
      to: BasketSnapshot,
      proceeds: ReadonlyMap<string, bigint>,
      dropped: { leg: SnapLeg; amount: bigint }[],
    ): Promise<{
      plan: RebalancePlan
      preview: DeltaPreview
      /** What the batch actually sells: every dropped leg + each over-target v2 leg.
       *  fee = the leg→WETH tier (null when the leg IS WETH — no swap hop). */
      physicalSells: { leg: SnapLeg; amount: bigint; fee: number | null }[]
      /** Under-target v2 legs with their WETH budgets. fee = the WETH→leg tier
       *  (null when the leg IS WETH). */
      buys: { leg: SnapLeg; wethBudget: bigint; fee: number | null; quotedOut: bigint }[]
      /** Projected acquisition per bought leg (lowercased asset → raw amount). */
      expectedOut: Map<string, bigint>
    } | null> => {
      if (!dep.uniV3SwapRouter || !dep.uniV3Quoter || !dep.weth) return null
      const client = clientFor(chainId)
      const weth = dep.weth
      const quoter = dep.uniV3Quoter
      const wethLow = weth.toLowerCase()
      const E18 = 10n ** 18n

      // Dropped legs: their WETH value is the budget's extra pot (+ sell tiers).
      let extra = 0n
      const sellFee = new Map<string, number>()
      const dropPreviews: DeltaSellPreview[] = []
      for (const { leg, amount } of dropped) {
        if (amount === 0n) continue
        if (leg.asset.toLowerCase() === wethLow) {
          extra += amount // already the hub — no swap
          continue
        }
        const q = await bestExactInTier(client, quoter, leg.asset, weth, amount)
        if (!q || q.amount === 0n) return null
        sellFee.set(leg.asset.toLowerCase(), q.fee)
        dropPreviews.push({ leg, amountIn: amount, fee: q.fee, quotedWeth: q.amount })
        extra += q.amount
      }

      // Price every v2 leg in WETH: value what the migration holds of it
      // (avail > 0), or probe the buy direction for a leg it holds none of.
      const probeWeth = extra > 0n ? extra : 10n ** 16n // realistic size, else 0.01 WETH
      const rlegs: RebalanceLegInput[] = []
      for (const l of to.legs) {
        const low = l.asset.toLowerCase()
        const avail = proceeds.get(low) ?? 0n
        if (low === wethLow) {
          rlegs.push({ asset: l.asset, symbol: l.symbol, decimals: l.decimals, idleHeld: l.idleHeld, avail, priceE18: E18 })
          continue
        }
        if (avail > 0n) {
          const q = await bestExactInTier(client, quoter, l.asset, weth, avail)
          if (!q || q.amount === 0n) return null
          sellFee.set(low, q.fee)
          rlegs.push({ asset: l.asset, symbol: l.symbol, decimals: l.decimals, idleHeld: l.idleHeld, avail, priceE18: mulDivDown(q.amount, E18, avail) })
        } else {
          const q = await bestExactInTier(client, quoter, weth, l.asset, probeWeth)
          if (!q || q.amount === 0n) return null
          rlegs.push({ asset: l.asset, symbol: l.symbol, decimals: l.decimals, idleHeld: l.idleHeld, avail: 0n, priceE18: mulDivDown(probeWeth, E18, q.amount) })
        }
      }

      const plan = planRebalance(rlegs, to.effectiveSupply, to.feeBps, extra)
      if (!plan.ok) return null
      // Nothing under target → the whole exercise buys nothing; let the plain
      // path stand (the caller's gain check would reject it anyway).
      if (plan.buys.length === 0) return null

      const legByAddr = new Map(to.legs.map((l) => [l.asset.toLowerCase(), l]))
      // Buys: quote each WETH budget at its REAL size (tier + expected fill).
      const buys: { leg: SnapLeg; wethBudget: bigint; fee: number | null; quotedOut: bigint }[] = []
      const buyPreviews: DeltaBuyPreview[] = []
      const expectedOut = new Map<string, bigint>()
      for (const b of plan.buys) {
        const low = b.asset.toLowerCase()
        const leg = legByAddr.get(low)
        if (!leg || b.wethBudget === 0n) continue // dust deficit — the buffer absorbs it
        if (low === wethLow) {
          buys.push({ leg, wethBudget: b.wethBudget, fee: null, quotedOut: b.wethBudget })
          buyPreviews.push({ leg, budget: b.wethBudget, fee: 0, quotedOut: b.wethBudget, mode: 'exact-in' })
          expectedOut.set(low, b.wethBudget)
          continue
        }
        const q = await bestExactInTier(client, quoter, weth, leg.asset, b.wethBudget)
        if (!q || q.amount === 0n) return null
        buys.push({ leg, wethBudget: b.wethBudget, fee: q.fee, quotedOut: q.amount })
        buyPreviews.push({ leg, budget: b.wethBudget, fee: q.fee, quotedOut: q.amount, mode: 'exact-in' })
        expectedOut.set(low, q.amount)
      }
      if (buys.length === 0) return null

      // Physical sells = every dropped leg + each over-target v2 leg.
      const physicalSells: { leg: SnapLeg; amount: bigint; fee: number | null }[] = dropped
        .filter((d) => d.amount > 0n)
        .map((d) => ({ leg: d.leg, amount: d.amount, fee: d.leg.asset.toLowerCase() === wethLow ? null : (sellFee.get(d.leg.asset.toLowerCase()) ?? null) }))
      const surplusPreviews: DeltaSellPreview[] = []
      let pot = extra
      for (const s of plan.sells) {
        const low = s.asset.toLowerCase()
        const leg = legByAddr.get(low)
        if (!leg) continue
        const isWeth = low === wethLow
        const rleg = rlegs.find((r) => r.asset.toLowerCase() === low)
        const value = rleg ? mulDivDown(s.amount, rleg.priceE18, E18) : 0n
        physicalSells.push({ leg, amount: s.amount, fee: isWeth ? null : (sellFee.get(low) ?? null) })
        surplusPreviews.push({ leg, amountIn: s.amount, fee: isWeth ? 0 : (sellFee.get(low) ?? 0), quotedWeth: value })
        pot += value
      }
      // A non-WETH sell must carry its tier (priced above); bail rather than guess.
      if (physicalSells.some((s) => s.fee === null && s.leg.asset.toLowerCase() !== wethLow)) return null

      // Full migrated value (priced) — pot/total = the swapped share of the move.
      const totalValueWeth = rlegs.reduce((s, l) => s + mulDivDown(l.avail, l.priceE18, E18), 0n) + extra
      const preview: DeltaPreview = { sells: [...dropPreviews, ...surplusPreviews], buys: buyPreviews, potWeth: pot, totalValueWeth }
      return { plan, preview, physicalSells, buys, expectedOut }
    },
    [chainId, dep.uniV3Quoter, dep.uniV3SwapRouter, dep.weth],
  )

  /** Read both baskets + holder state, build the preview plan. `amountRaw`
   *  defaults to the full v1 balance. Availability projects the redeem outputs
   *  ON TOP of what the wallet already holds of each v2 leg. */
  const buildPlan = useCallback(
    async (
      holder: Address,
      amountRaw?: bigint,
    ): Promise<{ view: MigratePlanView; blocker: MigrateBlocker | null }> => {
      const client = clientFor(chainId)
      const [from, to, fromBalance] = await Promise.all([
        readSnapshot(fromAddr as Address),
        readSnapshot(toAddr as Address),
        client.readContract({
          address: fromAddr as Address,
          abi: erc20BalanceAbi,
          functionName: 'balanceOf',
          args: [holder],
        }),
      ])
      const amt = amountRaw !== undefined && amountRaw > 0n && amountRaw <= fromBalance ? amountRaw : fromBalance

      const redeem = planRedeem(from.legs, from.effectiveSupply, from.feeBps, amt)
      const held = await walletBalances(holder, to.legs.map((l) => l.asset))

      // availability = current wallet balance + what the redeem will hand over
      let available = new Map(held)
      for (const { leg, out } of redeem.outs) {
        const k = leg.asset.toLowerCase()
        if (available.has(k)) available.set(k, (available.get(k) ?? 0n) + out)
      }

      const toSet = new Set(to.legs.map((l) => l.asset.toLowerCase()))
      const dropped = redeem.outs
        .filter(({ leg }) => !toSet.has(leg.asset.toLowerCase()))
        .map(({ leg, out }) => ({ leg: leg as SnapLeg, out }))

      let mint = planMint(to.legs, to.effectiveSupply, to.feeBps, available)
      let delta: DeltaPreview | null = null
      let deltaKind: MigratePlanView['deltaKind']

      let blocked: MigrateBlocker | null = null
      if (fromBalance === 0n && !redeemDoneRef.current) blocked = { kind: 'no-balance' }
      else if (to.effectiveSupply === 0n) blocked = { kind: 'zero-supply' }
      else {
        // ── REBALANCE delta first (new): balanced-target across every leg, sized
        //    to the migration's proceeds only. Adopted only when it mints
        //    meaningfully more than the plain path; any failure falls through to
        //    the legacy logic below unchanged. ──
        if (MIGRATE_REBALANCE_ENABLED && dep.uniV3SwapRouter && dep.uniV3Quoter && dep.weth) {
          const proceeds = new Map<string, bigint>()
          for (const { leg, out } of redeem.outs) {
            const k = leg.asset.toLowerCase()
            if (toSet.has(k) && out > 0n) proceeds.set(k, out)
          }
          const r = await quoteRebalance(
            to,
            proceeds,
            dropped.map((d) => ({ leg: d.leg, amount: d.out })),
          ).catch(() => null)
          if (r) {
            const plainTarget = mint.ok ? mint.targetShares : 0n
            if (r.plan.targetShares * BPS > plainTarget * (BPS + REBALANCE_MIN_GAIN_BPS)) {
              // Project the post-delta wallet: sold v2 surplus leaves, buys arrive.
              const projected = new Map(available)
              for (const s of r.physicalSells) {
                const k = s.leg.asset.toLowerCase()
                if (!toSet.has(k)) continue // dropped legs aren't mint inputs
                const cur = projected.get(k) ?? 0n
                projected.set(k, cur > s.amount ? cur - s.amount : 0n)
              }
              for (const [k, out] of r.expectedOut) projected.set(k, (projected.get(k) ?? 0n) + out)
              const rMint = planMint(to.legs, to.effectiveSupply, to.feeBps, projected)
              if (rMint.ok) {
                delta = r.preview
                available = projected
                mint = rMint
                deltaKind = 'rebalance'
              }
            }
          }
        }
        if (deltaKind !== 'rebalance') {
          if (mint.missing.length > 0) {
            const fundable = dropped.some((d) => d.out > 0n)
            if (!fundable) blocked = { kind: 'missing-legs', legs: mint.missing }
            else if (!dep.uniV3SwapRouter || !dep.uniV3Quoter || !dep.weth)
              blocked = { kind: 'no-delta-config', legs: mint.missing }
            else {
              const q = await quoteDelta(to, dropped, mint.missing, available)
              if ('unroutable' in q) blocked = { kind: 'no-route', legs: q.unroutable }
              else {
                delta = q.delta
                deltaKind = 'legacy'
                available = q.available
                mint = planMint(to.legs, to.effectiveSupply, to.feeBps, available)
                if (!mint.ok) blocked = { kind: 'dust' }
              }
            }
          } else if (!mint.ok) blocked = { kind: 'dust' }
        }
      }

      const view: MigratePlanView = { from, to, fromBalance, redeem, mint, delta, deltaKind, dropped }
      return { view, blocker: blocked }
    },
    [chainId, dep.uniV3Quoter, dep.uniV3SwapRouter, dep.weth, fromAddr, quoteDelta, quoteRebalance, readSnapshot, toAddr, walletBalances],
  )

  const refreshPlan = useCallback(
    async (amountRaw?: bigint) => {
      if (!address) return
      setPhase('planning')
      setError(null)
      // DEV demo baskets first: no contracts exist, so the real planner's reads
      // would revert ("balanceOf returned no data") and flip the summary to the
      // error stepper (owner report 2026-07-06). The fixture supplies a
      // consistent display-only plan instead; execute stays preview-blocked.
      if (import.meta.env.DEV) {
        try {
          const { devMigratePreview } = await import('./dev-fixture')
          const p = devMigratePreview(fromAddr, toAddr, chainId, amountRaw)
          if (p) {
            planRef.current = p
            previewRef.current = true
            setPreview(true)
            setPlan(p)
            setBlocker(null)
            setAmountState(amountRaw !== undefined && amountRaw <= p.fromBalance ? amountRaw : p.fromBalance)
            setPhase('ready')
            return
          }
        } catch {
          /* not a fixture pair — the real planner below decides */
        }
      }
      try {
        const { view, blocker: b } = await buildPlan(address, amountRaw)
        planRef.current = view
        setPlan(view)
        setBlocker(b)
        setAmountState(amountRaw !== undefined && amountRaw <= view.fromBalance ? amountRaw : view.fromBalance)
        setPhase(b ? 'blocked' : 'ready')
      } catch (e) {
        setError(messageOf(e))
        setPhase('error')
      }
    },
    [address, buildPlan, chainId, fromAddr, toAddr],
  )

  // Plan on open (and when the wallet/chain changes while open).
  useEffect(() => {
    if (!open || !address) return
    if (runningRef.current) return
    void refreshPlan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, address, chainId, fromAddr, toAddr])

  const setAmount = useCallback(
    (amountRaw: bigint) => {
      if (runningRef.current) return
      void refreshPlan(amountRaw)
    },
    [refreshPlan],
  )

  /** Run (or resume) the migration. Each tx is simulated before the wallet prompt. */
  const execute = useCallback(async () => {
    // Hard stop, independent of UI gating — keep through every refactor.
    if (!TRADING_ENABLED) {
      setError('Trading is disabled on this build (VITE_ENABLE_TRADING).')
      return
    }
    if (previewRef.current) {
      setError('Demo basket — preview only; there are no contracts to migrate.')
      return
    }
    if (!address || !walletReady || !publicClient) {
      setError(`Connect a wallet on ${cfg.name} to migrate.`)
      return
    }
    if (runningRef.current) return
    const current = planRef.current
    if (!current) return
    runningRef.current = true
    setPhase('running')
    setError(null)

    try {
      const client = clientFor(chainId)
      const holder = address
      const toBasket = current.to.address
      // referral (audit 2026-07-07): a referred upgrade tags the interface slice to
      // the referrer too, consistent with buys/sells/sweeps; self-ref suppressed.
      const frontend = (getStoredRef(address) ?? INTERFACE_TAG_ADDRESS ?? ZERO_ADDRESS) as Address
      const droppedLegs = current.dropped.map((d) => d.leg)

      // Residue universe: every constituent either side touches (+ WETH dust).
      // Baseline it BEFORE the first tx so the done state can tell "left behind
      // by this migration" apart from balances the holder already had.
      const residueMeta = new Map<string, { address: Address; symbol: string; decimals: number }>()
      for (const l of [...current.from.legs, ...current.to.legs]) {
        residueMeta.set(l.asset.toLowerCase(), { address: l.asset, symbol: l.symbol, decimals: l.decimals })
      }
      if (dep.weth) {
        const w = dep.weth.toLowerCase()
        if (!residueMeta.has(w)) residueMeta.set(w, { address: dep.weth, symbol: 'WETH', decimals: 18 })
      }
      const residueAssets = [...residueMeta.values()]
      if (!redeemDoneRef.current && preFlowBalancesRef.current === null) {
        preFlowBalancesRef.current = await walletBalances(holder, residueAssets.map((a) => a.address))
      }

      // ── 1. redeemInKind (skipped on resume — the shares are already burned) ──
      if (!redeemDoneRef.current) {
        setStage('redeem')
        const mask = current.from.legs.map(() => true)
        // Measure what the redeem delivers for EVERY v1 leg (dropped-leg sell
        // sizing + the rebalance delta's migration-scoped budget).
        const fromAssets = current.from.legs.map((l) => l.asset)
        const before = await walletBalances(holder, fromAssets)
        patchTx('redeem', { status: 'signing', error: null })
        await publicClient.simulateContract({
          account: holder,
          address: current.from.address,
          abi: basketAbi,
          functionName: 'redeemInKind',
          args: [amount, mask, holder],
        })
        const hash = await writeContractAsync({
          address: current.from.address,
          abi: basketAbi,
          functionName: 'redeemInKind',
          args: [amount, mask, holder],
          chainId,
        })
        patchTx('redeem', { status: 'confirming', hash })
        await publicClient.waitForTransactionReceipt({ hash })
        patchTx('redeem', { status: 'success' })
        redeemDoneRef.current = true
        const after = await walletBalances(holder, fromAssets)
        redeemReceivedRef.current = new Map(
          current.from.legs.map((l) => {
            const k = l.asset.toLowerCase()
            return [k, (after.get(k) ?? 0n) - (before.get(k) ?? 0n)]
          }),
        )
      }

      // ── 2. fresh state → the delta trade: REBALANCE to the balanced target
      //    (new; migration-scoped), falling back to the legacy dropped→added
      //    trade whenever the rebalance can't price or isn't worth its swaps. ──
      let to = await readSnapshot(toBasket)
      let available = await walletBalances(holder, to.legs.map((l) => l.asset))
      let mint = planMint(to.legs, to.effectiveSupply, to.feeBps, available)

      if (!deltaDoneRef.current) {
        const routerOk = !!(dep.uniV3SwapRouter && dep.uniV3Quoter && dep.weth)

        // Dropped-leg sell sizing: measured redeem deliveries; wallet balance on a resumed run.
        const sellable = await Promise.all(
          droppedLegs.map(async (l) => {
            const k = l.asset.toLowerCase()
            const measured = redeemReceivedRef.current?.get(k)
            if (measured !== undefined) return { leg: l, amount: measured }
            const bal = await client.readContract({
              address: l.asset,
              abi: erc20BalanceAbi,
              functionName: 'balanceOf',
              args: [holder],
            })
            return { leg: l, amount: bal }
          }),
        )
        const dropSells = sellable.filter((s) => s.amount > 0n)

        // ── ONE-TRANSACTION DELTA (both shapes): every (sold → bought) pair
        //    becomes a multihop exactInput through the WETH hub (C→WETH→D; 1-hop
        //    when either side IS WETH), batched via the router's native multicall.
        //    Each sub-swap pulls its own tokenIn from the holder and pays the
        //    holder — no intermediate custody, no WETH approve/cleanup round-trip.
        //    Wallet prompts: one exact-amount approval per SOLD asset + one
        //    batched swap tx. The two shapes only differ in WHAT is sold/bought:
        //    • rebalance — sells dropped legs + over-target v2 legs, buys every
        //      under-target leg, allocations proportional to WETH budgets;
        //    • legacy    — sells dropped legs, buys the MISSING legs, allocations
        //      proportional to target weights. ──
        interface SubSwap {
          path: Hex
          amountIn: bigint
          minOut: bigint
          /** The leg this sub-swap BUYS — sizes the up-front deposit approval. */
          outAsset: string
        }
        let batch: { sells: { leg: SnapLeg; amount: bigint }[]; subSwaps: SubSwap[] } | null = null

        // ── (a) the REBALANCE delta (gated + self-limiting; see features.ts) ──
        if (routerOk && MIGRATE_REBALANCE_ENABLED) {
          const toSet = new Set(to.legs.map((l) => l.asset.toLowerCase()))
          const proceeds = new Map<string, bigint>()
          const measured = redeemReceivedRef.current
          if (measured) {
            for (const [k, v] of measured) if (toSet.has(k) && v > 0n) proceeds.set(k, v)
          } else {
            // No measurement in this session (shouldn't happen) — the projected
            // redeem outputs are the honest stand-in.
            for (const { leg, out } of current.redeem.outs) {
              const k = leg.asset.toLowerCase()
              if (toSet.has(k) && out > 0n) proceeds.set(k, out)
            }
          }
          let rebal = await quoteRebalance(to, proceeds, dropSells).catch(() => null)
          if (rebal) {
            const plainTarget = mint.ok ? mint.targetShares : 0n
            if (!(rebal.plan.targetShares * BPS > plainTarget * (BPS + REBALANCE_MIN_GAIN_BPS))) rebal = null
          }
          if (rebal) {
            setStage('delta')
            const weth = dep.weth!
            const wethLow = weth.toLowerCase()
            const quoter = dep.uniV3Quoter!
            const budgets = rebal.buys.map((b) => b.wethBudget)
            const subSwaps: SubSwap[] = []
            for (const s of rebal.physicalSells) {
              const cLow = s.leg.asset.toLowerCase()
              const alloc = splitAmountByBudgets(s.amount, budgets)
              for (const [j, b] of rebal.buys.entries()) {
                const amountIn = alloc[j]
                if (amountIn === 0n) continue
                const dLow = b.leg.asset.toLowerCase()
                if (cLow === wethLow && dLow === wethLow) continue
                const path =
                  cLow === wethLow
                    ? encodeV3Path([weth, b.leg.asset], [b.fee!])
                    : dLow === wethLow
                      ? encodeV3Path([s.leg.asset, weth], [s.fee!])
                      : encodeV3Path([s.leg.asset, weth, b.leg.asset], [s.fee!, b.fee!])
                const quoted = await quoteExactInPath(client, quoter, path, amountIn)
                if (quoted == null || quoted === 0n) {
                  throw new Error(`No fill quoted for ${s.leg.symbol} → ${b.leg.symbol} — trade it manually, then resume.`)
                }
                subSwaps.push({ path, amountIn, minOut: minOutFor(quoted), outAsset: b.leg.asset })
              }
            }
            batch = { sells: rebal.physicalSells, subSwaps }
          }
        }

        // ── (b) the legacy dropped→added delta (unchanged) ──
        if (!batch && !mint.ok && mint.missing.length > 0) {
          if (!routerOk) {
            throw new Error(
              `Missing constituents (${mint.missing.map((l) => l.symbol).join(', ')}) and no Uniswap V3 router/quoter configured for the auto delta trade.`,
            )
          }
          setStage('delta')
          const weth = dep.weth!
          const wethLow = weth.toLowerCase()
          const quoter = dep.uniV3Quoter!
          const sells = dropSells
          const missingSnap = to.legs.filter((l) =>
            mint.missing.some((m) => m.asset.toLowerCase() === l.asset.toLowerCase()),
          )
          const missingWeights = missingSnap.map((l) => l.weight)

          // Tier discovery per hop (quoted at realistic sizes).
          const sellTier = new Map<string, number>()
          let potEstimate = 0n
          for (const s of sells) {
            if (s.leg.asset.toLowerCase() === wethLow) {
              potEstimate += s.amount
              continue
            }
            const q = await bestExactInTier(client, quoter, s.leg.asset, weth, s.amount)
            if (!q) throw new Error(`No V3/WETH route for ${s.leg.symbol} — sell it manually, then resume.`)
            sellTier.set(s.leg.asset.toLowerCase(), q.fee)
            potEstimate += q.amount
          }
          const buyTier = new Map<string, number>()
          const budgets = splitPotByWeight(potEstimate, missingWeights)
          for (const [j, legJ] of missingSnap.entries()) {
            if (legJ.asset.toLowerCase() === wethLow) continue
            const probe = budgets[j] > 0n ? budgets[j] : potEstimate
            const q = await bestExactInTier(client, quoter, weth, legJ.asset, probe)
            if (!q) throw new Error(`No V3/WETH route for ${legJ.symbol} — buy it manually, then resume.`)
            buyTier.set(legJ.asset.toLowerCase(), q.fee)
          }

          // Build + quote the sub-swaps (split each sold leg across the added legs
          // by target weight — the same proportional split the hub flow used).
          const subSwaps: SubSwap[] = []
          for (const s of sells) {
            const cLow = s.leg.asset.toLowerCase()
            const alloc = splitPotByWeight(s.amount, missingWeights)
            for (const [j, legJ] of missingSnap.entries()) {
              const amountIn = alloc[j]
              if (amountIn === 0n) continue
              const dLow = legJ.asset.toLowerCase()
              if (cLow === wethLow && dLow === wethLow) continue
              const path =
                cLow === wethLow
                  ? encodeV3Path([weth, legJ.asset], [buyTier.get(dLow)!])
                  : dLow === wethLow
                    ? encodeV3Path([s.leg.asset, weth], [sellTier.get(cLow)!])
                    : encodeV3Path([s.leg.asset, weth, legJ.asset], [sellTier.get(cLow)!, buyTier.get(dLow)!])
              const quoted = await quoteExactInPath(client, quoter, path, amountIn)
              if (quoted == null || quoted === 0n) {
                throw new Error(`No fill quoted for ${s.leg.symbol} → ${legJ.symbol} — trade it manually, then resume.`)
              }
              subSwaps.push({ path, amountIn, minOut: minOutFor(quoted), outAsset: legJ.asset })
            }
          }
          batch = { sells, subSwaps }
        }

        // ── the batch itself (shared tail): EVERY approval up-front (owner
        //    2026-07-07 13:57: "do all of the approvals before you do the trade"),
        //    then the trade as ONE multicall. Two spenders exist by design —
        //    the router (for the sells) and the new basket (for the deposits) —
        //    so a kept leg like UNI needs one approval to EACH; batching them
        //    here means the wallet asks everything ONCE, in one labeled stage,
        //    and nothing asks again mid-flow. ──
        if (batch) {
          const router02 = dep.uniV3SwapRouter!
          const { sells, subSwaps } = batch
          setStage('approve')

          // (a) sells → the router. FULL wallet balance, not just this delta's
          // amount: the post-migration sweep sells the SAME leftovers through
          // the same router, so no second approval there (owner ask 2026-07-05).
          // Zero-first for USDT-style tokens.
          const sellPlans = await Promise.all(
            sells.map(async (sl) => {
              const [allowance, balance] = await Promise.all([
                client.readContract({ address: sl.leg.asset, abi: erc20ApproveAbi, functionName: 'allowance', args: [holder, router02] }),
                client.readContract({ address: sl.leg.asset, abi: erc20BalanceAbi, functionName: 'balanceOf', args: [holder] }),
              ])
              const want = balance > sl.amount ? balance : sl.amount
              return { key: `sell:${sl.leg.asset.toLowerCase()}`, asset: sl.leg.asset, spender: router02, want, mode: approvalPlan(allowance, want) }
            }),
          )

          // (b) deposits → the new basket, PROJECTED past the trade: current
          // balance + 2× the quoted minOut this delta buys of the leg (real
          // output lands between minOut and the quote, so 2× is a safe ceiling
          // in the same full-balance spirit). Approving before the tokens
          // arrive is fine — allowance is independent of balance.
          const buyOutByLeg = new Map<string, bigint>()
          for (const sw of subSwaps) {
            const k = sw.outAsset.toLowerCase()
            buyOutByLeg.set(k, (buyOutByLeg.get(k) ?? 0n) + sw.minOut)
          }
          const depositBalances = await walletBalances(holder, to.legs.map((l) => l.asset))
          const depositPlans = (
            await Promise.all(
              to.legs.map(async (l) => {
                const k = l.asset.toLowerCase()
                const allowance = await client.readContract({ address: l.asset, abi: erc20ApproveAbi, functionName: 'allowance', args: [holder, toBasket] })
                const projected = (depositBalances.get(k) ?? 0n) + (buyOutByLeg.get(k) ?? 0n) * 2n
                if (projected === 0n) return null
                return { key: `approve:${k}`, asset: l.asset, spender: toBasket, want: projected, mode: approvalPlan(allowance, projected) }
              }),
            )
          ).filter((x): x is NonNullable<typeof x> => x !== null)

          const allPlans = [...sellPlans, ...depositPlans].filter((a) => a.mode !== 'none')
          setApproveProgress({ done: 0, total: allPlans.length })
          for (const [i, a] of allPlans.entries()) {
            const steps: bigint[] = a.mode === 'zero-first' ? [0n, a.want] : [a.want]
            for (const value of steps) {
              patchTx(a.key, { status: 'signing', error: null })
              const h = await writeContractAsync({
                address: a.asset,
                abi: erc20ApproveAbi,
                functionName: 'approve',
                args: [a.spender, value],
                chainId,
              })
              patchTx(a.key, { status: 'confirming', hash: h })
              await publicClient.waitForTransactionReceipt({ hash: h })
            }
            patchTx(a.key, { status: 'success' })
            setApproveProgress({ done: i + 1, total: allPlans.length })
          }

          setStage('delta')
          setDeltaProgress({ done: 0, total: 1 })
          let deltaDone = 0

          // The whole delta in ONE transaction.
          if (subSwaps.length > 0) {
            const datas = subSwaps.map((sw) =>
              encodeFunctionData({
                abi: swapRouter02Abi,
                functionName: 'exactInput',
                args: [{ path: sw.path, recipient: holder, amountIn: sw.amountIn, amountOutMinimum: sw.minOut }],
              }),
            )
            patchTx('delta-swap', { status: 'signing', error: null })
            await publicClient.simulateContract({
              account: holder,
              address: router02,
              abi: swapRouter02Abi,
              functionName: 'multicall',
              args: [datas],
            })
            const h = await writeContractAsync({
              address: router02,
              abi: swapRouter02Abi,
              functionName: 'multicall',
              args: [datas],
              chainId,
            })
            patchTx('delta-swap', { status: 'confirming', hash: h })
            await publicClient.waitForTransactionReceipt({ hash: h })
            patchTx('delta-swap', { status: 'success' })
            deltaDone += 1
            setDeltaProgress({ done: deltaDone, total: 1 })
          }

          deltaDoneRef.current = true
          // fresh state for the mint
          to = await readSnapshot(toBasket)
          available = await walletBalances(holder, to.legs.map((l) => l.asset))
          mint = planMint(to.legs, to.effectiveSupply, to.feeBps, available)
        }
      }

      if (!mint.ok) {
        const missing = mint.missing.map((l) => l.symbol).join(', ')
        throw new Error(
          to.effectiveSupply === 0n
            ? 'The new version has no supply yet — make a small first buy of it (swap-mint), then resume.'
            : mint.missing.length > 0
              ? `Missing constituents for the in-kind mint: ${missing}. Acquire them (or buy the new version directly), then resume.`
              : 'The migratable amount rounds to zero shares.',
        )
      }

      // ── 3. deposit approvals → the v2 basket. On the NO-DELTA path this is
      //    the real approval stage (full wallet balance per leg, owner ask).
      //    After a delta it is a SILENT TOP-UP check: the up-front stage already
      //    approved past the projected buys, so allowances normally cover the
      //    deposit and nothing prompts — a wallet ask here means the trade
      //    out-performed the projection (rare). Zero-first for USDT-style. ──
      if (!deltaDoneRef.current) setStage('approve')
      const [allowances, apprBalances] = await Promise.all([
        Promise.all(
          to.legs.map((l) =>
            client.readContract({ address: l.asset, abi: erc20ApproveAbi, functionName: 'allowance', args: [holder, toBasket] }),
          ),
        ),
        walletBalances(holder, to.legs.map((l) => l.asset)),
      ])
      const pending = to.legs
        .map((l, i) => {
          const bal = apprBalances.get(l.asset.toLowerCase()) ?? 0n
          const needed = bal > mint.amounts[i] ? bal : mint.amounts[i] // full balance, never below the deposit
          return { leg: l, needed, mode: approvalPlan(allowances[i], needed) }
        })
        .filter((a) => a.mode !== 'none')
      // Don't wipe the up-front stage's N-of-M display when nothing is pending.
      if (pending.length > 0 || !deltaDoneRef.current) setApproveProgress({ done: 0, total: pending.length })
      for (const [i, a] of pending.entries()) {
        const key = `approve:${a.leg.asset.toLowerCase()}`
        const steps: bigint[] = a.mode === 'zero-first' ? [0n, a.needed] : [a.needed]
        for (const value of steps) {
          patchTx(key, { status: 'signing', error: null })
          const hash = await writeContractAsync({
            address: a.leg.asset,
            abi: erc20ApproveAbi,
            functionName: 'approve',
            args: [toBasket, value],
            chainId,
          })
          patchTx(key, { status: 'confirming', hash })
          await publicClient.waitForTransactionReceipt({ hash })
        }
        patchTx(key, { status: 'success' })
        setApproveProgress({ done: i + 1, total: pending.length })
      }

      // ── 4. mintInKind — measure the REAL share output via a floor-open
      //    simulate, set the on-chain floor a slippage below the MEASURED value
      //    (same idiom as the sweep compound; planMint's math floor is the
      //    fallback), then broadcast. ──
      setStage('mint')
      patchTx('mint', { status: 'signing', error: null })
      const probe = await publicClient.simulateContract({
        account: holder,
        address: toBasket,
        abi: basketAbi,
        functionName: 'mintInKind',
        args: [mint.amounts, 1n, holder, frontend],
      })
      const measuredShares = typeof probe.result === 'bigint' ? probe.result : 0n
      const minShares =
        measuredShares > 0n ? mulDivDown(measuredShares, BPS - MIN_SHARES_SLIPPAGE_BPS, BPS) : mint.minShares
      const mintArgs = {
        account: holder,
        address: toBasket,
        abi: basketAbi,
        functionName: 'mintInKind' as const,
        args: [mint.amounts, minShares, holder, frontend] as const,
      }
      // Explicit gas — estimator under-shoots the multi-leg in-kind mint (OOG otherwise).
      const mintGas = await gasWithHeadroom(publicClient, mintArgs)
      const mintHash = await writeContractAsync({
        address: toBasket,
        abi: basketAbi,
        functionName: 'mintInKind',
        args: [mint.amounts, minShares, holder, frontend],
        chainId,
        gas: mintGas,
      })
      patchTx('mint', { status: 'confirming', hash: mintHash })
      const receipt = await publicClient.waitForTransactionReceipt({ hash: mintHash })
      const minted = parseEventLogs({ abi: [mintedInKindEvent], logs: receipt.logs }).find(
        (l) => l.args.to?.toLowerCase() === holder.toLowerCase(),
      )
      patchTx('mint', { status: 'success' })
      setResult({ shares: minted?.args.shares ?? minShares, mintHash })

      // ── measure the leftover: any involved constituent still in the wallet
      //    (overlap excess the proportional mint couldn't place, delta rounding,
      //    WETH dust). `amount` = what THIS migration left behind (vs. the
      //    pre-flow baseline) — the sweep's default scope; `walletBalance` = the
      //    full holding, offered behind the panel's opt-in "include everything". ──
      const residueBalances = await walletBalances(holder, residueAssets.map((a) => a.address))
      const baseline = preFlowBalancesRef.current
      setResidue(
        residueAssets
          .map((a) => {
            const k = a.address.toLowerCase()
            const bal = residueBalances.get(k) ?? 0n
            const base = baseline?.get(k) ?? 0n
            // No baseline (shouldn't happen in-session) → honest fallback: full balance.
            const fromFlow = baseline ? (bal > base ? bal - base : 0n) : bal
            return { ...a, amount: fromFlow, walletBalance: bal }
          })
          .filter((r) => (r.walletBalance ?? 0n) > 0n)
          .sort((a, b) => (b.amount === a.amount ? ((b.walletBalance ?? 0n) > (a.walletBalance ?? 0n) ? 1 : -1) : b.amount > a.amount ? 1 : -1)),
      )

      setPhase('done')
      // Refresh every read surface (balances, holdings, portfolio, NAV).
      void queryClient.invalidateQueries()
    } catch (e) {
      const msg = messageOf(e)
      // Mark whichever tx was in flight as errored.
      setTxs((s) => {
        const next = { ...s }
        for (const k of Object.keys(next)) {
          if (next[k].status === 'signing' || next[k].status === 'confirming') {
            next[k] = { ...next[k], status: 'error', error: msg }
          }
        }
        return next
      })
      setError(msg)
      setPhase('error')
    } finally {
      runningRef.current = false
    }
  }, [address, amount, cfg.name, chainId, dep.uniV3Quoter, dep.uniV3SwapRouter, dep.weth, patchTx, publicClient, queryClient, quoteRebalance, readSnapshot, walletBalances, walletReady, writeContractAsync])

  const reset = useCallback(() => {
    if (runningRef.current) return
    redeemDoneRef.current = false
    deltaDoneRef.current = false
    redeemReceivedRef.current = null
    preFlowBalancesRef.current = null
    setTxs({})
    setResult(null)
    setResidue([])
    setError(null)
    setStage('redeem')
    setApproveProgress({ done: 0, total: 0 })
    setDeltaProgress({ done: 0, total: 0 })
    void refreshPlan()
  }, [refreshPlan])

  return {
    enabled,
    walletReady,
    phase,
    blocker,
    plan,
    preview,
    amount,
    setAmount,
    stage,
    approveProgress,
    deltaProgress,
    txOf,
    result,
    residue,
    error,
    redeemDone: redeemDoneRef.current,
    execute,
    reset,
  }
}

function messageOf(e: unknown): string {
  const raw =
    e && typeof e === 'object' && 'shortMessage' in e && typeof e.shortMessage === 'string'
      ? e.shortMessage
      : e instanceof Error
        ? e.message
        : String(e)
  return friendlyRevert(e, raw)
}
