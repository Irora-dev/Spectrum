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
  // First visit: the operator's brand default (e.g. Robinhood Chain on a
  // stocks-forward site — owner 2026-07-29) when it's a scaffolded chain;
  // a returning visitor's own stored choice above always wins.
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
