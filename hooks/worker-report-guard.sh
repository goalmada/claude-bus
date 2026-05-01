#!/usr/bin/env bash
# claude-bus worker-side guard. Runs as an asyncRewake Stop hook in
# every Claude Code session. If this session is identified as a worker
# AND has at least one task in status "claimed" (i.e. it acknowledged
# the task by claiming the name, but never bus_send'd a result), the
# hook wakes the model with a reminder to either report the result or
# explicitly send a kind: "status" update.
#
# The intent: catch the "worker forgot to bus_send before going idle"
# failure mode that disconnects fan-out workflows.
#
# Dedup: each task gets at most ONE reminder per machine. The first
# fire writes ~/.claude-bus/reminded/<task-id>.txt. Subsequent fires
# for the same task short-circuit. This avoids loops where the model
# acknowledges the reminder verbally without actually reporting.

set -euo pipefail

root="${HOME}/.claude-bus"
mkdir -p "$root/reminded"

# Resolve identity. Same precedence as the other hooks: env, then
# active/<PPID>.txt for GUI sessions.
name="${CLAUDE_BUS_NAME:-}"
if [ -z "$name" ]; then
  active="$root/active/$PPID.txt"
  [ -f "$active" ] && name="$(cat "$active" 2>/dev/null || true)"
fi
[ -n "$name" ] || exit 0

# Find the first claimed-but-unreported task for this worker that we
# haven't already reminded about. Returns JSON or empty.
unreported=$(node -e '
  const fs = require("fs");
  const path = require("path");
  const root = process.env.HOME + "/.claude-bus";
  const dir = path.join(root, "tasks");
  const remindedDir = path.join(root, "reminded");
  if (!fs.existsSync(dir)) process.exit(0);
  const me = process.argv[1];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (t.worker_name !== me) continue;
      if (t.status !== "claimed") continue;
      if (fs.existsSync(path.join(remindedDir, t.id + ".txt"))) continue;
      console.log(JSON.stringify(t));
      break;
    } catch {}
  }
' "$name")

[ -n "$unreported" ] || exit 0

task_id=$(echo "$unreported" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).id)')
brief=$(echo "$unreported" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).brief_summary)')
recipients=$(echo "$unreported" | node -e 'const t=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(t.report_to.join(", "))')

# Mark reminded BEFORE waking, so a re-fire from a slow model doesn't
# stack reminders.
date -u +%Y-%m-%dT%H:%M:%SZ > "$root/reminded/$task_id.txt"

cat <<EOF
You ('$name') have a claimed task ($task_id) that you have not reported on yet. Before this session ends, send a kind: "result" bus_send to ${recipients} with the body following the strict REPORT TEMPLATE (your task id "$task_id" must be on the second line). The task was: "${brief}"

If the work is genuinely incomplete, send kind: "status" with what you have done so far instead — but do not silently end without communicating. This is a one-time per-task reminder.
EOF
exit 2
