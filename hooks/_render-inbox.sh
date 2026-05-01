#!/usr/bin/env bash
# Shared helper: read this session's unread mail, render a system-reminder
# block to stdout, and advance the cursor so we don't re-deliver. Used by
# both the UserPromptSubmit (check-inbox.sh) and Stop (wait-for-mail.sh)
# hooks so the user-facing behavior is identical.
#
# Returns nothing (and exits 0) if there's nothing to deliver. Callers
# decide whether to translate that into an exit-2 wake or not.
#
# Args:
#   $1 = session bus name (already resolved)
#   $2 = optional prefix for the reminder line ("" or "📬 ")

set -euo pipefail

name="$1"
prefix="${2:-}"
root="${HOME}/.claude-bus"
file="$root/inbox/$name.jsonl"
cfile="$root/cursor/$name.txt"

[ -f "$file" ] || exit 0

size=$(wc -c < "$file" | tr -d ' ')
pos=$([ -f "$cfile" ] && cat "$cfile" || echo 0)
[ "$pos" -lt "$size" ] || exit 0

unread_text=$(tail -c +$((pos + 1)) "$file")
unread_count=$(echo "$unread_text" | grep -c '' || true)
[ "$unread_count" -gt 0 ] || exit 0

# Per-message body cap (chars). Matches the bus_send body limit
# (MAX_BODY_BYTES in storage.js = 8192 bytes), so any message that
# successfully went through bus_send is delivered in full inline.
# Truncation is now a defensive safety net for messages injected past
# send validation (e.g. via a future direct-write tool), not a routine
# context-saving measure. If a worker is producing huge bodies, the
# right move is still to write to a file and send a path summary —
# but normal-sized briefs and result summaries never get clipped.
#
# Override at install time via CLAUDE_BUS_BODY_CAP if you want a
# tighter context budget per message.
BODY_CAP="${CLAUDE_BUS_BODY_CAP:-8192}"

# Render. node is available in any Claude Code host; use it for safe
# JSON parsing. Falls back to a plain dump if node is somehow missing.
# When a result-kind message contains a TASK ID, we look up the task
# record and prepend a "📋 result for task <id> (was: <brief summary>)"
# header so the orchestrator can't miss the linkage between the reply
# and the original dispatch.
if command -v node >/dev/null 2>&1; then
  rendered=$(node -e '
    const fs = require("fs");
    const path = require("path");
    const root = process.env.HOME + "/.claude-bus";
    const tasksDir = path.join(root, "tasks");
    const text = fs.readFileSync(0, "utf8");
    const cap = parseInt(process.argv[1], 10);
    const lines = text.split("\n").filter((l) => l.length);
    const out = [];

    function loadTask(id) {
      try {
        const raw = fs.readFileSync(path.join(tasksDir, id + ".json"), "utf8");
        return JSON.parse(raw);
      } catch { return null; }
    }
    function relativeAge(iso) {
      if (!iso) return "?";
      const ms = Date.now() - new Date(iso).getTime();
      const mins = Math.round(ms / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.round(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return `${Math.round(hrs / 24)}d ago`;
    }

    for (const l of lines) {
      let m;
      try { m = JSON.parse(l); } catch { out.push("  (malformed line skipped)"); continue; }
      const body = String(m.body ?? "");

      // Task linkage: if this is a result with a TASK ID line, prepend
      // a callout that the orchestrator can use to correlate the reply
      // with the original dispatch without scanning chat scrollback.
      let callout = "";
      if (m.kind === "result") {
        const idMatch = body.match(/^TASK ID:\s*(tsk-[a-z0-9-]+)\s*$/m);
        if (idMatch) {
          const t = loadTask(idMatch[1]);
          if (t) {
            const summary = String(t.brief_summary || "")
              .replace(/\s+/g, " ").slice(0, 100);
            callout = `📋 result for task ${t.id} — was: "${summary}" — spawned ${relativeAge(t.spawned_at)}, worker: ${t.worker_name}\n`;
          }
        }
      }

      const trimmed = body.length > cap
        ? body.slice(0, cap) + ` … [truncated, ${body.length - cap} more chars; bus_inbox(peek:true) for full]`
        : body;
      out.push(
        callout +
        `--- from ${m.from} • kind=${m.kind} • id=${m.id}` +
        (m.reply_to ? ` • reply_to=${m.reply_to}` : "") +
        ` ---\n${trimmed}`
      );
    }
    process.stdout.write(out.join("\n\n"));
  ' "$BODY_CAP" <<< "$unread_text")
else
  rendered="$unread_text"
fi

# Advance cursor — these messages are now considered delivered.
echo -n "$size" > "$cfile"

cat <<EOF
${prefix}claude-bus inbox for '$name' — $unread_count new message(s) below. The bodies are already in your context; you do NOT need to call bus_inbox unless you want to re-read or peek.

$rendered
EOF
