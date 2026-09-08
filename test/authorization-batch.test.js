import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeBatch } from '../src/personal/authorization-batch.js';

const NOW = '2026-09-08T10:00:00.000Z';
const EVIDENCE = 'Operator approved five launches in review ticket 4821';
const PRIOR_EVIDENCE = 'Earlier approval recorded in the operator ticket log';

const ask = (overrides = {}) => ({ authorizationId:'batch-2', enabled:true, launches:5, evidence:EVIDENCE, ...overrides });
const bare = () => ({ enabled:false, remaining:0, runner:null, authorizationHistory:[] });
const granted = (overrides = {}) => ({
  authorizationId:'batch-1',
  launchLimit:5,
  remaining:5,
  authorizationEnabled:true,
  enabled:true,
  authorizedAt:'2026-09-01T09:00:00.000Z',
  authorizationEvidence:PRIOR_EVIDENCE,
  authorizationHistory:[],
  runner:null,
  ...overrides
});
const replay = () => ({ authorizationId:'batch-1', enabled:true, launches:5, evidence:PRIOR_EVIDENCE });
const liveRunner = { id:'runner-1', taskId:'task-1', createdAt:'2026-09-08T09:59:00.000Z', pid:4321 };

test('first batch grants exactly the approved launches and records no snapshot', () => {
  const result = authorizeBatch(bare(), ask(), NOW);
  assert.deepEqual(result, {
    enabled:true,
    remaining:5,
    runner:null,
    authorizationHistory:[],
    authorizationId:'batch-2',
    launchLimit:5,
    authorizationEnabled:true,
    authorizedAt:NOW,
    authorizationEvidence:EVIDENCE
  });
});

test('older snapshots keep their counters and the closed batch is appended', () => {
  const old = { authorizationId:'batch-0', launchLimit:3, remaining:1, authorizedAt:'2026-08-01T00:00:00.000Z', authorizationEvidence:PRIOR_EVIDENCE, authorizationEnabled:true, closedAt:'2026-08-20T00:00:00.000Z' };
  const service = granted({ remaining:0, authorizationHistory:[old] });
  const result = authorizeBatch(service, ask(), NOW);
  assert.equal(result.authorizationHistory.length, 2);
  assert.deepEqual(result.authorizationHistory[0], old);
  assert.deepEqual(result.authorizationHistory[1], {
    authorizationId:'batch-1',
    launchLimit:5,
    remaining:0,
    authorizedAt:'2026-09-01T09:00:00.000Z',
    authorizationEvidence:PRIOR_EVIDENCE,
    authorizationEnabled:true,
    closedAt:NOW
  });
  assert.equal('authorizationHistory' in result.authorizationHistory[1], false);
  assert.equal(result.remaining, 5);
});

test('replaying the current authorization after one launch keeps four of five', () => {
  const service = granted({ remaining:4 });
  const result = authorizeBatch(service, replay(), NOW);
  assert.deepEqual(result, service);
  assert.equal(result.remaining, 4);
  assert.equal(result.launchLimit, 5);
  assert.notEqual(result, service);
});

test('replaying the current authorization during a live runner changes nothing', () => {
  const service = granted({ remaining:3, runner:{ ...liveRunner } });
  const result = authorizeBatch(service, replay(), NOW);
  assert.deepEqual(result, service);
  assert.equal(result.remaining, 3);
  assert.deepEqual(result.authorizationHistory, []);
});

test('reusing the current identifier with different terms is rejected', () => {
  const service = granted({ remaining:4 });
  for (const change of [{ launches:4 }, { enabled:false }, { evidence:EVIDENCE }]) {
    assert.throws(() => authorizeBatch(service, { ...replay(), ...change }, NOW), error => {
      assert.match(error.message, /already recorded with different terms/);
      assert.equal(error.message.includes(EVIDENCE), false);
      return true;
    });
  }
});

test('identifiers already in history cannot be reused', () => {
  const service = granted({
    authorizationId:'batch-3',
    remaining:0,
    authorizationHistory:[{ authorizationId:'batch-2', launchLimit:2, remaining:0, authorizedAt:'2026-08-02T00:00:00.000Z', authorizationEvidence:PRIOR_EVIDENCE, authorizationEnabled:true, closedAt:'2026-08-03T00:00:00.000Z' }]
  });
  assert.throws(() => authorizeBatch(service, ask(), NOW), /cannot be reused/);
});

test('a new batch is refused while a runner is unfinished', () => {
  const service = granted({ remaining:0, runner:{ ...liveRunner } });
  assert.throws(() => authorizeBatch(service, ask(), NOW), /while a runner is unfinished/);
  const finished = granted({ remaining:0, runner:{ ...liveRunner, finishedAt:'2026-09-08T09:59:30.000Z' } });
  assert.equal(authorizeBatch(finished, ask(), NOW).remaining, 5);
});

test('a new positive allowance cannot stack on an unspent remainder', () => {
  assert.throws(() => authorizeBatch(granted({ remaining:2 }), ask(), NOW), /Revoke the unspent allowance/);
  assert.throws(() => authorizeBatch(granted({ remaining:1 }), ask({ launches:1 }), NOW), /Revoke the unspent allowance/);
});

test('an explicit disabled zero request revokes the remainder and records it', () => {
  const service = granted({ remaining:3 });
  const result = authorizeBatch(service, ask({ enabled:false, launches:0 }), NOW);
  assert.equal(result.remaining, 0);
  assert.equal(result.launchLimit, 0);
  assert.equal(result.enabled, false);
  assert.equal(result.authorizationEnabled, false);
  assert.equal(result.authorizationHistory[0].remaining, 3);
  assert.equal(result.authorizationHistory[0].launchLimit, 5);
  assert.equal(result.authorizationHistory[0].closedAt, NOW);
});

test('invalid requests, evidence and times are refused with safe messages', () => {
  const service = bare();
  const bad = [
    { authorizationId:'' },
    { authorizationId:'b'.repeat(201) },
    { authorizationId:7 },
    { enabled:'true' },
    { enabled:1 },
    { launches:6 },
    { launches:-1 },
    { launches:1.5 },
    { launches:'5' },
    { evidence:'too short' },
    { evidence:`   ${'x'.repeat(19)}   ` },
    { evidence:null }
  ];
  for (const change of bad) assert.throws(() => authorizeBatch(service, ask(change), NOW), /Explicit authorization requires/);
  for (const request of [null, 'batch', []]) assert.throws(() => authorizeBatch(service, request, NOW), /Explicit authorization requires/);
  for (const when of ['', '   ', 'not a date', 42, null]) assert.throws(() => authorizeBatch(service, ask(), when), /parseable date string/);
  for (const state of [null, 'service', [], { authorizationHistory:{} }]) assert.throws(() => authorizeBatch(state, ask(), NOW), /must be an object with an array history/);
  assert.equal(authorizeBatch(service, ask({ evidence:`  ${'x'.repeat(20)}  ` }), NOW).launchLimit, 5);
});

test('the input service and its nested history are never mutated', () => {
  const service = granted({ remaining:0, authorizationHistory:[{ authorizationId:'batch-0', launchLimit:3, remaining:1, authorizedAt:'2026-08-01T00:00:00.000Z', authorizationEvidence:PRIOR_EVIDENCE, authorizationEnabled:true, closedAt:'2026-08-20T00:00:00.000Z' }] });
  const snapshot = structuredClone(service);
  const result = authorizeBatch(service, ask(), NOW);
  assert.deepEqual(service, snapshot);
  result.authorizationHistory.push({ authorizationId:'batch-9' });
  result.authorizationHistory[0].remaining = 99;
  assert.deepEqual(service, snapshot);
  assert.throws(() => authorizeBatch(service, ask({ authorizationId:'batch-0' }), NOW), /cannot be reused/);
  assert.deepEqual(service, snapshot);
});

test('malformed persisted counters cannot be interpreted as an exhausted batch', () => {
  for (const remaining of ['4', undefined, null, NaN, -1, 6, 1.5]) {
    assert.throws(() => authorizeBatch(granted({ remaining }), ask(), NOW), /Service authorization state/);
  }
  assert.throws(() => authorizeBatch(bare(), ask({ authorizationId:'   ' }), NOW), /Explicit authorization/);
});

test('revoking an unused remainder requires an explicitly disabled zero request', () => {
  assert.throws(() => authorizeBatch(granted({ remaining:3 }), ask({ enabled:true, launches:0 }), NOW), /Revoke the unspent allowance/);
});
