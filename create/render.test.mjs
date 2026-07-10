import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderBrandConfig, renderEnv, renderSiteConfig, validateSiteName } from './render.mjs'

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
  assert.match(env, /canonical Spectrum deployment \(Base \+ Ethereum, both live\)/)
})

test('scoped tiers land in the json; explicit router override still emits in env', () => {
  const info = JSON.parse(renderSiteConfig({ tier: 'info' }))
  assert.deepEqual(info.features, { wallet: true, deploy: false, trading: false, swap: false })
  const m = renderEnv({ tier: 'marketplace', swapRouter: '0xR' })
  assert.match(m, /VITE_SWAP_ROUTER_ADDRESS=0xR/)
})

test('validateSiteName rejects empty / long / spectrum', () => {
  assert.equal(validateSiteName('Acme').ok, true)
  assert.equal(validateSiteName('').ok, false)
  assert.equal(validateSiteName('x'.repeat(33)).ok, false)
  assert.equal(validateSiteName('My Spectrum').ok, false)
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
