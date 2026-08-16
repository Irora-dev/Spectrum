import { describe, expect, it } from 'vitest'
import {
  VERSION_INTENT_TTL_MS,
  clearVersionIntent,
  pendingVersionIntent,
  recordVersionIntent,
} from './version-intent'

function mem() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

const DEP = '0x00000000000000000000000000000000000000c1'
const PRED = '0x00000000000000000000000000000000000000b1'

describe('version-intent (the iterate loop hint)', () => {
  it('round-trips per deployer and chain', () => {
    const s = mem()
    recordVersionIntent(DEP, { predecessor: PRED, chainId: 8453 }, 1000, s)
    expect(pendingVersionIntent(DEP, 8453, 2000, s)?.predecessor).toBe(PRED)
    expect(pendingVersionIntent(DEP, 1, 2000, s)).toBeNull() // wrong chain: no hint
    expect(pendingVersionIntent('0x00000000000000000000000000000000000000c2', 8453, 2000, s)).toBeNull()
  })

  it('a stale intent never resurfaces — TTL capped', () => {
    const s = mem()
    recordVersionIntent(DEP, { predecessor: PRED, chainId: 8453 }, 1000, s)
    expect(pendingVersionIntent(DEP, 8453, 1000 + VERSION_INTENT_TTL_MS + 1, s)).toBeNull()
  })

  it('chains hold SEPARATE slots — recording on one never clobbers the other (audit C4)', () => {
    const s = mem()
    recordVersionIntent(DEP, { predecessor: PRED, chainId: 8453 }, 1000, s)
    recordVersionIntent(DEP, { predecessor: '0x00000000000000000000000000000000000000b2', chainId: 4663 }, 1100, s)
    expect(pendingVersionIntent(DEP, 8453, 1200, s)?.predecessor).toBe(PRED)
    expect(pendingVersionIntent(DEP, 4663, 1200, s)?.predecessor).toBe('0x00000000000000000000000000000000000000b2')
  })

  it('clear removes it; hostile storage content reads as no intent', () => {
    const s = mem()
    recordVersionIntent(DEP, { predecessor: PRED, chainId: 8453 }, 1000, s)
    clearVersionIntent(DEP, 8453, s)
    expect(pendingVersionIntent(DEP, 8453, 1001, s)).toBeNull()
    s.setItem(`spectrum.version-intent.${DEP.toLowerCase()}.8453`, '{"predecessor":"not-an-address","chainId":8453,"at":1}')
    expect(pendingVersionIntent(DEP, 8453, 2, s)).toBeNull()
  })
})
