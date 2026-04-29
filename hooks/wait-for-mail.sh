#!/usr/bin/env bash
# claude-bus async background poller. Runs as an asyncRewake Stop hook:
# after the model finishes a turn, this script runs in the background and
# waits for new mail. When something arrives, it renders the messages
# inline (so the orchestrator can act without an extra bus_inbox call),
# advances the cursor, and exits with code 2 to wake the model.
#
# Tunables (env):
#   CLAUDE_BUS_WAIT_SECONDS   max wait before timing out cleanly (default 1800)
#   CLAUDE_BUS_POLL_SECONDS   poll interval (default 3)

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

# Anchor on size at hook-start so we only react to NEW arrivals.
start_size=$(wc -c < "$file" | tr -d ' ')

max_wait="${CLAUDE_BUS_WAIT_SECONDS:-1800}"
poll="${CLAUDE_BUS_POLL_SECONDS:-3}"
elapsed=0

while [ "$elapsed" -lt "$max_wait" ]; do
  sleep "$poll"
  elapsed=$((elapsed + poll))

  size=$(wc -c < "$file" 2>/dev/null | tr -d ' ' || echo 0)
  if [ "$size" -le "$start_size" ]; then
    continue
  fi

  pos=$([ -f "$cfile" ] && cat "$cfile" || echo 0)
  if [ "$pos" -ge "$size" ]; then
    # A concurrent user-prompted turn already consumed the new mail.
    start_size="$size"
    continue
  fi

  rendered=$("$(dirname "$0")/_render-inbox.sh" "$name" "" || true)
  if [ -n "$rendered" ]; then
    echo "$rendered"
    exit 2
  fi

  # _render-inbox saw nothing (e.g. lost a race) — keep waiting.
  start_size="$size"
done

exit 0
