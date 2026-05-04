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

// 9. Task registry: createTask + listTasks + getTask round-trip.
const { createTask, listTasks, getTask, markTaskReported } = await import(
  "../src/storage.js"
);
const t1 = await createTask({
  owner: "auditor",
  worker_name: "impact-analyzer",
  brief_summary: "Run the spearman correlation",
  long_running: false,
  report_to: ["auditor"],
});
assert(/^tsk-[a-z0-9-]+$/.test(t1.id), "task id has expected format");
assert(t1.status === "spawned", "new task is in 'spawned' status");
assert(t1.owner === "auditor", "owner preserved");

await createTask({
  owner: "different-orch",
  worker_name: "x",
  brief_summary: "y",
  long_running: false,
  report_to: ["different-orch"],
});

const myTasks = await listTasks({ owner: "auditor" });
assert(myTasks.length === 1 && myTasks[0].id === t1.id,
  "listTasks filters by owner");

// 10. Marking a task reported is recorded and idempotent.
const updated = await markTaskReported(t1.id, "msg-result-001");
assert(updated.status === "reported", "status flipped to reported");
assert(updated.first_result_id === "msg-result-001", "result id stored");
const repeat = await markTaskReported(t1.id, "msg-result-002");
assert(repeat.first_result_id === "msg-result-001",
  "first-reporter-wins: idempotent on second call");

// 11. bus_send with TASK ID in body auto-marks the task.
const t2 = await createTask({
  owner: "auditor", worker_name: "x", brief_summary: "y",
  long_running: false, report_to: ["auditor"],
});
const resultMsg = await appendMessage({
  from: "x", to: "auditor", kind: "result", reply_to: null,
  body: `REPORT FROM: x\nTASK ID: ${t2.id}\nCONTEXT: y\n`,
});
const t2Updated = await getTask(t2.id);
assert(t2Updated.status === "reported",
  "bus_send with TASK ID line auto-marks the task");
assert(t2Updated.first_result_id === resultMsg.id,
  "task linked to the result message id");

// 12. Non-result kinds do NOT auto-mark.
const t3 = await createTask({
  owner: "auditor", worker_name: "x", brief_summary: "y",
  long_running: false, report_to: ["auditor"],
});
await appendMessage({
  from: "x", to: "auditor", kind: "status", reply_to: null,
  body: `TASK ID: ${t3.id}\nWorking on it`,
});
const t3Still = await getTask(t3.id);
assert(t3Still.status === "spawned",
  "status messages don't trigger task completion");

// 13. listTasks filter by status.
const reported = await listTasks({ owner: "auditor", status: "reported" });
assert(reported.length === 2,
  `reported filter: expected 2, got ${reported.length}`);
const spawned = await listTasks({ owner: "auditor", status: "spawned" });
assert(spawned.length === 1 && spawned[0].id === t3.id,
  "spawned filter returns the still-pending task");

// 14. v0.9: archiveSession removes inbox + cursor + flips matching tasks.
const { archiveSession } = await import("../src/storage.js");
await appendMessage({
  from: "auditor", to: "donezo", kind: "brief", body: "do the thing",
});
await readInbox("donezo"); // create cursor
const tDone = await createTask({
  owner: "auditor", worker_name: "donezo", brief_summary: "ok",
  long_running: false, report_to: ["auditor"],
});
const arch = await archiveSession("donezo");
assert(arch.removed.inbox === true, "archive removed inbox file");
assert(arch.removed.cursor === true, "archive removed cursor file");
assert(arch.archived_tasks.includes(tDone.id),
  "matching task flipped to archived");
const tDoneAfter = await getTask(tDone.id);
assert(tDoneAfter.status === "archived",
  "task status reads 'archived' after archive");
assert(typeof tDoneAfter.archived_at === "string",
  "archived_at timestamp recorded");

// 15. archiveSession is idempotent on tasks (re-archiving an already-
//     archived name doesn't re-stamp archived_at).
const arch2 = await archiveSession("donezo");
assert(arch2.archived_tasks.length === 0,
  "second archive of same name finds no still-active tasks");

await fs.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
