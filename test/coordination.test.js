import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PersonalQueue } from '../src/personal/queue.js';
import {
  publishReadiness, publishProgress, registerCandidateSource, reconcileCoordination,
  coordinationView, coordinationSummary, coordinationFor, normalizeSubject, reviewFacts,
} from '../src/personal/coordination.js';
import * as coordinator from '../src/personal/coordinator.js';
import { reserveLaunch, attachExternalProcess, finalizeExternalLaunch } from '../src/personal/admission.js';

// Every fact below is synthetic: temporary Git repositories, fake process identities and an
// injected clock. No model call, no real worker and no private runtime state is involved.

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const sha = seed => crypto.createHash('sha1').update(seed).digest('hex');
const digestOf = seed => crypto.createHash('sha256').update(seed).digest('hex');
const BIRTH = 'Mon Sep  8 11:00:00 2026';

function fixture(t, jobs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordination-test-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const queue = new PersonalQueue(path.join(root, 'private'));
  if (jobs.length) queue.transaction(state => { state.jobs.push(...structuredClone(jobs)); });
  return { queue, root };
}

function roster(queue, id = 'root-coordinator') {
  const coordinatorToken = `synthetic-role-proof-${id}`;
  const tokenHash = crypto.createHash('sha256').update(coordinatorToken).digest('hex');
  fs.writeFileSync(path.join(queue.root, 'coordinators.json'), JSON.stringify({ coordinators: [{ id, label: 'synthetic coordinator', tokenHash }] }), { mode: 0o600 });
  return { coordinatorId: id, coordinatorToken };
}

// A real linked worktree, so artifact observation reads actual Git state.
function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordination-repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), worktree = path.join(root, 'work');
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git(repo, 'init');
  fs.writeFileSync(path.join(repo, 'source.txt'), 'first\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Fixture');
  git(repo, 'worktree', 'add', '--detach', worktree, 'HEAD');
  return { git, repo, worktree: fs.realpathSync(worktree), head: () => git(worktree, 'rev-parse', 'HEAD') };
}

const liveJob = (overrides = {}) => ({
  id: 'task-live', owner: 'worker-owner', sourceTask: 'coordinator-task',
  status: 'running', createdAt: '2026-09-08T11:00:00.000Z', startedAt: '2026-09-08T11:59:00.000Z',
  pid: 4321, process: { pid: 4321, birth: BIRTH, startedAt: '2026-09-08T11:59:00.000Z' },
  brief: 'PRIVATE_BRIEF_TEXT', result: 'PRIVATE_RESULT_TEXT',
  ...overrides,
});

test('a live worker waiting for review is advertised for review, never as merely working', t => {
  const { queue } = fixture(t, [liveJob()]);
  const birth = () => BIRTH;
  reconcileCoordination(queue, { birth, now: NOW });
  assert.equal(coordinationView(queue, 'task-live').coordination.state, 'running');

  publishReadiness(queue, 'task-live', {
    owner: 'worker-owner', coordinator: 'root-coordinator',
    sha: sha('head-1'), digest: digestOf('result-1'), digestKind: 'result',
    evidenceRef: 'private:handoff/task-live', birth, now: NOW + 1000,
  });

  const view = coordinationView(queue, 'task-live').coordination;
  assert.equal(view.state, 'needs_review');
  // The process is still alive and confirmed: readiness outranks liveness.
  assert.equal(view.identity.state, 'confirmed');
  assert.equal(view.sha, sha('head-1'));
  assert.equal(view.digest, digestOf('result-1'));
  assert.equal(view.digestKind, 'result');
  assert.equal(view.evidenceRef, 'private:handoff/task-live');
  assert.equal(view.owner, 'worker-owner');
  assert.equal(view.coordinator, 'root-coordinator');
  assert.equal(view.at, new Date(NOW + 1000).toISOString());
  // The execution status is never rewritten by coordination.
  assert.equal(queue.get('task-live').status, 'running');

  for (const step of [1, 2, 3]) reconcileCoordination(queue, { birth, now: NOW + step * 30000 });
  assert.equal(coordinationView(queue, 'task-live').coordination.state, 'needs_review');
});

test('a legacy reported task maps to needs_review with the recorded evidence', t => {
  const { queue } = fixture(t, [liveJob({
    id: 'task-legacy', status: 'reported', baseSha: sha('base'), resultHash: digestOf('report'),
    finishedAt: '2026-09-08T11:59:30.000Z', launchId: 'launch-9',
    events: [{ revision: 3, at: '2026-09-08T11:59:30.000Z', status: 'reported', launchId: 'launch-9' }],
    revision: 3,
  })]);
  reconcileCoordination(queue, { birth: () => null, now: NOW });
  const view = coordinationView(queue, 'task-legacy').coordination;
  assert.equal(view.state, 'needs_review');
  assert.equal(view.reason, 'awaiting_coordinator_review');
  assert.equal(view.reviewSource, 'legacy_reported');
  assert.equal(view.sha, sha('base'));
  assert.equal(view.digest, digestOf('report'));
  // The revision that entered `reported`, which must stay stable while the coordination
  // record itself is written; otherwise every reconciliation would look like new work.
  const entered = view.reviewRevision;
  assert.ok(Number.isInteger(entered));
  assert.equal(view.evidenceRef, 'queue:launch:launch-9');
  assert.equal(queue.get('task-legacy').status, 'reported');
  for (const step of [1, 2, 3]) reconcileCoordination(queue, { birth: () => null, now: NOW + step * 1000 });
  assert.equal(coordinationView(queue, 'task-legacy').coordination.reviewRevision, entered);
});

test('exit, PID reuse, missing identity and stale progress become explicit blocks', t => {
  // The queue stamps its own events with the wall clock, so the injected observation time is
  // ahead of the fixture rather than a fixed date in the past.
  const later = Date.now() + 3600000;
  const start = new Date(Date.now() - 3600000).toISOString();
  const { queue } = fixture(t, [
    liveJob({ id: 'exited', pid: 111, process: { pid: 111, birth: 'b-111', startedAt: start } }),
    liveJob({ id: 'reused', pid: 222, process: { pid: 222, birth: 'b-222', startedAt: start } }),
    liveJob({ id: 'nameless', pid: undefined, process: undefined, startedAt: start }),
    liveJob({ id: 'unprovable', pid: 444, process: { pid: 444, startedAt: start } }),
    liveJob({ id: 'quiet', pid: 555, process: { pid: 555, birth: 'b-555', startedAt: start }, startedAt: start, progressAt: start }),
  ]);
  const births = { 222: 'a-different-process', 444: 'living-but-unattributable', 555: 'b-555' };
  reconcileCoordination(queue, { birth: pid => births[pid] ?? null, now: later, staleAfterMs: 60000 });

  const reasons = Object.fromEntries(coordinationSummary(queue).map(entry => [entry.id, [entry.coordination, entry.reason]]));
  assert.deepEqual(reasons.exited, ['blocked', 'unexpected_exit']);
  assert.deepEqual(reasons.reused, ['blocked', 'identity_mismatch']);
  assert.deepEqual(reasons.nameless, ['blocked', 'identity_missing']);
  assert.deepEqual(reasons.unprovable, ['blocked', 'identity_unprovable']);
  assert.deepEqual(reasons.quiet, ['blocked', 'stale_running']);
  // Nothing was relaunched, killed or resolved: the execution statuses are untouched.
  for (const id of ['exited', 'reused', 'nameless', 'unprovable', 'quiet']) assert.equal(queue.get(id).status, 'running');
});

test('a living process alone is not progress, and published progress refreshes the clock', t => {
  const later = Date.now() + 3600000;
  const start = new Date(Date.now() - 3600000).toISOString();
  const { queue } = fixture(t, [liveJob({ id: 'task-quiet', startedAt: start, process: { pid: 4321, birth: BIRTH, startedAt: start } })]);
  const birth = () => BIRTH;
  reconcileCoordination(queue, { birth, now: later, staleAfterMs: 60000 });
  assert.equal(coordinationView(queue, 'task-quiet').coordination.reason, 'stale_running');
  publishProgress(queue, 'task-quiet', { owner: 'worker-owner', note: 'private:progress/step-2', birth, now: later, staleAfterMs: 60000 });
  const view = coordinationView(queue, 'task-quiet').coordination;
  assert.equal(view.state, 'running');
  assert.equal(view.identity.stale, false);
  // Progress is a liveness fact only: it never claims the work is ready for review.
  assert.equal(view.reviewRevision, null);
});

test('an approval dies when the actual worktree HEAD or the reviewed digest changes', t => {
  const project = repository(t);
  const { queue } = fixture(t, [liveJob({ id: 'task-artifact', status: 'running', worktree: project.worktree, baseSha: project.head() })]);
  const role = roster(queue);
  const birth = () => BIRTH;
  const ready = (sha, digest, at) => publishReadiness(queue, 'task-artifact', {
    owner: 'worker-owner', coordinator: 'root-coordinator', sha, digest, digestKind: 'result',
    evidenceRef: 'private:review/task-artifact', birth, now: at,
  });

  ready(project.head(), digestOf('artifact-1'), NOW);
  const approved = coordinator.approve(queue, 'task-artifact', {
    ...role, sha: project.head(), digest: digestOf('artifact-1'),
    evidence: 'Read the diff at the exact commit and reran the assigned tests.',
    evidenceRef: 'private:approval/task-artifact', birth, now: NOW + 1000,
  });
  assert.equal(approved.state, 'approved');
  assert.equal(approved.approval.coordinator, 'root-coordinator');

  // The worker never republishes: the change alone must invalidate the approval.
  fs.writeFileSync(path.join(project.worktree, 'source.txt'), 'edited after approval\n');
  reconcileCoordination(queue, { birth, now: NOW + 2000 });
  let view = coordinationView(queue, 'task-artifact').coordination;
  assert.equal(view.state, 'needs_review');
  assert.equal(view.reason, 'approval_stale:worktree_modified');
  assert.equal(view.approvalStale, true);
  assert.throws(() => coordinator.startDeployment(queue, 'task-artifact', { ...role, evidence: 'Attempting deployment of stale approval.', birth, now: NOW + 3000 }), /current approval/);

  // A moved HEAD is drift too, even when the worktree is clean again.
  project.git(project.worktree, 'add', '.');
  project.git(project.worktree, 'commit', '-m', 'Later commit');
  reconcileCoordination(queue, { birth, now: NOW + 4000 });
  view = coordinationView(queue, 'task-artifact').coordination;
  assert.equal(view.reason, 'approval_stale:head_moved');
  assert.notEqual(view.observedSha, view.sha);

  // A fresh readiness at the new commit, then a different digest for the same commit.
  ready(project.head(), digestOf('artifact-2'), NOW + 5000);
  coordinator.approve(queue, 'task-artifact', {
    ...role, sha: project.head(), digest: digestOf('artifact-2'),
    evidence: 'Re-reviewed the recommitted artifact at the new commit.', birth, now: NOW + 6000,
  });
  assert.equal(coordinationView(queue, 'task-artifact').coordination.state, 'approved');
  ready(project.head(), digestOf('artifact-3'), NOW + 7000);
  assert.equal(coordinationView(queue, 'task-artifact').coordination.reason, 'approval_stale:review_digest_changed');
});

test('deployment and verification are coordinator-controlled and bound to the approved revision', t => {
  const project = repository(t);
  const { queue } = fixture(t, [liveJob({ id: 'task-deploy', status: 'reported', worktree: project.worktree, baseSha: project.head() })]);
  const role = roster(queue);
  const birth = () => null;
  publishReadiness(queue, 'task-deploy', {
    owner: 'worker-owner', coordinator: 'root-coordinator', sha: project.head(), digest: digestOf('deploy-1'),
    evidenceRef: 'private:review/task-deploy', birth, now: NOW,
  });
  const check = { kind: 'independent-test-run', ref: 'private:evidence/run-77', at: '2026-09-08T12:10:00.000Z' };
  const verifyInput = { ...role, sha: project.head(), digest: digestOf('deploy-1'), evidence: 'Independently reran the suite at the approved commit.', independentCheck: check, birth, now: NOW + 3000 };

  assert.throws(() => coordinator.recordVerification(queue, 'task-deploy', verifyInput), /current approval/);
  coordinator.approve(queue, 'task-deploy', { ...role, sha: project.head(), digest: digestOf('deploy-1'), evidence: 'Reviewed the reported artifact at the exact commit.', birth, now: NOW + 1000 });
  assert.equal(coordinator.startDeployment(queue, 'task-deploy', { ...role, evidence: 'Deploying the approved revision from the coordinator host.', birth, now: NOW + 2000 }).state, 'deploying');
  assert.throws(() => coordinator.recordVerification(queue, 'task-deploy', { ...verifyInput, digest: digestOf('another') }), /exact approved SHA and digest/);
  assert.throws(() => coordinator.recordVerification(queue, 'task-deploy', { ...verifyInput, independentCheck: null }), /independent check record/);
  const verified = coordinator.recordVerification(queue, 'task-deploy', verifyInput);
  assert.equal(verified.state, 'verified');
  assert.equal(verified.verification.coordinator, 'root-coordinator');
  assert.equal(verified.verification.independentCheck.ref, 'private:evidence/run-77');
});

test('a worker cannot approve, deploy or verify its own work', t => {
  const { queue } = fixture(t, [liveJob({ id: 'task-self', status: 'reported', baseSha: sha('base'), resultHash: digestOf('r'), finishedAt: '2026-09-08T11:59:30.000Z' })]);
  const approval = { sha: sha('base'), digest: digestOf('r'), evidence: 'Claiming my own work is fine, which it is not.' };

  // No roster at all: a supplied reviewer name proves nothing.
  assert.throws(() => coordinator.approve(queue, 'task-self', { ...approval, coordinatorId: 'worker-owner', coordinatorToken: 'guess' }), /No coordinator roster/);
  const role = roster(queue, 'worker-owner');
  assert.throws(() => coordinator.approve(queue, 'task-self', { ...approval, coordinatorId: 'worker-owner', coordinatorToken: 'wrong-secret' }), /role proof rejected/);
  // Even with a valid role proof, the executing owner cannot sign off on its own task.
  assert.throws(() => coordinator.approve(queue, 'task-self', { ...approval, ...role }), /cannot review, approve or verify its own work/);
  assert.throws(() => coordinator.approve(queue, 'task-self', { ...approval, coordinatorId: 'root-coordinator', coordinatorToken: role.coordinatorToken }), /Unknown coordinator/);
  // The worker-facing module exposes no approval path.
  assert.deepEqual(Object.keys(coordinationView(queue, 'task-self')).filter(key => /approve|deploy|verif/i.test(key)), []);
  reconcileCoordination(queue, { birth: () => null, now: NOW });
  assert.equal(coordinationView(queue, 'task-self').coordination.state, 'needs_review');
});

test('reconciliation alone never approves, deploys or verifies anything', t => {
  const { queue } = fixture(t, [liveJob({ id: 'task-alone', status: 'reported', baseSha: sha('b'), resultHash: digestOf('d'), finishedAt: '2026-09-08T11:59:30.000Z' })]);
  for (let step = 0; step < 20; step++) reconcileCoordination(queue, { birth: () => BIRTH, now: NOW + step * 60000 });
  const view = coordinationView(queue, 'task-alone').coordination;
  assert.equal(view.state, 'needs_review');
  assert.equal(view.approvedBy, null);
  assert.equal(view.verifiedBy, null);
});

test('a legacy verification stays authoritative only while its artifact is unchanged', t => {
  const project = repository(t);
  const { queue } = fixture(t, [liveJob({
    id: 'task-legacy-verified', status: 'verified', worktree: project.worktree,
    baseSha: project.head(), resultHash: digestOf('legacy'),
    verification: { reviewer: 'earlier-coordinator', evidence: 'Historical review record', at: '2026-09-01T00:00:00.000Z' },
  })]);
  reconcileCoordination(queue, { birth: () => null, now: NOW });
  assert.equal(coordinationView(queue, 'task-legacy-verified').coordination.state, 'verified');
  fs.writeFileSync(path.join(project.worktree, 'source.txt'), 'changed after the historical verification\n');
  reconcileCoordination(queue, { birth: () => null, now: NOW + 1000 });
  const view = coordinationView(queue, 'task-legacy-verified').coordination;
  assert.equal(view.state, 'needs_review');
  assert.equal(view.reason, 'legacy_verification_stale:worktree_modified');
});

test('an officially routed external launch is a coordination subject in place', t => {
  const project = repository(t);
  const { queue } = fixture(t);
  const role = roster(queue);
  coordinator.setRoutingPolicy(queue, { ...role, id: 'native-authorized-tasks-open-20260908', evidence: 'Operator approved open-ended authorized-task native routing.', now: NOW });
  coordinator.recordMachineCapacity(queue, { ...role, maxConcurrentWorkers: 4, basis: 'private:capacity/observation-1', now: NOW });
  const birth = () => BIRTH;
  const launch = reserveLaunch(queue, { policyId: 'native-authorized-tasks-open-20260908', owner: 'worker-owner', coordinator: 'root-coordinator', taskId: 'authorized-task-1', worktree: project.worktree, purpose: 'reliability work', birth, now: NOW });
  assert.equal(launch.policyId, 'native-authorized-tasks-open-20260908');
  assert.equal(launch.authorizationId, null);
  attachExternalProcess(queue, launch.id, { pid: 9911, birth, now: NOW + 1000 });

  reconcileCoordination(queue, { birth, now: NOW + 2000 });
  assert.equal(coordinationView(queue, launch.id).coordination.state, 'running');
  // The external record is tracked where it lives; no duplicate job is created.
  assert.equal(queue.get().length, 0);
  assert.equal(queue.snapshot().service.externalLaunches[0].coordination.state, 'running');

  publishReadiness(queue, launch.id, {
    owner: 'worker-owner', coordinator: 'root-coordinator', sha: project.head(), digest: digestOf('external-1'),
    evidenceRef: 'private:review/external-1', birth, now: NOW + 3000,
  });
  const view = coordinationView(queue, launch.id);
  assert.equal(view.subjectKind, 'external');
  assert.equal(view.coordination.state, 'needs_review');
  assert.equal(view.coordination.identity.state, 'confirmed');

  // A worker declaring its own record verified is finished work, not a verification, and it
  // does not release the slot while the recorded process is still alive.
  finalizeExternalLaunch(queue, launch.id, { state: 'verified', exit: 0, birth, now: NOW + 4000 });
  reconcileCoordination(queue, { birth, now: NOW + 5000 });
  assert.equal(coordinationView(queue, launch.id).coordination.state, 'needs_review');
  assert.equal(coordinationView(queue, launch.id).coordination.verifiedBy, null);
});

test('a settled external launch whose process is still alive is blocked, not released', t => {
  const { queue } = fixture(t);
  queue.transaction(state => {
    state.service = {
      enabled: false, remaining: 1, runner: null,
      externalLaunches: [{ id: 'external-live', owner: 'markets-owner', state: 'finished', createdAt: '2026-09-08T11:50:00.000Z', finishedAt: '2026-09-08T11:58:00.000Z', pid: 7777, birth: BIRTH, worktree: null, reviewRequired: false }],
    };
  });
  reconcileCoordination(queue, { birth: () => BIRTH, now: NOW });
  assert.equal(coordinationView(queue, 'external-live').coordination.reason, 'settled_state_with_live_process');
  // Once the recorded process is really gone, the historical record makes no claim.
  reconcileCoordination(queue, { birth: () => null, now: NOW + 1000 });
  assert.equal(coordinationView(queue, 'external-live').coordination.state, null);
});

test('historical settled launches outside the adoption window are left untouched', t => {
  const { queue } = fixture(t);
  queue.transaction(state => {
    state.service = {
      enabled: true, remaining: 1, runner: null,
      externalLaunches: [
        { id: 'old-images-1', owner: 'markets-owner', state: 'finished', createdAt: '2026-08-01T10:00:00.000Z', finishedAt: '2026-08-01T10:05:00.000Z', pid: 4242, birth: 'old-birth', exit: 0 },
        { id: 'old-images-2', owner: 'markets-owner', createdAt: '2026-08-02T10:00:00.000Z', finishedAt: '2026-08-02T10:05:00.000Z', exit: 0 },
      ],
    };
  });
  const summary = reconcileCoordination(queue, { birth: () => null, now: NOW });
  assert.equal(summary.skipped, 2);
  assert.equal(summary.notified, 0);
  for (const record of queue.snapshot().service.externalLaunches) assert.equal(record.coordination, undefined);
});

test('an ingested artifact timestamp is recorded but never used as elapsed time', t => {
  const { queue } = fixture(t, [liveJob({ id: 'task-ingest' })]);
  const birth = () => BIRTH;
  publishReadiness(queue, 'task-ingest', {
    owner: 'worker-owner', coordinator: 'root-coordinator', sha: sha('ingest'), digest: digestOf('ingest'),
    evidenceRef: 'private:artifact/native-review-1', claimedAt: '2099-01-01T00:00:00.000Z', birth, now: NOW,
  });
  const review = queue.get('task-ingest').review;
  assert.equal(review.at, new Date(NOW).toISOString());
  assert.equal(review.claimedAt, '2099-01-01T00:00:00.000Z');
  assert.equal(review.claimTrusted, false);
  assert.equal(coordinationView(queue, 'task-ingest').coordination.at, new Date(NOW).toISOString());
});

test('readiness requires an exact full SHA, a digest and matching ownership', t => {
  const { queue } = fixture(t, [liveJob({ id: 'task-guard' })]);
  const base = { owner: 'worker-owner', coordinator: 'root-coordinator', sha: sha('x'), digest: digestOf('y'), birth: () => null, now: NOW };
  assert.throws(() => publishReadiness(queue, 'task-guard', { ...base, sha: 'abc' }), /full Git commit SHA/);
  assert.throws(() => publishReadiness(queue, 'task-guard', { ...base, digest: 'nope' }), /digest/);
  assert.throws(() => publishReadiness(queue, 'task-guard', { ...base, owner: 'someone-else' }), /ownership mismatch/);
  assert.throws(() => publishReadiness(queue, 'task-guard', { ...base, coordinator: '' }), /coordinator identity/);
  assert.throws(() => publishReadiness(queue, 'task-guard', { ...base, digestKind: 'invented' }), /Digest kind/);
  assert.throws(() => publishReadiness(queue, 'task-guard', { ...base, evidenceRef: 'x'.repeat(201) }), /single-line reference/);
  assert.equal(queue.get('task-guard').review, undefined);
});

test('coordination derivation is pure and reports incomplete review evidence', () => {
  const subject = normalizeSubject({ id: 'pure', status: 'reported', owner: 'w', sourceTask: 'c', finishedAt: '2026-09-08T11:00:00.000Z' }, 'job');
  const outcome = coordinationFor(subject, { now: NOW, birth: () => null });
  assert.equal(outcome.state, 'needs_review');
  assert.match(outcome.reason, /^review_evidence_incomplete:/);
  assert.equal(reviewFacts(subject).source, 'legacy_reported');
});

// The record shape the existing launcher actually writes when a routed run finishes and waits
// for review, together with the candidate checkpoint file those workers publish beside the
// queue instead of calling `ready`.
const launcherRecord = (overrides = {}) => ({
  id: 'ext-live', authorizationId: null, policyId: 'native-authorized-tasks-open-20260908',
  owner: 'worker-owner', coordinator: 'root-coordinator', state: 'needs_review',
  createdAt: '2026-09-08T11:00:00.000Z', attachedAt: '2026-09-08T11:00:05.000Z',
  finishedAt: '2026-09-08T11:58:00.000Z', exit: 0, pid: 4321, birth: BIRTH,
  worktree: null, taskId: 'authorized-task-1', purpose: 'reliability', reviewRequired: true,
  ...overrides,
});

function writeCandidate(queue, name, candidate) {
  const directory = path.join(queue.root, 'candidates');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, name), JSON.stringify(candidate), { mode: 0o600 });
}

test('a finished launcher record waiting for review is readiness, not finished work', t => {
  const { queue } = fixture(t);
  queue.transaction(state => { state.service = { enabled: false, remaining: 1, runner: null, externalLaunches: [launcherRecord()] }; });
  reconcileCoordination(queue, { birth: () => null, now: NOW });
  const view = coordinationView(queue, 'ext-live');
  assert.equal(view.subjectKind, 'external');
  // Before this fix the record normalized to `finished` and reported finished_without_review.
  assert.equal(view.coordination.state, 'needs_review');
  assert.notEqual(view.coordination.reason, 'finished_without_review');
  assert.equal(view.coordination.owner, 'worker-owner');
  assert.equal(view.coordination.coordinator, 'root-coordinator');
  // Its own execution record is never rewritten.
  assert.equal(queue.snapshot().service.externalLaunches[0].state, 'needs_review');
});

test('a launcher record carrying its own sha and digest reports them exactly', t => {
  const { queue } = fixture(t);
  queue.transaction(state => {
    state.service = { enabled: false, remaining: 1, runner: null, externalLaunches: [launcherRecord({ sha: sha('launcher-head'), digest: digestOf('launcher-result') })] };
  });
  reconcileCoordination(queue, { birth: () => null, now: NOW });
  const view = coordinationView(queue, 'ext-live').coordination;
  assert.equal(view.state, 'needs_review');
  assert.equal(view.reason, 'awaiting_coordinator_review');
  assert.equal(view.sha, sha('launcher-head'));
  assert.equal(view.digest, digestOf('launcher-result'));
});

test('a registered candidate file supplies readiness and never an approval', t => {
  const project = repository(t);
  const { queue } = fixture(t);
  queue.transaction(state => { state.service = { enabled: false, remaining: 1, runner: null, externalLaunches: [launcherRecord({ worktree: project.worktree })] }; });
  writeCandidate(queue, 'ext-live.json', {
    // The shape an existing worker writes, including claims this mechanism must ignore.
    owner: 'worker-owner', reviewer: 'root-coordinator',
    sha: project.head(), resultHash: digestOf('candidate-1'),
    evidence: 'private:candidate/ext-live', writtenAt: '2099-01-01T00:00:00.000Z',
    approved: true, verified: true, deployed: true, state: 'verified',
  });
  const registered = registerCandidateSource(queue, 'ext-live', { owner: 'worker-owner', file: 'ext-live.json', birth: () => null, now: NOW });
  assert.equal(registered.candidateSource.ingested, true);

  const view = coordinationView(queue, 'ext-live').coordination;
  assert.equal(view.state, 'needs_review');
  assert.equal(view.reviewSource, 'candidate_file');
  assert.equal(view.sha, project.head());
  assert.equal(view.digest, digestOf('candidate-1'));
  assert.equal(view.evidenceRef, 'private:candidate/ext-live');
  // Self-declared approval, verification and deployment inside the file are ignored.
  assert.equal(view.approvedBy, null);
  assert.equal(view.verifiedBy, null);
  assert.equal(view.deployingSince, null);
  // The file's own written-at claim is never used as elapsed time.
  const review = queue.snapshot().service.externalLaunches[0].review;
  assert.equal(review.claimTrusted, false);
  assert.equal(review.claimedAt, '2099-01-01T00:00:00.000Z');
  assert.ok(Date.parse(review.at) <= Date.now());

  // Re-reading an unchanged candidate is idempotent: no new revision, no new alert.
  const before = queue.snapshot().service.externalLaunches[0].reviewSeq;
  for (const step of [1, 2, 3]) reconcileCoordination(queue, { birth: () => null, now: NOW + step * 1000 });
  assert.equal(queue.snapshot().service.externalLaunches[0].reviewSeq, before);
  assert.equal(coordinationView(queue, 'ext-live').coordination.state, 'needs_review');
});

test('candidate registration is scoped, ownership checked and never reads arbitrary paths', t => {
  const { queue } = fixture(t);
  queue.transaction(state => { state.service = { enabled: false, remaining: 1, runner: null, externalLaunches: [launcherRecord()] }; });
  const base = { owner: 'worker-owner', birth: () => null, now: NOW };
  for (const file of ['../../etc/passwd', '/etc/passwd', 'nested/path.json', 'no-extension', '.hidden.json', 'a'.repeat(200) + '.json']) {
    assert.throws(() => registerCandidateSource(queue, 'ext-live', { ...base, file }), /plain JSON file name/);
  }
  assert.throws(() => registerCandidateSource(queue, 'ext-live', { ...base, owner: 'someone-else', file: 'ext-live.json' }), /ownership mismatch/);

  // A registered file that is missing, unreadable or not owned readiness leaves no claim.
  registerCandidateSource(queue, 'ext-live', { ...base, file: 'ext-live.json' });
  assert.equal(queue.snapshot().service.externalLaunches[0].review, undefined);
  writeCandidate(queue, 'ext-live.json', { owner: 'a-different-worker', sha: sha('x'), resultHash: digestOf('y') });
  reconcileCoordination(queue, { birth: () => null, now: NOW });
  assert.equal(queue.snapshot().service.externalLaunches[0].review, undefined);
  // A world readable candidate is refused by the same private file rules the gate uses.
  writeCandidate(queue, 'ext-live.json', { owner: 'worker-owner', sha: sha('x'), resultHash: digestOf('y') });
  fs.chmodSync(path.join(queue.root, 'candidates', 'ext-live.json'), 0o644);
  reconcileCoordination(queue, { birth: () => null, now: NOW + 1000 });
  assert.equal(queue.snapshot().service.externalLaunches[0].review, undefined);
});

test('approval requires provable artifact evidence and fails closed without it', t => {
  const { queue } = fixture(t, [liveJob({ id: 'task-no-worktree', status: 'running', worktree: null })]);
  const role = roster(queue);
  const birth = () => BIRTH;
  publishReadiness(queue, 'task-no-worktree', {
    owner: 'worker-owner', coordinator: 'root-coordinator', sha: sha('unprovable'), digest: digestOf('unprovable'),
    evidenceRef: 'private:review/no-worktree', birth, now: NOW,
  });
  assert.equal(coordinationView(queue, 'task-no-worktree').coordination.state, 'needs_review');
  // Nothing observable backs this readiness, so it cannot be approved.
  assert.throws(() => coordinator.approve(queue, 'task-no-worktree', {
    ...role, sha: sha('unprovable'), digest: digestOf('unprovable'),
    evidence: 'Attempting to approve work with no observable artifact.', birth, now: NOW + 1000,
  }), /not currently provable \(artifact_evidence_missing:no_assigned_worktree\)/);
});

test('an approval whose artifact stops being observable becomes stale', t => {
  const project = repository(t);
  const { queue } = fixture(t, [liveJob({ id: 'task-vanishing', status: 'running', worktree: project.worktree, baseSha: project.head() })]);
  const role = roster(queue);
  const birth = () => BIRTH;
  publishReadiness(queue, 'task-vanishing', {
    owner: 'worker-owner', coordinator: 'root-coordinator', sha: project.head(), digest: digestOf('vanishing'),
    evidenceRef: 'private:review/vanishing', birth, now: NOW,
  });
  coordinator.approve(queue, 'task-vanishing', {
    ...role, sha: project.head(), digest: digestOf('vanishing'),
    evidence: 'Reviewed the artifact at the exact commit before it moved.', birth, now: NOW + 1000,
  });
  assert.equal(coordinationView(queue, 'task-vanishing').coordination.state, 'approved');
  // The assigned worktree is gone: uncertainty invalidates rather than preserving.
  fs.rmSync(project.worktree, { recursive: true, force: true });
  reconcileCoordination(queue, { birth, now: NOW + 2000 });
  const view = coordinationView(queue, 'task-vanishing').coordination;
  assert.equal(view.state, 'needs_review');
  assert.match(view.reason, /^approval_stale:artifact_unobservable:/);
  assert.throws(() => coordinator.startDeployment(queue, 'task-vanishing', { ...role, evidence: 'Deploying an unobservable approval must fail.', birth, now: NOW + 3000 }), /current approval/);
});

test('a checkpoint binding that cannot be recomputed is drift, not silence', t => {
  const project = repository(t);
  const scope = { read: ['source.txt'], edit: ['source.txt'], tests: ['test/unit.test.js'] };
  const { queue } = fixture(t, [liveJob({ id: 'task-checkpoint', status: 'running', worktree: project.worktree, baseSha: project.head(), scope })]);
  const role = roster(queue);
  const birth = () => BIRTH;
  const checkpointDigest = digestOf('checkpoint-1');
  publishReadiness(queue, 'task-checkpoint', {
    owner: 'worker-owner', coordinator: 'root-coordinator', sha: project.head(),
    digest: checkpointDigest, digestKind: 'checkpoint', evidenceRef: 'private:review/checkpoint', birth, now: NOW,
  });
  // The observed checkpoint of the real worktree does not match this synthetic digest, so the
  // binding is drift; it must not pass merely because a hash could not be produced.
  assert.throws(() => coordinator.approve(queue, 'task-checkpoint', {
    ...role, sha: project.head(), digest: checkpointDigest,
    evidence: 'Attempting to approve an unmatched checkpoint binding.', birth, now: NOW + 1000,
  }), /not currently provable \(checkpoint_/);
});

test('a candidate written directly beside the queue is supported, private state files are not', t => {
  const { queue } = fixture(t);
  queue.transaction(state => { state.service = { enabled: false, remaining: 1, runner: null, externalLaunches: [launcherRecord()] }; });
  fs.writeFileSync(path.join(queue.root, 'ext-live-checkpoint.json'), JSON.stringify({
    owner: 'worker-owner', reviewer: 'root-coordinator', headSha: sha('beside-queue'),
    artifactDigest: digestOf('beside-queue'), report: 'private:candidate/beside-queue',
  }), { mode: 0o600 });
  registerCandidateSource(queue, 'ext-live', { owner: 'worker-owner', file: 'ext-live-checkpoint.json', location: 'root', birth: () => null, now: NOW });
  const view = coordinationView(queue, 'ext-live').coordination;
  assert.equal(view.state, 'needs_review');
  assert.equal(view.sha, sha('beside-queue'));
  assert.equal(view.digest, digestOf('beside-queue'));
  assert.equal(view.digestKind, 'artifact');

  // Private state files can never be registered as review candidates, in any location.
  for (const file of ['queue.json', 'native-max-verification.json', 'coordinators.json', 'service-health.json']) {
    assert.throws(() => registerCandidateSource(queue, 'ext-live', { owner: 'worker-owner', file, location: 'root', birth: () => null, now: NOW }), /not a review candidate/);
  }
  assert.throws(() => registerCandidateSource(queue, 'ext-live', { owner: 'worker-owner', file: 'ext-live.json', location: 'anywhere', birth: () => null, now: NOW }), /Candidate location/);
  // The earlier valid registration is untouched by the refused ones.
  assert.equal(queue.snapshot().service.externalLaunches[0].candidateSource.file, 'ext-live-checkpoint.json');
});
