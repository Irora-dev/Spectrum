// Mobile wallet rails (owner 2026-07-12 12:36: "on mobile there's no way to
// actually connect — injected does nothing").
//
// A phone browser has no extension, so EIP-6963 discovers nothing and the bare
// `injected` connector is a dead row. The zero-config rail is the wallet apps'
// own dapp-browser deep links: each opens THIS site inside the wallet's in-app
// browser, where an injected provider exists and connecting works normally.
// Only wallets with a DOCUMENTED browse deep link ship here (a broken deep link
// is worse than none):
//   MetaMask  https://link.metamask.io/dapp/<host+path, scheme stripped>
//   Phantom   https://phantom.app/ul/browse/<url>?ref=<origin>   (EVM-capable)
//   Trust     https://link.trustwallet.com/open_url?coin_id=60&url=<url>
// Rainbow, Uniswap and Rabby mobile are WalletConnect-first with no public
// browse deep link — they connect through the WalletConnect row (when the
// operator configured a project id) or by opening the site in their built-in
// browsers by hand; the connect dialog says so honestly.

export interface WalletAppLink {
  name: string
  href: string
}

/** Coarse phone/tablet check — a UI hint, never a capability gate. */
export function isMobileUA(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /iphone|ipad|ipod|android/i.test(ua)
}

/** True when the page already has an injected EIP-1193 provider (inside a
 *  wallet's in-app browser, or a desktop extension) — the deep-link rail is
 *  pointless there and the normal connector list works. */
export function hasInjectedProvider(): boolean {
  return typeof window !== 'undefined' && 'ethereum' in window && !!(window as { ethereum?: unknown }).ethereum
}

/** Deep links that open `url` inside each wallet app's dapp browser. Pure. */
export function walletAppLinks(url: string): WalletAppLink[] {
  const u = new URL(url)
  const schemeless = `${u.host}${u.pathname}${u.search}`
  return [
    { name: 'MetaMask', href: `https://link.metamask.io/dapp/${schemeless}` },
    { name: 'Phantom', href: `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(u.origin)}` },
    { name: 'Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}` },
  ]
}
