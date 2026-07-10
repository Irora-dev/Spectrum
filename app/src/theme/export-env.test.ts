import { describe, it, expect } from 'vitest'
import { DEFAULT_DEPLOY, envConfigToText, FEE_TIERS, hasDeployErrors, pageTierWarnings, siteConfigToJson, validateDeploy, type DeployConfig } from './export-env'

const base: DeployConfig = { feeWallet: '0xFEE', rpcKey: 'key1', siteUrl: 'https://acme.xyz', tier: 'all' }

describe('envConfigToText', () => {
  it('the committed json carries the ALL-features default; the env carries only the RPC key', () => {
    expect(DEFAULT_DEPLOY.tier).toBe('all')
    expect(FEE_TIERS[0]).toBe('all')
    const json = JSON.parse(siteConfigToJson(base))
    expect(json.features).toEqual({ wallet: true, deploy: true, trading: true, swap: true })
    const env = envConfigToText(base)
    expect(env).not.toMatch(/VITE_ENABLE_/)
    expect(env).toMatch(/^VITE_ALCHEMY_API_KEY=key1$/m)
    expect(env).not.toMatch(/VITE_SUPABASE_URL=/)
    expect(env).toMatch(/ships DB-less/)
  })
  it('narrower tiers scope the committed features down', () => {
    expect(JSON.parse(siteConfigToJson({ ...base, tier: 'info' })).features)
      .toEqual({ wallet: true, deploy: false, trading: false, swap: false })
    expect(JSON.parse(siteConfigToJson({ ...base, tier: 'creation' })).features)
      .toEqual({ wallet: true, deploy: true, trading: false, swap: false })
  })
  it('env carries no identity or address lines at all', () => {
    const env = envConfigToText(base)
    for (const v of ['VITE_FACTORY_ADDRESS', 'VITE_SWAP_ROUTER_ADDRESS', 'VITE_WALLETCONNECT_PROJECT_ID', 'VITE_INTERFACE_TAG_ADDRESS', 'VITE_LAUNCHER_ADDRESS', 'VITE_SITE_URL', 'VITE_EXTRA_CHAIN_IDS']) {
      expect(env).not.toMatch(new RegExp(`^${v}=`, 'm'))
    }
    expect(env).toMatch(/canonical Spectrum deployment \(Base \+ Ethereum, both live\)/)
  })
  it('siteConfigToJson carries the committed identity (RPC key excluded)', () => {
    const json = JSON.parse(siteConfigToJson({ ...base, siteUrl: 'https://acme.xyz' }))
    expect(json.siteUrl).toBe('https://acme.xyz')
    expect(json.feeWallet).toBe('0xFEE')
    expect(JSON.stringify(json)).not.toMatch(/key1/)
  })
})

const VALID = '0x1234567890abcdef1234567890abcdef12345678'
// A config with the two REQUIRED fields (RPC key + site URL) filled; fee wallet optional.
const FILLED: DeployConfig = { ...DEFAULT_DEPLOY, rpcKey: 'key1', siteUrl: 'https://example.xyz' }

describe('validateDeploy', () => {
  it('RPC key + site URL are REQUIRED: a fresh config has exactly those two errors', () => {
    const { errors } = validateDeploy(DEFAULT_DEPLOY)
    expect(errors.rpcKey).toBeDefined()
    expect(errors.siteUrl).toBeDefined()
    expect(errors.feeWallet).toBeUndefined() // fee wallet stays optional
    expect(hasDeployErrors(errors)).toBe(true)
  })
  it('with RPC key + site URL filled the config is clean (fee wallet blank is fine)', () => {
    const { errors, warnings } = validateDeploy(FILLED)
    expect(hasDeployErrors(errors)).toBe(false)
    expect(warnings.siteUrl).toBeUndefined()
  })
  it('a valid fee wallet is clean; a malformed one is a blocking error', () => {
    expect(hasDeployErrors(validateDeploy({ ...FILLED, feeWallet: VALID }).errors)).toBe(false)
    const { errors } = validateDeploy({ ...FILLED, feeWallet: '0xNOPE' })
    expect(errors.feeWallet).toBeDefined()
    expect(hasDeployErrors(errors)).toBe(true)
  })
  it('a filled but non-https site URL warns without blocking (presence satisfied)', () => {
    const { errors, warnings } = validateDeploy({ ...FILLED, siteUrl: 'not a url' })
    expect(warnings.siteUrl).toBeDefined()
    expect(errors.siteUrl).toBeUndefined()
    expect(hasDeployErrors(errors)).toBe(false)
  })
})

describe('pageTierWarnings', () => {
  it('the all-features default warns for nothing', () => {
    expect(pageTierWarnings(DEFAULT_DEPLOY, undefined)).toHaveLength(0)
  })
  it('info tier (wallet on) warns for the pages its tier cannot power', () => {
    const pages = pageTierWarnings({ ...DEFAULT_DEPLOY, tier: 'info' }, undefined).map((w) => w.page).sort()
    expect(pages).toEqual(['fees', 'launch', 'trade'])
  })
  it('creation tier clears launch + portfolio; trade + fees still warn', () => {
    const pages = pageTierWarnings({ ...DEFAULT_DEPLOY, tier: 'creation' }, undefined).map((w) => w.page).sort()
    expect(pages).toEqual(['fees', 'trade'])
  })
  it('a disabled page never warns', () => {
    const w = pageTierWarnings({ ...DEFAULT_DEPLOY, tier: 'info' }, { launch: false, trade: false, fees: false, portfolio: false })
    expect(w).toHaveLength(0)
  })
})
