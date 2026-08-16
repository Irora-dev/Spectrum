import { useCallback, useRef, useState } from 'react'
import { settlementDecimalsFor } from '../chain/deployments'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { erc20Abi, parseEventLogs, parseUnits, type Address, type Hex } from 'viem'
import { useQueryClient } from '@tanstack/react-query'
import { chainCfg } from '../chain/chains'
import { DEPLOY_ENABLED } from '../config/features'
import { factoryDeployAbi, launchedEvent, swapRouterAbi, type FeeConfigInput } from './abis-v2'
import { probeBatchSupport, runBatch, type Eip1193Like } from './batch-calls'
import { friendlyRevert, launchPriceUnavailable } from './decode-revert'
import { quoteBuyLegFills } from './delta-trade'
import { DEFAULT_SLIPPAGE_BPS, encodeMintHookData } from './hook-data'
import { buildLaunchCalls, LAUNCH_BATCH_ATOMIC_REQUIRED } from './launch-batch'
import { firstMintMinOut, launchSplitFromDeployArgs } from './launch-first-mint'
import { getStoredRef } from './referral'
import { mineSalt } from './salt-mining'
import type { MineProgress } from './create2-mine'
import {
  startSqrtPriceX96ForDollarNav,
  toBasketEntries,
  type DeployAssetInput,
  type DeployBasketEntry,
} from './deploy'

const ZERO = '0x0000000000000000000000000000000000000000' as const

// idle → mining (find the 0x88 salt) → preparing (price + simulate) → ready (safe to
// sign) → signing (wallet prompt) → confirming (mined) → seeding (the first deposit,
// only on the two-step path) → success | error.
//
// ⛔ 'success' MEANS THE LAUNCH IS DONE, NOT MERELY DEPLOYED. A basket that exists and
// holds nothing is the window this flow closes: anyone may make its first deposit, and
// on a packing deployment they choose how it splits, so a starved leg costs the next
// honest buyer 57% of their mint (launch-first-mint.ts). The flow only reports success
// once the first deposit has landed, or once it has honestly failed and SAID so.
export type DeployStatus =
  | 'idle'
  | 'mining'
  | 'preparing'
  | 'ready'
  | 'signing'
  | 'confirming'
  | 'seeding'
  | 'success'
  | 'error'

/** The first deposit, as the launch flow collects it. Absent = deploy alone, which
 *  is the pre-existing behaviour and leaves the window open. */
export interface DeploySeedInput {
  /** Settlement dollars the creator is seeding with (already guard-checked by the
   *  launch form — seedVerdictForLaunch / launchSeedReady). */
  depositUsd: number
  /** Slippage tolerance for the first mint's per-leg floors, bps. */
  slippageBps?: number
}

export interface DeployInput {
  name: string
  symbol: string
  assets: DeployAssetInput[]
  /** whole-% weights aligned with `assets` (the builder's weight model). */
  weights: number[]
  /** The immutable per-basket fee config — CREATE2-committed, so it feeds
   *  the salt miner and predictTokenAddress. Set in the builder's fee step. */
  feeConfig: FeeConfigInput
  /** The first deposit, sent in the SAME batch as the deploy where the wallet can
   *  promise atomicity. Omit to deploy alone. */
  seed?: DeploySeedInput | null
}

export interface DeployState {
  status: DeployStatus
  /** salt-mining probe count (drives a "mining…" readout). */
  attempts: number
  /** Live salt-search figures — tries, measured rate, near-misses, the real
   *  candidate addresses the scanner flickers. Null before mining starts. */
  mining: MineProgress | null
  salt: Hex | null
  predicted: Address | null
  startSqrtPriceX96: bigint | null
  priceWei: bigint | null
  txHash: Hex | null
  /** deployed basket address, parsed from the Launched event. */
  token: Address | null
  error: string | null
  /** Whether this wallet will run the launch as ONE all-or-nothing batch on this
   *  chain. `null` = not probed yet (no wallet, or prepare has not run). `false` is
   *  an honest state the creator is TOLD about, never a silent downgrade. */
  canBatch: boolean | null
  /** True when a first deposit rides this launch at all. False = deploy alone. */
  hasSeed: boolean
  /** The first deposit landed. On the batched path this is true the moment the
   *  launch is, because they were the same transaction. */
  seeded: boolean
  /** The first deposit's own transaction on the two-step path. */
  seedTxHash: Hex | null
  /** Why the first deposit did not land, in plain words. The basket is live and the
   *  window is open while this is set, so it is stated, not swallowed. */
  seedError: string | null
}

const INITIAL: DeployState = {
  status: 'idle',
  attempts: 0,
  mining: null,
  salt: null,
  predicted: null,
  startSqrtPriceX96: null,
  priceWei: null,
  txHash: null,
  token: null,
  error: null,
  canBatch: null,
  hasSeed: false,
  seeded: false,
  seedTxHash: null,
  seedError: null,
}

/** The first mint, priced and encoded at prepare time so the batch can carry it. */
interface PreparedSeed {
  amountRaw: bigint
  minOut: bigint
  hookData: Hex
  splitBps: readonly number[]
  router: Address
  settlement: Address
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
  /** null when no deposit was asked for, or when it could not be priced honestly. */
  seed: PreparedSeed | null
}

/**
 * Headless launch flow for the basket builder. Two steps so the UI ceremony can
 * play while we mine, then ask for an explicit signature:
 *   • prepare(input) — assemble basket → mine the 0x88 salt → read the
 *     launch price (currentDeployPrice — a FLAT fee on every deployed factory;
 *     the ABI is unchanged from the auction generation that preceded them) →
 *     compute the $1.00-NAV start price → simulate
 *     (no broadcast) → price + encode the first deposit → probe whether this
 *     wallet can run the launch as one batch. Lands in 'ready'.
 *   • broadcast()    — run the launch. ONE all-or-nothing batch (deploy, approve,
 *     first mint) where the wallet promises atomicity; otherwise deploy, then the
 *     first deposit as the IMMEDIATE next signature, never a later page.
 *
 * ⛔ WHY THE FIRST DEPOSIT IS PART OF LAUNCHING. Between deploying a basket and
 * making its first deposit, anyone else can make that deposit instead, and on a
 * packing deployment the depositor chooses how their money splits across legs. So a
 * griefer can first-mint with a starved leg and the next honest buyer is funded
 * against a composition missing that leg: contracts measured $5,000 of attacker
 * capital turning a $10,000 mint into $4,255, a 57% loss
 * (test/FirstMintStarveEconomics.t.sol; the older "~$40, a nuisance" comment in
 * SpectrumBasket.sol is retracted there). Their named remedy is atomic
 * deploy-plus-first-mint, which does not narrow the window, it removes it.
 *
 * `enabled` is false unless DEPLOY_ENABLED and a wallet is connected on the
 * active chain — broadcast() refuses otherwise. Everything else (mining,
 * pricing, simulation) is read-only and safe to run regardless.
 */
export function useDeployBasket(chainId: number) {
  const cfg = chainCfg(chainId) // throws on unsupported chains
  const { address, isConnected, chainId: walletChainId, connector } = useAccount()
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
          onProgress: (mining) => patch({ attempts: mining.attempts, mining }),
        })
        const startSqrtPriceX96 = startSqrtPriceX96ForDollarNav(predicted, usdc, undefined, settlementDecimalsFor(chainId))
        patch({ status: 'preparing', salt, predicted, startSqrtPriceX96 })

        // The flat launch fee (LAUNCH_FEE_WEI — measured 0.001 ETH on all three
        // deployed factories, 2026-08-13). Its ONE refusal is SlotNotOpen(),
        // reverted while `block.number < lastDeployBlock + 10`.
        //
        // ⛔ A FAILED READ IS NOT EVIDENCE OF A SCHEDULE. This catch used to
        // answer every failure with "Auction slot is not open yet", naming both
        // a mechanism that does not exist on these contracts and a cause it
        // could not know — an unreachable RPC read the same as a real refusal.
        // The factory's own revert is decoded and stated; anything else says
        // only that the price could not be read. Still blocking either way: a
        // deploy never proceeds on an unknown price.
        let priceWei: bigint
        try {
          priceWei = await (publicClient ?? throwNoClient()).readContract({
            address: factory,
            abi: factoryDeployAbi,
            functionName: 'currentDeployPrice',
          })
        } catch (e) {
          throw new Error(launchPriceUnavailable(e))
        }

        // Dry-run against the live factory + connected account so a doomed deploy
        // fails here, before any signature. Skipped with no wallet.
        if (address && publicClient) {
          // Funds first, in plain numbers: an underfunded deploy otherwise dies
          // as an opaque node/wallet error ("transaction creation failed",
          // 2026-07-07 13:14 — the wallet held 0.021 ETH against a 0.1 ETH
          // launch fee). ~0.01 ETH headroom covers the ~5.5M-gas deploy.
          const balance = await publicClient.getBalance({ address })
          const gasHeadroomWei = 10_000_000_000_000_000n
          if (balance < priceWei + gasHeadroomWei) {
            const fmt = (wei: bigint) => (Number(wei) / 1e18).toFixed(4)
            throw new Error(
              `Not enough ETH to deploy: this wallet holds ${fmt(balance)} ETH, the deploy needs ${fmt(priceWei)} ETH for the launch fee plus roughly ${fmt(gasHeadroomWei)} for gas. Top up and try again.`,
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

        // ── the first deposit, priced and encoded HERE so it can ride the same
        // batch as the deploy. Nothing is signed by this; it is quotes and encoding.
        const seed =
          input.seed && address && publicClient
            ? await prepareSeed({
                client: publicClient,
                cfg,
                chainId,
                basket,
                feeBps: input.feeConfig.basketFeeBps,
                holder: address,
                seed: input.seed,
              })
            : null

        // Does this wallet promise all-or-nothing on this chain? Probed, never
        // assumed, and the answer is shown to the creator before they sign
        // (a wallet that cannot is not blocked, it is told — NON_ATOMIC_LAUNCH_NOTE).
        let canBatch: boolean | null = null
        if (seed && address) {
          const provider = (await connector?.getProvider?.().catch(() => undefined)) as Eip1193Like | undefined
          canBatch = provider ? await probeBatchSupport(provider, address, chainId) : false
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
          seed,
        }
        patch({
          status: 'ready',
          priceWei,
          canBatch,
          hasSeed: !!seed,
          // Asked for but not priceable (no route quote for a leg, no configured
          // router). SAID, not swallowed: the launch still works, it just cannot
          // carry the deposit, so the creator needs to know the window will be open
          // and that seeding is the next thing to do.
          seedError:
            input.seed && !seed
              ? 'Your first deposit could not be priced right now, so it cannot go through with the launch. You can make it from the basket page straight after.'
              : null,
        })
      } catch (e) {
        patch({ status: 'error', error: messageOf(e) })
      }
    },
    [address, chainId, cfg, connector, patch, publicClient],
  )

  // The first deposit as its OWN two signatures, for wallets that sign one step at
  // a time. Same three calls the batch carries, same encoding, different transport —
  // there is one construction of this money movement, not two.
  //
  // A failure here is NEVER an error state for the launch: the basket is live, and
  // saying "deploy failed" would be false. It sets `seedError` instead, which the
  // ceremony shows beside a retry, because the window is open until the deposit lands.
  const runSeed = useCallback(
    async (seed: PreparedSeed, token: Address, holder: Address) => {
      try {
        const client = publicClient ?? throwNoClient()
        // ⚠⚠ CHECK THE BALANCE BEFORE THE APPROVAL, AND SAY THE SHORTFALL IN
        // DOLLARS (the owner live 2026-08-15). His Robinhood seed asked for exactly
        // $60.00 from a wallet holding $59.97 — three cents short, because the
        // amount was sized when the bridge was quoted and the arrival landed a
        // hair under. The pull then reverted deep inside the route and surfaced
        // as a bare selector ("swapExactIn reverted with 0x356680b7"), which
        // tells a person nothing and sent this lane chasing pool depth,
        // slippage and floors for an hour.
        //
        // The shortfall is ARITHMETIC WE ALREADY HAVE: the balance is one read
        // beside the allowance read we make anyway, on the same batched
        // transport. There is no excuse for discovering it on chain.
        //
        // It REFUSES rather than quietly seeding the smaller amount: the seed
        // size is what the creator consented to, and buying less of their own
        // basket is a different trade than the one they approved.
        const [allowance, balance] = await Promise.all([
          client.readContract({
            address: seed.settlement,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [holder, seed.router],
          }),
          client.readContract({
            address: seed.settlement,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [holder],
          }),
        ])
        if (balance < seed.amountRaw) {
          const usd = (v: bigint) =>
            `$${(Number(v) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          // THE HOUSE SHORTFALL GRAMMAR ("Needs $X more"), deliberately —
          // thesis-funding.ts speaks it and the run overlay's pay-asset door
          // keys off it, so a shortfall phrased this way is recognisable to the
          // surfaces that can OFFER a way through instead of dead-ending
          // (the owner 2026-08-15: "we should accommodate… rather than throw an
          // error"). Wording it any other way would strand it as prose.
          throw new Error(
            `Needs ${usd(seed.amountRaw - balance)} more to make this deposit. It costs ${usd(seed.amountRaw)} and this wallet holds ${usd(balance)}. Add it, or start the deposit again at the smaller amount.`,
          )
        }
        if (allowance < seed.amountRaw) {
          const approveHash = await writeContractAsync({
            address: seed.settlement,
            abi: erc20Abi,
            functionName: 'approve',
            args: [seed.router, seed.amountRaw],
            chainId,
          })
          await client.waitForTransactionReceipt({ hash: approveHash })
        }
        const hash = await writeContractAsync({
          address: seed.router,
          abi: swapRouterAbi,
          functionName: 'swapExactIn',
          args: [token, seed.settlement, seed.amountRaw, seed.minOut, seed.hookData, holder],
          chainId,
        })
        patch({ seedTxHash: hash })
        await client.waitForTransactionReceipt({ hash })
        patch({ status: 'success', seeded: true, seedError: null })
        void queryClient.invalidateQueries()
      } catch (e) {
        patch({ status: 'success', seeded: false, seedError: messageOf(e) })
      }
    },
    [chainId, patch, publicClient, queryClient, writeContractAsync],
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
    // ── PATH A: one all-or-nothing batch. The window never opens.
    const predicted = state.predicted
    if (p.seed && state.canBatch && address && predicted) {
      const provider = (await connector?.getProvider?.().catch(() => undefined)) as Eip1193Like | undefined
      if (!provider) {
        // The probe said yes and the provider has since gone. Downgrade honestly
        // rather than silently: the next press takes the two-step path, and the
        // ceremony shows what that means before it does.
        return patch({ status: 'ready', canBatch: false })
      }
      patch({ status: 'signing', error: null, seedError: null })
      const calls = buildLaunchCalls(
        {
          factory: p.factory,
          salt: p.salt,
          name: p.name,
          symbol: p.symbol,
          basket: p.basket,
          startSqrtPriceX96: p.startSqrtPriceX96,
          priceWei: p.priceWei,
          feeConfig: p.feeConfig,
        },
        { ...p.seed, basket: predicted, to: address },
      )
      const outcome = await runBatch(provider, address, p.chainId, calls, {
        // NOT optional for this batch: a partial run deploys the basket without
        // minting into it, which IS the window (launch-first-mint.ts). A wallet that
        // will not promise it refuses here rather than half-running the ceremony.
        atomicRequired: LAUNCH_BATCH_ATOMIC_REQUIRED,
        onSent: () => patch({ status: 'confirming' }),
      })
      if (outcome.kind === 'success') {
        // The address is `predicted` and cannot be anything else: deployBasket
        // CREATE2s from the same init code predictTokenAddress hashed, and it reverts
        // BadHookFlags on any address that is not the mined one. A batch that landed
        // therefore landed on exactly this address, and the mint in the same batch
        // proves it (a wrong address has no code, so the mint would have reverted).
        //
        // okCount is still checked: an atomic wallet should never report a short
        // count, and if one does, the deposit is NOT claimed as made. Claiming it
        // wrongly is the one mistake that hides an open window.
        const seeded = outcome.okCount >= calls.length
        patch({
          status: 'success',
          token: predicted,
          seeded,
          seedError: seeded
            ? null
            : 'Your wallet reported that part of the launch did not go through. Check your basket before depositing again.',
        })
        void queryClient.invalidateQueries()
        return
      }
      if (outcome.kind === 'timeout') {
        // The batch may still land. Re-sending would pay a second launch fee and
        // deploy a second basket, so this stops here and says so.
        return patch({
          status: 'error',
          error:
            'Your wallet has not reported back on the launch yet. It may still go through, so do not send it again. Check your wallet, then refresh this page.',
        })
      }
      // failure = declined, or the wallet would not promise all-or-nothing after all.
      // NOT auto-continued into a second prompt: a creator who just declined must not
      // be handed another signature request they did not ask for. The next press
      // takes the two-step path, and NON_ATOMIC_LAUNCH_NOTE is shown before it.
      return patch({
        status: 'ready',
        canBatch: false,
        error: 'Your wallet did not take the launch and your first deposit as one step.',
      })
    }

    // ── PATH B: the wallet signs one step at a time. The deploy is unchanged from
    // before this fix; the first deposit follows it IMMEDIATELY, in this same
    // ceremony, because a separate page is a page the creator may never reach.
    try {
      patch({ status: 'signing', error: null })
      // maxCost == the price we showed: a tight slippage guard. The deployed
      // lineage's fee is a constant, so this lands; a surprise repricing on any
      // future lineage reverts instead of overpaying.
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
      // The list caches enumerate the factory BEFORE this deploy existed — without
      // this, the fresh basket stays invisible in Explore until the poll interval
      // (owner hit it live on Base, 2026-07-09). Same full invalidation the swap
      // path fires; discovery re-enumerates live so the new basket appears at once.
      void queryClient.invalidateQueries()
      if (!p.seed || !token || !address) return patch({ status: 'success', token })
      patch({ status: 'seeding', token })
      await runSeed(p.seed, token, address)
    } catch (e) {
      patch({ status: 'error', error: messageOf(e) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    address,
    chainId,
    cfg.name,
    connector,
    isConnected,
    patch,
    publicClient,
    queryClient,
    runSeed,
    state.canBatch,
    state.predicted,
    walletChainId,
    writeContractAsync,
  ])

  // The first deposit on the two-step path, and the retry when its prompt was
  // declined. Separate from broadcast() so the basket is never deployed twice: by
  // the time this runs, it exists.
  const seedNow = useCallback(async () => {
    const p = preparedRef.current
    if (!p?.seed || !state.token || !address) return
    patch({ status: 'seeding', seedError: null })
    await runSeed(p.seed, state.token, address)
  }, [address, patch, runSeed, state.token])

  return { ...state, enabled, prepare, broadcast, seedNow, reset }
}

/**
 * Price and encode the first deposit BEFORE the basket exists, so it can travel in
 * the same batch as the deploy.
 *
 * ⛔ THE SPLIT COMES FROM THE DEPLOY ARGUMENTS, and that is the whole justification:
 * the factory abi.encodes this exact BasketEntry array (weights and all) into the
 * init code it CREATE2s from, so the address being created is a function of these
 * weights. The split is therefore bound to the basket it funds, in one transaction,
 * signed by the person whose money it is. `launchSplitFromDeployArgs` is the only
 * producer of that funding case and applies the same normalisation as the
 * read-off-the-basket path (first-mint-split.ts).
 *
 * ⛔ THE PER-LEG FLOORS ARE LIVE ROUTE QUOTES, not weights and not spot. The
 * contract calls the mandatory non-zero legMins "the ONLY guarantee against a
 * price-pump sandwich" at the first mint, so they are quoted along the REAL acquire
 * route (settlement to ETH to each leg, fee and impact included), exactly as the
 * seeding path does today. `null` rather than a guess when the hub cannot be quoted:
 * hook-data.ts refuses to encode without live per-leg quotes and there is no basket
 * to simulate against yet, so the launch degrades to the two-step path and says so.
 */
async function prepareSeed(args: {
  client: NonNullable<ReturnType<typeof usePublicClient>>
  cfg: ReturnType<typeof chainCfg>
  chainId: number
  basket: DeployBasketEntry[]
  feeBps: number
  holder: Address
  seed: DeploySeedInput
}): Promise<PreparedSeed | null> {
  const { client, cfg, basket, feeBps, holder, seed } = args
  const { usdc, swapRouter, weth, uniV3Quoter } = cfg
  if (!usdc || !swapRouter || !weth || !uniV3Quoter) return null
  if (!(seed.depositUsd > 0)) return null

  const split = launchSplitFromDeployArgs(basket, basket.length)
  if (!split) return null

  const amountRaw = parseUnits(seed.depositUsd.toString(), settlementDecimalsFor(args.chainId))
  if (amountRaw <= 0n) return null
  // The acquire runs on the NET amount (the basket takes its fee first), so the legs
  // are quoted from net and the aggregate floor is derived from net.
  const netRaw = amountRaw - (amountRaw * BigInt(Math.round(feeBps))) / 10_000n
  const minOut = firstMintMinOut(netRaw)
  if (minOut == null) return null

  const fills = await quoteBuyLegFills(
    client,
    uniV3Quoter,
    usdc,
    weth,
    basket.map((e, i) => ({
      asset: e.asset,
      // The share the payload will really fund this leg with, in percent.
      weightPct: split.splitBps[i] / 100,
      isUsdc: e.asset.toLowerCase() === usdc.toLowerCase(),
      // No basket, so no spot fallback exists. A leg that cannot be quoted stays 0
      // and the encoder refuses below rather than shipping an unprotected floor.
      spotAmount: 0n,
    })),
    netRaw,
  ).catch(() => null)
  if (!fills || fills.length !== basket.length || fills.some((f) => f <= 0n)) return null

  try {
    const { hookData } = encodeMintHookData({
      quotedLegAmounts: fills,
      slippageBps: seed.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      minOut,
      interfaceTag: getStoredRef(holder),
      funding: { source: 'deploy-args-weights', splitBps: split.splitBps },
    })
    return { amountRaw, minOut, hookData, splitBps: split.splitBps, router: swapRouter, settlement: usdc }
  } catch {
    // The encoder refuses rather than degrade (a rounded-zero floor, a split that
    // does not divide the whole buy). Refusing here is the same answer.
    return null
  }
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
