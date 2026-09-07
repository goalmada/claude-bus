# Personal subscription queue (opt-in preparation)

This separate command prepares bounded local review jobs for the official Claude Code CLI. It does not modify the existing bus server, hooks, terminal workers, or dashboard. There is no daemon, automatic queue drain, model call on installation, or fallback executor. Real launches are disabled by default. The initial scope is a tool-free review of content supplied over stdin, not autonomous code editing.

## Decision and limits

A structured subprocess was selected over terminal screen detection. Final JSON and process exit status can distinguish failure from a report without guessing from an idle terminal. The existing bus executor is left alone because changing its defaults would affect current users. This module uses no external packages.

The public repository contains generic code, synthetic tests, and this design. Never commit real task descriptions, results, account identifiers, verification records, or credentials here. State belongs under `~/.local/state/claude-personal-queue`, outside any Git checkout, owned by the current user with mode 0700. State files use mode 0600 and atomic, synced replacement. Existing overly permissive directories are rejected rather than silently changed.

There is one executor slot across the queue. Synchronous state transactions use an exclusive directory lock. Duplicate keys return the existing task only when all input fields match. A stale transaction lock fails closed and requires inspection. A persisted launch intent prevents silent retries after a supervisor crash. This provides at-most-once automatic launch attempts, not proof of exactly-once remote execution.

## Use the local command

Run the command from this branch checkout. No installation into an active bus is required.

```sh
node bin/personal-queue list
```

`submit` reads JSON from stdin. Required fields: `key` (idempotency key), `sourceTask` (originating coordinator task identifier), `worktree`, `baseSha` (full commit hash), and `brief`. Optional `timeoutMs` defaults to 300000 and cannot exceed 600000. Briefs are limited to 128 KiB. Use a fresh, clean linked Git worktree pinned to the intended commit. The primary checkout is rejected. Prepare the bounded diff and relevant compiled context before submission; the executor receives only the supplied brief and cannot read files itself.

The coordinator invokes `run <id>` once. `list` and `status <id>` return summary metadata, without task content or account details. Full results remain in private `queue.json`. `cancel <id>` cancels queued jobs immediately and asks the owning supervisor to interrupt running jobs. After 500 ms, the supervisor kills the owned process group if needed. The launch deadline also uses this termination path. Nothing searches for or kills other workers.

```sh
node bin/personal-queue status TASK_ID
```

There is no network listener, dashboard publishing, automatic resumption, or paid extraction/matching. A future private dashboard adapter should project deterministic state from this queue only after its access controls and availability are verified.

## Native account verification gate

As checked in the official documentation on 2026-09-07, the proposed June 15 separation of programmatic subscription usage was paused. This is not free API access: programmatic requests consume the subscription allowance. See [the subscription update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and [authentication precedence](https://code.claude.com/docs/en/authentication).

Before any real run, verify the intended native Max account using `/status` and `/usage` in the user's normal login context. Confirm remaining allowance and disable extra usage. Record the observed time windows, not an invented token balance. Use native `/login` if login is unavailable. Never extract or copy tokens from Keychain, environment variables, terminal services, or credential files.

Only after that check, an operator can create `native-max-verification.json` inside the private queue directory with mode 0600. It must contain `enabled: true`, `plan: "max"`, `extraUsageEnabled: false`, `available: true`, `checkedAt` (current ISO timestamp), `organizationId` (the verified subscription organization UUID), and `evidence` (a concise description of the native account/usage check). Do not include credentials. No enabling file is shipped or created by the command. Verification expires after one hour. Remove it to disable launches.

The launcher starts with a small environment allowlist. It does not inherit OAuth tokens, API keys, billing-provider overrides, or a custom Claude configuration directory. Native CLI authentication must independently succeed. Safe mode disables user customizations; restricted mode, no tools, an empty strict MCP configuration, and a fixed subscription organization constrain the run. Unknown authentication labels fail closed. Authentication schema and native access still need confirmation in the intended login context; fake tests do not establish live subscription access.

Do not use `--bare`: it disables subscription OAuth. The adapter uses flags observed in CLI 2.1.250, avoiding flags documented only for newer versions. Model error, denied tool, limit, missing login, invalid output, or failed preflight stops the job without API or alternate-agent fallback. The account gate is a recent human verification, not a live billing meter or a provider-enforced spending ceiling. If account settings change, revoke the gate and verify again.

## Recovery and independent verification

Lifecycle: `queued`, `launching`, `running`, `reported`, `verified`; exceptional states: `blocked`, `failed`, `cancelled`, `timed_out`, `uncertain`. A successful final JSON result becomes `reported`, never automatically `verified`. Stderr is drained and discarded; output is capped at 1 MiB. Only the final result and limited process metadata are retained. Nonzero exits, malformed output, missing final results and permission denials cannot pass.

`verify <id>` reads JSON containing `reviewer`, `resultHash`, and `evidence` from stdin. The reviewer must inspect the report independently and cite concrete checks. The command binds that record to the exact report hash and rechecks the pinned clean worktree. It records a reviewer attestation, not a semantic proof that the review is correct. The model has no tools or access to this operation.

After a crashed supervisor, invoke `reconcile <id>`. It marks the job uncertain and keeps the executor slot occupied. Inspect the recorded launch identifier, private state, and actual owned process before recovery. The command will not kill a PID from an earlier process lifetime. After independently confirming that the owned process is stopped, `resolve <id>` accepts an evidence record on stdin and marks the attempt failed. Any intentional retry requires a new task key. Never infer completion from a reused PID or an idle terminal.

If a stale `queue.lock` remains, inspect its owner record and confirm that no transaction owner is running before removing only that lock. There is no automatic stale-lock takeover.

## Validation and rollback

```sh
npm run test:personal
```

Tests use temporary Git repositories and Node fake executors only. They exercise deduplication, single-executor admission, cancellation, forced timeout termination, persisted uncertain launch intent, preflight reconciliation, malformed/error output, reviewer-bound verification, private state permissions, native auth rejection and default-disabled behavior. No Claude model call is part of testing.

Rollback: stop new submissions, cancel only adapter-owned work, inspect any uncertain launch, and remove the private verification file. Preserve private results and worktrees for review. Then stop using this branch or revert its commit. Existing bus and terminal workers continue unchanged. Writable execution, automatic scheduling, remote hosting and dashboard integration require separate implementation and verification.

Validation note: the existing `mcp_roundtrip.js` suite intermittently reports three live-peer detection assertion failures. The same failures were reproduced from unchanged `origin/main`; this adapter is not imported by that server. Smoke and claim-flow checks passed, and a complete suite run also passed during preparation. Keep this pre-existing timing issue distinct from the isolated executor tests.
