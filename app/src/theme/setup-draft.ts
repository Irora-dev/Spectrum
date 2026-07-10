import type { BrandConfig } from './brand'
import type { DeployConfig } from './export-env'

// The setup studio's draft lives in localStorage so the operator's in-browser preview
// survives navigation + reload — per-browser only, so real visitors always see the
// committed brand.config.ts, never a draft. Applied on boot (main.tsx) when present.
const KEY = 'spectrum-mini:setup-draft:v1'
// The deploy config (tier + operator values) is a separate key: it never affects the live
// look, so it isn't applied on boot — it just persists what the operator typed for the .env
// export. v2: the 2026-07-09 rework (all-features default tier; factory/router/WalletConnect
// fields removed) — old v1 drafts carry the removed shape + 'info' default, so they're
// deliberately orphaned rather than migrated.
const DEPLOY_KEY = 'spectrum-mini:deploy-draft:v2'

export function loadDraft(): BrandConfig | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as BrandConfig) : null
  } catch {
    return null
  }
}

export function saveDraft(brand: BrandConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(brand))
  } catch {
    /* storage unavailable — the live in-page apply still works for this session */
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

export function loadDeployDraft(): DeployConfig | null {
  try {
    const raw = localStorage.getItem(DEPLOY_KEY)
    return raw ? (JSON.parse(raw) as DeployConfig) : null
  } catch {
    return null
  }
}

export function saveDeployDraft(deploy: DeployConfig): void {
  try {
    localStorage.setItem(DEPLOY_KEY, JSON.stringify(deploy))
  } catch {
    /* storage unavailable — the export still works for this session */
  }
}

export function clearDeployDraft(): void {
  try {
    localStorage.removeItem(DEPLOY_KEY)
  } catch {
    /* ignore */
  }
}
