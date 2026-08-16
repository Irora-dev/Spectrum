import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PAGE_KEYS, renderBrandConfig, renderEnv, renderSiteConfig, validateSiteName } from './render.mjs'

test('renderBrandConfig emits name/style/palette and only OFF pages', () => {
  const out = renderBrandConfig({
    name: 'Acme Baskets', tagline: 'onchain baskets', style: 'aurora',
    palette: { from: '#111111', via: '#222222', to: '#333333', accent: '#444444' },
    pagesOff: ['refer', 'integrate'],
  })
  assert.match(out, /name: "Acme Baskets"/)
  assert.match(out, /style: "aurora"/)
  assert.match(out, /gradientFrom: "#111111"/)
  assert.match(out, /accent: "#444444"/)
  assert.match(out, /refer: false/)
  assert.match(out, /integrate: false/)
  assert.doesNotMatch(out, /discover: false/) // omitted keys stay on
  assert.match(out, /satisfies|: BrandConfig/) // typed against the contract
})

test('renderBrandConfig defaults style to spectral + omits pages when all on', () => {
  const out = renderBrandConfig({ name: 'Baskets', palette: {} })
  assert.match(out, /style: "spectral"/)
  assert.doesNotMatch(out, /pages:/)
  assert.match(out, /gradientFrom: "#ff9248"/) // SPECTRUM_DNA default
})

test('bundle is a real page key here (it was missing while the app + studio had it)', () => {
  assert.ok(PAGE_KEYS.includes('bundle'))
  assert.match(renderBrandConfig({ name: 'Baskets', palette: {}, pagesOff: ['bundle'] }), /bundle: false/)
})

// This file HAND-MIRRORS the app's PAGE_KEYS (it can't import TS from the app).
// The mirror silently lost 'bundle' once, making `--no-bundle` a no-op while the
// /setup studio honoured it. Pin the mirror against the app's own source.
test('PAGE_KEYS mirrors app/src/theme/brand.ts exactly, and in order', () => {
  const src = readFileSync(new URL('../app/src/theme/brand.ts', import.meta.url), 'utf8')
  const block = /export const PAGE_KEYS: PageKey\[\] = \[([\s\S]*?)\]/.exec(src)
  assert.ok(block, "couldn't locate PAGE_KEYS in the app source")
  const appKeys = [...block[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
  assert.deepEqual(PAGE_KEYS, appKeys)
})

// Same hazard for the feature knobs: the app declares them on BrandConfig, and
// this renderer has to be able to emit every one of them.
test('every default-ON BrandConfig knob the app declares is emittable here', () => {
  const src = readFileSync(new URL('../app/src/theme/brand.ts', import.meta.url), 'utf8')
  // setupStudio left this list 2026-08-02: it is OPT-IN now, so its emittable
  // value is `true`, not `false`. Covered just below rather than dropped.
  const declared = ['stocks', 'starterTokens', 'prismCredit']
  for (const k of declared) {
    assert.match(src, new RegExp(`\\n\\s*${k}\\?: boolean`), `${k} should be a BrandConfig knob`)
    const out = renderBrandConfig({ name: 'Baskets', palette: {}, [k]: false })
    assert.match(out, new RegExp(`${k}: false`), `renderBrandConfig must emit ${k}: false`)
  }
  // The OPT-IN knob gets the same protection in its own direction: the app must
  // declare it, and this renderer must be able to emit it.
  assert.match(src, /\n\s*setupStudio\?: boolean/, 'setupStudio should be a BrandConfig knob')
  assert.match(
    renderBrandConfig({ name: 'Baskets', palette: {}, setupStudio: true }),
    /setupStudio: true/,
    'renderBrandConfig must emit setupStudio: true',
  )
})

test('renderBrandConfig emits the default-ON feature knobs only when turned OFF', () => {
  const on = renderBrandConfig({ name: 'Baskets', palette: {} })
  for (const k of ['stocks', 'starterTokens', 'prismCredit', 'setupStudio', 'defaultChainId']) {
    assert.doesNotMatch(on, new RegExp(`${k}:`), `${k} must be omitted when left ON`)
  }
  const off = renderBrandConfig({
    name: 'Baskets',
    palette: {},
    stocks: false,
    starterTokens: false,
    prismCredit: false,
    setupStudio: false,
    defaultChainId: 8453,
  })
  assert.match(off, /stocks: false/)
  assert.match(off, /starterTokens: false/)
  assert.match(off, /prismCredit: false/)
  // setupStudio is OPT-IN since 2026-08-02, so `false` is the DEFAULT and emits
  // nothing: an absent key already means off. Asserting its absence is what
  // catches a regression back to opt-out.
  assert.doesNotMatch(off, /setupStudio/)
  assert.match(off, /defaultChainId: 8453/)
})

test('setupStudio is OPT-IN: the key is emitted only when explicitly enabled', () => {
  const optedIn = renderBrandConfig({ name: 'Baskets', palette: {}, setupStudio: true })
  assert.match(optedIn, /setupStudio: true/)
})

test('renderEnv carries only the RPC key + explicit overrides; flags/identity move to site.config.json', () => {
  const env = renderEnv({ tier: 'creation', factory: '0xFAC', feeWallet: '0xFEE', rpcKey: 'k1' })
  assert.doesNotMatch(env, /VITE_ENABLE_/)
  assert.match(env, /VITE_FACTORY_ADDRESS=0xFAC/)
  assert.match(env, /VITE_ALCHEMY_API_KEY=k1/)
  assert.doesNotMatch(env, /VITE_INTERFACE_TAG_ADDRESS=/)
  assert.doesNotMatch(env, /VITE_LAUNCHER_ADDRESS=/)
  assert.doesNotMatch(env, /VITE_SITE_URL=/)
  assert.doesNotMatch(env, /VITE_SUPABASE_URL=/)
  assert.doesNotMatch(env, /VITE_METADATA_BASE_URL=/)
  assert.match(env, /ships DB-less/)
})

test('renderSiteConfig carries identity + tier features (RPC key excluded)', () => {
  const json = JSON.parse(renderSiteConfig({ siteUrl: 'https://acme.xyz', feeWallet: '0xFEE', rpcKey: 'SECRETISH', tier: 'creation' }))
  assert.deepEqual(json, {
    siteUrl: 'https://acme.xyz', feeWallet: '0xFEE',
    features: { wallet: true, deploy: true, trading: false, swap: false },
  })
})

test('no tier given -> ALL features in the committed json; env has no address lines', () => {
  const json = JSON.parse(renderSiteConfig({ feeWallet: '0xFEE' }))
  assert.deepEqual(json.features, { wallet: true, deploy: true, trading: true, swap: true })
  const env = renderEnv({ feeWallet: '0xFEE' })
  assert.doesNotMatch(env, /VITE_FACTORY_ADDRESS=/)
  assert.doesNotMatch(env, /VITE_SWAP_ROUTER_ADDRESS=/)
  assert.doesNotMatch(env, /VITE_WALLETCONNECT_PROJECT_ID=/)
  assert.doesNotMatch(env, /VITE_EXTRA_CHAIN_IDS/)
  assert.match(env, /canonical Spectrum deployment \(Base, Ethereum \+ Robinhood Chain\)/)
})

test('scoped tiers land in the json; explicit router override still emits in env', () => {
  // info = browse/read with NO wallet — the same state check-config names
  // "info-only"; wallet:true here made the wizard's info site connect wallets.
  const info = JSON.parse(renderSiteConfig({ tier: 'info' }))
  assert.deepEqual(info.features, { wallet: false, deploy: false, trading: false, swap: false })
  // every transactional tier still carries the wallet flag the app requires
  const fees = JSON.parse(renderSiteConfig({ tier: 'fees' }))
  assert.deepEqual(fees.features, { wallet: true, deploy: false, trading: true, swap: false })
  const m = renderEnv({ tier: 'marketplace', swapRouter: '0xR' })
  assert.match(m, /VITE_SWAP_ROUTER_ADDRESS=0xR/)
})

test('validateSiteName rejects empty / long, and ACCEPTS Spectrum', () => {
  assert.equal(validateSiteName('Acme').ok, true)
  assert.equal(validateSiteName('').ok, false)
  assert.equal(validateSiteName('x'.repeat(33)).ok, false)
  // The "no Spectrum" rejection was removed (owner 2026-07-29): a site on this
  // kit is an interface to the Spectrum protocol, and that name is now the
  // recommended default.
  assert.equal(validateSiteName('My Spectrum').ok, true)
  assert.equal(validateSiteName('Spectrum').ok, true)
})

test('hostingGuide covers every host; vps walks server rules; unknown falls back', async () => {
  const { HOSTS, hostingGuide } = await import('./render.mjs')
  for (const h of HOSTS) {
    const g = hostingGuide(h)
    assert.ok(Array.isArray(g) && g.length >= 2, `${h} guide has lines`)
    assert.match(g[0], /Hosting/, `${h} guide is labeled`)
  }
  const vps = hostingGuide('vps').join('\n')
  assert.match(vps, /try_files/)     // the nginx rules are in the walkthrough
  assert.match(vps, /HTTPS/)         // secure-context note present
  assert.match(vps, /rsync|scp/)     // a concrete upload command
  assert.deepEqual(hostingGuide('geocities'), hostingGuide('later')) // unknown → later
})
