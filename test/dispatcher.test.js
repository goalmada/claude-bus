import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchNext } from '../src/personal/dispatcher.js';

// Pure Node: fake queue objects and executor spies only. No store, subprocess or network.
const job = (overrides = {}) => ({
  id: 'job-1',
  status: 'queued',
  createdAt: '2026-09-06T10:00:00.000Z',
  revision: 2,
  ...overrides,
});

// Only queue.get and queue.run may be touched; any other member would be a second path
// into the store (submit, resume, change, ...) and must fail the test loudly.
const fakeQueue = (jobs, run) => {
  const calls = { get: [], run: [] };
  const members = {
    get(id) { calls.get.push(id); return structuredClone(jobs); },
    async run(id, executor) {
      calls.run.push({ id, executor });
      return run ? run(id, executor) : { id, status: 'reported', revision: 7 };
    },
  };
  const queue = new Proxy(members, {
    get(target, prop) {
      if (prop !== 'get' && prop !== 'run') throw new Error(`dispatchNext must not use queue.${String(prop)}`);
      return target[prop];
    },
  });
  return { queue, calls };
};

// The executor is opaque to the dispatcher: it is only forwarded to queue.run.
const fakeExecutor = () => {
  const touched = [];
  const executor = new Proxy({ prepare() { throw new Error('dispatchNext must not prepare an executor'); } }, {
    get(target, prop) { touched.push(String(prop)); return target[prop]; },
  });
  return { executor, touched };
};

test('dispatches the oldest queued task by createdAt', async () => {
  const { queue, calls } = fakeQueue([
    job({ id: 'newer', createdAt: '2026-09-06T12:00:00.000Z' }),
    job({ id: 'oldest', createdAt: '2026-09-06T08:00:00.000Z' }),
    job({ id: 'middle', createdAt: '2026-09-06T10:00:00.000Z' }),
  ], id => ({ id, status: 'reported', revision: 4 }));
  const { executor, touched } = fakeExecutor();

  const outcome = await dispatchNext(queue, executor);

  assert.deepEqual(calls.run.map(call => call.id), ['oldest']);
  assert.equal(calls.run[0].executor, executor);
  assert.deepEqual(touched, [], 'the dispatcher must not inspect or drive the executor');
  assert.deepEqual(outcome, { state: 'reported', taskId: 'oldest', revision: 4 });
});

test('breaks createdAt ties with the task id', async () => {
  const at = '2026-09-06T09:00:00.000Z';
  const { queue, calls } = fakeQueue([
    job({ id: 'b-task', createdAt: at }),
    job({ id: 'a-task', createdAt: at }),
    job({ id: 'c-task', createdAt: at }),
  ], id => ({ id, status: 'reported', revision: 1 }));

  const outcome = await dispatchNext(queue, fakeExecutor().executor);

  assert.deepEqual(calls.run.map(call => call.id), ['a-task']);
  assert.equal(outcome.taskId, 'a-task');
});

test('reads the whole snapshot through queue.get once', async () => {
  const { queue, calls } = fakeQueue([job({ id: 'only' })], id => ({ id, status: 'reported', revision: 1 }));

  await dispatchNext(queue, fakeExecutor().executor);

  assert.deepEqual(calls.get, [undefined]);
});

test('blocks on a busy executor for every in-flight state', async () => {
  for (const status of ['launching', 'running', 'checking', 'uncertain']) {
    const { queue, calls } = fakeQueue([
      job({ id: 'waiting-work', createdAt: '2026-09-06T07:00:00.000Z' }),
      job({ id: 'in-flight', status, createdAt: '2026-09-06T11:00:00.000Z' }),
    ]);
    const { executor, touched } = fakeExecutor();

    const outcome = await dispatchNext(queue, executor);

    assert.deepEqual(outcome, { state: 'blocked', reason: 'executor_busy', taskId: 'in-flight' }, `${status} must block dispatch`);
    assert.deepEqual(calls.run, [], `${status} must not launch anything`);
    assert.deepEqual(touched, [], `${status} must not prepare an executor`);
  }
});

test('a busy executor outranks reported work awaiting review', async () => {
  const { queue, calls } = fakeQueue([
    job({ id: 'reported-first', status: 'reported', createdAt: '2026-09-06T06:00:00.000Z' }),
    job({ id: 'running-now', status: 'running', createdAt: '2026-09-06T09:00:00.000Z' }),
  ]);

  const outcome = await dispatchNext(queue, fakeExecutor().executor);

  assert.deepEqual(outcome, { state: 'blocked', reason: 'executor_busy', taskId: 'running-now' });
  assert.deepEqual(calls.run, []);
});

test('waits for review while a task is reported', async () => {
  const { queue, calls } = fakeQueue([
    job({ id: 'queued-older', createdAt: '2026-09-05T00:00:00.000Z' }),
    job({ id: 'needs-review', status: 'reported', createdAt: '2026-09-06T00:00:00.000Z' }),
  ]);
  const { executor, touched } = fakeExecutor();

  const outcome = await dispatchNext(queue, executor);

  assert.deepEqual(outcome, { state: 'waiting', reason: 'review_required', taskId: 'needs-review' });
  assert.deepEqual(calls.run, [], 'unreviewed work must not drain invisibly');
  assert.deepEqual(touched, []);
});

test('reports the oldest reported task when several await review', async () => {
  const { queue } = fakeQueue([
    job({ id: 'reported-b', status: 'reported', createdAt: '2026-09-06T05:00:00.000Z' }),
    job({ id: 'reported-a', status: 'reported', createdAt: '2026-09-04T05:00:00.000Z' }),
  ]);

  assert.equal((await dispatchNext(queue, fakeExecutor().executor)).taskId, 'reported-a');
});

test('is idle with an empty queue', async () => {
  const { queue, calls } = fakeQueue([]);
  const { executor, touched } = fakeExecutor();

  assert.deepEqual(await dispatchNext(queue, executor), { state: 'idle' });
  assert.deepEqual(calls.run, []);
  assert.deepEqual(touched, []);
});

test('never restarts stopped or finished tasks', async () => {
  for (const status of ['paused', 'blocked', 'cancelled', 'timed_out', 'failed', 'verified']) {
    const { queue, calls } = fakeQueue([job({ id: `${status}-task`, status })]);
    const { executor, touched } = fakeExecutor();

    assert.deepEqual(await dispatchNext(queue, executor), { state: 'idle' }, `${status} must not be dispatched`);
    assert.deepEqual(calls.run, [], `${status} must not be resumed automatically`);
    assert.deepEqual(touched, []);
  }
});

test('ignores stopped tasks and dispatches the oldest queued one among them', async () => {
  const { queue, calls } = fakeQueue([
    job({ id: 'paused-old', status: 'paused', createdAt: '2026-09-01T00:00:00.000Z' }),
    job({ id: 'failed-old', status: 'failed', createdAt: '2026-09-02T00:00:00.000Z' }),
    job({ id: 'queued-task', createdAt: '2026-09-03T00:00:00.000Z' }),
    job({ id: 'cancelled-old', status: 'cancelled', createdAt: '2026-09-01T12:00:00.000Z' }),
  ], id => ({ id, status: 'reported', revision: 3 }));

  const outcome = await dispatchNext(queue, fakeExecutor().executor);

  assert.deepEqual(calls.run.map(call => call.id), ['queued-task']);
  assert.deepEqual(outcome, { state: 'reported', taskId: 'queued-task', revision: 3 });
});

test('returns the status, id and revision recorded by queue.run', async () => {
  for (const status of ['reported', 'blocked', 'failed', 'cancelled', 'timed_out', 'paused', 'uncertain']) {
    const { queue } = fakeQueue(
      [job({ id: 'launched' })],
      id => ({ id, status, revision: 11, result: 'private result', reason: 'private reason' }),
    );

    const outcome = await dispatchNext(queue, fakeExecutor().executor);

    assert.deepEqual(outcome, { state: status, taskId: 'launched', revision: 11 });
    assert.deepEqual(Object.keys(outcome).sort(), ['revision', 'state', 'taskId']);
  }
});

test('reports the identity queue.run returns, not the one it selected', async () => {
  const { queue } = fakeQueue([job({ id: 'selected' })], () => ({ id: 'recorded', status: 'reported', revision: 9 }));

  assert.deepEqual(await dispatchNext(queue, fakeExecutor().executor), { state: 'reported', taskId: 'recorded', revision: 9 });
});

test('propagates a queue.run rejection without retrying the race', async () => {
  const { queue, calls } = fakeQueue([
    job({ id: 'first', createdAt: '2026-09-06T01:00:00.000Z' }),
    job({ id: 'second', createdAt: '2026-09-06T02:00:00.000Z' }),
  ], () => { throw new Error('Only queued tasks can launch; never retry an uncertain launch'); });

  await assert.rejects(
    () => dispatchNext(queue, fakeExecutor().executor),
    /Only queued tasks can launch/,
  );
  assert.equal(calls.run.length, 1, 'a lost race must surface, not trigger a second launch');
  assert.deepEqual(calls.run.map(call => call.id), ['first']);
});

test('propagates a queue.get failure', async () => {
  const queue = { get() { throw new Error('Unsupported queue format'); }, run: async () => assert.fail('must not launch') };

  await assert.rejects(() => dispatchNext(queue, fakeExecutor().executor), /Unsupported queue format/);
});

test('rejects a snapshot that is not a list of tasks', async () => {
  for (const jobs of [undefined, null, {}, 'queued']) {
    const queue = { get: () => jobs, run: async () => assert.fail('must not launch') };
    await assert.rejects(() => dispatchNext(queue, fakeExecutor().executor), /Queue snapshot must be a list of tasks/);
  }
});

test('does not mutate the caller snapshot while ordering it', async () => {
  const jobs = [
    job({ id: 'newer', createdAt: '2026-09-06T12:00:00.000Z' }),
    job({ id: 'older', createdAt: '2026-09-06T08:00:00.000Z' }),
  ];
  const before = structuredClone(jobs);
  const queue = { get: () => jobs, run: async id => ({ id, status: 'reported', revision: 1 }) };

  assert.equal((await dispatchNext(queue, fakeExecutor().executor)).taskId, 'older');
  assert.deepEqual(jobs, before);
});
