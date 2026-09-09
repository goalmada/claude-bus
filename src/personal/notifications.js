import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Durable notification outbox for coordination transitions. It lives inside the existing
// queue state (one more key in the same synced transaction), so no second store, no
// scheduler and no invented application API are introduced.
//
// Delivery semantics are explicit and deliberately pessimistic:
//   pending   -> enqueued durably by a coordination transition. Nothing was delivered.
//   published -> mirrored into the private `notifications` directory beside `events`.
//                Availability for a consumer, still not delivery.
//   delivered -> a registered coordinator confirmed it received the record.
//   acked     -> a registered coordinator confirmed it acted on the record.
// Only the last two are claims about a coordinator actually seeing anything.

// Keep every acknowledged record until this bound, so a repeat of the same failure can
// still be recognised long after it was handled. Trimming drops the oldest acknowledged
// records only; pending, published and delivered records are never dropped.
export const ACKED_HISTORY_LIMIT = 1000;

// Alert metadata must stay free of prompts, results and credentials: only short identifiers,
// hashes and references pass this gate.
export const REFERENCE_LIMIT = 200;
const CONTROL = /\p{Cc}/u;
export function safeReference(value, label) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text.length || text.length > REFERENCE_LIMIT || CONTROL.test(text)) {
    throw new Error(`${label} must be a single-line reference of at most ${REFERENCE_LIMIT} characters`);
  }
  return text;
}

export function notificationList(state) {
  const list = state.notifications;
  if (list === undefined) return (state.notifications = []);
  if (!Array.isArray(list)) throw new Error('Notification outbox must be an array; inspect the private queue state');
  return list;
}

// A durable index of every dedupe key ever enqueued, kept separately from the records so
// that retention trimming, a restart or an acknowledged record can never resurrect an alert
// about an unchanged, still active failure.
export function notificationIndex(state) {
  const index = state.notificationIndex;
  if (index === undefined) return (state.notificationIndex = {});
  if (!index || typeof index !== 'object' || Array.isArray(index)) throw new Error('Notification dedupe index must be an object; inspect the private queue state');
  return index;
}

// Keys are `<subjectId>|<reason>|<signature>`. Entries for subjects that no longer exist are
// dropped; entries for every live subject are kept regardless of record retention.
export function pruneNotificationIndex(state, subjectIds) {
  const index = notificationIndex(state);
  const live = new Set(subjectIds ?? []);
  for (const key of Object.keys(index)) {
    if (!live.has(key.slice(0, key.indexOf('|')))) delete index[key];
  }
  return Object.keys(index).length;
}

// Deduplicates on the exact (subject, reason, coordination signature) identity, so an
// unchanged failure observed on every reconciliation is enqueued once and never repeated.
export function enqueueNotification(state, record) {
  const list = notificationList(state);
  const index = notificationIndex(state);
  if (typeof record?.dedupeKey !== 'string' || !record.dedupeKey.length) throw new Error('Notification requires a dedupe key');
  if (index[record.dedupeKey] || list.some(entry => entry?.dedupeKey === record.dedupeKey)) return null;
  index[record.dedupeKey] = record.at ?? new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    ...record,
    publishedAt: null,
    deliveredAt: null, deliveredTo: null,
    ackedAt: null, ackedBy: null, ackNote: null,
  };
  list.push(entry);
  trimAcknowledged(list);
  return entry;
}

function trimAcknowledged(list) {
  const acked = list.filter(entry => entry.ackedAt);
  if (acked.length <= ACKED_HISTORY_LIMIT) return;
  const drop = new Set(acked.slice(0, acked.length - ACKED_HISTORY_LIMIT).map(entry => entry.id));
  for (let index = list.length - 1; index >= 0; index--) if (drop.has(list[index].id)) list.splice(index, 1);
}

export function pendingNotifications(queue, { includeDelivered = true } = {}) {
  return notificationList(queue.snapshot())
    .filter(entry => !entry.ackedAt && (includeDelivered || !entry.deliveredAt))
    .map(entry => structuredClone(entry));
}

export function notificationHistory(queue, taskId) {
  return notificationList(queue.snapshot())
    .filter(entry => !taskId || entry.taskId === taskId)
    .map(entry => structuredClone(entry));
}

// Mirrors pending records into the private state directory next to `events`. Writing a file
// is availability for the consumer seam, never proof that the coordinator received it.
export function publishNotificationFiles(queue, { now = Date.now() } = {}) {
  const directory = path.join(queue.root, 'notifications');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const at = new Date(now).toISOString();
  const unpublished = pendingNotifications(queue).filter(entry => !entry.publishedAt && /^[a-zA-Z0-9-]+$/.test(entry.id));
  if (!unpublished.length) return 0;
  for (const entry of unpublished) {
    const target = path.join(directory, `${entry.id}.json`);
    if (fs.existsSync(target)) continue;
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, ...entry, publishedAt: at }) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, target);
  }
  const ids = new Set(unpublished.map(entry => entry.id));
  return queue.transaction(state => {
    let written = 0;
    for (const entry of notificationList(state)) if (ids.has(entry.id) && !entry.publishedAt) { entry.publishedAt = at; written++; }
    return written;
  });
}

function updateNotifications(queue, ids, apply) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id.length)) throw new Error('Provide the notification ids to update');
  const wanted = new Set(ids);
  return queue.transaction(state => {
    const list = notificationList(state);
    if ([...wanted].some(id => !list.some(entry => entry.id === id))) throw new Error('Unknown notification id; inspect the private outbox');
    const updated = [];
    for (const entry of list) if (wanted.has(entry.id)) { apply(entry); updated.push(structuredClone(entry)); }
    return updated;
  });
}

export function markDelivered(queue, ids, { consumer, transport = null, now = Date.now() } = {}) {
  const to = safeReference(consumer, 'Delivery consumer');
  const seam = safeReference(transport, 'Delivery transport');
  if (!to) throw new Error('Delivery consumer required');
  const at = new Date(now).toISOString();
  return updateNotifications(queue, ids, entry => {
    if (entry.deliveredAt) return;
    entry.deliveredAt = at;
    entry.deliveredTo = seam ? `${to} via ${seam}` : to;
  });
}

export function markAcknowledged(queue, ids, { consumer, note = null, now = Date.now() } = {}) {
  const by = safeReference(consumer, 'Acknowledging consumer');
  const reference = safeReference(note, 'Acknowledgement note');
  if (!by) throw new Error('Acknowledging consumer required');
  const at = new Date(now).toISOString();
  return updateNotifications(queue, ids, entry => {
    if (entry.ackedAt) return;
    // An acknowledgement implies receipt; record both rather than inferring one later.
    entry.deliveredAt ??= at;
    entry.deliveredTo ??= by;
    entry.ackedAt = at; entry.ackedBy = by; entry.ackNote = reference;
  });
}
