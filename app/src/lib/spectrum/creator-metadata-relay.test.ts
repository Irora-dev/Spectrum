import { describe, expect, it, beforeEach } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'
import { handleMetadataRelay, parseRelayPath, type RelayIo, type RelayStore } from './creator-metadata-relay'
import { buildCreatorMetadata, signCreatorMetadata, type SignedCreatorMetadata } from './creator-metadata'

// The write-relay's decision core (built 2026-08-13; the audit flagged it had
// NO test — the whole point of splitting it into `src` was to make it testable,
// like the zerox handler). Real EIP-712 signatures where a pass is required —
// a mocked signer would pin nothing about the "verified as the deployer" gate.

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DEPLOYER = privateKeyToAccount(KEY)
const FACTORY = '0x00000000000000000000000000000000000000f1' as Address
const BASKET = '0x00000000000000000000000000000000000ba5c0' as Address
const CHAIN = 8453

class MemStore implements RelayStore {
  m = new Map<string, string>()
  async get(path: string) {
    return this.m.get(path) ?? null
  }
  async set(path: string, json: string) {
    this.m.set(path, json)
  }
}

let store: MemStore
const io = (over: Partial<RelayIo> = {}): RelayIo => ({
  deployerOf: async () => DEPLOYER.address,
  factoryFor: () => FACTORY,
  chainIds: [CHAIN],
  store,
  ...over,
})
beforeEach(() => {
  store = new MemStore()
})

/** A genuinely deployer-signed blob for BASKET on CHAIN. */
async function signedBlob(over: { issuedAt?: number; basket?: Address } = {}): Promise<SignedCreatorMetadata> {
  const meta = buildCreatorMetadata({ handle: 'creator', name: 'Creator' }, over.basket ?? BASKET, over.issuedAt ?? 1_000)
  return signCreatorMetadata({
    meta,
    signer: DEPLOYER.address,
    chainId: CHAIN,
    factory: FACTORY,
    signTypedDataAsync: (a) => DEPLOYER.signTypedData(a as Parameters<typeof DEPLOYER.signTypedData>[0]),
  })
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://relay.example/${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers })

describe('parseRelayPath — the path is the claim', () => {
  it('accepts <chainId>/<0xbasket>.json and lowercases the basket', () => {
    expect(parseRelayPath('/x/8453/0xABCDabcd00000000000000000000000000000000.json')).toEqual({
      chainId: 8453,
      basket: '0xabcdabcd00000000000000000000000000000000',
    })
  })
  it('refuses traversal, non-hex, bad chain', () => {
    expect(parseRelayPath('/8453/../secrets.json')).toBeNull()
    expect(parseRelayPath('/8453/0xnothex.json')).toBeNull()
    expect(parseRelayPath('/0/0x0000000000000000000000000000000000000000.json')).toBeNull()
  })
})

describe('handleMetadataRelay — the security gates', () => {
  it('GET on a stored path returns it; GET on an empty path 404s', async () => {
    const blob = await signedBlob()
    await store.set(`${CHAIN}/${BASKET.toLowerCase()}.json`, JSON.stringify(blob))
    const ok = await handleMetadataRelay(new Request(`https://relay.example/${CHAIN}/${BASKET.toLowerCase()}.json`), io())
    expect(ok.status).toBe(200)
    const miss = await handleMetadataRelay(new Request(`https://relay.example/${CHAIN}/0x0000000000000000000000000000000000000001.json`), io())
    expect(miss.status).toBe(404)
  })

  it('a genuinely deployer-signed blob at its own path STORES (204)', async () => {
    const blob = await signedBlob()
    const res = await handleMetadataRelay(post(`${CHAIN}/${BASKET.toLowerCase()}.json`, blob), io())
    expect(res.status).toBe(204)
    expect(store.m.get(`${CHAIN}/${BASKET.toLowerCase()}.json`)).toBeTruthy()
  })

  it('THE PATH IS THE CLAIM: a blob signed for basket A cannot be hung at basket B (422), even by its own signer', async () => {
    const blob = await signedBlob({ basket: BASKET })
    const otherPath = `${CHAIN}/0x00000000000000000000000000000000000ba5c1.json`
    const res = await handleMetadataRelay(post(otherPath, blob), io())
    expect(res.status).toBe(422)
    expect(store.m.size).toBe(0)
  })

  it('UNVERIFIED IS NEVER STORED: an unreadable deployer refuses 503, never defaults open', async () => {
    const blob = await signedBlob()
    const res = await handleMetadataRelay(post(`${CHAIN}/${BASKET.toLowerCase()}.json`, blob), io({ deployerOf: async () => null }))
    expect(res.status).toBe(503)
    expect(store.m.size).toBe(0)
  })

  it('a valid signature from a NON-deployer refuses 401', async () => {
    const blob = await signedBlob()
    // the real deployer is someone else entirely
    const res = await handleMetadataRelay(post(`${CHAIN}/${BASKET.toLowerCase()}.json`, blob), io({ deployerOf: async () => '0x000000000000000000000000000000000000dEaD' as Address }))
    expect(res.status).toBe(401)
    expect(store.m.size).toBe(0)
  })

  it('ROLLBACK REFUSED: an older issuedAt cannot overwrite a newer stored record (409)', async () => {
    const newer = await signedBlob({ issuedAt: 2_000 })
    expect((await handleMetadataRelay(post(`${CHAIN}/${BASKET.toLowerCase()}.json`, newer), io())).status).toBe(204)
    const older = await signedBlob({ issuedAt: 1_000 })
    const res = await handleMetadataRelay(post(`${CHAIN}/${BASKET.toLowerCase()}.json`, older), io())
    expect(res.status).toBe(409)
    // the newer record still stands
    expect(JSON.parse(store.m.get(`${CHAIN}/${BASKET.toLowerCase()}.json`)!).metadata.issuedAt).toBe(2_000)
  })

  it('a chain not served refuses 400 before any read', async () => {
    const blob = await signedBlob()
    const res = await handleMetadataRelay(post(`1/${BASKET.toLowerCase()}.json`, blob), io())
    expect(res.status).toBe(400)
  })

  it('a declared Content-Length past the cap fast-rejects 413 without buffering', async () => {
    const res = await handleMetadataRelay(
      post(`${CHAIN}/${BASKET.toLowerCase()}.json`, '{}', { 'content-length': String(32_768 * 5) }),
      io(),
    )
    expect(res.status).toBe(413)
  })

  it('an oversized measured body refuses 413; non-JSON 400; a non-blob shape 400', async () => {
    const huge = 'x'.repeat(32_768 + 10)
    expect((await handleMetadataRelay(post(`${CHAIN}/${BASKET.toLowerCase()}.json`, JSON.stringify({ x: huge })), io())).status).toBe(413)
    expect((await handleMetadataRelay(post(`${CHAIN}/${BASKET.toLowerCase()}.json`, 'not json'), io())).status).toBe(400)
    expect((await handleMetadataRelay(post(`${CHAIN}/${BASKET.toLowerCase()}.json`, { not: 'a blob' }), io())).status).toBe(400)
  })

  it('GET/POST only — other methods 405, OPTIONS preflights 204', async () => {
    const del = await handleMetadataRelay(new Request(`https://relay.example/${CHAIN}/${BASKET.toLowerCase()}.json`, { method: 'DELETE' }), io())
    expect(del.status).toBe(405)
    const opt = await handleMetadataRelay(new Request(`https://relay.example/${CHAIN}/${BASKET.toLowerCase()}.json`, { method: 'OPTIONS' }), io())
    expect(opt.status).toBe(204)
  })
})
