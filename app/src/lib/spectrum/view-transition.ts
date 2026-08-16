// ─────────────────────────────────────────────────────────────────────────────
// THE GLIDE (the owner's greenlight, 2026-08-03 ~16:2x): cross-surface shared-
// element motion — the found book's tiles travel into the weight station as
// one motion, "what you hold becomes your plan" as a single visual sentence.
//
// Progressive by construction: no View Transitions support, or a reduced-
// motion preference, and the update runs plainly — today's behavior, exactly.
// Names must be valid CSS custom-idents, so tile ids (which carry ':') are
// sanitized; BOTH surfaces derive names from the SAME unified-asset id, which
// is what makes the browser pair old and new tiles up.
// ─────────────────────────────────────────────────────────────────────────────

/** A stable, CSS-safe view-transition-name for a tile id (`canon:eth`,
 *  `8453:0xabc…`). Same id in, same name out — on both surfaces. */
export function vtName(id: string): string {
  return `vt-${id.replace(/[^a-zA-Z0-9-]/g, '-')}`
}

type DocWithVT = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => unknown
}

/** Run `update` inside a view transition where the platform + the user allow
 *  it; plainly otherwise. The update may be async (a lazy route resolving) —
 *  the browser holds the old frame until it settles. */
export function withViewTransition(update: () => void | Promise<void>): void {
  if (typeof document === 'undefined') {
    void update()
    return
  }
  let reduce = false
  try {
    reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    /* no matchMedia (tests): treat as no preference */
  }
  const doc = document as DocWithVT
  if (reduce || typeof doc.startViewTransition !== 'function') {
    void update()
    return
  }
  doc.startViewTransition(update)
}
