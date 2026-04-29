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
  { name: "claude-bus", version: "0.2.0" },
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
