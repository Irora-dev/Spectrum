// The service worker's storage machinery, against a faked chrome.storage:
// the localStorage shim (persist-cache must actually cache in a worker with no
// window) and the notification cooldown gate (an oscillating threshold must
// not spam).

import { beforeEach, describe, expect, it } from 'vitest'

type Area = Map<string, unknown>

function fakeChromeStorage() {
  const areas: Record<'local' | 'sync', Area> = { local: new Map(), sync: new Map() }
  const api = (area: Area) => ({
    get: (key: string) => Promise.resolve(area.has(key) ? { [key]: area.get(key) } : {}),
    set: (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) area.set(k, v)
      return Promise.resolve()
    },
    remove: (key: string) => {
      area.delete(key)
      return Promise.resolve()
    },
  })
  ;(globalThis as Record<string, unknown>).chrome = {
    storage: { local: api(areas.local), sync: api(areas.sync) },
  }
  return areas
}

describe('localStorage shim', () => {
  let areas: ReturnType<typeof fakeChromeStorage>

  beforeEach(() => {
    areas = fakeChromeStorage()
    // A fresh window per test so installs don't leak between tests.
    delete (globalThis as Record<string, unknown>).window
    delete (globalThis as Record<string, unknown>).localStorage
  })

  it('gives persist-cache a working TTL cache in a window-less context', async () => {
    const shim = await import('./localstorage-shim')
    shim.installLocalStorageShim()
    await shim.hydrateLocalStorageShim()

    // The REAL shared-lib module, unmodified, running against the shim.
    const { cacheGet, cacheSet } = await import('@app/lib/spectrum/persist-cache')
    cacheSet('probe', { hello: 'lens' }, 60_000)
    expect(cacheGet('probe')).toEqual({ hello: 'lens' })

    cacheSet('expired', 'gone', 1) // 1ms TTL (0 or less means "never expires")
    await new Promise((r) => setTimeout(r, 10))
    expect(cacheGet('expired')).toBeNull()
  })

  it('persists through chrome.storage.local and hydrates back', async () => {
    const shim = await import('./localstorage-shim')
    shim.installLocalStorageShim()
    await shim.hydrateLocalStorageShim()

    const w = (globalThis as { window?: { localStorage?: Storage } }).window
    w!.localStorage!.setItem('k1', 'v1')
    await shim.flushLocalStorageShim()

    const backing = areas.local.get('lscache/v1') as Record<string, string>
    expect(backing.k1).toBe('v1')
  })
})

describe('cooldown gate', () => {
  beforeEach(() => {
    fakeChromeStorage()
  })

  it('lets a firing through once, then holds it for the window', async () => {
    const { filterCooldown } = await import('./storage')
    const firing = [{ key: 'drift:r1:8453:0xa' }]
    const t0 = 1_000_000

    expect(await filterCooldown(firing, t0)).toHaveLength(1)
    expect(await filterCooldown(firing, t0 + 60_000)).toHaveLength(0) // oscillation stays quiet
    expect(await filterCooldown(firing, t0 + 7 * 60 * 60 * 1000)).toHaveLength(1) // window passed
  })

  it('gates per key, not globally', async () => {
    const { filterCooldown } = await import('./storage')
    const t0 = 1_000_000
    await filterCooldown([{ key: 'a' }], t0)
    const out = await filterCooldown([{ key: 'a' }, { key: 'b' }], t0 + 1)
    expect(out.map((f) => f.key)).toEqual(['b'])
  })
})
