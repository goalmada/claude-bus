import crypto from 'node:crypto';
import { processBirth } from './process-identity.js';

// One shared admission helper for every launch route: the installed legacy service runner, a
// direct `queue.run` dispatch and an officially routed native launch. Counting and reserving
// happen inside the existing queue transaction lock, so the bound is atomic across processes
// rather than advisory inside one of them.
//
// Two regimes coexist, and which one applies is a recorded fact, never a guess:
//
//   legacy       no routing policy. The historical finite limits apply: one executor at a
//                time unless a coordinator explicitly recorded a higher bound, and never
//                more than the legacy ceiling of five.
//   routed       an operator-approved `service.routingPolicy` with mode `authorized_tasks`
//                and provider `official_native_claude_max`. There is no invented worker cap
//                and no trial launch counter. The real bound is the recorded machine
//                capacity, which fails closed whenever it is missing, malformed or stale.
//
// Neither regime refills the other's counters. `service.remaining`, its
// `authorizationHistory` and the older one-launch external authorizations stay exactly as
// recorded: history, never a live allowance.

export const LEGACY_MAX_CONCURRENCY = 5;
export const LEGACY_CONCURRENCY = 1;
export const ROUTED_MODE = 'authorized_tasks';
export const ROUTED_PROVIDER = 'official_native_claude_max';
export const INFLIGHT_STATUSES = new Set(['launching', 'running', 'uncertain', 'checking']);
const SETTLED_EXTERNAL = new Set(['finished', 'failed', 'cancelled', 'released', 'verified']);
// A freshly reserved record has no process identity yet: the same grace the service uses.
const ATTACH_GRACE_MS = 10000;

export function routingPolicy(state) {
  const policy = state?.service?.routingPolicy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
  if (policy.mode !== ROUTED_MODE || policy.provider !== ROUTED_PROVIDER) {
    throw new Error('Recorded routing policy is not a recognised authorized-task native route; inspect the private ledger');
  }
  if (typeof policy.id !== 'string' || !policy.id.trim().length) throw new Error('Routing policy requires a stable id');
  if (policy.fixedWorkerCap !== null && policy.fixedWorkerCap !== undefined && !Number.isInteger(policy.fixedWorkerCap)) {
    throw new Error('Routing policy worker cap must be an integer or null');
  }
  return policy;
}

// Machine capacity is the real constraint under an open-ended routing policy. It is an
// operator-recorded fact about this machine, and admission fails closed when it is uncertain.
export function machineCapacity(state, { now = Date.now() } = {}) {
  const capacity = state?.service?.machineCapacity;
  if (capacity === undefined || capacity === null) return null;
  if (typeof capacity !== 'object' || Array.isArray(capacity)) throw new Error('Machine capacity record must be an object; inspect the private ledger');
  if (capacity.uncertain === true) throw new Error('Machine capacity is recorded as uncertain; admission fails closed until it is re-observed');
  const max = capacity.maxConcurrentWorkers;
  if (!Number.isInteger(max) || max < 1) throw new Error('Machine capacity must record a positive integer maxConcurrentWorkers; admission fails closed');
  if (capacity.ttlMs !== undefined && capacity.ttlMs !== null) {
    const observed = Date.parse(capacity.observedAt ?? '');
    if (!Number.isInteger(capacity.ttlMs) || capacity.ttlMs < 1 || !Number.isFinite(observed)) throw new Error('Machine capacity freshness is malformed; admission fails closed');
    if (now - observed > capacity.ttlMs) throw new Error('Machine capacity observation expired; re-observe this machine before launching');
    if (observed > now) throw new Error('Machine capacity observation is dated in the future; admission fails closed');
  }
  return { max, basis: capacity.basis ?? null, observedAt: capacity.observedAt ?? null };
}

// The effective concurrency bound and where it came from. Nothing here invents a cap of five
// under a routing policy, and nothing raises the legacy bound implicitly.
export function launchLimit(state, { now = Date.now() } = {}) {
  const policy = routingPolicy(state);
  const configured = state?.service?.concurrency?.limit ?? null;
  if (configured !== null && (!Number.isInteger(configured) || configured < 1)) {
    throw new Error('Recorded concurrency limit must be a positive integer; inspect the private ledger before launching');
  }
  if (!policy) {
    if (configured !== null && configured > LEGACY_MAX_CONCURRENCY) throw new Error('Legacy concurrency cannot exceed five without an approved routing policy');
    return { limit: configured ?? LEGACY_CONCURRENCY, source: configured ? 'legacy_configured' : 'legacy_default', policyId: null };
  }
  const capacity = machineCapacity(state, { now });
  const capped = Number.isInteger(policy.fixedWorkerCap) ? policy.fixedWorkerCap : null;
  const candidates = [capped, capacity?.max ?? null, configured].filter(value => Number.isInteger(value));
  if (!candidates.length) {
    // Open-ended policy with nothing recorded about this machine: fail closed on the legacy
    // serial bound instead of assuming the machine can host an unbounded number of workers.
    return { limit: LEGACY_CONCURRENCY, source: 'routed_capacity_unrecorded', policyId: policy.id };
  }
  return {
    limit: Math.min(...candidates),
    source: capped !== null ? 'routed_policy_cap' : capacity ? 'routed_machine_capacity' : 'routed_configured',
    policyId: policy.id,
  };
}

// Kept for callers that only need the number.
export const concurrencyLimit = (state, options) => launchLimit(state, options).limit;

// Legacy external records were written before this feature and may lack `state`. Anything
// that is not clearly settled occupies a slot: conservative, never cleaned up automatically,
// and surfaced for coordinator inspection instead. A worker declaring its own record
// finished or verified does not release the slot while its process is still alive.
export function externalSettled(record, { birth = processBirth } = {}) {
  if (!record || typeof record !== 'object') return false;
  const claimed = Boolean(record.finishedAt) || (record.exit !== undefined && record.exit !== null) || SETTLED_EXTERNAL.has(record.state);
  if (!claimed) return false;
  if (Number.isInteger(record.pid) && typeof record.birth === 'string' && record.birth.length) {
    return birth(record.pid) !== record.birth;
  }
  return true;
}

// Slot keys deduplicate the same work seen through different ledgers: a service runner, the
// job it owns and an external record naming that task are one slot, not three.
export function occupiedSlots(state, { birth = processBirth, now = Date.now() } = {}) {
  const slots = new Map();
  // A key seen through more than one ledger stays one slot, but every contributing kind is
  // recorded: a claim can only ever release a slot that is exactly the caller's reservation.
  const add = (key, entry) => {
    const existing = slots.get(key);
    if (!existing) { slots.set(key, { key, kinds: [entry.kind], ...entry }); return; }
    existing.kinds.push(entry.kind);
    existing.uncertain = existing.uncertain || entry.uncertain;
    existing.reason = existing.reason ?? entry.reason;
  };
  for (const job of state?.jobs ?? []) {
    if (!INFLIGHT_STATUSES.has(job.status)) continue;
    const uncertain = job.status === 'uncertain';
    add(`task:${job.id}`, { kind: 'job', id: job.id, status: job.status, uncertain, reason: uncertain ? 'executor_identity_uncertain' : null });
  }
  const runner = state?.service?.runner;
  if (runner && !runner.finishedAt) {
    add(runner.taskId ? `task:${runner.taskId}` : `runner:${runner.id}`, { kind: 'runner', id: runner.id ?? null, taskId: runner.taskId ?? null, uncertain: false, reason: null });
  }
  for (const record of state?.service?.externalLaunches ?? []) {
    if (externalSettled(record, { birth })) continue;
    let uncertain = true, reason = 'external_identity_unrecorded';
    const claimedSettled = Boolean(record.finishedAt) || (record.exit !== undefined && record.exit !== null) || SETTLED_EXTERNAL.has(record.state);
    if (Number.isInteger(record.pid) && typeof record.birth === 'string' && record.birth.length) {
      const confirmed = birth(record.pid) === record.birth;
      // A record that claims to be finished while its own process is still confirmed alive
      // is the most suspicious case of all: it holds the slot and is reported as uncertain.
      uncertain = !confirmed || claimedSettled;
      reason = !confirmed ? 'external_identity_unconfirmed' : claimedSettled ? 'external_settled_with_live_process' : null;
    } else if (!record.pid && !claimedSettled && Date.parse(record.createdAt ?? '') > now - ATTACH_GRACE_MS) {
      uncertain = false; reason = null;
    }
    add(record.taskId ? `task:${record.taskId}` : `external:${record.id}`, { kind: 'external', id: record.id ?? null, taskId: record.taskId ?? null, owner: record.owner ?? null, uncertain, reason });
  }
  return [...slots.values()];
}

// `claim` is the reservation the caller already owns, as `{ key, kind }`. It releases that
// slot only when the slot comes from exactly that kind, so a duplicate record under the same
// task identity can never be hidden behind someone else's reservation.
export function admissionStatus(state, { claim = null, ...options } = {}) {
  const { limit, source, policyId } = launchLimit(state, options);
  const all = occupiedSlots(state, options);
  const slots = claim
    ? all.filter(slot => !(slot.key === claim.key && slot.kinds.length === 1 && slot.kinds[0] === claim.kind))
    : all;
  return { limit, source, policyId, used: slots.length, available: Math.max(0, limit - slots.length), slots, uncertain: slots.filter(slot => slot.uncertain) };
}

export function assertAdmission(state, options = {}) {
  const status = admissionStatus(state, options);
  if (status.used >= status.limit) {
    throw new Error(status.limit === LEGACY_CONCURRENCY
      ? 'One executor at a time; reconcile unfinished launches first'
      : `Bounded concurrency reached: ${status.used} of ${status.limit} launch slots occupied; reconcile unfinished launches first`);
  }
  return status;
}

// A task identity may hold exactly one slot. Reservations never pass an exclusion, so a
// duplicate identity cannot be smuggled past the bound by naming an occupied task.
export function assertUnclaimedTask(state, taskId, options = {}) {
  if (taskId === null || taskId === undefined) return;
  if (typeof taskId !== 'string' || !taskId.trim().length) throw new Error('Task identity must be a non-empty string');
  if (taskClaimed(state, taskId, options)) throw new Error('Task identity is already reserved or running; reconcile the existing launch first');
}

export const taskClaimed = (state, taskId, options = {}) => occupiedSlots(state, options).some(slot => slot.key === `task:${taskId}`);

export function externalAuthorizations(state) {
  const service = state.service ??= { enabled: false, remaining: 0, runner: null };
  const ledger = service.externalAuthorizations;
  if (ledger === undefined) return (service.externalAuthorizations = []);
  if (!Array.isArray(ledger)) throw new Error('External authorization ledger must be an array; inspect the private state');
  return ledger;
}

// Reserves exactly one launch slot. Under a routing policy the reservation cites the policy
// id and the authorized task identity; obsolete trial counters are not decremented. Without
// a policy the caller must name a finite external authorization, which is consumed once and
// never refilled. `service.remaining`, `service.runner` and `service.authorizationHistory`
// are untouched in both cases.
export function reserveLaunch(queue, {
  authorizationId = null, policyId = null, owner, taskId = null, worktree = null,
  purpose = null, reviewRequired = null, coordinator = null, birth = processBirth, now = Date.now(),
} = {}) {
  if (typeof owner !== 'string' || !owner.trim().length || owner.length > 200) throw new Error('Reservation requires an owner identity');
  if (taskId !== null && (typeof taskId !== 'string' || !taskId.trim().length)) throw new Error('Authorized task identity must be a non-empty string');
  return queue.transaction(state => {
    const policy = routingPolicy(state);
    let authorization = null;
    if (policyId !== null) {
      if (!policy) throw new Error('No routing policy is recorded; cite an explicit external authorization instead');
      if (policy.id !== policyId) throw new Error('Routing policy id does not match the recorded operator approval');
      if (!taskId) throw new Error('A routed launch must name the authorized task identity');
    } else {
      const ledger = externalAuthorizations(state);
      authorization = ledger.find(entry => entry?.id === authorizationId);
      if (!authorization) throw new Error('Unknown external launch authorization');
      if (!Number.isInteger(authorization.remaining) || authorization.remaining < 0) throw new Error('External authorization counter is malformed; inspect the private ledger');
      if (authorization.remaining === 0) throw new Error('External launch authorization is exhausted; no automatic refill');
    }
    // Counting, identity checking and consuming happen in one transaction, so a duplicate or
    // an over-the-bound contender loses deterministically.
    assertUnclaimedTask(state, taskId, { birth, now });
    assertAdmission(state, { birth, now });
    const record = {
      id: crypto.randomUUID(),
      authorizationId: authorization ? authorizationId : null,
      policyId: policy && policyId !== null ? policy.id : null,
      owner, coordinator,
      state: 'reserved', createdAt: new Date(now).toISOString(),
      pid: null, birth: null, worktree, taskId, purpose,
      reviewRequired: typeof reviewRequired === 'boolean' ? reviewRequired : Boolean(worktree),
    };
    if (authorization) {
      authorization.remaining -= 1;
      authorization.consumed = [...(authorization.consumed ?? []), { launchId: record.id, at: record.createdAt }];
    }
    (state.service.externalLaunches ??= []).push(record);
    return record;
  });
}

function withExternalLaunch(queue, launchId, apply) {
  return queue.transaction(state => {
    const record = (state.service?.externalLaunches ?? []).find(entry => entry?.id === launchId);
    if (!record) throw new Error('Unknown external launch record');
    apply(record);
    return structuredClone(record);
  });
}

export function attachExternalProcess(queue, launchId, { pid, birth = processBirth, now = Date.now() } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Process identity requires a positive pid');
  return withExternalLaunch(queue, launchId, record => {
    if (externalSettled(record, { birth })) throw new Error('External launch is already finalized');
    if (Number.isInteger(record.pid) && record.pid !== pid) throw new Error('External launch is already bound to another process');
    record.pid = pid;
    record.birth = birth(pid);
    record.state = 'running';
    record.attachedAt = new Date(now).toISOString();
  });
}

// Finalizers run late, often from another process. This one re-reads under the lock and
// writes only its own record: it never rewrites the service object, never enables the
// service and never refills an authorization, so a concurrent ledger update survives. The
// slot is only really released once the recorded process is observed to be gone.
export function finalizeExternalLaunch(queue, launchId, { state = 'finished', exit = null, evidenceRef = null, birth = processBirth, now = Date.now() } = {}) {
  if (!SETTLED_EXTERNAL.has(state)) throw new Error(`Final external state must be one of ${[...SETTLED_EXTERNAL].join(', ')}`);
  return withExternalLaunch(queue, launchId, record => {
    // Idempotent on the record's own finalization, independent of what the process does.
    if (record.finishedAt || externalSettled(record, { birth })) return;
    record.state = state;
    record.exit = exit;
    record.finishedAt = new Date(now).toISOString();
    if (evidenceRef !== null && evidenceRef !== undefined) record.evidenceRef = evidenceRef;
  });
}
