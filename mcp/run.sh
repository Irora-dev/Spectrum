#!/bin/sh
# Run the Spectrum MCP server (build first: node mcp/build.mjs).
# dist/server.mjs is fully self-contained; node is the only requirement.
#
# `mcp/run.sh --check` verifies the install instead of serving: node version,
# a fresh build, then a real JSON-RPC initialize and a live spectrum_health
# call over stdio. Prints PASS/FAIL lines and exits 0 only when all pass.
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" != "--check" ]; then
  exec node "$DIR/dist/server.mjs"
fi

# ── install self-check ───────────────────────────────────────────────────────
echo "spectrum-mcp install check"

# 1) node present and >= 20 (the kit's engines floor: app/package.json)
if ! command -v node >/dev/null 2>&1; then
  echo "FAIL node: not found on PATH (this kit needs Node 20+)"
  exit 1
fi
NODE_V="$(node --version)"
if node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "PASS node: $NODE_V (>= 20 required)"
else
  echo "FAIL node: $NODE_V is below the kit's floor of 20; install a current Node"
  exit 1
fi

# 2) the bundle builds (esbuild ships with the app; requires npm install in app/)
if BUILD_OUT="$(node "$DIR/build.mjs" 2>&1)"; then
  echo "PASS build: dist/server.mjs rebuilt"
else
  echo "FAIL build: node mcp/build.mjs failed (run 'npm install' in app/ first; esbuild ships with the app)"
  printf '%s\n' "$BUILD_OUT"
  exit 1
fi

# 3+4) start the real server, speak the real protocol: initialize, then a live
# spectrum_health tools/call. The Base (8453) row must answer with a matching
# chain id; the other chains' rows print as information. Honest exit codes.
node --input-type=module -e '
import { spawn } from "node:child_process";
const server = process.argv[1];
const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
let failed = false;
let finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  child.kill();
  process.exit(failed ? 1 : 0);
};
const fail = (line) => { console.log(line); failed = true; finish(); };
// the server itself backstops any tool at 90s with a sentence; this outer
// bound only catches a broken bundle that never answers at all
const timer = setTimeout(() => fail("FAIL handshake: the server did not answer within 100s (broken bundle, or every RPC is hanging)"), 100000);
child.on("error", (e) => fail("FAIL server: could not spawn dist/server.mjs (" + e.message + ")"));
child.on("exit", (code) => { if (!finished) fail("FAIL server: exited early with code " + code + " before answering"); });
child.stdout.on("data", (d) => {
  buf += String(d);
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.error) { fail("FAIL rpc: id " + msg.id + " answered a protocol error: " + (msg.error.message || "unknown")); return; }
    if (msg.id === 1) {
      const info = msg.result && msg.result.serverInfo;
      if (info) console.log("PASS initialize: " + info.name + " " + info.version + " answered the MCP handshake");
      else { fail("FAIL initialize: the server answered without serverInfo"); return; }
    }
    if (msg.id === 2) {
      const res = msg.result || {};
      const text = res.content && res.content[0] ? String(res.content[0].text) : "";
      if (res.isError) { fail("FAIL health: the tool refused: " + text.split("\n")[0]); return; }
      if (!text) { fail("FAIL health: empty tool result"); return; }
      for (const row of text.split("\n")) console.log("  | " + row);
      const base = text.split("\n").find((l) => l.startsWith("8453 ("));
      if (!base) { fail("FAIL health: no Base (8453) row; this build does not configure Base, which the shipped kit does by default"); return; }
      if (base.includes("answers, chain id matches")) console.log("PASS health: live Base RPC answers and the chain id matches");
      else { fail("FAIL health: the Base RPC is not healthy (" + base.trim() + "); seat a working RPC (VITE_BASE_RPC_URL or VITE_ALCHEMY_API_KEY)"); return; }
      finish();
    }
  }
});
const frames = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "spectrum_health", arguments: {} } },
];
for (const f of frames) child.stdin.write(JSON.stringify(f) + "\n");
' "$DIR/dist/server.mjs"
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  echo "PASS check: the install is healthy"
else
  echo "FAIL check: see the FAIL line above"
fi
exit "$STATUS"
