# claude-bus

A tiny MCP server that lets Claude Code sessions send each other messages
through shared inboxes. Coordinator/worker agent patterns without a
framework — just 150 lines of Node and a JSONL file per session.

## What problem it solves

Claude Code sessions are isolated by design: each session has its own
context, its own worktree, its own process. That isolation is what makes
`spawn_task` safe, but it also means a coordinator session can't natively
receive results from the workers it spawned. People end up copy-pasting
output between terminal windows.

`claude-bus` gives every session a named inbox. Workers send `result`
messages to the coordinator; the coordinator aggregates; nobody
copy-pastes. It's designed for the fan-out patterns that show up in data
auditing, parallel testing, codebase-wide refactors, and any other
"dispatch N workers, collect N results" workflow.

## How it works

- Each session starts with `CLAUDE_BUS_NAME` set to its identity
  (`auditor`, `tester-1`, …). That name is its inbox.
- Three MCP tools: `bus_send`, `bus_inbox`, `bus_peers`.
- Storage is append-only JSONL at `~/.claude-bus/inbox/<name>.jsonl`. A
  per-session cursor at `~/.claude-bus/cursor/<name>.txt` tracks how far
  into the log the session has read.
- A `UserPromptSubmit` hook checks the inbox on every user turn and
  injects a `<system-reminder>` when there's unread mail. No polling, no
  long-lived connections.

No registration step, no locks, no database. Writers append. Readers
advance their own cursor. That's the whole protocol.

## Install

```bash
git clone https://github.com/goalmada/claude-bus.git ~/Desktop/claude-bus
cd ~/Desktop/claude-bus
npm install
```

Register the MCP server at user scope (one time):

```bash
claude mcp add -s user claude-bus node "$HOME/Desktop/claude-bus/src/server.js"
```

Add the inbox-check hook to `~/.claude/settings.json` under
`hooks.UserPromptSubmit`. Merge it alongside any existing hooks — do not
clobber them:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash /Users/YOU/Desktop/claude-bus/hooks/check-inbox.sh"
          }
        ]
      }
    ]
  }
}
```

### Setting a session's identity

There are two ways to tell a session who it is:

**Terminal flow.** Export `CLAUDE_BUS_NAME` before launching Claude Code:

```bash
CLAUDE_BUS_NAME=auditor claude
# ... in another terminal:
CLAUDE_BUS_NAME=tester-1 claude
```

**Mac app / GUI flow.** GUI Claude Code can't inherit shell env vars, so
the session claims its identity at runtime by calling the `bus_claim`
tool. Paste this as the first line of the session's opening prompt:

```
First, call bus_claim({ name: "auditor" }) to register me on the bus.
```

(swap in `tester-1`, `tester-2`, etc. for worker sessions). The
templates under `templates/` already include this step.

Safe to install globally either way: sessions that never claim an
identity see the tools but get a helpful error if they call them.

## Tools

### `bus_send(to, kind, body, reply_to?)`
Appends a message to the recipient's inbox. Returns `{ok, id,
delivered_at}`. Body capped at 8 KB — for larger payloads, write to a
file and send the path plus a summary.

### `bus_inbox(peek?)`
Returns unread messages for *this* session and advances the cursor.
`peek: true` reads without advancing.

### `bus_peers()`
Lists every session with an inbox on this machine, plus this session's
unread count.

## CLI

```bash
claude-bus peers                          # who has an inbox
claude-bus unread auditor                 # how many unread for auditor
claude-bus peek auditor 5                 # last 5 messages
claude-bus tail auditor                   # follow live (like tail -f)
claude-bus send auditor tester-1 brief "run suite A"
```

## Example: data auditor fan-out

1. Start the auditor session with `CLAUDE_BUS_NAME=auditor`. Paste
   `templates/auditor-brief.md` as the opening prompt.
2. Spawn N tester sessions (via `spawn_task` or manually) with
   `CLAUDE_BUS_NAME=tester-1`, `tester-2`, … Paste
   `templates/tester-brief.md` as each one's opening prompt.
3. The auditor dispatches briefs via `bus_send`. Testers work in
   parallel. Results land in the auditor's inbox as they complete.
4. The auditor synthesizes once all outstanding briefs have replies.

See `examples/data-auditor.md` for a worked example.

## Design notes

- **Append-only JSONL + per-reader cursor.** No locks. A reader can
  never block a writer; a crashed reader just replays from wherever it
  left off. Inspect any inbox with `cat`.
- **No push transport.** An earlier draft used SSE for server→client
  push; it was deleted. At human timescales (minutes, not milliseconds)
  a hook-triggered inbox check is indistinguishable from push and is
  dramatically simpler.
- **No registration.** The session's `CLAUDE_BUS_NAME` *is* its inbox.
  First `bus_send` to a name creates the file.
- **Names are trusted.** All sessions in a workflow are cooperating
  Claude Code instances you launched. There's no authentication and the
  trust model is the same as the trust model for local files.
- **Context budget first.** The 8 KB body cap exists because unbounded
  message bodies would silently burn the coordinator's context window.
  Testers write big outputs to disk and send pointers.

## License

MIT. See `LICENSE`.
