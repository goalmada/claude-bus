// Personal use only. Pure evaluation of an already read native Max verification gate.
// No filesystem, process, network or external dependencies, and no way to extend the
// one hour lifetime, renew launch authorizations or route around the native plan.
const MAX_AGE_MS = 3600000;
const ORGANIZATION_ID = /^[0-9a-f-]{36}$/i;

const reject = reason => ({ ok: false, reason });

function isFilledString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function evaluateNativeGate(gate, now = Date.now()) {
  if (gate === null || gate === undefined) return reject('native_gate_missing');
  if (typeof gate !== 'object' || Array.isArray(gate)) return reject('native_gate_invalid');

  // Booleans and the plan label are compared strictly so truthy stand-ins never pass.
  if (gate.enabled !== true) return reject('native_gate_disabled');
  if (gate.plan !== 'max') return reject('native_gate_not_max');
  if (gate.extraUsageEnabled !== false) return reject('native_gate_extra_usage');
  if (gate.available !== true) return reject('native_gate_unavailable');

  if (!isFilledString(gate.evidence)) return reject('native_gate_invalid');
  if (!isFilledString(gate.organizationId) || !ORGANIZATION_ID.test(gate.organizationId)) return reject('native_gate_invalid');
  if (!isFilledString(gate.checkedAt)) return reject('native_gate_invalid');
  const checkedAt = Date.parse(gate.checkedAt);
  if (!Number.isFinite(checkedAt)) return reject('native_gate_invalid');
  if (typeof now !== 'number' || !Number.isFinite(now)) return reject('native_gate_invalid');

  const age = now - checkedAt;
  if (age < 0) return reject('native_gate_future');
  if (age > MAX_AGE_MS) return reject('native_gate_expired');

  return { ok: true, reason: null };
}
