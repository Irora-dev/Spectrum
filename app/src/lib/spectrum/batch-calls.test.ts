import { describe, expect, it } from 'vitest'
import { parseAtomicSupport } from './batch-calls'

describe('parseAtomicSupport — both 5792 capability generations, defensively', () => {
  it('final-spec shape: atomic.status supported/ready count, unsupported does not', () => {
    expect(parseAtomicSupport({ '0x1235': { atomic: { status: 'supported' } } }, 0x1235)).toBe(true)
    expect(parseAtomicSupport({ '0x1235': { atomic: { status: 'ready' } } }, 0x1235)).toBe(true)
    expect(parseAtomicSupport({ '0x1235': { atomic: { status: 'unsupported' } } }, 0x1235)).toBe(false)
  })

  it('draft shape: atomicBatch.supported boolean', () => {
    expect(parseAtomicSupport({ '0x2105': { atomicBatch: { supported: true } } }, 8453)).toBe(true)
    expect(parseAtomicSupport({ '0x2105': { atomicBatch: { supported: false } } }, 8453)).toBe(false)
  })

  it('decimal string keys are accepted', () => {
    expect(parseAtomicSupport({ '4663': { atomic: { status: 'supported' } } }, 4663)).toBe(true)
  })

  it('wrong chain, junk, and absent entries are all false — never assume', () => {
    expect(parseAtomicSupport({ '0x1': { atomic: { status: 'supported' } } }, 8453)).toBe(false)
    expect(parseAtomicSupport(null, 8453)).toBe(false)
    expect(parseAtomicSupport('garbage', 8453)).toBe(false)
    expect(parseAtomicSupport({ '0x2105': { atomicBatch: { supported: 'yes' } } }, 8453)).toBe(false)
    expect(parseAtomicSupport({}, 8453)).toBe(false)
  })
})
