// The deep-link contract — the ONLY interface between the extension and the
// site. A link carries INTENT, never a plan: no encoded amounts, no encoded
// weights. Prices move between the notification and the click, and a URL is
// user-editable, so the site always recomputes from live state and no deep
// link ever lands on a signature.

import siteConfig from '@app/site.config.json'

/** Deep-link base: the user's setting wins, then the build-time env override,
 *  then the operator's committed site.config.json. Null = not configured yet
 *  (the popup asks for it before showing outbound actions).
 *  The PATH is preserved — the kit supports subpath hosting (base:'./'), so an
 *  operator at example.com/shop must deep-link to /shop/portfolio. Query and
 *  hash are dropped: the base is a place, not a plan. */
export function siteBase(settingsSiteUrl?: string): string | null {
  const fromSettings = settingsSiteUrl?.trim()
  const fromEnv = (import.meta.env.VITE_SITE_URL as string | undefined)?.trim()
  const fromConfig = (siteConfig as { siteUrl?: string }).siteUrl?.trim()
  const base = fromSettings || fromEnv || fromConfig || ''
  if (!base) return null
  try {
    const u = new URL(base.includes('://') ? base : `https://${base}`)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return (u.origin + u.pathname).replace(/\/+$/, '')
  } catch {
    return null
  }
}

export function portfolioUrl(base: string): string {
  return `${base}/portfolio`
}

export function tokenUrl(base: string, address: string, chainId: number): string {
  return `${base}/token?addr=${encodeURIComponent(address)}&chain=${chainId}`
}
