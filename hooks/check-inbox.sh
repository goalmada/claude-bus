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

name="${CLAUDE_BUS_NAME:-}"
[ -n "$name" ] || exit 0

root="${HOME}/.claude-bus"
file="$root/inbox/$name.jsonl"
cfile="$root/cursor/$name.txt"

[ -f "$file" ] || exit 0
size=$(wc -c < "$file" | tr -d ' ')
pos=$([ -f "$cfile" ] && cat "$cfile" || echo 0)
[ "$pos" -lt "$size" ] || exit 0

unread=$(tail -c +$((pos + 1)) "$file" | grep -c '' || true)
senders=$(tail -c +$((pos + 1)) "$file" | sed -n 's/.*"from":"\([^"]*\)".*/\1/p' | sort -u | paste -sd "," -)

echo "<system-reminder>claude-bus: $unread unread message(s) for '$name' from: ${senders:-unknown}. Call bus_inbox() to read them.</system-reminder>"
