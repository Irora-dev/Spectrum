// Service-worker entry. MV3 discipline shapes everything here:
//
//  · This worker is woken by alarms and killed when idle. It polls chain,
//    evaluates the user's local alert rules, and fires notifications.
//    It has no DOM, no window, and NO WALLET — it cannot sign, by design;
//    the extension notices, the site executes.
//  · Event listeners are registered synchronously at the top level (a listener
//    added after an await misses the event that woke the worker).
//  · The poll module is imported STATICALLY — MV3 service workers forbid
//    dynamic import() at runtime (the live-fire round caught this: the worker
//    woke, threw on import('./poll'), and nothing ever reached storage). The
//    lib's module-scope cache reads therefore run before the shim's backing
//    store hydrates — safe, because persist-cache degrades to null inside its
//    own try/catch; every call-time read happens after hydration in runPoll.

import { hydrateLocalStorageShim, installLocalStorageShim } from '../shared/localstorage-shim'
import { runPoll } from './poll'
import { getSettings, takeNotificationLink } from '../shared/storage'

installLocalStorageShim()

const POLL_ALARM = 'spectrum-poll'

async function ensureAlarm(): Promise<void> {
  const settings = await getSettings()
  // One periodic alarm at the user's cadence. Packed extensions floor alarm
  // periods at 30s; ours floors at 5 MINUTES — the platform allowing faster is
  // not a reason to burn RPC on a portfolio that moves in hours.
  await chrome.alarms.create(POLL_ALARM, {
    periodInMinutes: settings.pollMinutes,
    delayInMinutes: 1,
  })
}

let polling = false
async function runGuarded(trigger: 'alarm' | 'manual'): Promise<{ ok: boolean; reason?: string }> {
  if (polling) return { ok: false, reason: 'already-running' }
  polling = true
  // Chrome kills an MV3 worker ~30s after its last extension-API activity, and
  // a cold discovery over public RPC can sit in fetch() longer than that. An
  // extension-API heartbeat (Chrome's own documented pattern) resets the idle
  // timer for the duration of the poll — and only for the duration.
  const keepalive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000)
  try {
    await hydrateLocalStorageShim()
    return await runPoll(trigger)
  } finally {
    clearInterval(keepalive)
    polling = false
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm()
})

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) void runGuarded('alarm')
})

chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
  if (msg?.type === 'poll-now') {
    runGuarded('manual').then(sendResponse, () => sendResponse({ ok: false, reason: 'error' }))
    return true // async response
  }
  if (msg?.type === 'settings-changed') {
    ensureAlarm().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }))
    return true
  }
  return undefined
})

// The user's settings live in storage.sync and FOLLOW them across devices —
// a cadence changed on another machine must re-arm this machine's alarm too
// (the popup's settings-changed message only covers local saves).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes['settings/v1']) void ensureAlarm()
})

// A notification click deep-links out with INTENT only; the site recomputes
// from live state. chrome.tabs.create needs no "tabs" permission.
chrome.notifications.onClicked.addListener((id) => {
  void (async () => {
    const url = await takeNotificationLink(id)
    if (url) await chrome.tabs.create({ url })
    chrome.notifications.clear(id)
  })()
})

// Dismissed-without-clicking must not leak its parked deep link.
chrome.notifications.onClosed.addListener((id) => {
  void takeNotificationLink(id)
})
