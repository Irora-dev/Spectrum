import { beforeEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'

// The store reads window.localStorage per call — stub a Map-backed fake and
// import fresh per test so persistence is exercised for real (the
// bridge-pending suite's pattern).
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

async function freshModule(storage = fakeStorage()) {
  vi.resetModules()
  vi.stubGlobal('window', { localStorage: storage, location: { host: 'demo.spectrum.test' } })
  const mod = await import('./wallet-links')
  return { mod, storage }
}

beforeEach(() => vi.unstubAllGlobals())

// Anvil's well-known dev keys — deterministic, public, and never real money.
const A = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const M = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')

describe('the link message', () => {
  it('binds both addresses, the host, and the day — and says what signing means', async () => {
    const { mod } = await freshModule()
    const msg = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.UTC(2026, 7, 3, 12))
    expect(msg).toContain(A.address.toLowerCase())
    expect(msg).toContain(M.address.toLowerCase())
    expect(msg).toContain('demo.spectrum.test')
    expect(msg).toContain('2026-08-03')
    expect(msg).toMatch(/approves nothing/i)
    expect(msg).toMatch(/undone/i)
  })
})

describe('verifyLink: a real sign-and-recover round trip', () => {
  it('accepts a genuine signature from the member', async () => {
    const { mod } = await freshModule()
    const message = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.now())
    const signature = await M.signMessage({ message })
    expect(
      await mod.verifyLink({ anchor: A.address, member: M.address, message, signature, linkedAt: Date.now() }, null),
    ).toBe(true)
  })

  it('rejects a signature from the WRONG wallet (the anchor cannot vouch for the member)', async () => {
    const { mod } = await freshModule()
    const message = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.now())
    const signature = await A.signMessage({ message })
    expect(
      await mod.verifyLink({ anchor: A.address, member: M.address, message, signature, linkedAt: Date.now() }, null),
    ).toBe(false)
  })

  it('rejects a tampered message (a moved record must not read)', async () => {
    const { mod } = await freshModule()
    const message = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.now())
    const signature = await M.signMessage({ message })
    const tampered = message.replace(A.address.toLowerCase(), M.address.toLowerCase())
    expect(
      await mod.verifyLink({ anchor: A.address, member: M.address, message: tampered, signature, linkedAt: Date.now() }, null),
    ).toBe(false)
  })

  it('rejects garbage without throwing', async () => {
    const { mod } = await freshModule()
    expect(
      await mod.verifyLink({ anchor: A.address, member: M.address, message: 'x', signature: '0xdead', linkedAt: 0 }, null),
    ).toBe(false)
  })
})

describe('the registry', () => {
  it('persists a link and resolves the group from BOTH sides', async () => {
    const { mod } = await freshModule()
    mod.addLink({ anchor: A.address, member: M.address, message: 'm', signature: '0x1', linkedAt: 1 })

    const fromAnchor = mod.groupFor(A.address)
    const fromMember = mod.groupFor(M.address)
    expect(fromAnchor.addresses).toEqual([A.address.toLowerCase(), M.address.toLowerCase()])
    expect(fromMember.addresses).toEqual(fromAnchor.addresses)
    expect(fromMember.anchor).toBe(A.address.toLowerCase())
  })

  it('a stranger resolves to a group of one', async () => {
    const { mod } = await freshModule()
    const g = mod.groupFor('0x00000000000000000000000000000000000000aa')
    expect(g.addresses).toEqual(['0x00000000000000000000000000000000000000aa'])
    expect(g.members).toEqual([])
  })

  it('one group per member: re-linking to a new anchor MOVES the wallet', async () => {
    const { mod } = await freshModule()
    const B = '0x00000000000000000000000000000000000000bb'
    mod.addLink({ anchor: A.address, member: M.address, message: 'm', signature: '0x1', linkedAt: 1 })
    mod.addLink({ anchor: B, member: M.address, message: 'm2', signature: '0x2', linkedAt: 2 })
    expect(mod.groupFor(A.address).addresses).toEqual([A.address.toLowerCase()])
    expect(mod.groupFor(M.address).anchor).toBe(B)
  })

  it('unlink removes exactly that member', async () => {
    const { mod } = await freshModule()
    const C = '0x00000000000000000000000000000000000000cc'
    mod.addLink({ anchor: A.address, member: M.address, message: 'm', signature: '0x1', linkedAt: 1 })
    mod.addLink({ anchor: A.address, member: C, message: 'm2', signature: '0x2', linkedAt: 2 })
    mod.removeLink(M.address)
    expect(mod.groupFor(A.address).addresses).toEqual([A.address.toLowerCase(), C])
  })

  // ⚠ THE CASE THE FLAT TEST ABOVE CANNOT SEE (found 2026-08-11). Both members
  // there hang off one anchor, so nothing can be orphaned and "delete the row"
  // and "delete the subtree" agree. A CHAIN (importable: A←M here, M←X from
  // another device) tells them apart: unlinking M used to drop only A←M, so X
  // disappeared from A's panel — unlistable, unremovable — while its record
  // stayed in storage and silently merged back the next time the user
  // connected M.
  it('unlinking a middle wallet takes its orphans with it, not just its own row', async () => {
    const { mod } = await freshModule()
    const X = '0x00000000000000000000000000000000000000e5'
    mod.addLink({ anchor: A.address, member: M.address, message: 'm1', signature: '0x1', linkedAt: 1 })
    mod.addLink({ anchor: M.address, member: X, message: 'm2', signature: '0x2', linkedAt: 2 })
    expect(mod.groupFor(A.address).addresses).toHaveLength(3)

    mod.removeLink(M.address)

    // A is alone, as the panel already showed…
    expect(mod.groupFor(A.address).addresses).toEqual([A.address.toLowerCase()])
    // …and the record that only reached the group THROUGH M is gone with it,
    // so connecting M later cannot resurrect the branch.
    expect(mod.loadLinks()).toHaveLength(0)
    expect(mod.groupFor(M.address).addresses).toEqual([M.address.toLowerCase()])
  })

  it('survives a corrupted store and unavailable storage', async () => {
    const bad = fakeStorage()
    bad.setItem('spectrum.wallet-links.v1', '{not json')
    const { mod } = await freshModule(bad)
    expect(mod.loadLinks()).toEqual([])

    vi.resetModules()
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('denied')
      },
    })
    const mod2 = await import('./wallet-links')
    expect(mod2.loadLinks()).toEqual([])
    expect(mod2.groupFor(A.address).addresses).toEqual([A.address.toLowerCase()])
  })

  it('verifyLinks keeps only the sound records', async () => {
    const { mod } = await freshModule()
    const message = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.now())
    const signature = await M.signMessage({ message })
    const good = { anchor: A.address, member: M.address, message, signature, linkedAt: 1 }
    const bad = { ...good, member: '0x00000000000000000000000000000000000000dd' }
    expect(await mod.verifyLinks([good, bad], null)).toEqual([good])
  })
})

describe('smart-wallet (ERC-1271) dispatch', () => {
  const CC = '0x00000000000000000000000000000000000000cc'
  // Field-consistent (fields-match runs FIRST); only the signature is
  // contract-wallet-shaped, so recovery fails and the chain path decides.
  const contractish = {
    anchor: A.address.toLowerCase(),
    member: CC,
    message: [
      `Link wallet ${CC}`,
      `to the portfolio of ${A.address.toLowerCase()}`,
      'on demo.spectrum.test (2026-08-03).',
      '',
      'This signature only proves ownership so the two wallets can be viewed as one portfolio in this browser. It approves nothing, spends nothing, and can be undone there at any time.',
    ].join('\n'),
    signature: '0x1271' as const,
    linkedAt: 1,
  }

  it('a signature that does not recover falls through to the chain verifier', async () => {
    const { mod } = await freshModule()
    const asked: number[] = []
    const ok = await mod.verifyLink(contractish, async (chainId) => {
      asked.push(chainId)
      return chainId === 8453
    })
    expect(ok).toBe(true)
    expect(asked.length).toBeGreaterThan(0)
  })

  it('refuses when every chain says no', async () => {
    const { mod } = await freshModule()
    expect(await mod.verifyLink(contractish, async () => false)).toBe(false)
  })

  it('one chain THROWING does not veto another vouching', async () => {
    const { mod } = await freshModule()
    let first = true
    const ok = await mod.verifyLink(contractish, async () => {
      if (first) {
        first = false
        throw new Error('rpc down')
      }
      return true
    })
    expect(ok).toBe(true)
  })

  it('an EOA signature short-circuits without touching the chain', async () => {
    const { mod } = await freshModule()
    const message = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.now())
    const signature = await M.signMessage({ message })
    let touched = false
    const ok = await mod.verifyLink(
      { anchor: A.address, member: M.address, message, signature, linkedAt: 1 },
      async () => {
        touched = true
        return false
      },
    )
    expect(ok).toBe(true)
    expect(touched).toBe(false)
  })
})

describe('session-load screening (classifyLink): transport weather is not tampering', () => {
  const CC = '0x00000000000000000000000000000000000000cc'
  const contractish = {
    anchor: A.address.toLowerCase(),
    member: CC,
    message: [
      `Link wallet ${CC}`,
      `to the portfolio of ${A.address.toLowerCase()}`,
      'on demo.spectrum.test (2026-08-03).',
      '',
      'This signature only proves ownership so the two wallets can be viewed as one portfolio in this browser. It approves nothing, spends nothing, and can be undone there at any time.',
    ].join('\n'),
    signature: '0x1271' as const,
    linkedAt: 1,
  }

  it('an EOA match is sound without touching a chain', async () => {
    const { mod } = await freshModule()
    const message = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.now())
    const signature = await M.signMessage({ message })
    expect(
      await mod.classifyLink({ anchor: A.address, member: M.address, message, signature, linkedAt: 1 }, null),
    ).toBe('sound')
  })

  it('every chain answering NO is unsound', async () => {
    const { mod } = await freshModule()
    expect(await mod.classifyLink(contractish, async () => false)).toBe('unsound')
  })

  it('a downed RPC is UNKNOWN, never unsound — a real group must not shrink over weather', async () => {
    const { mod } = await freshModule()
    expect(
      await mod.classifyLink(contractish, async () => {
        throw new Error('rpc down')
      }),
    ).toBe('unknown')
  })

  it('screenLinks drops only the definitely bad', async () => {
    const { mod } = await freshModule()
    const message = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.now())
    const signature = await M.signMessage({ message })
    const sound = { anchor: A.address, member: M.address, message, signature, linkedAt: 1 }
    const kept = await mod.screenLinks([sound, contractish], async () => {
      throw new Error('rpc down') // the 1271 record cannot be judged today
    })
    expect(kept).toEqual([sound, contractish])
    const strict = await mod.screenLinks([sound, contractish], async () => false)
    expect(strict).toEqual([sound])
  })
})

describe('the anchor field is bound to the signed message (review finding)', () => {
  it('a genuinely-signed record with a REPOINTED anchor field refuses everywhere', async () => {
    const { mod } = await freshModule()
    const message = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.now())
    const signature = await M.signMessage({ message })
    // the attack: keep the real signature, point the FIELD at a rich stranger
    const Z = '0x00000000000000000000000000000000000000ee'
    const tampered = { anchor: Z, member: M.address, message, signature, linkedAt: 1 }
    expect(mod.linkFieldsMatchMessage(tampered)).toBe(false)
    expect(await mod.verifyLink(tampered, null)).toBe(false)
    expect(await mod.classifyLink(tampered, async () => true)).toBe('unsound') // no RPC opinion can save it
    const res = await mod.importBundle(JSON.stringify({ v: 1, exportedAt: 1, links: [tampered] }), null)
    expect(res).toEqual({ added: 0, rejected: 1, capped: 0 })
  })

  it('a non-address anchor never imports', async () => {
    const { mod } = await freshModule()
    const message = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.now())
    const signature = await M.signMessage({ message })
    expect(
      mod.linkFieldsMatchMessage({ anchor: 'zzz', member: M.address, message, signature, linkedAt: 1 }),
    ).toBe(false)
  })

  it('the honest record passes the field check', async () => {
    const { mod } = await freshModule()
    const message = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.now())
    const signature = await M.signMessage({ message })
    expect(
      mod.linkFieldsMatchMessage({ anchor: A.address, member: M.address, message, signature, linkedAt: 1 }),
    ).toBe(true)
  })
})

describe('transitive group resolution (review finding: imported chains)', () => {
  const X = '0x00000000000000000000000000000000000000f1'

  it('a chained import resolves to ONE group from every side', async () => {
    const { mod } = await freshModule()
    // this browser: M linked into A's group; imported: X linked into M's
    mod.addLink({ anchor: A.address, member: M.address, message: 'm1', signature: '0x1', linkedAt: 1 })
    mod.addLink({ anchor: M.address, member: X, message: 'm2', signature: '0x2', linkedAt: 2 })
    const want = [A.address.toLowerCase(), M.address.toLowerCase(), X]
    expect(mod.groupFor(A.address).addresses).toEqual(want)
    expect(mod.groupFor(M.address).addresses).toEqual(want)
    expect(mod.groupFor(X).addresses).toEqual(want)
    expect(mod.groupFor(X).anchor).toBe(A.address.toLowerCase())
  })

  it('a cycle breaks at the same deterministic root from both sides', async () => {
    const { mod } = await freshModule()
    const B = '0x00000000000000000000000000000000000000b2'
    const C = '0x00000000000000000000000000000000000000c3'
    mod.addLink({ anchor: B, member: C, message: 'm1', signature: '0x1', linkedAt: 1 })
    mod.addLink({ anchor: C, member: B, message: 'm2', signature: '0x2', linkedAt: 2 })
    const fromB = mod.groupFor(B)
    const fromC = mod.groupFor(C)
    expect(fromB.anchor).toBe(fromC.anchor)
    expect([...fromB.addresses].sort()).toEqual([...fromC.addresses].sort())
  })

  // ⚠ THE CASE THE PURE-CYCLE TEST ABOVE CANNOT SEE (found 2026-08-11). It
  // walks only cycle members, so breaking at "the smallest of everything
  // WALKED" and "the smallest IN THE CYCLE" agree there and the bug hid. A
  // wallet hanging OFF the cycle is the boundary that tells them apart: from
  // Z the walk is [Z, A, B], and a lexicographically-small Z used to become
  // its own root — Z saw a group of ONE while A and B saw all three. Any
  // wallet whose address sorts below the cycle reproduces it.
  it('a wallet hanging off a cycle still sees the SAME group as the cycle members', async () => {
    const { mod } = await freshModule()
    const Z = '0x0000000000000000000000000000000000000011' // sorts BELOW both
    const A2 = '0x00000000000000000000000000000000000000a1'
    const B2 = '0x00000000000000000000000000000000000000b2'
    // importable shape: Z linked into A2's group; A2↔B2 a cycle from a bundle
    mod.addLink({ anchor: A2, member: Z, message: 'm1', signature: '0x1', linkedAt: 1 })
    mod.addLink({ anchor: B2, member: A2, message: 'm2', signature: '0x2', linkedAt: 2 })
    mod.addLink({ anchor: A2, member: B2, message: 'm3', signature: '0x3', linkedAt: 3 })
    const fromZ = mod.groupFor(Z)
    const fromA = mod.groupFor(A2)
    const fromB = mod.groupFor(B2)
    expect(fromZ.anchor).toBe(fromA.anchor)
    expect(fromB.anchor).toBe(fromA.anchor)
    expect([...fromZ.addresses].sort()).toEqual([Z, A2, B2].sort())
    expect([...fromA.addresses].sort()).toEqual([Z, A2, B2].sort())
    expect([...fromB.addresses].sort()).toEqual([Z, A2, B2].sort())
  })
})

describe('cross-purpose replay: a signature harvested on ANOTHER site', () => {
  // ⚠ THE HOLE THIS PINS (found 2026-08-11). linkFieldsMatchMessage used to
  // run two /…/m regexes over the message — LINE anchors, first-match — so any
  // message merely CONTAINING the two lines passed. An attacker running any
  // site that signs a multi-line message with a user-supplied field (a SIWE
  // statement, a profile bio, a memo) could inject them; the victim signs "to
  // log in" and the attacker holds a record that satisfies the field check AND
  // signature recovery, minted without the victim ever opening this app.
  // Phished through the import door it merges a stranger into their book —
  // rooted at the attacker, whose row the panel gives no unlink button.
  // The check is whole-message equality now. The second test is the one that
  // keeps the fix honest: a REAL link must still verify.
  const ATTACKER = '0x00000000000000000000000000000000000000a1'

  it('a foreign login message carrying the two lines is REFUSED', async () => {
    const { mod } = await freshModule()
    const foreign = [
      'evil-airdrop.example wants you to sign in with your Ethereum account:',
      M.address,
      '',
      'Claim your airdrop.',
      `Link wallet ${M.address.toLowerCase()}`,
      `to the portfolio of ${ATTACKER}`,
      '',
      'URI: https://evil-airdrop.example',
      'Nonce: 32891756',
    ].join('\n')
    const signature = await M.signMessage({ message: foreign })
    const forged = { anchor: ATTACKER, member: M.address.toLowerCase(), message: foreign, signature, linkedAt: Date.now() }
    // the signature is GENUINELY the member's — recovery alone would say yes
    expect(mod.linkFieldsMatchMessage(forged)).toBe(false)
    expect(await mod.verifyLink(forged, null)).toBe(false)
    expect(await mod.classifyLink(forged, null)).toBe('unsound')
  })

  it('the two lines reordered, or padded with junk, is REFUSED', async () => {
    const { mod } = await freshModule()
    const scrambled = [
      `to the portfolio of ${ATTACKER}`,
      'something in between',
      `Link wallet ${M.address.toLowerCase()}`,
      'on demo.spectrum.test (2026-08-11).',
      '',
      'This signature only proves ownership so the two wallets can be viewed as one portfolio in this browser. It approves nothing, spends nothing, and can be undone there at any time.',
    ].join('\n')
    const signature = await M.signMessage({ message: scrambled })
    expect(
      mod.linkFieldsMatchMessage({ anchor: ATTACKER, member: M.address.toLowerCase(), message: scrambled, signature, linkedAt: 0 }),
    ).toBe(false)
  })

  it('a GENUINE link message still verifies — the fix refuses nothing real', async () => {
    const { mod } = await freshModule()
    const msg = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.UTC(2026, 7, 11, 9, 30))
    const signature = await M.signMessage({ message: msg })
    const real = { anchor: A.address, member: M.address, message: msg, signature, linkedAt: Date.now() }
    expect(mod.linkFieldsMatchMessage(real)).toBe(true)
    expect(await mod.verifyLink(real, null)).toBe(true)
  })
})

describe('the change announcement', () => {
  it('fires on add and remove so every hook instance re-reads', async () => {
    const events: string[] = []
    const storage = fakeStorage()
    vi.resetModules()
    vi.stubGlobal('window', {
      localStorage: storage,
      dispatchEvent: (e: Event) => {
        events.push(e.type)
        return true
      },
    })
    const mod = await import('./wallet-links')
    mod.addLink({ anchor: A.address, member: M.address, message: 'm', signature: '0x1', linkedAt: 1 })
    mod.removeLink(M.address)
    expect(events).toEqual([mod.LINKS_CHANGED_EVENT, mod.LINKS_CHANGED_EVENT])
  })
})

describe('the cross-device bundle', () => {
  it('round-trips: export, wipe, import re-verifies and restores', async () => {
    const { mod } = await freshModule()
    const message = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.now())
    const signature = await M.signMessage({ message })
    mod.addLink({ anchor: A.address, member: M.address, message, signature, linkedAt: 1 })
    const json = JSON.stringify(mod.exportBundle())

    // a fresh browser
    const { mod: mod2 } = await freshModule()
    expect(mod2.groupFor(A.address).addresses).toHaveLength(1)
    const res = await mod2.importBundle(json, null)
    expect(res).toEqual({ added: 1, rejected: 0, capped: 0 })
    expect(mod2.groupFor(A.address).addresses).toEqual([A.address.toLowerCase(), M.address.toLowerCase()])
  })

  it('rejects tampered records on import, counts them honestly', async () => {
    const { mod } = await freshModule()
    const message = mod.linkMessage(A.address, M.address, 'demo.spectrum.test', Date.now())
    const signature = await M.signMessage({ message })
    const bundle = {
      v: 1,
      exportedAt: 1,
      links: [
        { anchor: A.address, member: M.address, message, signature, linkedAt: 1 },
        { anchor: A.address, member: '0x00000000000000000000000000000000000000dd', message, signature, linkedAt: 2 },
      ],
    }
    const res = await mod.importBundle(JSON.stringify(bundle), null)
    expect(res).toEqual({ added: 1, rejected: 1, capped: 0 })
  })

  it('says not-a-bundle for garbage rather than half-importing', async () => {
    const { mod } = await freshModule()
    expect(await mod.importBundle('{not json', null)).toBeNull()
    expect(await mod.importBundle('{"v":2,"links":[]}', null)).toBeNull()
    expect(await mod.importBundle('{"v":1,"links":"nope"}', null)).toBeNull()
  })
})

describe('alreadyLinkedMember: the ceremony says so instead of silently waiting', () => {
  // Topology only — groupFor resolves by fields, no crypto needed here.
  const anchor = '0x00000000000000000000000000000000000000aa'
  const member = '0x00000000000000000000000000000000000000bb'
  const stranger = '0x00000000000000000000000000000000000000cc'
  const links = [{ anchor, member, message: '', signature: '0x' as `0x${string}`, linkedAt: 1 }]

  it('names a linked member you switched to', async () => {
    const { mod } = await freshModule()
    expect(mod.alreadyLinkedMember(member, anchor, anchor, null, links)).toBe(member)
  })

  it('stays silent on the account the ceremony started from — standing still is not a switch', async () => {
    const { mod } = await freshModule()
    expect(mod.alreadyLinkedMember(anchor, anchor, anchor, null, links)).toBeNull()
  })

  it('stays silent on the armed candidate — the sign face owns that account', async () => {
    const { mod } = await freshModule()
    expect(mod.alreadyLinkedMember(stranger, anchor, anchor, stranger, links)).toBeNull()
  })

  it('stays silent on a stranger — the watcher offers it to sign instead', async () => {
    const { mod } = await freshModule()
    expect(mod.alreadyLinkedMember(stranger, anchor, anchor, null, links)).toBeNull()
  })

  it('names the anchor when the ceremony began from a member', async () => {
    const { mod } = await freshModule()
    expect(mod.alreadyLinkedMember(anchor, anchor, member, null, links)).toBe(anchor)
  })

  it('is case-insensitive about every address it is handed', async () => {
    const { mod } = await freshModule()
    expect(
      mod.alreadyLinkedMember(member.toUpperCase().replace('0X', '0x'), anchor, anchor, null, links),
    ).toBe(member)
  })

  it('answers nothing without a connected account or an armed anchor', async () => {
    const { mod } = await freshModule()
    expect(mod.alreadyLinkedMember(undefined, anchor, anchor, null, links)).toBeNull()
    expect(mod.alreadyLinkedMember(member, null, anchor, null, links)).toBeNull()
  })
})
