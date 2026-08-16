import { isAddress } from 'viem'
import type { Address } from 'viem'
import { verifyCreatorMetadata, type SignedCreatorMetadata } from './creator-metadata'

// ─────────────────────────────────────────────────────────────────────────────
// THE METADATA WRITE-RELAY's decision core (the owner greenlight 2026-08-13: "yes
// can we do this?"). The client half has existed since Phase A with zero
// servers to talk to — persist-metadata.ts POSTs a creator's DEPLOYER-SIGNED
// blob to `VITE_METADATA_WRITE_URL/<chainId>/<basket>.json` and use-publish
// re-reads the convention URL to confirm it became servable. THIS module is
// the server's brain, in `src` where tsc/eslint/vitest see it; the Netlify
// edge function is a deliberately thin adapter (the zerox.ts law — an adapter
// is checked by nothing, so it must contain nothing checkable).
//
// TRUST POSTURE (operator.ts's own words): the relay is NEVER authoritative
// and holds NO key. It re-verifies the EIP-712 signature against the basket's
// ON-CHAIN deployer and refuses anything that fails — a hostile or buggy
// relay can only DENY, never forge, because every reader re-verifies at
// render. Storing garbage would still cost readers a fetch, so garbage is
// refused here too.
//
// LAWS:
//  · the URL path IS the claim — `<chainId>/<basket>.json` must match the
//    blob's own signed `metadata.basket` (the typed data binds the basket, so
//    a blob can never be re-hung on a sibling basket even by its own signer);
//  · UNREADABLE IS NOT VERIFIED — a deployer read that fails refuses (503,
//    try again), it never "defaults open" and stores an unverified blob;
//  · ROLLBACK IS REFUSED — blobs are public, so anyone can replay an OLD
//    signed blob; a POST whose `issuedAt` is older than the stored one is
//    answered 409 and the newer record stands (re-signing bumps issuedAt);
//  · size is bounded BEFORE parsing (MAX_BLOB_BYTES, the module's own cap);
//  · cheap checks run before expensive ones — shape and path-match refuse
//    before the on-chain deployer read, so a garbage flood costs no RPC.
// ─────────────────────────────────────────────────────────────────────────────

/** The relay enforces creator-metadata's OWN blob cap on the wire — ONE
 *  constant (audit 2026-08-13: a restated bound drifts). Re-exported name so
 *  callers reading the relay don't reach across modules. */
export { MAX_BLOB_BYTES as RELAY_MAX_BLOB_BYTES } from './creator-metadata'
import { MAX_BLOB_BYTES as RELAY_MAX_BLOB_BYTES } from './creator-metadata'

export interface RelayStore {
  /** The stored JSON at a convention path, or null. */
  get(path: string): Promise<string | null>
  set(path: string, json: string): Promise<void>
}

export interface RelayIo {
  /** `factory.tokens(basket) → deployer` on the chain — null = could not read
   *  (network weather, unknown basket). Null REFUSES; it never defaults open. */
  deployerOf(chainId: number, basket: Address): Promise<Address | null>
  /** The factory address seated for the chain (the EIP-712 domain's
   *  verifyingContract), or null when the chain has none. */
  factoryFor(chainId: number): Address | null
  /** The chains this deployment serves. */
  chainIds: readonly number[]
  store: RelayStore
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
// Public, signature-anchored data: any origin may READ (other tools, other
// fronts); writes are gated by the signature, not the origin.
const CORS = { 'access-control-allow-origin': '*' }

function refusal(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { ...JSON_HEADERS, ...CORS } })
}

/** Parse `…/<chainId>/<0xbasket>.json` from the tail of a request path. */
export function parseRelayPath(pathname: string): { chainId: number; basket: Address } | null {
  const m = /\/(\d{1,10})\/(0x[0-9a-fA-F]{40})\.json$/.exec(pathname)
  if (!m) return null
  const chainId = Number(m[1])
  if (!Number.isInteger(chainId) || chainId <= 0) return null
  if (!isAddress(m[2], { strict: false })) return null
  return { chainId, basket: m[2].toLowerCase() as Address }
}

/** Shape-guard a parsed body into a SignedCreatorMetadata, or null. Bounds and
 *  types only — the SIGNATURE decides truth, verifyCreatorMetadata's job. */
function shapeBlob(v: unknown): SignedCreatorMetadata | null {
  if (!v || typeof v !== 'object') return null
  const b = v as Record<string, unknown>
  if (typeof b.signer !== 'string' || !isAddress(b.signer, { strict: false })) return null
  if (typeof b.signature !== 'string' || !/^0x[0-9a-fA-F]{2,4096}$/.test(b.signature)) return null
  const m = b.metadata as Record<string, unknown> | undefined
  if (!m || typeof m !== 'object') return null
  if (typeof m.basket !== 'string' || !isAddress(m.basket, { strict: false })) return null
  if (typeof m.issuedAt !== 'number' || !Number.isInteger(m.issuedAt) || m.issuedAt < 0) return null
  return v as SignedCreatorMetadata
}

/** The stored record's issuedAt, or null when absent/unreadable. */
async function storedIssuedAt(store: RelayStore, path: string): Promise<number | null> {
  try {
    const raw = await store.get(path)
    if (!raw) return null
    const v = JSON.parse(raw) as { metadata?: { issuedAt?: unknown } }
    const at = v?.metadata?.issuedAt
    return typeof at === 'number' && Number.isFinite(at) ? at : null
  } catch {
    return null
  }
}

export async function handleMetadataRelay(req: Request, io: RelayIo): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      },
    })
  }

  const parsed = parseRelayPath(new URL(req.url).pathname)
  if (!parsed) return refusal(404, 'Expected /<chainId>/<basket>.json.')
  const { chainId, basket } = parsed
  const path = `${chainId}/${basket}.json`

  if (req.method === 'GET') {
    const stored = await io.store.get(path)
    if (stored == null) return refusal(404, 'No published metadata for this basket.')
    return new Response(stored, {
      status: 200,
      // modest cache: a re-publish should become visible within minutes, and
      // every reader re-verifies the signature anyway
      headers: { ...JSON_HEADERS, ...CORS, 'cache-control': 'public, max-age=300' },
    })
  }

  if (req.method !== 'POST') return refusal(405, 'GET or POST only.')

  if (!io.chainIds.includes(chainId)) return refusal(400, `Chain ${chainId} is not served here.`)

  // FAST-REJECT AN ABSURD DECLARED LENGTH BEFORE BUFFERING (audit 2026-08-13):
  // `req.text()` buffers the WHOLE body into memory first, so a multi-GB drip
  // would balloon before the measured check below could fire. A DECLARED
  // Content-Length past a generous multiple of the cap is refused without
  // reading a byte. The declared length is NOT trusted as authoritative (a
  // liar under-declares) — the measured check after the read stays the real
  // bound; this only stops the honest-huge and the obvious-flood cheaply.
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > RELAY_MAX_BLOB_BYTES * 4)
    return refusal(413, 'Declared body length exceeds the cap.')

  // Bound the wire before touching JSON.parse — a content-length lie is caught
  // by reading the text and measuring it ourselves (bytes, not UTF-16 units:
  // a multi-byte body must not sneak to ~2× the cap).
  const text = await req.text()
  if (new TextEncoder().encode(text).length > RELAY_MAX_BLOB_BYTES) return refusal(413, 'Blob exceeds the 32 KiB cap.')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return refusal(400, 'Body is not JSON.')
  }
  const blob = shapeBlob(body)
  if (!blob) return refusal(400, 'Body is not a signed metadata blob.')

  // The path is the claim: a blob signed for basket A can never be hung at
  // basket B's path, even by its own signer. Checked BEFORE the deployer read.
  if (blob.metadata.basket.toLowerCase() !== basket)
    return refusal(422, 'The blob is signed for a different basket than this path.')

  const factory = io.factoryFor(chainId)
  if (!factory) return refusal(503, `No factory is seated for chain ${chainId}; nothing can verify.`)

  const deployer = await io.deployerOf(chainId, basket)
  if (deployer == null || !isAddress(deployer, { strict: false }))
    return refusal(503, 'Could not read the basket deployer on-chain just now — try again. Unverified is never stored.')

  const ok = await verifyCreatorMetadata(blob, { chainId, factory, expectedDeployer: deployer })
  if (!ok) return refusal(401, 'Signature did not verify as the basket deployer. Nothing stored.')

  // Replay-rollback guard: blobs are public, so an OLD signed blob can be
  // re-posted by anyone. Never let it overwrite a newer record.
  const existingAt = await storedIssuedAt(io.store, path)
  if (existingAt != null && blob.metadata.issuedAt < existingAt)
    return refusal(409, 'A newer signed record already exists for this basket.')

  await io.store.set(path, JSON.stringify(blob))
  return new Response(null, { status: 204, headers: CORS })
}
