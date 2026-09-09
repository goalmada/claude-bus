import { reconcileIdentity, processFacts, ACTIVE_STATUSES, DEFAULT_STALE_MS, DEFAULT_IDENTITY_GRACE_MS } from './process-identity.js';
import { enqueueNotification, publishNotificationFiles, pruneNotificationIndex, safeReference } from './notifications.js';
import { memoizedObserver, artifactDrift } from './artifact.js';

// Durable coordination state for personal queue work. This extends the existing queue
// instead of adding a second queue or monitor: a `coordination` record is derived from facts
// the queue already owns and written inside the same synced transaction, next to the record
// it describes. The legacy `status` field is never rewritten here.
//
// Two record kinds are coordination subjects, both in place:
//   - `state.jobs[]`            legacy queue tasks executed through queue.run
//   - `state.service.externalLaunches[]`  officially routed direct native launches
// External records are normalized, never copied into duplicate jobs.
//
// The defect this closes: a live worker that finished its work and is waiting for a
// coordinator was advertised as merely "working" because its PID was still alive. Review
// readiness is therefore evaluated before any liveness fact.

export const COORDINATION_STATES = Object.freeze(['running', 'needs_review', 'approved', 'deploying', 'verified', 'blocked']);
export const DEFAULT_OVERDUE_MS = 120000;
// Finished subjects older than this are historical: reconciliation leaves them untouched
// unless they already carry a coordination record, so adopting this feature cannot flood the
// coordinator with alerts about work that was completed and handled long ago.
export const DEFAULT_ADOPTION_WINDOW_MS = 86400000;
export const DIGEST_KINDS = Object.freeze(['result', 'artifact', 'checkpoint']);

const FULL_SHA = /^[a-f0-9]{40,64}$/;
const DIGEST = /^(sha256:)?[a-f0-9]{40,128}$/;
// Legacy `reported` is the recorded "executor produced a result" state: it maps to needs_review.
const LEGACY_REVIEW_STATUSES = new Set(['reported', 'needs_review']);
const LEGACY_STOPPED = new Map([
  ['blocked', 'executor_blocked'],
  ['failed', 'executor_failed'],
  ['timed_out', 'executor_timed_out'],
  ['uncertain', 'launch_uncertain'],
  ['paused', 'paused_awaiting_coordinator'],
]);
// A worker can move an external record into a finished state; only observed exit plus the
// coordinator decide what that means, so these are settled rather than in flight.
const SETTLED = new Set(['finished', 'released', 'cancelled']);
const EXTERNAL_STATUS = new Map([
  ['reserved', 'launching'],
  ['running', 'running'],
  ['finished', 'finished'],
  // A worker declaring its own work verified is not a verification; it is finished work.
  ['verified', 'finished'],
  ['released', 'released'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
]);

const iso = now => new Date(now).toISOString();
const text = value => typeof value === 'string' && value.trim().length > 0;
const time = value => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; };

// The revision at which a legacy job entered `reported`. Using the live job revision would
// change on every metadata write, including this feature's own bookkeeping, and would keep
// invalidating coordinator approvals for no reason.
function legacyReviewRevision(job) {
  const events = Array.isArray(job.events) ? job.events : [];
  // The revision that entered `reported`, taken from the start of the trailing run of
  // reported events. Taking the newest one would advance on every later metadata write.
  let transition = null;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.status !== 'reported') break;
    if (Number.isInteger(events[index].revision)) transition = events[index].revision;
  }
  if (transition !== null) return transition;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.status === 'reported' && Number.isInteger(events[index].revision)) return events[index].revision;
  }
  return Number.isInteger(job.revision) ? job.revision : null;
}

// One shape for both record kinds. Nested objects are shared with the stored record, so a
// caller mutates the real record and never a copy.
export function normalizeSubject(record, kind = 'job') {
  if (kind !== 'external') {
    return {
      kind: 'job', id: record.id, status: record.status,
      owner: record.owner ?? null, coordinator: record.sourceTask ?? null,
      worktree: record.worktree ?? null, scope: record.scope ?? null,
      baseSha: record.baseSha ?? null, resultHash: record.resultHash ?? null,
      checkpointHash: record.checkpoint?.hash ?? null, launchId: record.launchId ?? null,
      revision: Number.isInteger(record.revision) ? record.revision : null,
      events: Array.isArray(record.events) ? record.events : [],
      process: processFacts(record),
      startedAt: record.startedAt ?? null, finishedAt: record.finishedAt ?? null,
      progressAt: record.progressAt ?? null, capacityAt: record.capacity?.observedAt ?? null,
      review: record.review ?? null, coordination: record.coordination ?? null,
      legacyVerification: record.verification ?? null,
      expectsReview: true, settledAt: record.finishedAt ?? null,
      record,
    };
  }
  // External launch records were written by the direct native route. Their owner, identity,
  // worktree and review metadata are read defensively: unknown fields stay null.
  const status = EXTERNAL_STATUS.get(record.state) ?? (record.finishedAt || record.exit !== undefined && record.exit !== null ? 'finished' : 'running');
  return {
    kind: 'external', id: record.id, status,
    owner: text(record.owner) ? record.owner : null,
    coordinator: text(record.coordinator) ? record.coordinator : text(record.authorizedBy) ? record.authorizedBy : null,
    worktree: text(record.worktree) ? record.worktree : null, scope: record.scope ?? null,
    baseSha: text(record.baseSha) ? record.baseSha : null, resultHash: null, checkpointHash: null,
    launchId: record.id, revision: Number.isInteger(record.reviewSeq) ? record.reviewSeq : null,
    events: [],
    process: { pid: Number.isInteger(record.pid) ? record.pid : null, birth: text(record.birth) ? record.birth : null, startedAt: record.attachedAt ?? record.createdAt ?? null },
    startedAt: record.attachedAt ?? record.createdAt ?? null,
    finishedAt: record.finishedAt ?? null,
    progressAt: record.progressAt ?? null, capacityAt: null,
    review: record.review ?? null, coordination: record.coordination ?? null,
    legacyVerification: null,
    // Image and utility launches carry no worktree and expect no review; routed task work does.
    expectsReview: typeof record.reviewRequired === 'boolean' ? record.reviewRequired : text(record.worktree),
    settledAt: record.finishedAt ?? null,
    policyId: record.policyId ?? null, taskId: record.taskId ?? null,
    record,
  };
}

export function coordinationSubjects(state) {
  const jobs = (state.jobs ?? []).map(job => normalizeSubject(job, 'job'));
  const external = (state.service?.externalLaunches ?? []).filter(entry => entry && typeof entry === 'object' && text(entry.id)).map(entry => normalizeSubject(entry, 'external'));
  return [...jobs, ...external];
}

// The facts a needs_review state must carry. A published readiness record wins; otherwise a
// legacy reported job is projected onto the same shape from what the queue already stored.
export function reviewFacts(subject) {
  const published = subject?.review;
  if (published && typeof published === 'object') {
    // A readiness record from an earlier attempt is not evidence about the current one.
    if (subject.launchId && published.launchId && published.launchId !== subject.launchId) return null;
    return { ...published, source: published.source ?? 'published' };
  }
  if (!LEGACY_REVIEW_STATUSES.has(subject?.status)) return null;
  const digest = text(subject.resultHash) ? subject.resultHash : subject.checkpointHash ?? null;
  return {
    source: 'legacy_reported',
    revision: subject.kind === 'job' ? legacyReviewRevision(subject.record) : subject.revision,
    sha: text(subject.baseSha) ? subject.baseSha : null,
    digest,
    digestKind: text(subject.resultHash) ? 'result' : digest ? 'checkpoint' : null,
    // Scoped project work carries both: the result hash names the report, the checkpoint
    // digest names the exact edits the reviewer looked at.
    checkpointDigest: subject.checkpointHash ?? null,
    evidenceRef: text(subject.launchId) ? `queue:launch:${subject.launchId}` : null,
    owner: subject.owner, coordinator: subject.coordinator,
    at: subject.finishedAt ?? null,
    launchId: subject.launchId ?? null,
  };
}

export function missingReviewFields(review) {
  const missing = [];
  if (!text(review?.sha) || !FULL_SHA.test(review.sha)) missing.push('sha');
  if (!text(review?.digest)) missing.push('digest');
  if (!text(review?.owner)) missing.push('owner');
  if (!text(review?.coordinator)) missing.push('coordinator');
  if (!text(review?.at)) missing.push('at');
  return missing;
}

// An approval is bound to the exact reviewed revision, SHA and result, artifact or checkpoint
// digest, and to what the assigned worktree actually contains now. Any change to those facts
// makes it stale before deploying or verifying, whether or not the worker republishes.
export function approvalDrift(review, approval, observation) {
  if (!approval) return 'no_approval';
  if (!review) return 'review_withdrawn';
  if (approval.sha !== review.sha) return 'review_sha_changed';
  if (approval.digest !== review.digest) return 'review_digest_changed';
  if (approval.reviewRevision !== review.revision) return 'review_revision_changed';
  return artifactDrift({ sha: approval.sha, digest: approval.digest, digestKind: approval.digestKind, checkpointDigest: approval.checkpointDigest ?? null }, observation);
}

export function coordinationFor(subject, options = {}) {
  const { now = Date.now() } = options;
  const review = reviewFacts(subject);
  const record = subject.coordination ?? {};
  const approval = record.approval ?? null;
  const verification = record.verification ?? null;
  const deploy = record.deploy ?? null;
  // Observing the filesystem is deferred until a binding actually needs checking.
  const observe = options.observe ?? memoizedObserver();
  const observation = review || approval ? observe(subject, { now }) : null;
  const drift = approval ? approvalDrift(review, approval, observation) : null;
  const validApproval = Boolean(approval && !drift);
  const validDeploy = Boolean(validApproval && deploy && deploy.approvedAt === approval.at);
  const validVerification = Boolean(validApproval && verification
    && verification.approvedAt === approval.at
    && verification.sha === approval.sha
    && verification.digest === approval.digest);
  const reviewDrift = review && !approval ? artifactDrift({ sha: review.sha, digest: review.digest, digestKind: review.digestKind, checkpointDigest: review.checkpointDigest ?? null }, observation) : null;
  const observed = options.identity ?? reconcileIdentity(subject, { ...options, now });
  const alive = observed.state === 'confirmed';

  const build = (state, reason) => ({
    state, reason,
    sha: review?.sha ?? null,
    digest: review?.digest ?? null,
    digestKind: review?.digestKind ?? null,
    observedSha: observation?.headSha ?? null,
    observedAt: observation?.observedAt ?? null,
    evidenceRef: (validApproval ? approval.evidenceRef : null) ?? review?.evidenceRef ?? null,
    owner: review?.owner ?? subject.owner ?? null,
    coordinator: (validApproval ? approval.coordinator : null) ?? review?.coordinator ?? subject.coordinator ?? null,
    reviewRevision: review?.revision ?? null,
    reviewSource: review?.source ?? null,
    reviewAt: review?.at ?? null,
    subjectKind: subject.kind,
    identity: { state: observed.state, pid: observed.pid, stale: observed.stale, progressAt: observed.progressAt, reason: observed.reason },
  });

  if (validVerification) return build('verified', 'independently_verified');
  // A legacy reviewer verification is a historical fact about the artifact it named. It stays
  // authoritative only while that artifact is unchanged.
  if (subject.legacyVerification && subject.status === 'verified' && !approval) {
    const legacy = artifactDrift({ sha: subject.baseSha, digest: subject.resultHash, digestKind: 'result' }, observation ?? observe(subject, { now }));
    return legacy ? build('needs_review', `legacy_verification_stale:${legacy}`) : build('verified', 'legacy_verification');
  }
  if (validDeploy) return build('deploying', 'coordinator_deploying');
  if (validApproval) return build('approved', 'coordinator_approved');

  // Review readiness outranks a living PID: a worker waiting for a coordinator is never
  // advertised as merely working, whether its process is alive or already gone.
  if (review) {
    if (approval) return build('needs_review', `approval_stale:${drift}`);
    if (reviewDrift) return build('needs_review', `review_artifact_changed:${reviewDrift}`);
    const incomplete = missingReviewFields(review);
    return build('needs_review', incomplete.length ? `review_evidence_incomplete:${incomplete.join(',')}` : 'awaiting_coordinator_review');
  }

  const stopped = LEGACY_STOPPED.get(subject.status);
  if (stopped) return build('blocked', stopped);
  if (SETTLED.has(subject.status)) {
    // A settled record whose process is still alive was not really finished.
    if (alive) return build('blocked', 'settled_state_with_live_process');
    if (subject.status === 'finished' && subject.expectsReview) return build('blocked', 'finished_without_review');
    return null;
  }
  if (ACTIVE_STATUSES.has(subject.status)) {
    if (alive) return observed.stale ? build('blocked', 'stale_running') : build('running', 'executor_running');
    if (observed.state === 'starting') return build('running', 'executor_starting');
    // Unexpected exit, missing identity, unprovable identity and PID reuse are explicit
    // coordinator outcomes. They never trigger an automatic relaunch or a PID-based signal.
    return build('blocked', observed.reason);
  }
  return null;
}

const cleared = subject => ({
  state: null, reason: 'no_active_coordination',
  sha: null, digest: null, digestKind: null, observedSha: null, observedAt: null,
  evidenceRef: null, owner: subject.owner ?? null, coordinator: subject.coordinator ?? null,
  reviewRevision: null, reviewSource: null, reviewAt: null, subjectKind: subject.kind, identity: null,
});

export const signatureOf = next => next
  ? `${next.state}|${next.reason}|${next.sha ?? '-'}|${next.digest ?? '-'}|${next.reviewRevision ?? '-'}`
  : 'cleared|no_active_coordination';

function notificationFrom(subject, coordination, reason, at) {
  return {
    taskId: subject.id,
    subjectKind: subject.kind,
    revision: subject.revision,
    state: coordination.state ?? null,
    reason,
    detail: coordination.reason ?? null,
    sha: coordination.sha ?? null,
    observedSha: coordination.observedSha ?? null,
    digest: coordination.digest ?? null,
    digestKind: coordination.digestKind ?? null,
    evidenceRef: coordination.evidenceRef ?? null,
    owner: coordination.owner ?? null,
    coordinator: coordination.coordinator ?? null,
    reviewRevision: coordination.reviewRevision ?? null,
    identityState: coordination.identity?.state ?? null,
    at,
    dedupeKey: `${subject.id}|${reason}|${coordination.signature}`,
  };
}

// Historical, already settled work is left exactly as it is unless it is already tracked.
export function inAdoptionScope(subject, { now = Date.now(), adoptionWindowMs = DEFAULT_ADOPTION_WINDOW_MS } = {}) {
  if (subject.coordination) return true;
  if (!SETTLED.has(subject.status) && subject.status !== 'verified') return true;
  const settled = time(subject.settledAt);
  return settled === null || now - settled <= adoptionWindowMs;
}

// Recomputes one subject inside an open transaction, persists a changed coordination record
// and enqueues at most one notification per meaningful transition plus one overdue alert.
export function refreshSubject(state, subject, options = {}) {
  const now = options.now ?? Date.now();
  const overdueMs = options.overdueMs ?? DEFAULT_OVERDUE_MS;
  if (!Number.isInteger(overdueMs) || overdueMs < 1000) throw new Error('Overdue review threshold must be an integer of at least 1000 ms');
  const at = iso(now);
  const next = coordinationFor(subject, { ...options, now });
  const previous = subject.coordination ?? null;
  const signature = signatureOf(next);
  const notifications = [];

  if (!previous || previous.signature !== signature) {
    subject.record.coordination = {
      ...(previous ?? {}), ...(next ?? cleared(subject)),
      signature, at, previousState: previous?.state ?? null, overdueNotifiedAt: null,
    };
    const reason = next ? `enter_${next.state}` : 'coordination_cleared';
    const entry = enqueueNotification(state, notificationFrom(subject, subject.record.coordination, reason, at));
    if (entry) notifications.push(entry);
    return { id: subject.id, state: next?.state ?? null, changed: true, notifications };
  }

  // Exactly one overdue alert per entry into needs_review, evaluated by whichever existing
  // loop calls this function. No timer and no scheduler is introduced here. The elapsed time
  // is measured from the observed transition, never from a timestamp a worker supplied.
  if (previous.state === 'needs_review' && !previous.overdueNotifiedAt) {
    const entered = time(previous.at);
    if (entered !== null && now - entered >= overdueMs) {
      subject.record.coordination = { ...previous, overdueNotifiedAt: at };
      const entry = enqueueNotification(state, notificationFrom(subject, subject.record.coordination, 'overdue_review', at));
      if (entry) notifications.push(entry);
    }
  }
  return { id: subject.id, state: previous.state ?? null, changed: false, notifications };
}

// Idempotent whole-queue reconciliation over both record kinds. The installed service loop
// and the existing root heartbeat both call this; running it more often only re-derives the
// same facts. It never changes an execution status, never relaunches and never kills.
export function reconcileCoordination(queue, options = {}) {
  const observe = options.observe ?? memoizedObserver();
  const summary = queue.transaction(state => {
    const result = { scanned: 0, skipped: 0, changed: 0, notified: 0, states: {} };
    const subjects = coordinationSubjects(state);
    for (const subject of subjects) {
      if (!inAdoptionScope(subject, options)) { result.skipped++; continue; }
      const outcome = refreshSubject(state, subject, { ...options, observe });
      result.scanned++;
      if (outcome.changed) result.changed++;
      result.notified += outcome.notifications.length;
      const key = outcome.state ?? 'none';
      result.states[key] = (result.states[key] ?? 0) + 1;
    }
    pruneNotificationIndex(state, subjects.map(subject => subject.id));
    return result;
  });
  // Mirroring is best effort: the durable outbox is the record of truth and the next
  // reconciliation republishes whatever could not be written now.
  try { summary.published = publishNotificationFiles(queue, options); }
  catch { summary.published = null; }
  return summary;
}

export function findSubject(state, id) {
  const job = (state.jobs ?? []).find(entry => entry.id === id);
  if (job) return normalizeSubject(job, 'job');
  const external = (state.service?.externalLaunches ?? []).find(entry => entry?.id === id);
  if (external) return normalizeSubject(external, 'external');
  throw new Error('Unknown coordination subject');
}

// Executor-facing API. A worker may publish that its work is ready for review and that it is
// still making progress. It can never approve, deploy or verify: those live in coordinator.js
// behind an explicit role gate and are not exposed to any worker tool.
export function publishReadiness(queue, id, {
  owner, sha, digest, digestKind = 'result', checkpointDigest = null, evidenceRef = null, coordinator,
  claimedAt = null, now = Date.now(), ...options
} = {}) {
  if (!text(owner) || owner.length > 200) throw new Error('Readiness requires the executing owner identity');
  if (!text(coordinator) || coordinator.length > 200) throw new Error('Readiness requires the awaited coordinator identity');
  if (!text(sha) || !FULL_SHA.test(sha)) throw new Error('Readiness requires the exact full Git commit SHA');
  if (!DIGEST_KINDS.includes(digestKind)) throw new Error(`Digest kind must be one of ${DIGEST_KINDS.join(', ')}`);
  if (!text(digest) || !DIGEST.test(digest)) throw new Error('Readiness requires a result, artifact or checkpoint digest');
  const reference = safeReference(evidenceRef, 'Evidence reference');
  const claim = safeReference(claimedAt, 'Artifact written-at claim');
  const at = iso(now);
  return queue.transaction(state => {
    const subject = findSubject(state, id);
    if (text(subject.owner) && subject.owner !== owner) throw new Error('Readiness ownership mismatch');
    const record = subject.record;
    const revision = subject.kind === 'job' ? (record.revision ?? 0) + 1 : (record.reviewSeq = (record.reviewSeq ?? 0) + 1);
    record.review = {
      source: 'published', revision, sha, digest, digestKind,
      checkpointDigest: text(checkpointDigest) ? checkpointDigest : null,
      evidenceRef: reference, owner, coordinator,
      // `at` is the observed publication time. A written-at claim from an ingested artifact is
      // retained as untrusted metadata and never used to compute elapsed review time.
      at, claimedAt: claim, claimTrusted: false,
      launchId: subject.launchId ?? null,
    };
    subject.review = record.review;
    subject.revision = subject.kind === 'job' ? revision : record.reviewSeq;
    refreshSubject(state, subject, { ...options, now });
    return structuredClone(record.coordination);
  });
}

// Progress is a liveness fact, not a review claim: it only refreshes the staleness clock.
export function publishProgress(queue, id, { owner, note = null, now = Date.now(), ...options } = {}) {
  const reference = safeReference(note, 'Progress note');
  const at = iso(now);
  return queue.transaction(state => {
    const subject = findSubject(state, id);
    if (!text(owner) || (text(subject.owner) && subject.owner !== owner)) throw new Error('Progress ownership mismatch');
    subject.record.progressAt = at;
    subject.record.progressNote = reference;
    subject.progressAt = at;
    refreshSubject(state, subject, { ...options, now });
    return { id: subject.id, progressAt: at, state: subject.record.coordination?.state ?? null };
  });
}

// Read-only projection of the durable coordination record. Safe to print: it carries
// identifiers, hashes and references only, never briefs, results or credentials.
export function coordinationView(queue, id) {
  const state = queue.snapshot();
  const subject = findSubject(state, id);
  const record = subject.coordination ?? null;
  return {
    taskId: subject.id,
    subjectKind: subject.kind,
    status: subject.status,
    coordination: record && {
      state: record.state, reason: record.reason, at: record.at,
      sha: record.sha, observedSha: record.observedSha, observedAt: record.observedAt,
      digest: record.digest, digestKind: record.digestKind,
      evidenceRef: record.evidenceRef, owner: record.owner, coordinator: record.coordinator,
      reviewRevision: record.reviewRevision, reviewSource: record.reviewSource,
      identity: record.identity ?? null,
      overdueNotifiedAt: record.overdueNotifiedAt ?? null,
      approvedBy: record.approval?.coordinator ?? null,
      approvalStale: Boolean(record.approval) && record.state === 'needs_review',
      deployingSince: record.deploy?.at ?? null,
      verifiedBy: record.verification?.coordinator ?? null,
    },
  };
}

export function coordinationSummary(queue, options = {}) {
  const state = queue.snapshot();
  return coordinationSubjects(state).map(subject => ({
    id: subject.id, kind: subject.kind, status: subject.status,
    coordination: subject.coordination?.state ?? null,
    reason: subject.coordination?.reason ?? null,
    at: subject.coordination?.at ?? null,
  })).filter(entry => options.all || entry.coordination !== null);
}

export { DEFAULT_STALE_MS, DEFAULT_IDENTITY_GRACE_MS };
