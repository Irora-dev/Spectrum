// ─────────────────────────────────────────────────────────────────────────────
// SEARCH FOCUS — the seam behind the keyboard shortcut (QOL #18, owner-greenlit
// 2026-08-05: "no keyboard search; command-K is the biggest speed win for power
// users, and the modal already exists").
//
// The house idiom for "some other surface should do a thing" is a window event
// (`spectrum:connect` already summons the wallet dialog from anywhere), so this
// follows it rather than threading refs through the shell.
//
// TWO CASES, one call. A search input that is ALREADY on screen should just take
// focus; a page without one has to travel to the Baskets page first. The event
// is `cancelable`, so a mounted search calls preventDefault() to claim it and
// `dispatchEvent` returns false — the caller learns synchronously whether a live
// input answered, with no timer and no guessing.
//
// The PENDING flag covers the travelling case: a search that mounts after a
// request consumes it once. Deliberately module-level rather than storage — this
// is a gesture in flight, never a preference that should survive a reload.
// ─────────────────────────────────────────────────────────────────────────────

export const SEARCH_FOCUS_EVENT = 'spectrum:search-focus'

let pending = false

/** Ask the app to focus its search. Returns true when a mounted input took it. */
export function requestSearchFocus(): boolean {
  const claimed =
    typeof window !== 'undefined' &&
    !window.dispatchEvent(new CustomEvent(SEARCH_FOCUS_EVENT, { cancelable: true }))
  // Nobody answered: leave the request standing for the search that is about to
  // mount on the page we are travelling to.
  pending = !claimed
  return claimed
}

/** A mounting search asks once whether it arrived because of the shortcut. */
export function consumeSearchFocusRequest(): boolean {
  if (!pending) return false
  pending = false
  return true
}

/** True on mac-family platforms, where the shortcut wears Command rather than
 *  Control. Read at call time so tests can stub the navigator. */
export function isMacPlatform(): boolean {
  try {
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')
  } catch {
    return false
  }
}
