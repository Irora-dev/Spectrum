import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeAbiParameters, decodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from 'viem'
import {
  UR_ADDRESS_THIS,
  UR_CMD_V4_SWAP,
  UR_CMD_WRAP_ETH,
  UR_CONTRACT_BALANCE,
  UR_MSG_SENDER,
  V4_ACTION_SETTLE_ALL,
  V4_ACTION_SWAP_EXACT_IN_SINGLE,
  V4_ACTION_TAKE,
  V4_ACTION_TAKE_ALL,
  V4_OPEN_DELTA,
  encodeUrV4SellToWeth,
  encodeUrV4SwapExactInSingle,
  type UrV4PoolKey,
  packV3Path,
  urUsesSixFieldV3,
} from './universal-router'
import { PRISM_POOL_KEY, encodePrismPoolSwap } from '../prism/pool'

// ─────────────────────────────────────────────────────────────────────────────
// PINS for the v4 shapes. Two proofs anchor these tests:
//  · the ERC-20-out shape must be BYTE-IDENTICAL to prism/pool.ts's
//    encodePrismPoolSwap — the encoder that has carried real mainnet buys
//    since 2026-07-30. Identity to shipped bytes IS the pin.
//  · the WETH-out sell shape mirrors SpectrumContracts'
//    test/fork/DirectSwapWrapperSellFork.t.sol (4/4 on a mainnet fork at
//    block 25767000); its test 2 proves WRAP_ETH(minOut) is an executable
//    theft, so the CONTRACT_BALANCE word is asserted by name here.
// ─────────────────────────────────────────────────────────────────────────────

const urExecuteAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])

const ACTIONS_AND_PARAMS = [{ type: 'bytes' }, { type: 'bytes[]' }] as const
const ADDRESS_UINT = [{ type: 'address' }, { type: 'uint256' }] as const
const ADDRESS_ADDRESS_UINT = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] as const
const EXACT_IN_SINGLE = [
  {
    type: 'tuple',
    components: [
      {
        name: 'poolKey',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint128' },
      { name: 'amountOutMinimum', type: 'uint128' },
      { name: 'hookData', type: 'bytes' },
    ],
  },
] as const

// A hooked native-ETH pool key (all-lowercase literals — no checksum noise).
const SELL_KEY: UrV4PoolKey = {
  currency0: zeroAddress,
  currency1: '0x0000000000000000000000000000000000f00d01' as Address,
  fee: 10_000,
  tickSpacing: 200,
  hooks: '0x000000000000000000000000000000000000abcd' as Address,
}

describe('the constant words — SpectrumContracts-verified (router Etherscan source + a real sell tx, DirectSwapWrapperSellFork.t.sol)', () => {
  it('pins every byte and sentinel', () => {
    expect(UR_CMD_V4_SWAP).toBe('0x10')
    expect(UR_CMD_WRAP_ETH).toBe('0x0b')
    expect(V4_ACTION_SWAP_EXACT_IN_SINGLE).toBe(0x06)
    expect(V4_ACTION_SETTLE_ALL).toBe(0x0c)
    expect(V4_ACTION_TAKE).toBe(0x0e)
    expect(V4_ACTION_TAKE_ALL).toBe(0x0f)
    expect(V4_OPEN_DELTA).toBe(0n)
    expect(UR_CONTRACT_BALANCE).toBe(1n << 255n)
    expect(UR_MSG_SENDER.toLowerCase()).toBe('0x0000000000000000000000000000000000000001')
    expect(UR_ADDRESS_THIS.toLowerCase()).toBe('0x0000000000000000000000000000000000000002')
  })
})

describe('encodeUrV4SwapExactInSingle — BYTE-IDENTICAL to the shipped prism encoder', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** encodePrismPoolSwap derives its deadline as
   *  `Math.floor(Date.now()/1000) + 1200` (read from its source) — pin the
   *  clock to a whole second and hand our pure encoder the same number. */
  function pinnedDeadline(): number {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_766_000_000_000))
    return Math.floor(Date.now() / 1000) + 1200
  }

  it('reproduces encodePrismPoolSwap byte-for-byte (the live PRISM buy shape)', () => {
    const deadline = pinnedDeadline()
    const amountIn = 100_000_000_000_000_000n // 0.1 ETH — the size the prism module verified on-chain
    const minOut = 4_305_000_000_000_000_000n
    const shipped = encodePrismPoolSwap('buy', amountIn, minOut)
    const ours = encodeUrV4SwapExactInSingle({
      poolKey: PRISM_POOL_KEY,
      zeroForOne: true,
      amountIn,
      amountOutMin: minOut,
      deadline,
    })
    expect(ours).toBe(shipped.data)
  })

  it('identity holds at the uint128 edge, and an explicit hookData "0x" changes nothing', () => {
    const deadline = pinnedDeadline()
    const amountIn = (1n << 128n) - 1n
    const shipped = encodePrismPoolSwap('buy', amountIn, 0n)
    const ours = encodeUrV4SwapExactInSingle({
      poolKey: PRISM_POOL_KEY,
      zeroForOne: true,
      amountIn,
      amountOutMin: 0n,
      hookData: '0x',
      deadline,
    })
    expect(ours).toBe(shipped.data)
  })

  it("enforces the prism module's own uint128 range law", () => {
    const base = { poolKey: PRISM_POOL_KEY, zeroForOne: true, amountOutMin: 0n, deadline: 1_766_000_000 }
    expect(() => encodeUrV4SwapExactInSingle({ ...base, amountIn: 0n })).toThrow(/out of range/i)
    expect(() => encodeUrV4SwapExactInSingle({ ...base, amountIn: 1n << 128n })).toThrow(/out of range/i)
    expect(() => encodeUrV4SwapExactInSingle({ ...base, amountIn: 1n, amountOutMin: 1n << 128n })).toThrow(/out of range/i)
  })

  it('REFUSES native output — the wrapper reverts NativeOutputUnsupported, so composing it would be a guaranteed revert', () => {
    // zeroForOne=false on a native-ETH pool = output is currency0 = raw ETH.
    expect(() =>
      encodeUrV4SwapExactInSingle({
        poolKey: PRISM_POOL_KEY,
        zeroForOne: false,
        amountIn: 10n ** 18n,
        amountOutMin: 0n,
        deadline: 1_766_000_000,
      }),
    ).toThrow(/encodeUrV4SellToWeth/)
  })
})

describe('encodeUrV4SellToWeth — the fork-proven sell (4/4 at block 25767000; test 1 = this exact shape)', () => {
  const amountIn = 5n * 10n ** 18n
  const minOut = 2n * 10n ** 18n
  const deadline = 1_766_000_000

  function decoded() {
    const data = encodeUrV4SellToWeth({ poolKey: SELL_KEY, amountIn, amountOutMin: minOut, deadline })
    const { functionName, args } = decodeFunctionData({ abi: urExecuteAbi, data })
    expect(functionName).toBe('execute')
    return args
  }

  it('commands are exactly 0x100b (V4_SWAP then WRAP_ETH); the deadline rides through untouched', () => {
    const [commands, inputs, dl] = decoded()
    expect(commands).toBe('0x100b')
    expect(inputs).toHaveLength(2)
    expect(dl).toBe(1_766_000_000n)
  })

  it('v4 actions are exactly 0x060c0e — TAKE, not TAKE_ALL — and the slippage floor rides ONLY in the swap params', () => {
    const [, inputs] = decoded()
    const [actions, params] = decodeAbiParameters(ACTIONS_AND_PARAMS, inputs[0])
    expect(actions).toBe('0x060c0e')
    expect(params).toHaveLength(3)
    // params[0]: ExactInputSingleParams — zeroForOne false, the floor lives here
    const [swap] = decodeAbiParameters(EXACT_IN_SINGLE, params[0])
    expect(swap.zeroForOne).toBe(false)
    expect(swap.amountIn).toBe(amountIn)
    expect(swap.amountOutMinimum).toBe(minOut)
    expect(swap.hookData).toBe('0x')
    expect(swap.poolKey.hooks.toLowerCase()).toBe(SELL_KEY.hooks.toLowerCase())
    // params[1]: SETTLE_ALL(currency1, amountIn)
    const [settleCurrency, settleAmount] = decodeAbiParameters(ADDRESS_UINT, params[1])
    expect(settleCurrency.toLowerCase()).toBe(SELL_KEY.currency1.toLowerCase())
    expect(settleAmount).toBe(amountIn)
    // params[2]: TAKE(native, ADDRESS_THIS, OPEN_DELTA) — output stays ON THE ROUTER
    const [takeCurrency, takeRecipient, takeAmount] = decodeAbiParameters(ADDRESS_ADDRESS_UINT, params[2])
    expect(takeCurrency).toBe(zeroAddress)
    expect(takeRecipient.toLowerCase()).toBe(UR_ADDRESS_THIS.toLowerCase())
    expect(takeAmount).toBe(V4_OPEN_DELTA)
  })

  it('THE WORD THAT MUST NEVER REGRESS: WRAP_ETH carries MSG_SENDER + the CONTRACT_BALANCE sentinel — never a floor', () => {
    const [, inputs] = decoded()
    const [recipient, amount] = decodeAbiParameters(ADDRESS_UINT, inputs[1])
    expect(recipient.toLowerCase()).toBe(UR_MSG_SENDER.toLowerCase())
    expect(amount).toBe(UR_CONTRACT_BALANCE)
    expect(amount).toBe(1n << 255n) // the sentinel word itself
    // fork test 2: minOut here strands realOutput−minOut on the router for any
    // stranger's SWEEP — assert it is NOT what got encoded.
    expect(amount).not.toBe(minOut)
  })

  it('refuses a pool whose currency0 is not native — the shape is only lawful selling INTO ETH', () => {
    expect(() =>
      encodeUrV4SellToWeth({ poolKey: { ...SELL_KEY, currency0: SELL_KEY.currency1 }, amountIn, amountOutMin: minOut, deadline }),
    ).toThrow(/native-ETH pool/i)
  })

  it('enforces the same uint128 range law as the buy shape', () => {
    expect(() => encodeUrV4SellToWeth({ poolKey: SELL_KEY, amountIn: 0n, amountOutMin: 0n, deadline })).toThrow(/out of range/i)
    expect(() => encodeUrV4SellToWeth({ poolKey: SELL_KEY, amountIn: 1n << 128n, amountOutMin: 0n, deadline })).toThrow(/out of range/i)
  })
})

describe('the path bytes and the chain-shape gate — pinned byte-exact (the audit sweep’s :43/:47/:114)', () => {
  it('packV3Path packs token‖fee‖token in order, multi-hop', () => {
    const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
    const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const
    const C = '0xcccccccccccccccccccccccccccccccccccccccc' as const
    expect(packV3Path([A, B, C], [100, 10000])).toBe(('0x' + 'aa'.repeat(20) + '000064' + 'bb'.repeat(20) + '002710' + 'cc'.repeat(20)) as Hex)
  })
  it('only 4663 speaks the six-field V3 shape — the canonical deploys do not', () => {
    expect(urUsesSixFieldV3(4663)).toBe(true)
    expect(urUsesSixFieldV3(1)).toBe(false)
    expect(urUsesSixFieldV3(8453)).toBe(false)
  })
})
