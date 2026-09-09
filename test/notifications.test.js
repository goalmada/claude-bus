import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PersonalQueue } from '../src/personal/queue.js';
import { publishReadiness, reconcileCoordination, DEFAULT_OVERDUE_MS } from '../src/personal/coordination.js';
import { pendingNotifications, notificationHistory, publishNotificationFiles } from '../src/personal/notifications.js';
import * as coordinator from '../src/personal/coordinator.js';

// The outbox is exercised with an injected clock only. Nothing here schedules anything: the
// existing root heartbeat is the consumer and calls the same functions every two minutes.

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const sha = seed => crypto.createHash('sha1').update(seed).digest('hex');
const digestOf = seed => crypto.createHash('sha256').update(seed).digest('hex');
const BIRTH = 'Mon Sep  8 11:00:00 2026';

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-test-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const queue = new PersonalQueue(path.join(root, 'private'));
  queue.transaction(state => state.jobs.push({
    id: 'task-one', owner: 'worker-owner', sourceTask: 'coordinator-task', status: 'running',
    createdAt: '2026-09-08T11:00:00.000Z', startedAt: '2026-09-08T11:59:00.000Z',
    pid: 4321, process: { pid: 4321, birth: BIRTH, startedAt: '2026-09-08T11:59:00.000Z' },
    brief: 'PRIVATE_BRIEF_TEXT', result: 'PRIVATE_RESULT_TEXT', credentials: 'PRIVATE_TOKEN_TEXT',
    ...overrides,
  }));
  return queue;
}

function roster(queue, id = 'root-coordinator') {
  const coordinatorToken = `synthetic-role-proof-${id}`;
  const tokenHash = crypto.createHash('sha256').update(coordinatorToken).digest('hex');
  fs.writeFileSync(path.join(queue.root, 'coordinators.json'), JSON.stringify({ coordinators: [{ id, label: 'synthetic coordinator', tokenHash }] }), { mode: 0o600 });
  return { coordinatorId: id, coordinatorToken };
}

const ready = (queue, at, digest = digestOf('result-1')) => publishReadiness(queue, 'task-one', {
  owner: 'worker-owner', coordinator: 'root-coordinator', sha: sha('head-1'), digest,
  evidenceRef: 'private:handoff/task-one', birth: () => BIRTH, now: at,
});

test('a readiness transition notifies immediately and exactly once', t => {
  const queue = fixture(t);
  reconcileCoordination(queue, { birth: () => BIRTH, now: NOW });
  assert.equal(pendingNotifications(queue).filter(entry => entry.reason === 'enter_needs_review').length, 0);

  ready(queue, NOW + 1000);
  const alerts = pendingNotifications(queue).filter(entry => entry.reason === 'enter_needs_review');
  assert.equal(alerts.length, 1);
  const alert = alerts[0];
  assert.equal(alert.taskId, 'task-one');
  assert.equal(alert.state, 'needs_review');
  assert.equal(alert.sha, sha('head-1'));
  assert.equal(alert.digest, digestOf('result-1'));
  assert.equal(alert.owner, 'worker-owner');
  assert.equal(alert.coordinator, 'root-coordinator');
  assert.equal(alert.identityState, 'confirmed');
  assert.equal(alert.at, new Date(NOW + 1000).toISOString());
  // Enqueued is not delivered, and not acknowledged.
  assert.equal(alert.deliveredAt, null);
  assert.equal(alert.ackedAt, null);

  for (let step = 1; step <= 5; step++) reconcileCoordination(queue, { birth: () => BIRTH, now: NOW + 1000 + step * 1000 });
  assert.equal(pendingNotifications(queue).filter(entry => entry.reason === 'enter_needs_review').length, 1);
});

test('one overdue review alert fires after two minutes and never repeats', t => {
  const queue = fixture(t);
  ready(queue, NOW);
  const overdue = () => pendingNotifications(queue).filter(entry => entry.reason === 'overdue_review');

  reconcileCoordination(queue, { birth: () => BIRTH, now: NOW + DEFAULT_OVERDUE_MS - 1 });
  assert.equal(overdue().length, 0);
  reconcileCoordination(queue, { birth: () => BIRTH, now: NOW + DEFAULT_OVERDUE_MS });
  assert.equal(overdue().length, 1);
  assert.equal(overdue()[0].state, 'needs_review');
  for (let step = 1; step <= 10; step++) reconcileCoordination(queue, { birth: () => BIRTH, now: NOW + DEFAULT_OVERDUE_MS * (1 + step) });
  assert.equal(overdue().length, 1);
  assert.equal(DEFAULT_OVERDUE_MS, 120000);

  // A new readiness revision is new work: it starts its own overdue window.
  ready(queue, NOW + 600000, digestOf('result-2'));
  reconcileCoordination(queue, { birth: () => BIRTH, now: NOW + 600000 + DEFAULT_OVERDUE_MS });
  assert.equal(overdue().length, 2);
});

test('an unchanged failure is never repeated, across reconciliations and restarts', t => {
  const queue = fixture(t);
  const dead = { birth: () => null, now: NOW };
  reconcileCoordination(queue, dead);
  const blocked = pendingNotifications(queue).filter(entry => entry.state === 'blocked');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].detail, 'unexpected_exit');

  const role = roster(queue);
  coordinator.acknowledge(queue, { ...role, ids: [blocked[0].id], note: 'private:incident/queue-1', now: NOW + 1000 });
  assert.equal(pendingNotifications(queue).length, 0);

  // A separate process observing the same unchanged failure must stay quiet, even though the
  // acknowledged record is no longer pending.
  const reopened = new PersonalQueue(queue.root);
  for (let step = 1; step <= 5; step++) reconcileCoordination(reopened, { birth: () => null, now: NOW + step * 60000 });
  assert.equal(pendingNotifications(reopened).length, 0);
  const history = notificationHistory(reopened, 'task-one');
  assert.equal(history.length, 1);
  assert.equal(history[0].ackedBy, 'root-coordinator');
  assert.equal(history[0].ackNote, 'private:incident/queue-1');
  assert.ok(history[0].ackedAt);
});

test('delivery and acknowledgement are coordinator statements that survive a restart', t => {
  const queue = fixture(t);
  ready(queue, NOW);
  const role = roster(queue);
  const [alert] = pendingNotifications(queue);

  // A worker cannot silence its own alert: the role proof is required.
  assert.throws(() => coordinator.acknowledge(queue, { coordinatorId: 'worker-owner', coordinatorToken: 'guess', ids: [alert.id] }), /Unknown coordinator|role proof/);
  assert.equal(pendingNotifications(queue)[0].ackedAt, null);

  const delivered = coordinator.confirmDelivery(queue, { ...role, ids: [alert.id], transport: 'seguimiento-de-proyectos heartbeat', now: NOW + 1000 });
  assert.equal(delivered[0].deliveredTo, 'root-coordinator via seguimiento-de-proyectos heartbeat');
  // Delivered is still pending work for the coordinator until it is acknowledged.
  assert.equal(pendingNotifications(queue).length, 1);
  assert.equal(pendingNotifications(queue, { includeDelivered: false }).length, 0);

  coordinator.acknowledge(new PersonalQueue(queue.root), { ...role, ids: [alert.id], note: 'private:review/started', now: NOW + 2000 });
  const reopened = new PersonalQueue(queue.root);
  assert.equal(pendingNotifications(reopened).length, 0);
  const [record] = notificationHistory(reopened, 'task-one');
  assert.equal(record.deliveredAt, new Date(NOW + 1000).toISOString());
  assert.equal(record.ackedAt, new Date(NOW + 2000).toISOString());
  assert.equal(record.ackedBy, 'root-coordinator');
});

test('the mirrored outbox file is availability, never delivery, and carries no private text', t => {
  const queue = fixture(t);
  ready(queue, NOW);
  const written = publishNotificationFiles(queue, { now: NOW + 500 });
  assert.equal(written, 1);
  assert.equal(publishNotificationFiles(queue, { now: NOW + 600 }), 0);

  const directory = path.join(queue.root, 'notifications');
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1);
  const contents = fs.readFileSync(path.join(directory, files[0]), 'utf8');
  for (const secret of ['PRIVATE_BRIEF_TEXT', 'PRIVATE_RESULT_TEXT', 'PRIVATE_TOKEN_TEXT']) assert.equal(contents.includes(secret), false);
  const record = JSON.parse(contents);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.publishedAt, new Date(NOW + 500).toISOString());
  // Publishing a file is not a claim that anyone received or acted on it.
  assert.equal(record.deliveredAt, null);
  assert.equal(record.ackedAt, null);
  assert.equal(fs.statSync(path.join(directory, files[0])).mode & 0o077, 0);
  assert.equal(pendingNotifications(queue)[0].publishedAt, new Date(NOW + 500).toISOString());
});

test('acknowledging an unknown record is refused rather than silently ignored', t => {
  const queue = fixture(t);
  const role = roster(queue);
  assert.throws(() => coordinator.acknowledge(queue, { ...role, ids: ['not-a-real-id'] }), /Unknown notification id/);
  assert.throws(() => coordinator.acknowledge(queue, { ...role, ids: [] }), /notification ids/);
});
