import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUILDER_DRAFT_PREFIX,
  COMPOSER_DRAFT_KEY,
  markTickerDeployed,
  hasShareStamp,
  inProgressLaunches,
  journeyOfBasket,
  journeyOfDraft,
  launchJourneys,
  markShared,
  read,
  readLaunchDrafts,
  readShareStamps,
  resumeHeadline,
  stepOf,
  unread,
  type BasketRef,
  type DraftRef,
  type JourneyStorage,
} from './launch-journey'

// the owner's 2026-08-13 ruling, pinned: "you should ALWAYS be guided through the
// entire setup, and even if you accidentally refresh or click off you should
// always be able to resume from your creator page or /create."
//
// The tests that matter most here are the LYING tests. Every "done" this model
// emits has to trace to a read that answered — so the ones proving it says
// UNKNOWN instead of guessing carry more weight than the happy paths.

const basket = (over: Partial<BasketRef> = {}): BasketRef => ({
  chainId: 8453,
  address: '0x1111111111111111111111111111111111111111',
  name: 'Blue Chip Index',
  symbol: 'BLUE',
  supply: read(0),
  thesis: read(''),
  sharedLocally: false,
  ...over,
})

const draft = (over: Partial<DraftRef> = {}): DraftRef => ({
  kind: 'composer',
  key: COMPOSER_DRAFT_KEY,
  chainId: null,
  predecessor: null,
  name: 'Half Built',
  symbol: 'HALF',
  assetCount: 3,
  symbols: ['WETH', 'USDC', 'DAI'],
  savedAt: 1_700_000_000_000,
  ...over,
})

describe('the four states the ruling names', () => {
  it('an unseeded deployed basket reports SEED as the next step', () => {
    const j = journeyOfBasket(basket({ supply: read(0) }))
    expect(j.resumeAt).toBe('seed')
    expect(j.next).toBe('seed')
    expect(j.complete).toBe(false)
    expect(j.uncertain).toBe(false)
    expect(stepOf(j, 'deploy').status).toBe('done')
    expect(stepOf(j, 'seed').status).toBe('todo')
  })

  it('a seeded basket with no note reports THESIS as the next step', () => {
    const j = journeyOfBasket(basket({ supply: read(1_000), thesis: read('') }))
    expect(stepOf(j, 'seed').status).toBe('done')
    expect(j.resumeAt).toBe('thesis')
    expect(j.complete).toBe(false)
  })

  it('everything done reports COMPLETE', () => {
    const j = journeyOfBasket(
      basket({ supply: read(1_000), thesis: read('bluechips, equal weight'), sharedLocally: true }),
    )
    expect(j.resumeAt).toBeNull()
    expect(j.next).toBeNull()
    expect(j.complete).toBe(true)
    expect(j.uncertain).toBe(false)
  })

  it('a draft with no deploy reports CONTINUE BUILDING', () => {
    const j = journeyOfDraft(draft())
    expect(j.resumeAt).toBe('build')
    expect(j.complete).toBe(false)
    // and it does not pretend to know anything about a basket that is not there
    expect(stepOf(j, 'seed').status).toBe('todo')
    expect(stepOf(j, 'seed').evidence).toContain('no basket yet')
  })
})

describe('the anti-lying law: an unread read is never a done and never a zero', () => {
  it('an unreadable supply reports UNKNOWN, not "not seeded"', () => {
    const j = journeyOfBasket(basket({ supply: unread('rpc refused') }))
    expect(stepOf(j, 'seed').status).toBe('unknown')
    expect(stepOf(j, 'seed').evidence).toContain('rpc refused')
    expect(j.uncertain).toBe(true)
    expect(j.complete).toBe(false)
  })

  it('an unreadable note registry reports UNKNOWN, not "no thesis"', () => {
    const j = journeyOfBasket(basket({ supply: read(5), thesis: unread('every getLogs window refused') }))
    expect(stepOf(j, 'thesis').status).toBe('unknown')
    expect(j.uncertain).toBe(true)
  })

  it('an unreadable step can never make a journey COMPLETE, even with everything else done', () => {
    const j = journeyOfBasket(
      basket({ supply: unread('rpc refused'), thesis: read('written'), sharedLocally: true }),
    )
    expect(j.complete).toBe(false)
    expect(j.uncertain).toBe(true)
  })

  it('a NaN supply is unknown — a broken decoder must not read as "nobody bought in"', () => {
    const j = journeyOfBasket(basket({ supply: read(Number.NaN) }))
    expect(stepOf(j, 'seed').status).toBe('unknown')
    expect(j.uncertain).toBe(true)
  })

  it('a negative supply is not "seeded"', () => {
    expect(stepOf(journeyOfBasket(basket({ supply: read(-1) })), 'seed').status).toBe('todo')
  })

  it('a whitespace-only note is not a thesis', () => {
    const j = journeyOfBasket(basket({ supply: read(5), thesis: read('   \n  ') }))
    expect(stepOf(j, 'thesis').status).toBe('todo')
    expect(j.resumeAt).toBe('thesis')
  })

  it('every step states WHERE its status came from', () => {
    const j = journeyOfBasket(basket({ supply: read(3), thesis: read('why') }))
    for (const step of j.steps) expect(step.evidence.length).toBeGreaterThan(0)
    expect(stepOf(j, 'seed').evidence).toContain('effectiveSupply')
    expect(stepOf(j, 'deploy').evidence).toContain('exists on chain')
  })
})

describe('the share step is local, and says so', () => {
  it('names itself a local stamp in both directions — never a fact about the world', () => {
    expect(stepOf(journeyOfBasket(basket({ sharedLocally: true })), 'share').evidence).toContain('this device')
    expect(stepOf(journeyOfBasket(basket({ sharedLocally: false })), 'share').evidence).toContain('device')
  })

  it('never holds a launch open: a live, seeded, written basket is COMPLETE unshared', () => {
    const j = journeyOfBasket(basket({ supply: read(9), thesis: read('the case'), sharedLocally: false }))
    expect(j.complete).toBe(true)
    expect(j.resumeAt).toBeNull()
    // ...but the post-deploy card can still offer it, which is what `next` is for
    expect(j.next).toBe('share')
  })

  it('is therefore never offered by a RESUME surface on its own', () => {
    const done = basket({ supply: read(9), thesis: read('the case'), sharedLocally: false })
    expect(inProgressLaunches({ drafts: [], baskets: [done] })).toHaveLength(0)
  })
})

describe('what the wallet has in flight', () => {
  it('offers only launches with something outstanding', () => {
    const finished = basket({ address: '0xaaa', supply: read(1), thesis: read('done'), sharedLocally: true })
    const unseeded = basket({ address: '0xbbb', supply: read(0) })
    const list = inProgressLaunches({ drafts: [draft()], baskets: [finished, unseeded] })
    expect(list.map((j) => j.resumeAt)).toEqual(['build', 'seed'])
  })

  it('offers an UNREADABLE basket too — "we could not check" is worth saying', () => {
    const murky = basket({ supply: unread('rpc refused') })
    expect(inProgressLaunches({ drafts: [], baskets: [murky] })).toHaveLength(1)
  })

  it('drafts lead — a draft is the only thing that disappears if forgotten', () => {
    const list = launchJourneys({ drafts: [draft()], baskets: [basket({ supply: read(0) })] })
    expect(list[0].subject.kind).toBe('draft')
  })

  it('freshest draft first', () => {
    const older = draft({ key: `${BUILDER_DRAFT_PREFIX}1`, kind: 'builder', chainId: 1, savedAt: 1 })
    const newer = draft({ savedAt: 2 })
    const list = launchJourneys({ drafts: [older, newer], baskets: [] })
    expect(list.map((j) => j.id)).toEqual([`draft:${COMPOSER_DRAFT_KEY}`, `draft:${BUILDER_DRAFT_PREFIX}1`])
  })

  it('seeding outranks thesis-writing: the blocking loose end is offered first', () => {
    const needsThesis = basket({ address: '0xaaa', supply: read(1), thesis: read('') })
    const needsSeed = basket({ address: '0xbbb', supply: read(0) })
    const list = inProgressLaunches({ drafts: [], baskets: [needsThesis, needsSeed] })
    expect(list.map((j) => j.resumeAt)).toEqual(['seed', 'thesis'])
  })

  it('an UNREADABLE basket sorts behind every real loose end — never offered first', () => {
    const murky = basket({ address: '0xaaa', supply: unread('rpc refused') })
    const needsThesis = basket({ address: '0xbbb', supply: read(1), thesis: read('') })
    const list = inProgressLaunches({ drafts: [], baskets: [murky, needsThesis] })
    expect(list.map((j) => j.uncertain)).toEqual([false, true])
  })

  it('…but it is still the offer when it is the ONLY news', () => {
    const murky = basket({ supply: unread('rpc refused') })
    expect(inProgressLaunches({ drafts: [], baskets: [murky] })[0].uncertain).toBe(true)
  })

  it('nothing anywhere is an empty list, never a card with nothing in it', () => {
    expect(inProgressLaunches({ drafts: [], baskets: [] })).toEqual([])
  })
})

describe('the headline never states what it could not read', () => {
  it('says it could not read, and names NO next step', () => {
    const line = resumeHeadline(journeyOfBasket(basket({ supply: unread('rpc refused') })))
    expect(line).toContain('couldn’t read')
    expect(line).not.toContain('next:')
  })

  it('names the next step when it genuinely knows it', () => {
    expect(resumeHeadline(journeyOfBasket(basket({ supply: read(0) })))).toContain('seed it')
  })

  it('falls back to a description, never a blank, for an unnamed subject', () => {
    expect(resumeHeadline(journeyOfDraft(draft({ name: '  ' })))).toContain('unnamed draft')
    expect(resumeHeadline(journeyOfBasket(basket({ name: '', symbol: '', supply: read(0) })))).toContain(
      'your basket',
    )
  })
})

// ── the storage half ─────────────────────────────────────────────────────────

class MemStore implements JourneyStorage {
  private rows = new Map<string, string>()
  get length() {
    return this.rows.size
  }
  key(i: number) {
    return [...this.rows.keys()][i] ?? null
  }
  getItem(k: string) {
    return this.rows.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.rows.set(k, v)
  }
  removeItem(k: string) {
    this.rows.delete(k)
  }
}

const composerRow = JSON.stringify({
  assets: [{ symbol: 'WETH' }, { symbol: 'USDC' }],
  weights: [50, 50],
  name: 'Two Things',
  symbol: 'TWO',
  savedAt: 1_700_000_000_000,
})

describe('finding the drafts that already persist', () => {
  it('finds the composer draft under its shipped key', () => {
    const s = new MemStore()
    s.setItem(COMPOSER_DRAFT_KEY, composerRow)
    const [d] = readLaunchDrafts(s)
    expect(d).toMatchObject({
      kind: 'composer',
      chainId: null,
      name: 'Two Things',
      symbol: 'TWO',
      assetCount: 2,
      symbols: ['WETH', 'USDC'],
    })
  })

  it('finds a chain-scoped builder draft and recovers its chain', () => {
    const s = new MemStore()
    s.setItem(`${BUILDER_DRAFT_PREFIX}4663`, JSON.stringify({ assets: [{ symbol: 'RH' }], weights: [100], name: 'Rh' }))
    const [d] = readLaunchDrafts(s)
    expect(d).toMatchObject({ kind: 'builder', chainId: 4663, predecessor: null, assetCount: 1 })
  })

  it('recovers the predecessor from a version-mode draft key', () => {
    const s = new MemStore()
    s.setItem(
      `${BUILDER_DRAFT_PREFIX}8453:from:0xabc`,
      JSON.stringify({ assets: [{ symbol: 'X' }], weights: [100], name: 'V2' }),
    )
    expect(readLaunchDrafts(s)[0]).toMatchObject({ chainId: 8453, predecessor: '0xabc' })
  })

  it('a corrupt or empty row is NOT offered as a launch (never repaired, never guessed)', () => {
    const s = new MemStore()
    s.setItem(COMPOSER_DRAFT_KEY, '{{{ not json')
    s.setItem(`${BUILDER_DRAFT_PREFIX}1`, JSON.stringify({ assets: [], weights: [], name: '', symbol: '' }))
    s.setItem(`${BUILDER_DRAFT_PREFIX}8453`, JSON.stringify({ nope: true }))
    s.setItem(`${BUILDER_DRAFT_PREFIX}notanumber`, JSON.stringify({ assets: [{ symbol: 'X' }], name: 'x' }))
    expect(readLaunchDrafts(s)).toEqual([])
  })

  it('a draft with no assets but a name IS still a draft — the words are work too', () => {
    const s = new MemStore()
    s.setItem(`${BUILDER_DRAFT_PREFIX}1`, JSON.stringify({ assets: [], weights: [], name: 'Named It First' }))
    expect(readLaunchDrafts(s)).toHaveLength(1)
  })

  it('ignores unrelated keys, including near-misses', () => {
    const s = new MemStore()
    s.setItem('spectrum:allocation:draft:0xabc', composerRow)
    s.setItem('spectrum:launch-draft:v1:1', composerRow)
    expect(readLaunchDrafts(s)).toEqual([])
  })

  it('no storage at all is an empty list, not a crash', () => {
    expect(readLaunchDrafts(null)).toEqual([])
  })

  it('the key strings match the ones the owning files construct', () => {
    // pages/Composer.tsx COMPOSER_DRAFT_KEY · components/launch/BasketBuilder.tsx
    // DRAFT_PREFIX. Both owners keep their loaders private, so this is the
    // drift alarm: if either renames its key, this fails instead of the resume
    // card silently going quiet forever.
    expect(COMPOSER_DRAFT_KEY).toBe('spectrum:composer-draft:v1')
    expect(BUILDER_DRAFT_PREFIX).toBe('spectrum:launch-draft:v2:')
  })
})

describe('the local share stamp', () => {
  it('round-trips, and is scoped per chain and address', () => {
    const s = new MemStore()
    markShared(8453, '0xAAA', s)
    const stamps = readShareStamps(s)
    expect(hasShareStamp(stamps, 8453, '0xaaa')).toBe(true)
    expect(hasShareStamp(stamps, 1, '0xaaa')).toBe(false)
    expect(hasShareStamp(stamps, 8453, '0xbbb')).toBe(false)
  })

  it('a corrupt stamp row reads as no stamps, never as a claim', () => {
    const s = new MemStore()
    s.setItem('spectrum:launch-shared:v1', '{{{')
    expect(readShareStamps(s).size).toBe(0)
  })

  it('storage being unavailable is survivable in both directions', () => {
    expect(() => markShared(1, '0xaaa', null)).not.toThrow()
    expect(readShareStamps(null).size).toBe(0)
  })
})


describe('markTickerDeployed × the interrupted-run guard (create-flow recovery audit, 2026-08-15)', () => {
  const draftRow = JSON.stringify({ assets: [{ symbol: 'WETH' }], weights: [100], name: 'Two', symbol: 'TWO', savedAt: 1 })
  const stub = () => {
    const mem = new MemStore()
    vi.stubGlobal('localStorage', mem as unknown as Storage)
    return mem
  }
  afterEach(() => vi.unstubAllGlobals())

  it('with NO persisted run, the stamp deletes the matching draft (the TEST100 ghost stays dead)', () => {
    const mem = stub()
    mem.setItem(COMPOSER_DRAFT_KEY, draftRow)
    markTickerDeployed('TWO')
    expect(mem.getItem(COMPOSER_DRAFT_KEY)).toBeNull()
  })
  it('with an UNFINISHED landed-lanes run persisted, the draft SURVIVES — it is the resume door', () => {
    const mem = stub()
    mem.setItem(COMPOSER_DRAFT_KEY, draftRow)
    mem.setItem('spectrum:landed-lanes:v1', JSON.stringify({ name: 'Two', lanes: [{ chainId: 8453, newAddress: '0x1' }] }))
    markTickerDeployed('TWO')
    expect(mem.getItem(COMPOSER_DRAFT_KEY)).not.toBeNull()
  })
  it('an EMPTY-lanes row does not shield the draft (nothing to resume)', () => {
    const mem = stub()
    mem.setItem(COMPOSER_DRAFT_KEY, draftRow)
    mem.setItem('spectrum:landed-lanes:v1', JSON.stringify({ name: 'Two', lanes: [] }))
    markTickerDeployed('TWO')
    expect(mem.getItem(COMPOSER_DRAFT_KEY)).toBeNull()
  })
  it('an unreadable row falls through to the deletion (never a crash)', () => {
    const mem = stub()
    mem.setItem(COMPOSER_DRAFT_KEY, draftRow)
    mem.setItem('spectrum:landed-lanes:v1', '{{{ not json')
    markTickerDeployed('TWO')
    expect(mem.getItem(COMPOSER_DRAFT_KEY)).toBeNull()
  })
})
