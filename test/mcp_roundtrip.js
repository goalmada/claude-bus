// Spawn the server as two separate processes ("auditor" and "tester-1"),
// drive them over stdio using raw JSON-RPC, and verify a real message
// round-trips from auditor to tester-1 and back.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claude-bus-mcp-"));
const env = { ...process.env, HOME: tmp };

function startSession(name) {
  const proc = spawn("node", ["src/server.js"], {
    env: { ...env, CLAUDE_BUS_NAME: name },
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
  proc.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
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

const auditor = startSession("auditor");
const tester = startSession("tester-1");
await auditor.init();
await tester.init();

let passed = 0, failed = 0;
const assert = (cond, msg) => {
  if (cond) { passed++; console.log("  ok  " + msg); }
  else      { failed++; console.error("  FAIL " + msg); }
};

// 1. List tools.
const tools = await auditor.call("tools/list");
const names = tools.result.tools.map((t) => t.name).sort();
assert(JSON.stringify(names) === JSON.stringify(["bus_claim","bus_inbox","bus_peers","bus_send"]),
  `tools listed: ${names.join(",")}`);

// 2. Auditor sends a brief to tester-1.
const sendRes = await auditor.call("tools/call", {
  name: "bus_send",
  arguments: { to: "tester-1", kind: "brief", body: "run suite A on dataset Z" },
});
const sendPayload = JSON.parse(sendRes.result.content[0].text);
assert(sendPayload.ok === true, "send returned ok");
const briefId = sendPayload.id;
assert(typeof briefId === "string", `brief id = ${briefId}`);

// 3. Tester reads inbox and sees it.
const inboxRes = await tester.call("tools/call", {
  name: "bus_inbox", arguments: {},
});
const inboxPayload = JSON.parse(inboxRes.result.content[0].text);
assert(inboxPayload.messages.length === 1, "tester sees 1 message");
assert(inboxPayload.messages[0].from === "auditor", "from = auditor");
assert(inboxPayload.messages[0].body === "run suite A on dataset Z", "body matches");

// 4. Tester replies.
await tester.call("tools/call", {
  name: "bus_send",
  arguments: { to: "auditor", kind: "result", reply_to: briefId, body: "PASS 42/42" },
});

// 5. Auditor sees the reply threaded to the original brief.
const reply = await auditor.call("tools/call", {
  name: "bus_inbox", arguments: {},
});
const replyPayload = JSON.parse(reply.result.content[0].text);
assert(replyPayload.messages.length === 1, "auditor sees 1 reply");
assert(replyPayload.messages[0].reply_to === briefId, "reply_to threads correctly");
assert(replyPayload.messages[0].body === "PASS 42/42", "result body matches");

// 6. Peers.
const peersRes = await auditor.call("tools/call", {
  name: "bus_peers", arguments: {},
});
const peersPayload = JSON.parse(peersRes.result.content[0].text);
assert(peersPayload.peers.includes("tester-1") && peersPayload.peers.includes("auditor"),
  `peers: ${peersPayload.peers.join(",")}`);

auditor.proc.kill();
tester.proc.kill();
await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
