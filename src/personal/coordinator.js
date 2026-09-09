import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findSubject, refreshSubject, reviewFacts, approvalDrift } from './coordination.js';
import { memoizedObserver, artifactDrift } from './artifact.js';
import { safeReference, markDelivered, markAcknowledged } from './notifications.js';
import { externalAuthorizations, routingPolicy, ROUTED_MODE, ROUTED_PROVIDER, LEGACY_MAX_CONCURRENCY } from './admission.js';

// The protected coordinator surface. Approval, deployment, verification, routing policy,
// machine capacity, launch authorization and notification acknowledgement live here and
// nowhere else. No worker-facing module imports this file, and no task tool exposes it.
//
// Trust model, stated plainly: a caller proves the coordinator role by presenting a secret
// whose SHA-256 matches a roster entry in the private queue directory. The roster stores
// only hashes, so reading it does not let a worker forge an approval. This is a real control
// against accidental or tool-mediated self-approval; it is NOT an operating-system security
// boundary. Anything running as the same user can read this process's memory, its arguments
// and the operator's own token file. Separate accounts, or a coordinator on another host,
// are the only real isolation. See docs/COORDINATION-RELIABILITY.md.

const ROSTER = 'coordinators.json';
const text = value => typeof value === 'string' && value.trim().length > 0;
const iso = now => new Date(now).toISOString();
const EVIDENCE_MIN = 20;

export function readRoster(root) {
  const file = path.join(root, ROSTER);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1) throw new Error('Coordinator roster must be a private regular file owned by this user with mode 0600');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || !Array.isArray(parsed.coordinators) || !parsed.coordinators.length) throw new Error('Coordinator roster must list at least one coordinator');
  return parsed.coordinators;
}

// Constant-time comparison of the presented secret against the recorded hash.
export function assertCoordinator(root, { coordinatorId, coordinatorToken } = {}) {
  if (!text(coordinatorId)) throw new Error('Coordinator identity required');
  if (!text(coordinatorToken)) throw new Error('Coordinator role proof required; a supplied reviewer name is not sufficient');
  let entry;
  try { entry = readRoster(root).find(candidate => candidate?.id === coordinatorId); }
  catch (error) { throw new Error(error.code === 'ENOENT' ? 'No coordinator roster is installed; the coordinator must create it before using this command' : error.message); }
  if (!entry || !/^[a-f0-9]{64}$/.test(entry.tokenHash ?? '')) throw new Error('Unknown coordinator or missing role proof; refusing the command');
  const presented = crypto.createHash('sha256').update(coordinatorToken).digest();
  const recorded = Buffer.from(entry.tokenHash, 'hex');
  if (presented.length !== recorded.length || !crypto.timingSafeEqual(presented, recorded)) throw new Error('Coordinator role proof rejected');
  return { id: entry.id, label: entry.label ?? null };
}

function requireEvidence(evidence) {
  if (typeof evidence !== 'string' || evidence.trim().length < EVIDENCE_MIN) throw new Error(`Independent evidence of at least ${EVIDENCE_MIN} characters is required`);
  return evidence.trim();
}

// A coordinator may not sign off on work it executed itself.
function assertNotSelfReview(coordinator, subject, review) {
  if (coordinator === subject.owner || (review && coordinator === review.owner)) throw new Error('The executing owner cannot review, approve or verify its own work');
}

function coordinatorChange(queue, id, role, apply, options = {}) {
  const observe = options.observe ?? memoizedObserver();
  return queue.transaction(state => {
    const subject = findSubject(state, id);
    const review = reviewFacts(subject);
    const observation = observe(subject, options);
    apply({ state, subject, review, observation, role });
    refreshSubject(state, subject, { ...options, observe });
    return structuredClone(subject.record.coordination);
  });
}

// Binds an approval to the exact reviewed revision, SHA and digest, after re-observing what
// the assigned worktree contains right now. It never marks anything deployed or verified.
export function approve(queue, id, { coordinatorId, coordinatorToken, sha, digest, evidence, evidenceRef = null, now = Date.now(), ...options } = {}) {
  const role = assertCoordinator(queue.root, { coordinatorId, coordinatorToken });
  const attestation = requireEvidence(evidence);
  const reference = safeReference(evidenceRef, 'Evidence reference');
  return coordinatorChange(queue, id, role, ({ subject, review, observation }) => {
    if (!review) throw new Error('There is no published review readiness to approve');
    assertNotSelfReview(role.id, subject, review);
    if (review.sha !== sha || review.digest !== digest) throw new Error('Approval must bind the exact reviewed SHA and digest');
    const drift = artifactDrift({ sha: review.sha, digest: review.digest, digestKind: review.digestKind, checkpointDigest: review.checkpointDigest ?? null }, observation);
    if (drift) throw new Error(`Reviewed artifact changed since readiness (${drift}); re-review before approving`);
    subject.record.coordination = {
      ...(subject.coordination ?? {}),
      approval: {
        coordinator: role.id, sha, digest, digestKind: review.digestKind,
        checkpointDigest: review.checkpointDigest ?? null,
        reviewRevision: review.revision, evidence: attestation, evidenceRef: reference,
        observedSha: observation?.headSha ?? null, at: iso(now),
      },
      deploy: null, verification: null,
    };
    subject.coordination = subject.record.coordination;
  }, { ...options, now });
}

// Deployment is a coordinator-controlled state. A worker can never enter it.
export function startDeployment(queue, id, { coordinatorId, coordinatorToken, evidence, evidenceRef = null, now = Date.now(), ...options } = {}) {
  const role = assertCoordinator(queue.root, { coordinatorId, coordinatorToken });
  const attestation = requireEvidence(evidence);
  const reference = safeReference(evidenceRef, 'Evidence reference');
  return coordinatorChange(queue, id, role, ({ subject, review, observation }) => {
    const approval = subject.coordination?.approval ?? null;
    const drift = approvalDrift(review, approval, observation);
    if (drift) throw new Error(`Deployment requires a current approval (${drift})`);
    subject.record.coordination = {
      ...subject.coordination,
      deploy: { coordinator: role.id, approvedAt: approval.at, evidence: attestation, evidenceRef: reference, at: iso(now) },
      verification: null,
    };
    subject.coordination = subject.record.coordination;
  }, { ...options, now });
}

// Verification requires independent evidence gathered at the exact approved revision, and
// re-checks the artifact rather than trusting the approval record alone.
export function recordVerification(queue, id, { coordinatorId, coordinatorToken, sha, digest, evidence, evidenceRef = null, independentCheck = null, now = Date.now(), ...options } = {}) {
  const role = assertCoordinator(queue.root, { coordinatorId, coordinatorToken });
  const attestation = requireEvidence(evidence);
  const reference = safeReference(evidenceRef, 'Evidence reference');
  if (!independentCheck || typeof independentCheck !== 'object') throw new Error('Verification requires an independent check record');
  const kind = safeReference(independentCheck.kind, 'Independent check kind');
  const checkRef = safeReference(independentCheck.ref, 'Independent check reference');
  if (!kind || !checkRef) throw new Error('Independent check requires a kind and a reference');
  return coordinatorChange(queue, id, role, ({ subject, review, observation }) => {
    const approval = subject.coordination?.approval ?? null;
    const drift = approvalDrift(review, approval, observation);
    if (drift) throw new Error(`Verification requires a current approval (${drift})`);
    assertNotSelfReview(role.id, subject, review);
    if (approval.sha !== sha || approval.digest !== digest) throw new Error('Verification must name the exact approved SHA and digest');
    subject.record.coordination = {
      ...subject.coordination,
      verification: {
        coordinator: role.id, approvedAt: approval.at, sha, digest,
        evidence: attestation, evidenceRef: reference,
        independentCheck: { kind, ref: checkRef, at: safeReference(independentCheck.at, 'Independent check time') },
        observedSha: observation?.headSha ?? null, at: iso(now),
      },
    };
    subject.coordination = subject.record.coordination;
  }, { ...options, now });
}

// Records the operator-approved routing policy and preserves every earlier policy.
export function setRoutingPolicy(queue, {
  coordinatorId, coordinatorToken, id, mode = ROUTED_MODE, provider = ROUTED_PROVIDER,
  fixedWorkerCap = null, fixedTrialLaunchCap = null, evidence, now = Date.now(),
} = {}) {
  const role = assertCoordinator(queue.root, { coordinatorId, coordinatorToken });
  const attestation = requireEvidence(evidence);
  if (!text(id) || id.length > 200) throw new Error('Routing policy requires a stable id');
  if (mode !== ROUTED_MODE || provider !== ROUTED_PROVIDER) throw new Error('Only the authorized-task official native route is supported');
  if (fixedWorkerCap !== null && (!Number.isInteger(fixedWorkerCap) || fixedWorkerCap < 1)) throw new Error('Fixed worker cap must be null or a positive integer');
  if (fixedTrialLaunchCap !== null && (!Number.isInteger(fixedTrialLaunchCap) || fixedTrialLaunchCap < 1)) throw new Error('Fixed trial launch cap must be null or a positive integer');
  return queue.transaction(state => {
    const service = state.service ??= { enabled: false, remaining: 0, runner: null };
    const current = service.routingPolicy ?? null;
    if (current?.id === id) return structuredClone(current);
    const history = service.routingPolicyHistory ??= [];
    if (history.some(entry => entry?.id === id)) throw new Error('Retired routing policy identifiers cannot be reused');
    if (current) history.push({ ...current, closedAt: iso(now) });
    service.routingPolicy = {
      id, mode, provider, fixedWorkerCap, fixedTrialLaunchCap,
      authorizedBy: role.id, authorizedAt: iso(now), evidence: attestation,
    };
    return structuredClone(service.routingPolicy);
  });
}

// Records what this machine can actually host. Missing, malformed or expired records make
// admission fail closed rather than assume capacity.
export function recordMachineCapacity(queue, { coordinatorId, coordinatorToken, maxConcurrentWorkers, basis, ttlMs = null, uncertain = false, now = Date.now() } = {}) {
  assertCoordinator(queue.root, { coordinatorId, coordinatorToken });
  const reference = safeReference(basis, 'Capacity basis');
  if (uncertain !== true && (!Number.isInteger(maxConcurrentWorkers) || maxConcurrentWorkers < 1)) throw new Error('Machine capacity requires a positive integer worker count, or an explicit uncertain flag');
  if (ttlMs !== null && (!Number.isInteger(ttlMs) || ttlMs < 1)) throw new Error('Capacity freshness must be null or a positive integer of milliseconds');
  return queue.transaction(state => {
    const service = state.service ??= { enabled: false, remaining: 0, runner: null };
    const previous = service.machineCapacity ?? null;
    if (previous) (service.machineCapacityHistory ??= []).push({ ...previous, closedAt: iso(now) });
    service.machineCapacity = {
      maxConcurrentWorkers: uncertain === true ? null : maxConcurrentWorkers,
      basis: reference, ttlMs, uncertain: uncertain === true, observedAt: iso(now),
    };
    return structuredClone(service.machineCapacity);
  });
}

// A finite external authorization for the legacy route. Existing entries are never edited,
// never refilled and never removed.
export function authorizeExternalLaunches(queue, { coordinatorId, coordinatorToken, authorizationId, launches, purpose = null, evidence, now = Date.now() } = {}) {
  const role = assertCoordinator(queue.root, { coordinatorId, coordinatorToken });
  const attestation = requireEvidence(evidence);
  const reference = safeReference(purpose, 'Authorization purpose');
  if (!text(authorizationId) || authorizationId.length > 200) throw new Error('External authorization requires a stable id');
  if (!Number.isInteger(launches) || launches < 1 || launches > LEGACY_MAX_CONCURRENCY) throw new Error(`Legacy external authorization must grant between 1 and ${LEGACY_MAX_CONCURRENCY} launches`);
  return queue.transaction(state => {
    const ledger = externalAuthorizations(state);
    const existing = ledger.find(entry => entry?.id === authorizationId);
    if (existing) {
      if (existing.launchLimit !== launches || existing.evidence !== attestation) throw new Error('Authorization identifier is already recorded with different terms');
      return structuredClone(existing);
    }
    const entry = {
      id: authorizationId, launchLimit: launches, remaining: launches, purpose: reference,
      evidence: attestation, authorizedBy: role.id, authorizedAt: iso(now), consumed: [],
    };
    ledger.push(entry);
    return structuredClone(entry);
  });
}

export function setConcurrency(queue, { coordinatorId, coordinatorToken, limit, evidence, now = Date.now() } = {}) {
  const role = assertCoordinator(queue.root, { coordinatorId, coordinatorToken });
  const attestation = requireEvidence(evidence);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency limit must be a positive integer');
  return queue.transaction(state => {
    const service = state.service ??= { enabled: false, remaining: 0, runner: null };
    const policy = routingPolicy(state);
    if (!policy && limit > LEGACY_MAX_CONCURRENCY) throw new Error('Legacy concurrency cannot exceed five without an approved routing policy');
    const previous = service.concurrency ?? null;
    if (previous) (service.concurrencyHistory ??= []).push({ ...previous, closedAt: iso(now) });
    service.concurrency = { limit, policyId: policy?.id ?? null, authorizedBy: role.id, evidence: attestation, at: iso(now) };
    return structuredClone(service.concurrency);
  });
}

// Acknowledgement is a coordinator statement, so a worker cannot silence its own alerts.
export function confirmDelivery(queue, { coordinatorId, coordinatorToken, ids, transport = null, now = Date.now() } = {}) {
  const role = assertCoordinator(queue.root, { coordinatorId, coordinatorToken });
  return markDelivered(queue, ids, { consumer: role.id, transport, now });
}

export function acknowledge(queue, { coordinatorId, coordinatorToken, ids, note = null, now = Date.now() } = {}) {
  const role = assertCoordinator(queue.root, { coordinatorId, coordinatorToken });
  return markAcknowledged(queue, ids, { consumer: role.id, note, now });
}
