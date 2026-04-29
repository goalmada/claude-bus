#!/usr/bin/env bash
# claude-bus UserPromptSubmit hook.
#
# Runs before each user prompt is sent to the model. If the current session
# (identified by CLAUDE_BUS_NAME or active/<PPID>.txt) has unread mail,
# prints a system-reminder block with the FULL message bodies (truncated
# to a safe per-message size) so the model can act without a separate
# bus_inbox call. Advances the cursor as part of delivery.

set -euo pipefail

root="${HOME}/.claude-bus"

name="${CLAUDE_BUS_NAME:-}"
if [ -z "$name" ]; then
  active="$root/active/$PPID.txt"
  [ -f "$active" ] && name="$(cat "$active" 2>/dev/null || true)"
fi
[ -n "$name" ] || exit 0

reminder=$("$(dirname "$0")/_render-inbox.sh" "$name" "" || true)
[ -n "$reminder" ] || exit 0

echo "<system-reminder>$reminder</system-reminder>"
