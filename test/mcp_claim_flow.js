// Mac-app / GUI flow: server starts WITHOUT CLAUDE_BUS_NAME, the session
// claims its identity at runtime via bus_claim, then send/receive work.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claude-bus-claim-"));
const env = { ...process.env, HOME: tmp };
delete env.CLAUDE_BUS_NAME;

function startSession() {
  const proc = spawn("node", ["src/server.js"], {
    env, // crucially: no CLAUDE_BUS_NAME
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiters = [];
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const w = waiters.shift();
      if (w) w(msg);
    }
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
  let id = 0;
  function call(method, params = {}) {
    return new Promise((resolve) => {
      waiters.push(resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
    });
  }
  async function init() {
    await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  return { proc, call, init };
}

let passed = 0, failed = 0;
const assert = (cond, msg) => {
  if (cond) { passed++; console.log("  ok  " + msg); }
  else      { failed++; console.error("  FAIL " + msg); }
};

const s = startSession();
await s.init();

// 1. Without claiming, bus_send should error helpfully.
const noIdent = await s.call("tools/call", {
  name: "bus_send",
  arguments: { to: "x", kind: "brief", body: "hi" },
});
assert(noIdent.result.isError === true, "send without claim is an error");
assert(noIdent.result.content[0].text.includes("bus_claim"),
  "error message points at bus_claim");

// 2. Claim identity.
const claim = await s.call("tools/call", {
  name: "bus_claim", arguments: { name: "auditor" },
});
const claimPayload = JSON.parse(claim.result.content[0].text);
assert(claimPayload.ok === true && claimPayload.identity === "auditor",
  "bus_claim returns ok and identity");

// 3. Now send works and uses the claimed identity.
const send = await s.call("tools/call", {
  name: "bus_send",
  arguments: { to: "tester-1", kind: "brief", body: "do the thing" },
});
const sendPayload = JSON.parse(send.result.content[0].text);
assert(sendPayload.ok === true, "send works after claim");

// 4. Active file was written and contains the claimed name.
// The server keys by process.ppid — i.e. THIS test process's PID, since we
// spawned the server. (In a real Claude Code session, ppid = the Claude
// Code session PID.) So the file we expect to find is named after our PID.
const activeFile = path.join(tmp, ".claude-bus", "active", `${process.pid}.txt`);
const activeContent = await fs.readFile(activeFile, "utf8");
assert(activeContent.trim() === "auditor", "active/<ppid>.txt holds claimed name");

// 5. Invalid name is rejected.
const bad = await s.call("tools/call", {
  name: "bus_claim", arguments: { name: "../evil" },
});
assert(bad.result.isError === true, "invalid claim name rejected");

s.proc.kill();
await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
