import { setTimeout as sleep } from 'node:timers/promises';
import { dispatchNext } from './dispatcher.js';

// Bounded local worker, never a launch-on-login service. Review remains an external gate.
export async function workQueue(queue, executor, { maxJobs = 5, maxRunMs = 900000, pollMs = 1000, signal, onEvent = () => {}, dispatch = dispatchNext } = {}) {
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 20 || !Number.isInteger(maxRunMs) || maxRunMs < 100 || maxRunMs > 1800000 || !Number.isInteger(pollMs) || pollMs < 25 || pollMs > 5000) throw new Error('Worker limits outside supported bounds');
  const deadline = Date.now() + maxRunMs;
  let launched = 0, activeId = null;
  const interrupt = () => {
    if (!activeId) return;
    try { const j=queue.get(activeId); if(j.status==='running')queue.pause(activeId); else if(j.status==='launching')queue.cancel(activeId); } catch {}
  };
  const timer = setTimeout(interrupt, maxRunMs);
  signal?.addEventListener('abort', interrupt);
  try {
    while (Date.now() < deadline && !signal?.aborted && launched < maxJobs) {
      const jobs=queue.get();
      // Never use a paused/blocked result as a reason to try another executor or billing route.
      if(jobs.some(j=>j.status==='uncertain'))return {state:'blocked',reason:'uncertain_launch',launched};
      const ownedExecutor={prepare:async job=>{activeId=job.id;return await executor.prepare(job);}};
      const outcome=await dispatch(queue,ownedExecutor);
      onEvent(outcome);
      if(outcome.taskId && !['idle','waiting','blocked'].includes(outcome.state))launched++;
      activeId=null;
      if(outcome.state==='reported') {
        // The next iteration waits on the dispatcher's report-review gate.
      } else if(['failed','timed_out','paused','cancelled','uncertain'].includes(outcome.state) || (outcome.state==='blocked' && outcome.reason!=='executor_busy')) return {...outcome,launched};
      if(Date.now()<deadline && !signal?.aborted)await sleep(Math.min(pollMs,deadline-Date.now()),undefined,{signal}).catch(error=>{if(error.name!=='AbortError')throw error;});
    }
    return {state:signal?.aborted?'interrupted':launched>=maxJobs?'limit_reached':'deadline',launched};
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',interrupt);}
}
