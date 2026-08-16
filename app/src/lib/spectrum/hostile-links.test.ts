import { beforeEach, describe, expect, it } from 'vitest'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import {
  addLink,
  groupFor,
  importBundle,
  linkMessage,
  loadLinks,
  verifyLink,
  type WalletLink,
} from './wallet-links'

// ─────────────────────────────────────────────────────────────────────────────
// HOSTILE LINKS — the wallet-linking hardening pass (owner 2026-08-06 16:4x:
// "the biggest weakpoint given people will be connecting/signing from all
// kinds of wallet providers"). Drives the store from OUTSIDE its own test
// file per the §3D rule: cycles and deep chains a cross-device import can
// legitimately produce, tampered bundles, hostile sizes, case-mangled
// addresses, and the 10+-wallet group the owner wants supported. The
// existing wallet-links.test.ts covers the happy paths; this file exists to
// try to break them.
// ─────────────────────────────────────────────────────────────────────────────

// node env: give the module a real-enough localStorage
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  clear() {
    this.m.clear()
  }
}

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = globalThis as unknown
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemStorage()
})

async function signedLink(anchor: string, memberKey: `0x${string}`, host = 'spectrum.test'): Promise<WalletLink> {
  const acct = privateKeyToAccount(memberKey)
  const message = linkMessage(anchor, acct.address, host, Date.now())
  const signature = await acct.signMessage({ message })
  return { anchor: anchor.toLowerCase(), member: acct.address.toLowerCase(), message, signature, linkedAt: Date.now() }
}

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`

describe('groupFor under imported topologies (cycles, chains, junk)', () => {
  it('a CYCLE (A→B here, B→A imported) resolves to ONE deterministic root from every side', () => {
    const a = addr(0xa)
    const b = addr(0xb)
    const links: WalletLink[] = [
      { anchor: b, member: a, message: 'x', signature: '0x', linkedAt: 1 },
      { anchor: a, member: b, message: 'x', signature: '0x', linkedAt: 2 },
    ]
    const fromA = groupFor(a, links)
    const fromB = groupFor(b, links)
    expect(fromA.anchor).toBe(fromB.anchor)
    expect(new Set(fromA.addresses)).toEqual(new Set(fromB.addresses))
    expect(fromA.addresses).toHaveLength(2)
  })

  it('a THREE-node cycle terminates and agrees from every side', () => {
    const [a, b, c] = [addr(1), addr(2), addr(3)]
    const links: WalletLink[] = [
      { anchor: a, member: b, message: 'x', signature: '0x', linkedAt: 1 },
      { anchor: b, member: c, message: 'x', signature: '0x', linkedAt: 2 },
      { anchor: c, member: a, message: 'x', signature: '0x', linkedAt: 3 },
    ]
    const roots = new Set([groupFor(a, links).anchor, groupFor(b, links).anchor, groupFor(c, links).anchor])
    expect(roots.size).toBe(1)
    expect(groupFor(a, links).addresses).toHaveLength(3)
  })

  it('a SELF-LINK record neither loops nor grows the group', () => {
    const a = addr(0xaa)
    const links: WalletLink[] = [{ anchor: a, member: a, message: 'x', signature: '0x', linkedAt: 1 }]
    const g = groupFor(a, links)
    expect(g.anchor).toBe(a)
    expect(g.addresses).toEqual([a])
  })

  it('a deep chain (X→M, M→A) resolves the WHOLE tree from the leaf', () => {
    const [a, m, x] = [addr(0xa1), addr(0xa2), addr(0xa3)]
    const links: WalletLink[] = [
      { anchor: a, member: m, message: 'x', signature: '0x', linkedAt: 1 },
      { anchor: m, member: x, message: 'x', signature: '0x', linkedAt: 2 },
    ]
    for (const side of [a, m, x]) {
      const g = groupFor(side, links)
      expect(g.anchor).toBe(a)
      expect(new Set(g.addresses)).toEqual(new Set([a, m, x]))
    }
  })

  it('TWELVE members resolve as one group from every side (the 10+ ask)', () => {
    const anchor = addr(0x100)
    const members = Array.from({ length: 12 }, (_, i) => addr(0x200 + i))
    const links: WalletLink[] = members.map((m, i) => ({ anchor, member: m, message: 'x', signature: '0x', linkedAt: i }))
    expect(groupFor(anchor, links).addresses).toHaveLength(13)
    expect(groupFor(members[11], links).addresses).toHaveLength(13)
    expect(groupFor(members[11], links).anchor).toBe(anchor)
  })

  it('duplicate member records (a tampered store) cannot double-count an address', () => {
    const a = addr(0x11)
    const m = addr(0x22)
    const links: WalletLink[] = [
      { anchor: a, member: m, message: 'x', signature: '0x', linkedAt: 1 },
      { anchor: a, member: m, message: 'x', signature: '0x', linkedAt: 2 },
    ]
    expect(groupFor(a, links).addresses).toHaveLength(2)
  })

  it('CASE-MANGLED addresses fold to one identity everywhere', () => {
    const key = generatePrivateKey()
    const acct = privateKeyToAccount(key)
    const anchor = addr(0x77)
    const upper = { anchor: anchor.toUpperCase().replace('0X', '0x'), member: acct.address, message: 'x', signature: '0x' as const, linkedAt: 1 }
    addLink(upper as WalletLink)
    const g = groupFor(anchor)
    expect(g.addresses).toContain(acct.address.toLowerCase())
    // re-link under different casing MOVES, never duplicates
    addLink({ ...(upper as WalletLink), anchor: addr(0x88) })
    expect(loadLinks()).toHaveLength(1)
  })
})

describe('importBundle under attack', () => {
  it('a genuinely-signed record with a SWAPPED ANCHOR FIELD is refused on import (the stranger-holdings splice)', async () => {
    const key = generatePrivateKey()
    const honest = await signedLink(addr(0xa), key)
    const tampered = { ...honest, anchor: addr(0xe) } // point the record at a victim anchor
    const res = await importBundle(JSON.stringify({ v: 1, exportedAt: 1, links: [tampered] }), null)
    expect(res).toEqual({ added: 0, rejected: 1, capped: 0 })
    expect(loadLinks()).toHaveLength(0)
  })

  it('a tampered MEMBER field is refused even though the signature is real', async () => {
    const key = generatePrivateKey()
    const honest = await signedLink(addr(0xa), key)
    const tampered = { ...honest, member: addr(0xd) }
    const res = await importBundle(JSON.stringify({ v: 1, exportedAt: 1, links: [tampered] }), null)
    expect(res).toEqual({ added: 0, rejected: 1, capped: 0 })
  })

  it('an honest bundle imports and merges into the live group', async () => {
    const key = generatePrivateKey()
    const honest = await signedLink(addr(0xa), key)
    const res = await importBundle(JSON.stringify({ v: 1, exportedAt: 1, links: [honest] }), null)
    expect(res).toEqual({ added: 1, rejected: 0, capped: 0 })
    expect(groupFor(addr(0xa)).addresses).toContain(honest.member)
  })

  it('a HOSTILE-SIZE bundle is bounded — thousands of records cannot buy thousands of crypto ops', async () => {
    const junk = Array.from({ length: 5000 }, (_, i) => ({
      anchor: addr(0xa),
      member: addr(0x1000 + i),
      message: 'x',
      signature: '0x00',
      linkedAt: i,
    }))
    const res = await importBundle(JSON.stringify({ v: 1, exportedAt: 1, links: junk }), null)
    // however the module bounds it, the answer must come back quickly and add nothing
    expect(res).not.toBeNull()
    expect(res!.added).toBe(0)
    expect(loadLinks()).toHaveLength(0)
  })

  it('a 10MB message on one record cannot reach the crypto path', async () => {
    const bomb = {
      anchor: addr(0xa),
      member: addr(0xb),
      message: 'A'.repeat(10_000_000),
      signature: '0x00',
      linkedAt: 1,
    }
    const started = Date.now()
    const res = await importBundle(JSON.stringify({ v: 1, exportedAt: 1, links: [bomb] }), null)
    expect(res!.added).toBe(0)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('verifyLink refuses what no wallet signed', () => {
  it('the signature of ANOTHER message never verifies (splice across records)', async () => {
    const key = generatePrivateKey()
    const acct = privateKeyToAccount(key)
    const msgA = linkMessage(addr(0xa), acct.address, 'spectrum.test', Date.now())
    const sigA = await acct.signMessage({ message: msgA })
    // a record claiming message B but carrying A's signature
    const msgB = linkMessage(addr(0xb), acct.address, 'spectrum.test', Date.now())
    const spliced: WalletLink = { anchor: addr(0xb), member: acct.address.toLowerCase(), message: msgB, signature: sigA, linkedAt: 1 }
    expect(await verifyLink(spliced, null)).toBe(false)
  })
})
