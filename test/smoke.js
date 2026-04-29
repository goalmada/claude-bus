// Minimal smoke test: append + read + cursor + size limit.
// Uses a temp dir to avoid stomping on real ~/.claude-bus state.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "claude-bus-test-"));
process.env.HOME = tmp; // redirect storage to an ephemeral dir

const { appendMessage, readInbox, unreadCount, listPeers, MAX_BODY_BYTES } =
  await import("../src/storage.js");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  ok  " + msg); }
  else       { failed++; console.error("  FAIL " + msg); }
}

// 1. Send + receive.
const m1 = await appendMessage({
  from: "auditor", to: "tester-1", kind: "brief",
  reply_to: null, body: "run test suite A",
});
assert(typeof m1.id === "string" && m1.id.length > 8, "message id assigned");
assert(m1.from === "auditor" && m1.to === "tester-1", "from/to preserved");

let inbox = await readInbox("tester-1");
assert(inbox.messages.length === 1, "tester-1 sees 1 message");
assert(inbox.messages[0].body === "run test suite A", "body roundtrips");

// 2. Cursor advances — second read returns nothing.
inbox = await readInbox("tester-1");
assert(inbox.messages.length === 0, "cursor advanced, no repeats");

// 3. Peek returns full history regardless of cursor — the fix for the
//    "Stop hook truncated my body and now I can't get the full text" bug.
await appendMessage({ from: "auditor", to: "tester-1", kind: "brief", body: "B" });
const peekFresh = await readInbox("tester-1", { peek: true });
assert(peekFresh.messages.length === 2, "peek shows ALL history (consumed A + new B)");
assert(peekFresh.messages[0].body === "run test suite A", "peek includes already-consumed first message");
assert(peekFresh.messages[1].body === "B", "peek includes new second message");

const again = await readInbox("tester-1", { peek: true });
assert(again.messages.length === 2, "peek is idempotent — does not advance cursor");

const real = await readInbox("tester-1");
assert(real.messages.length === 1 && real.messages[0].body === "B",
  "non-peek consume returns only unread (B), advances cursor");

// 4. Unread count.
await appendMessage({ from: "auditor", to: "tester-2", kind: "brief", body: "C" });
await appendMessage({ from: "auditor", to: "tester-2", kind: "brief", body: "D" });
assert((await unreadCount("tester-2")) === 2, "unread count = 2");
await readInbox("tester-2");
assert((await unreadCount("tester-2")) === 0, "unread count after read = 0");

// 5. Peer list.
const peers = await listPeers();
assert(peers.includes("tester-1") && peers.includes("tester-2"), "peers list");

// 6. Size cap.
let threw = false;
try {
  await appendMessage({
    from: "auditor", to: "tester-1", kind: "brief",
    body: "x".repeat(MAX_BODY_BYTES + 1),
  });
} catch { threw = true; }
assert(threw, "oversized body rejected");

// 7. Name validation.
threw = false;
try {
  await appendMessage({ from: "auditor", to: "../evil", kind: "brief", body: "x" });
} catch { threw = true; }
assert(threw, "path-traversal name rejected");

// 8. Reply threading.
const q = await appendMessage({ from: "tester-1", to: "auditor", kind: "question", body: "?" });
const a = await appendMessage({
  from: "auditor", to: "tester-1", kind: "answer",
  reply_to: q.id, body: "yes",
});
assert(a.reply_to === q.id, "reply_to preserved");

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
