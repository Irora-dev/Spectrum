// Tiny localStorage JSON cache with TTL — for keyless third-party lookups
// (Coingecko token info, the verified token list, extracted logo colors) so
// repeat visits don't re-spend network or rate-limit budget. Every operation
// is best-effort: quota errors, privacy modes, and SSR all degrade to "no
// cache" silently. Never load-bearing.

const PREFIX = 'spectrum:cache:v1:'

interface Boxed<T> {
  v: T
  /** Expiry epoch-ms; 0 = never. */
  exp: number
}

export function cacheGet<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key)
    if (!raw) return null
    const boxed = JSON.parse(raw) as Boxed<T>
    if (boxed.exp !== 0 && Date.now() > boxed.exp) {
      window.localStorage.removeItem(PREFIX + key)
      return null
    }
    return boxed.v
  } catch {
    return null
  }
}

export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  try {
    const boxed: Boxed<unknown> = { v: value, exp: ttlMs > 0 ? Date.now() + ttlMs : 0 }
    window.localStorage.setItem(PREFIX + key, JSON.stringify(boxed))
  } catch {
    /* quota / privacy mode / SSR — cache is optional */
  }
}

export const DAY_MS = 86_400_000
