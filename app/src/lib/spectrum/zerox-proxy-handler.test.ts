import { describe, expect, it, vi } from 'vitest'
import { handleZeroxProxy, type ZeroxProxyEnv } from './zerox-proxy-handler'

// THE HANDLER, which review found was covered by NOTHING — no tsc, no lint, no
// test — in the one file that touches the credential. These drive the whole
// lifecycle with an injected fetch, so the envelopes and the exact upstream
// request are assertable without deploying.

const SELF = 'https://spectrum.example'
const TOKEN_A = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TOKEN_B = '0x4200000000000000000000000000000000000006'
const TAKER = '0x0fe4223AD99dF788A6Dcad148eB4086E6389cEB6'
const KEY = 'test-key-never-real'

const okBody = { liquidityAvailable: true, buyAmount: '123' }
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const url = (over: Record<string, string> = {}) => {
  const p = new URLSearchParams({ chainId: '8453', sellToken: TOKEN_A, buyToken: TOKEN_B, sellAmount: '250000000', taker: TAKER, ...over })
  return `${SELF}/api/zerox/swap/allowance-holder/quote?${p}`
}
const req = (u = url(), init: RequestInit = {}) => new Request(u, { method: 'GET', ...init })
const env = (over: Partial<ZeroxProxyEnv> = {}): ZeroxProxyEnv => ({
  apiKey: KEY,
  canonicalOrigin: SELF,
  extraOrigins: [],
  fetchImpl: vi.fn(async () => jsonRes(okBody)) as unknown as typeof fetch,
  ...over,
})

describe('the happy path, and exactly what it sends upstream', () => {
  it('forwards a clean request and passes the JSON body and status back', async () => {
    const e = env()
    const res = await handleZeroxProxy(req(), e)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(okBody)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('sends the key, the version, no redirect-following and a timeout — and NOTHING of the caller', async () => {
    const spy = vi.fn(async () => jsonRes(okBody))
    await handleZeroxProxy(
      req(url(), { headers: { cookie: 'session=secret', authorization: 'Bearer x', 'x-forwarded-for': '1.2.3.4' } }),
      env({ fetchImpl: spy as unknown as typeof fetch }),
    )
    const [upstreamUrl, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(upstreamUrl).toBe(
      `https://api.0x.org/swap/allowance-holder/quote?chainId=8453&sellToken=${TOKEN_A}&buyToken=${TOKEN_B}&sellAmount=250000000&taker=${TAKER}`,
    )
    expect(init.headers).toEqual({ '0x-api-key': KEY, '0x-version': 'v2' })
    expect(init.redirect).toBe('manual') // the credential control
    expect(init.signal).toBeTruthy()
    // the caller's cookie/authorization/forwarded-for must not ride along
    expect(JSON.stringify(init.headers)).not.toContain('session=secret')
    expect(JSON.stringify(init.headers)).not.toContain('Bearer')
  })

  it('NEVER echoes an upstream header — a rate-limit token or a set-cookie must not come back', async () => {
    const leaky = async () =>
      new Response(JSON.stringify(okBody), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', 'x-ratelimit-remaining': '7', 'x-api-key-echo': KEY },
      })
    const res = await handleZeroxProxy(req(), env({ fetchImpl: leaky as unknown as typeof fetch }))
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-ratelimit-remaining')).toBeNull()
    expect(res.headers.get('x-api-key-echo')).toBeNull()
    expect(await res.text()).not.toContain(KEY)
  })
})

describe('the credential never leaves, on any path', () => {
  it('no envelope contains the key', async () => {
    const cases: Array<[string, ZeroxProxyEnv, Request]> = [
      ['405', env(), req(url(), { method: 'POST' } as RequestInit)],
      ['403 origin', env(), req(url(), { headers: { origin: 'https://evil.example' } })],
      ['404 path', env(), req(`${SELF}/api/zerox/nope`)],
      ['400 params', env(), req(url({ chainId: '137' }))],
      ['503 no key', env({ apiKey: null }), req()],
    ]
    for (const [label, e, r] of cases) {
      const res = await handleZeroxProxy(r, e)
      expect(await res.text(), label).not.toContain(KEY)
    }
  })

  it('a REDIRECT is refused, never followed — the one way the key could reach another host', async () => {
    const redirecting = async () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } })
    const res = await handleZeroxProxy(req(), env({ fetchImpl: redirecting as unknown as typeof fetch }))
    expect(res.status).toBe(502)
    expect((await res.json()).name).toBe('UPSTREAM_REDIRECTED')
  })

  it('an upstream that is not JSON is refused rather than relabelled', async () => {
    const html = async () => new Response('<html>challenge</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    const res = await handleZeroxProxy(req(), env({ fetchImpl: html as unknown as typeof fetch }))
    expect(res.status).toBe(502)
    expect((await res.json()).name).toBe('UPSTREAM_UNPARSEABLE')
  })

  it('a thrown fetch becomes an honest 502, not a crash', async () => {
    const boom = async () => {
      throw new Error('network')
    }
    const res = await handleZeroxProxy(req(), env({ fetchImpl: boom as unknown as typeof fetch }))
    expect(res.status).toBe(502)
    expect((await res.json()).name).toBe('UPSTREAM_UNREACHABLE')
  })
})

describe('nothing reaches the upstream until every gate has passed', () => {
  const neverCalled = () => {
    const spy = vi.fn(async () => jsonRes(okBody))
    return { spy, e: env({ fetchImpl: spy as unknown as typeof fetch }) }
  }

  it('a non-GET is refused before anything else', async () => {
    const { spy, e } = neverCalled()
    const res = await handleZeroxProxy(req(url(), { method: 'DELETE' } as RequestInit), e)
    expect(res.status).toBe(405)
    expect(spy).not.toHaveBeenCalled()
  })

  it('a foreign origin costs us no upstream call', async () => {
    const { spy, e } = neverCalled()
    const res = await handleZeroxProxy(req(url(), { headers: { origin: 'https://evil.example' } }), e)
    expect(res.status).toBe(403)
    expect(spy).not.toHaveBeenCalled()
  })

  it('an <img>-shaped cross-site load costs us no upstream call — the quota drain', async () => {
    const { spy, e } = neverCalled()
    const res = await handleZeroxProxy(req(url(), { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' } }), e)
    expect(res.status).toBe(403)
    expect(spy).not.toHaveBeenCalled()
  })

  it('a bad path or bad params cost us no upstream call', async () => {
    for (const r of [req(`${SELF}/api/zerox/swap/permit2/quote`), req(url({ sellToken: 'nope' }))]) {
      const { spy, e } = neverCalled()
      await handleZeroxProxy(r, e)
      expect(spy).not.toHaveBeenCalled()
    }
  })

  it('a missing key says so — an operator fact, not a market fact', async () => {
    const { spy, e } = neverCalled()
    const res = await handleZeroxProxy(req(), { ...e, apiKey: null })
    expect(res.status).toBe(503)
    expect((await res.json()).name).toBe('NO_UPSTREAM_KEY')
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('the origin comparison uses the CANONICAL origin, not the request’s own host', () => {
  it('a preview host claiming to be itself is refused when a canonical origin is configured', async () => {
    // env vars are shared across Netlify contexts, so without this every PR
    // preview is a working public proxy on the production key
    const res = await handleZeroxProxy(
      new Request('https://deploy-preview-42--site.netlify.app/api/zerox/swap/allowance-holder/quote?' + new URL(url()).searchParams, {
        headers: { origin: 'https://deploy-preview-42--site.netlify.app' },
      }),
      env(),
    )
    expect(res.status).toBe(403)
  })
  it('…and an operator’s declared extra origin is allowed', async () => {
    const res = await handleZeroxProxy(req(url(), { headers: { origin: 'https://custom.example' } }), env({ extraOrigins: ['https://custom.example'] }))
    expect(res.status).toBe(200)
  })
})
