# Example: data auditor dispatches 3 parallel testers

A worked example of the fan-out pattern that motivated `claude-bus`.

## Setup

Three terminals. In each, set `CLAUDE_BUS_NAME` before launching Claude
Code so the MCP server knows which inbox belongs to that session.

```bash
# Terminal 1
CLAUDE_BUS_NAME=auditor claude

# Terminal 2
CLAUDE_BUS_NAME=tester-1 claude

# Terminal 3
CLAUDE_BUS_NAME=tester-2 claude

# Terminal 4
CLAUDE_BUS_NAME=tester-3 claude
```

In each tester terminal, paste `templates/tester-brief.md` as the opening
prompt. In the auditor terminal, paste `templates/auditor-brief.md`.

## Auditor's dispatch script (pseudocode)

```
for (i, test) in enumerate([suite_A, suite_B, suite_C]):
    id = bus_send(
      to=f"tester-{i+1}",
      kind="brief",
      body=json({dataset: test.dataset, instructions: test.steps})
    )
    dispatch_table[id] = test.name
```

## While testers work

Auditor calls `bus_inbox()` occasionally (or reacts to the
`UserPromptSubmit` hook reminder). Status updates and results arrive in
whatever order they complete.

```
📬 1 unread from tester-2
  → kind=status, body="30% done, fold 2/3"

📬 1 unread from tester-1
  → kind=result, reply_to=m-abc, body="PASS 42/42 cases, see /tmp/t1.md"

📬 1 unread from tester-3
  → kind=question, body="dataset missing column `ts_utc` — use `timestamp`?"
    ← auditor: bus_send(to=tester-3, kind=answer, reply_to=..., body="yes")
```

## Synthesis

Once every dispatched brief has a matching `result`, the auditor stitches
the report. It keeps quoted result bodies verbatim so you can audit the
synthesis.

## What you're NOT doing anymore

Copy-pasting tester output between windows.
