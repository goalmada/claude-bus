import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNativeGate } from '../src/personal/native-gate.js';

const CHECKED_AT = '2026-09-08T12:00:00.000Z';
const NOW = Date.parse(CHECKED_AT);
const ORGANIZATION_ID = '0b6e1c74-9d2f-4a51-8c33-7e5ab0d29f14';

const sample = (overrides = {}) => ({
  enabled: true,
  plan: 'max',
  extraUsageEnabled: false,
  available: true,
  evidence: '/status and /usage transcript captured locally',
  organizationId: ORGANIZATION_ID,
  checkedAt: CHECKED_AT,
  ...overrides,
});

const expect = (gate, now, reason) => assert.deepEqual(evaluateNativeGate(gate, now), reason === null ? { ok: true, reason: null } : { ok: false, reason });

test('accepts a fresh native Max verification', () => {
  expect(sample(), NOW, null);
  expect(sample(), NOW + 1000, null);
});

test('an omitted clock defaults to the real current time', () => {
  assert.deepEqual(evaluateNativeGate(sample({ checkedAt: new Date().toISOString() })), { ok: true, reason: null });
  assert.deepEqual(evaluateNativeGate(sample()).ok, false);
});

test('missing gate is reported as missing', () => {
  expect(null, NOW, 'native_gate_missing');
  expect(undefined, NOW, 'native_gate_missing');
  assert.deepEqual(evaluateNativeGate(), { ok: false, reason: 'native_gate_missing' });
});

test('non object and array shapes are invalid', () => {
  for (const gate of ['{}', 42, true, Symbol('gate'), () => {}, [sample()], []]) {
    expect(gate, NOW, 'native_gate_invalid');
  }
});

test('disabled gate is rejected before any other field', () => {
  expect(sample({ enabled: false }), NOW, 'native_gate_disabled');
  expect(sample({ enabled: undefined }), NOW, 'native_gate_disabled');
  // A broken gate still reports the disabled flag first.
  expect(sample({ enabled: false, plan: 'pro', evidence: '', organizationId: 'x' }), NOW, 'native_gate_disabled');
});

test('non max plans are rejected', () => {
  for (const plan of ['pro', 'Max', 'max ', '', undefined, null, 1]) {
    expect(sample({ plan }), NOW, 'native_gate_not_max');
  }
});

test('extra usage must be explicitly disabled', () => {
  for (const extraUsageEnabled of [true, undefined, null, 'false']) {
    expect(sample({ extraUsageEnabled }), NOW, 'native_gate_extra_usage');
  }
});

test('unavailable native capacity is rejected', () => {
  for (const available of [false, undefined, null, 'yes']) {
    expect(sample({ available }), NOW, 'native_gate_unavailable');
  }
});

test('booleans are not coerced from truthy or falsy stand-ins', () => {
  expect(sample({ enabled: 1 }), NOW, 'native_gate_disabled');
  expect(sample({ enabled: 'true' }), NOW, 'native_gate_disabled');
  expect(sample({ extraUsageEnabled: 0 }), NOW, 'native_gate_extra_usage');
  expect(sample({ extraUsageEnabled: '' }), NOW, 'native_gate_extra_usage');
  expect(sample({ available: 1 }), NOW, 'native_gate_unavailable');
});

test('evidence must be a non empty trimmed string', () => {
  for (const evidence of [undefined, null, '', '   ', '\n\t', 0, true, ['proof']]) {
    expect(sample({ evidence }), NOW, 'native_gate_invalid');
  }
});

test('organization id keeps the existing accepted shape', () => {
  expect(sample({ organizationId: ORGANIZATION_ID.toUpperCase() }), NOW, null);
  for (const organizationId of [undefined, null, '', '   ', ORGANIZATION_ID.slice(0, 35), `${ORGANIZATION_ID}a`, 'g'.repeat(36), `${ORGANIZATION_ID.slice(0, 35)} `, 123]) {
    expect(sample({ organizationId }), NOW, 'native_gate_invalid');
  }
});

test('checked at must be a non empty parseable string', () => {
  for (const checkedAt of [undefined, null, '', '   ', 'not-a-date', 'yesterday', NOW, new Date(NOW)]) {
    expect(sample({ checkedAt }), NOW, 'native_gate_invalid');
  }
});

test('a supplied clock must be a finite number', () => {
  for (const now of [NaN, Infinity, -Infinity, '1757332800000', null, new Date(NOW), {}]) {
    expect(sample(), now, 'native_gate_invalid');
  }
});

test('a gate checked after the clock is refused as future', () => {
  expect(sample(), NOW - 1, 'native_gate_future');
  expect(sample(), NOW - 3600000, 'native_gate_future');
});

test('expiry boundary is exactly one hour inclusive', () => {
  expect(sample(), NOW + 3600000, null);
  expect(sample(), NOW + 3600001, 'native_gate_expired');
  expect(sample(), NOW + 86400000, 'native_gate_expired');
});

test('an expired gate cannot be revived by extra fields', () => {
  const gate = sample({ maxAgeMs: 86400000, lifetimeMs: 86400000, expiresAt: '2099-01-01T00:00:00.000Z' });
  expect(gate, NOW + 3600001, 'native_gate_expired');
});

test('the input gate is never mutated', () => {
  const gate = sample();
  const snapshot = structuredClone(gate);
  evaluateNativeGate(gate, NOW);
  evaluateNativeGate(gate, NOW + 3600001);
  evaluateNativeGate(gate, NaN);
  assert.deepEqual(gate, snapshot);
});

test('diagnostics expose only ok and a fixed reason code', () => {
  const gate = sample();
  for (const [candidate, now] of [[gate, NOW], [gate, NOW + 3600001], [gate, NOW - 1], [sample({ plan: 'pro' }), NOW], [null, NOW]]) {
    const result = evaluateNativeGate(candidate, now);
    assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason']);
    assert.equal(typeof result.ok, 'boolean');
    const serialized = JSON.stringify(result);
    for (const secret of [gate.evidence, gate.organizationId, gate.checkedAt]) {
      assert.ok(!serialized.includes(secret), `diagnostics leaked ${secret}`);
    }
  }
});
