# Coordination reliability

A live worker that had finished its work and was waiting for a coordinator was advertised as
merely "working", because its process was still alive. Nothing durable said "this is ready for
review", nothing told the coordinator, and nothing noticed when a review was never picked up.
This change closes that gap inside the existing personal queue.

## Decision: extend the queue, do not add a second mechanism

Two designs were compared.

A parallel monitor process with its own store would have been independent of the queue, but it
would need its own lock, its own crash recovery and its own copy of process identity, and its
answer could disagree with the queue that actually owns the work. Two sources of truth about
"is this task waiting for me" is the defect, not the fix.

Extending the queue was selected. Coordination is derived from facts the queue already holds
and written inside the same synced transaction, next to the record it describes. There is no
second queue, no second lock, no new daemon and no new scheduler. The legacy `status` field is
never rewritten by this feature, so every existing command, event and test keeps its meaning.

## Coordination states

`job.coordination.state` and `externalLaunch.coordination.state` are one of:

| State | Meaning |
| --- | --- |
| `running` | An owned process is confirmed alive by PID plus birth, and it has shown progress inside the stale threshold. |
| `needs_review` | Work is ready for a coordinator. It carries the exact full Git SHA, the result, artifact or checkpoint digest, an evidence reference, the owner and coordinator identities, and the observed timestamp. |
| `approved` | A registered coordinator approved that exact revision, SHA and digest. |
| `deploying` | A registered coordinator started deployment against a current approval. |
| `verified` | A registered coordinator recorded independent evidence at the exact approved revision. |
| `blocked` | An explicit outcome that needs a person: unexpected exit, PID reuse, missing or unprovable identity, stale running, a stopped executor state, or a settled record whose process is still alive. |

A subject with no active coordination claim (queued work, historical settled launches) has a
`null` state rather than an invented one.

Priority is the point of the change. Review readiness is evaluated **before** any liveness
fact, so a worker that published readiness while its process is still alive reads as
`needs_review`, never as `running`. The same holds for a process that already exited: the
readiness record, not the corpse, decides. Legacy `reported` maps to `needs_review`, with the
SHA, result hash or checkpoint hash, launch reference, owner and coordinator projected from
what the queue already stored.

Two record kinds are coordination subjects, tracked where they already live:

- `state.jobs[]`, the legacy queue tasks executed through `queue.run`.
- `state.service.externalLaunches[]`, the officially routed direct native launches.

External records are normalized in place. They are never cloned into duplicate jobs. Unknown
or missing fields stay `null` instead of being guessed, and a record without an assigned
worktree is treated as work that expects no review (`reviewRequired: false` by default), which
is what keeps existing image and utility launches quiet.

## Process identity and progress

Identity is the pair (PID, process birth), never a PID alone. `queue.run` now records
`job.process = { pid, birth, startedAt }` when the child spawns. Reconciliation compares the
recorded birth with a fresh `/bin/ps` observation and produces:

`confirmed`, `starting` (inside a 10 second grace), `exited`, `reused` (a different birth for
the same PID), `missing` (an active status with no PID past the grace) or `unprovable` (a live
PID with no recorded birth, so it cannot be attributed to this launch).

Everything except `confirmed` and `starting` becomes an explicit `blocked` coordination
outcome for an active subject. Nothing is relaunched, nothing is killed, and no PID is
signalled on the basis of an inference.

A living process is not progress. Staleness is measured from the last meaningful event:
launch, runtime initialization, a provider capacity observation, a published progress note, a
status transition or completion. Ordinary metadata rewrites, including this feature's own
coordination bookkeeping, are excluded on purpose, so a quiet process cannot look busy just
because its record was touched. The threshold is `staleAfterMs` (default 900000 ms) and the
clock is injected in tests.

## Artifact binding and approval invalidation

An approval binds the coordinator identity, the exact full SHA, the result, artifact or
checkpoint digest, the review revision and the evidence. It is re-checked against what the
assigned worktree actually contains right now, so it dies on a real change even when the
worker never republishes anything:

- `head_moved`: the worktree HEAD is no longer the approved commit.
- `worktree_modified`: uncommitted changes exist for non checkpoint bound work.
- `checkpoint_changed`: the scoped checkpoint digest no longer matches.
- `artifact_unobservable:<reason>`: the assigned worktree cannot be read. Uncertainty
  invalidates an approval rather than preserving it.
- `review_sha_changed`, `review_digest_changed`, `review_revision_changed`: the worker
  published a different readiness record.

Observation is bounded to the assigned worktree path, is read only, runs `git rev-parse HEAD`
and `git status --porcelain`, and never executes anything supplied by a task. A stale approval
returns the subject to `needs_review` with the reason attached, and `coord-deploy` and
`coord-verify` refuse. A legacy `verify` record stays authoritative as a historical fact only
while its artifact is unchanged; after a later change it reads
`legacy_verification_stale:<reason>`, because it verified the old artifact and not the new one.

## Notifications: outbox, transport seam and acknowledgement

Every meaningful transition enqueues at most one durable notification inside the same
transaction, plus exactly one overdue alert per entry into `needs_review` once 120000 ms have
passed. Deduplication is on `(subject, reason, coordination signature)`, where the signature
contains the state, the reason, the SHA, the digest and the review revision. An unchanged
failure observed on every reconciliation is enqueued once. A durable dedupe index is kept
separately from the records, so retention trimming, an acknowledgement or a restart cannot
resurrect an alert about an unchanged, still active failure.

The lifecycle is deliberately pessimistic about what counts as delivery:

| Field | Meaning |
| --- | --- |
| enqueued | Written durably in the queue. Nothing was delivered. |
| `publishedAt` | Mirrored into the private `notifications/` directory beside `events/`. Availability for a consumer, still not delivery. |
| `deliveredAt`, `deliveredTo` | A registered coordinator confirmed it received the record. |
| `ackedAt`, `ackedBy`, `ackNote` | A registered coordinator confirmed it acted on the record. |

**The transport seam is the existing root heartbeat `seguimiento-de-proyectos`, which already
runs every two minutes.** No scheduler, timer or application API is introduced by this change.
The heartbeat is the consumer and calls the CLI:

```sh
node bin/personal-queue coordination-reconcile        # derive states, enqueue alerts, mirror files
node bin/personal-queue notifications                 # pending records, safe metadata only
echo '{"coordinatorId":"...","coordinatorToken":"...","ids":["..."],"transport":"seguimiento-de-proyectos"}' \
  | node bin/personal-queue coord-notify-delivered
echo '{"coordinatorId":"...","coordinatorToken":"...","ids":["..."],"note":"private:review/started"}' \
  | node bin/personal-queue coord-notify-ack
```

An unacknowledged outbox record is not a delivered message and must never be reported as one.
The installed service loop calls the same reconciliation every two seconds, which only makes
the same derived facts available sooner.

Alert metadata is restricted by construction to identifiers, hashes, short references and
timestamps. Briefs, results, checkpoints, prompts, evidence text and credentials are never
copied into a notification or its mirrored file.

## Roles: who may do what

The executor surface is `ready` and `progress`. A worker may publish that its work is ready
for review, with its own ownership, exact SHA and digest, and it may publish progress. It has
no approval, deployment, verification, routing or acknowledgement path at all: those functions
live in `src/personal/coordinator.js`, which no worker facing module imports.

Coordinator commands require a role proof. `coordinators.json` in the private queue directory
lists `{ id, label, tokenHash }`, where `tokenHash` is the SHA-256 of a secret the coordinator
holds outside the queue directory. The roster stores hashes only, so reading it does not let a
worker forge an approval, and the comparison is constant time. Approval and verification also
refuse when the caller is the subject's own owner.

**Documented limitation: the same operating system user is not a security boundary.** Anything
running as this user can read this process's memory and arguments, and can read the operator's
own token file if it is stored under the same home directory. The roster is a real control
against accidental or tool-mediated self approval, and an audit record of who approved what.
It is not isolation. Separate accounts, or a coordinator on another host, are the only real
isolation. A worker supplied reviewer string alone is explicitly insufficient and is rejected.

## Launch admission and the routing policy

One shared helper admits every launch route: the installed legacy service runner, a direct
`queue.run` dispatch and an officially routed native launch. Counting and reserving happen
inside the existing queue transaction lock, so the bound is atomic across processes. Slot keys
deduplicate the same work seen through different ledgers, so a service runner, the job it owns
and an external record naming that task are one slot rather than three.

Two regimes coexist, and which one applies is a recorded fact:

**Legacy**, when no routing policy is recorded. One executor at a time, unless a coordinator
explicitly recorded a higher bound, and never more than five. Finite
`service.externalAuthorizations` entries are consumed exactly once and never refilled.

**Routed**, under an operator approved `service.routingPolicy` with mode `authorized_tasks`
and provider `official_native_claude_max`. There is no fixed worker cap and no trial launch
counter: `fixedWorkerCap` and `fixedTrialLaunchCap` are `null`, and no ceiling of five is
invented. A routed reservation cites the policy id and the authorized task identity, and it
does not decrement any obsolete trial counter. The real bound is the recorded machine
capacity, and it fails closed:

- capacity missing: the serial legacy bound applies, reported as `routed_capacity_unrecorded`.
- capacity `uncertain: true`, malformed, expired against its `ttlMs`, or dated in the future:
  admission refuses until the machine is observed again.

Open ended routing is not unauthenticated launching. A reservation still requires an owner
identity, an authorized task identity, a unique task identity, the recorded policy and, for
review bearing work, an isolated worktree. Ownership, idempotency, exact revision independent
review and process reconciliation are unchanged.

Occupancy cannot be bypassed. A task identity holds exactly one slot, a duplicate reservation
for an identity that is already reserved or running is rejected atomically inside the same
transaction, and a caller can release only its own reservation: a claim drops a slot solely
when that slot comes from exactly the caller's reservation kind, so a duplicate record under
the same task identity is never hidden behind someone else's reservation. A worker moving its own record to `finished` or `verified` does not release the slot
while its recorded process is still confirmed alive: that record is reported as occupied and
uncertain, and its coordination state becomes `blocked`. Only an observed exit or a proper
finalization releases a slot, and unfinished or ambiguous legacy records are conservatively
counted as occupied and never cleaned up automatically.

Finalizers re-read under the lock and write only their own record. They never rewrite the
service object, never enable the service and never refill an authorization, so a concurrent
ledger update from the images launcher survives.

## Migration of existing state

Nothing is rewritten in place, and every counter that already exists stays as recorded.

| Key | Migration |
| --- | --- |
| `service.remaining`, `service.launchLimit`, `service.authorizationId`, `service.authorizationHistory` | Untouched historical facts of the legacy service route. Never refilled, never reinterpreted as a live allowance for the routed path. |
| `service.externalAuthorizations[]` | Preserved. The earlier single launch entry stays consumed with `remaining: 0` and keeps its `consumed` list. |
| `service.externalLaunches[]` | Preserved and extended in place with `coordination`, `review`, `progressAt`, `policyId` and `reviewRequired`. Records with `finishedAt` or `exit` older than the 24 hour adoption window and without a coordination record are skipped entirely, so adopting this feature does not raise alerts about historical work. |
| `service.routingPolicy` | Read if present. `coord-routing-policy` records a new one and pushes the previous one into `service.routingPolicyHistory`. Retired policy identifiers cannot be reused. |
| `service.machineCapacity` | New, optional, coordinator recorded. Previous records are preserved in `service.machineCapacityHistory`. |
| `service.concurrency` | New, optional, coordinator recorded, with `service.concurrencyHistory`. |
| `state.notifications`, `state.notificationIndex` | New. Created empty on first use. |
| `job.coordination`, `job.review`, `job.process`, `job.progressAt` | New per task fields. Absent on old records and derived on the next reconciliation. |

Backwards compatibility: with no routing policy and no new configuration, the effective limit
is the historical serial one, `queue.run` refuses a second executor with the same message as
before, and every existing command behaves as it did. The queue file format version is
unchanged.

## Install and rollback

Install, as the coordinator:

```sh
# 1. Create the role proof. Keep the secret outside the queue directory.
TOKEN=$(openssl rand -hex 32)                      # store this where only the coordinator reads it
HASH=$(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)
umask 077
cat > ~/.local/state/claude-personal-queue/coordinators.json <<JSON
{"coordinators":[{"id":"<coordinator-id>","label":"root coordinator","tokenHash":"$HASH"}]}
JSON
chmod 600 ~/.local/state/claude-personal-queue/coordinators.json

# 2. Record the approved routing policy and what this machine can host.
echo '{"coordinatorId":"<id>","coordinatorToken":"'"$TOKEN"'","id":"native-authorized-tasks-open-20260908","evidence":"<concrete operator approval>"}' \
  | node bin/personal-queue coord-routing-policy
echo '{"coordinatorId":"<id>","coordinatorToken":"'"$TOKEN"'","maxConcurrentWorkers":<observed>,"basis":"private:capacity/<reference>","ttlMs":86400000}' \
  | node bin/personal-queue coord-machine-capacity

# 3. Reconcile once and inspect before wiring the heartbeat.
node bin/personal-queue coordination-reconcile
node bin/personal-queue admission
node bin/personal-queue notifications
```

Then add the three heartbeat calls above to the existing `seguimiento-de-proyectos` run. No
launchd job, timer or service change is required by this feature.

Rollback: revert this commit. The added state keys are inert for older code, which ignores
`coordination`, `review`, `notifications`, `routingPolicy`, `machineCapacity` and
`concurrency`, and the legacy counters were never modified. To stand down without reverting,
remove `service.routingPolicy` and `service.concurrency` to return to the serial legacy bound,
or delete `coordinators.json` to disable every coordinator command. Removing the private
`notifications/` directory only discards mirrored copies; the durable outbox stays in the
queue. Preserve private queue state, worktrees and any in flight launch for inspection: this
change never kills, relaunches or finalizes work on its own.

## Known limits

- The coordination state is advisory metadata. It never rewrites the legacy execution
  `status`, so the service and dispatcher keep their existing behaviour and a `blocked`
  coordination outcome does not stop a running process.
- Progress signals are coarse. Without published progress notes, the meaningful events are
  launch, runtime initialization, capacity observations and completion, so the stale threshold
  must exceed a normal quiet period. The 900000 ms default is a starting point, not a measured
  value for any particular workload.
- Process identity relies on `/bin/ps` start times on macOS. A PID whose birth was never
  recorded is reported as unprovable rather than assumed, which is conservative and can flag
  launches that predate this change.
- Artifact observation covers the assigned worktree HEAD, its dirty state and, for scoped
  project work, the checkpoint digest. It does not verify build outputs, remote state or
  anything outside that worktree.
- The role proof is not an operating system boundary, as stated above.
- Machine capacity is an operator recorded number. Nothing here measures memory, CPU or
  provider side limits, and the provider can still refuse work independently.
- Under an open ended policy the bound is whatever capacity was recorded. An over generous
  record is not detected by this code.
- Notification records are retained until acknowledged, and acknowledged records are trimmed
  beyond 1000. The dedupe index is pruned only for subjects that no longer exist.
- Everything in this repository is generic code and synthetic tests. No live queue content,
  task text, account identifier or credential belongs here.

## PR context handoff

This branch is `codex/coordination-reliability`. It was implemented by the Claude Max worker
and is submitted for independent review. It has not been reviewed, deployed or independently
verified by its author.

What to review first:

1. `src/personal/coordination.js`: state derivation order, in particular that review readiness
   is evaluated before liveness, and the stability of the legacy review revision so that
   coordination bookkeeping does not invalidate approvals or re-notify.
2. `src/personal/artifact.js` and `approvalDrift`: whether the drift categories match the
   project's real definition of "the artifact changed", and whether treating an unreadable
   worktree as drift is the behaviour you want.
3. `src/personal/admission.js`: the routing policy, the fail closed machine capacity rules,
   the slot key deduplication and the duplicate task identity rejection.
4. `src/personal/coordinator.js`: the role gate, self review refusal and the exact bindings
   for approval, deployment and verification.
5. `src/personal/queue.js` and `src/personal/service.js`: the three integration points, which
   are the shared admission check, the recorded process birth and the reconciliation call in
   the existing loop.

Verification performed by the author: `npm test` on this branch, which is 34 smoke assertions,
102 round trip assertions for each of three startup orders, 6 claim flow assertions and 149
focused tests, all passing, including 33 new tests across `test/coordination.test.js`,
`test/notifications.test.js` and `test/admission.test.js`. The concurrency test uses six real
child processes racing for five slots against one temporary queue. All tests are synthetic:
temporary Git repositories, fake process identities and injected clocks. No model call, no
live queue state and no worker launch is part of the test suite.

Not done by the author, and left to the coordinator: independent review, integration,
installation, any live state migration, the routing policy and machine capacity records, and
verification against a real queue. The author holds no approval capability and did not create
one for itself.
