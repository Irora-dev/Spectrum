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

/** Coarse phone/tablet check — a UI hint, never a capability gate. iPadOS 13+
 *  Safari reports a desktop "Macintosh" UA; the multi-touch probe catches it
 *  (real Macs report maxTouchPoints 0; systems audit). */
export function isMobileUA(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  if (/iphone|ipad|ipod|android/i.test(ua)) return true
  return /macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1
}

/** Fine-pointer check (desktop mouse/trackpad): gate `autoFocus` on pickers so
 *  a phone doesn't pop the keyboard over the list it opened to BROWSE. */
export function hasFinePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
}

/** True when the page already has an injected EIP-1193 provider (inside a
 *  wallet's in-app browser, or a desktop extension) — the deep-link rail is
 *  pointless there and the normal connector list works. */
export function hasInjectedProvider(): boolean {
  return typeof window !== 'undefined' && 'ethereum' in window && !!(window as { ethereum?: unknown }).ethereum
}

/** Deep links that open `url` inside each wallet app's dapp browser. Pure.
 *  The MetaMask path/query tail is percent-encoded and carries the hash —
 *  a raw `?basket=…&chain=…` rode un-namespaced on the universal link where
 *  the link parser could eat it (systems audit; Phantom/Trust already encode). */
export function walletAppLinks(url: string): WalletAppLink[] {
  const u = new URL(url)
  const schemeless = `${u.host}${encodeURIComponent(`${u.pathname}${u.search}${u.hash}`)}`
  return [
    { name: 'MetaMask', href: `https://link.metamask.io/dapp/${schemeless}` },
    { name: 'Phantom', href: `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(u.origin)}` },
    { name: 'Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}` },
  ]
}
