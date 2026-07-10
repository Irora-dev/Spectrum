import { describe, expect, it } from 'vitest'
import { encodeErrorResult, parseAbi, toFunctionSelector } from 'viem'
import { friendlyRevert } from './decode-revert'

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
    ).toContain('10 USDC first-buy minimum')
    expect(friendlyRevert({}, 'some unrelated failure')).toBe('some unrelated failure')
  })
})
