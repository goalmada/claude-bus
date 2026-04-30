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
const expectedTools = [
  "bus_claim", "bus_inbox", "bus_peers", "bus_revive",
  "bus_send", "bus_spawn_worker", "bus_task", "bus_tasks",
];
assert(JSON.stringify(names) === JSON.stringify(expectedTools),
  `tools listed: ${names.join(",")}`);

// 2. Auditor sends a brief to tester-1.
const sendRes = await auditor.call("tools/call", {
  name: "bus_send",
  arguments: { to: "tester-1", kind: "brief", body: "run suite A on dataset Z" },
});
const sendPayload = JSON.parse(sendRes.result.content[0].text);
assert(sendPayload.ok === true, "send returned ok");
assert(sendPayload.recipient_alive === true,
  `send to live tester-1 reports alive: actual=${sendPayload.recipient_alive}`);
assert(sendPayload.warning === undefined,
  "no warning when recipient is alive");
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

// 6. Peers — new rich shape: array of {name, alive, has_inbox, unread}.
const peersRes = await auditor.call("tools/call", {
  name: "bus_peers", arguments: {},
});
const peersPayload = JSON.parse(peersRes.result.content[0].text);
const peerNames = peersPayload.peers.map((p) => p.name);
assert(peerNames.includes("tester-1") && peerNames.includes("auditor"),
  `peers: ${peerNames.join(",")}`);
const testerPeer = peersPayload.peers.find((p) => p.name === "tester-1");
assert(testerPeer && testerPeer.alive === true,
  `tester-1 alive=${testerPeer?.alive}`);
assert(typeof testerPeer.unread === "number",
  "tester-1 has unread count");

// 7. bus_spawn_worker prepares spawn_task args from a plain brief.
const sw = await auditor.call("tools/call", {
  name: "bus_spawn_worker",
  arguments: {
    name: "impact-analyzer",
    brief: "Run a Spearman correlation between cb_post_views.impact_score and view counts. Report findings.",
    long_running: false,
  },
});
const swPayload = JSON.parse(sw.result.content[0].text);
assert(swPayload.ok === true, "bus_spawn_worker ok");
assert(swPayload.worker_name === "impact-analyzer", "worker_name preserved");
assert(swPayload.spawn_task_args.title.includes("impact-analyzer"), "title generated");
assert(swPayload.spawn_task_args.prompt.includes('bus_claim({name: "impact-analyzer"})'),
  "brief instructs worker to claim its name");
assert(swPayload.spawn_task_args.prompt.includes('to: "auditor"'),
  "brief instructs worker to reply to auditor (the orchestrator)");
assert(swPayload.spawn_task_args.prompt.includes("Spearman correlation"),
  "user brief embedded verbatim");
assert(typeof swPayload.spawn_task_args.tldr === "string" && swPayload.spawn_task_args.tldr.length > 0,
  "tldr generated");

// 8. long_running flag changes the reporting language.
const sw2 = await auditor.call("tools/call", {
  name: "bus_spawn_worker",
  arguments: {
    name: "watcher",
    brief: "Watch the build status and ping me when state changes.",
    long_running: true,
  },
});
const sw2Payload = JSON.parse(sw2.result.content[0].text);
assert(sw2Payload.long_running === true, "long_running flag preserved");
assert(sw2Payload.spawn_task_args.prompt.includes("stay open indefinitely"),
  "long-running brief tells worker to stay open");

// 9. Invalid worker name is rejected.
const swBad = await auditor.call("tools/call", {
  name: "bus_spawn_worker",
  arguments: { name: "../evil", brief: "do something malicious here" },
});
assert(swBad.result.isError === true, "invalid worker name rejected");

// 9a. Report template is embedded in the brief.
assert(swPayload.spawn_task_args.prompt.includes("REPORT FROM:"),
  "brief includes REPORT FROM section");
assert(swPayload.spawn_task_args.prompt.includes("NEXT STEPS:"),
  "brief includes NEXT STEPS section");
assert(swPayload.spawn_task_args.prompt.includes('write "n/a" if a section truly does not apply'),
  "brief tells worker to fill every section");

// 9b. report_to defaults to [SELF].
assert(JSON.stringify(swPayload.report_to) === JSON.stringify(["auditor"]),
  `report_to defaults to [SELF]: ${JSON.stringify(swPayload.report_to)}`);

// 9c. report_to with multiple recipients changes the brief.
const swCC = await auditor.call("tools/call", {
  name: "bus_spawn_worker",
  arguments: {
    name: "audited-worker",
    brief: "Investigate the thing and report findings.",
    report_to: ["auditor", "data-auditor", "logger"],
  },
});
const swCCPayload = JSON.parse(swCC.result.content[0].text);
assert(JSON.stringify(swCCPayload.report_to) === JSON.stringify(["auditor", "data-auditor", "logger"]),
  "report_to preserves multi-recipient list");
assert(swCCPayload.spawn_task_args.prompt.includes('"auditor"') &&
       swCCPayload.spawn_task_args.prompt.includes('"data-auditor"') &&
       swCCPayload.spawn_task_args.prompt.includes('"logger"'),
  "multi-recipient brief lists all three names");
assert(swCCPayload.spawn_task_args.tldr.includes("CC'd to: auditor, data-auditor, logger"),
  "multi-recipient tldr surfaces the CC list");

// 9d. Invalid report_to entry rejected.
const swBadCC = await auditor.call("tools/call", {
  name: "bus_spawn_worker",
  arguments: {
    name: "x",
    brief: "ten chars min",
    report_to: ["valid-name", "bad name with spaces"],
  },
});
assert(swBadCC.result.isError === true, "invalid report_to entry rejected");

// 10. bus_spawn_worker creates a task entry; its id is embedded in the brief.
const taskId = swPayload.task_id;
assert(/^tsk-[a-z0-9-]+$/.test(taskId), `task_id has expected format: ${taskId}`);
assert(swPayload.spawn_task_args.prompt.includes(`TASK ID: ${taskId}`),
  "task id is embedded in the report template inside the brief");

// 11. bus_tasks lists the new task with status: spawned.
const tlistRes = await auditor.call("tools/call", {
  name: "bus_tasks", arguments: {},
});
const tlist = JSON.parse(tlistRes.result.content[0].text);
const myTask = tlist.tasks.find((t) => t.id === taskId);
assert(myTask !== undefined, "spawned task appears in bus_tasks");
assert(myTask.status === "spawned", "task starts in 'spawned' status");
assert(myTask.worker_name === "impact-analyzer", "worker_name on task");
assert(tlist.summary.spawned >= 1, "summary counts spawned tasks");

// 12. Filtering by status works.
const reportedFilter = await auditor.call("tools/call", {
  name: "bus_tasks", arguments: { status: "reported" },
});
const reported = JSON.parse(reportedFilter.result.content[0].text);
assert(reported.tasks.find((t) => t.id === taskId) === undefined,
  "task not returned when filtering for status=reported");

// 13. Worker bus_sends a result with TASK ID line; task auto-flips to reported.
//    We send from the "impact-analyzer" identity by claiming it on the
//    second test session.
await tester.call("tools/call", {
  name: "bus_claim", arguments: { name: "impact-analyzer" },
});
const resultBody = `REPORT FROM: impact-analyzer
TASK ID: ${taskId}
CONTEXT: Spearman analysis
WHY: Verify impact_score correlates with views
PROBLEM: Suspected null correlation
SOLUTION: Computed Spearman, found r=-0.07
STATUS: done
NOTES: n/a
NEXT STEPS:
- Replace impact_score model
`;
await tester.call("tools/call", {
  name: "bus_send",
  arguments: { to: "auditor", kind: "result", body: resultBody },
});

// Allow filesystem write to flush. (Same process so this is paranoia.)
await new Promise((r) => setTimeout(r, 50));

const after = await auditor.call("tools/call", {
  name: "bus_task", arguments: { id: taskId },
});
const afterTask = JSON.parse(after.result.content[0].text);
assert(afterTask.status === "reported",
  `task auto-marked reported via bus_send body: actual status=${afterTask.status}`);
assert(typeof afterTask.first_result_id === "string" &&
       afterTask.first_result_id.length > 0,
  "first_result_id populated on auto-mark");

// 14. bus_task scoping: another session can't read auditor's task.
const stranger = startSession("stranger");
await stranger.init();
await stranger.call("tools/call", {
  name: "bus_claim", arguments: { name: "stranger" },
});
const stealAttempt = await stranger.call("tools/call", {
  name: "bus_task", arguments: { id: taskId },
});
assert(stealAttempt.result.isError === true,
  "non-owner cannot inspect another orchestrator's task");
stranger.proc.kill();

// 15. v0.6: long_running default is true.
const swDefault = await auditor.call("tools/call", {
  name: "bus_spawn_worker",
  arguments: {
    name: "default-worker",
    brief: "Generic task for default test, ten or more chars.",
  },
});
const swDefaultPayload = JSON.parse(swDefault.result.content[0].text);
assert(swDefaultPayload.long_running === true,
  `long_running defaults to true: actual=${swDefaultPayload.long_running}`);
assert(swDefaultPayload.spawn_task_args.prompt.includes("stay open indefinitely"),
  "default brief is the long-running variant");

// 16. v0.6: bus_claim for a name with an open task flips the task to claimed.
const swClaim = await auditor.call("tools/call", {
  name: "bus_spawn_worker",
  arguments: {
    name: "to-be-claimed",
    brief: "Some real task that needs at least ten chars.",
  },
});
const swClaimPayload = JSON.parse(swClaim.result.content[0].text);
const claimTaskId = swClaimPayload.task_id;

// Pre-check: task starts in "spawned".
const preClaim = await auditor.call("tools/call", {
  name: "bus_task", arguments: { id: claimTaskId },
});
assert(JSON.parse(preClaim.result.content[0].text).status === "spawned",
  "task starts in 'spawned' state");

// Have a fresh session claim that name.
const claimer = startSession("claimer-init");
await claimer.init();
const claimResp = await claimer.call("tools/call", {
  name: "bus_claim", arguments: { name: "to-be-claimed" },
});
const claimPayload = JSON.parse(claimResp.result.content[0].text);
assert(claimPayload.claimed_task && claimPayload.claimed_task.id === claimTaskId,
  "bus_claim response surfaces the matched task");

// Wait for filesystem flush, then verify status flipped.
await new Promise((r) => setTimeout(r, 50));
const postClaim = await auditor.call("tools/call", {
  name: "bus_task", arguments: { id: claimTaskId },
});
const postClaimTask = JSON.parse(postClaim.result.content[0].text);
assert(postClaimTask.status === "claimed",
  `task flipped to 'claimed' after bus_claim: actual=${postClaimTask.status}`);
assert(typeof postClaimTask.claimed_at === "string",
  "claimed_at timestamp recorded");

claimer.proc.kill();

// 17. v0.6: bus_send to a non-existent / dead recipient surfaces
//     recipient_alive: false plus a warning pointing at bus_revive.
const ghostSend = await auditor.call("tools/call", {
  name: "bus_send",
  arguments: { to: "ghost-worker", kind: "brief", body: "are you there?" },
});
const ghostPayload = JSON.parse(ghostSend.result.content[0].text);
assert(ghostPayload.ok === true, "send to dead recipient still succeeds (queues)");
assert(ghostPayload.recipient_alive === false,
  "recipient_alive: false for dead/missing peer");
assert(typeof ghostPayload.warning === "string" &&
       ghostPayload.warning.includes("bus_revive"),
  "warning points at bus_revive");

// 18. v0.6: bus_revive generates spawn_task args that re-claim the name
//     and instruct the new session to read inbox history as context.
const revive = await auditor.call("tools/call", {
  name: "bus_revive", arguments: { name: "ghost-worker" },
});
const revivePayload = JSON.parse(revive.result.content[0].text);
assert(revivePayload.ok === true, "bus_revive ok");
assert(revivePayload.target_name === "ghost-worker", "target_name preserved");
assert(revivePayload.target_was_alive === false,
  "ghost-worker correctly reported as not alive");
assert(revivePayload.spawn_task_args.prompt.includes('bus_claim({name: "ghost-worker"})'),
  "revive brief tells new session to re-claim same name");
assert(revivePayload.spawn_task_args.prompt.includes("bus_inbox({peek: true})"),
  "revive brief tells new session to peek inbox history");
assert(revivePayload.spawn_task_args.title === "Revive ghost-worker",
  "chip title reflects the operation");

// 19. v0.6: bus_revive with follow_up embeds it in the brief.
const reviveWithFollow = await auditor.call("tools/call", {
  name: "bus_revive",
  arguments: {
    name: "ghost-worker",
    follow_up: "We discovered the build is also failing on macOS — please check that path too.",
  },
});
const followPayload = JSON.parse(reviveWithFollow.result.content[0].text);
assert(followPayload.spawn_task_args.prompt.includes("build is also failing on macOS"),
  "follow_up embedded in revive brief");

// 20. v0.6: invalid name on bus_revive is rejected.
//
// (Note: a check for "revive on already-alive name flags target_was_alive"
// would be ideal here, but in this test harness multiple "sessions" share
// the test process's ppid and overwrite each other's active/ entries,
// so liveness lookups for parallel sessions are unreliable. The
// production case — each Claude Code session has its own ppid — is
// covered indirectly by test 17, which exercises the dead-recipient
// path that bus_revive is meant to recover from.)
const reviveBad = await auditor.call("tools/call", {
  name: "bus_revive", arguments: { name: "../evil" },
});
assert(reviveBad.result.isError === true, "invalid revive name rejected");

// 10. bus_claim response includes the protocol primer.
const claim2 = await tester.call("tools/call", {
  name: "bus_claim", arguments: { name: "tester-1" },
});
const primerText = claim2.result.content[1]?.text ?? "";
assert(primerText.includes("bus_spawn_worker"),
  "claim response includes protocol primer");

auditor.proc.kill();
tester.proc.kill();
await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
