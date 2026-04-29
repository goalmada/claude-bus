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
if command -v node >/dev/null 2>&1; then
  rendered=$(node -e '
    const text = require("fs").readFileSync(0, "utf8");
    const cap = parseInt(process.argv[1], 10);
    const lines = text.split("\n").filter((l) => l.length);
    const out = [];
    for (const l of lines) {
      let m;
      try { m = JSON.parse(l); } catch { out.push("  (malformed line skipped)"); continue; }
      const body = String(m.body ?? "");
      const trimmed = body.length > cap
        ? body.slice(0, cap) + ` … [truncated, ${body.length - cap} more chars; bus_inbox(peek:true) for full]`
        : body;
      out.push(
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
