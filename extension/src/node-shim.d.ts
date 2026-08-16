// Ambient node-module shims (the theme-parity test reads CSS off disk; the
// icon script is plain node). Mirrors the app's posture: no @types/node, so
// auto-included node globals never shift the typecheck — declare exactly the
// node surface used. Runtime is real node regardless.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string
}
declare module 'node:path' {
  export function resolve(...parts: string[]): string
  export function dirname(path: string): string
}
declare module 'node:url' {
  export function fileURLToPath(url: string): string
}
