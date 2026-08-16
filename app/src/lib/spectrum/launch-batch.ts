import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { factoryDeployAbi, swapRouterAbi, type FeeConfigInput } from './abis-v2'
import type { BatchCall } from './batch-calls'
import type { DeployBasketEntry } from './deploy'

// ─────────────────────────────────────────────────────────────────────────────
// The atomic launch's CALLS — deploy, approve, first mint, in that order, as one
// list. Pure: no wallet, no network, no React. The transport decides how they
// travel (one EIP-5792 batch where the wallet can promise atomicity, three
// signatures where it cannot); the CALLS are identical either way, which is the
// point — there is one construction of the money movement, not two.
//
// ⛔ THIS BATCH REQUIRES ATOMICITY, and it is the reason `atomicRequired` became a
// parameter at all. The calls are not independent: a partial run that deploys the
// basket and does not mint into it leaves exactly the window this whole change
// closes (launch-first-mint.ts — contracts measured a 57% loss on the victim of
// a starved first mint). A wallet that will not promise all-or-nothing is not a
// wallet to send this to; it takes the honest two-step path and is told why.
//
// ⛔ AND deployBasket IS CALLED EXACTLY AS IT ALWAYS WAS. Same argument tuple, same
// order, same value. Only the transport differs: `wallet_sendCalls` carries
// calldata, so the call is encoded rather than handed to writeContract. Changing an
// argument here would change the CREATE2 address and invalidate the mined salt, so
// this tuple must keep matching use-deploy's sequential broadcast verbatim.
// ─────────────────────────────────────────────────────────────────────────────

/** Never false. Named so the reason survives, and so a test can assert on it
 *  rather than on a literal buried in a request. */
export const LAUNCH_BATCH_ATOMIC_REQUIRED = true

const erc20ApproveAbi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

export interface LaunchDeployCall {
  factory: Address
  salt: Hex
  name: string
  symbol: string
  basket: DeployBasketEntry[]
  startSqrtPriceX96: bigint
  /** maxCost — the price we showed. A surprise repricing reverts rather than overpays. */
  priceWei: bigint
  feeConfig: FeeConfigInput
}

export interface LaunchMintCall {
  router: Address
  settlement: Address
  /** The CREATE2 address the deploy above will produce. Bound to that call's own
   *  arguments, which is what makes the first mint's split honest. */
  basket: Address
  amountRaw: bigint
  minOut: bigint
  hookData: Hex
  to: Address
}

/**
 * The launch, as calls. Approve sits between the two because the router pulls the
 * settlement token from the signer on the mint, and inside one atomic batch the
 * allowance it grants cannot be used by anything else along the way.
 *
 * `mint` omitted returns the deploy alone: the honest degrade when the first
 * deposit could not be priced (no live per-leg quotes means nothing may be
 * encoded — hook-data.ts refuses, by design).
 */
export function buildLaunchCalls(deploy: LaunchDeployCall, mint?: LaunchMintCall | null): BatchCall[] {
  const calls: BatchCall[] = [
    {
      to: deploy.factory,
      value: deploy.priceWei,
      data: encodeFunctionData({
        abi: factoryDeployAbi,
        functionName: 'deployBasket',
        args: [
          deploy.salt,
          deploy.name,
          deploy.symbol,
          deploy.basket,
          deploy.startSqrtPriceX96,
          deploy.priceWei,
          deploy.feeConfig,
        ],
      }),
    },
  ]
  if (!mint) return calls
  calls.push({
    to: mint.settlement,
    data: encodeFunctionData({
      abi: erc20ApproveAbi,
      functionName: 'approve',
      args: [mint.router, mint.amountRaw],
    }),
  })
  calls.push({
    to: mint.router,
    data: encodeFunctionData({
      abi: swapRouterAbi,
      functionName: 'swapExactIn',
      args: [mint.basket, mint.settlement, mint.amountRaw, mint.minOut, mint.hookData, mint.to],
    }),
  })
  return calls
}
