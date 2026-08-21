import { describe, expect, it } from 'vitest'

// ── THE CHAT-KIT DRIFT GUARD (2026-08-21) ────────────────────────────────────
// The handoff manifest (scripts/chat-kit/manifest.json) is a shopping list a
// CONSUMER resyncs verbatim — a vendored file importing a chat-local module
// the manifest never ships produces a broken consumer tree. Measured drift the
// night this test was written: FOUR cards (Redeem/Thesis/Profile/AssetPicker)
// were imported by the vendored shell and absent from the list. The guard is
// closure: every `components/chat/*` import reachable from a listed file must
// itself be listed. Add a card → add its manifest row, same commit.

const MANIFEST_RAW = import.meta.glob(['/scripts/chat-kit/manifest.json'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const SHELL_RAW = import.meta.glob(['/src/pages/Chat.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const CHAT_RAW = import.meta.glob(['/src/components/chat/*.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

function one<T>(rec: Record<string, T>, label: string): T {
  const vals = Object.values(rec)
  if (vals.length !== 1) throw new Error(`${label}: expected exactly one glob hit, got ${vals.length}`)
  return vals[0]
}

describe('chat-kit manifest — vendored closure', () => {
  const manifest = JSON.parse(one(MANIFEST_RAW, 'manifest')) as Record<string, unknown>
  const listed = new Set(
    (['shell', 'brain', 'cards', 'mascot', 'docs', 'driver'] as const).flatMap((g) => (Array.isArray(manifest[g]) ? (manifest[g] as string[]) : [])),
  )

  /** chat-local imports of a source file, as manifest-relative paths */
  function chatImportsOf(src: string, selfIsChatLocal: boolean): string[] {
    const names = new Set<string>()
    for (const m of src.matchAll(/from\s+'(?:\.\.?\/)*components\/chat\/([A-Za-z][A-Za-z0-9]*)'/g)) names.add(m[1])
    if (selfIsChatLocal) for (const m of src.matchAll(/from\s+'\.\/([A-Za-z][A-Za-z0-9]*)'/g)) names.add(m[1])
    return [...names]
  }
  const asListedPath = (name: string): string | null => {
    for (const ext of ['tsx', 'ts']) {
      const p = `src/components/chat/${name}.${ext}`
      if (listed.has(p)) return p
      if (`/${p}` in CHAT_RAW && listed.has(p)) return p
    }
    return null
  }
  const existsOnDisk = (name: string): boolean => [`/src/components/chat/${name}.tsx`, `/src/components/chat/${name}.ts`].some((p) => p in CHAT_RAW)

  it('every chat-local import reachable from a vendored file is itself vendored', () => {
    const ghosts: string[] = []
    const sources: [string, string, boolean][] = [['src/pages/Chat.tsx', one(SHELL_RAW, 'shell'), false]]
    for (const [path, raw] of Object.entries(CHAT_RAW)) {
      const rel = path.slice(1)
      if (listed.has(rel)) sources.push([rel, raw, true])
    }
    for (const [from, raw, selfLocal] of sources) {
      for (const name of chatImportsOf(raw, selfLocal)) {
        if (!existsOnDisk(name)) continue // a type-only or re-export alias, not a file
        if (!asListedPath(name)) ghosts.push(`${from} imports ${name} — add src/components/chat/${name}.tsx to the manifest`)
      }
    }
    expect(ghosts, ghosts.join('\n')).toEqual([])
  })

  it('the both-boxes contract: the widget files are vendored beside the page shell', () => {
    expect(listed.has('src/components/chat/SpecterWidget.tsx'), 'SpecterWidget.tsx missing from the manifest shell').toBe(true)
    expect(listed.has('src/components/chat/WidgetChat.tsx'), 'WidgetChat.tsx missing from the manifest shell').toBe(true)
  })

  it('every listed chat-local file actually exists', () => {
    const missing = [...listed].filter((p) => p.startsWith('src/components/chat/') && p.endsWith('.tsx') && !(`/${p}` in CHAT_RAW) && !p.endsWith('.md'))
    expect(missing, missing.join(', ')).toEqual([])
  })
})
