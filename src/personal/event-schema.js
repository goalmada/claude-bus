// JSON Schema for the v1 event records written by service-events.js. Those records are
// `{ schemaVersion, ...dashboardHandoff(...), independentlyVerified }`, so this schema is a
// strict mirror of the projection contract in projection.js: every property is required and
// additionalProperties is false, which keeps private task material (brief, result, runtime,
// checkpoints, verification, account data, credentials) out of a published event by construction.

// The exact recorded execution states; the projection preserves them rather than guessing.
export const states = [
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
];

// Coordinator-facing dashboard statuses; null when the coordinator still has to decide.
export const suggestedStatuses = ['todo', 'running', 'waiting', 'blocked', 'done'];

export const evidenceKinds = ['actual', 'simulated', 'unverified'];

const nonEmptyString = description => ({ type: 'string', minLength: 1, description });

export const eventSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/goalmada/claude-bus/schemas/personal-event.schema.json',
  title: 'Personal queue event',
  description: 'A single published personal queue event record (schema version 1).',
  type: 'object',
  additionalProperties: false,
  required: [
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
  ],
  properties: {
    schemaVersion: {
      type: 'integer',
      const: 1,
      description: 'Version of this event record shape.',
    },
    taskId: {
      type: 'string',
      minLength: 1,
      pattern: '^[a-zA-Z0-9-]+$',
      description: 'Queue job identifier; publishing skips ids outside this character set.',
    },
    sourceTask: nonEmptyString('Identifier of the task the job was created from.'),
    owner: nonEmptyString('Owner the coordinator hands the task back to.'),
    revision: {
      type: 'integer',
      minimum: 1,
      description: 'Revision of the event, monotonically increasing per task.',
    },
    occurredAt: {
      type: 'string',
      minLength: 1,
      format: 'date-time',
      description: 'Timestamp of the latest event on the record.',
    },
    state: {
      type: 'string',
      enum: [...states],
      description: 'The exact recorded execution state.',
    },
    suggestedStatus: {
      type: ['string', 'null'],
      enum: [...suggestedStatuses, null],
      description: 'Suggested dashboard status, or null when the coordinator must decide.',
    },
    evidenceKind: {
      type: 'string',
      enum: [...evidenceKinds],
      description: 'Whether the evidence behind the event is actual, simulated or unverified.',
    },
    independentlyVerified: {
      type: 'boolean',
      description: 'True only when a verification record independently covers this event.',
    },
    summary: nonEmptyString('Short factual summary of the execution state.'),
    next: nonEmptyString('The next coordinator step.'),
    blocker: nonEmptyString('Blocking condition, or "None" when nothing blocks the task.'),
    userAction: {
      type: 'null',
      description: 'Always null: events never request an action from the user.',
    },
  },
};

export default eventSchema;
