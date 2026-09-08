// One dispatch decision for the personal queue, made from the queue's own snapshot.
// The coordinator keeps review, commits, npm recipe approval and dashboard publishing:
// this only decides whether the single executor slot is free and, if so, hands the
// oldest queued task to queue.run exactly once. No second store, no direct spawn, no
// model selection, and no automatic resume: paused, blocked, cancelled, timed_out and
// failed tasks stay stopped until a human acts on them.

// The queue allows one executor at a time; an unreconciled launch is still owned work.
const busy = new Set(['launching', 'running', 'checking', 'uncertain']);

// Oldest submission first, with the id as a stable tie-break.
const order = (a, b) => {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};
const oldest = (jobs, match) => jobs.filter(match).sort(order)[0] ?? null;

export async function dispatchNext(queue, executor) {
  const jobs = queue.get();
  if (!Array.isArray(jobs)) throw new Error('Queue snapshot must be a list of tasks');

  // An in-flight or uncertain launch blocks dispatch entirely, before any executor is touched.
  const blocking = oldest(jobs, job => busy.has(job.status));
  if (blocking) return { state: 'blocked', reason: 'executor_busy', taskId: blocking.id };

  // Reported work is unreviewed. Launching past it would drain the queue invisibly.
  const reported = oldest(jobs, job => job.status === 'reported');
  if (reported) return { state: 'waiting', reason: 'review_required', taskId: reported.id };

  const selected = oldest(jobs, job => job.status === 'queued');
  if (!selected) return { state: 'idle' };

  // Exactly one attempt. A lost race surfaces as an error; retrying it could double-launch.
  const result = await queue.run(selected.id, executor);
  return { state: result.status, taskId: result.id, revision: result.revision };
}
