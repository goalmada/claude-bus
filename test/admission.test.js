import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PersonalQueue } from '../src/personal/queue.js';
import {
  admissionStatus, assertAdmission, launchLimit, occupiedSlots, reserveLaunch,
  attachExternalProcess, finalizeExternalLaunch, LEGACY_CONCURRENCY, LEGACY_MAX_CONCURRENCY,
} from '../src/personal/admission.js';
import * as coordinator from '../src/personal/coordinator.js';
import { serviceTick, configureService } from '../src/personal/service.js';

// Synthetic ledgers only. The concurrency race uses real separate processes against one
// temporary queue; nothing here launches a worker or touches live runtime state.

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const POLICY = 'native-authorized-tasks-open-20260908';
const BIRTH = 'Mon Sep  8 11:00:00 2026';
const contender = fileURLToPath(new URL('./fixtures/reserve-launch.js', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-test-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new PersonalQueue(path.join(root, 'private'));
}

function roster(queue, id = 'root-coordinator') {
  const coordinatorToken = `synthetic-role-proof-${id}`;
  const tokenHash = crypto.createHash('sha256').update(coordinatorToken).digest('hex');
  fs.writeFileSync(path.join(queue.root, 'coordinators.json'), JSON.stringify({ coordinators: [{ id, label: 'synthetic coordinator', tokenHash }] }), { mode: 0o600 });
  return { coordinatorId: id, coordinatorToken };
}

// The historical ledger this feature must preserve exactly: one legacy service batch with a
// consumed remainder, and one already consumed single-launch external authorization.
function legacyLedger(queue) {
  queue.transaction(state => {
    state.service = {
      enabled: true, remaining: 1, runner: null,
      authorizationId: 'legacy-batch-7', launchLimit: 5, authorizationEnabled: true,
      authorizedAt: '2026-09-01T00:00:00.000Z', authorizationEvidence: 'Historical operator approval for the legacy trial',
      authorizationHistory: [{ authorizationId: 'legacy-batch-6', launchLimit: 5, remaining: 0, authorizedAt: '2026-08-01T00:00:00.000Z', authorizationEvidence: 'Earlier batch', authorizationEnabled: true, closedAt: '2026-09-01T00:00:00.000Z' }],
      externalAuthorizations: [{ id: 'reliability-trial-1', launchLimit: 1, remaining: 0, evidence: 'Single launch approved for the reliability task', authorizedAt: '2026-09-08T09:00:00.000Z', consumed: [{ launchId: 'external-old', at: '2026-09-08T09:01:00.000Z' }] }],
      externalLaunches: [{ id: 'external-old', authorizationId: 'reliability-trial-1', owner: 'worker-owner', state: 'finished', createdAt: '2026-09-08T09:01:00.000Z', finishedAt: '2026-09-08T09:30:00.000Z', exit: 0, pid: 3131, birth: 'old-birth' }],
    };
  });
}

const routed = (queue, role, capacity = 5) => {
  coordinator.setRoutingPolicy(queue, { ...role, id: POLICY, evidence: 'Operator approved open-ended authorized-task native routing.', now: NOW });
  if (capacity !== null) coordinator.recordMachineCapacity(queue, { ...role, maxConcurrentWorkers: capacity, basis: 'private:capacity/observation-1', now: NOW });
};

test('the legacy serial limit is the default and cannot be raised without a routing policy', t => {
  const queue = fixture(t);
  const role = roster(queue);
  assert.deepEqual(launchLimit(queue.snapshot()), { limit: LEGACY_CONCURRENCY, source: 'legacy_default', policyId: null });
  assert.throws(() => coordinator.setConcurrency(queue, { ...role, limit: LEGACY_MAX_CONCURRENCY + 1, evidence: 'Trying to raise the legacy bound without a policy.' }), /cannot exceed five/);
  coordinator.setConcurrency(queue, { ...role, limit: 3, evidence: 'Explicitly approved three concurrent legacy launches.', now: NOW });
  assert.equal(launchLimit(queue.snapshot()).limit, 3);
  assert.equal(launchLimit(queue.snapshot()).source, 'legacy_configured');
});

test('an approved routing policy replaces the fixed caps and preserves policy history', t => {
  const queue = fixture(t);
  const role = roster(queue);
  routed(queue, role, 8);
  const policy = queue.snapshot().service.routingPolicy;
  assert.equal(policy.id, POLICY);
  assert.equal(policy.mode, 'authorized_tasks');
  assert.equal(policy.provider, 'official_native_claude_max');
  assert.equal(policy.fixedWorkerCap, null);
  assert.equal(policy.fixedTrialLaunchCap, null);
  assert.equal(policy.authorizedBy, 'root-coordinator');
  // No invented ceiling of five under the policy: the machine capacity is the bound.
  const limit = launchLimit(queue.snapshot());
  assert.equal(limit.limit, 8);
  assert.equal(limit.source, 'routed_machine_capacity');
  assert.equal(limit.policyId, POLICY);

  coordinator.setRoutingPolicy(queue, { ...role, id: 'native-authorized-tasks-open-20260909', evidence: 'Superseding operator routing approval recorded later.', now: NOW + 1000 });
  const history = queue.snapshot().service.routingPolicyHistory;
  assert.equal(history.length, 1);
  assert.equal(history[0].id, POLICY);
  assert.equal(history[0].closedAt, new Date(NOW + 1000).toISOString());
  assert.throws(() => coordinator.setRoutingPolicy(queue, { ...role, id: POLICY, evidence: 'Reusing a retired policy identifier must fail.' }), /cannot be reused/);
});

test('machine capacity fails closed when it is missing, uncertain or expired', t => {
  const queue = fixture(t);
  const role = roster(queue);
  routed(queue, role, null);
  // An open-ended policy with nothing recorded about this machine stays serial.
  assert.deepEqual(launchLimit(queue.snapshot(), { now: NOW }), { limit: LEGACY_CONCURRENCY, source: 'routed_capacity_unrecorded', policyId: POLICY });

  coordinator.recordMachineCapacity(queue, { ...role, uncertain: true, basis: 'private:capacity/unknown-load', now: NOW });
  assert.throws(() => launchLimit(queue.snapshot(), { now: NOW }), /uncertain/);
  coordinator.recordMachineCapacity(queue, { ...role, maxConcurrentWorkers: 6, basis: 'private:capacity/observation-2', ttlMs: 3600000, now: NOW });
  assert.equal(launchLimit(queue.snapshot(), { now: NOW + 1000 }).limit, 6);
  assert.throws(() => launchLimit(queue.snapshot(), { now: NOW + 3600001 }), /expired/);
  assert.throws(() => launchLimit(queue.snapshot(), { now: NOW - 1000 }), /future/);
  assert.equal(queue.snapshot().service.machineCapacityHistory.length, 1);
});

test('a routed reservation cites the policy and never touches the historical counters', t => {
  const queue = fixture(t);
  legacyLedger(queue);
  const role = roster(queue);
  routed(queue, role, 5);
  const before = queue.snapshot().service;

  const launch = reserveLaunch(queue, { policyId: POLICY, owner: 'worker-owner', taskId: 'authorized-task-1', worktree: null, purpose: 'reliability', birth: () => null, now: NOW });
  assert.equal(launch.policyId, POLICY);
  assert.equal(launch.authorizationId, null);

  const after = queue.snapshot().service;
  // Every historical fact is preserved untouched, and nothing is refilled.
  assert.equal(after.remaining, before.remaining);
  assert.equal(after.authorizationId, 'legacy-batch-7');
  assert.deepEqual(after.authorizationHistory, before.authorizationHistory);
  assert.deepEqual(after.externalAuthorizations, before.externalAuthorizations);
  assert.equal(after.externalAuthorizations[0].remaining, 0);
  assert.equal(after.externalLaunches[0].id, 'external-old');
  assert.equal(after.externalLaunches.length, 2);
  assert.equal(after.runner, null);

  // The consumed one-launch authorization stays consumed.
  assert.throws(() => reserveLaunch(queue, { authorizationId: 'reliability-trial-1', owner: 'worker-owner', birth: () => null, now: NOW }), /exhausted; no automatic refill/);
});

test('a legacy external authorization is consumed exactly once', t => {
  const queue = fixture(t);
  const role = roster(queue);
  coordinator.setConcurrency(queue, { ...role, limit: 3, evidence: 'Three concurrent legacy launches approved for this test.', now: NOW });
  coordinator.authorizeExternalLaunches(queue, { ...role, authorizationId: 'trial-2', launches: 1, purpose: 'one direct launch', evidence: 'Operator approved exactly one direct launch.', now: NOW });
  const record = reserveLaunch(queue, { authorizationId: 'trial-2', owner: 'worker-owner', birth: () => null, now: NOW });
  const ledger = queue.snapshot().service.externalAuthorizations.find(entry => entry.id === 'trial-2');
  assert.equal(ledger.launchLimit, 1);
  assert.equal(ledger.remaining, 0);
  assert.deepEqual(ledger.consumed.map(entry => entry.launchId), [record.id]);
  assert.throws(() => reserveLaunch(queue, { authorizationId: 'trial-2', owner: 'worker-owner', birth: () => null, now: NOW }), /exhausted/);
  assert.throws(() => coordinator.authorizeExternalLaunches(queue, { ...role, authorizationId: 'trial-2', launches: 2, evidence: 'Attempting different terms under the same id.' }), /different terms/);
});

test('one task identity holds one slot and cannot be reserved twice', t => {
  const queue = fixture(t);
  const role = roster(queue);
  routed(queue, role, 5);
  reserveLaunch(queue, { policyId: POLICY, owner: 'worker-owner', taskId: 'authorized-task-1', birth: () => null, now: NOW });
  assert.throws(() => reserveLaunch(queue, { policyId: POLICY, owner: 'another-owner', taskId: 'authorized-task-1', birth: () => null, now: NOW }), /already reserved or running/);
  assert.equal(queue.snapshot().service.externalLaunches.length, 1);
  // A job in flight under the same identity is the same slot, counted once.
  queue.transaction(state => state.jobs.push({ id: 'authorized-task-1', status: 'running', owner: 'worker-owner', createdAt: '2026-09-08T11:00:00.000Z' }));
  assert.equal(admissionStatus(queue.snapshot(), { birth: () => null, now: NOW }).used, 1);
});

test('a worker-declared finish does not release a slot while its process is alive', t => {
  const queue = fixture(t);
  const role = roster(queue);
  routed(queue, role, 2);
  const launch = reserveLaunch(queue, { policyId: POLICY, owner: 'worker-owner', taskId: 'authorized-task-1', birth: () => null, now: NOW });
  attachExternalProcess(queue, launch.id, { pid: 8181, birth: () => BIRTH, now: NOW });
  finalizeExternalLaunch(queue, launch.id, { state: 'verified', exit: 0, birth: () => BIRTH, now: NOW + 1000 });

  const alive = { birth: () => BIRTH, now: NOW + 2000 };
  assert.equal(admissionStatus(queue.snapshot(), alive).used, 1);
  assert.equal(occupiedSlots(queue.snapshot(), alive)[0].uncertain, true);
  assert.equal(occupiedSlots(queue.snapshot(), alive)[0].reason, 'external_settled_with_live_process');
  // Only an observed exit releases it.
  assert.equal(admissionStatus(queue.snapshot(), { birth: () => null, now: NOW + 3000 }).used, 0);
});

test('unfinished and ambiguous legacy external records occupy a slot conservatively', t => {
  const queue = fixture(t);
  queue.transaction(state => {
    state.service = {
      enabled: true, remaining: 1, runner: null,
      externalLaunches: [
        { id: 'legacy-unfinished', owner: 'markets-owner', createdAt: '2026-09-08T09:00:00.000Z' },
        { id: 'legacy-done', owner: 'markets-owner', createdAt: '2026-09-08T08:00:00.000Z', finishedAt: '2026-09-08T08:30:00.000Z', exit: 0 },
      ],
    };
  });
  const slots = occupiedSlots(queue.snapshot(), { birth: () => null, now: NOW });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].id, 'legacy-unfinished');
  assert.equal(slots[0].uncertain, true);
  assert.equal(slots[0].reason, 'external_identity_unrecorded');
  assert.throws(() => assertAdmission(queue.snapshot(), { birth: () => null, now: NOW }), /One executor at a time/);
});

test('the finalizer preserves concurrent ledger updates and never enables the service', t => {
  const queue = fixture(t);
  const role = roster(queue);
  routed(queue, role, 3);
  const launch = reserveLaunch(queue, { policyId: POLICY, owner: 'worker-owner', taskId: 'authorized-task-1', birth: () => null, now: NOW });

  // Another writer changes the ledger between the reservation and the finalization, exactly
  // as the images launcher does when it re-enables the legacy service on exit.
  queue.transaction(state => {
    state.service.enabled = true;
    state.service.externalLaunches.push({ id: 'concurrent-images', owner: 'markets-owner', state: 'running', createdAt: '2026-09-08T12:00:30.000Z' });
  });
  finalizeExternalLaunch(queue, launch.id, { state: 'finished', exit: 0, evidenceRef: 'private:evidence/launch-1', birth: () => null, now: NOW + 1000 });

  const service = queue.snapshot().service;
  assert.equal(service.enabled, true);
  assert.equal(service.externalLaunches.length, 2);
  assert.equal(service.externalLaunches[1].id, 'concurrent-images');
  assert.equal(service.externalLaunches[1].state, 'running');
  const finalized = service.externalLaunches[0];
  assert.equal(finalized.state, 'finished');
  assert.equal(finalized.exit, 0);
  assert.equal(finalized.evidenceRef, 'private:evidence/launch-1');
  // Finalizing is idempotent and never refills the ledger.
  finalizeExternalLaunch(queue, launch.id, { state: 'failed', exit: 9, birth: () => null, now: NOW + 5000 });
  assert.equal(queue.snapshot().service.externalLaunches[0].finishedAt, new Date(NOW + 1000).toISOString());
});

test('six real processes race for five slots and exactly one is refused', async t => {
  const queue = fixture(t);
  const role = roster(queue);
  routed(queue, role, 5);
  const run = (taskId) => new Promise(resolve => {
    execFile(process.execPath, [contender, queue.root, POLICY, 'worker-owner', taskId], { timeout: 30000 }, (error, stdout) => {
      resolve(error && !stdout ? { ok: false, taskId, message: String(error.message) } : JSON.parse(stdout));
    });
  });
  const outcomes = await Promise.all(Array.from({ length: 6 }, (_, index) => run(`authorized-task-${index}`)));
  const accepted = outcomes.filter(outcome => outcome.ok);
  const refused = outcomes.filter(outcome => !outcome.ok);
  assert.equal(accepted.length, 5);
  assert.equal(refused.length, 1);
  assert.match(refused[0].message, /Bounded concurrency reached: 5 of 5/);
  const launches = queue.snapshot().service.externalLaunches;
  assert.equal(launches.length, 5);
  assert.equal(new Set(launches.map(record => record.taskId)).size, 5);
  assert.equal(new Set(launches.map(record => record.id)).size, 5);
  assert.equal(admissionStatus(queue.snapshot(), { birth: () => null, now: Date.now() }).available, 0);
});

test('the legacy service shares the same bound as the direct route', t => {
  const queue = fixture(t);
  queue.transaction(state => state.jobs.push({ id: 'task-one', owner: 'test-owner', sourceTask: 'test-source', createdAt: '2026-01-01T00:00:00.000Z', status: 'queued' }));
  configureService(queue, { authorizationId: 'fixture-batch', enabled: true, launches: 2, evidence: 'Explicit synthetic service test authorization' });
  fs.writeFileSync(path.join(queue.root, 'native-max-verification.json'), JSON.stringify({
    enabled: true, plan: 'max', extraUsageEnabled: false, available: true, checkedAt: new Date(NOW - 60000).toISOString(),
    organizationId: '00000000-0000-0000-0000-000000000000', evidence: 'Synthetic private gate evidence',
  }), { mode: 0o600 });
  queue.transaction(state => {
    state.service.externalLaunches = [{ id: 'direct-live', owner: 'worker-owner', state: 'running', createdAt: '2026-09-08T11:55:00.000Z', pid: 9090, birth: BIRTH }];
  });
  const outcome = serviceTick(queue, { birth: () => BIRTH, now: NOW, launch: () => assert.fail('must not launch while the shared bound is full') });
  assert.deepEqual(outcome, { state: 'blocked', reason: 'launch_admission_full', taskId: 'task-one' });
  // The allowance is untouched by a refused admission.
  assert.equal(queue.snapshot().service.remaining, 2);
  assert.equal(queue.get('task-one').status, 'queued');
});

test('a duplicate record under a claimed identity is never hidden behind a reservation', t => {
  const queue = fixture(t);
  queue.transaction(state => {
    state.jobs.push({ id: 'task-one', owner: 'worker-owner', sourceTask: 'coordinator-task', status: 'queued', createdAt: '2026-09-08T11:00:00.000Z' });
    state.service = {
      enabled: false, remaining: 0,
      runner: { id: 'reserved', taskId: 'task-one', createdAt: '2026-09-08T11:59:00.000Z', pid: null, birth: null },
      externalLaunches: [{ id: 'shadow', owner: 'another-owner', state: 'running', createdAt: '2026-09-08T11:30:00.000Z', pid: 5150, birth: BIRTH, taskId: 'task-one' }],
    };
  });
  const observed = { birth: () => BIRTH, now: NOW };
  const claim = { key: 'task:task-one', kind: 'runner' };
  // The reservation may release its own slot, but the shadow record under the same identity
  // still occupies one, so the caller cannot launch past the bound.
  assert.equal(admissionStatus(queue.snapshot(), observed).used, 1);
  assert.equal(admissionStatus(queue.snapshot(), { ...observed, claim }).used, 1);
  assert.deepEqual(occupiedSlots(queue.snapshot(), observed)[0].kinds, ['runner', 'external']);
  assert.throws(() => assertAdmission(queue.snapshot(), { ...observed, claim }), /One executor at a time/);
});
