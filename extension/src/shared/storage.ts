// One typed home for everything the extension stores, and WHERE it lives:
//
//   storage.sync   — the user's own configuration (watched address, poll
//                    interval, site URL, target weights, alert rules). Small,
//                    worth surviving a reinstall, follows the user across
//                    devices through their own browser account — none of it
//                    ours to operate.
//   storage.local  — device-local machinery: the cached portfolio snapshot,
//                    per-rule notification cooldowns, poll back-off state, and
//                    the service worker's localStorage shim backing store.
//
// Nothing here is a server, an account, or telemetry.

import type { PortfolioSnapshot } from './portfolio'
import type { Rule } from './rules'

// ── keys ─────────────────────────────────────────────────────────────────────

const K_SETTINGS = 'settings/v1' // sync
const K_RULES = 'rules/v1' // sync
const K_SNAPSHOT = 'snapshot/v1' // local
const K_COOLDOWNS = 'cooldowns/v1' // local
const K_BACKOFF = 'backoff/v1' // local
const K_NOTIF_LINKS = 'notif-links/v1' // local

// ── settings ─────────────────────────────────────────────────────────────────

export interface Settings {
  /** Watched address (read-only lens — an address, never a connection). */
  address?: string
  /** Poll cadence in minutes. Floor 5 — a portfolio moves in hours, and the
   *  copy must never imply real-time anyway (alarms don't wake a sleeping
   *  machine). */
  pollMinutes: number
  /** The operator site actions hand off to (deep-link base). */
  siteUrl?: string
  /** Target weights by exposure key `${chainId}:${address}` (percent). */
  targets: Record<string, number>
}

export const POLL_MINUTES_DEFAULT = 15
export const POLL_MINUTES_FLOOR = 5

export function clampPollMinutes(n: number | undefined): number {
  if (!Number.isFinite(n)) return POLL_MINUTES_DEFAULT
  return Math.max(POLL_MINUTES_FLOOR, Math.round(n as number))
}

export async function getSettings(): Promise<Settings> {
  const got = await chrome.storage.sync.get(K_SETTINGS)
  const raw = (got[K_SETTINGS] ?? {}) as Partial<Settings>
  return {
    address: raw.address,
    pollMinutes: clampPollMinutes(raw.pollMinutes),
    siteUrl: raw.siteUrl,
    targets: raw.targets ?? {},
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings()
  const next: Settings = {
    ...cur,
    ...patch,
    pollMinutes: clampPollMinutes(patch.pollMinutes ?? cur.pollMinutes),
    targets: patch.targets ?? cur.targets,
  }
  await chrome.storage.sync.set({ [K_SETTINGS]: next })
  return next
}

// ── alert rules ──────────────────────────────────────────────────────────────

export async function getRules(): Promise<Rule[]> {
  const got = await chrome.storage.sync.get(K_RULES)
  const raw = got[K_RULES]
  return Array.isArray(raw) ? (raw as Rule[]) : []
}

export async function setRules(rules: Rule[]): Promise<void> {
  await chrome.storage.sync.set({ [K_RULES]: rules })
}

// ── snapshot ─────────────────────────────────────────────────────────────────

export async function getSnapshot(): Promise<PortfolioSnapshot | null> {
  const got = await chrome.storage.local.get(K_SNAPSHOT)
  const raw = got[K_SNAPSHOT] as PortfolioSnapshot | undefined
  return raw && raw.v === 1 ? raw : null
}

export async function setSnapshot(snap: PortfolioSnapshot): Promise<void> {
  await chrome.storage.local.set({ [K_SNAPSHOT]: snap })
}

export async function clearSnapshot(): Promise<void> {
  await chrome.storage.local.remove(K_SNAPSHOT)
}

// ── notification cooldowns ───────────────────────────────────────────────────
// A threshold oscillating around its boundary must not spam: each fired key
// (rule × subject) is quiet until its cooldown passes.

export const COOLDOWN_MS_DEFAULT = 6 * 60 * 60 * 1000

export async function filterCooldown<T extends { key: string }>(
  firings: T[],
  now = Date.now(),
  cooldownMs = COOLDOWN_MS_DEFAULT,
): Promise<T[]> {
  if (firings.length === 0) return firings
  const got = await chrome.storage.local.get(K_COOLDOWNS)
  const map = (got[K_COOLDOWNS] ?? {}) as Record<string, number>
  const fresh = firings.filter((f) => !(map[f.key] > now))
  if (fresh.length > 0) {
    for (const f of fresh) map[f.key] = now + cooldownMs
    for (const [k, until] of Object.entries(map)) if (until <= now) delete map[k]
    await chrome.storage.local.set({ [K_COOLDOWNS]: map })
  }
  return fresh
}

// ── poll back-off ────────────────────────────────────────────────────────────
// Back off hard on total failure: consecutive failures push the next attempt
// out (1×, 2×, 4×, 8× the poll interval, capped) instead of hammering a sick
// endpoint every alarm.

export interface Backoff {
  failures: number
  untilMs: number
}

export async function getBackoff(): Promise<Backoff> {
  const got = await chrome.storage.local.get(K_BACKOFF)
  const raw = (got[K_BACKOFF] ?? {}) as Partial<Backoff>
  return { failures: raw.failures ?? 0, untilMs: raw.untilMs ?? 0 }
}

export async function bumpBackoff(pollMinutes: number, now = Date.now()): Promise<Backoff> {
  const prev = await getBackoff()
  const failures = prev.failures + 1
  const factor = Math.min(2 ** (failures - 1), 8)
  const next: Backoff = { failures, untilMs: now + factor * pollMinutes * 60_000 }
  await chrome.storage.local.set({ [K_BACKOFF]: next })
  return next
}

export async function clearBackoff(): Promise<void> {
  await chrome.storage.local.remove(K_BACKOFF)
}

// ── notification → destination links ─────────────────────────────────────────
// chrome.notifications carries no payload; park each notification's deep link
// so onClicked can route. Pruned as notifications are consumed.

const NOTIF_LINKS_MAX = 50

export async function rememberNotificationLink(id: string, url: string): Promise<void> {
  const got = await chrome.storage.local.get(K_NOTIF_LINKS)
  const map = (got[K_NOTIF_LINKS] ?? {}) as Record<string, string>
  map[id] = url
  // onClosed prunes normally; this cap is the backstop (oldest first — ids
  // carry their creation timestamp, and insertion order matches anyway).
  const keys = Object.keys(map)
  for (const k of keys.slice(0, Math.max(0, keys.length - NOTIF_LINKS_MAX))) delete map[k]
  await chrome.storage.local.set({ [K_NOTIF_LINKS]: map })
}

export async function takeNotificationLink(id: string): Promise<string | null> {
  const got = await chrome.storage.local.get(K_NOTIF_LINKS)
  const map = (got[K_NOTIF_LINKS] ?? {}) as Record<string, string>
  const url = map[id] ?? null
  if (url) {
    delete map[id]
    await chrome.storage.local.set({ [K_NOTIF_LINKS]: map })
  }
  return url
}
