import { useCallback, useEffect, useRef, useState } from 'react'

// ── one copy behaviour for every copy affordance ──────────────────────────────
// Extracted from the DocKit chip's private `useCopy` — the implementation that
// already backed CopyChip and AddrChips — so the QOL round's shared CopyAddress
// composes the real thing instead of growing a fourth copy of it (QOL round
// 2026-08-05 #6: "copy-address affordances are inconsistent").
//
// Hardened over the original in the three ways an address chip needs:
//  · a missing clipboard API (insecure context, an old browser) and a REJECTED
//    write (denied permission) both fail quietly — never a throw, and never a
//    "Copied" that lies about what is on the clipboard.
//  · the reset timer lives in a ref and is cleared both on unmount and before it
//    is re-armed, so a chip that disappears mid-flourish (a search row
//    re-rendering, a card leaving the grid) strands nothing, and a fast repeat
//    tap can never leave the label stuck on "Copied".
//  · `copied` flips only after the write actually resolved.
//
// Follow-up for whoever owns those files next: DocKit's `useCopy`,
// ListingPipeline's CopyRow and Portfolio's BasketAdminBar each still carry
// their own timer — they should import this hook.
export function useCopy(resetMs = 1600): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback(
    async (text: string) => {
      if (!text) return
      try {
        if (!navigator.clipboard?.writeText) return
        await navigator.clipboard.writeText(text)
      } catch {
        return
      }
      setCopied(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        setCopied(false)
        timer.current = null
      }, resetMs)
    },
    [resetMs],
  )

  return { copied, copy }
}
