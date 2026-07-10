// Ambient node-module shims for vite.config.ts ONLY (tsconfig.node.json includes this
// file). The app deliberately ships without @types/node — node_modules is shared with the
// operator repo, and auto-included node globals would silently change its typecheck — so
// declare the exact node surface the config uses. Runtime is real node regardless.
declare module 'node:fs' {
  export function writeFileSync(path: string, data: string): void
  export function readFileSync(path: string, encoding: string): string
  export function existsSync(path: string): boolean
}
declare module 'node:path' {
  export function resolve(...parts: string[]): string
  export function dirname(path: string): string
}
declare module 'node:url' {
  export function fileURLToPath(url: string): string
}
// Minimal process global for reading real env vars at config time (CI dashboards
// inject them as process env), and import.meta.url for path resolution (the node
// tsconfig has no DOM/node libs to provide either).
declare const process: { env: Record<string, string | undefined> }
interface ImportMeta {
  url: string
}
