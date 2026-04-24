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
  unreadCount,
  MAX_BODY_BYTES,
} from "./storage.js";

// If CLAUDE_BUS_NAME is unset, the server still starts but every tool call
// returns a helpful error. This keeps the server well-behaved when it's
// configured globally but the current terminal didn't opt in to the bus.
const SELF = process.env.CLAUDE_BUS_NAME || null;
const NO_NAME_HINT =
  "claude-bus is not active in this session. Set CLAUDE_BUS_NAME " +
  "(e.g. export CLAUDE_BUS_NAME=auditor) before launching claude, " +
  "then restart the session.";

const TOOLS = [
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
      "List all sessions that have an inbox on this machine. Useful for " +
      "discovering which testers/workers are online.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const server = new Server(
  { name: "claude-bus", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
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
      const peers = await listPeers();
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
