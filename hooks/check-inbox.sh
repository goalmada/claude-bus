#!/usr/bin/env bash
# claude-bus UserPromptSubmit hook.
#
# Runs before each user prompt is sent to the model. If the current session
# (identified by CLAUDE_BUS_NAME) has unread messages, prints a short
# system-reminder that Claude Code appends to the prompt context.
#
# Install by adding to ~/.claude/settings.json:
#   {
#     "hooks": {
#       "UserPromptSubmit": [
#         { "hooks": [{ "type": "command", "command": "/Users/YOU/Desktop/claude-bus/hooks/check-inbox.sh" }] }
#       ]
#     }
#   }

set -euo pipefail

root="${HOME}/.claude-bus"

# Identity resolution: env var (terminal flow) → active/<PPID>.txt (Mac app
# flow, written by bus_claim). Silently no-op if neither is set.
name="${CLAUDE_BUS_NAME:-}"
if [ -z "$name" ]; then
  active="$root/active/$PPID.txt"
  [ -f "$active" ] && name="$(cat "$active" 2>/dev/null || true)"
fi
[ -n "$name" ] || exit 0

file="$root/inbox/$name.jsonl"
cfile="$root/cursor/$name.txt"

[ -f "$file" ] || exit 0
size=$(wc -c < "$file" | tr -d ' ')
pos=$([ -f "$cfile" ] && cat "$cfile" || echo 0)
[ "$pos" -lt "$size" ] || exit 0

unread=$(tail -c +$((pos + 1)) "$file" | grep -c '' || true)
senders=$(tail -c +$((pos + 1)) "$file" | sed -n 's/.*"from":"\([^"]*\)".*/\1/p' | sort -u | paste -sd "," -)

echo "<system-reminder>claude-bus: $unread unread message(s) for '$name' from: ${senders:-unknown}. Call bus_inbox() to read them.</system-reminder>"
