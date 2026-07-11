import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import brand from '../brand.config'
import siteConfig from '../site.config.json'
import { KIT_VERSION, KIT_UPDATE_MANIFEST_URL } from '../kit-version'
import type { BrandConfig, DesignStyle, PageKey } from '../theme/brand'
import { PAGE_KEYS, validateSiteName } from '../theme/brand'
import { applyBrand } from '../theme/theme'
import { GRADIENT_CATALOG } from '../theme/catalog'
import { brandConfigToTs } from '../theme/export-brand'
import type { DeployConfig, DeployIssues } from '../theme/export-env'
import { DEFAULT_DEPLOY, envConfigToText, FEE_TIERS, hasDeployErrors, pageTierWarnings, siteConfigToJson, TIER_DETAILS, TIER_LABELS, validateDeploy } from '../theme/export-env'
import {
  clearDeployDraft, clearDraft, loadDeployDraft, loadDraft, saveDeployDraft, saveDraft,
} from '../theme/setup-draft'

// Sentinel that carries the "applied ✓" state across the page reload a successful
// apply causes (vite restarts when brand.config.ts / .env.local change on disk).
const APPLIED_FLAG = 'setup-applied:v1'

// In-studio "kit update available" notice — OPERATOR-ONLY (owner 2026-07-09): shown when
// the connected wallet IS the site's fee wallet (the operator's public identity in the
// committed config), or on any dev build (the operator's own machine). Relevance gating,
// not security — everything involved is public; visitors just never see operator chrome.
// Dormant until KIT_UPDATE_MANIFEST_URL is set (the public repo home).
function useKitUpdate(isOperator: boolean): { version: string; note?: string } | null {
  const [latest, setLatest] = useState<{ version: string; note?: string } | null>(null)
  useEffect(() => {
    if (!KIT_UPDATE_MANIFEST_URL || !isOperator) return
    if (sessionStorage.getItem('kit-update-dismissed') === KIT_VERSION) return
    let stale = false
    fetch(KIT_UPDATE_MANIFEST_URL, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((m: { version?: string; note?: string } | null) => {
        if (!stale && m?.version && m.version !== KIT_VERSION) setLatest({ version: m.version, note: m.note })
      })
      .catch(() => {
        /* offline / blocked — the notice is best-effort only */
      })
    return () => {
      stale = true
    }
  }, [isOperator])
  return latest
}

// ⓘ disclosure (the /docs InfoDot pattern) — detail lives behind the dot, the label
// stays one line. Opens on hover and on click/tap for touch + keyboard.
function InfoDot({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <span
      className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label="What this means"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`press grid h-5 w-5 place-items-center rounded-full border font-mono text-[11px] font-bold transition-colors ${
          open ? 'border-cyan/60 bg-cyan/15 text-cyan' : 'border-white/25 bg-white/[0.07] text-ink-dim hover:border-cyan/50 hover:text-cyan'
        }`}
      >
        i
      </button>
      {open && (
        <span className="absolute left-1/2 top-6 z-30 w-[min(24rem,80vw)] -translate-x-1/2 rounded-xl border border-white/[0.2] bg-panel-2 p-4 pt-3 text-left text-[13px] font-normal normal-case leading-relaxed tracking-normal text-ink-dim shadow-[0_20px_60px_-20px_rgba(0,0,0,0.9)]">
          {children}
        </span>
      )}
    </span>
  )
}

const STYLES: { id: DesignStyle; blurb: string }[] = [
  { id: 'spectral', blurb: 'The reference look' },
  { id: 'aurora', blurb: 'Indigo, soft, violet accent' },
  { id: 'prism', blurb: 'Pure-black, crisp, cyan' },
  { id: 'umbra', blurb: 'Solid near-black fintech' },
  { id: 'sylvan', blurb: 'Organic green / lime' },
]
const PAGE_LABELS: Record<PageKey, string> = {
  discover: 'Discover / Explore', launch: 'Launch + Composer', trade: 'Swap (buy / sell)',
  fees: 'Flush (fee console)', portfolio: 'Portfolio', creators: 'Creators',
  refer: 'Refer & earn', integrate: 'Integrate', docs: 'Docs / FAQ / Learn',
}

// Live design studio: the operator customizes the site's look + pages ON the site and
// sees it re-skin instantly (applyBrand over the CSS-var tokens), then Confirm exports the
// three files a deploy needs — brand.config.ts (look) + site.config.json (tier/site URL/fee wallet, committed) + .env.local (RPC key).
// The draft is a per-browser preview (localStorage); real visitors always see the committed
// brand.config.ts. Deploy config never touches the live look, so it isn't applied — just exported.
export function Setup() {
  const [draft, setDraft] = useState<BrandConfig>(() => loadDraft() ?? structuredClone(brand))
  const [deploy, setDeploy] = useState<DeployConfig>(() => loadDeployDraft() ?? structuredClone(DEFAULT_DEPLOY))
  const [copied, setCopied] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [resetArmed, setResetArmed] = useState(false)
  // A successful apply makes vite restart (it watches the written config files), which
  // reloads this page — POSSIBLY MORE THAN ONCE (three files land; each restart reconnects
  // and re-reloads). So the success flag is NOT consumed on mount: it stays in
  // sessionStorage until the user dismisses the popup or edits again, keeping the popup
  // open across however many refreshes the restart causes (owner 2026-07-09).
  const [applied, setApplied] = useState<'idle' | 'busy' | 'done' | 'error'>(() =>
    sessionStorage.getItem(APPLIED_FLAG) ? 'done' : 'idle',
  )
  const dismissApplied = () => {
    sessionStorage.removeItem(APPLIED_FLAG)
    setApplied('idle')
  }
  const [applyError, setApplyError] = useState('')
  const nameCheck = validateSiteName(draft.name)
  // Operator identity = connected wallet matches the committed fee wallet; dev builds
  // always count (the operator's own machine).
  const { address: connected } = useAccount()
  const committedFeeWallet = ((siteConfig as { feeWallet?: string }).feeWallet ?? '').toLowerCase()
  const isOperator =
    import.meta.env.DEV || (!!committedFeeWallet && connected?.toLowerCase() === committedFeeWallet)
  const kitUpdate = useKitUpdate(isOperator)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  // Dev server only: the setup-apply middleware (vite.config.ts) can write the config files
  // straight into the checkout. A deployed static site has no such endpoint — download/copy.
  const canWriteBack = import.meta.env.DEV
  // The two draft effects also run on mount; without the first-run guards they would
  // instantly clear the reload-surviving 'done' state above.
  const firstDraftRun = useRef(true)
  const firstDeployRun = useRef(true)

  useEffect(() => {
    applyBrand(draft)
    saveDraft(draft)
    if (firstDraftRun.current) {
      firstDraftRun.current = false
      return
    }
    setConfirmed(false) // any edit invalidates the just-downloaded/applied files
    dismissApplied()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])
  useEffect(() => {
    saveDeployDraft(deploy)
    if (firstDeployRun.current) {
      firstDeployRun.current = false
      return
    }
    setConfirmed(false)
    dismissApplied()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploy])

  const setPalette = (patch: Partial<BrandConfig['palette']>) =>
    setDraft((d) => ({ ...d, palette: { ...d.palette, ...patch } }))
  const pageOn = (k: PageKey) => draft.pages?.[k] !== false
  const togglePage = (k: PageKey) =>
    setDraft((d) => ({ ...d, pages: { ...d.pages, [k]: !(d.pages?.[k] !== false) } }))
  const gradientSelected = (g: (typeof GRADIENT_CATALOG)[number]) =>
    draft.palette.gradientFrom === g.from && draft.palette.gradientVia === g.via && draft.palette.gradientTo === g.to
  const setDeployField = <K extends keyof DeployConfig>(k: K, v: DeployConfig[K]) =>
    setDeploy((d) => ({ ...d, [k]: v }))

  const tsText = useMemo(() => brandConfigToTs(draft), [draft])
  const envText = useMemo(() => envConfigToText(deploy), [deploy])
  const siteJsonText = useMemo(() => siteConfigToJson(deploy), [deploy])
  const { errors, warnings } = useMemo(() => validateDeploy(deploy), [deploy])
  const pageWarnings = useMemo(() => pageTierWarnings(deploy, draft.pages), [deploy, draft.pages])

  const downloadText = (text: string, filename: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
  // Confirm hands over the three files a deploy reads. The staggering keeps browsers from
  // coalescing the two into one download (some suppress a same-tick second click).
  const confirmDownload = () => {
    downloadText(tsText, 'brand.config.ts')
    setTimeout(() => downloadText(siteJsonText, 'site.config.json'), 250)
    setTimeout(() => downloadText(envText, '.env.local'), 500)
    setConfirmed(true)
  }
  const copyText = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tag)
      setTimeout(() => setCopied(''), 1500)
    } catch { /* clipboard blocked — the download still works */ }
  }
  // Dev write-back: hand both generated files to the dev server, which writes them into
  // the project (src/brand.config.ts + .env.local) — the no-download onboarding path.
  const applyToProject = async () => {
    setApplied('busy')
    try {
      const r = await fetch('/__setup/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Setup-Apply': '1' },
        body: JSON.stringify({ brandConfig: tsText, envLocal: envText, siteConfig: siteJsonText }),
      })
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`)
      sessionStorage.setItem(APPLIED_FLAG, '1') // vite restarts + reloads the page; see useState above
      setApplied('done')
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e))
      setApplied('error')
    }
  }
  const reset = () => {
    clearDraft()
    clearDeployDraft()
    const base = structuredClone(brand)
    setDraft(base)
    setDeploy(structuredClone(DEFAULT_DEPLOY))
    applyBrand(base)
    setConfirmed(false)
  }
  // Two-click guard: Reset wipes every draft edit, so the first click only arms it
  // (auto-disarms after 3s) and the second actually reverts to the committed config.
  const onReset = () => {
    if (!resetArmed) {
      setResetArmed(true)
      setTimeout(() => setResetArmed(false), 3000)
      return
    }
    reset()
    setResetArmed(false)
  }

  const label = 'font-mono text-xs uppercase tracking-[0.2em] text-ink-faint'
  const sectionTitle = 'font-display text-xl font-semibold uppercase tracking-wide text-ink'
  const input = 'w-full rounded-lg border border-line bg-panel px-3 py-2 text-ink outline-none focus:border-cyan'
  const chip = (on: boolean) =>
    `press rounded-full border px-3 py-1.5 text-sm transition-colors ${on ? 'border-cyan bg-cyan/10 text-cyan' : 'border-line text-ink-dim hover:border-line-bright'}`
  const addrInput = (field: keyof DeployIssues) => (errors[field] ? input.replace('border-line', 'border-magenta') : input)
  const fieldMsg = (field: keyof DeployIssues) => {
    if (errors[field]) return <p className="text-xs text-magenta">{errors[field]}</p>
    if (warnings[field]) return <p className="text-xs text-amber">{warnings[field]}</p>
    return null
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-8">
        <p className="font-mono text-sm uppercase tracking-[0.25em] text-ink-dim">Set up your site</p>
        <h1 className="spectrum-wordmark mt-1 font-display text-5xl font-bold uppercase">Customize</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-dim">
          Pick your look, pages, and deployment. The site re-skins live.
          {canWriteBack ? (
            <> When it's right, <b className="text-ink">Apply</b> writes your config into the project.</>
          ) : (
            <> When it's right, <b className="text-ink">Confirm</b> downloads the config files a deploy needs.</>
          )} This preview is only in your browser.
        </p>
      </header>

      {kitUpdate && !updateDismissed && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-cyan/40 bg-cyan/[0.07] p-4">
          <p className="text-sm text-ink-dim">
            <b className="text-ink">Kit update available</b> — {KIT_VERSION} → {kitUpdate.version}
            {kitUpdate.note ? <>: {kitUpdate.note}</> : null}. Ask your AI agent to{' '}
            <b className="text-ink">"update my site"</b>, or pull upstream per START-HERE.
          </p>
          <button
            type="button"
            onClick={() => {
              sessionStorage.setItem('kit-update-dismissed', KIT_VERSION)
              setUpdateDismissed(true)
            }}
            className="press ml-auto rounded-full border border-line px-3 py-1.5 text-xs text-ink-faint hover:text-ink-dim"
          >
            Dismiss
          </button>
        </div>
      )}

      <section className="space-y-6 rounded-3xl border border-line card-surface p-6">
        {/* Identity */}
        <div className="space-y-3">
          <label className={label}>Site name (text wordmark)</label>
          <input className={input} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Your site name" />
          {!nameCheck.ok && <p className="text-xs text-magenta">{nameCheck.error}</p>}
          <label className={label}>Tagline (optional)</label>
          <input className={input} value={draft.tagline ?? ''} onChange={(e) => setDraft((d) => ({ ...d, tagline: e.target.value || undefined }))} placeholder="onchain baskets" />
        </div>

        {/* Design style */}
        <div className="space-y-2">
          <p className={label}>Design style</p>
          <div className="flex flex-wrap gap-2">
            {STYLES.map((s) => (
              <button key={s.id} type="button" aria-pressed={draft.style === s.id} title={s.blurb} className={chip(draft.style === s.id)} onClick={() => setDraft((d) => ({ ...d, style: s.id }))}>
                {s.id}
              </button>
            ))}
          </div>
        </div>

        {/* Gradient */}
        <div className="space-y-2">
          <p className={label}>Color scheme (gradient)</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {GRADIENT_CATALOG.map((g) => (
              <button
                key={g.id}
                type="button"
                aria-pressed={gradientSelected(g)}
                aria-label={`Gradient ${g.label}`}
                onClick={() => setPalette({ gradientFrom: g.from, gradientVia: g.via, gradientTo: g.to })}
                className={`press flex items-center gap-2 rounded-lg border p-2 text-left transition-colors ${gradientSelected(g) ? 'border-cyan' : 'border-line hover:border-line-bright'}`}
              >
                <span aria-hidden className="h-5 w-8 shrink-0 rounded" style={{ background: `linear-gradient(90deg, ${g.from}, ${g.via}, ${g.to})` }} />
                <span className="text-xs text-ink-dim">{g.label}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <span className={label}>Custom</span>
            {(['gradientFrom', 'gradientVia', 'gradientTo'] as const).map((k) => (
              <input key={k} type="color" aria-label={k} value={draft.palette[k]} onChange={(e) => setPalette({ [k]: e.target.value })} className="h-8 w-10 cursor-pointer rounded border border-line bg-transparent" />
            ))}
            <span className={label}>Accent</span>
            <input type="color" aria-label="accent" value={draft.palette.accent ?? draft.palette.gradientTo} onChange={(e) => setPalette({ accent: e.target.value })} className="h-8 w-10 cursor-pointer rounded border border-line bg-transparent" />
          </div>
        </div>

        {/* Pages — its own panel inside the card */}
        <div className="space-y-3 rounded-2xl border border-line bg-void/40 p-4">
          <p className={sectionTitle}>Pages to ship</p>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {PAGE_KEYS.map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-2 text-sm text-ink-dim">
                <input type="checkbox" checked={pageOn(k)} onChange={() => togglePage(k)} className="accent-cyan" />
                {PAGE_LABELS[k]}
              </label>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-5 space-y-6 rounded-3xl border border-line card-surface p-6">
        <div className="space-y-1">
          <p className={sectionTitle}>Deployment</p>
          <p className="flex items-center gap-2 text-sm text-ink-dim">
            Choose a tier that sets what a connected visitor can do.
            <InfoDot>
              Every tier connects a wallet (Rabby, MetaMask, Coinbase). The default ships the full site on
              the canonical Spectrum contracts, live on Base, Ethereum and Robinhood Chain. Your fee wallet has no default,
              and the kit runs with no database.
            </InfoDot>
          </p>
        </div>

        {/* Feature tier */}
        <div className="space-y-2">
          <p className={label}>Feature tier</p>
          <div className="space-y-1.5">
            {FEE_TIERS.map((t) => {
              const on = deploy.tier === t
              return (
                <div key={t} className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => setDeployField('tier', t)}
                    className={`press flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${on ? 'border-cyan bg-cyan/10' : 'border-line hover:border-line-bright'}`}
                  >
                    <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${on ? 'border-cyan' : 'border-line'}`}>
                      {on && <span className="h-2 w-2 rounded-full bg-cyan" />}
                    </span>
                    <span className="text-[15px] text-ink-dim">{TIER_LABELS[t]}</span>
                  </button>
                  <InfoDot>{TIER_DETAILS[t]}</InfoDot>
                </div>
              )
            })}
          </div>
          {pageWarnings.length > 0 && (
            <div className="space-y-0.5 pt-1">
              {pageWarnings.map((w) => (
                <p key={w.page} className="text-xs text-amber">{w.message}</p>
              ))}
            </div>
          )}
        </div>

        {/* The operator's own values — everything else is the shipped canonical deployment */}
        <div className="space-y-3">
          {/* Fee wallet gets the gradient-highlight treatment (owner 2026-07-09: make it very
              obvious they'd want to set this up). Border rides the live brand gradient vars, so
              it retints with the studio's gradient picking; inner radius tracks the style scale. */}
          <div
            className="rounded-2xl p-px"
            style={{ backgroundImage: 'linear-gradient(135deg, var(--color-amber), var(--color-magenta), var(--color-cyan))' }}
          >
            <div className="space-y-1 rounded-[calc(var(--radius-2xl)_-_1px)] bg-panel p-4">
              <span className="flex items-center gap-2">
                <label className="font-display text-base font-semibold uppercase tracking-wide text-ink">Your fee wallet, earn from your site</label>
                <InfoDot>
                  Your own wallet. When set, your site tags it on the activity it originates and the
                  Spectrum contracts route it the fixed interface and launcher shares, roughly 5% of the
                  protocol fee each. That is a redirected slice of the protocol fee, at no extra cost to
                  your visitors. Leave it blank and that share simply is not taken. No default wallet
                  ever ships here.
                </InfoDot>
              </span>
              <p className="text-xs text-ink-dim">
                Launches and trades your site carries pay a share of the protocol fee to this address. Optional,
                but this is how running a site earns.
              </p>
              <input className={addrInput('feeWallet')} aria-invalid={!!errors.feeWallet} value={deploy.feeWallet} onChange={(e) => setDeployField('feeWallet', e.target.value)} placeholder="0x… receives the interface + launcher shares" />
              {fieldMsg('feeWallet')}
            </div>
          </div>
          <div className="space-y-1">
            <label className={label}>RPC key</label>
            <input className={addrInput('rpcKey')} aria-invalid={!!errors.rpcKey} value={deploy.rpcKey} onChange={(e) => setDeployField('rpcKey', e.target.value)} placeholder="your provider key (Alchemy, Infura, any)" />
            <p className="text-xs text-ink-faint">
              Ships in the public bundle. Use your own key, restricted to your site's domain, never a secret.
            </p>
            {fieldMsg('rpcKey')}
          </div>
          <div className="space-y-1">
            <label className={label}>Site URL</label>
            <input className={addrInput('siteUrl')} aria-invalid={!!errors.siteUrl} value={deploy.siteUrl} onChange={(e) => setDeployField('siteUrl', e.target.value)} placeholder="https://your-site.xyz" />
            {fieldMsg('siteUrl')}
          </div>
        </div>
      </section>

      {/* Actions */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {canWriteBack && (
          <button type="button" disabled={!nameCheck.ok || hasDeployErrors(errors) || applied === 'busy'} onClick={applyToProject} className="press rounded-full bg-cyan px-5 py-2.5 font-semibold text-void disabled:opacity-40">
            {applied === 'busy' ? 'Applying…' : 'Apply to this project'}
          </button>
        )}
        <button
          type="button"
          disabled={!nameCheck.ok || hasDeployErrors(errors)}
          onClick={confirmDownload}
          className={
            canWriteBack
              ? 'press rounded-full border border-line px-4 py-2.5 text-ink-dim hover:border-line-bright disabled:opacity-40'
              : 'press rounded-full bg-cyan px-5 py-2.5 font-semibold text-void disabled:opacity-40'
          }
        >
          {canWriteBack ? 'or download the files' : 'Confirm and download brand.config.ts + .env.local'}
        </button>
        <button type="button" onClick={onReset} className={`press rounded-full border px-4 py-2.5 ${resetArmed ? 'border-amber text-amber' : 'border-line text-ink-faint hover:text-ink-dim'}`}>
          {resetArmed ? 'Click again to reset' : 'Reset to committed'}
        </button>
      </div>

      {(!nameCheck.ok || hasDeployErrors(errors)) && (
        <p className="mt-2 text-xs text-ink-faint">Fix the highlighted fields above to enable {canWriteBack ? 'apply' : 'download'}.</p>
      )}

      {applied === 'done' && (
        // The baton-pass popup: the click's job is done here; the terminal
        // continues the setup. Survives the post-apply reload via the sessionStorage flag.
        <div className="fixed inset-0 z-50 grid place-items-center bg-void/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Setup applied">
          <div className="w-full max-w-md rounded-3xl border border-teal/40 card-surface p-6 shadow-[0_30px_90px_-30px_rgba(0,0,0,0.9)]">
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-teal">✓ Applied, your site is running this setup</p>
            <h2 className="mt-2 font-display text-2xl font-bold uppercase">Great, now head back to your terminal</h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-dim">
              Your AI agent continues from there: it validates the config, builds the site, and walks you
              through putting it online. If it asks, say <b className="text-ink">done</b>.
            </p>
            <p className="mt-2 text-xs text-ink-faint">
              No agent? Run <code className="text-cyan">npm run build</code>, then deploy <code className="text-cyan">app/dist/</code>.
              You can keep customizing here and apply again any time.
            </p>
            <div className="mt-5">
              <button type="button" onClick={dismissApplied} className="press rounded-full border border-line px-4 py-2 text-sm text-ink-dim hover:border-line-bright">
                Keep customizing
              </button>
            </div>
          </div>
        </div>
      )}
      {applied === 'error' && (
        <p className="mt-2 text-xs text-amber">
          Apply failed ({applyError}). The dev server may have restarted; use "download the files" instead, or reload.
        </p>
      )}

      {confirmed && (
        <div className="mt-4 rounded-2xl border border-teal/30 bg-teal/[0.06] p-4">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-teal">✓ Downloaded. Last steps:</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-dim">
            <li>Put <code className="text-cyan">brand.config.ts</code> and <code className="text-cyan">site.config.json</code> in <code className="text-cyan">app/src/</code>.</li>
            <li>Put <code className="text-cyan">.env.local</code> in <code className="text-cyan">app/</code> (rename it if your browser dropped the leading dot).</li>
            <li>Run <code className="text-cyan">npm run build</code>, then deploy <code className="text-cyan">app/dist/</code> to any static host.</li>
          </ol>
          <p className="mt-2 text-xs text-ink-faint">
            Creator profiles and theses ship in your build from <code className="text-cyan">app/metadata/</code>, no database or server needed.
            Your tab title, social cards and sitemap auto-brand from this config at build; for polish, swap
            <code className="text-cyan"> app/public/og.png</code> + the icons for your own artwork.
          </p>
        </div>
      )}

      <details className="mt-5 rounded-2xl border border-line bg-panel/60 p-4">
        <summary className="cursor-pointer font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">Preview brand.config.ts</summary>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-void/60 p-3 text-xs leading-relaxed text-ink-dim">{tsText}</pre>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => copyText(tsText, 'ts')} className="press rounded-full border border-line px-3 py-1.5 text-xs text-ink-dim hover:border-line-bright">
            {copied === 'ts' ? 'Copied ✓' : 'Copy'}
          </button>
          <p className="text-xs text-ink-faint">
            Save as <code className="text-cyan">app/src/brand.config.ts</code>.
          </p>
        </div>
      </details>

      <details className="mt-3 rounded-2xl border border-line bg-panel/60 p-4">
        <summary className="cursor-pointer font-mono text-xs uppercase tracking-[0.15em] text-ink-faint">Preview .env.local</summary>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-void/60 p-3 text-xs leading-relaxed text-ink-dim">{envText}</pre>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => copyText(envText, 'env')} className="press rounded-full border border-line px-3 py-1.5 text-xs text-ink-dim hover:border-line-bright">
            {copied === 'env' ? 'Copied ✓' : 'Copy'}
          </button>
          <p className="text-xs text-ink-faint">
            Save as <code className="text-cyan">app/.env.local</code> (a leading-dot file, so your browser may save it as <code className="text-cyan">env.local</code>; rename it).
          </p>
        </div>
      </details>
    </div>
  )
}
