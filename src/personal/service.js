import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publishEvents } from './service-events.js';

const busy = new Set(['launching','running','checking','uncertain']);
export function processBirth(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding:'utf8', timeout:2000 }).trim() || null; }
  catch { return null; }
}
export function serviceState(queue) {
  return queue.transaction(state => structuredClone(state.service ?? { enabled:false, remaining:0, runner:null }));
}
export function configureService(queue, { enabled, launches, evidence }) {
  if (typeof enabled !== 'boolean' || !Number.isInteger(launches) || launches < 0 || launches > 5 || typeof evidence !== 'string' || evidence.length < 20) throw new Error('Explicit service configuration and at most five launch authorizations required');
  return queue.transaction(state => {
    const service = state.service ??= { remaining:0, runner:null };
    if (service.runner && !service.runner.finishedAt) throw new Error('Do not reconfigure an owned runner');
    Object.assign(service, { enabled, remaining:launches, authorizationEvidence:evidence, authorizedAt:new Date().toISOString() });
    return structuredClone(service);
  });
}

export function serviceTick(queue, { launch = launchRunner, birth = processBirth, now = Date.now() } = {}) {
  publishEvents(queue);
  let reservation = null;
  const outcome = queue.transaction(state => {
    const service = state.service ??= { enabled:false, remaining:0, runner:null };
    service.observedAt = new Date(now).toISOString();
    let runner = service.runner;
    if (runner && !runner.finishedAt) {
      if (runner.pid && birth(runner.pid) === runner.birth) return { state:'running', taskId:runner.taskId, runnerId:runner.id };
      if (!runner.pid && now - Date.parse(runner.createdAt) < 10000) return { state:'waiting', reason:'runner_starting' };
      const job = queue.find(state, runner.taskId);
      if (['reported','verified','cancelled','paused','blocked','failed','timed_out'].includes(job.status)) runner.finishedAt = new Date(now).toISOString();
      else {
        job.status = 'uncertain';
        job.reason = 'Runner identity unavailable after reconnect; inspect native process and checkpoint before recovery';
        return { state:'blocked', reason:'runner_uncertain', taskId:job.id };
      }
    }
    const occupied = state.jobs.find(job => busy.has(job.status));
    if (occupied) return { state:'blocked', reason:'executor_busy', taskId:occupied.id };
    const review = state.jobs.find(job => job.status === 'reported');
    if (review) return { state:'waiting', reason:'review_required', taskId:review.id };
    const stopped = state.jobs.find(job => ['blocked','failed','paused','timed_out'].includes(job.status));
    if (stopped) return { state:'blocked', reason:'stopped_task_requires_coordinator', taskId:stopped.id };
    if (!service.enabled) return { state:'disabled' };
    if (service.remaining <= 0) return { state:'blocked', reason:'launch_authorization_exhausted' };
    const next = state.jobs.filter(job => job.status === 'queued').sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    if (!next) return { state:'idle' };
    // Capacity is intentionally not renewed from a timer or a successful prior run.
    const gate = path.join(queue.root, 'native-max-verification.json');
    if (!fs.existsSync(gate)) return { state:'blocked', reason:'fresh_native_verification_required', taskId:next.id };
    const quota = state.jobs.find(job => job.capacity?.status === 'rejected' && !job.verification && job.status !== 'cancelled');
    if (quota) return { state:'blocked', reason:'provider_capacity_rejected', taskId:quota.id };
    reservation = { id:crypto.randomUUID(), taskId:next.id, createdAt:new Date(now).toISOString(), pid:null, birth:null };
    service.runner = reservation;
    service.remaining--;
    return { state:'launching', taskId:next.id, runnerId:reservation.id };
  });
  if (reservation) launch(queue, reservation);
  return outcome;
}

function launchRunner(queue, reservation) {
  const env = Object.fromEntries(['HOME','PATH','TMPDIR','LANG','LC_ALL','USER','LOGNAME','SHELL'].filter(key => process.env[key]).map(key => [key,process.env[key]]));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./service-runner.js', import.meta.url)), queue.root, reservation.id], { env, detached:true, stdio:'ignore' });
  child.on('error', () => {}); // Persisted launch intent is reconciled conservatively by the next tick.
  child.unref();
}

export async function runService(queue, { signal, intervalMs = 2000, onState = () => {} } = {}) {
  const lock = path.join(queue.root, 'service.lock');
  const identity = { pid:process.pid, birth:processBirth(process.pid) };
  try { fs.mkdirSync(lock, { mode:0o700 }); }
  catch {
    const owner = JSON.parse(fs.readFileSync(path.join(lock,'owner.json'),'utf8'));
    if (!owner.birth || processBirth(owner.pid) === owner.birth) throw new Error('Service already active or ownership uncertain');
    fs.rmSync(lock, { recursive:true });
    fs.mkdirSync(lock, { mode:0o700 });
  }
  fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify(identity),{mode:0o600});
  try {
    while (!signal?.aborted) {
      try { onState(serviceTick(queue)); }
      catch { onState({state:'blocked',reason:'service_inspection_required'}); }
      await new Promise(resolve => { const timer=setTimeout(done,intervalMs); function done(){clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();} signal?.addEventListener('abort',done,{once:true}); });
    }
  } finally { fs.rmSync(lock, {recursive:true,force:true}); }
}
