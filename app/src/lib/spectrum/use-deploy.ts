import { useCallback, useRef, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { parseEventLogs, type Address, type Hex } from 'viem'
import { useQueryClient } from '@tanstack/react-query'
import { chainCfg } from '../chain/chains'
import { DEPLOY_ENABLED } from '../config/features'
import { factoryDeployAbi, launchedEvent, type FeeConfigInput } from './abis-v2'
import { friendlyRevert } from './decode-revert'
import { mineSalt } from './salt-mining'
import {
  startSqrtPriceX96ForDollarNav,
  toBasketEntries,
  type DeployAssetInput,
  type DeployBasketEntry,
} from './deploy'

const ZERO = '0x0000000000000000000000000000000000000000' as const

// idle → mining (find the 0x88 salt) → preparing (price + simulate) → ready (safe to
// sign) → signing (wallet prompt) → confirming (mined) → success | error.
export type DeployStatus =
  | 'idle'
  | 'mining'
  | 'preparing'
  | 'ready'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'error'

export interface DeployInput {
  name: string
  symbol: string
  assets: DeployAssetInput[]
  /** whole-% weights aligned with `assets` (the builder's weight model). */
  weights: number[]
  /** The immutable per-basket fee config — CREATE2-committed, so it feeds
   *  the salt miner and predictTokenAddress. Set in the builder's fee step. */
  feeConfig: FeeConfigInput
}

export interface DeployState {
  status: DeployStatus
  /** salt-mining probe count (drives a "mining…" readout). */
  attempts: number
  salt: Hex | null
  predicted: Address | null
  startSqrtPriceX96: bigint | null
  priceWei: bigint | null
  txHash: Hex | null
  /** deployed basket address, parsed from the Launched event. */
  token: Address | null
  error: string | null
}

const INITIAL: DeployState = {
  status: 'idle',
  attempts: 0,
  salt: null,
  predicted: null,
  startSqrtPriceX96: null,
  priceWei: null,
  txHash: null,
  token: null,
  error: null,
}

interface Prepared {
  chainId: number
  factory: Address
  deployer: Address
  name: string
  symbol: string
  basket: DeployBasketEntry[]
  feeConfig: FeeConfigInput
  salt: Hex
  startSqrtPriceX96: bigint
  priceWei: bigint
}

/**
 * Headless launch flow for the basket builder. Two steps so the UI ceremony can
 * play while we mine, then ask for an explicit signature:
 *   • prepare(input) — assemble basket → mine the 0x88 salt → read the
 *     Dutch-auction price → compute the $1.00-NAV start price → simulate (no
 *     broadcast). Lands in 'ready'.
 *   • broadcast()    — sign + send deployBasket, wait for the receipt, parse Launched.
 *
 * `enabled` is false unless DEPLOY_ENABLED and a wallet is connected on the
 * active chain — broadcast() refuses otherwise. Everything else (mining,
 * pricing, simulation) is read-only and safe to run regardless.
 */
export function useDeployBasket(chainId: number) {
  const cfg = chainCfg(chainId) // throws on unsupported chains
  const { address, isConnected, chainId: walletChainId } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()

  const [state, setState] = useState<DeployState>(INITIAL)
  const preparedRef = useRef<Prepared | null>(null)
  const patch = useCallback((p: Partial<DeployState>) => setState((s) => ({ ...s, ...p })), [])

  // Launch requires the dedicated DEPLOY_ENABLED gate — having a wallet, or
  // trading being on, is never enough to arm a deploy.
  const enabled = DEPLOY_ENABLED && isConnected && walletChainId === chainId
  const reset = useCallback(() => {
    preparedRef.current = null
    setState(INITIAL)
  }, [])

  const prepare = useCallback(
    async (input: DeployInput) => {
      const deployer = (address ?? ZERO) as Address
      try {
        preparedRef.current = null
        setState({ ...INITIAL, status: 'mining' })

        const factory = cfg.factory
        const usdc = cfg.usdc
        if (!factory || !usdc) {
          throw new Error(
            'No V2 deployment is configured on this build (deployments.json is empty) — there is nothing to deploy against.',
          )
        }

        const basket = toBasketEntries(input.assets, input.weights)

        const { salt, predicted } = await mineSalt({
          factory,
          chainId,
          basket,
          deployer,
          feeConfig: input.feeConfig,
          onProgress: (attempts) => patch({ attempts }),
        })
        const startSqrtPriceX96 = startSqrtPriceX96ForDollarNav(predicted, usdc)
        patch({ status: 'preparing', salt, predicted, startSqrtPriceX96 })

        // Dutch-auction cost to claim the next slot. Reverts SlotNotOpen() between slots.
        let priceWei: bigint
        try {
          priceWei = await (publicClient ?? throwNoClient()).readContract({
            address: factory,
            abi: factoryDeployAbi,
            functionName: 'currentDeployPrice',
          })
        } catch {
          throw new Error('Auction slot is not open yet — one deploy per slot. Try again in a few blocks.')
        }

        // Dry-run against the live factory + connected account so a doomed deploy
        // fails here, before any signature. Skipped with no wallet.
        if (address && publicClient) {
          // Funds first, in plain numbers: an underfunded deploy otherwise dies
          // as an opaque node/wallet error ("transaction creation failed",
          // 2026-07-07 13:14 — the wallet held 0.021 ETH against a 0.1 ETH
          // auction). ~0.01 ETH headroom covers the ~5.5M-gas deploy.
          const balance = await publicClient.getBalance({ address })
          const gasHeadroomWei = 10_000_000_000_000_000n
          if (balance < priceWei + gasHeadroomWei) {
            const fmt = (wei: bigint) => (Number(wei) / 1e18).toFixed(4)
            throw new Error(
              `Not enough ETH to deploy: this wallet holds ${fmt(balance)} ETH, the deploy needs ${fmt(priceWei)} ETH for the auction slot plus roughly ${fmt(gasHeadroomWei)} for gas. Top up and try again.`,
            )
          }
          await publicClient.simulateContract({
            account: address,
            address: factory,
            abi: factoryDeployAbi,
            functionName: 'deployBasket',
            args: [salt, input.name, input.symbol, basket, startSqrtPriceX96, priceWei, input.feeConfig],
            value: priceWei,
          })
        }

        preparedRef.current = {
          chainId,
          factory,
          deployer,
          name: input.name,
          symbol: input.symbol,
          basket,
          feeConfig: input.feeConfig,
          salt,
          startSqrtPriceX96,
          priceWei,
        }
        patch({ status: 'ready', priceWei })
      } catch (e) {
        patch({ status: 'error', error: messageOf(e) })
      }
    },
    [address, chainId, cfg.factory, cfg.usdc, patch, publicClient],
  )

  const broadcast = useCallback(async () => {
    const p = preparedRef.current
    if (!p) return patch({ status: 'error', error: 'Nothing prepared to deploy. Run prepare() first.' })
    // Hard stop, independent of any UI gating: launching is blocked unless
    // DEPLOY_ENABLED is explicitly set. The last line of defense against an
    // accidental deploy — keep this guard through every refactor.
    if (!DEPLOY_ENABLED) return patch({ status: 'error', error: 'Basket deploy is disabled on this build (set VITE_ENABLE_DEPLOY).' })
    if (!isConnected || walletChainId !== chainId) {
      return patch({ status: 'error', error: `Connect a wallet on ${cfg.name} to deploy.` })
    }
    try {
      patch({ status: 'signing', error: null })
      // maxCost == the price we showed: a tight slippage guard. The Dutch price only
      // falls within a slot, so this lands; if a new slot opened it reverts (no overpay).
      const hash = await writeContractAsync({
        address: p.factory,
        abi: factoryDeployAbi,
        functionName: 'deployBasket',
        args: [p.salt, p.name, p.symbol, p.basket, p.startSqrtPriceX96, p.priceWei, p.feeConfig],
        value: p.priceWei,
        chainId: p.chainId,
      })
      patch({ status: 'confirming', txHash: hash })

      const receipt = await (publicClient ?? throwNoClient()).waitForTransactionReceipt({ hash })
      const launched = parseEventLogs({ abi: [launchedEvent], logs: receipt.logs })
      const token = (launched.find((l) => eqAddr(l.args.deployer, p.deployer))?.args.basket ??
        launched[0]?.args.basket ??
        null) as Address | null
      patch({ status: 'success', token })
      // The list caches enumerate the factory BEFORE this deploy existed — without
      // this, the fresh basket stays invisible in Explore until the poll interval
      // (owner hit it live on Base, 2026-07-09). Same full invalidation the swap
      // path fires; discovery re-enumerates live so the new basket appears at once.
      void queryClient.invalidateQueries()
    } catch (e) {
      patch({ status: 'error', error: messageOf(e) })
    }
  }, [chainId, cfg.name, isConnected, patch, publicClient, queryClient, walletChainId, writeContractAsync])

  return { ...state, enabled, prepare, broadcast, reset }
}

function throwNoClient(): never {
  throw new Error('No RPC client for the active chain.')
}

function eqAddr(a?: string, b?: string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
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
