# Changelog

All notable changes to claude-bus. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.13.0] — 2026-05-08

Mitigation for an upstream Claude Code bug: `spawn_task` chips that
silently fail to render in the Mac app's "Suggested task" panel when
the same session name is targeted multiple times in succession.

### Changed

- **`bus_spawn_worker` hard-refuses when the target name is already
  alive on the bus.** Previously it would happily issue spawn_task
  args for a name that already had a live session, producing a
  redundant chip. Now it errors with a message pointing at
  `bus_send` (the right tool for messaging an existing worker) or
  suggesting a fresh name (e.g. `<name>-2`) if the orchestrator
  truly wants a separate worker.
- **`bus_run_worker` hard-refuses on the same condition.** Same
  reasoning. Avoids redundant headless processes for an already-
  serving name.
- **`bus_revive` hard-refuses when the target is already alive.**
  Pre-v0.13 it soft-warned in the chip's `tldr` and still issued
  the chip. The empirical pattern was that reviving alive workers
  is the most reliable trigger for the Claude Code chip-not-
  rendering bug, AND it's semantically wrong (nothing died — there's
  nothing to revive). Now the tool throws an error instead of
  generating a redundant chip.

### Why this matters

This doesn't fix the Claude Code rendering issue itself — that's an
upstream bug we filed separately. What it does: cuts off the most
reliable trigger from our side. The orchestrator can no longer
accidentally issue redundant chips for live names; it has to either
`bus_send` to the existing session or pick a different name. Result:
fewer chips dropped on the floor, fewer "I sent it but the user
never saw it" surprises.

### Tests

138 pass (was 130). New assertions: refusal fires + names the
correct alternative + points at `bus_send` for all three tools, with
a re-claim setup that makes `tester-1` honestly alive in the
harness despite shared-ppid limitations.

## [0.12.1] — 2026-05-07

### Fixed

- **Heartbeat config now works in the Mac app flow.** v0.12 only read
  the interval from `CLAUDE_BUS_HEARTBEAT_MINUTES` env var, which
  doesn't propagate to GUI Claude Code launched from the Dock or
  Spotlight. Added two file-based fallbacks:
  - `~/.claude-bus/heartbeat-config/<name>.txt` — per-session integer
    (minutes). Set this for the specific orchestrator you want to
    self-pace.
  - `~/.claude-bus/heartbeat-config/_default.txt` — machine-wide
    default. Applies to every session that lacks a per-session file.

  Resolution order: env > per-session file > default file > off.

  Same pattern as `auto-spawn.on` and `notify.on` from earlier
  versions — env for terminal flow, file for GUI flow.

## [0.12.0] — 2026-05-07

Heartbeat prompt — proactive self-evaluation tick for orchestrators.

### Added

- **Heartbeat prompt.** When `CLAUDE_BUS_HEARTBEAT_MINUTES=N` (N>0)
  is set on a session, the asyncRewake hook fires a wake every N
  minutes with the prompt "🫀 heartbeat — anything worth doing right
  now?" The model evaluates current state (in-flight tasks, recent
  inbox traffic, the user's last goal) and either takes an action or
  acknowledges "no-op, all quiet" and ends the turn cleanly.

### Why

v0.10's nudges are reactive — they fire when something happens
(overdue task, stuck outgoing, new mail). The heartbeat is the
proactive complement: even when nothing event-triggered has fired,
periodically ask the orchestrator "is there anything to do?" Useful
for unattended fan-outs (paired with v0.11 `bus_run_worker`) where
the orchestrator should self-pace, and for long-running planning
sessions where the model should periodically re-evaluate state.

### Tradeoffs

Each heartbeat tick is a model turn. At 30-min intervals that's 48
turns/day; at 60-min, 24/day. Pick interval based on token budget.
Off by default — the user explicitly opts in per session. The
"either action or no-op briefly" framing in the prompt is intentional
to keep null-state turns cheap.

### State

Per-session timestamp at `~/.claude-bus/heartbeat-fires/<name>.txt`.
First-run initializes; first actual fire happens one full interval
after that.

## [0.11.0] — 2026-05-07

Headless worker spawning for unattended fan-outs.

### Added

- **`bus_run_worker(name, brief, opts?)`** tool. Forks a `claude -p`
  subprocess that runs the brief autonomously and `bus_send`s a
  result back when done. No chip, no click — for the case where the
  user has walked away and explicitly asked the orchestrator to fan
  out without their input. Workers are one-shot (no `long_running`
  — `claude -p` is print mode).

### Safety profile

`bus_run_worker` bypasses the chip-click human approval gate that
`bus_spawn_worker` provides. Three guardrails:

1. **Off by default.** Requires `CLAUDE_BUS_AUTO_SPAWN=1` in env OR
   `touch ~/.claude-bus/auto-spawn.on`. Without one of those, the
   tool errors with a clear message naming the gate.
2. **Concurrency cap.** Default 5 simultaneous headless workers.
   Tracked via `~/.claude-bus/auto-spawn-pids/<task-id>.txt`. Raise
   with `CLAUDE_BUS_MAX_AUTO=N`.
3. **Hard runtime timeout.** Default 1800s (30 min); max 4 hours.
   Subprocess is `SIGTERM`'d if it runs longer.

### Audit

- Every spawn appends a JSON line to `~/.claude-bus/auto-spawn-audit.log`
  with timestamp, task_id, owner, worker_name, pid, cwd, permission_mode,
  brief snippet (first 200 chars).
- Per-worker stdout/stderr captured to
  `~/.claude-bus/auto-spawn-logs/<task-id>.log` for post-mortem
  debugging when the user comes back.

### Convention

Protocol primer instructs the orchestrator to prefer `bus_spawn_worker`
when the user is engaged at the keyboard (chip click is a useful
human review of the brief) and only switch to `bus_run_worker` when
the user has explicitly said they're walking away. The orchestrator
should also reset to `bus_spawn_worker` when the user returns and
engages again.

## [0.10.0] — 2026-05-07

The "stuck worker detection" failure class is closed. Four tightly-coupled
features piggyback on the existing asyncRewake Stop hook poll loop — no
new daemons, no new MCP transport.

### Added

- **Read receipts.** `bus_send` response now includes `delivered_offset`
  (byte offset where the message was appended). New `bus_delivery(to,
  offset)` tool returns `{read, current_cursor}` by comparing the
  recipient's cursor to the offset. The cursor *is* the read marker —
  it advances when the recipient's UserPromptSubmit/Stop hook delivers
  messages inline OR when `bus_inbox()` is called.
- **Outgoing-message tracking.** Per-session log at
  `~/.claude-bus/sent/<name>.jsonl`. The asyncRewake hook scans this on
  every poll iteration; messages older than `CLAUDE_BUS_STUCK_SECONDS`
  (default 300s) and still unread fire a one-time wake nudge pointing
  at `bus_revive`.
- **Heartbeat liveness.** `wait-for-mail.sh` touches
  `~/.claude-bus/heartbeat/<name>.txt` every poll iteration.
  `bus_peers` reports `responsive: bool` per peer (heartbeat fresh
  within 120s) — distinct from `alive` (PID holds the name). When you
  `bus_send` to an alive-but-non-responsive recipient, the response
  surfaces a warning: positive evidence the hook is broken, separate
  from the silent "alive but maybe broken" gap.
- **Task check-in deadlines.** `bus_spawn_worker` accepts
  `check_in_minutes` (default 30, 0 disables, max 7 days). Task records
  gain `check_in_at` and `nudged_at` fields. When a task is past its
  deadline without being reported, the hook fires a structured one-time
  wake nudge naming the worker, brief, and likely causes ("missed the
  wake" vs "still working/stuck").

### Changed

- Default `CLAUDE_BUS_WAIT_SECONDS` raised from `21600` (6 hours) to
  `604800` (7 days). A sleeping bash poller has trivial resource cost,
  and v0.9's timeout-notification self-diagnoses on expiry. Real-world
  idle stretches now stay watched indefinitely.

### Why lightweight (hook-touch) over invasive (worker pings) heartbeat

The load-bearing signal for "can I reach this worker?" is whether the
asyncRewake hook is running, not whether the model is. Hook-touch is
free; 60s model-driven `bus_alive()` pings would cost continuous tokens
for an edge case (wedged model + alive process) that hasn't been observed
in practice.

## [0.9.0] — 2026-05-04

Critical bug fix plus three feature additions.

### Fixed

- **Silent deafness past 30-min idle.** The `Stop` asyncRewake hook
  defaulted to a 30-minute poll cap, then exited cleanly. Messages
  arriving after that into a long-idle orchestrator landed in a dead
  poller — wake never fired. Default raised to 6 hours and the hook
  now fires a macOS notification on timeout so silence is
  self-diagnosing. (Further raised to 7 days in v0.10.)
- **Wake-on-unread race.** The hook anchored on `start_size` at hook
  start and only woke for *new* bytes. Mail arriving between
  `UserPromptSubmit` and `Stop` within a turn — and not surfaced
  during that turn — was silently ignored by the next Stop hook
  (size unchanged since start, despite cursor < size). New logic:
  wake whenever cursor is behind file size, regardless of when those
  bytes arrived.

### Added

- **Project prefixes for chip titles.** `.claude-bus/config.json` in
  the project root (walked up from cwd) sets a per-project prefix.
  `cb: dynamic tier classifier` instead of `s: dynamic-tier-classifier`.
  Revive operations get a `↻` marker (`cb: ↻ ghost worker`). Override
  via `CLAUDE_BUS_PROJECT_PREFIX` env or per-call `project_prefix` arg.
- **`bus_archive(name)`** tool. Removes inbox file, cursor, and flips
  matching tasks to `status: "archived"`. Refuses if a live session
  still holds the name.
- **Optional macOS notifications.** Set `CLAUDE_BUS_NOTIFY=1` in shell
  or `touch ~/.claude-bus/notify.on`. Result-kind `bus_send`s fire a
  banner + sound. Mac app limit: all sessions live in one window with
  internal tabs, so AppleScript can't reliably target individual tabs
  for closing — the notification nudges you to switch and close
  manually.

## [0.8.0] — 2026-05-03

UX polish driven by real-use friction.

### Added

- **Short chip titles.** `s: dynamic tier classifier` instead of
  `Spawn dynamic-tier-classifier worker`. `bus_revive` uses `r:`. Bus
  protocol names keep their kebab-case; only the chip display is
  shortened.
- **Task-linkage callout in inbox renders.** When a result-kind message
  with a `TASK ID:` line lands, the system-reminder prepends a callout
  line summarizing the originating task: `📋 result for task tsk-abc —
  was: "<brief>" — spawned 23m ago, worker: <name>`. Closes the "the
  orchestrator missed that this reply matched a task it dispatched"
  failure mode without needing it to call `bus_task` by hand.
- **Worker-side asyncRewake report-guard hook.** When a worker session
  is about to stop AND has a claimed-but-unreported task, the hook
  wakes the model with a one-time-per-task reminder to `bus_send` a
  result or send `kind: "status"` with progress. Dedup state at
  `~/.claude-bus/reminded/<task-id>.txt`.

## [0.7.0] — 2026-05-01

### Added

- **`bus_scratch(name?, purpose?)`** tool. Spawns a fresh idle Claude
  Code session in bypass-permissions mode. Workaround for Mac app
  builds where the new-session UI doesn't expose bypass mode
  (`anthropics/claude-code#55095`). Workers acks once, then idle until
  the user types in their tab or the orchestrator `bus_send`s a task.

## [0.6.0] — 2026-04-29

Long-lived workers by default; dead-worker recovery primitive.

### Changed

- **`long_running` default flipped to `true`.** Workers stay alive
  after their first reply and listen for follow-ups. The orchestrator
  can `bus_send` additional tasks to the same name — same context,
  same session, no new chip. Pass `long_running: false` explicitly
  for genuinely one-shot work.

### Added

- **`bus_revive(name, follow_up?)`** tool. When a worker is dead but
  the orchestrator wants to continue the conversation, `bus_revive`
  generates a `spawn_task` brief that respawns a fresh session
  re-claiming the *same name* and reading prior inbox history as
  context. Preserves the conversation thread without proliferating
  worker names.
- **`recipient_alive` in `bus_send` response.** When false, the
  response includes a warning pointing at `bus_revive`.
- **`claimed` task lifecycle state.** `bus_claim` flips matching open
  tasks from `spawned` to `claimed` automatically. Distinguishes
  "chip not yet clicked" from "worker is alive and working."

## [0.5.0] — 2026-04-29

### Added

- **Task registry.** `bus_spawn_worker` records each spawn at
  `~/.claude-bus/tasks/<id>.json`. `TASK ID: <id>` line embedded in
  the report template; when the worker `bus_send`s a result with a
  matching `TASK ID:` line, the bus auto-flips the task from
  `spawned` to `reported`.
- **`bus_tasks(status?)`** tool — list tasks owned by this session.
  Survives context compaction.
- **`bus_task(id)`** tool — full detail for one task, owner-scoped.

## [0.4.0] — 2026-04-29

Strict report template + multi-recipient reports.

### Added

- **Report template baked into worker briefs.** 8-section structure
  (REPORT FROM / TASK ID / CONTEXT / WHY / PROBLEM / SOLUTION /
  STATUS / NOTES / NEXT STEPS). Real bake-off vs. "let the
  orchestrator reformat" found template-at-source wins on cost
  (2.2× cheaper), latency (1.6× faster), audit-trail quality, and
  proactive next-steps quality.
- **`report_to: ["a", "b"]`** parameter — CC the structured report
  to additional sessions (e.g. an audit/log session). Default
  `[<your-name>]`.

### Fixed

- `bus_inbox(peek: true)` returns full history regardless of cursor
  (previously only returned messages past cursor, which broke
  re-reading truncated bodies).
- Hook body cap matched to `bus_send` MAX_BODY_BYTES (8KB) so any
  message that successfully sent is delivered in full inline.

## [0.3.0] — 2026-04-28

### Added

- **`bus_spawn_worker(name, brief)`** tool. Generates a self-contained
  worker brief with the bus protocol baked in. Returns `spawn_task`
  arguments ready to invoke. Eliminates the per-spawn boilerplate the
  orchestrator used to write by hand.
- **Inline-body delivery in hooks.** Both `UserPromptSubmit` and
  `Stop` hooks read the unread messages and dump them into the
  system-reminder directly. The orchestrator can act without an
  extra `bus_inbox` round-trip.
- **Protocol primer attached to `bus_claim` response.** A
  freshly-started session learns the bus protocol from the tool
  itself instead of needing the user to paste guidance.

## [0.2.0] — 2026-04-28

### Changed

- **`bus_peers` shape.** Old: list of names. New: list of
  `{name, alive, has_inbox, unread}`. `alive` reports whether at
  least one Claude Code process currently holds the name.
- Env-var identity (`CLAUDE_BUS_NAME=...`) now writes its own
  `active/<ppid>.txt` at server startup, so terminal-flow sessions
  appear in `bus_peers` consistently with claim-flow sessions.

## [0.1.0] — 2026-04-25

Initial release. Three tools (`bus_send`, `bus_inbox`, `bus_peers`),
JSONL inbox per recipient, per-session byte-offset cursor, 8 KB body
cap, strict name validation, `reply_to` threading. Two hooks
(UserPromptSubmit + asyncRewake Stop). Identity via `CLAUDE_BUS_NAME`
env or `bus_claim` (Mac-app flow).
