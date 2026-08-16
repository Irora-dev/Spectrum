import { describe, expect, it } from 'vitest'
import { parseChainParam } from './Composer'
import { CHAINS, SUPPORTED_CHAIN_IDS, chainCfg } from '../lib/chain/chains'

// ─────────────────────────────────────────────────────────────────────────────
// THE /createbasket DEEP LINK IS AN EXTERNAL CONTRACT (Prismbeat's bot, 2026-07-08).
// Something outside this repo builds these URLs, so the accepted `?chain=` values
// are a published interface rather than an internal detail — they cannot quietly
// narrow. This file exists because they DID quietly narrow: the parser carried a
// hand-written {eth, ethereum, mainnet, base} map that omitted robinhood, the one
// chain every live basket is on (SpectrumContracts, 2026-08-07: 21 of 21 on 4663,
// zero on Base or Ethereum). Nothing failed loudly — a link naming that chain just
// silently fell back to whatever the user was already on, which for a basket
// (single-chain by construction, one V2 factory per chain) is the wrong chain.
// ─────────────────────────────────────────────────────────────────────────────

describe('parseChainParam — the ?chain= contract', () => {
  it('accepts EVERY supported chain by its own table key, so the parser cannot drift from the table', () => {
    for (const id of SUPPORTED_CHAIN_IDS) {
      expect(parseChainParam(chainCfg(id).key)).toBe(id)
    }
  })

  it('accepts every supported chain by its numeric id', () => {
    for (const id of SUPPORTED_CHAIN_IDS) {
      expect(parseChainParam(String(id))).toBe(id)
    }
  })

  it('names the Robinhood chain — the regression this file was written for', () => {
    // guarded rather than asserted flat: 4663 is an operator opt-in
    // (VITE_EXTRA_CHAIN_IDS), so on a build without it the honest answer is null
    if (SUPPORTED_CHAIN_IDS.includes(4663)) {
      expect(parseChainParam('robinhood')).toBe(4663)
      expect(parseChainParam('rh')).toBe(4663)
      expect(parseChainParam('4663')).toBe(4663)
    } else {
      expect(parseChainParam('robinhood')).toBeNull()
    }
  })

  it('is case- and whitespace-insensitive, the way a hand-built URL arrives', () => {
    const id = SUPPORTED_CHAIN_IDS[0]
    const key = chainCfg(id).key
    expect(parseChainParam(`  ${key.toUpperCase()}  `)).toBe(id)
  })

  it('refuses an unsupported chain rather than guessing — including one that exists but is not enabled', () => {
    expect(parseChainParam('137')).toBeNull() // polygon: a real chain, not ours
    expect(parseChainParam('solana')).toBeNull()
    expect(parseChainParam('not-a-chain')).toBeNull()
  })

  it('refuses the EMPTY and blank forms — Number("") is 0, not NaN, so this needs its own case', () => {
    // the exact coercion that has bitten this codebase before: an empty string
    // reaching Number() produces a valid integer, so only the supported-set check
    // stands between "" and a confidently wrong chain
    expect(parseChainParam('')).toBeNull()
    expect(parseChainParam('   ')).toBeNull()
    expect(parseChainParam(null)).toBeNull()
  })

  it('refuses a fractional or signed id rather than truncating it', () => {
    expect(parseChainParam('8453.5')).toBeNull()
    expect(parseChainParam('-8453')).toBeNull()
  })

  it('every alias it accepts resolves to a chain the table actually knows', () => {
    // an alias pointing at an id absent from CHAINS would be a dead string that
    // reads as support; the supported-set check is what makes that impossible
    for (const alias of ['eth', 'mainnet', 'rh', 'robinhoodchain']) {
      const got = parseChainParam(alias)
      if (got != null) expect(CHAINS[got]).toBeDefined()
    }
  })
})
