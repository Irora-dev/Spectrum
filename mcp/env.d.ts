// The app source types `import.meta.env` via vite/client; this build runs the
// SAME source node-side (esbuild `define` replaces every occurrence at build,
// per mcp/build.mjs), so the checker just needs the shape declared. Values
// resolve to process.env.VITE_* — strings or undefined, exactly as declared.
interface ImportMetaEnv {
  readonly [key: string]: string | undefined
}
interface ImportMeta {
  readonly env: ImportMetaEnv & { readonly DEV: boolean; readonly PROD: boolean; readonly MODE: string }
  readonly glob: (pattern: string, opts?: Record<string, unknown>) => Record<string, unknown>
}

// The server touches exactly this much of node; the kit ships no @types/node
// (it is a browser app), so the touched surface is declared here instead of
// adding a types dependency for three names.
declare const process: {
  stdin: unknown
  stdout: { write(chunk: string): boolean }
  stderr: { write(chunk: string): boolean }
  env: Record<string, string | undefined>
  on(event: 'unhandledRejection', cb: (reason: unknown) => void): void
  on(event: 'uncaughtException', cb: (err: unknown) => void): void
}
declare module 'node:readline' {
  export function createInterface(opts: { input: unknown; terminal?: boolean }): {
    on(event: 'line', cb: (line: string) => void): void
  }
}
// The registry digest touches exactly this much of node:crypto (same reasoning
// as the process declaration above — no @types/node for two names).
declare module 'node:crypto' {
  export function createHash(algorithm: 'sha256'): {
    update(data: string): { digest(encoding: 'hex'): string }
  }
}

// The session journal touches exactly this much of node:fs (append-only,
// fail-open) — same no-@types/node reasoning as the declarations above.
declare module 'node:fs' {
  export function appendFileSync(path: string, data: string): void
}

declare module 'viem/accounts' {
  export function privateKeyToAccount(key: `0x${string}`): import('viem').Account
}

// tags.ts imports a YAML banlist via Vite's ?raw (a build-time string); it is
// dragged into the graph transitively but the compose path never calls it.
// Declare the module so the checker sees a string, matching the build define.
declare module '*.yml?raw' {
  const content: string
  export default content
}
