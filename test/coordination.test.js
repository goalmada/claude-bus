import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PersonalQueue } from '../src/personal/queue.js';
import {
  publishReadiness, publishProgress, reconcileCoordination, coordinationView,
  coordinationSummary, coordinationFor, normalizeSubject, reviewFacts,
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
