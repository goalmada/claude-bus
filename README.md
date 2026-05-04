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

Add the inbox-check hooks to `~/.claude/settings.json`. Merge them
alongside any existing hooks — do not clobber them:

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
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash /Users/YOU/Desktop/claude-bus/hooks/wait-for-mail.sh",
            "asyncRewake": true,
            "rewakeMessage": "claude-bus push: ",
            "rewakeSummary": "claude-bus mail arrived"
          }
        ]
      }
    ]
  }
}
```

`UserPromptSubmit` surfaces unread mail at the start of every turn (in
case you want to nudge the session). `Stop` is the real push: after
each turn ends, an `asyncRewake` background poller waits up to 30 min
for new mail and wakes the model the instant it arrives — so a
coordinator that's idle while workers run will reactivate on its own.

A second `Stop` hook (`worker-report-guard.sh`) catches the worker-
forgetfulness failure mode: if a session is identified as a worker
and has any task in `claimed` status (claimed but never reported),
the hook wakes the model with a one-time-per-task reminder to either
`bus_send` the result now or send a `kind: "status"` update with
progress. Dedup state lives in `~/.claude-bus/reminded/<task-id>.txt`.

When result-kind messages with a `TASK ID:` line land in your inbox,
the render hook prepends a `📋 result for task <id> — was: "<brief
summary>" — spawned <time-ago>, worker: <name>` callout so the
orchestrator can correlate replies with original dispatches without
scrolling chat history.

Chip titles are short and dash-stripped: `s: dynamic tier classifier`
instead of `Spawn dynamic-tier-classifier worker`. The internal bus
name keeps the kebab-case for protocol cleanliness; only the chip
display is shortened.

When you're juggling multiple projects, configure a project prefix so
chips from different projects are scannable at a glance:

```json
// .claude-bus/config.json (in project root, walked up from cwd)
{ "prefix": "cb" }
```

With this in your cryptobriefing repo, every spawn chip from that
project reads `cb: dynamic tier classifier`. Drop a `{"prefix": "r"}`
in your rumbo repo and chips from there read `r: market scraper`.
Revive operations get a small `↻` marker (`cb: ↻ ghost worker`) so
recovery is visually distinct from fresh spawns. Override per-call
with `bus_spawn_worker({project_prefix: "cb", ...})` or globally with
`CLAUDE_BUS_PROJECT_PREFIX=cb`.

To get a macOS notification (banner + sound) every time a worker
sends a `kind: "result"` message, set `CLAUDE_BUS_NOTIFY=1` in your
shell or `touch ~/.claude-bus/notify.on`. The Mac app limitation:
all Claude Code sessions live inside a single window with internal
tabs, so the notification can't include a "click to close that
worker's window" action — it just nudges you to switch over and
close manually.

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

### `bus_claim(name)`
Registers this session's identity. The response includes a short protocol
primer so a freshly-started orchestrator/worker can use the bus correctly
without coaching.

### `bus_scratch({ name?, purpose? })`
Spawns a fresh idle worker session in **bypass-permissions mode**.
Returns `spawn_task` arguments — call `spawn_task` with them and a chip
appears for the user to click. The worker claims its name, acks once,
then sits idle until the user types in its chat tab or the orchestrator
`bus_send`s it a task.

Useful as a workaround for Desktop builds where the new-session UI does
not expose bypass mode (`anthropics/claude-code#55095`): the chip-spawn
code path lands sessions in bypass mode reliably, so spawning a
no-op worker is currently the only way to land an interactive bypass
session through the Desktop UI. All args are optional; the default
worker name is `scratch-<base36-timestamp>` so consecutive calls don't
collide.

### `bus_spawn_worker(name, brief, long_running?, report_to?)`
Generates a self-contained brief for a new worker and returns
`spawn_task` arguments ready to invoke. The orchestrator passes plain
English; the tool handles the bus-protocol boilerplate (claim, listen,
reply with `reply_to` set) AND injects a strict report template the
worker fills in for its result body:

```
REPORT FROM: <worker-name>
TASK ID: tsk-...     (auto-injected; lets the bus link the result to the task)
CONTEXT: ...
WHY: ...
PROBLEM: ...
SOLUTION: ...
STATUS: done | partial | blocked + reason
NOTES: ...
NEXT STEPS: - ...
```

Stamping the structure at message-creation time means inbox files are
already structured, the orchestrator surfaces results faithfully (no
LLM reformat round-trip), and asking the worker for NEXT STEPS makes
it actually think about them. A bake-off against a "let the
orchestrator reformat afterwards" approach found Option-1 wins on cost
(2.2× cheaper), latency (1.6× faster), audit-trail quality, and — non-
obviously — proactive next-steps quality. See commit history for the
full comparison.

`long_running` defaults to `true` — workers stay open after their
first reply and listen for follow-ups indefinitely. The orchestrator
can `bus_send` additional tasks to the same name without re-spawning.
Pass `long_running: false` only for genuinely one-shot work where you
will never need to follow up. Pass `report_to: ["a", "b"]` to CC the
structured report to additional sessions (default: just the calling
orchestrator).

Typical use:
```
bus_spawn_worker({
  name: "impact-analyzer",
  brief: "Run a Spearman correlation between cb_post_views.impact_score
          and view counts. Report findings.",
  report_to: ["orchestrator", "data-auditor"]   // optional
})
// → returns { spawn_task_args: { title, tldr, prompt } }
// Then call spawn_task with those args. User clicks chip, worker runs.
```

### `bus_tasks(status?)`
Lists tasks YOU spawned via `bus_spawn_worker`. Each `bus_spawn_worker`
call records a task entry in `~/.claude-bus/tasks/<id>.json` with the
worker name, brief summary, recipients, and status. When a worker's
`kind: "result"` message contains a `TASK ID:` line matching a known
task, the bus auto-flips that task's status from `"spawned"` to
`"reported"` and stores the result message id.

This is mostly useful for two situations:
- mid-fan-out: see what's still outstanding without scrolling chat
- post-compaction: your task registry survives even if your
  conversation memory gets trimmed — call `bus_tasks` to recover

Filter by `status: "spawned" | "reported" | "all"` (default `"all"`).

### `bus_task(id)`
Full detail for a specific task by id. Only the owning orchestrator
can read its own tasks.

### `bus_revive(name, follow_up?)`
When a recipient is dead (Claude Code window closed, Cmd+Q'd, app
restarted), use this to bring it back without losing the conversation
thread. Returns `spawn_task` arguments for a fresh session that
re-claims the *same* name and reads its prior inbox history as
context. Optional `follow_up` is a plain-English instruction
appended to the brief (use this when you have new context the worker
didn't have before dying).

The reborn session doesn't have the dead process's local conversation
transcript, but it has the entire bus history of messages to/from
that name — which is the load-bearing context for most
bus-coordinated workflows. This keeps the session count minimum: one
"deployer-2" reborn vs. two-or-three differently-named workers.

### `bus_send(to, kind, body, reply_to?)`
Appends a message to the recipient's inbox. Returns `{ok, id,
delivered_at, recipient_alive}`. If `recipient_alive` is `false`, the
response also includes a `warning` pointing at `bus_revive` — the
message is queued in a dead inbox and nobody will read it until the
name is re-claimed. Body capped at 8 KB — for larger payloads, write
to a file and send the path plus a summary.

### `bus_inbox(peek?)`
Returns unread messages for *this* session and advances the cursor.
`peek: true` reads without advancing.

In normal use you rarely need to call this — the `UserPromptSubmit` and
`Stop` hooks already deliver new mail inline as system-reminders, with
bodies included in full (the per-message cap matches the `bus_send`
body limit of 8 KB, so any message that sent successfully is delivered
intact). Use `bus_inbox(peek: true)` to re-read history or to fetch
the rare oversized message that hit the defensive truncation.

### `bus_peers()`
Returns every name known to the bus with rich status:

```json
{
  "self": "auditor",
  "unread": 3,
  "peers": [
    {"name": "auditor",   "alive": true,  "has_inbox": true,  "unread": 3},
    {"name": "tester-1",  "alive": true,  "has_inbox": false, "unread": 0},
    {"name": "tester-2",  "alive": false, "has_inbox": true,  "unread": 1}
  ]
}
```

`alive: true` means at least one Claude Code process is currently
holding that name — i.e., you can `bus_send` to it and the message
will reach a live session. `alive: false` means the session ended
(window closed, process gone). `has_inbox: true` means the peer has
received messages at some point. `unread` is the queue depth in that
peer's inbox right now — useful for spotting workers that have stopped
keeping up.

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
- **Push via `asyncRewake` Stop hook.** After each turn ends, a small
  shell poller runs in the background and wakes the model when mail
  arrives. No long-lived daemons, no IPC server, no SSE — just a
  shell script that sleeps in a loop and exits with code 2 when it
  finds new bytes in the inbox file. Earlier drafts used SSE for
  push; deleted in favor of this.
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
