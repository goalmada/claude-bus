// Synthetic contender for the concurrent reservation test. Each copy is a real, separate
// process racing for the same private queue, so the bound is exercised across processes
// rather than inside one event loop.
import { PersonalQueue } from '../../src/personal/queue.js';
import { reserveLaunch } from '../../src/personal/admission.js';

const [root, policyId, owner, taskId] = process.argv.slice(2);
const queue = new PersonalQueue(root);
const deadline = Date.now() + 15000;
let outcome;
while (true) {
  try {
    // No process observation: reserved records have no identity yet in this test.
    const record = reserveLaunch(queue, { policyId, owner, taskId, birth: () => null });
    outcome = { ok: true, id: record.id, taskId };
    break;
  } catch (error) {
    if (/Queue locked/.test(error.message) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      continue;
    }
    outcome = { ok: false, taskId, message: error.message };
    break;
  }
}
process.stdout.write(JSON.stringify(outcome));
