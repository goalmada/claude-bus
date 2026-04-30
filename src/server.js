#!/usr/bin/env node
// claude-bus MCP server.
//
// Each Claude Code session launches this with CLAUDE_BUS_NAME set to its
// identity (e.g. "auditor", "tester-1"). The name identifies which inbox
// is "mine" for bus_inbox and which "from" field to stamp on bus_send.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  appendMessage,
  readInbox,
  listPeers,
  listPeerInfo,
  unreadCount,
  setActiveIdentity,
  getActiveIdentity,
  pruneStaleActive,
  createTask,
  getTask,
  listTasks,
  markTasksClaimedFor,
  isPeerAlive,
  MAX_BODY_BYTES,
} from "./storage.js";

// Identity resolution, in order:
//   1. CLAUDE_BUS_NAME env var          — terminal flow
//   2. bus_claim() called this session  — Mac app / GUI flow
//   3. active/<ppid>.txt on disk        — persists across MCP server restarts
//                                          within one Claude Code session
//   4. nothing                           — tool calls return a helpful error
//
// The PID we key on is process.ppid: the Claude Code session that spawned
// this MCP server over stdio. Each Claude Code session has its own MCP
// subprocess, so ppid is unique per session.

let _selfClaimed = null;

function resolveSelf() {
  if (process.env.CLAUDE_BUS_NAME) return process.env.CLAUDE_BUS_NAME;
  if (_selfClaimed) return _selfClaimed;
  const fromFile = getActiveIdentity(process.ppid);
  if (fromFile) {
    _selfClaimed = fromFile;
    return fromFile;
  }
  return null;
}

const NO_NAME_HINT =
  "claude-bus is not active in this session. Call bus_claim with a " +
  "name (e.g. bus_claim({name: 'auditor'})) to register this session. " +
  "Or, in a terminal, restart Claude Code with CLAUDE_BUS_NAME=<name> " +
  "set in your shell.";

// Protocol primer attached to every successful bus_claim response so a
// freshly-started orchestrator/worker knows the workflow without extra
// coaching from the user.
const PROTOCOL_PRIMER = `You are now identified on claude-bus. Quick protocol:

• To delegate work to a new session, use bus_spawn_worker(name, brief).
  It generates a self-contained brief and returns spawn_task arguments.
  After calling it, run spawn_task with those args. The user clicks the
  chip to actually start the worker. Do NOT write spawn_task briefs by
  hand — bus_spawn_worker bakes in the bus protocol for you.

• To message an existing live session, use bus_send(to, kind, body).
  Run bus_peers() first to see who is alive (peers with alive: true
  can be messaged; alive: false are dead windows — spawn a new one).

• Incoming mail is delivered automatically. The UserPromptSubmit and
  Stop hooks read your inbox and inject the message bodies inline as
  system-reminders. You normally do NOT need to call bus_inbox — the
  content is already in your context. Use bus_inbox(peek: true) only
  for debugging or to re-read.

• Push works: when a message arrives while you are idle, the Stop
  hook wakes you within ~3s. You do not need the user to nudge you.

• When replying to a specific message, set reply_to: <message-id> on
  your bus_send. Keeps threads matchable for the recipient.

• If a worker should stay alive after its first task to handle
  follow-ups, pass long_running: true to bus_spawn_worker.

• Workers report back in a strict template (REPORT FROM / TASK ID /
  CONTEXT / WHY / PROBLEM / SOLUTION / STATUS / NOTES / NEXT STEPS).
  When you surface a worker result to the user, pass it through
  faithfully — it is already in the right shape. ONLY if a result
  body does not begin with "REPORT FROM:" should you reformat it into
  the template; that's the fallback for off-format drift.

• Every bus_spawn_worker call records a task entry. Use bus_tasks() to
  see what's outstanding and bus_task(id) for full detail. The registry
  survives context compaction — if your memory of the fan-out gets
  trimmed, bus_tasks() recovers it. Lifecycle states:
    spawned  — chip created, no worker has claimed the name yet (the
               user may not have clicked the chip; if it stays in this
               state past a few minutes, re-issue or assume stuck)
    claimed  — a worker session has claimed the name (chip clicked,
               worker is alive and working)
    reported — worker bus_sent a kind: "result" with the matching TASK ID

• bus_send returns recipient_alive in its response. If recipient_alive
  is false, the message is QUEUED in a dead inbox — nobody will read it.
  Do not assume delivery means processing. The right response is
  bus_revive(name) which spawns a fresh session that re-claims the
  same name and reads the prior inbox history as context. Do NOT spawn
  a new differently-named worker — reusing the name preserves the
  conversation thread and keeps session count minimum.

• Workers default to long_running: true so they stay alive after their
  first reply and remain reachable for follow-ups. Pass long_running:
  false explicitly only for genuinely one-shot work.`;

// Strict report template every worker uses for its result body. Stamping
// structure at message-creation time means the orchestrator surfaces
// reports faithfully (no LLM reformat round-trip), inbox files are
// already structured (cat-friendly logs), and asking the worker to fill
// in NEXT STEPS makes the worker actually think about them. The TASK ID
// line lets the bus auto-link the result back to the task record so the
// orchestrator can recover state after compaction.
const REPORT_TEMPLATE_TEMPLATE = `REPORT FROM: <your-name>
TASK ID: <TASK_ID_PLACEHOLDER>
CONTEXT: <one line — what this work was about>
WHY: <one line — why we did it>
PROBLEM: <one line — what was actually broken/unknown going in>
SOLUTION: <one line — what you did to address it>
STATUS: <one line — done | partial | blocked + reason>
NOTES: <0-2 lines — anything the orchestrator should know that doesn't fit above>
NEXT STEPS: <one line per concrete next action, dash-prefixed>`;

function reportTemplateFor(taskId) {
  return REPORT_TEMPLATE_TEMPLATE.replace("<TASK_ID_PLACEHOLDER>", taskId);
}

// Self-contained brief generator for bus_spawn_worker. The worker session
// has no memory of the orchestrator, so the brief teaches it the bus
// protocol from cold.
function buildWorkerBrief({ workerName, orchestratorName, userBrief, longRunning, reportTo, taskId }) {
  const recipients = reportTo.length === 1
    ? `to: "${reportTo[0]}"`
    : `to each of these recipients in turn: ${reportTo.map((r) => `"${r}"`).join(", ")} (one bus_send per recipient, identical body)`;

  const reportingLine = longRunning
    ? `When you finish each task, send your result ${recipients} with kind: "result", reply_to: <id-of-the-most-recent-brief-you-received>, and a body formatted EXACTLY as the REPORT TEMPLATE below. Then call bus_inbox() and wait for follow-up messages — stay open indefinitely until "${orchestratorName}" explicitly tells you to stop.`
    : `When done, send your result ${recipients} with kind: "result", reply_to: <id-of-the-brief-message-that-told-you-what-to-do>, and a body formatted EXACTLY as the REPORT TEMPLATE below. After that you may close.`;

  return `You are a worker session on claude-bus. Your name is "${workerName}". Your orchestrator is "${orchestratorName}".

First two actions (in order):
  1. Call bus_claim({name: "${workerName}"}) to register your inbox.
  2. Call bus_inbox() to confirm the inbox is empty (or to pick up any pre-staged briefs from ${orchestratorName}).

Your task:

${userBrief}

How to report back:
${reportingLine}

REPORT TEMPLATE (use this verbatim for your result body — fill in each field, do not omit any section, write "n/a" if a section truly does not apply). The TASK ID line is pre-filled with your task id; copy it as-is so the orchestrator can auto-link your reply to the task it spawned:

${reportTemplateFor(taskId)}

If your result is larger than ~6KB even after fitting the template, write the detail to a file under /tmp/${workerName}-*.{md,json} and put the path in NOTES with a one-line summary in SOLUTION.

If you have a blocking question, send kind: "question" to ${orchestratorName} with your question (free-form body — the template only applies to "result" kind). Their reply will arrive automatically (push hook wakes you).

Important: do not assume anything not stated above. The orchestrator has no memory of you and you have no memory of them — the bus is your only channel.`;
}

// Best-effort cleanup of stale entries from ended sessions.
try { pruneStaleActive(); } catch {}

// If identity came from the env (terminal flow), record it in the active
// registry too. This unifies the two flows so bus_peers can report
// liveness uniformly regardless of how the session was named.
if (process.env.CLAUDE_BUS_NAME) {
  try { setActiveIdentity(process.ppid, process.env.CLAUDE_BUS_NAME); } catch {}
}

const TOOLS = [
  {
    name: "bus_claim",
    description:
      "Register this session's identity on the bus. Call once at session " +
      "start before bus_send/bus_inbox. The name is what other sessions " +
      "address their messages to. In a terminal you can skip this if " +
      "CLAUDE_BUS_NAME is already set in the environment.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "1-64 chars, [a-zA-Z0-9_-] only (e.g. 'auditor', 'tester-1')",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bus_send",
    description:
      "Send a message to another session's inbox. 'to' is the recipient's " +
      "CLAUDE_BUS_NAME. 'kind' is a short tag like 'brief', 'result', " +
      "'status', 'question'. Optional 'reply_to' is the id of a prior " +
      `message you are answering. Body is capped at ${MAX_BODY_BYTES} bytes; ` +
      "for larger payloads write to a file and send the path.",
    inputSchema: {
      type: "object",
      required: ["to", "kind", "body"],
      properties: {
        to: { type: "string", description: "recipient session name" },
        kind: { type: "string", description: "brief|result|status|question|..." },
        body: { type: "string", description: "message body (plain text or JSON string)" },
        reply_to: { type: ["string", "null"], description: "id of message being answered" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bus_inbox",
    description:
      "Read messages addressed to this session. Two modes: " +
      "peek=false (default) reads UNREAD messages and advances the " +
      "cursor (consume). peek=true returns EVERY message ever delivered " +
      "to this inbox from offset 0, regardless of cursor — use this to " +
      "re-read a message whose body was truncated in a system-reminder, " +
      "or to inspect history. peek does not modify the cursor.",
    inputSchema: {
      type: "object",
      properties: {
        peek: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bus_spawn_worker",
    description:
      "Generate a self-contained brief for a new worker session and " +
      "return spawn_task arguments ready to invoke. After calling this, " +
      "you should call spawn_task with the title/prompt/tldr from the " +
      "response. The generated brief bakes in the bus protocol (claim, " +
      "do the work, report back) AND a strict report template so the " +
      "worker's result is already structured when it lands in your " +
      "inbox. Use long_running: true for workers that should stay open " +
      "for follow-ups. Use report_to to CC the structured report to " +
      "additional sessions (e.g. an audit/log session).",
    inputSchema: {
      type: "object",
      required: ["name", "brief"],
      properties: {
        name: {
          type: "string",
          description:
            "Bus name for the worker (e.g. 'impact-analyzer'). 1-64 chars, " +
            "[a-zA-Z0-9_-] only. Choose something descriptive — this is " +
            "how you address the worker.",
        },
        brief: {
          type: "string",
          description:
            "Plain-English description of what the worker should do. " +
            "Be specific (file paths, dataset names, expected output " +
            "format). The worker has no memory of you — include " +
            "everything needed to act cold.",
        },
        title: {
          type: "string",
          description:
            "Optional short title for the spawn_task chip. Defaults to " +
            "'Spawn <name> worker' if omitted.",
        },
        long_running: {
          type: "boolean",
          description:
            "If true (the default), the worker stays open after its " +
            "first reply and listens for follow-ups indefinitely. The " +
            "orchestrator can then bus_send additional tasks to the " +
            "same name — same context, same session, no new chip. " +
            "Pass false ONLY for genuinely one-shot work where you " +
            "will never need to follow up. Default flipped to true in " +
            "v0.6 because dead-worker recovery is more painful than a " +
            "long-lived session.",
          default: true,
        },
        report_to: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of session names to send the structured " +
            "report to. Defaults to [<your-name>] (i.e. just the calling " +
            "orchestrator). Use this to CC results to an audit session, " +
            "another orchestrator, or a logger — e.g. " +
            "report_to: ['orchestrator', 'data-auditor'].",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bus_revive",
    description:
      "Generate spawn_task arguments to revive a dead session. Use " +
      "this when you discover a recipient is no longer alive (via " +
      "recipient_alive: false in a bus_send response, or alive: false " +
      "in bus_peers). The generated brief tells the new session to " +
      "re-claim the SAME name and read its prior inbox history as " +
      "context, so the conversation thread continues without you " +
      "having to spawn a new differently-named worker. Optionally pass " +
      "a short follow_up message that should also be communicated to " +
      "the reborn session (in addition to whatever was queued).",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description:
            "Name of the session to revive. Must be a name you previously " +
            "communicated with (i.e. that has an inbox or active claim).",
        },
        follow_up: {
          type: "string",
          description:
            "Optional plain-English instruction to surface to the reborn " +
            "session in addition to whatever was queued. Use this when " +
            "you have new context the worker didn't have before dying.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bus_tasks",
    description:
      "List tasks YOU spawned via bus_spawn_worker. Each task tracks " +
      "the worker name, brief summary, spawn time, status (spawned | " +
      "reported), and the message id of the worker's first result if " +
      "received. Useful for: (a) seeing what's outstanding mid-fan-out, " +
      "(b) recovering state after context compaction (your task " +
      "registry survives even if your conversation memory is trimmed), " +
      "(c) detecting stuck workers (status: spawned for hours = chip " +
      "never clicked or worker errored).",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["spawned", "reported", "all"],
          default: "all",
          description: "Filter by task status. Default 'all'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bus_task",
    description:
      "Fetch full details for one task by id. Includes the brief " +
      "summary, recipients, status, and (if reported) the result " +
      "message id so you can locate the report in your inbox.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Task id (tsk-...)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bus_peers",
    description:
      "List every session known to the bus, with liveness and unread " +
      "count. A peer is 'alive' if at least one Claude Code process " +
      "currently holds its name (i.e. you can still message it). " +
      "'has_inbox' means the peer has received messages at some point. " +
      "'unread' is how many messages are queued in that peer's inbox " +
      "right now (useful for spotting stuck workers).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const server = new Server(
  { name: "claude-bus", version: "0.6.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  // bus_claim is the one tool that's allowed before identity is set.
  if (name === "bus_claim") {
    try {
      setActiveIdentity(process.ppid, args.name);
      _selfClaimed = args.name;
      // If this claim resolves an outstanding "spawned" task (i.e. the
      // user just clicked a chip we issued), flip its lifecycle to
      // "claimed" so the spawning orchestrator can see the worker is
      // actually alive and working.
      let claimedTask = null;
      try { claimedTask = await markTasksClaimedFor(args.name); } catch {}
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                identity: args.name,
                ppid: process.ppid,
                claimed_task: claimedTask
                  ? { id: claimedTask.id, owner: claimedTask.owner }
                  : null,
              },
              null, 2
            ),
          },
          { type: "text", text: PROTOCOL_PRIMER },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `claude-bus error: ${err.message}` }],
      };
    }
  }

  const SELF = resolveSelf();
  if (!SELF) {
    return {
      isError: true,
      content: [{ type: "text", text: NO_NAME_HINT }],
    };
  }
  try {
    if (name === "bus_spawn_worker") {
      const workerName = args.name;
      const userBrief = args.brief;
      // Default flipped to true in v0.6: workers stay alive unless the
      // caller explicitly opts out.
      const longRunning = args.long_running === false ? false : true;
      const title = args.title || `Spawn ${workerName} worker`;
      const reportTo = Array.isArray(args.report_to) && args.report_to.length > 0
        ? args.report_to
        : [SELF];

      if (typeof workerName !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(workerName)) {
        throw new Error(
          `invalid worker name "${workerName}": must be 1-64 chars, [a-zA-Z0-9_-] only`
        );
      }
      if (typeof userBrief !== "string" || userBrief.trim().length < 10) {
        throw new Error("brief must be a non-empty string of at least 10 chars");
      }
      if (title.length > 60) {
        throw new Error("title must be ≤60 chars");
      }
      for (const r of reportTo) {
        if (typeof r !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(r)) {
          throw new Error(
            `invalid report_to entry "${r}": must be 1-64 chars, [a-zA-Z0-9_-] only`
          );
        }
      }

      // Record the task BEFORE generating the brief so we can embed the
      // task id into the report template the worker will use.
      const task = await createTask({
        owner: SELF,
        worker_name: workerName,
        brief_summary: userBrief,
        long_running: longRunning,
        report_to: reportTo,
      });

      const prompt = buildWorkerBrief({
        workerName,
        orchestratorName: SELF,
        userBrief,
        longRunning,
        reportTo,
        taskId: task.id,
      });

      const ccLine = reportTo.length > 1
        ? ` Reports CC'd to: ${reportTo.join(", ")}.`
        : "";
      const tldr =
        `Spawns "${workerName}" worker on claude-bus. ` +
        (longRunning
          ? `Stays open for follow-ups from ${SELF}.`
          : `One-shot — replies once and may close.`) +
        ccLine;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                task_id: task.id,
                worker_name: workerName,
                long_running: longRunning,
                report_to: reportTo,
                spawn_task_args: { title, tldr, prompt },
                next_step:
                  "Call spawn_task with the title, tldr, and prompt above. " +
                  "The user will see a chip and click to start the worker. " +
                  `When the worker reports back, the result will appear in ${reportTo.length === 1 ? `your inbox ("${reportTo[0]}")` : `the inboxes of: ${reportTo.join(", ")}`} automatically and task ${task.id} will be marked reported. ` +
                  "Use bus_tasks() at any time to see what's outstanding (helpful after compaction).",
              },
              null,
              2
            ),
          },
        ],
      };
    }
    if (name === "bus_send") {
      const msg = await appendMessage({
        from: SELF,
        to: args.to,
        kind: args.kind,
        reply_to: args.reply_to ?? null,
        body: args.body,
      });
      // Liveness probe AFTER the send. We don't want to refuse delivery
      // (queueing for a not-yet-claimed name is a legitimate pattern),
      // but the orchestrator needs to KNOW when its message landed in
      // a dead inbox so it can decide to bus_revive instead of waiting.
      const recipient_alive = await isPeerAlive(args.to);
      const response = {
        ok: true,
        id: msg.id,
        delivered_at: msg.created_at,
        recipient_alive,
      };
      if (!recipient_alive) {
        response.warning =
          `Recipient "${args.to}" is not currently alive on the bus. ` +
          `The message is queued but nobody is listening. The right ` +
          `response is to call bus_revive({name: "${args.to}"}) which ` +
          `respawns a session that re-claims this name and reads the ` +
          `prior inbox history as context. Do NOT spawn a new ` +
          `differently-named worker — reusing the name preserves the ` +
          `conversation thread.`;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
    if (name === "bus_inbox") {
      const { messages } = await readInbox(SELF, { peek: !!args.peek });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ self: SELF, messages }, null, 2),
          },
        ],
      };
    }
    if (name === "bus_revive") {
      const targetName = args.name;
      const followUp = (args.follow_up || "").trim();
      if (typeof targetName !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(targetName)) {
        throw new Error(
          `invalid name "${targetName}": must be 1-64 chars, [a-zA-Z0-9_-] only`
        );
      }
      const stillAlive = await isPeerAlive(targetName);
      const followUpBlock = followUp
        ? `\n\nFollow-up note from ${SELF} (use this in addition to the inbox history):\n${followUp}\n`
        : "";

      const prompt = `You are a reborn session on claude-bus. The previous session that held the name "${targetName}" is no longer alive — you are taking over that identity. Your orchestrator is "${SELF}".

First two actions (in order):
  1. Call bus_claim({name: "${targetName}"}) to take over the name.
  2. Call bus_inbox({peek: true}) to read the FULL history of messages
     ever sent to "${targetName}". This is your context — the prior
     conversation thread between you and ${SELF} is in those messages.
     Read them in chronological order to understand what was being
     worked on, what was already discussed, and what's still pending.

After that, call bus_inbox() (without peek) to consume the unread queue
and process whatever messages were waiting for you when the previous
session died.${followUpBlock}

When you reply, use the same protocol you would as any worker — REPORT
template for results, or kind: "question" for blocking questions.

Important: do NOT pretend to be the prior session. You don't have its
local conversation transcript, only the bus history. If something in
the history is unclear, send kind: "question" to ${SELF} for
clarification rather than guessing. This is a continuity hand-off, not
a memory restore.`;

      const tldr = stillAlive
        ? `Note: "${targetName}" appears to be alive already. Reviving anyway will create a second claimant. You probably want to bus_send instead.`
        : `Revives the dead "${targetName}" session by spawning a fresh worker that re-claims the name and reads inbox history as context.`;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                target_name: targetName,
                target_was_alive: stillAlive,
                spawn_task_args: {
                  title: `Revive ${targetName}`,
                  tldr,
                  prompt,
                },
                next_step:
                  `Call spawn_task with the spawn_task_args above. The user clicks the chip; the new session re-claims "${targetName}" and reads inbox history as context. Any messages already queued in the inbox will be processed.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
    if (name === "bus_tasks") {
      const status = args.status || "all";
      const tasks = await listTasks({ owner: SELF, status });
      const summary = {
        spawned: tasks.filter((t) => t.status === "spawned").length,
        reported: tasks.filter((t) => t.status === "reported").length,
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { self: SELF, filter: status, summary, tasks },
              null,
              2
            ),
          },
        ],
      };
    }
    if (name === "bus_task") {
      const t = await getTask(args.id);
      if (!t) {
        return {
          isError: true,
          content: [{ type: "text", text: `task not found: ${args.id}` }],
        };
      }
      // Don't leak other orchestrators' tasks — but be explicit about why.
      if (t.owner !== SELF) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `task ${t.id} is owned by "${t.owner}", not "${SELF}". You can only inspect tasks you spawned.`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(t, null, 2) }],
      };
    }
    if (name === "bus_peers") {
      const peers = await listPeerInfo();
      const mine = await unreadCount(SELF);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { self: SELF, unread: mine, peers },
              null,
              2
            ),
          },
        ],
      };
    }
    throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `claude-bus error: ${err.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
