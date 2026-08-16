import { beforeEach, describe, expect, it, vi } from 'vitest'

function fakeStorage(seed: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(seed))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => void m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
    _map: m,
  }
}

async function fresh(seed: Record<string, string> = {}) {
  vi.resetModules()
  const storage = fakeStorage(seed)
  vi.stubGlobal('window', { localStorage: storage })
  const mod = await import('./state-bundle')
  return { mod, storage }
}

beforeEach(() => vi.unstubAllGlobals())

describe('the state bundle: intent and records travel, caches never', () => {
  it('exports allocation state, pnl indexes and the dot-namespace; excludes caches and foreign keys', async () => {
    const { mod } = await fresh({
      'spectrum:allocation:draft:0xabc': '{"targets":[]}',
      'pnl:v3:8453:0xabc:0xrouter': '{"upToBlock":"9"}',
      'spectrum.portfolio-intro.v1': '"done"',
      'spectrum:cache:v1:v4hub:8453': '{"stale":"cache"}',
      'wagmi.store': '{"not":"ours"}',
    })
    const b = mod.exportStateBundle(123)
    expect(Object.keys(b.entries).sort()).toEqual([
      'pnl:v3:8453:0xabc:0xrouter',
      'spectrum.portfolio-intro.v1',
      'spectrum:allocation:draft:0xabc',
    ])
    expect(b).toMatchObject({ v: 1, kind: 'spectrum-state', exportedAt: 123 })
  })

  it('restores only ABSENT keys — local work is never clobbered', async () => {
    const { mod, storage } = await fresh({
      'spectrum:allocation:draft:0xabc': '{"targets":["local-newer"]}',
    })
    const report = await mod.importStateBundle(
      JSON.stringify({
        v: 1,
        kind: 'spectrum-state',
        exportedAt: 1,
        entries: {
          'spectrum:allocation:draft:0xabc': '{"targets":["remote-older"]}',
          'spectrum:allocation:portfolio:0xabc': '{"targets":[],"amountUsd":1}',
        },
      }),
      null,
    )
    expect(report).toMatchObject({ restored: 1, skippedExisting: 1, rejected: 0 })
    expect(storage.getItem('spectrum:allocation:draft:0xabc')).toContain('local-newer')
    expect(storage.getItem('spectrum:allocation:portfolio:0xabc')).toContain('amountUsd')
  })

  it('refuses cache keys, foreign keys and non-JSON values, counting them', async () => {
    const { mod, storage } = await fresh()
    const report = await mod.importStateBundle(
      JSON.stringify({
        v: 1,
        kind: 'spectrum-state',
        exportedAt: 1,
        entries: {
          'spectrum:cache:v1:x': '{"a":1}',
          'evil-key': '{"a":1}',
          'spectrum:allocation:draft:0xdef': 'not json{',
        },
      }),
      null,
    )
    expect(report).toMatchObject({ restored: 0, rejected: 3 })
    expect(storage.length).toBe(0)
  })

  it('routes wallet links through signature verification, never a raw write', async () => {
    const { mod, storage } = await fresh()
    const report = await mod.importStateBundle(
      JSON.stringify({
        v: 1,
        kind: 'spectrum-state',
        exportedAt: 1,
        entries: {
          'spectrum.wallet-links.v1': JSON.stringify([
            { anchor: '0xa', member: '0xb', message: 'forged', signature: '0xdead', linkedAt: 1 },
          ]),
        },
      }),
      null,
    )
    expect(report?.links).toEqual({ added: 0, rejected: 1, capped: 0 })
    expect(storage.getItem('spectrum.wallet-links.v1')).toBeNull()
  })

  it('says not-a-bundle for garbage and for a links-only file', async () => {
    const { mod } = await fresh()
    expect(await mod.importStateBundle('{oops', null)).toBeNull()
    expect(await mod.importStateBundle(JSON.stringify({ v: 1, exportedAt: 1, links: [] }), null)).toBeNull()
  })

  it('round-trips: export from one browser, restore into an empty one', async () => {
    const { mod } = await fresh({
      'spectrum:allocation:portfolio:0xabc': '{"targets":[{"w":1}],"amountUsd":5}',
      'pnl:v3:1:0xabc:0xr': '{"upToBlock":"77","positions":{}}',
    })
    const json = JSON.stringify(mod.exportStateBundle())
    const { mod: mod2, storage: s2 } = await fresh()
    const report = await mod2.importStateBundle(json, null)
    expect(report).toMatchObject({ restored: 2, skippedExisting: 0, rejected: 0 })
    expect(s2.getItem('pnl:v3:1:0xabc:0xr')).toContain('77')
  })
})
