import { describe, it, expect } from 'vitest'
import { isMobileUA, walletAppLinks } from './mobile'

describe('isMobileUA', () => {
  it('matches phones and tablets, not desktops', () => {
    expect(isMobileUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true)
    expect(isMobileUA('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(true)
    expect(isMobileUA('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe(true)
    expect(isMobileUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false)
    expect(isMobileUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false)
  })
})

describe('walletAppLinks', () => {
  const url = 'https://acme.example/token/8453/0xAbC?x=1'
  const links = Object.fromEntries(walletAppLinks(url).map((l) => [l.name, l.href]))

  it('MetaMask gets the scheme-stripped host+path form', () => {
    expect(links['MetaMask']).toBe('https://link.metamask.io/dapp/acme.example/token/8453/0xAbC?x=1')
  })

  it('Phantom gets the encoded browse form with a ref', () => {
    expect(links['Phantom']).toBe(
      `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent('https://acme.example')}`,
    )
  })

  it('Trust gets the open_url form with the EVM coin id', () => {
    expect(links['Trust Wallet']).toBe(
      `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}`,
    )
  })

  it('every link is https and carries the site', () => {
    for (const l of walletAppLinks(url)) {
      expect(l.href.startsWith('https://')).toBe(true)
      expect(l.href.includes('acme.example')).toBe(true)
    }
  })
})
