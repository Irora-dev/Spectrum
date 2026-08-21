import { describe, expect, it } from 'vitest'
import { encodeErrorResult, parseAbi, toFunctionSelector } from 'viem'
import { contractReasonOf, friendlyRevert, launchPriceUnavailable, LAUNCH_PRICE_UNREADABLE } from './decode-revert'

const wrappedErrorAbi = parseAbi([
  'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
])

const wrap = (inner: `0x${string}`): `0x${string}` =>
  encodeErrorResult({
    abi: wrappedErrorAbi,
    errorName: 'WrappedError',
    args: ['0xb7c98b95Ba31DE1b852F17fC1075197FA3534088', '0xf3cd914c', inner, '0x'],
  })

describe('friendlyRevert — PoolManager-wrapped hook reverts', () => {
  it('unwraps WrappedError and names the inner basket error (the live 0x90bfb865 case)', () => {
    const inner = toFunctionSelector('InsufficientFirstDeposit()') as `0x${string}`
    const err = { shortMessage: 'reverted', cause: { data: wrap(inner) } }
    const msg = friendlyRevert(err, 'reverted')
    expect(msg).toContain('InsufficientFirstDeposit')
    expect(msg).toContain('10 USDC')
  })
  it("the LIVE LegMinNotMet case, with contracts' own selectors (0x50bf0751 in 0x90bfb865)", () => {
    // SpectrumContracts measured this on a fork of live 4663 (2026-08-04): after
    // ~20k USDG of one-way buying, the next bare mint is refused with
    // LegMinNotMet and the IDENTICAL mint passes 30 minutes later. They named
    // the exact bytes a decoder must survive, so this pins them rather than
    // trusting that our unwrap "should" handle it.
    const inner = toFunctionSelector('LegMinNotMet()') as `0x${string}`
    expect(inner).toBe('0x50bf0751') // their measured inner selector
    const err = { shortMessage: 'reverted', cause: { data: wrap(inner) } }
    const msg = friendlyRevert(err, 'reverted with the following signature: 0x90bfb865')
    // THREE causes share this error with OPPOSITE remedies (contracts' live-
    // registry measurement, R's correction 2026-08-04: the old "never stuck"
    // copy was right for a TWAP burst and actively misleading for a
    // structurally dead leg — a user there would retry forever on our advice).
    // The hint must carry the user-side discriminator: all three cases, each
    // with its test, and the dead-leg case stated as unfixable by retrying.
    expect(msg).toMatch(/smaller amount working right now/i) // thin pool → size down
    expect(msg).toMatch(/30 minutes/i) // TWAP burst → transient, retry heals
    expect(msg).toMatch(/no amount ever working/i) // dead leg → retrying cannot help
    expect(msg).toMatch(/retrying cannot help/i)
    expect(msg).not.toMatch(/0x50bf0751|0x90bfb865/) // never a raw selector
  })

  it('FirstMintUnderValued carries BOTH causes with the size discriminator (the live packsFundingSplit case)', () => {
    // Measured 2026-08-15: a deployment entry missing packsFundingSplit made every
    // seed compose the legacy unsplit payload — the basket acquires NOTHING and
    // trips this same guard at ANY size. The old pools-only hint ("use a larger
    // amount or calmer pools") sent a real operator hunting fee tiers for a config
    // key. The hint must state the config cause, name the flag, and keep the
    // thin-pools remedy for the case size actually fixes.
    const inner = toFunctionSelector('FirstMintUnderValued()') as `0x${string}`
    const err = { shortMessage: 'reverted', cause: { data: wrap(inner) } }
    const msg = friendlyRevert(err, 'reverted')
    expect(msg).toMatch(/packsFundingSplit/) // the config cause, named actionably
    expect(msg).toMatch(/no amount can pass/i) // …and stated as unfixable by sizing
    expect(msg).toMatch(/larger amount or calmer pools/i) // the thin-pools remedy stays
    expect(msg).not.toMatch(/0x90bfb865/)
  })
  it('unwraps NESTED wraps (hook revert re-wrapped per unlock layer)', () => {
    const inner = toFunctionSelector('SlippageExceeded()') as `0x${string}`
    const err = { cause: { data: wrap(wrap(inner)) } }
    expect(friendlyRevert(err, 'x')).toContain('SlippageExceeded')
  })
  it('names a bare basket error selector from raw data', () => {
    const err = { data: toFunctionSelector('ZeroSupply()') }
    expect(friendlyRevert(err, 'x')).toContain('ZeroSupply')
  })
  it('falls back to the signature-in-message path, and to the raw message otherwise', () => {
    expect(
      friendlyRevert({}, 'reverted with the following signature: 0x90bfb865'),
      // The bare-signature path must NOT name a cause: the wrapper's reason
      // never reached us. It previously asserted the 10 USDC first-buy minimum,
      // which sent a real user hunting a minimum they had already cleared while
      // the true cause (decoded from chain) was a leg floor on an established
      // basket. Pin the honesty, not the guess.
    ).toContain('did not return the reason')
    expect(
      friendlyRevert({}, 'reverted with the following signature: 0x90bfb865'),
    ).not.toContain('10 USDC')
    expect(friendlyRevert({}, 'some unrelated failure')).toBe('some unrelated failure')
  })
  // Same honesty law, second offender (2026-08-13): CREATE2Failed asserted "this
  // exact configuration is already deployed" FIRST, and that cause cannot occur on
  // the launch path — the salt is freshly mined at random against the factory's own
  // oracle. Reproduced live: the factory that threw it enumerated ZERO baskets, and
  // the real cause was a Uniswap V2 leg route, which the current contract generation
  // rejects in the basket constructor. Pin the honesty, not the guess.
  it('CREATE2Failed names the venue discriminator and never asserts "already deployed"', () => {
    const msg = friendlyRevert({ data: toFunctionSelector('CREATE2Failed()') }, 'x')
    expect(msg).toContain('CREATE2Failed')
    expect(msg).toContain('Uniswap V2')
    expect(msg).not.toMatch(/already deployed/i)
    expect(msg).not.toMatch(/check Explore/i)
  })
})

// ── the launch-price read (owner, 2026-08-13: "i thought we removed auction
// slots in new contracts????") ───────────────────────────────────────────────
// He was right twice. The shipped factories charge a FLAT LAUNCH_FEE_WEI —
// measured 0.001 ETH on all three (Base/Ethereum/Robinhood rehearsal factories,
// probed 2026-08-13) — so no auction exists to have a slot. And the message was
// bolted to the wrong event: it came from the CATCH around a `currentDeployPrice`
// READ, so an unreachable RPC produced a confident claim about the factory's
// launch schedule. The factory's one real refusal is SlotNotOpen(), reverted
// while block.number < lastDeployBlock + 10.
describe('launchPriceUnavailable — a failed price read says only what it knows', () => {
  it('surfaces the factory’s OWN revert, in the factory’s own terms', () => {
    const err = { shortMessage: 'reverted', data: toFunctionSelector('SlotNotOpen()') }
    const msg = launchPriceUnavailable(err)
    // no mechanism claim (owner 2026-08-21: no cooldown on basket creation) —
    // the hint states the refusal and the safe retry, nothing it cannot prove
    expect(msg).toContain('not accepting a new launch')
    expect(msg).toContain('try again shortly')
    expect(msg).not.toMatch(/auction/i)
    expect(msg).not.toMatch(/10-block|breather|cooldown/i)
  })

  it('decodes a revert carried as a bare signature in the message too', () => {
    const err = { shortMessage: `reverted with the following signature: ${toFunctionSelector('SlotNotOpen()')}` }
    expect(launchPriceUnavailable(err)).toContain('not accepting a new launch')
  })

  it('says the honest thing when the read failed for network reasons', () => {
    for (const err of [
      new Error('HTTP request failed. Status: 429'),
      { shortMessage: 'The request took too long to respond.' },
      new Error('fetch failed'),
      {},
    ]) {
      const msg = launchPriceUnavailable(err)
      expect(msg).toBe(LAUNCH_PRICE_UNREADABLE)
      expect(msg).toMatch(/could not be read/i)
      expect(msg).not.toMatch(/auction|slot/i)
    }
  })

  it('never claims a slot state it cannot know', () => {
    // The whole defect in one assertion: an unknown failure must not name the
    // factory's schedule, and no message on this path may say "auction".
    expect(launchPriceUnavailable(new Error('socket hang up'))).not.toMatch(/slot|auction|try again in a few blocks/i)
  })

  it('contractReasonOf separates a contract refusal from everything else', () => {
    expect(contractReasonOf({ data: toFunctionSelector('SlotNotOpen()') })).toContain('SlotNotOpen')
    expect(contractReasonOf(new Error('HTTP request failed. Status: 500'))).toBeNull()
    // node/wallet money noise is NOT a contract reason — friendlyRevert translates
    // it for the SIGNING path, but a read must not inherit that claim.
    expect(contractReasonOf(new Error('insufficient funds for gas * price + value'))).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE PORTFOLIO BATCHER'S VOCABULARY (pass-one LOW-3, 2026-08-14): before
// these pins the app could not name a single SpectrumPortfolioBatcher revert.
// The argful errors must decode their args — the whole point is that a
// failing REQUIRED leg is named by index, since the contract discards the
// inner cause on the required path by design.
// ─────────────────────────────────────────────────────────────────────────────
describe('portfolio-batcher reverts — every error is named, argful ones name the leg', () => {
  const pAbi = parseAbi([
    'error RequiredLegFailed(uint256 index)',
    'error MinBuyNotMet(uint256 delivered, uint256 floor)',
    'error ZeroFloor(uint256 index)',
    'error BudgetsExceedFunding()',
    'error DeadlinePassed()',
  ])
  const err = (errorName: string, args: readonly unknown[] = []) =>
    ({ data: encodeErrorResult({ abi: pAbi, errorName: errorName as never, args: args as never }) }) as unknown

  it('RequiredLegFailed(2) names LEG 3 — the 1-based index a human can match to the review row', () => {
    const reason = contractReasonOf(err('RequiredLegFailed', [2n]))
    expect(reason).toMatch(/RequiredLegFailed/)
    expect(reason).toMatch(/leg 3/)
    expect(reason).toMatch(/re-open the review/)
  })

  it('MinBuyNotMet decodes and says the market moved — never an anonymous sentence', () => {
    expect(contractReasonOf(err('MinBuyNotMet', [99n, 100n]))).toMatch(/MinBuyNotMet — a leg delivered under the floor/)
  })

  it('ZeroFloor(0) names leg 1; argless errors still name themselves', () => {
    expect(contractReasonOf(err('ZeroFloor', [0n]))).toMatch(/leg 1/)
    expect(contractReasonOf(err('BudgetsExceedFunding'))).toMatch(/BudgetsExceedFunding — the legs plus the fee exceed/)
    expect(contractReasonOf(err('DeadlinePassed'))).toMatch(/DeadlinePassed — this batch expired/)
  })

  it('friendlyRevert speaks the batch sentence for a portfolio revert', () => {
    expect(friendlyRevert(err('RequiredLegFailed', [0n]), 'fallback')).toMatch(/^Batch reverted: RequiredLegFailed/)
  })

  it('an unknown selector still falls through to the basket vocabulary unharmed', () => {
    const basketErr = { data: encodeErrorResult({ abi: parseAbi(['error ZeroSupply()']), errorName: 'ZeroSupply' }) } as unknown
    expect(contractReasonOf(basketErr)).toMatch(/ZeroSupply/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE DEPLOYED-TABLE CROSS-CHECK (SpectrumContracts' close-out, 2026-08-14):
// their table is derived from the DEPLOYED batcher ABI (identical bytes on all
// three chains). Every selector they measured must decode through OUR abi to
// the SAME name — a signature drift (a renamed arg type, a missed error) makes
// a live revert read as anonymous exactly when a user needs the name. This is
// the paper-encoding law: an interface is trusted only against a selector pin.
// ─────────────────────────────────────────────────────────────────────────────
describe('the deployed selector table decodes 32/32', () => {
  const DEPLOYED: [string, string][] = [
    ['0x14d4a4e8', 'OnlySelf'], ['0x2c74e31d', 'BurnPoolDoesNotPriceAsset'], ['0x3887143e', 'RecipientIsSelf'],
    ['0x3be0b6e6', 'FeeRecipientIsSelf'], ['0x3e3f8f73', 'ApproveFailed'], ['0x4120b7c2', 'BurnSwapFailed'],
    ['0x449fd517', 'RouterHasNoCode'], ['0x56a218de', 'LegOverspent'], ['0x657526de', 'DeadlineTooFar'],
    ['0x6aa6553e', 'ZeroFloor'], ['0x70f65caa', 'DeadlinePassed'], ['0x78c30717', 'BurnAssetNotPriceable'],
    ['0x7939f424', 'TransferFromFailed'], ['0x81382d2e', 'FeeAboveCeiling'], ['0x835da7f4', 'RequiredLegFailed'],
    ['0x85d53c40', 'TooManyLegs'], ['0x86b27acd', 'AggCallFailed'], ['0x892aa18c', 'BurnFloorIsZero'],
    ['0x90b8ec18', 'TransferFailed'], ['0x9528138c', 'NoLegs'], ['0x9ee7732f', 'BurnSinkHasNoCode'],
    ['0xa049fe2d', 'BuyTokenHasNoCode'], ['0xab143c06', 'Reentrancy'], ['0xbf1f9350', 'MinBuyNotMet'],
    ['0xc5f2ed4d', 'BudgetsExceedFunding'], ['0xc90023c1', 'BurnSendFailed'], ['0xd92e233d', 'ZeroAddress'],
    ['0xddafd724', 'MinBurnNotMet'], ['0xdf5d9791', 'BuyIsFundingAsset'], ['0xe25dcaf4', 'BurnFallbackSinkInvalid'],
    ['0xf629ff06', 'BurnTwapUnavailable'], ['0xfb6a13d6', 'BurnPoolNotEthDenominated'],
  ]
  // args are zero-padded words; every argful error here takes uint256s only,
  // so selector + zeroed words decodes cleanly for the argful ones too
  const dataFor = (selector: string, words: number) => (selector + '00'.repeat(32 * words)) as `0x${string}`
  const ARGS: Record<string, number> = { LegOverspent: 2, DeadlineTooFar: 2, ZeroFloor: 1, RequiredLegFailed: 1, BuyTokenHasNoCode: 1, MinBuyNotMet: 2, MinBurnNotMet: 2 }

  it('every deployed selector resolves to its named sentence — none reads as anonymous', () => {
    for (const [selector, name] of DEPLOYED) {
      const reason = contractReasonOf({ data: dataFor(selector, ARGS[name] ?? 0) })
      expect(reason, `${selector} ${name}`).toMatch(new RegExp(`^${name}`))
    }
  })

  it('the table is the instrument’s own premise: 32 distinct selectors', () => {
    expect(new Set(DEPLOYED.map(([s]) => s)).size).toBe(32)
  })
})
