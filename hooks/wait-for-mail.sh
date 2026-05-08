#!/usr/bin/env bash
# claude-bus async background poller. Runs as an asyncRewake Stop hook:
# after the model finishes a turn, this script runs in the background and
# waits for new mail. When something arrives, it renders the messages
# inline (so the orchestrator can act without an extra bus_inbox call),
# advances the cursor, and exits with code 2 to wake the model.
#
# In v0.10 this hook also:
#   - touches ~/.claude-bus/heartbeat/<name>.txt every poll iteration so
#     bus_peers can distinguish "alive" (PID holds the name) from
#     "responsive" (push hook is actively running)
#   - scans the task registry for overdue tasks owned by this session
#     and fires a one-time nudge when a task is past its check_in_at
#     without being reported
#   - scans this session's outgoing-message log for messages still
#     unread by the recipient past 5 min, and surfaces them as a wake
#     reminder so the orchestrator can revive or follow up
#
# Wakes via exit 2 on ANY of: new mail, overdue task, stuck outgoing.
#
# Tunables (env):
#   CLAUDE_BUS_WAIT_SECONDS    max wait before timing out cleanly (default
#                                7 days = 604800; raised from 6h in v0.10
#                                because long-idle orchestrators were the
#                                last source of silent-deafness)
#   CLAUDE_BUS_POLL_SECONDS    poll interval (default 3)
#   CLAUDE_BUS_STUCK_SECONDS   age at which an unread outgoing message is
#                                considered stuck (default 300 = 5 min)
#   CLAUDE_BUS_NOTIFY          if non-empty, fire macOS notifications

set -euo pipefail

root="${HOME}/.claude-bus"
mkdir -p "$root/heartbeat"

name="${CLAUDE_BUS_NAME:-}"
if [ -z "$name" ]; then
  active="$root/active/$PPID.txt"
  [ -f "$active" ] && name="$(cat "$active" 2>/dev/null || true)"
fi
[ -n "$name" ] || exit 0

file="$root/inbox/$name.jsonl"
cfile="$root/cursor/$name.txt"

[ -f "$file" ] || : > "$file"

max_wait="${CLAUDE_BUS_WAIT_SECONDS:-604800}"  # 7 days
poll="${CLAUDE_BUS_POLL_SECONDS:-3}"
stuck_seconds="${CLAUDE_BUS_STUCK_SECONDS:-300}"
elapsed=0

notify() {
  [ -n "${CLAUDE_BUS_NOTIFY:-}" ] || return 0
  local title="$1"
  local message="$2"
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"${message//\"/\\\"}\" with title \"${title//\"/\\\"}\"" >/dev/null 2>&1 || true
  fi
}

# touch_heartbeat — writes an empty file with a fresh mtime. bus_peers/
# isPeerResponsive uses the mtime to determine push-liveness.
touch_heartbeat() {
  : > "$root/heartbeat/$name.txt" 2>/dev/null || true
}

# Scan task registry for overdue tasks and stuck outgoing messages.
# Returns rendered reminder text on stdout if anything fires, empty otherwise.
# Periodic heartbeat tick. Off by default (interval=0). When the env
# CLAUDE_BUS_HEARTBEAT_MINUTES > 0, fires a wake every N minutes
# prompting the orchestrator to self-evaluate ("anything worth doing
# right now?"). Each tick is a model turn — picks have token cost.
# Tracked via ~/.claude-bus/heartbeat-fires/<name>.txt (unix timestamp
# of last fire). First run initializes the timestamp; first actual
# fire happens one full interval after that.
scan_for_heartbeat() {
  local interval_min="${CLAUDE_BUS_HEARTBEAT_MINUTES:-0}"
  [ "$interval_min" -gt 0 ] || return 0

  mkdir -p "$root/heartbeat-fires"
  local hb_file="$root/heartbeat-fires/$name.txt"
  local now
  now=$(date +%s)
  local interval_sec=$((interval_min * 60))

  local last
  if [ -f "$hb_file" ]; then
    last=$(cat "$hb_file" 2>/dev/null | tr -d ' ')
    [ -n "$last" ] || last=0
  else
    # First time we see this session — initialize, do not fire.
    echo "$now" > "$hb_file"
    return 0
  fi

  local elapsed=$((now - last))
  if [ "$elapsed" -lt "$interval_sec" ]; then
    return 0
  fi

  # Fire. Stamp the new timestamp BEFORE rendering so a re-fire from
  # a slow model doesn't double-trigger.
  echo "$now" > "$hb_file"

  local mins_since=$((elapsed / 60))
  cat <<HEARTBEAT
🫀 heartbeat — anything worth doing right now?

It's been ~${mins_since} minutes since your last heartbeat tick. Look at:
  • bus_tasks() — what's still in flight, what's stuck
  • bus_peers() — which workers are alive and responsive
  • bus_inbox(peek: true) — recent traffic you may want to follow up on
  • The user's most recent goal — what were they trying to accomplish?

If there's a useful move — spawn a worker, ping a stuck one, synthesize
recent findings, surface a status update — take it. If nothing has
materially changed and no action is warranted, just say "no-op, all
quiet" briefly and end your turn cleanly. Either response is correct.
HEARTBEAT
}

scan_for_nudges() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    const root = process.env.HOME + "/.claude-bus";
    const me = process.argv[1];
    const stuckSec = parseInt(process.argv[2], 10);
    const now = Date.now();
    const out = [];

    // 1. Overdue tasks owned by this session.
    const tasksDir = path.join(root, "tasks");
    try {
      for (const f of fs.readdirSync(tasksDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const t = JSON.parse(fs.readFileSync(path.join(tasksDir, f), "utf8"));
          if (t.owner !== me) continue;
          if (t.status === "reported" || t.status === "archived") continue;
          if (t.nudged_at) continue;
          if (!t.check_in_at) continue;
          if (new Date(t.check_in_at).getTime() > now) continue;

          // Mark nudged BEFORE rendering so a re-fire from a slow model
          // does not stack reminders.
          t.nudged_at = new Date().toISOString();
          fs.writeFileSync(path.join(tasksDir, f), JSON.stringify(t, null, 2));

          const ageMin = Math.round((now - new Date(t.spawned_at).getTime()) / 60000);
          const summary = String(t.brief_summary || "")
            .replace(/\s+/g, " ").slice(0, 120);
          out.push(
            `⏰ task ${t.id} overdue check-in (worker "${t.worker_name}", ` +
            `spawned ${ageMin}m ago, status: ${t.status})\n` +
            `   Brief: "${summary}"\n` +
            `   Likely cases:\n` +
            `   1. Worker reported but you missed the wake — call bus_inbox(peek: true)\n` +
            `      and grep for TASK ID ${t.id} to confirm.\n` +
            `   2. Worker is still working or stuck — bus_send kind: "status" to ` +
            `"${t.worker_name}" asking for progress, or check its window.`
          );
          break; // surface one nudge per wake to avoid drowning the model
        } catch {}
      }
    } catch {}

    // 2. Outgoing messages still unread past stuck threshold.
    const sentFile = path.join(root, "sent", me + ".jsonl");
    if (out.length === 0 && fs.existsSync(sentFile)) {
      const lines = fs.readFileSync(sentFile, "utf8").split("\n").filter(Boolean);
      for (const l of lines) {
        try {
          const s = JSON.parse(l);
          const ageMs = now - new Date(s.delivered_at).getTime();
          if (ageMs < stuckSec * 1000) continue;
          if (s._nudged) continue;

          // Read recipient cursor.
          let cursor = 0;
          try {
            const raw = fs.readFileSync(path.join(root, "cursor", s.to + ".txt"), "utf8");
            cursor = parseInt(raw.trim(), 10) || 0;
          } catch {}
          if (cursor > s.delivered_offset) continue; // already read

          // Mark this send as nudged in the sent log.
          // (Rewriting the whole file once per nudge is fine — sent logs
          // are small, one line per outgoing message.)
          s._nudged = new Date().toISOString();
          const updated = lines.map((ll) => {
            try {
              const obj = JSON.parse(ll);
              return obj.id === s.id ? JSON.stringify(s) : ll;
            } catch { return ll; }
          }).join("\n") + "\n";
          fs.writeFileSync(sentFile, updated);

          const ageMin = Math.round(ageMs / 60000);
          out.push(
            `📭 message ${s.id} to "${s.to}" still unread after ${ageMin}m ` +
            `(kind: ${s.kind})\n` +
            `   The recipient has not advanced its cursor past your message.\n` +
            `   Likely cases:\n` +
            `   1. Recipient is alive but its push hook is broken — try ` +
            `bus_revive("${s.to}").\n` +
            `   2. Recipient window was closed — also bus_revive.\n` +
            `   3. Recipient is genuinely busy in another turn — bus_peers ` +
            `to confirm responsive: true, then wait.`
          );
          break;
        } catch {}
      }
    }

    process.stdout.write(out.join("\n\n"));
  ' "$name" "$stuck_seconds" 2>/dev/null
}

while true; do
  touch_heartbeat

  size=$(wc -c < "$file" 2>/dev/null | tr -d ' ' || echo 0)
  pos=$([ -f "$cfile" ] && cat "$cfile" || echo 0)

  # Wake whenever the cursor is behind file size — i.e. there is
  # genuinely unread mail. This catches both new arrivals and pre-
  # existing un-delivered mail (the silent-deafness case fixed in v0.9).
  if [ "$pos" -lt "$size" ]; then
    rendered=$("$(dirname "$0")/_render-inbox.sh" "$name" "" || true)
    if [ -n "$rendered" ]; then
      notify "claude-bus" "$name received new mail"
      echo "$rendered"
      exit 2
    fi
  else
    # No unread mail. Check for overdue tasks or stuck outgoing messages.
    nudges=$(scan_for_nudges || true)
    if [ -n "$nudges" ]; then
      notify "claude-bus" "$name has overdue task or stuck message"
      echo "$nudges"
      exit 2
    fi

    # Then the proactive heartbeat (off by default; set
    # CLAUDE_BUS_HEARTBEAT_MINUTES=N to enable for this session).
    heartbeat=$(scan_for_heartbeat || true)
    if [ -n "$heartbeat" ]; then
      echo "$heartbeat"
      exit 2
    fi
  fi

  if [ "$elapsed" -ge "$max_wait" ]; then
    notify "claude-bus" "stopped watching '$name' after ${max_wait}s — submit any prompt to re-arm"
    exit 0
  fi

  sleep "$poll"
  elapsed=$((elapsed + poll))
done
