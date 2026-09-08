// Contract tests for the published event schema. These are pure: nothing is read from or
// written to disk, no queue is started and no build output is required. Records under test
// are built the same way service-events.js builds them, so schema drift away from the real
// projection contract fails here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { eventSchema, states, suggestedStatuses, evidenceKinds } from '../src/personal/event-schema.js';
import { dashboardHandoff } from '../src/personal/projection.js';

const expectedFields = [
  'schemaVersion',
  'taskId',
  'sourceTask',
  'owner',
  'revision',
  'occurredAt',
  'state',
  'suggestedStatus',
  'evidenceKind',
  'independentlyVerified',
  'summary',
  'next',
  'blocker',
  'userAction',
];

// A deliberately small subset of JSON Schema: exactly the keywords the event schema uses.
function matchesType(type, value) {
  if (type === 'null') return value === null;
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'string') return typeof value === 'string';
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  throw new Error(`Unsupported schema type: ${type}`);
}

function errorsFor(schema, value, at = '') {
  const where = at || '(root)';
  const errors = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some(type => matchesType(type, value))) errors.push(`${where}: expected ${types.join('|')}`);
  if ('const' in schema && value !== schema.const) errors.push(`${where}: expected const ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where}: shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${where}: fails pattern ${schema.pattern}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${where}: below minimum ${schema.minimum}`);
  if (matchesType('object', value)) {
    for (const field of schema.required ?? []) {
      if (!Object.hasOwn(value, field)) errors.push(`${where}/${field}: required field missing`);
    }
    for (const [key, child] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (!property) {
        if (schema.additionalProperties === false) errors.push(`${where}/${key}: additional property rejected`);
        continue;
      }
      errors.push(...errorsFor(property, child, `${where}/${key}`));
    }
  }
  return errors;
}

// Mirrors the job shape publishEvents projects from, private material included on purpose.
function jobFor(status, extra = {}) {
  return {
    id: 'task-42',
    sourceTask: 'source-7',
    owner: 'coordinator',
    revision: 3,
    status,
    events: [{ status, revision: 3, at: '2026-01-02T03:04:05.000Z' }],
    brief: 'private brief text',
    result: 'private executor result',
    account: { email: 'owner@example.com', token: 'secret' },
    runtime: { pid: 4242 },
    checkpoints: ['/private/path/checkpoint'],
    ...extra,
  };
}

// The exact record publishEvents writes: { schemaVersion, ...projection, independentlyVerified }.
function recordFor(status, { kind = 'actual', verified = false, ...extra } = {}) {
  const job = jobFor(status, verified ? { verification: { at: '2026-01-02T03:04:04.000Z' } } : {});
  const projection = dashboardHandoff(job, {
    kind,
    summary: `Queue execution state: ${status}`,
    next: 'Coordinator follows the exact recorded execution state',
    blocker: 'None',
  });
  return { schemaVersion: 1, ...projection, independentlyVerified: verified, ...extra };
}

test('schema requires every declared property and forbids anything else', () => {
  assert.equal(eventSchema.type, 'object');
  assert.equal(eventSchema.additionalProperties, false);
  assert.deepEqual(eventSchema.required, expectedFields);
  assert.deepEqual(Object.keys(eventSchema.properties).sort(), [...expectedFields].sort());
});

test('required fields exactly match what service-events.js publishes', () => {
  const published = Object.keys(recordFor('reported'));
  assert.deepEqual(published.sort(), [...eventSchema.required].sort());
});

test('a published record validates for every recorded state', () => {
  for (const state of states) {
    const record = recordFor(state, { verified: state === 'verified' });
    assert.equal(record.state, state);
    assert.deepEqual(errorsFor(eventSchema, record), [], `state ${state} should validate`);
  }
});

test('dropping any required field is rejected', () => {
  for (const field of expectedFields) {
    const record = recordFor('running');
    delete record[field];
    const errors = errorsFor(eventSchema, record);
    assert.ok(errors.length > 0, `missing ${field} must be rejected`);
    assert.ok(errors.some(error => error.includes(`/${field}`)), `error should name ${field}: ${errors.join(', ')}`);
  }
});

test('private brief, result and account material is rejected as an additional property', () => {
  const leaks = {
    brief: 'private brief text',
    result: 'private executor result',
    account: { email: 'owner@example.com' },
    verification: { at: '2026-01-02T03:04:04.000Z' },
    runtime: { pid: 4242 },
    checkpoints: ['/private/path/checkpoint'],
    events: [{ status: 'running', revision: 3, at: '2026-01-02T03:04:05.000Z' }],
  };
  for (const [field, value] of Object.entries(leaks)) {
    const errors = errorsFor(eventSchema, recordFor('reported', { [field]: value }));
    assert.deepEqual(errors, [`(root)/${field}: additional property rejected`]);
  }
  // Nothing private can be described by the schema in the first place.
  for (const field of Object.keys(leaks)) {
    assert.ok(!Object.hasOwn(eventSchema.properties, field), `${field} must not be a schema property`);
  }
});

test('state enum is exactly the recorded execution states', () => {
  assert.deepEqual(eventSchema.properties.state.enum, [
    'queued',
    'launching',
    'running',
    'checking',
    'reported',
    'paused',
    'blocked',
    'failed',
    'timed_out',
    'cancelled',
    'uncertain',
    'verified',
  ]);
  assert.deepEqual(eventSchema.properties.state.enum, states);
  for (const state of ['done', 'todo', 'waiting', 'succeeded', 'unknown', '', null]) {
    const errors = errorsFor(eventSchema, { ...recordFor('running'), state });
    assert.ok(errors.some(error => error.startsWith('(root)/state')), `state ${JSON.stringify(state)} must be rejected`);
  }
});

test('suggestedStatus allows the dashboard statuses or null only', () => {
  for (const status of [...suggestedStatuses, null]) {
    assert.deepEqual(errorsFor(eventSchema, { ...recordFor('running'), suggestedStatus: status }), []);
  }
  for (const status of ['archived', 'verified', '']) {
    assert.ok(errorsFor(eventSchema, { ...recordFor('running'), suggestedStatus: status }).length > 0);
  }
});

test('evidenceKind, independentlyVerified, revision and userAction are strict', () => {
  assert.deepEqual(eventSchema.properties.evidenceKind.enum, evidenceKinds);
  for (const kind of evidenceKinds) {
    assert.deepEqual(errorsFor(eventSchema, recordFor('running', { kind })), []);
  }
  assert.ok(errorsFor(eventSchema, { ...recordFor('running'), evidenceKind: 'assumed' }).length > 0);

  for (const value of ['true', 1, null]) {
    assert.ok(errorsFor(eventSchema, { ...recordFor('running'), independentlyVerified: value }).length > 0);
  }
  // Stricter than projection.js, which accepts revision 0: a published event always has one.
  for (const revision of [0, -1, 1.5, '3']) {
    assert.ok(errorsFor(eventSchema, { ...recordFor('running'), revision }).length > 0, `revision ${revision} must be rejected`);
  }
  assert.deepEqual(errorsFor(eventSchema, { ...recordFor('running'), revision: 1 }), []);

  // Events report facts; they never ask the user to do anything.
  assert.deepEqual(eventSchema.properties.userAction, {
    type: 'null',
    description: 'Always null: events never request an action from the user.',
  });
  assert.ok(errorsFor(eventSchema, { ...recordFor('running'), userAction: 'confirm the run' }).length > 0);
});

test('identity and text fields reject empty strings', () => {
  for (const field of ['taskId', 'sourceTask', 'owner', 'occurredAt', 'summary', 'next', 'blocker']) {
    assert.ok(errorsFor(eventSchema, { ...recordFor('running'), [field]: '' }).length > 0, `${field} must be non-empty`);
  }
  // Publishing skips ids outside this character set, so the schema does too.
  assert.ok(errorsFor(eventSchema, { ...recordFor('running'), taskId: '../escape' }).length > 0);
  assert.equal(eventSchema.properties.schemaVersion.const, 1);
  assert.ok(errorsFor(eventSchema, { ...recordFor('running'), schemaVersion: 2 }).length > 0);
});
