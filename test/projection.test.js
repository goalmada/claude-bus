import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHandoff } from '../src/personal/projection.js';

// A job carrying the private material the projection must never leak.
const job = (overrides = {}) => ({
  id: 'e2f1c0a4-1111-4222-8333-444455556666',
  sourceTask: 'task-71',
  owner: 'reviewer-a',
  revision: 3,
  status: 'queued',
  events: [
    { revision: 2, at: '2026-09-06T10:00:00.000Z', status: 'launching' },
    { revision: 3, at: '2026-09-06T10:04:31.000Z', status: 'queued' },
  ],
  brief: 'private brief text',
  result: 'private result text',
  resultHash: 'a'.repeat(64),
  checkpoint: { hash: 'b'.repeat(64) },
  checkpoints: [{ hash: 'b'.repeat(64) }],
  sessionId: 'session-abc',
  worktree: '/Users/someone/code/wt',
  baseSha: 'c'.repeat(40),
  billingMode: 'subscription_only',
  key: 'idempotency-key',
  inputHash: 'd'.repeat(64),
  pid: 4242,
  ...overrides,
});

const evidence = (overrides = {}) => ({
  kind: 'unverified',
  summary: 'Executor reported and the coordinator has not reviewed yet.',
  next: 'Coordinator reviews the reported diff.',
  blocker: 'None.',
  ...overrides,
});

const fields = [
  'taskId', 'sourceTask', 'owner', 'revision', 'occurredAt', 'state',
  'suggestedStatus', 'evidenceKind', 'summary', 'next', 'blocker', 'userAction',
];

test('projects the facts the coordinator owns', () => {
  const handoff = dashboardHandoff(job(), evidence());
  assert.deepEqual(handoff, {
    taskId: 'e2f1c0a4-1111-4222-8333-444455556666',
    sourceTask: 'task-71',
    owner: 'reviewer-a',
    revision: 3,
    occurredAt: '2026-09-06T10:04:31.000Z',
    state: 'queued',
    suggestedStatus: 'todo',
    evidenceKind: 'unverified',
    summary: 'Executor reported and the coordinator has not reviewed yet.',
    next: 'Coordinator reviews the reported diff.',
    blocker: 'None.',
    userAction: null,
  });
});

test('occurredAt is the timestamp of the latest event only', () => {
  const record = job({
    events: [
      { revision: 1, at: '2026-09-01T00:00:00.000Z', status: 'queued' },
      { revision: 2, at: '2026-09-02T00:00:00.000Z', status: 'launching' },
      { revision: 3, at: '2026-09-03T09:15:00.000Z', status: 'running' },
    ],
    status: 'running',
  });
  assert.equal(dashboardHandoff(record, evidence()).occurredAt, '2026-09-03T09:15:00.000Z');
});

test('maps every known state and preserves the exact state', () => {
  const expected = {
    queued: 'todo',
    launching: 'running',
    running: 'running',
    blocked: 'blocked',
    reported: 'waiting',
    paused: 'waiting',
    failed: 'blocked',
    timed_out: 'blocked',
  };
  for (const [status, suggestedStatus] of Object.entries(expected)) {
    const handoff = dashboardHandoff(job({ status }), evidence());
    assert.equal(handoff.suggestedStatus, suggestedStatus, `${status} should suggest ${suggestedStatus}`);
    assert.equal(handoff.state, status, `${status} must be reported verbatim`);
  }
});

test('cancelled and uncertain defer to the coordinator with the exact state', () => {
  for (const status of ['cancelled', 'uncertain']) {
    for (const kind of ['actual', 'simulated', 'unverified']) {
      const handoff = dashboardHandoff(job({ status, verification: { reviewer: 'other' } }), evidence({ kind }));
      assert.equal(handoff.suggestedStatus, null, `${status} must not be guessed`);
      assert.equal(handoff.state, status);
    }
  }
});

test('verified is done only with actual evidence and a verification record', () => {
  const verification = { reviewer: 'reviewer-b', evidence: 'independently re-ran the tests', at: '2026-09-06T11:00:00.000Z' };
  const handoff = dashboardHandoff(job({ status: 'verified', verification }), evidence({ kind: 'actual' }));
  assert.equal(handoff.suggestedStatus, 'done');
  assert.equal(handoff.state, 'verified');
  assert.equal(handoff.evidenceKind, 'actual');
});

test('simulated evidence never reaches done even when verified', () => {
  const verification = { reviewer: 'reviewer-b', evidence: 'independently re-ran the tests' };
  for (const kind of ['simulated', 'unverified']) {
    const handoff = dashboardHandoff(job({ status: 'verified', verification }), evidence({ kind }));
    assert.equal(handoff.suggestedStatus, 'waiting', `${kind} evidence must wait`);
    assert.equal(handoff.state, 'verified');
  }
});

test('actual evidence without a verification record waits', () => {
  for (const verification of [undefined, null]) {
    const handoff = dashboardHandoff(job({ status: 'verified', verification }), evidence({ kind: 'actual' }));
    assert.equal(handoff.suggestedStatus, 'waiting');
  }
});

test('rejects unknown states', () => {
  for (const status of ['done', 'todo', 'waiting', 'VERIFIED', '', null, undefined, 42]) {
    assert.throws(() => dashboardHandoff(job({ status }), evidence()), /Unknown task state/);
  }
});

test('rejects invalid or missing evidence kinds', () => {
  for (const kind of [undefined, null, '', 'real', 'Actual', 'verified', 1, {}]) {
    assert.throws(() => dashboardHandoff(job(), evidence({ kind })), /Evidence kind/);
  }
});

test('requires explicit summary, next and blocker strings', () => {
  for (const field of ['summary', 'next', 'blocker']) {
    for (const value of [undefined, null, '', '   ', 5, {}]) {
      assert.throws(
        () => dashboardHandoff(job(), evidence({ [field]: value })),
        new RegExp(`Evidence ${field} must be a non-empty string`),
        `${field}=${JSON.stringify(value)} must be rejected`,
      );
    }
  }
});

test('requires a job and an evidence object', () => {
  assert.throws(() => dashboardHandoff(null, evidence()), /Task record required/);
  assert.throws(() => dashboardHandoff('task-71', evidence()), /Task record required/);
  assert.throws(() => dashboardHandoff(job(), null), /Evidence required/);
  assert.throws(() => dashboardHandoff(job(), 'looks fine'), /Evidence required/);
});

test('requires full task identity', () => {
  for (const field of ['id', 'sourceTask', 'owner']) {
    for (const value of [undefined, null, '', '  ', 7]) {
      assert.throws(() => dashboardHandoff(job({ [field]: value }), evidence()), /Task identity required/);
    }
  }
});

test('requires a concrete revision', () => {
  for (const revision of [undefined, null, -1, 1.5, '3', NaN]) {
    assert.throws(() => dashboardHandoff(job({ revision }), evidence()), /Task revision required/);
  }
  assert.equal(dashboardHandoff(job({ revision: 0 }), evidence()).revision, 0);
});

test('requires a non-empty event history with a timestamped latest event', () => {
  for (const events of [undefined, null, [], 'none', {}]) {
    assert.throws(() => dashboardHandoff(job({ events }), evidence()), /Task events required/);
  }
  for (const latest of [null, {}, { revision: 3, status: 'queued' }, { at: '' }, { at: 12 }]) {
    assert.throws(
      () => dashboardHandoff(job({ events: [{ revision: 2, at: '2026-09-06T10:00:00.000Z', status: 'launching' }, latest] }), evidence()),
      /Latest event timestamp required/,
    );
  }
});

test('never exposes private task material or credentials', () => {
  const record = job({
    status: 'verified',
    verification: { reviewer: 'reviewer-b', evidence: 'independently re-ran the tests' },
    apiKey: 'sk-ant-should-never-appear',
    account: { email: 'someone@example.com', plan: 'max' },
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-should-never-appear' },
    attempts: [{ launchId: 'launch-1', resultHash: 'a'.repeat(64) }],
  });
  const handoff = dashboardHandoff(record, evidence({ kind: 'actual' }));

  assert.deepEqual(Object.keys(handoff).sort(), [...fields].sort());
  for (const leaked of [
    'brief', 'result', 'resultHash', 'checkpoint', 'checkpoints', 'sessionId', 'worktree',
    'baseSha', 'billingMode', 'key', 'inputHash', 'pid', 'apiKey', 'account', 'env',
    'attempts', 'verification',
  ]) {
    assert.equal(Object.hasOwn(handoff, leaked), false, `${leaked} must not be projected`);
  }

  const serialized = JSON.stringify(handoff);
  for (const secret of ['private brief text', 'private result text', 'sk-ant-should-never-appear', 'oauth-should-never-appear', 'someone@example.com', '/Users/someone/code/wt', 'session-abc', 'idempotency-key']) {
    assert.equal(serialized.includes(secret), false, `${secret} must not leak into the handoff`);
  }
});

test('is read-only: it neither mutates its inputs nor decides the user action', () => {
  const record = job({ status: 'reported' });
  const facts = evidence({ kind: 'simulated' });
  const before = { record: structuredClone(record), facts: structuredClone(facts) };

  const handoff = dashboardHandoff(record, facts);

  assert.deepEqual(record, before.record);
  assert.deepEqual(facts, before.facts);
  assert.equal(handoff.userAction, null);
  assert.equal(dashboardHandoff(record, facts).occurredAt, handoff.occurredAt);
});
