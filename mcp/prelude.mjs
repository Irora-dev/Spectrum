// Injected FIRST into the bundle (esbuild `inject`) so the Vite/browser globals
// the app modules touch at import time exist before any of them evaluate. The
// server file's own boot block would run too late — module init order follows
// the import graph, and the app modules are imported before main() runs.
const g = globalThis
if (!g.localStorage) {
  const mem = new Map()
  g.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size },
  }
  g.sessionStorage = g.localStorage
}
g.__viteGlob = () => ({})
g.__viteEnv = new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? process.env[k] : undefined) })
