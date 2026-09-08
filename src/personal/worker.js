import { setTimeout as sleep } from 'node:timers/promises';
import { dispatchNext } from './dispatcher.js';

// Bounded local worker. The coordinator owns review and explicit continuation.
export async function workQueue(queue, executor, {
  maxJobs = 5, maxRunMs = 900000, pollMs = 1000, signal,
  onEvent = () => {}, dispatch = dispatchNext,
} = {}) {
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 20 ||
      !Number.isInteger(maxRunMs) || maxRunMs < 100 || maxRunMs > 1800000 ||
      !Number.isInteger(pollMs) || pollMs < 25 || pollMs > 5000) {
    throw new Error('Worker limits outside supported bounds');
  }
  const deadline = Date.now() + maxRunMs;
  let launched = 0, activeId = null, lastOutcome = null, stopReason = null, interruptError = null;
  const interrupt = reason => {
    stopReason = reason;
    if (!activeId) return;
    try {
      const job = queue.get(activeId);
      if (job.status === 'running') queue.pause(activeId);
      else if (job.status === 'launching') queue.cancel(activeId);
    } catch (error) {
      interruptError = { taskId: activeId, reason: 'stop_request_failed' };
    }
  };
  const timer = setTimeout(() => interrupt('deadline'), maxRunMs);
  const abort = () => interrupt('interrupted');
  signal?.addEventListener('abort', abort);
  try {
    while (Date.now() < deadline && !signal?.aborted && launched < maxJobs) {
      if (queue.get().some(job => job.status === 'uncertain')) {
        return { state: 'blocked', reason: 'uncertain_launch', launched };
      }
      // prepare is reached only after this queue.run atomically claims its task.
      const ownedExecutor = { prepare: async job => {
        activeId = job.id;
        return await executor.prepare(job);
      } };
      const outcome = await dispatch(queue, ownedExecutor);
      activeId = null;
      lastOutcome = outcome;
      if (outcome.taskId && !['idle', 'waiting', 'blocked'].includes(outcome.state)) launched++;
      onEvent(outcome);
      if (interruptError) return { state: 'uncertain', ...interruptError, stopReason, lastOutcome, launched };
      if (['failed', 'timed_out', 'paused', 'cancelled', 'uncertain'].includes(outcome.state) ||
          (outcome.state === 'blocked' && outcome.reason !== 'executor_busy')) {
        return { ...outcome, launched, ...(stopReason ? { stopReason } : {}) };
      }
      if (Date.now() < deadline && !signal?.aborted && launched < maxJobs) {
        await sleep(Math.min(pollMs, deadline - Date.now()), undefined, { signal })
          .catch(error => { if (error.name !== 'AbortError') throw error; });
      }
    }
    return {
      state: signal?.aborted ? 'interrupted' : launched >= maxJobs ? 'limit_reached' : 'deadline',
      launched, lastOutcome,
    };
  } catch (error) {
    // A failed supervisor must still request a stop for its own claimed launch.
    interrupt('supervisor_error');
    if (interruptError) error.interruptFailure = interruptError;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
