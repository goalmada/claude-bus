const INVALID_REQUEST = 'Explicit authorization requires an identifier, boolean enablement, at most five launches and recorded evidence';
const INVALID_TIME = 'Authorization time must be a parseable date string';
const INVALID_SERVICE = 'Service authorization state must be an object with an array history';
const CONFLICTING_REPLAY = 'Authorization identifier is already recorded with different terms';
const REUSED_ID = 'Retired authorization identifiers cannot be reused';
const ACTIVE_RUNNER = 'Do not authorize a new batch while a runner is unfinished';
const UNSPENT_ALLOWANCE = 'Revoke the unspent allowance before authorizing a new batch';

// Pure: returns a new service object and never renews allowance on its own.
export function authorizeBatch(service, request, now = new Date().toISOString()) {
  if (!service || typeof service !== 'object' || Array.isArray(service)) throw new Error(INVALID_SERVICE);
  if (service.authorizationHistory !== undefined && !Array.isArray(service.authorizationHistory)) throw new Error(INVALID_SERVICE);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error(INVALID_REQUEST);
  const { authorizationId, enabled, launches, evidence } = request;
  if (typeof authorizationId !== 'string' || authorizationId.length === 0 || authorizationId.length > 200) throw new Error(INVALID_REQUEST);
  if (typeof enabled !== 'boolean') throw new Error(INVALID_REQUEST);
  if (!Number.isInteger(launches) || launches < 0 || launches > 5) throw new Error(INVALID_REQUEST);
  if (typeof evidence !== 'string' || evidence.trim().length < 20) throw new Error(INVALID_REQUEST);
  if (typeof now !== 'string' || now.trim().length === 0 || Number.isNaN(Date.parse(now))) throw new Error(INVALID_TIME);

  const updated = structuredClone(service);
  const current = typeof updated.authorizationId === 'string' && updated.authorizationId.length > 0 ? updated.authorizationId : null;
  if (current === authorizationId) {
    // Idempotent replay keeps the consumed allowance, even while a runner holds the batch.
    if (updated.authorizationEnabled === enabled && updated.launchLimit === launches && updated.authorizationEvidence === evidence) return updated;
    throw new Error(CONFLICTING_REPLAY);
  }
  const history = Array.isArray(updated.authorizationHistory) ? updated.authorizationHistory : [];
  if (history.some(entry => entry?.authorizationId === authorizationId)) throw new Error(REUSED_ID);
  if (updated.runner && !updated.runner.finishedAt) throw new Error(ACTIVE_RUNNER);
  if (launches > 0 && (Number.isInteger(updated.remaining) ? updated.remaining : 0) > 0) throw new Error(UNSPENT_ALLOWANCE);

  updated.authorizationHistory = history;
  if (current !== null) history.push({
    authorizationId:current,
    launchLimit:updated.launchLimit ?? null,
    remaining:updated.remaining ?? null,
    authorizedAt:updated.authorizedAt ?? null,
    authorizationEvidence:updated.authorizationEvidence ?? null,
    authorizationEnabled:updated.authorizationEnabled ?? null,
    closedAt:now
  });
  return Object.assign(updated, {
    authorizationId,
    launchLimit:launches,
    remaining:launches,
    authorizationEnabled:enabled,
    enabled,
    authorizedAt:now,
    authorizationEvidence:evidence
  });
}
