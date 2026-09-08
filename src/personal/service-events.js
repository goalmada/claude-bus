import fs from 'node:fs';
import path from 'node:path';
import { dashboardHandoff } from './projection.js';

export function publishEvents(queue) {
  const directory = path.join(queue.root, 'events');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let written = 0;
  for (const job of queue.get()) {
    if (!/^[a-zA-Z0-9-]+$/.test(job.id) || !job.events?.length) continue;
    for (const event of job.events) {
      const target = path.join(directory, `${job.id}.${event.revision}.json`);
      if (fs.existsSync(target)) continue;
      const verified = event.status === 'verified' && job.verification?.revision === event.revision && job.verification.resultHash === job.resultHash && event.at >= job.verification.at;
      const record = { ...job, status: event.status, revision: event.revision, events: [event], verification: verified ? job.verification : undefined };
      const summary = event.status === 'reported' ? 'Executor report ready for independent review' : `Queue execution state: ${event.status}`;
      const projection = dashboardHandoff(record, {
        kind: job.runtime ? 'actual' : 'unverified', summary,
        next: event.status === 'reported' ? 'Coordinator reviews the retained result and exact file checkpoint' : 'Coordinator follows the exact recorded execution state',
        blocker: ['blocked','failed','uncertain','timed_out'].includes(event.status) ? 'Coordinator inspection required; automatic retry disabled' : 'None',
      });
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, ...projection, independentlyVerified: verified }) + '\n', { mode: 0o600 });
      fs.renameSync(temporary, target);
      written++;
    }
  }
  return written;
}
