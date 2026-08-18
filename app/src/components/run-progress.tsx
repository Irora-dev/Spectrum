// ─────────────────────────────────────────────────────────────────────────────
// RUN-PROGRESS PRIMITIVES — the moving light line and its keyframes, shared.
//
// Born inside the thesis run overlay (the owner 2026-08-15 0008: "a little
// like moving light line below each card… keep that and use it" — the reuse
// law: the real component, never a lookalike). Both products' run surfaces
// mount these — the portfolio flow's step cards, the direct-leg card, the
// portfolio page, and the thesis overlay itself — so they live here, in
// neutral chrome, rather than making every portfolio surface import the
// basket product's 1,900-line runner for a beam and a <style> tag (the
// split's T7 cycle). ThesisRunOverlay re-exports them, so its callers are
// unchanged. Hosts must mount <RunProgressStyles /> once.
// ─────────────────────────────────────────────────────────────────────────────

export function RunBeam({ accent }: { accent: string }) {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-x-3 bottom-0 h-[2px] overflow-hidden">
      <span className="trov-beam absolute inset-y-0 w-1/2" style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />
    </span>
  )
}

// self-contained keyframes (a host surface may not touch index.css)
export function RunProgressStyles() {
  return (
    <style>{`
@keyframes trov-beam { from { transform: translateX(-100%); } to { transform: translateX(200%); } }
.trov-beam { animation: trov-beam 2.4s ease-in-out infinite; }
@keyframes trov-shimmer { from { background-position: 200% 0; opacity: 1; } to { background-position: -60% 0; opacity: 0; } }
.trov-shimmer { animation: trov-shimmer 1.6s ease-out 1 forwards; }
@media (prefers-reduced-motion: reduce) {
  .trov-beam, .trov-shimmer { animation: none; display: none; }
}
`}</style>
  )
}
