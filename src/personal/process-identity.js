import { execFileSync } from 'node:child_process';

// Process identity for coordination. A living PID is never proof of progress and a PID
// alone is never enough to act on: identity is the pair (pid, birth) plus the last
// meaningful event. Nothing here signals, kills or relaunches a process; every uncertain
// observation is returned as an explicit state for a coordinator to resolve.

export const DEFAULT_STALE_MS = 900000;
export const DEFAULT_IDENTITY_GRACE_MS = 10000;
// The legacy in-flight statuses that claim an owned executor process.
export const ACTIVE_STATUSES = new Set(['launching', 'running', 'checking']);

export function processBirth(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 }).trim() || null; }
  catch { return null; }
}

// Legacy jobs recorded only `pid`. Newer launches also record the birth timestamp, which is
// what makes a later observation provable rather than a guess about a reusable number.
export function processFacts(job) {
  const recorded = job?.process && typeof job.process === 'object' ? job.process : null;
  const pid = Number.isInteger(recorded?.pid) ? recorded.pid : Number.isInteger(job?.pid) ? job.pid : null;
  const birth = typeof recorded?.birth === 'string' && recorded.birth.length ? recorded.birth : null;
  return { pid, birth, startedAt: recorded?.startedAt ?? job?.startedAt ?? null };
}

const time = value => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; };

// The latest fact that actually shows progress. Plain revision bookkeeping (including the
// coordination records written by this feature) is deliberately excluded, so a quiet process
// cannot keep looking busy just because its metadata was rewritten.
export function lastMeaningfulAt(job) {
  const candidates = [job?.startedAt, job?.finishedAt, job?.progressAt, job?.attachedAt, job?.review?.at, job?.capacityAt, job?.capacity?.observedAt];
  const events = Array.isArray(job?.events) ? job.events : [];
  events.forEach((event, index) => {
    if (index === 0 || event?.status !== events[index - 1]?.status) candidates.push(event?.at);
  });
  const stamps = candidates.map(time).filter(value => value !== null);
  return stamps.length ? Math.max(...stamps) : null;
}

// States: none, starting, confirmed, exited, reused, missing, unprovable.
export function reconcileIdentity(job, {
  birth = processBirth, now = Date.now(),
  staleAfterMs = DEFAULT_STALE_MS, identityGraceMs = DEFAULT_IDENTITY_GRACE_MS,
} = {}) {
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1000) throw new Error('Stale threshold must be an integer of at least 1000 ms');
  if (!Number.isInteger(identityGraceMs) || identityGraceMs < 0) throw new Error('Identity grace must be a non-negative integer');
  const facts = processFacts(job);
  const active = ACTIVE_STATUSES.has(job?.status);
  const progressAt = lastMeaningfulAt(job);
  const stale = active && progressAt !== null && now - progressAt > staleAfterMs;
  const base = {
    pid: facts.pid, birth: facts.birth, stale,
    progressAt: progressAt === null ? null : new Date(progressAt).toISOString(),
  };
  if (facts.pid === null) {
    if (!active) return { ...base, state: 'none', reason: 'no_owned_process' };
    const started = time(facts.startedAt);
    if (started !== null && now - started < identityGraceMs) return { ...base, state: 'starting', reason: 'launch_starting' };
    return { ...base, state: 'missing', reason: 'identity_missing' };
  }
  const observed = birth(facts.pid);
  if (observed === null || observed === undefined) return { ...base, state: 'exited', reason: active ? 'unexpected_exit' : 'process_exited' };
  // A living PID without a recorded birth cannot be attributed to this launch.
  if (facts.birth === null) return { ...base, state: 'unprovable', reason: 'identity_unprovable' };
  if (observed !== facts.birth) return { ...base, state: 'reused', reason: 'identity_mismatch' };
  return { ...base, state: 'confirmed', reason: stale ? 'stale_running' : 'process_confirmed' };
}
