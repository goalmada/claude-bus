#!/usr/bin/env bash
# claude-bus background poller. Runs as an asyncRewake Stop hook: after
# the model finishes a turn, this script runs in the background and waits
# for new mail to arrive in this session's inbox. If something arrives,
# it exits with code 2 — Claude Code interprets that as "wake the model
# and inject this stdout as a system-reminder."
#
# This is the difference between "you have to nudge the orchestrator
# every time you want it to check the inbox" and "the orchestrator wakes
# up automatically when a worker reports back."
#
# Tunables (env):
#   CLAUDE_BUS_WAIT_SECONDS   max wait before timing out cleanly (default 1800)
#   CLAUDE_BUS_POLL_SECONDS   poll interval (default 3)

set -euo pipefail

root="${HOME}/.claude-bus"

# Resolve identity: env first, then per-session active file.
name="${CLAUDE_BUS_NAME:-}"
if [ -z "$name" ]; then
  active="$root/active/$PPID.txt"
  [ -f "$active" ] && name="$(cat "$active" 2>/dev/null || true)"
fi
# Sessions that aren't on the bus get no daemon. Silent exit.
[ -n "$name" ] || exit 0

file="$root/inbox/$name.jsonl"
cfile="$root/cursor/$name.txt"

[ -f "$file" ] || : > "$file"

# Anchor: only mail that arrives AFTER this point counts as a wake signal.
# Mail already there when the hook started would cause a useless wake-loop.
start_size=$(wc -c < "$file" | tr -d ' ')

max_wait="${CLAUDE_BUS_WAIT_SECONDS:-1800}"
poll="${CLAUDE_BUS_POLL_SECONDS:-3}"
elapsed=0

while [ "$elapsed" -lt "$max_wait" ]; do
  sleep "$poll"
  elapsed=$((elapsed + poll))

  size=$(wc -c < "$file" 2>/dev/null | tr -d ' ' || echo 0)
  if [ "$size" -le "$start_size" ]; then
    continue   # nothing new yet
  fi

  # Something was appended. Check if it's actually unread (the model may
  # have read it during a concurrent user-prompted turn).
  pos=$([ -f "$cfile" ] && cat "$cfile" || echo 0)
  if [ "$pos" -ge "$size" ]; then
    # Model already consumed it. Re-anchor and keep waiting.
    start_size="$size"
    continue
  fi

  unread=$(tail -c +$((pos + 1)) "$file" | grep -c '' || true)
  senders=$(tail -c +$((pos + 1)) "$file" \
    | sed -n 's/.*"from":"\([^"]*\)".*/\1/p' \
    | sort -u | paste -sd "," -)

  echo "$unread new message(s) for '$name' from: ${senders:-unknown}. Call bus_inbox() to read them."
  exit 2
done

# Timed out, no mail. Clean exit.
exit 0
