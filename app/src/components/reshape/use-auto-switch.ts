import { useEffect, useRef } from 'react'
import type { NetworkSwitch } from '../WrongNetwork'
import { autoSwitchVerdict } from './auto-switch'

// ── THE AUTO-SWITCH SHELL ─────────────────────────────────────────────────────
// The React half of auto-switch.ts (the owner 2026-08-13: "can we auto switch them
// to the next chain, save them a click to switch to eth/base etc") — the law
// lives there, this owns exactly two things: the fire-once memory and the call.
//
// Shared by both sequential ceremonies so there is ONE place where a ceremony
// asks a wallet to change networks by itself. The call is the app's own
// useNetworkSwitch (wagmi switchChain) — the same mutation the manual offer
// button uses, so a declined auto-call lands in exactly the state a declined
// click does, and the button's existing declined copy speaks for it.

/**
 * Ask the wallet — ONCE — for the active lane's chain.
 *
 * Fires only on the ceremony's own transitions: the memory is a ref, so asking
 * never causes a render, and a re-render never asks. Every refusal is decided
 * in autoSwitchVerdict; nothing about consent is decided here (the wallet still
 * shows its own prompt, and the sequencer still advances only on the OBSERVED
 * wallet chain).
 */
export function useLaneAutoSwitch({
  sw,
  shipping,
  demo,
  laneChainId,
  laneState,
  connected,
  walletChainId,
  signing,
}: {
  /** The ceremony's ONE switch mutation, re-targeted as the cursor moves. */
  sw: NetworkSwitch
  shipping: boolean
  demo: boolean
  laneChainId: number | null
  laneState: string | null
  connected: boolean
  walletChainId: number | undefined
  signing: boolean
}): void {
  // Law (a)'s memory: the chains this ceremony has already asked for. A ref,
  // never state — a request must not re-render the ceremony that made it.
  const asked = useRef<number[]>([])
  // switchNow/declined/switching arrive on a fresh object every render; held in
  // a ref they stay out of the effect's dependency list, so the effect runs on
  // the ceremony's transitions and nothing else. Declared FIRST so it is
  // refreshed before the asking effect reads it on the same commit.
  const swRef = useRef(sw)
  useEffect(() => {
    swRef.current = sw
  })

  useEffect(() => {
    if (laneChainId == null) return
    const verdict = autoSwitchVerdict({
      shipping,
      demo,
      laneChainId,
      laneState,
      connected,
      walletChainId: walletChainId ?? null,
      signing,
      switching: swRef.current.switching,
      declined: swRef.current.declined,
      asked: asked.current,
    })
    if (verdict !== 'ask') return
    // remember BEFORE calling: the mutation's own state change re-runs this
    // effect, and the memory is what makes that pass a no-op instead of a loop
    asked.current = [...asked.current, laneChainId]
    swRef.current.switchNow()
  }, [shipping, demo, laneChainId, laneState, connected, walletChainId, signing, sw.switching, sw.declined])
}
