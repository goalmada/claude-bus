#!/usr/bin/env bash
# claude-bus async background poller. Runs as an asyncRewake Stop hook:
# after the model finishes a turn, this script runs in the background and
# waits for new mail. When something arrives, it renders the messages
# inline (so the orchestrator can act without an extra bus_inbox call),
# advances the cursor, and exits with code 2 to wake the model.
#
# Wakes the model on EITHER of two conditions:
#   1. New bytes appeared in the inbox file (poll-based detection)
#   2. The cursor is behind the file size (i.e. there is unread mail
#      that NEVER got delivered — e.g. arrived between the prior turn's
#      UserPromptSubmit hook and Stop hook). This catches the race that
#      caused silent-deafness in earlier versions.
#
# Tunables (env):
#   CLAUDE_BUS_WAIT_SECONDS   max wait before timing out cleanly
#                              (default 21600 = 6 hours; was 1800 = 30 min,
#                              raised because real fan-outs idle longer
#                              than 30 min and the previous default left
#                              orchestrators silently deaf to mail
#                              arriving past that window).
#   CLAUDE_BUS_POLL_SECONDS   poll interval (default 3)
#   CLAUDE_BUS_NOTIFY         if non-empty, fire a macOS notification on
#                              every wake AND on timeout (so the user is
#                              told when the watcher disengages).

set -euo pipefail

root="${HOME}/.claude-bus"

name="${CLAUDE_BUS_NAME:-}"
if [ -z "$name" ]; then
  active="$root/active/$PPID.txt"
  [ -f "$active" ] && name="$(cat "$active" 2>/dev/null || true)"
fi
[ -n "$name" ] || exit 0

file="$root/inbox/$name.jsonl"
cfile="$root/cursor/$name.txt"

[ -f "$file" ] || : > "$file"

max_wait="${CLAUDE_BUS_WAIT_SECONDS:-21600}"
poll="${CLAUDE_BUS_POLL_SECONDS:-3}"
elapsed=0

# Helper: fire a passive macOS notification if the user opted in.
notify() {
  [ -n "${CLAUDE_BUS_NOTIFY:-}" ] || return 0
  local title="$1"
  local message="$2"
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"${message//\"/\\\"}\" with title \"${title//\"/\\\"}\"" >/dev/null 2>&1 || true
  fi
}

while true; do
  size=$(wc -c < "$file" 2>/dev/null | tr -d ' ' || echo 0)
  pos=$([ -f "$cfile" ] && cat "$cfile" || echo 0)

  # Wake whenever the cursor is behind file size — i.e. there is
  # genuinely unread mail. This catches both new arrivals and pre-
  # existing un-delivered mail (the silent-deafness case).
  if [ "$pos" -lt "$size" ]; then
    rendered=$("$(dirname "$0")/_render-inbox.sh" "$name" "" || true)
    if [ -n "$rendered" ]; then
      notify "claude-bus" "$name received new mail"
      echo "$rendered"
      exit 2
    fi
    # _render-inbox saw nothing (lost a race with a concurrent reader).
    # Fall through to sleep and try again.
  fi

  if [ "$elapsed" -ge "$max_wait" ]; then
    notify "claude-bus" "stopped watching '$name' after ${max_wait}s — submit any prompt to re-arm"
    exit 0
  fi

  sleep "$poll"
  elapsed=$((elapsed + poll))
done
