# Personal subscription queue (opt-in execution)

This separate command prepares bounded local review jobs for the official Claude Code CLI. It does not modify the existing bus server, hooks, terminal workers, or dashboard. Installation makes no model call and provides no fallback executor. An explicitly started bounded worker or separately installed persistent supervisor can select queued tasks. Real launches are disabled by default. Review mode is tool-free. Project mode edits exact assigned files and runs fixed sandboxed Node tests.

## Decision and limits

A structured subprocess was selected over terminal screen detection. Final JSON and process exit status can distinguish failure from a report without guessing from an idle terminal. The existing bus executor is left alone because changing its defaults would affect current users. The queue uses Node built-ins; project tools reuse the repository MCP SDK.

The public repository contains generic code, synthetic tests, and this design. Never commit real task descriptions, results, account identifiers, verification records, or credentials here. State belongs under `~/.local/state/claude-personal-queue`, outside any Git checkout, owned by the current user with mode 0700. State files use mode 0600 and atomic, synced replacement. Existing overly permissive directories are rejected rather than silently changed.

There is one executor slot across the queue. Synchronous state transactions use an exclusive directory lock. Duplicate keys return the existing task only when all input fields match. A stale transaction lock fails closed and requires inspection. A persisted launch intent prevents silent retries after a supervisor crash. This provides at-most-once automatic launch attempts, not proof of exactly-once remote execution.

## Use the local command

Run the command from this branch checkout. No installation into an active bus is required.

```sh
node bin/personal-queue list
```

`submit` reads JSON from stdin. Required fields: `key` (idempotency key), `sourceTask` (originating coordinator task identifier), `worktree`, `baseSha` (full commit hash), and `brief`. Optional `timeoutMs` defaults to 300000 and cannot exceed 600000. Briefs are limited to 128 KiB. Use a fresh, clean linked Git worktree pinned to the intended commit. The primary checkout is rejected. Prepare the bounded diff and relevant compiled context before submission; review mode receives only the supplied brief; project mode can read only its assigned files.

The coordinator invokes `run <id>` once. `list` and `status <id>` return summary metadata, without task content or account details. Full results remain in private `queue.json`. `cancel <id>` cancels queued jobs immediately and asks the owning supervisor to interrupt running jobs. After 500 ms, the supervisor kills the owned process group if needed. The launch deadline also uses this termination path. Nothing searches for or kills other workers.

```sh
node bin/personal-queue status TASK_ID
```

There is no network listener, dashboard publishing, automatic resumption, or paid extraction/matching. A future private dashboard adapter should project deterministic state from this queue only after its access controls and availability are verified.

## Native account verification gate

As checked in the official documentation on 2026-09-07, the proposed June 15 separation of programmatic subscription usage was paused. This is not free API access: programmatic requests consume the subscription allowance. See [the subscription update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and [authentication precedence](https://code.claude.com/docs/en/authentication).

Before any real run, verify the intended native Max account using `/status` and `/usage` in the user's normal login context. Confirm remaining allowance and disable extra usage. Record the observed time windows, not an invented token balance. Use native `/login` if login is unavailable. Never extract or copy tokens from Keychain, environment variables, terminal services, or credential files.

Only after that check, an operator can create `native-max-verification.json` inside the private queue directory with mode 0600. It must contain `enabled: true`, `plan: "max"`, `extraUsageEnabled: false`, `available: true`, `checkedAt` (current ISO timestamp), `organizationId` (the verified subscription organization UUID), and `evidence` (a concise description of the native account/usage check). Do not include credentials. No enabling file is shipped or created by the command. Verification expires after one hour. Remove it to disable launches.

The launcher starts with a small environment allowlist. It does not inherit OAuth tokens, API keys, billing-provider overrides, or a custom Claude configuration directory. Native CLI authentication must independently succeed. Review mode uses safe mode. Project mode uses restricted mode, empty setting sources, disabled hooks and slash commands, zero built-in tools, and only the explicit scoped MCP broker. Safe mode cannot be used for project mode because it disables that broker. Runtime initialization must confirm exactly the expected tool names before a project result is accepted. Both modes fix the verified subscription organization. Unknown authentication labels fail closed. Authentication schema and native access still need confirmation in the intended login context; fake tests do not establish live subscription access.

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

Rollback: stop new submissions, cancel only adapter-owned work, inspect any uncertain launch, and remove the private verification file. Preserve private results and worktrees for review. Then stop using this branch or revert its commit. Existing bus and terminal workers continue unchanged. Remote hosting and machine-to-machine dashboard ingestion remain outside this implementation. The optional local launchd supervisor is documented below.

Validation note: the existing `mcp_roundtrip.js` suite intermittently reports three live-peer detection assertion failures. The same failures were reproduced from unchanged `origin/main`; this adapter is not imported by that server. Smoke and claim-flow checks passed, and a complete suite run also passed during preparation. Keep this pre-existing timing issue distinct from the isolated executor tests.

## Controlled project mode

Two approaches were evaluated: native Read/Edit/Bash with permission and sandbox settings, or explicit scoped tools through the existing MCP SDK. This pilot selects a small MCP broker, leaving all built-in tools disabled. Native commands are convenient but a permitted test command still executes project code; the broker fixes the command and enforces its sandbox independently. It reuses the same queue and native subscription authentication.

Submit `mode: "project"`, an explicit `owner`, and `scope` with exact `read`, `edit`, and `tests` path arrays. Dot paths, parent traversal, node_modules, symlinks and hard-linked files are rejected. Writes require the previous content hash, or null for a new file, and replace content atomically. There is no general terminal, network tool, commit tool, or deploy tool. The coordinator reviews and commits the resulting diff. Another unfinished task cannot claim the same worktree.

The broker exposes `read_file`, `write_file` and `run_tests`. Tests run under macOS sandbox-exec with an explicit Node test list, network denied, no subprocess creation, source read-only, and writes limited to a fresh test temporary directory. Tests that require subprocesses are not supported by this initial profile. Non-macOS hosts fail closed. The test process receives no account environment or home-directory read allowance. The local broker itself is trusted host code, outside the model's edit scope.

Each state mutation records a monotonic per-task revision and timestamped event inside the same synced state transaction. Tool audit records live privately beside the queue, with task and launch IDs, paths, hashes and test exit codes. Full model output remains private. These records are evidence, not an automatic declaration that the task is complete.

`pause` interrupts the owned running process and captures allowed file contents and their hash. `resume` only accepts stopped project attempts with unchanged checkpoints; it keeps the same task/worktree, records the previous attempt and starts a new bounded continuation. This is explicit checkpoint continuation, not automatic replay of an uncertain native session. Original instructions and preserved files provide context. No reset or checkout discards edits. Quota/auth failures remain blocked with no alternate billing route; the same recovery check applies after resolving the cause.

Project verification binds a reviewer record to both the actual result hash and the exact scoped file checkpoint. Changes outside the assigned files become uncertain and retain the executor slot for inspection. A successful test report alone never marks the work verified. Committing or deploying remains a coordinator-owned action after review.

The private dashboard is a separate owner-controlled card projection. The bridge sends a sourced report with task ID, revision, occurrence time, exact execution state and actual versus simulated verification. No concurrent direct dashboard writer or writable HTTP endpoint is introduced. Reported work waits for independent review; cancelled and uncertain work retain those exact states rather than becoming done.

Generate an owner-reviewed dashboard handoff with `handoff <id>` and evidence JSON on stdin. The command returns only the explicit projection fields; it does not publish anything. Queue revisions and occurrence times remain attached. Send that result to the designated dashboard owner, who applies the projection and verifies the displayed card.

Actual integration exercised native subscription project tools, two source writes, fixed sandboxed tests and independent review. An intentional interruption preserved the first edit; a conservatively uncertain attempt was reconciled after checking process absence and continued with the same task/worktree. Two integration defects were corrected: safe mode hid the explicit broker, and read-only state polling contended with the writer lock. Reads now consume atomically replaced snapshots. Private execution identities and evidence remain outside this public document.

## Reviewed project commands

The coordinator can use `approve-check <id>` with JSON containing `recipe`, `reviewer`, and concrete `evidence`, then `check <id>`. Supported recipes are `npm-test` and `npm-build`. Approval binds the unchanged base commit, scoped file checkpoint and exact package script. Build outputs can be explicitly limited to `dist`, `build`, or `.next`; tests cannot write project directories. Dependencies must already be installed. No package installation or network access is granted.

The command runs under a separate macOS sandbox with selected child executables, private temporary writes, a two-minute limit and bounded output. Cancellation or timeout leaves an uncertain state for process reconciliation. A synthetic npm fixture demonstrated actual shell/Node subprocess execution. This repository's complete suite does **not** pass inside that profile: Git fixture creation and nested sandbox setup are blocked. No general project compatibility or real application build is claimed. This is a selected-command boundary, not a VM or a general shell for model-generated programs.

The full repository suite passed when run independently by the coordinator outside the outer sandbox. When a project needs that separate review path, `verify` accepts an explicit `independentCheck` attestation with zero `code`, the exact `checkpointHash`, retained output's SHA-256 `outputHash`, and concrete `evidence`. It preserves the failed sandbox result and labels the separate record `coordinator_attestation`. The native executor cannot issue approvals or verification. An attestation is the coordinator's assertion backed by retained output, not a cryptographic proof or a successful sandbox run.

## Dispatch and bounded work

`dispatch` selects the oldest queued task once. An occupied or uncertain executor slot blocks selection; any reported result waits for coordinator review. Stopped tasks are never resumed automatically. `work` accepts JSON on stdin with optional `maxJobs` (1 to 20), `maxRunMs` (100 to 1800000), and `pollMs` (25 to 5000). Defaults are five launches and fifteen minutes. It polls for queued work and completed review, then exits at its bound. Interrupting it stops only the task it claimed. Authentication, quota and uncertain launch failures stop it without changing billing routes.

The subscription gate must still be fresh for every launch. The worker never renews quota evidence, retrieves credentials or silently resumes paused tasks. `resume` remains an explicit coordinator action after checkpoint and process checks. No background service is installed by this command.

Native subscription execution produced the dispatcher and its tests in an actual linked project worktree. Both the native tool and coordinator passed the assigned 33 tests. The coordinator also passed the repository suite independently before committing. A further actual native project review ran through `workQueue` and `dispatchNext`, stopped after its one-job bound, and rejected concurrent execution. Its findings were independently assessed; stop-error reporting and retained wait reasons were strengthened. Dispatcher ordering and injected lifecycle failures are tested with simulated queue/executor state. A sustained multi-job native queue drain has not been demonstrated. These are separate claims.

## Persistent local supervision

Two designs were compared: keeping the native subprocess inside one persistent supervisor, or giving each execution a separate durable runner. The separate runner was selected because a supervisor restart can reconnect to the same native execution without reconstructing or repeating a model call.

`python3 scripts/install-personal-service.py` installs the explicitly authorized launchd agent. Installation preserves authentication and launch allowance. `serve` observes the queue every two seconds; each launch first consumes a durable authorization and records runner intent in the same queue transaction. The runner records its PID and process birth before claiming the task. On reconnect, the supervisor matches that identity and observes the existing runner. Missing identities and ambiguous launches become uncertain rather than being retried. A stale queue write lock remains a manual inspection case; brief normal contention waits up to 500 milliseconds.

`service-config` accepts private JSON `{ "authorizationId": "unique-approval-id", "enabled": true, "launches": 5, "evidence": "Concrete existing authorization" }`. This grants at most five launch attempts, not five successful results. No timer replenishes it. Native account and capacity evidence still expire after one hour; the service cannot refresh those facts itself. A capacity rejection or authentication/billing retry event stops execution without another billing path. Reported work blocks the next task until independent review. Paused tasks require explicit `resume`. `cancel` targets the recorded task through its living runner, including after supervisor reconnect.

`service-status` reports supervisor state and remaining authorizations. `result <id>` accepts exact `owner` and `sourceTask` on stdin and returns a complete reported/verified result for coordinator review. This ownership check prevents accidental routing; it is not a security boundary between processes owned by the same OS user. Full results and file checkpoints remain private. A separate supported coordinator wakeup mechanism must read these results and perform review; this Node service does not invent a Codex control API or automatically approve code.

The event producer writes immutable `<taskId>.<revision>.json` records in the private `events` directory. Consumers approve an exact local mapping of task identity to personal/company scope and project. Unknown tasks are held. The public event schema is generated by `npm run build`. Independently verified events bind the exact verification revision and result hash; automatic dashboard completion requires that evidence. Consumer cursors and projections belong in private durable state, never public Git. Lifecycle summaries never include results, prompts, credentials or account identifiers.

Actual local service verification: a native project task wrote its first schema file, paused with a retained checkpoint, and stayed paused across supervisor restart. Explicit continuation preserved the task/worktree. A second supervisor restart during native execution retained the same native PID and launch identity. The native task passed nine assigned tests, then a reviewed `npm-build` generated the event schema inside the sandbox. The coordinator independently read the artifact and checked its exact structure and deterministic bytes. The separate dashboard consumer automatically projected the verified revision as done. An additional native child launch was explicitly cancelled through the queue.

Supported real project/build scope is this repository's schema artifact and assigned pure Node tests. The generic npm child-process fixture also passes. This repository's full suite still requires coordinator-host validation because its nested sandbox and Git fixtures are incompatible with the outer sandbox. No universal application build, container isolation, remote orchestration or unattended semantic review is claimed.

Rollback: disable new service launches with `service-config` and zero allowance when no runner is owned, or remove the private launch gate immediately. Cancel owned tasks and inspect uncertainty. Boot out `com.goalmada.claude-personal-queue` from the user's launchd domain; remove its LaunchAgents plist to prevent the next login starting it. Stopping only the supervisor intentionally leaves a live runner intact for reconnection. Preserve private queue/events and worktrees for investigation. Existing bus workers remain unchanged.

## Diagnosing queued tasks before consuming an authorization

The service and native launcher share one pure gate evaluator. A queued task with missing, malformed, disabled, unavailable, future-dated or expired native verification remains queued and consumes no service authorization. File ownership, permissions, links and parsing are checked before use. The one-hour lifetime and native Max-only route are unchanged.

`service-status` includes `nativeGate: { ok, reason }` evaluated at read time. It never returns the gate record, organization identity or evidence text in that field. The service outcome distinguishes `native_gate_expired`, `native_gate_missing`, `native_gate_invalid`, `native_gate_unsafe_file`, `launch_authorization_exhausted` and `executor_identity_uncertain`. An occupied runner or pending independent review still takes priority over new launches. A finite allowance is never replenished automatically, and gate inspection never signs in or invokes a model.

Actual native Max work produced the shared evaluator and eighteen tests using the final existing launch authorization. The coordinator independently read both files and reran the tests, replaced one date-dependent assertion, then integrated the file checks and before-reservation gate. Integration tests verify blocked tasks retain their status/allowance and distinguish expired verification from exhausted authorization and identity recovery. No extra launch was granted for validation.

## Separate authorization batches

Each `service-config` request must carry a stable `authorizationId` for the actual approval. Repeating the same current ID and terms returns its existing remaining allowance, even while a runner is active. It does not reset the count. Changing the terms under that ID or reusing a historical ID is rejected.

A new batch records the previous batch's ID, limit, unused remainder, evidence and timestamps in private `authorizationHistory`. It cannot replace a positive unused remainder or an unfinished runner. An explicit disabled zero-allowance request can revoke an unused remainder and preserves that remainder in history. Legacy approvals without an ID require coordinator migration before a named batch; existing evidence must not be discarded.

Runner reservations carry their authorization ID into the task and preserved attempts. The live `remaining` count stays authoritative; historical records preserve the original counters. A new explicit approval never increases concurrency or grants more than five attempts. No automatic renewal or increase is introduced.

The first useful task of a separately approved five-attempt trial used actual native Max to write the pure history/replay helper and eleven tests. Native execution took about114 seconds and passed its tests. The coordinator independently reran them, then hardened malformed-counter and explicit-revocation cases before integration. Those review corrections are why native success alone is not the release gate. The previous trial's five consumed attempts remain separately recorded; this task consumed one attempt in the new trial.
