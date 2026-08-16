import { useSyncExternalStore } from 'react'
import { chainCfg, DEFAULT_CHAIN_ID, SUPPORTED_CHAIN_IDS } from './chains'
import brand from '../../brand.config'

// App-level "viewing network" for the Base⇄Eth toggle. Independent of the wallet's
// connected chain (read views work with no wallet); the UI can sync the wallet via
// wagmi's useSwitchChain when it changes. Provider-less module store + localStorage.

const STORAGE_KEY = 'spectrum.activeChainId'
const ids = SUPPORTED_CHAIN_IDS as readonly number[]

function readInitial(): number {
  if (typeof localStorage !== 'undefined') {
    const v = Number(localStorage.getItem(STORAGE_KEY))
    if (ids.includes(v)) return v
  }
  // First visit: the operator's chosen opening network, when it is a scaffolded
  // chain; a returning visitor's own stored choice above always wins.
  //
  // TWO SOURCES, ENV FIRST (2026-08-06). `brand.config.ts` is merged into the
  // kit release line, so a hardcoded default there travelled with every
  // absorption — the test line's Robinhood 4663 kept landing in a kit that
  // ships Base-first, and UIGuy had to catch and hand-revert it. Reading the
  // env here keeps that file identical on both lines and puts the divergence
  // where per-deploy divergence belongs. Absent or unparseable falls through to
  // the brand file and then to Base, so the safe value is also the default.
  const fromEnv = Number(String(import.meta.env.VITE_DEFAULT_CHAIN_ID ?? '').trim())
  if (Number.isInteger(fromEnv) && ids.includes(fromEnv)) return fromEnv
  // still honoured for an operator who genuinely sets it in their brand file
  const branded = Number(brand.defaultChainId)
  if (ids.includes(branded)) return branded
  return DEFAULT_CHAIN_ID
}

let current = readInitial()
const listeners = new Set<() => void>()

export function setActiveChainId(chainId: number): void {
  if (!ids.includes(chainId) || chainId === current) return
  current = chainId
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, String(chainId))
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useActiveChainId(): number {
  return useSyncExternalStore(subscribe, () => current, () => DEFAULT_CHAIN_ID)
}

// Convenience: active chain id + its config + setter + the supported list (for the toggle).
export function useActiveChain() {
  const chainId = useActiveChainId()
  return {
    chainId,
    cfg: chainCfg(chainId),
    setChainId: setActiveChainId,
    supported: SUPPORTED_CHAIN_IDS,
  }
}
