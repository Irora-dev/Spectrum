import { describe, expect, it } from 'vitest'
import { ALLOWED_CHAIN_IDS, browserFetchAllowed, buildZeroxUpstream, originAllowed, PROXY_PREFIX, stripProxyPrefix, ZEROX_HOST } from './zerox-proxy-request'

// THE PROXY'S REQUEST CONTRACT. The key it holds is only as safe as the thing
// in front of it: a proxy that forwards what it is handed is an open relay, so
// every upstream URL is REBUILT from an allowlist and these are the pins that
// say so. Two properties matter most and both are negative — nothing a caller
// sends may reach the upstream URL unless it was validated, and nothing may
// redirect us off 0x.

const TOKEN_A = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TOKEN_B = '0x4200000000000000000000000000000000000006'
const TAKER = '0x0fe4223AD99dF788A6Dcad148eB4086E6389cEB6'
const PATH = '/swap/allowance-holder/quote'

const q = (over: Record<string, string> = {}) =>
  new URLSearchParams({ chainId: '8453', sellToken: TOKEN_A, buyToken: TOKEN_B, sellAmount: '250000000', taker: TAKER, ...over })

describe('the happy path builds exactly the URL we intend', () => {
  it('rebuilds a clean upstream URL on the pinned host', () => {
    const r = buildZeroxUpstream(PATH, q())
    expect(r.ok).toBe(true)
    expect(r.ok && r.url.startsWith(`${ZEROX_HOST}${PATH}?`)).toBe(true)
    expect(r.ok && r.url).toContain('chainId=8453')
  })
  it('accepts every supported chain — and NOT the price endpoint, which nothing calls', () => {
    for (const id of ALLOWED_CHAIN_IDS) expect(buildZeroxUpstream(PATH, q({ chainId: String(id) })).ok, `chain ${id}`).toBe(true)
    // /price was allowlisted with no caller: double the free-oracle surface
    // for zero benefit. It comes back WITH its caller, not before.
    expect(buildZeroxUpstream('/swap/allowance-holder/price', q()).ok).toBe(false)
  })
  it('carries an optional slippage when it is well formed', () => {
    const r = buildZeroxUpstream(PATH, q({ slippageBps: '50' }))
    expect(r.ok && r.url).toContain('slippageBps=50')
  })
})

describe('IT IS NOT AN OPEN RELAY — nothing unvalidated reaches the upstream URL', () => {
  it('THE EXACT URL, byte for byte — the only assertion a passthrough cannot survive', () => {
    // ⚠ THE ORIGINAL PIN HERE DID NOT HOLD (A6 review, 2026-08-07). It named
    // three parameters and asserted their absence, so replacing the rebuild
    // with `new URLSearchParams(params)` minus those three — a COMPLETE open
    // relay — kept all 15 tests green under a describe block literally titled
    // "IT IS NOT AN OPEN RELAY". Naming absences can only ever test the
    // absences you thought of. The URL itself is the property.
    const r = buildZeroxUpstream(PATH, q())
    expect(r.ok && r.url).toBe(
      `${ZEROX_HOST}${PATH}?chainId=8453&sellToken=${TOKEN_A}&buyToken=${TOKEN_B}&sellAmount=250000000&taker=${TAKER}`,
    )
  })

  it('the forwarded parameter SET is exactly the allowlist, whatever is stuffed in', () => {
    // twenty junk parameters, including the v2 fee names the earlier pin
    // missed entirely — it named 0x *v1* fee params (affiliateAddress,
    // feeRecipient) against a v2 endpoint, so it was guarding inert spellings
    // while the ones that actually redirect a fee went unmentioned.
    const junk: Record<string, string> = {
      swapFeeRecipient: TAKER, swapFeeBps: '100', swapFeeToken: TOKEN_A, // v2 fee params — the real ones
      affiliateAddress: TAKER, feeRecipient: TAKER, feeSellTokenPercentage: '1', // v1, kept for completeness
      excludedSources: 'everything', includedSources: 'nothing', gasPrice: '1', slippagePercentage: '1',
      priceImpactProtectionPercentage: '0', enableSlippageProtection: 'false', intentOnFilling: 'true',
      skipValidation: 'true', takerAddress: TAKER, buyAmount: '1', sellEntireBalance: 'true',
      integrator: 'x', partner: 'x', referrer: 'x',
    }
    const r = buildZeroxUpstream(PATH, q(junk))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect([...new URL(r.url).searchParams.keys()].sort()).toEqual(['buyToken', 'chainId', 'sellAmount', 'sellToken', 'taker'])
    }
  })

  it('and with a valid slippage the set grows by exactly that one key', () => {
    const r = buildZeroxUpstream(PATH, q({ slippageBps: '50', swapFeeBps: '999' }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect([...new URL(r.url).searchParams.keys()].sort()).toEqual(['buyToken', 'chainId', 'sellAmount', 'sellToken', 'slippageBps', 'taker'])
    }
  })

  it('forwards the NORMALIZED chainId, not the raw one — one value, one reading', () => {
    const r = buildZeroxUpstream(PATH, q({ chainId: '0008453' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(new URL(r.url).searchParams.get('chainId')).toBe('8453')
  })

  it('refuses any path but the two we use — including traversal shapes', () => {
    for (const p of ['/swap/permit2/quote', '/', '/orderbook/v1/orders', '/swap/allowance-holder/quote/../../admin', '']) {
      const r = buildZeroxUpstream(p, q())
      expect(r.ok, p).toBe(false)
      expect(!r.ok && r.status).toBe(404)
    }
  })

  it('cannot be pointed at another host through a parameter', () => {
    const r = buildZeroxUpstream(PATH, q({ sellToken: 'https://attacker.example/x' }))
    expect(r.ok).toBe(false)
    // and even a valid request only ever names our pinned host
    const good = buildZeroxUpstream(PATH, q())
    expect(good.ok && new URL(good.url).origin).toBe(new URL(ZEROX_HOST).origin)
  })

  it('refuses an unsupported chain — we are not a general-purpose 0x gateway', () => {
    for (const bad of ['137', '0', '-1', '99999999', 'abc', '']) {
      expect(buildZeroxUpstream(PATH, q({ chainId: bad })).ok, bad).toBe(false)
    }
  })

  it('refuses malformed addresses in either token or the taker', () => {
    for (const bad of ['0x123', 'not-an-address', '', `${TOKEN_A}extra`]) {
      expect(buildZeroxUpstream(PATH, q({ sellToken: bad })).ok, `sell ${bad}`).toBe(false)
      expect(buildZeroxUpstream(PATH, q({ buyToken: bad })).ok, `buy ${bad}`).toBe(false)
      expect(buildZeroxUpstream(PATH, q({ taker: bad })).ok, `taker ${bad}`).toBe(false)
    }
  })

  it('refuses a self-swap — a no-op that only burns quota', () => {
    expect(buildZeroxUpstream(PATH, q({ buyToken: TOKEN_A })).ok).toBe(false)
    expect(buildZeroxUpstream(PATH, q({ buyToken: TOKEN_A.toLowerCase() })).ok).toBe(false)
  })

  it('refuses a hostile sellAmount: zero, negative, unbounded or not a number', () => {
    for (const bad of ['0', '000', '-1', '1.5', '1e21', 'NaN', '', '9'.repeat(41)]) {
      expect(buildZeroxUpstream(PATH, q({ sellAmount: bad })).ok, bad).toBe(false)
    }
    expect(buildZeroxUpstream(PATH, q({ sellAmount: '9'.repeat(40) })).ok).toBe(true) // at the bound
  })

  it('refuses a malformed slippage rather than silently dropping it', () => {
    // dropping it would quote a DIFFERENT trade than the caller asked for
    for (const bad of ['-1', 'abc', '99999', '1.5']) {
      expect(buildZeroxUpstream(PATH, q({ slippageBps: bad })).ok, bad).toBe(false)
    }
  })

  it('never echoes caller input into the refusal text', () => {
    const r = buildZeroxUpstream(PATH, q({ sellToken: '<script>alert(1)</script>' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).not.toContain('script')
  })
})

describe('the origin check is a speed bump, and the tests say so', () => {
  const SELF = 'https://spectrum.example'
  it('allows our own origin, and an operator’s declared extra origin', () => {
    expect(originAllowed(SELF, SELF)).toBe(true)
    expect(originAllowed('https://custom.example', SELF, ['https://custom.example'])).toBe(true)
    expect(originAllowed(`${SELF}/`, SELF)).toBe(true) // trailing slash
  })
  it('refuses another site using us as a free gateway from a browser', () => {
    expect(originAllowed('https://totally-unrelated-attacker.example', SELF)).toBe(false)
  })
  it('ALLOWS an absent origin — and that is the documented limit, not an oversight', () => {
    // curl never sends one and forges it freely, so refusing here would break
    // same-origin fetches for no security gain. Quota protection is rate
    // limiting, which this layer does not claim to provide.
    expect(originAllowed(null, SELF)).toBe(true)
  })
})

describe('the prefix strip refuses rather than inventing a path', () => {
  // A bare slice() does not fail when the prefix is absent — it returns a
  // plausible-looking path and the code carries on. Today the platform's route
  // config makes that unreachable; a guard that is only correct because of
  // someone else's config is one edit from being wrong, and it sat in the one
  // file tsc does not check.
  it('strips a real proxy path', () => {
    expect(stripProxyPrefix(`${PROXY_PREFIX}/swap/allowance-holder/quote`)).toBe('/swap/allowance-holder/quote')
  })
  it('refuses a pathname that does not carry the prefix — never a silent reinterpretation', () => {
    for (const p of ['/somewhere/else', '/api/zeroxx/quote', '/API/ZEROX/quote', '', '/', '/api/zerox']) {
      expect(stripProxyPrefix(p), p).toBeNull()
    }
  })
  it('a refused strip cannot reach the URL builder at all', () => {
    // the two guards compose: even if a stripped value leaked through, the
    // path allowlist is exact-match, so this is defence in depth rather than
    // one check carrying everything
    expect(buildZeroxUpstream('/else', q()).ok).toBe(false)
  })
})

describe('duplicate query parameters cannot smuggle a second value', () => {
  it('the FIRST value is validated and the rebuild carries only it', () => {
    // ?chainId=8453&chainId=1 — .get() returns the first, and the upstream URL
    // is rebuilt from validated values, so the second copy is dropped rather
    // than forwarded for 0x to interpret differently than we did.
    const raw = new URLSearchParams(
      `chainId=8453&chainId=1&sellToken=${TOKEN_A}&buyToken=${TOKEN_B}&sellAmount=250000000&sellAmount=999&taker=${TAKER}`,
    )
    const r = buildZeroxUpstream(PATH, raw)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const out = new URL(r.url).searchParams
      expect(out.getAll('chainId')).toEqual(['8453'])
      expect(out.getAll('sellAmount')).toEqual(['250000000'])
    }
  })
  it('and a duplicate whose FIRST value is invalid refuses, rather than falling through to the second', () => {
    const raw = new URLSearchParams(
      `chainId=137&chainId=8453&sellToken=${TOKEN_A}&buyToken=${TOKEN_B}&sellAmount=250000000&taker=${TAKER}`,
    )
    expect(buildZeroxUpstream(PATH, raw).ok).toBe(false)
  })
})

describe('the origin check, and the bypass it does NOT cover', () => {
  const SELF = 'https://spectrum.example'
  it('an <img> tag sends NO Origin — which is why originAllowed alone never stopped a quota drain', () => {
    // The claim was "it stops another WEBSITE using us from a browser". It does
    // not: browsers omit Origin on img/script/iframe/preload/navigation, so an
    // attacker page of <img src="https://our-site/api/zerox/..."> passes.
    expect(originAllowed(null, SELF)).toBe(true) // still true, and still correct for same-origin
    // …and THIS is the check that refuses it, using headers a browser sets and
    // a page cannot forge
    expect(browserFetchAllowed('cross-site', 'image')).toBe(false)
    expect(browserFetchAllowed('cross-site', 'empty')).toBe(false)
    expect(browserFetchAllowed('same-origin', 'image')).toBe(false)
    expect(browserFetchAllowed('same-site', 'script')).toBe(false)
  })
  it('our own same-origin fetch passes', () => {
    expect(browserFetchAllowed('same-origin', 'empty')).toBe(true)
    expect(browserFetchAllowed('none', 'document')).toBe(true)
  })
  it('a non-browser (no Sec-Fetch headers at all) is ALLOWED — stated, not hidden', () => {
    // curl and scripts send neither header. That is quota protection, it needs
    // stateful rate limiting, and it belongs to the platform.
    expect(browserFetchAllowed(null, null)).toBe(true)
  })
  it('a prefix-matching impostor origin is refused — not a startsWith', () => {
    // a mutation to `allowed.some(a => origin.startsWith(a))` would admit this
    expect(originAllowed('https://spectrum.example.evil.com', SELF)).toBe(false)
    expect(originAllowed('https://spectrum.example.evil.com', SELF, ['https://spectrum.example'])).toBe(false)
  })
  it('scheme and case are part of the identity', () => {
    expect(originAllowed('http://spectrum.example', SELF)).toBe(false)
    expect(originAllowed('https://SPECTRUM.example', SELF)).toBe(true) // host case is not
  })
  it('the literal string "null" (a sandboxed iframe) is refused, not treated as absent', () => {
    expect(originAllowed('null', SELF)).toBe(false)
  })
})
