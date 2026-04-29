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
  follow-ups, pass long_running: true to bus_spawn_worker.`;

// Self-contained brief generator for bus_spawn_worker. The worker session
// has no memory of the orchestrator, so the brief teaches it the bus
// protocol from cold.
function buildWorkerBrief({ workerName, orchestratorName, userBrief, longRunning }) {
  const reportingLine = longRunning
    ? `When you finish each task, call bus_send({to: "${orchestratorName}", kind: "result", body: "...", reply_to: <id-of-the-most-recent-brief-from-${orchestratorName}>}). Then call bus_inbox() and wait for follow-up messages — stay open indefinitely until ${orchestratorName} explicitly tells you to stop.`
    : `When done, call bus_send({to: "${orchestratorName}", kind: "result", body: "...", reply_to: <id-of-the-brief-message-that-told-you-what-to-do>}). After that you may close.`;

  return `You are a worker session on claude-bus. Your name is "${workerName}". Your orchestrator is "${orchestratorName}".

First two actions (in order):
  1. Call bus_claim({name: "${workerName}"}) to register your inbox.
  2. Call bus_inbox() to confirm the inbox is empty (or to pick up any pre-staged briefs from ${orchestratorName}).

Your task:

${userBrief}

How to report back:
${reportingLine}

If your result is larger than ~1KB, write it to a file under /tmp/${workerName}-*.{md,json} and put the path plus a short summary in the body of your bus_send.

If you have a blocking question, send kind: "question" to ${orchestratorName} with your question. Their reply will arrive automatically (push hook wakes you).

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
      "Read unread messages addressed to this session and mark them read. " +
      "Set peek=true to read without advancing the cursor (useful for " +
      "debugging). Returns messages in delivery order.",
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
      "response. The generated brief includes the bus protocol baked in " +
      "(claim identity, do the work, send result back to you with " +
      "reply_to set), so you do not need to write that boilerplate. " +
      "Set long_running: true if the worker should stay open after its " +
      "first reply to handle follow-up messages from you.",
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
            "If true, the worker stays open after its first reply and " +
            "calls bus_inbox in a loop to handle follow-ups. Defaults to " +
            "false (one-shot worker).",
          default: false,
        },
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
  { name: "claude-bus", version: "0.3.0" },
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
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, identity: args.name, ppid: process.ppid },
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
      const longRunning = !!args.long_running;
      const title = args.title || `Spawn ${workerName} worker`;

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

      const prompt = buildWorkerBrief({
        workerName,
        orchestratorName: SELF,
        userBrief,
        longRunning,
      });

      const tldr =
        `Spawns "${workerName}" worker on claude-bus. ` +
        (longRunning
          ? `Stays open for follow-ups from ${SELF}.`
          : `One-shot — replies once and may close.`);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                worker_name: workerName,
                long_running: longRunning,
                spawn_task_args: { title, tldr, prompt },
                next_step:
                  "Call spawn_task with the title, tldr, and prompt above. " +
                  "The user will see a chip and click to start the worker. " +
                  `When the worker reports back, the message will appear in your inbox automatically (you are "${SELF}").`,
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
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, id: msg.id, delivered_at: msg.created_at },
              null,
              2
            ),
          },
        ],
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
