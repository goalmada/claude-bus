// Deterministic, read-only projection from a personal queue job to a dashboard handoff.
// It shapes facts the coordinator already owns: no reports are sent and the dashboard is
// never written here. Private task material (brief, result, checkpoints, account data,
// credentials) is excluded by construction: only the fields below are ever returned.

const kinds = new Set(['actual', 'simulated', 'unverified']);
// Coordinator decides these; the exact state is preserved so nothing is guessed for a human.
const deferred = new Set(['cancelled', 'uncertain']);
const mapped = new Map([
  ['queued', 'todo'],
  ['launching', 'running'],
  ['running', 'running'],
  // A check is still an owned in-flight attempt, so it reads as running on the dashboard.
  ['checking', 'running'],
  ['blocked', 'blocked'],
  ['reported', 'waiting'],
  ['paused', 'waiting'],
  ['failed', 'blocked'],
  ['timed_out', 'blocked'],
]);

const text = value => typeof value === 'string' && value.trim().length > 0;

export function dashboardHandoff(job, evidence) {
  if (!job || typeof job !== 'object') throw new Error('Task record required');
  if (!evidence || typeof evidence !== 'object') throw new Error('Evidence required');
  if (!kinds.has(evidence.kind)) throw new Error('Evidence kind must be actual, simulated or unverified');
  for (const field of ['summary', 'next', 'blocker']) {
    if (!text(evidence[field])) throw new Error(`Evidence ${field} must be a non-empty string`);
  }
  if (!text(job.id) || !text(job.sourceTask) || !text(job.owner)) throw new Error('Task identity required');
  if (!Number.isInteger(job.revision) || job.revision < 0) throw new Error('Task revision required');
  if (!Array.isArray(job.events) || !job.events.length) throw new Error('Task events required');
  const latest = job.events[job.events.length - 1];
  if (!latest || typeof latest !== 'object' || !text(latest.at)) throw new Error('Latest event timestamp required');
  const state = job.status;
  if (state !== 'verified' && !mapped.has(state) && !deferred.has(state)) throw new Error('Unknown task state');

  // A verified task is only done when the evidence is actual and an independent
  // verification record exists; anything else waits for the coordinator.
  const suggestedStatus = state === 'verified'
    ? (evidence.kind === 'actual' && job.verification ? 'done' : 'waiting')
    : mapped.get(state) ?? null;

  return {
    taskId: job.id,
    sourceTask: job.sourceTask,
    owner: job.owner,
    revision: job.revision,
    occurredAt: latest.at,
    state,
    suggestedStatus,
    evidenceKind: evidence.kind,
    summary: evidence.summary,
    next: evidence.next,
    blocker: evidence.blocker,
    userAction: null,
  };
}
