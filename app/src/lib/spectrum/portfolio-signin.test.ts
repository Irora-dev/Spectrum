import { beforeEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'

// The sign-in module (the owner 2026-08-13: "'log into' your portfolio by signing
// with one of your linked wallets"). Same suite shape as wallet-links.test.ts:
// REAL viem signatures — a mocked signer would pin nothing about recovery.

function fakeStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => void m.clear(),
    key: () => null,
    get length() {
      return m.size
    },
  }
}

async function fresh(storage: ReturnType<typeof fakeStorage> | null = fakeStorage()) {
  vi.resetModules()
  if (storage) vi.stubGlobal('window', { localStorage: storage })
  else
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('storage unavailable')
      },
    })
  return { signin: await import('./portfolio-signin'), storage }
}

beforeEach(() => vi.unstubAllGlobals())

// anvil's first two well-known dev keys — the wallet-links suite's own pair
const OWNER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const OTHER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')

describe('signInMessage (frozen format)', () => {
  it('is the exact self-describing, scope-stamped string — verbatim, so drift is a red test', async () => {
    const { signin } = await fresh()
    expect(signin.signInMessage(OWNER.address, 'app.example', Date.UTC(2026, 7, 13, 12))).toBe(
      [
        `Sign in to the portfolio of ${OWNER.address.toLowerCase()}`,
        'on app.example (2026-08-13).',
        '',
        'This signature only proves the wallet is yours, so this browser can open its portfolio. It approves nothing, spends nothing, and stays on this device.',
      ].join('\n'),
    )
  })
})

describe('verifySignIn', () => {
  it('accepts the owner’s real signature by EOA recovery — no chain consulted', async () => {
    const { signin } = await fresh()
    const message = signin.signInMessage(OWNER.address, 'app.example', Date.now())
    const signature = await OWNER.signMessage({ message })
    // verify: null forbids the chain fallback — recovery alone must carry it
    await expect(signin.verifySignIn(OWNER.address, message, signature, null)).resolves.toBe(true)
  })

  it('refuses another wallet’s signature over the same message', async () => {
    const { signin } = await fresh()
    const message = signin.signInMessage(OWNER.address, 'app.example', Date.now())
    const signature = await OTHER.signMessage({ message })
    await expect(signin.verifySignIn(OWNER.address, message, signature, null)).resolves.toBe(false)
  })

  it('falls through to the chain verifier for a non-recovering (smart-wallet) signature', async () => {
    const { signin } = await fresh()
    const message = signin.signInMessage(OWNER.address, 'app.example', Date.now())
    const asked: number[] = []
    // a 1271 wallet's signature never RECOVERS to its address — garbage bytes
    // stand in for one; only the injected verifier can vouch
    const vouch = await signin.verifySignIn(OWNER.address, message, '0xdeadbeef', async (chainId) => {
      asked.push(chainId)
      return true
    })
    expect(vouch).toBe(true)
    expect(asked.length).toBeGreaterThan(0)
    // and when every chain says no, the answer is no
    await expect(signin.verifySignIn(OWNER.address, message, '0xdeadbeef', async () => false)).resolves.toBe(false)
  })
})

describe('the login latch', () => {
  it('roundtrips per wallet, case-insensitively, and anySignedIn answers for a linked group', async () => {
    const { signin } = await fresh()
    expect(signin.hasSignedIn(OWNER.address)).toBe(false)
    signin.markSignedIn(OWNER.address.toUpperCase().replace('0X', '0x'))
    expect(signin.hasSignedIn(OWNER.address.toLowerCase())).toBe(true)
    // the group law: one member's login vouches for the set
    expect(signin.anySignedIn([OTHER.address, OWNER.address])).toBe(true)
    expect(signin.anySignedIn([OTHER.address])).toBe(false)
    expect(signin.anySignedIn([])).toBe(false)
  })

  it('a corrupt row reads as signed OUT and a write heals it', async () => {
    const storage = fakeStorage()
    storage.setItem('spectrum.portfolio-signin.v1', '{not json')
    const { signin } = await fresh(storage)
    expect(signin.hasSignedIn(OWNER.address)).toBe(false)
    signin.markSignedIn(OWNER.address)
    expect(signin.hasSignedIn(OWNER.address)).toBe(true)
  })

  it('unreadable storage asks again — signed OUT, and the write failure stays silent', async () => {
    const { signin } = await fresh(null)
    expect(signin.hasSignedIn(OWNER.address)).toBe(false)
    expect(() => signin.markSignedIn(OWNER.address)).not.toThrow()
  })

  it('the latch caps at 20 wallets — a wallet-hopping session cannot grow it unbounded', async () => {
    const { signin } = await fresh()
    for (let i = 0; i < 25; i++) signin.markSignedIn(`0x${String(i).padStart(40, '0')}`)
    expect(signin.hasSignedIn(`0x${'0'.repeat(40)}`)).toBe(false) // the oldest fell off
    expect(signin.hasSignedIn(`0x${'24'.padStart(40, '0')}`)).toBe(true)
  })
})

describe('verifySignIn pins the message format (audit 2026-08-13 — the 2026-08-11 class)', () => {
  it('refuses a real owner signature over a message THIS APP would never produce', async () => {
    const { signin } = await fresh()
    // the owner genuinely signs a DIFFERENT message (a link message, a foreign
    // SIWE, anything) — recovery succeeds, but it is not a sign-in
    const foreign = 'Link wallet ' + OWNER.address.toLowerCase() + '\nto some other place.'
    const sig = await OWNER.signMessage({ message: foreign })
    await expect(signin.verifySignIn(OWNER.address, foreign, sig, null)).resolves.toBe(false)
    // the SAME signature over the SAME message, but presented as a sign-in with
    // a hand-forged stamp line, still fails — the rebuild won't match
    const spoof = foreign + '\non evil.example (2026-08-13).\n'
    const sig2 = await OWNER.signMessage({ message: spoof })
    await expect(signin.verifySignIn(OWNER.address, spoof, sig2, null)).resolves.toBe(false)
  })

  it('still accepts a genuine sign-in message built by signInMessage', async () => {
    const { signin } = await fresh()
    const msg = signin.signInMessage(OWNER.address, 'app.example', Date.UTC(2026, 7, 13, 9))
    const sig = await OWNER.signMessage({ message: msg })
    await expect(signin.verifySignIn(OWNER.address, msg, sig, null)).resolves.toBe(true)
  })
})
