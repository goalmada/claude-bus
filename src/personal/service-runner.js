import { PersonalQueue } from './queue.js';
import { nativeClaude } from './claude.js';
import { processBirth } from './service.js';
const [root, runnerId] = process.argv.slice(2);
const queue = new PersonalQueue(root);
const taskId = queue.transaction(state => {
  const runner = state.service?.runner;
  if (!runner || runner.id !== runnerId || runner.pid || runner.finishedAt) throw new Error('Runner reservation no longer owned');
  runner.pid = process.pid;
  runner.birth = processBirth(process.pid);
  return runner.taskId;
});
const stop = () => { try { queue.cancel(taskId); } catch {} };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
try {
  await queue.run(taskId, nativeClaude(queue.root), { reservationId:runnerId });
  queue.transaction(state => {
    if (state.service?.runner?.id === runnerId) state.service.runner.finishedAt = new Date().toISOString();
  });
} catch {
  // A surviving native child cannot be reconstructed from an exception. Never relaunch it.
  try { queue.change(taskId, job => { job.status='uncertain'; job.reason='Runner failed; inspect owned process and preserved work before recovery'; }); } catch {}
}
