import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
} from 'viem'
import type { clientFor } from '../chain/rpc'
import type { PoolReadyChainCfg } from '../chain/chains'
import { erc20MetaAbi } from './abis'

type Client = ReturnType<typeof clientFor>

// ─────────────────────────────────────────────────────────────────────────────
// Constituent screening — the checks a token must pass BEFORE venue discovery
// even matters. The contracts screen what they can on-chain (ERC-777 reverts in
// the basket constructor via ERC-1820); everything else is explicitly the
// frontend's job per the contracts hand-off ("no fee-on-transfer — FE-screened;
// no rebasing — off-chain exclusion"). This module is that screen.
//
// Every check mirrors an on-chain reality, not a curation opinion:
//   • not-a-contract / decimals() reverts → the factory re-reads decimals at
//     deploy (creators can't lie about them), so the deploy itself would revert.
//     Fail here, before anyone mines a salt or pays auction price.
//   • ERC-777 → the basket constructor rejects via the ERC-1820 registry. Same
//     probe, same registry, run early so the error is readable instead of a
//     revert at broadcast.
//   • Spectrum basket tokens → a basket IS its own V4 hook and its self-pool is
//     USDC-quoted + hooked; nesting one as a leg is never routable. Detected
//     structurally: factory.tokens(asset) returns a non-zero deployer.
//   • fee-on-transfer → silently under-fills legs and can brick a V4 leg
//     (transfer in ≠ balance delta). Detected empirically: a simulated transfer
//     whose received amount is compared to the sent amount (eth_simulateV1 with
//     a state-overridden balance — no real funds, no real state).
//   • rebasing → balance drift breaks share accounting; there is no on-chain
//     signature for it, so a small documented denylist of the famous offenders
//     backstops the empirical probe.
//
// Degradation posture: identity checks (contract / decimals / 777 / basket) are
// HARD — they read deterministic on-chain state, and a failure there is a
// failure of the token, not of our infra. The fee-on-transfer probe is
// BEST-EFFORT: balance-slot discovery is heuristic and eth_simulateV1 may be
// unsupported on a keyless RPC — an inconclusive probe adds nothing rather than
// crying wolf. The denylist stays load-bearing either way.
// ─────────────────────────────────────────────────────────────────────────────

// ERC-1820 registry — same keyless-deploy address on every EVM chain (the
// contracts repo pins the identical constant). If it has no code on a chain,
// the probe concludes "not 777", which matches what the basket ctor would see.
const ERC1820_REGISTRY: Address = '0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24'
const ERC777_TOKEN_HASH = keccak256(stringToHex('ERC777Token'))

const erc1820Abi = parseAbi([
  'function getInterfaceImplementer(address account, bytes32 interfaceHash) view returns (address)',
])

const factoryTokensAbi = parseAbi([
  'function tokens(address) view returns (address deployer)',
])

const erc20TransferAbi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
])

// Probe actors for the transfer simulation — arbitrary, funds never move for real.
const PROBE_SENDER: Address = '0x1000000000000000000000000000000000000001'
const PROBE_RECIPIENT: Address = '0x1000000000000000000000000000000000000002'
// 1e18 raw units: large enough that a bps-scale fee is visible in integer math,
// small enough to never overflow an 18-dec supply.
const PROBE_AMOUNT = 10n ** 18n

// Balance slots are scanned 0..12 — covers vanilla OZ (0), Solmate (varies low),
// USDT (2), USDC-style proxies (9; the override lands on the PROXY's storage,
// which is where delegatecall reads). Namespaced-storage upgradeables won't be
// found → probe is inconclusive → no claim made.
const BALANCE_SLOT_SCAN = 13

/** Known rebasing / fee-on-transfer tokens — the documented backstop, not a census.
 *  Keyed by chainId → lowercase address. Say WHY in the value; the message shows it. */
const DENYLIST: Record<number, Record<string, { kind: 'REBASING' | 'FEE_ON_TRANSFER'; note: string }>> = {
  1: {
    // Lido stETH — balance rebases daily; share accounting drifts under it.
    '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': { kind: 'REBASING', note: 'stETH rebases daily (use wstETH instead)' },
    // Ampleforth — the canonical elastic-supply token.
    '0xd46ba6d942050d489dbd938a2c909a5d5039a161': { kind: 'REBASING', note: 'AMPL is elastic-supply (rebasing)' },
    // NOTE: fee-on-transfer tokens are deliberately NOT listed here — the probe
    // measures the CURRENT fee empirically (e.g. PAXG carries fee *capability*
    // but charges 0% today, live-verified 2026-07-06; a list would wrongly ban
    // it, and would miss the tax token that turns its fee on tomorrow).
  },
  8453: {},
}

export interface TokenScreen {
  /** Deterministic disqualifier — the deploy would revert or the leg can't account.
   *  VENUE_CHECK_FAILED is the one non-verdict: the RPC dropped the check (rate
   *  limit / transport) — retry, never a statement about the token. */
  hardFail: { code: 'NOT_A_CONTRACT' | 'NON_STANDARD' | 'ERC777' | 'SPECTRUM_BASKET' | 'FEE_ON_TRANSFER' | 'REBASING' | 'VENUE_CHECK_FAILED'; message: string } | null
  /** Non-fatal findings, appended to the pool result's warnings. */
  warnings: string[]
  /** decimals() as the chain reports it (only meaningful when hardFail is null). */
  decimals: number
}

/** The CONTRACT refused the call (reverted, or answered with no data) — as opposed
 *  to the RPC failing to deliver it (rate limit, timeout, transport). Only the
 *  former is evidence about the token; a real BNKR on Base was hard-failed as
 *  "non-standard" by a rate-limited public RPC before this split (2026-07-12). */
function isContractRefusal(e: unknown): boolean {
  return (
    e instanceof BaseError &&
    !!e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError)
  )
}

/** Identity screen — cheap deterministic reads, run in parallel with venue discovery. */
export async function screenTokenIdentity(
  client: Client,
  // Only chainId + factory are read — V4-only chains (no WETH/V2/V3 infra) screen too.
  cfg: Pick<PoolReadyChainCfg, 'chainId' | 'factory'>,
  asset: Address,
): Promise<TokenScreen> {
  const lower = asset.toLowerCase()

  const listed = DENYLIST[cfg.chainId]?.[lower]
  if (listed) {
    return {
      hardFail: {
        code: listed.kind,
        message:
          listed.kind === 'REBASING'
            ? `This token can't be a basket leg: ${listed.note}. Rebasing balances break basket share accounting.`
            : `This token can't be a basket leg: ${listed.note}. Fee-on-transfer under-fills the leg on every mint.`,
      },
      warnings: [],
      decimals: 18,
    }
  }

  const [code, decimalsRead, erc777Impl, basketDeployer] = await Promise.all([
    // Distinguish "the chain says there is no code" (hard fail) from "the RPC
    // call failed" (unknown → skip; a dead RPC fails venue discovery anyway).
    client.getCode({ address: asset }).then((c) => c ?? '0x').catch(() => 'RPC_FAILED' as const),
    client
      .readContract({ address: asset, abi: erc20MetaAbi, functionName: 'decimals' })
      .then((d) => ({ ok: true as const, value: Number(d), refusal: false }))
      .catch((e) => ({ ok: false as const, value: 18, refusal: isContractRefusal(e) })),
    client
      .readContract({
        address: ERC1820_REGISTRY,
        abi: erc1820Abi,
        functionName: 'getInterfaceImplementer',
        args: [asset, ERC777_TOKEN_HASH],
      })
      .catch(() => zeroAddress),
    cfg.factory
      ? client
          .readContract({ address: cfg.factory, abi: factoryTokensAbi, functionName: 'tokens', args: [asset] })
          .catch(() => zeroAddress)
      : Promise.resolve(zeroAddress),
  ])

  if (code === '0x') {
    return {
      hardFail: { code: 'NOT_A_CONTRACT', message: 'No contract exists at this address on the selected network.' },
      warnings: [],
      decimals: 18,
    }
  }

  if (basketDeployer && basketDeployer.toLowerCase() !== zeroAddress) {
    return {
      hardFail: {
        code: 'SPECTRUM_BASKET',
        message:
          'This is a Spectrum basket token — baskets are their own V4 hooks and cannot be nested as constituents.',
      },
      warnings: [],
      decimals: decimalsRead.value,
    }
  }

  if (erc777Impl && erc777Impl.toLowerCase() !== zeroAddress) {
    return {
      hardFail: {
        code: 'ERC777',
        message:
          'This is an ERC-777 token — its transfer callbacks are a reentrancy surface, and the basket contract rejects it on-chain.',
      },
      warnings: [],
      decimals: decimalsRead.value,
    }
  }

  if (!decimalsRead.ok) {
    // Only a refusal FROM THE CONTRACT is a verdict on the token. An RPC that
    // dropped the call (rate limit / transport — public endpoints burst-fail
    // under the add-token read storm) must read as "couldn't check, retry":
    // hard-failing a real token here blocks a legitimate launch (BNKR, 2026-07-12).
    if (!decimalsRead.refusal) {
      return {
        hardFail: {
          code: 'VENUE_CHECK_FAILED',
          message: 'Could not verify this token (the RPC dropped the check) — add it again to retry. A rate-limited public endpoint is the usual cause; your own RPC key or URL avoids it.',
        },
        warnings: [],
        decimals: 18,
      }
    }
    return {
      hardFail: {
        code: 'NON_STANDARD',
        message: 'Not a standard ERC-20: decimals() reverted. The deploy itself would revert on this token.',
      },
      warnings: [],
      decimals: 18,
    }
  }
  if (decimalsRead.value > 30) {
    return {
      hardFail: {
        code: 'NON_STANDARD',
        message: `Not a supported ERC-20: ${decimalsRead.value} decimals overflows basket leg math.`,
      },
      warnings: [],
      decimals: decimalsRead.value,
    }
  }

  return { hardFail: null, warnings: [], decimals: decimalsRead.value }
}

/** Find the Solidity mapping slot that backs balanceOf via state-overridden reads. */
async function findBalanceSlot(client: Client, asset: Address, holder: Address): Promise<number | null> {
  const MARK = PROBE_AMOUNT
  const attempts = await Promise.all(
    Array.from({ length: BALANCE_SLOT_SCAN }, (_, slot) =>
      client
        .readContract({
          address: asset,
          abi: erc20MetaAbi,
          functionName: 'balanceOf',
          args: [holder],
          stateOverride: [
            {
              address: asset,
              stateDiff: [
                {
                  slot: keccak256(
                    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, BigInt(slot)]),
                  ),
                  value: toHex(MARK, { size: 32 }),
                },
              ],
            },
          ],
        })
        .then((bal) => (bal === MARK ? slot : null))
        .catch(() => null),
    ),
  )
  return attempts.find((s): s is number => s !== null) ?? null
}

export type TransferProbe =
  | { verdict: 'clean' }
  | { verdict: 'fee-on-transfer'; receivedBps: number }
  | { verdict: 'inconclusive' }

/**
 * Empirical fee-on-transfer probe: give PROBE_SENDER a state-overridden balance,
 * simulate transfer → balanceOf(recipient) in one eth_simulateV1 batch (state
 * persists across the batch, nothing touches the chain), and compare received
 * to sent. Any infra failure → 'inconclusive', never a verdict.
 */
export async function probeTransferFee(client: Client, asset: Address): Promise<TransferProbe> {
  try {
    const slot = await findBalanceSlot(client, asset, PROBE_SENDER)
    if (slot === null) return { verdict: 'inconclusive' }

    const balanceOverride = [
      {
        address: asset,
        stateDiff: [
          {
            slot: keccak256(
              encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [PROBE_SENDER, BigInt(slot)]),
            ),
            value: toHex(PROBE_AMOUNT, { size: 32 }),
          },
        ],
      },
    ]

    const { results } = await client.simulateCalls({
      account: PROBE_SENDER,
      stateOverrides: balanceOverride,
      calls: [
        { to: asset, abi: erc20TransferAbi, functionName: 'transfer', args: [PROBE_RECIPIENT, PROBE_AMOUNT] },
        { to: asset, abi: erc20MetaAbi, functionName: 'balanceOf', args: [PROBE_RECIPIENT] },
      ],
    })

    const [transferRes, balanceRes] = results
    if (transferRes.status !== 'success' || balanceRes.status !== 'success') return { verdict: 'inconclusive' }
    const received = balanceRes.result as bigint
    if (received >= PROBE_AMOUNT) return { verdict: 'clean' }
    // Received less than sent — a transfer fee, measured, not inferred.
    const receivedBps = Number((received * 10_000n) / PROBE_AMOUNT)
    return { verdict: 'fee-on-transfer', receivedBps }
  } catch {
    return { verdict: 'inconclusive' }
  }
}
