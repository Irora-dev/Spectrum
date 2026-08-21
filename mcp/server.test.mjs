// The MCP server's protocol + refusal pins — OFFLINE by design: every case
// here either speaks pure protocol or refuses before any chain read, so the
// suite runs in CI with no RPC and no network. Run: node --test mcp/server.test.mjs
// (build first: node mcp/build.mjs — the test exercises the SHIPPED artifact,
// not the source, so a build-step regression fails here too).
//
// Two ways in, both against dist/server.mjs:
//   · WIRE tests spawn the real server over real stdio (drive/connect below);
//   · UNIT pins import the bundle in-process under MCP_NO_WIRE=1 (the server's
//     test seam — no stdin listener, no banner) to reach the exported pure
//     guards, the shape builders, and the tool registry behavior no wire test
//     can observe (registry sizes, the lint dispatch, cap parsing).
// Every RPC env var is pointed at a closed local port so anything that tries
// the chain refuses fast and deterministically — still no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// closed port = instant refusal; '' clears any ambient key/allowlist so the
// suite is deterministic on any machine
const OFFLINE_ENV = {
  VITE_BASE_RPC_URL: 'http://127.0.0.1:1',
  VITE_MAINNET_RPC_URL: 'http://127.0.0.1:1',
  VITE_ROBINHOOD_RPC_URL: 'http://127.0.0.1:1',
  VITE_ALCHEMY_API_KEY: '',
  VITE_EXTRA_CHAIN_IDS: '',
  VITE_SNAPSHOT_URL: '',
  MCP_OPERATOR_KEY: '',
  MCP_EXECUTE_CHAINS: '',
  MCP_EXECUTE_MAX_TX_USD: '',
  MCP_EXECUTE_MAX_SESSION_USD: '',
}
Object.assign(process.env, OFFLINE_ENV, { MCP_NO_WIRE: '1' })
// the in-process import (unit pins): MCP_NO_WIRE=1 above means no stdin
// listener starts and no banner prints — just the exports
const MOD = await import('./dist/server.mjs')

const A = '0x40B1e5818b449Db3A7bb0FE482B5784F77fCD2c0'
const B = '0x563791d3338b88c4347dcd26a1740dcc9170c088'
// the canonical throwaway key (never holds anything); its well-known address
const KEY1 = '0x0000000000000000000000000000000000000000000000000000000000000001'
const KEY1_ADDR = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'

/** Drive the real server over real stdio: send frames, collect replies until
 *  every awaited id answers (or 10s passes — a hang is a failure with words). */
function drive(frames, awaitIds, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(HERE, 'dist/server.mjs')], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, MCP_NO_WIRE: '', ...env },
    })
    const got = new Map()
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`server did not answer ids [${awaitIds.filter((i) => !got.has(i)).join(', ')}] within 10s`))
    }, 10_000)
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += String(d)
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        if (msg.id != null) got.set(msg.id, msg)
        if (awaitIds.every((i) => got.has(i))) {
          clearTimeout(timer)
          child.kill()
          resolve(got)
        }
      }
    })
    child.on('error', reject)
    for (const f of frames) child.stdin.write(JSON.stringify(f) + '\n')
  })
}

/** A stateful wire client for tests that must SEQUENCE calls (compose, then
 *  execute what came back) or read stderr. Same real server, same real stdio. */
function connect(env) {
  const child = spawn('node', [join(HERE, 'dist/server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MCP_NO_WIRE: '', ...env },
  })
  let stderrText = ''
  let stdoutRaw = ''
  child.stderr.on('data', (d) => { stderrText += String(d) })
  const waiters = new Map()
  let buf = ''
  child.stdout.on('data', (d) => {
    stdoutRaw += String(d)
    buf += String(d)
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id != null && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg)
        waiters.delete(msg.id)
      }
    }
  })
  return {
    stderr: () => stderrText,
    stdout: () => stdoutRaw,
    notify(frame) { child.stdin.write(JSON.stringify(frame) + '\n') },
    call(frame, ms = 10_000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no answer for id ${frame.id} within ${ms}ms`)), ms)
        waiters.set(frame.id, (m) => { clearTimeout(t); resolve(m) })
        child.stdin.write(JSON.stringify(frame) + '\n')
      })
    },
    async waitStderr(substr, ms = 8_000) {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        if (stderrText.includes(substr)) return true
        await new Promise((r) => setTimeout(r, 50))
      }
      return false
    },
    kill() { child.kill() },
  }
}

const INIT = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
]
const callFrame = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

/** keys + types, recursively — the golden-shape fingerprint. Arrays report the
 *  shape of their first element; null stays null (a pinned nullable). */
function typeShape(v) {
  if (v === null) return null
  if (Array.isArray(v)) return [v.length === 0 ? 'empty' : typeShape(v[0])]
  if (typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = typeShape(v[k])
    return out
  }
  return typeof v
}
const TX_SHAPE = { chainId: 'number', data: 'string', to: 'string', value: 'string' }

test('initialize + tools/list — the protocol handshake and the tool registry', async () => {
  const got = await drive([...INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }], [1, 2])
  assert.equal(got.get(1).result.serverInfo.name, 'spectrum-mcp')
  const names = got.get(2).result.tools.map((t) => t.name)
  assert.deepEqual(names, [
    'spectrum_health', 'spectrum_list_baskets', 'spectrum_read_basket', 'spectrum_positions', 'spectrum_compose_redeem_in_kind',
    'spectrum_compose_buy', 'spectrum_quote_buy', 'spectrum_quote_sell', 'spectrum_compose_sell', 'spectrum_compose_migrate',
    'spectrum_compose_create_basket', 'spectrum_compose_revoke', 'spectrum_execute', 'spectrum_search', 'spectrum_history',
  ])
  for (const t of got.get(2).result.tools) {
    assert.ok(t.description.length > 20, `${t.name} has a real description`)
    assert.equal(t.inputSchema.type, 'object')
  }
})

test('refusals are sentences, and they fire BEFORE any chain read', async () => {
  const call = (id, args) => callFrame(id, 'spectrum_compose_redeem_in_kind', args)
  const got = await drive(
    [
      ...INIT,
      call(2, { chainId: 999, basket: B, sharesRaw: '1', holder: A }), // unknown chain
      call(3, { chainId: 8453, basket: 'not-an-address', sharesRaw: '1', holder: A }), // bad address
      call(4, { chainId: 8453, basket: B, sharesRaw: '1.5', holder: A }), // decimal shares
      call(5, { chainId: 8453, basket: B, sharesRaw: '0', holder: A }), // zero shares
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
    ],
    [2, 3, 4, 5, 6],
  )
  const text = (id) => got.get(id).result.content[0].text
  assert.ok(got.get(2).result.isError && /not configured/.test(text(2)), 'unknown chain refuses in words')
  // R2's wire law: a refusal NEVER carries structuredContent — an agent must
  // never find a signable payload on an error result
  for (const id of [2, 3, 4, 5]) assert.equal(got.get(id).result.structuredContent, undefined, `refusal ${id} carries no structuredContent`)
  assert.ok(got.get(3).result.isError && /not a valid address/.test(text(3)), 'bad address refuses in words')
  assert.ok(got.get(4).result.isError && /raw integer/.test(text(4)), 'decimal shares refuse in words')
  assert.ok(got.get(5).result.isError && /positive/.test(text(5)), 'zero shares refuse in words')
  assert.ok(got.get(6).error && /unknown tool/.test(got.get(6).error.message), 'unknown tool is a protocol error')
})

test('compose refusals fire before any chain read — slippage bounds, decimals, execute-without-key, list filters', async () => {
  const got = await drive(
    [
      ...INIT,
      callFrame(2, 'spectrum_compose_buy', { chainId: 8453, basket: B, amountUsd: 50, holder: A, slippageBps: 99999 }), // slippage out of bounds
      callFrame(3, 'spectrum_compose_sell', { chainId: 8453, basket: B, sharesRaw: '1.5', holder: A }), // decimal shares
      callFrame(4, 'spectrum_compose_create_basket', { chainId: 8453, name: 'X', symbol: 'X', assets: ['a'], weightsPct: [100], deployer: A, basketFeeBps: 100, creatorShareBps: 0 }), // 1 leg
      callFrame(5, 'spectrum_execute', { chainId: 8453, to: B, data: '0x' }), // no operator key
      // per-weight law (F10): the SUM check alone would pass -10/110 — each
      // weight must be its own integer in 1..99, refused before any chain read
      callFrame(6, 'spectrum_compose_create_basket', { chainId: 8453, name: 'X', symbol: 'X', assets: ['a', 'b'], weightsPct: [-10, 110], deployer: A, basketFeeBps: 100, creatorShareBps: 0 }),
      callFrame(7, 'spectrum_compose_create_basket', { chainId: 8453, name: 'X', symbol: 'X', assets: ['a', 'b'], weightsPct: [50.5, 49.5], deployer: A, basketFeeBps: 100, creatorShareBps: 0 }),
      // shares one-of law (R3): human `shares` OR raw `sharesRaw`, never both, never neither
      callFrame(8, 'spectrum_compose_sell', { chainId: 8453, basket: B, sharesRaw: '1000', shares: 1.5, holder: A }),
      callFrame(9, 'spectrum_compose_sell', { chainId: 8453, basket: B, holder: A }),
      callFrame(10, 'spectrum_compose_migrate', { chainId: 8453, fromBasket: B, shares: -2, holder: A }),
      // list_baskets filter validation refuses before the chain (R4)
      callFrame(11, 'spectrum_list_baskets', { chainId: 8453, sort: 'volume' }),
      callFrame(12, 'spectrum_list_baskets', { chainId: 8453, limit: 0 }),
      callFrame(13, 'spectrum_list_baskets', { chainId: 8453, limit: 2.5 }),
    ],
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  )
  const text = (id) => got.get(id).result.content[0].text
  assert.ok(got.get(2).result.isError && /between 10 and 2000/.test(text(2)), 'slippage bounds refuse in words')
  assert.ok(got.get(3).result.isError && /raw integer/.test(text(3)), 'decimal shares refuse in words')
  assert.ok(got.get(4).result.isError && /2.12 legs|2–12 legs/.test(text(4)), 'a 1-leg basket refuses in words')
  assert.ok(!got.get(5).result.isError && /compose-only/.test(text(5)), 'execute without a key is compose-only, not an error')
  assert.ok(got.get(6).result.isError && /integer between 1 and 99/.test(text(6)), 'a negative weight refuses even when the sum is 100')
  assert.ok(got.get(7).result.isError && /integer between 1 and 99/.test(text(7)), 'fractional weights refuse in words')
  assert.ok(got.get(8).result.isError && /exactly ONE of sharesRaw \| shares/.test(text(8)), 'both share forms refuse in words')
  assert.ok(got.get(9).result.isError && /shares are required/.test(text(9)), 'neither share form refuses in words')
  assert.ok(got.get(10).result.isError && /positive number in human units/.test(text(10)), 'negative human shares refuse in words')
  assert.ok(got.get(11).result.isError && /sort must be "aum" or "change24h"/.test(text(11)), 'an unknown sort refuses in words')
  assert.ok(got.get(12).result.isError && /positive integer/.test(text(12)), 'a zero limit refuses in words')
  assert.ok(got.get(13).result.isError && /positive integer/.test(text(13)), 'a fractional limit refuses in words')
})

test('execute is bounded to composed payloads even WITH an operator key — the key cannot be pointed at arbitrary calldata', async () => {
  // the throwaway well-formed key; the guard refuses before any account or
  // network is touched, so it is never used to sign anything
  const got = await drive(
    [...INIT, callFrame(2, 'spectrum_execute', { chainId: 8453, to: B, data: '0xdeadbeef', value: '0' })],
    [2],
    { MCP_OPERATOR_KEY: KEY1 },
  )
  const r = got.get(2).result
  assert.ok(r.isError, 'an uncomposed payload is refused even with a key present')
  assert.ok(/not composed by this server/.test(r.content[0].text), 'the refusal names the registry guard')
})

test('compose_revoke — offline compose, decode-shaped calldata, default spender, golden structured shape', async () => {
  const c = connect({})
  try {
    await c.call(INIT[0])
    c.notify(INIT[1])
    // explicit spender
    const r2 = await c.call(callFrame(2, 'spectrum_compose_revoke', { chainId: 8453, token: B, spender: A }))
    assert.ok(!r2.result.isError, `revoke composes offline (got: ${r2.result.content[0].text.slice(0, 120)})`)
    const p = r2.result.structuredContent
    assert.deepEqual(typeShape(p), TX_SHAPE, 'revoke structuredContent is the pinned payload shape')
    assert.equal(p.to.toLowerCase(), B.toLowerCase(), 'the call goes to the token')
    assert.ok(p.data.startsWith('0x095ea7b3'), 'approve selector')
    assert.equal(p.data.length, 2 + 8 + 64 + 64, 'approve(spender, amount) calldata length')
    assert.ok(p.data.endsWith('0'.repeat(64)), 'the amount is ZERO — a revoke, not a grant')
    assert.ok(p.data.toLowerCase().includes(A.slice(2).toLowerCase()), 'the spender rides in the bytes')
    assert.equal(p.value, '0')
    assert.ok(/REVIEW/.test(r2.result.content[0].text) && /ZERO/.test(r2.result.content[0].text), 'review sentences present')
    // default spender = the chain's swap router
    const r3 = await c.call(callFrame(3, 'spectrum_compose_revoke', { chainId: 8453, token: B }))
    assert.ok(!r3.result.isError, 'default-spender revoke composes')
    assert.ok(/swap router/.test(r3.result.content[0].text), 'the review says the default spender is the swap router')
    // bad spender refuses in words
    const r4 = await c.call(callFrame(4, 'spectrum_compose_revoke', { chainId: 8453, token: B, spender: 'nope' }))
    assert.ok(r4.result.isError && /not a valid address/.test(r4.result.content[0].text))
  } finally {
    c.kill()
  }
})

test('execute chain allowlist — a composed payload on an off-list chain refuses in words (and the registry guard passed first)', async () => {
  const c = connect({ MCP_OPERATOR_KEY: KEY1, MCP_EXECUTE_CHAINS: '1' })
  try {
    await c.call(INIT[0])
    c.notify(INIT[1])
    const r2 = await c.call(callFrame(2, 'spectrum_compose_revoke', { chainId: 8453, token: B, spender: A }))
    assert.ok(!r2.result.isError, 'the compose itself works on any configured chain')
    const p = r2.result.structuredContent
    const r3 = await c.call(callFrame(3, 'spectrum_execute', { chainId: p.chainId, to: p.to, data: p.data, value: p.value }))
    assert.ok(r3.result.isError, 'an off-list chain refuses')
    const t = r3.result.content[0].text
    assert.ok(/allowlist/.test(t) && /MCP_EXECUTE_CHAINS/.test(t) && /8453/.test(t), 'the refusal names the chain and the env knob')
    assert.ok(!/not composed by this server/.test(t), 'the registry guard passed — this is the allowlist speaking, not guard 1')
  } finally {
    c.kill()
  }
})

test('the ARMED banner — one stderr line naming address, chains, caps; never on stdout; never the key', async () => {
  const c = connect({ MCP_OPERATOR_KEY: KEY1, MCP_EXECUTE_CHAINS: '8453' })
  try {
    await c.call(INIT[0])
    assert.ok(await c.waitStderr('EXECUTE ARMED'), 'the banner prints when a key is present')
    const line = c.stderr().split('\n').find((l) => l.includes('EXECUTE ARMED'))
    assert.ok(line.includes(`EXECUTE ARMED for ${KEY1_ADDR}`), 'the banner names the derived address')
    assert.ok(/chains 8453/.test(line), 'the banner names the allowlisted chains')
    assert.ok(/caps 500\/1000 USD/.test(line), 'the banner names the default caps')
    assert.ok(!c.stderr().includes(KEY1) && !c.stderr().includes(KEY1.slice(2)), 'no part of the key is ever printed')
    assert.ok(!c.stdout().includes('EXECUTE ARMED'), 'stdout is the JSON-RPC wire — the banner never touches it')
  } finally {
    c.kill()
  }
  // and WITHOUT a key: no banner
  const quiet = connect({})
  try {
    await quiet.call(INIT[0])
    assert.equal(await quiet.waitStderr('EXECUTE ARMED', 700), false, 'no key, no banner')
  } finally {
    quiet.kill()
  }
})

test('quote_buy over the wire — a refusal is a sentence with NO structuredContent (nothing signable ever rides an error)', async () => {
  const got = await drive([...INIT, callFrame(2, 'spectrum_quote_buy', { chainId: 8453, basket: B, amountUsd: 5, holder: A })], [2])
  const r = got.get(2).result
  assert.ok(r.isError, 'no reachable RPC, so the quote refuses')
  assert.equal(r.structuredContent, undefined, 'the refusal carries no structuredContent')
  assert.ok(r.content[0].text.length > 10, 'the refusal says what happened (here: the RPC transport failure, verbatim)')
})

test('health over the wire — chain rows plus provenance (kit version, build stamp, registry digest), golden structured shape', async () => {
  const c = connect({})
  try {
    await c.call(INIT[0])
    c.notify(INIT[1])
    const r = await c.call(callFrame(2, 'spectrum_health', {}), 20_000)
    assert.ok(!r.result.isError, 'health answers even with every RPC dead')
    const s = r.result.structuredContent
    assert.ok(Array.isArray(s.chains) && s.chains.length >= 1, 'at least one chain row')
    for (const row of s.chains) {
      assert.deepEqual(typeShape(row), { chainId: 'number', name: 'string', note: 'string', ok: 'boolean' }, 'chain row shape pinned')
      assert.equal(row.ok, false, 'every RPC here is a closed port')
      assert.ok(/UNREACHABLE/.test(row.note), 'the row says so in words')
    }
    const version = JSON.parse(readFileSync(join(HERE, '../version.json'), 'utf8')).version
    assert.equal(s.kitVersion, version, 'kitVersion is the repo root version.json, stamped at build')
    assert.ok(Number.isFinite(Date.parse(s.buildStamp)), 'buildStamp is a real ISO time')
    assert.match(s.registryDigest, /^[0-9a-f]{64}$/, 'registryDigest is a sha256 hex')
    const text = r.result.content[0].text
    assert.ok(text.includes('kit version:') && text.includes('registry digest'), 'the text carries the provenance too')
  } finally {
    c.kill()
  }
})

test('noise on the wire never crashes the server', async () => {
  const child = spawn('node', [join(HERE, 'dist/server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, MCP_NO_WIRE: '' } })
  child.stdin.write('this is not json\n\n{broken\n')
  child.stdin.write(JSON.stringify(INIT[0]) + '\n')
  const answered = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000)
    child.stdout.once('data', () => {
      clearTimeout(t)
      resolve(true)
    })
  })
  child.kill()
  assert.ok(answered, 'the server still answers after garbage frames')
})

// ── UNIT PINS (in-process against the built artifact, MCP_NO_WIRE=1) ─────────

test('golden structured shapes — every structuredContent builder is pinned (keys + types); Bankr parses these', () => {
  const tx = { to: A, data: '0xdead', value: '0', chainId: 8453 }
  assert.deepEqual(typeShape(MOD.shapeTx(tx)), TX_SHAPE)
  // extra properties never leak into the wire shape
  assert.deepEqual(typeShape(MOD.shapeTx({ ...tx, secret: 'x' })), TX_SHAPE)

  assert.deepEqual(typeShape(MOD.shapeSwapPair({ approval: tx, swap: tx })), { approval: TX_SHAPE, swap: TX_SHAPE })
  assert.deepEqual(typeShape(MOD.shapeSwapPair({ approval: null, swap: tx })), { approval: null, swap: TX_SHAPE }, 'a covered allowance pins approval as null, not absent')

  assert.deepEqual(typeShape(MOD.shapeCreate({ predicted: A, calls: [tx] })), { calls: [TX_SHAPE], predicted: 'string' })

  const quote = MOD.shapeQuote({
    quoteOnly: true, chainId: 8453, basket: B, amountUsd: 250,
    expectedSharesRaw: '100', floorSharesRaw: '99', expectedShares: '1.0', floorShares: '0.99',
    slippageBps: 100, feeBps: 100, navPerToken: 1.23, navSource: 'onchain', review: [],
  })
  assert.deepEqual(typeShape(quote), {
    amountUsd: 'number', basket: 'string', chainId: 'number',
    expectedShares: 'string', expectedSharesRaw: 'string', feeBps: 'number',
    floorShares: 'string', floorSharesRaw: 'string', navPerToken: 'number', navSource: 'string', slippageBps: 'number',
  })
  for (const k of ['to', 'data', 'value', 'approval', 'swap', 'calls'])
    assert.ok(!(k in quote), `a quote carries no '${k}' — it must never look signable`)

  const health = MOD.shapeHealth([{ chainId: 8453, name: 'Base', ok: true, note: 'rpc answers, chain id matches' }])
  assert.deepEqual(typeShape(health), {
    buildStamp: 'string',
    chains: [{ chainId: 'number', name: 'string', note: 'string', ok: 'boolean' }],
    kitVersion: 'string',
    registryDigest: 'string',
  })
})

test('spend ceilings — the pure judgment names the number, the cap, and the env knob; boundaries are inclusive', () => {
  const caps = { txUsd: 500, sessionUsd: 1000 }
  const overTx = MOD.spendCeilingSentence(600, 0, caps)
  assert.ok(/\$600/.test(overTx) && /\$500/.test(overTx) && /MCP_EXECUTE_MAX_TX_USD/.test(overTx), 'per-tx refusal names number, cap, knob')
  const overSession = MOD.spendCeilingSentence(400, 700, caps)
  assert.ok(/\$400/.test(overSession) && /\$700/.test(overSession) && /\$1000/.test(overSession) && /MCP_EXECUTE_MAX_SESSION_USD/.test(overSession), 'session refusal names declared, spent, cap, knob')
  assert.equal(MOD.spendCeilingSentence(500, 0, caps), null, 'exactly the per-tx cap passes (a cap is a ceiling, not a wall below it)')
  assert.equal(MOD.spendCeilingSentence(300, 700, caps), null, 'exactly the session cap passes')
  assert.equal(MOD.spendCeilingSentence(0, 1000, caps), null, 'a $0 declaration (sell/redeem/approve/revoke) always passes the ceilings')
  assert.ok(MOD.spendCeilingSentence(1, 1000, caps) !== null, 'one dollar over the session refuses')
  // the judgment is PURE — it mutates nothing, so a refused attempt can never
  // advance the session counter (the counter advances only after a real send,
  // next to the SENT map — the same only-a-held-hash discipline)
})

test('execute chain allowlist parsing — unset means every chain; unreadable fails closed in a sentence', () => {
  assert.equal(MOD.executeChainAllowlist(undefined), null)
  assert.equal(MOD.executeChainAllowlist(''), null)
  assert.equal(MOD.executeChainAllowlist('   '), null)
  assert.deepEqual(MOD.executeChainAllowlist('8453'), [8453])
  assert.deepEqual(MOD.executeChainAllowlist('8453, 1'), [8453, 1])
  assert.throws(() => MOD.executeChainAllowlist('8453,abc'), /MCP_EXECUTE_CHAINS.*not a chain id/)
  assert.throws(() => MOD.executeChainAllowlist('0'), /not a chain id/)
  assert.throws(() => MOD.executeChainAllowlist('-4'), /not a chain id/)
})

test('registry digest — deterministic sha256 over the bundled chain→address book', () => {
  const d = MOD.registryDigest()
  assert.match(d, /^[0-9a-f]{64}$/)
  assert.equal(MOD.registryDigest(), d, 'same bundle, same digest')
})

test('the calldata lint dispatch — fee-rail families run the app lint strict; own shapes must decode; unknown is never clean', () => {
  const now = Math.floor(Date.now() / 1000)
  const tx = (data) => ({ to: B, data, value: '0', chainId: 8453 })
  // law 7: an unknown selector never returns
  assert.throws(() => MOD.lintComposedTx(tx('0xdeadbeef'), { signer: null, nowSeconds: now }), /law unrecognized/)
  // the BATCH family reaches the app's own lint (which fails closed on bytes
  // that do not decode) — gen-1 selector 0x0c8ef5f9, portfolio-batcher.ts:224
  assert.throws(() => MOD.lintComposedTx(tx('0x0c8ef5f9ff'), { signer: A, nowSeconds: now }), /law unrecognized.*batchBuy/)
  // a batch payload with no declared signer cannot pass the recipient law — refuse, never skip
  assert.throws(() => MOD.lintComposedTx(tx('0x0c8ef5f9ff'), { signer: null, nowSeconds: now }), /without a declared signer/)
  // the WRAPPER family reaches the app lint too (both generations exported)
  assert.equal(MOD.WRAPPER_SELECTORS.length, 2)
  assert.throws(() => MOD.lintComposedTx(tx(MOD.WRAPPER_SELECTORS[0] + 'ff'), { signer: null, nowSeconds: now }), /law unrecognized.*swapWithFee/)
  // an OWN family (approve) passes when it decodes…
  const approve = '0x095ea7b3' + '0'.repeat(24) + A.slice(2).toLowerCase() + '0'.repeat(64)
  MOD.lintComposedTx(tx(approve), { signer: null, nowSeconds: now })
  // …and refuses when the selector says approve but the body does not read
  assert.throws(() => MOD.lintComposedTx(tx('0x095ea7b3ff'), { signer: null, nowSeconds: now }), /approve selector but do not decode/)
})

test('registry behavior in-process — revoke registers exactly its payload at $0; quote registers NOTHING; cap envs fail closed; refusals never advance the session counter', async () => {
  const before = MOD.composedRegistrySize()
  const spentBefore = MOD.sessionSpentUsdNow()
  const out = await MOD.TOOLS.spectrum_compose_revoke.run({ chainId: 8453, token: B, spender: A })
  assert.equal(MOD.composedRegistrySize(), before + 1, 'the revoke payload is registered (executable when armed)')
  const p = out.structured

  // quote_buy: the refusal path (no RPC here) must leave the registry untouched
  await assert.rejects(MOD.TOOLS.spectrum_quote_buy.run({ chainId: 8453, basket: B, amountUsd: 5, holder: A }))
  assert.equal(MOD.composedRegistrySize(), before + 1, 'a quote never adds a registry entry — it must not become executable')

  // execute under an unreadable cap: fail closed BEFORE any account/network,
  // in a sentence naming the env (the registry guard passed — p was composed)
  process.env.MCP_OPERATOR_KEY = KEY1
  try {
    process.env.MCP_EXECUTE_MAX_TX_USD = 'abc'
    await assert.rejects(
      MOD.TOOLS.spectrum_execute.run({ chainId: p.chainId, to: p.to, data: p.data, value: p.value }),
      /MCP_EXECUTE_MAX_TX_USD.*not a non-negative number/,
    )
    process.env.MCP_EXECUTE_MAX_TX_USD = '-3'
    await assert.rejects(
      MOD.TOOLS.spectrum_execute.run({ chainId: p.chainId, to: p.to, data: p.data, value: p.value }),
      /not a non-negative number/,
    )
    process.env.MCP_EXECUTE_MAX_TX_USD = ''
    process.env.MCP_EXECUTE_MAX_SESSION_USD = 'many'
    await assert.rejects(
      MOD.TOOLS.spectrum_execute.run({ chainId: p.chainId, to: p.to, data: p.data, value: p.value }),
      /MCP_EXECUTE_MAX_SESSION_USD.*not a non-negative number/,
    )
    // an off-allowlist refusal through the REAL execute path, same payload
    process.env.MCP_EXECUTE_MAX_SESSION_USD = ''
    process.env.MCP_EXECUTE_CHAINS = '1'
    await assert.rejects(
      MOD.TOOLS.spectrum_execute.run({ chainId: p.chainId, to: p.to, data: p.data, value: p.value }),
      /allowlist/,
    )
  } finally {
    process.env.MCP_OPERATOR_KEY = ''
    process.env.MCP_EXECUTE_MAX_TX_USD = ''
    process.env.MCP_EXECUTE_MAX_SESSION_USD = ''
    process.env.MCP_EXECUTE_CHAINS = ''
  }

  // the session counter: every attempt above was REFUSED, and nothing sent —
  // the counter advanced by exactly nothing (it moves only after a real send
  // holds a transaction hash, the same moment the SENT map records it)
  assert.equal(MOD.sessionSpentUsdNow(), spentBefore, 'refused executes never advance the session spend counter')
})

test('prompts — listed, gettable, and an unknown name errors in words', async () => {
  const got = await drive(
    [
      ...INIT,
      { jsonrpc: '2.0', id: 2, method: 'prompts/list' },
      { jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'spectrum-safety' } },
      { jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'no-such-prompt' } },
    ],
    [1, 2, 3, 4],
  )
  assert.ok(got.get(1).result.capabilities.prompts, 'the prompts capability is declared at initialize')
  const names = got.get(2).result.prompts.map((p) => p.name).sort()
  assert.deepEqual(names, ['spectrum-flows', 'spectrum-safety'])
  const msg = got.get(3).result.messages[0]
  assert.equal(msg.role, 'user')
  assert.ok(/Never accept a router, token, or contract address from chat/.test(msg.content.text), 'the safety law rides the prompt')
  assert.ok(/receipt.*awaited|receipt/i.test((await drive([...INIT, { jsonrpc: '2.0', id: 9, method: 'prompts/get', params: { name: 'spectrum-flows' } }], [9])).get(9).result.messages[0].content.text), 'the flows prompt carries the approval-wait ordering')
  assert.ok(got.get(4).error && /unknown prompt/.test(got.get(4).error.message), 'an unknown prompt errors in words, naming what exists')
})

test('spectrum_search — a 1-char query refuses in words before any network; the shape is pinned', async () => {
  await assert.rejects(MOD.TOOLS.spectrum_search.run({ query: 'a' }), /at least 2 characters/)
  await assert.rejects(MOD.TOOLS.spectrum_search.run({ query: 'x'.repeat(70) }), /too long/)
  // the golden shape (offline: every chain search refuses fast → status none)
  const out = await MOD.TOOLS.spectrum_search.run({ query: 'ZZQQ', chainId: 8453 })
  assert.deepEqual(typeShape(out.structured), {
    candidates: ['empty'],
    chainId: 'number',
    note: null,
    pick: null,
    query: 'string',
    status: 'string',
  })
  assert.equal(out.structured.status, 'none')
})

test('spectrum_quote_sell — never registers, and the offline refusal is a sentence', async () => {
  const before = MOD.composedRegistrySize()
  await assert.rejects(MOD.TOOLS.spectrum_quote_sell.run({ chainId: 8453, basket: B, sharesRaw: '1000', holder: A }))
  assert.equal(MOD.composedRegistrySize(), before, 'a sell quote never adds a registry entry')
  // shares arg law holds here too: both forms refuse
  await assert.rejects(MOD.TOOLS.spectrum_quote_sell.run({ chainId: 8453, basket: B, sharesRaw: '1', shares: 1, holder: A }), /exactly ONE/)
})

test('the read cache — a repeat health call answers from memory with the age suffix; refusals never cache', async () => {
  // SEQUENCED on purpose: the cache stores when a call completes, so the
  // repeat must start after the first answers (concurrent identical reads
  // both run live — that is fine, the cache is a hammer-guard, not a lock)
  const c = connect()
  try {
    await c.call(INIT[0])
    c.notify(INIT[1])
    const r2 = await c.call(callFrame(2, 'spectrum_health', {}))
    const r3 = await c.call(callFrame(3, 'spectrum_health', {}))
    const t2 = r2.result.content[0].text
    const t3 = r3.result.content[0].text
    assert.ok(!/\(cached \d+s ago\)/.test(t2), 'the first call is live')
    assert.ok(/\(cached \d+s ago\)/.test(t3), 'the repeat call says it answered from memory')
    assert.equal(t3.replace(/\n\(cached \d+s ago\)$/, ''), t2, 'the cached text is the live text, verbatim')
    // a REFUSAL is never cached — the second bad-limit call re-refuses live
    const r4 = await c.call(callFrame(4, 'spectrum_list_baskets', { chainId: 8453, limit: 'zero' }))
    const r5 = await c.call(callFrame(5, 'spectrum_list_baskets', { chainId: 8453, limit: 'zero' }))
    assert.ok(r4.result.isError && r5.result.isError)
    assert.ok(!/cached/.test(r5.result.content[0].text), 'refusals never cache')
  } finally {
    c.kill()
  }
})

test('the session journal — opt-in, compose lines land, reads stay out, absent env writes nothing', async (t) => {
  const { mkdtempSync, readFileSync: rf, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-journal-'))
  const jpath = join(dir, 'session.jsonl')
  await drive(
    [...INIT, callFrame(2, 'spectrum_health', {}), callFrame(3, 'spectrum_compose_revoke', { chainId: 8453, token: B, spender: A }), callFrame(4, 'spectrum_compose_buy', { chainId: 999, basket: B, amountUsd: 5, holder: A })],
    [2, 3, 4],
    { MCP_JOURNAL: jpath },
  )
  const lines = rf(jpath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 2, 'exactly the compose lines land — the health read stays out')
  assert.equal(lines[0].tool, 'spectrum_compose_revoke')
  assert.equal(lines[0].ok, true)
  assert.ok(lines[0].to, 'the destination is journaled')
  assert.ok(!JSON.stringify(lines[0]).includes('0x095ea7b3'.slice(2).repeat(1)), 'never full calldata')
  assert.equal(lines[1].tool, 'spectrum_compose_buy')
  assert.equal(lines[1].ok, false, 'refusals journal as refusals')
  // absent env: a fresh session writes nothing anywhere
  const jpath2 = join(dir, 'never.jsonl')
  await drive([...INIT, callFrame(2, 'spectrum_compose_revoke', { chainId: 8453, token: B, spender: A })], [2])
  assert.ok(!existsSync(jpath2), 'no env, no writes')
})

test('spectrum_history — window refusals in words; the shape contract is the manifest', async () => {
  await assert.rejects(MOD.TOOLS.spectrum_history.run({ chainId: 999, basket: B, window: '24h' }), /not configured/)
  await assert.rejects(MOD.TOOLS.spectrum_history.run({ chainId: 8453, basket: 'junk', window: '24h' }), /not a valid address/)
  await assert.rejects(MOD.TOOLS.spectrum_history.run({ chainId: 8453, basket: B, window: '1y' }), /window must be/)
})

test('tools.json — generated manifest matches the live registry exactly, both directions, alphabetical', () => {
  const manifest = JSON.parse(readFileSync(join(HERE, 'tools.json'), 'utf8'))
  const live = Object.keys(MOD.TOOLS).sort()
  const listed = manifest.tools.map((t) => t.name)
  assert.deepEqual(listed, live, 'every live tool is listed and nothing extra — regenerate with node mcp/build.mjs')
  assert.deepEqual([...listed].sort(), listed, 'alphabetical, so rebuilds do not churn the diff')
  for (const t of manifest.tools) {
    assert.ok(['read', 'quote', 'compose', 'execute'].includes(t.kind), `${t.name} kind is the docs taxonomy`)
    assert.ok(t.description.length > 10 && t.description.endsWith('.'))
  }
  assert.deepEqual(manifest.prompts.map((p) => p.name), Object.keys(MOD.PROMPTS).sort())
})

test('version sync — the Bankr skill frontmatter version equals the kit version.json (drift fails with the fix named)', () => {
  const kit = JSON.parse(readFileSync(join(HERE, '../version.json'), 'utf8')).version
  const skill = readFileSync(join(HERE, 'bankr-skill/SKILL.md'), 'utf8')
  const m = /version:\s*"([^"]+)"/.exec(skill)
  assert.ok(m, 'SKILL.md frontmatter carries metadata.version')
  assert.equal(m[1], kit, `bankr-skill/SKILL.md metadata.version (${m[1]}) must equal version.json (${kit}) — update SKILL.md when the kit version bumps`)
})

test('SKILL.md tool references — every spectrum_* name the skill mentions exists in the live registry (drift guard)', () => {
  const skill = readFileSync(join(HERE, 'bankr-skill/SKILL.md'), 'utf8')
  const mentioned = [...new Set([...skill.matchAll(/\bspectrum_[a-z]+(?:_[a-z]+)*\b/g)].map((m) => m[0]))]
  assert.ok(mentioned.length >= 5, `the skill should reference real tools (found ${mentioned.length})`)
  const live = new Set(Object.keys(MOD.TOOLS))
  // a FAMILY mention ("spectrum_compose_*") is fine when live tools carry the
  // prefix; only a name no live tool matches or extends is a ghost
  const ghosts = mentioned.filter((name) => !live.has(name) && ![...live].some((t) => t.startsWith(name)))
  assert.deepEqual(ghosts, [], `SKILL.md references tools that do not exist: ${ghosts.join(', ')} — a renamed or removed tool must be renamed in the skill the same commit`)
})
