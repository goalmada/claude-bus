import fs from 'node:fs';
import { capacityFromEvent } from './capacity.js';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { execFileSync, spawn } from 'node:child_process';
import { validateScope, checkpoint, assertDiffScope } from './workspace.js';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const inflight = new Set(['launching', 'running', 'uncertain', 'checking']);
const terminal = new Set(['verified', 'failed', 'cancelled', 'timed_out']);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export class PersonalQueue {
  constructor(root = path.join(os.homedir(), '.local/state/claude-personal-queue')) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync(root);
    try { git(this.root, 'rev-parse', '--git-dir'); throw new Error('Queue state must be outside every git checkout'); }
    catch (error) { if (!error.status) throw error; }
    const stat = fs.statSync(this.root);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Queue directory must be owned by this user with mode 0700');
    this.file = path.join(this.root, 'queue.json');
    this.lock = path.join(this.root, 'queue.lock');
  }

  transaction(fn) {
    // Fail closed on a stale lock. Never steal a lease using a guessed PID.
    try { fs.mkdirSync(this.lock, { mode: 0o700 }); }
    catch { throw new Error('Queue locked: retry later; inspect a persistent stale lock manually'); }
    try {
      fs.writeFileSync(path.join(this.lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
      const state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, jobs: [] };
      if (state.version !== 1 || !Array.isArray(state.jobs)) throw new Error('Unsupported queue format');
      const before = JSON.stringify(state);
      const previous = new Map(state.jobs.map(j => [j.id, JSON.stringify(j)]));
      const result = fn(state);
      for (const job of state.jobs) {
        if (previous.get(job.id) !== JSON.stringify(job)) {
          job.revision = (job.revision ?? 0) + 1;
          job.events ??= [];
          job.events.push({ revision: job.revision, at: new Date().toISOString(), status: job.status, launchId: job.launchId ?? null });
        }
      }
      if (fs.existsSync(this.file) && JSON.stringify(state) === before) return structuredClone(result);
      const tmp = path.join(this.root, `queue-${crypto.randomUUID()}.tmp`);
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(state, null, 2)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      const dir = fs.openSync(this.root, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      return structuredClone(result);
    } finally { fs.rmSync(this.lock, { recursive: true }); }
  }

  submit({ key, sourceTask, worktree, baseSha, brief, timeoutMs = 300000, mode = 'review', scope, owner = sourceTask }) {
    if (![key, sourceTask, worktree, baseSha, brief].every(v => typeof v === 'string' && v.length)) throw new Error('Missing task fields');
    if (Buffer.byteLength(brief) > 128 * 1024 || key.length > 200 || sourceTask.length > 200) throw new Error('Task too large');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 600000) throw new Error('Timeout must be 25..600000 ms');
    worktree = fs.realpathSync(worktree);
    if (git(worktree, 'rev-parse', '--show-toplevel') !== worktree) throw new Error('Use the worktree root');
    const gitDir = git(worktree, 'rev-parse', '--absolute-git-dir');
    const common = fs.realpathSync(path.resolve(worktree, git(worktree, 'rev-parse', '--git-common-dir')));
    if (fs.realpathSync(gitDir) === common) throw new Error('Use an isolated linked worktree, not the primary checkout');
    if (!/^[a-f0-9]{40,64}$/.test(baseSha) || git(worktree, 'rev-parse', 'HEAD') !== baseSha) throw new Error('Base commit mismatch');

    if (!['review', 'project'].includes(mode) || typeof owner !== 'string' || !owner) throw new Error('Task mode and owner required');
    scope = mode === 'project' ? validateScope(worktree, scope) : null;
    const input = { sourceTask, owner, worktree, baseSha, brief, timeoutMs, mode, scope, billingMode: 'subscription_only', tools: mode === 'project' ? ['read_file','write_file','run_tests'] : [] };
    const inputHash = digest(JSON.stringify(input));
    return this.transaction(state => {
      const existing = state.jobs.find(job => job.key === key);
      if (existing) {
        if (existing.inputHash !== inputHash) throw new Error('Idempotency key already used for different input');
        return existing;
      }
      if (git(worktree, 'status', '--porcelain')) throw new Error('Worktree must be clean');
      if (state.jobs.some(j => j.worktree === worktree && !terminal.has(j.status))) throw new Error('Worktree already owned by an unfinished task');
      const job = { id: crypto.randomUUID(), key, ...input, inputHash, status: 'queued', createdAt: new Date().toISOString() };
      state.jobs.push(job);
      return job;
    });
  }

  get(id) {
    // Atomic replacement gives readers a complete snapshot without contending with a writer.
    const state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, jobs: [] };
    if (state.version !== 1 || !Array.isArray(state.jobs)) throw new Error('Unsupported queue format');
    return structuredClone(id ? this.find(state, id) : state.jobs);
  }
  find(state, id) {
    const job = state.jobs.find(j => j.id === id);
    if (!job) throw new Error('Unknown task');
    return job;
  }
  change(id, fn) { return this.transaction(state => { const job = this.find(state, id); fn(job); return job; }); }

  cancel(id) {
    return this.change(id, job => {
      if (terminal.has(job.status)) return;
      if (job.status === 'uncertain') throw new Error('Uncertain launch: reconcile the owned process manually before cancellation');
      if (['queued', 'blocked', 'reported'].includes(job.status)) job.status = 'cancelled';
      else job.cancelRequested = true;
    });
  }

  pause(id) {
    return this.change(id, job => {
      if (job.status !== 'running') throw new Error('Only a running task can be interrupted');
      job.pauseRequested = true;
    });
  }

  resume(id) {
    return this.change(id, job => {
      if ((!['paused', 'timed_out', 'blocked'].includes(job.status) && !(job.status === 'failed' && job.reconciliationEvidence)) || job.mode !== 'project' || !job.checkpoint) throw new Error('Resume requires a stopped project attempt with a checkpoint');
      assertDiffScope(job.worktree, job.scope);
      if (checkpoint(job.worktree, job.scope).hash !== job.checkpoint.hash) throw new Error('Checkpoint has external edits; inspect before continuing');
      job.status = 'queued';
      job.cancelRequested = false; job.pauseRequested = false;
    });
  }

  reconcile(id) {
    return this.change(id, job => {
      if (!inflight.has(job.status)) throw new Error('Only in-flight launches need reconciliation');
      job.status = 'uncertain';
      job.reason = 'Supervisor state uncertain: inspect the recorded launch and worktree. No automatic relaunch or PID-based kill.';
    });
  }

  resolveUncertain(id, evidence) {
    if (!evidence || evidence.length < 20) throw new Error('Record evidence that the owned process is stopped');
    return this.change(id, job => {
      if (job.status !== 'uncertain') throw new Error('Task is not uncertain');
      job.status = 'failed';
      job.reconciliationEvidence = evidence;
    });
  }

  verify(id, { reviewer, resultHash, evidence, independentCheck }) {
    if (!reviewer || !evidence || evidence.length < 20) throw new Error('Independent reviewer and verification evidence required');
    return this.change(id, job => {
      const recipePassed = job.checkResult?.code === 0 && job.checkResult?.checkpointHash === job.checkpoint?.hash;
      const coordinatorChecked = independentCheck?.code === 0 && independentCheck.checkpointHash === job.checkpoint?.hash && /^[a-f0-9]{64}$/.test(independentCheck.outputHash ?? '') && typeof independentCheck.evidence === 'string' && independentCheck.evidence.length >= 20;
      if (job.checkApproval && !recipePassed && !coordinatorChecked) throw new Error('Approved project check must pass, or coordinator must attest a separate check of the current edits');
      if (job.status !== 'reported' || job.resultHash !== resultHash) throw new Error('Verification must match a reported result');
      if (git(job.worktree, 'rev-parse', 'HEAD') !== job.baseSha) throw new Error('Base changed since execution');
      if (job.mode === 'project') {
        assertDiffScope(job.worktree, job.scope);
        if (checkpoint(job.worktree, job.scope).hash !== job.checkpoint?.hash) throw new Error('Edits changed since report');
      } else if (git(job.worktree, 'status', '--porcelain')) throw new Error('Worktree changed since review');
      job.verification = { reviewer, evidence, resultHash, at: new Date().toISOString() };
      if (coordinatorChecked) job.verification.independentCheck = { mechanism: 'coordinator_attestation', code: 0, checkpointHash: independentCheck.checkpointHash, outputHash: independentCheck.outputHash, evidence: independentCheck.evidence };
      job.status = 'verified';
    });
  }

  async run(id, executor) {
    const launchId = crypto.randomUUID();
    const job = this.transaction(state => {
      const job = this.find(state, id);
      if (job.status !== 'queued') throw new Error('Only queued tasks can launch; never retry an uncertain launch');
      if (state.jobs.some(j => inflight.has(j.status))) throw new Error('One executor at a time; reconcile unfinished launches first');
      job.attempts ??= [];
      if (job.launchId) job.attempts.push({ launchId: job.launchId, resultHash: job.resultHash ?? null, checkpointHash: job.checkpoint?.hash ?? null, finishedAt: job.finishedAt ?? null });
      job.cancelRequested = false; job.pauseRequested = false;
      delete job.result; delete job.resultHash; delete job.runtime; delete job.reason; delete job.sessionId;
      job.status = 'launching';
      job.launchId = launchId;
      job.startedAt = new Date().toISOString();
      return job;
    });
    let spec;
    try {
      if (git(job.worktree, 'rev-parse', 'HEAD') !== job.baseSha) throw new Error('Base changed before launch');
      if (job.mode === 'project' && job.checkpoint) {
        assertDiffScope(job.worktree, job.scope);
        if (checkpoint(job.worktree, job.scope).hash !== job.checkpoint.hash) throw new Error('Checkpoint changed before resume');
      } else if (git(job.worktree, 'status', '--porcelain')) throw new Error('Worktree changed before launch');
      spec = await executor.prepare(job);
    } catch {
      return this.change(id, j => { if (j.status === 'launching') { j.status = j.cancelRequested ? 'cancelled' : 'blocked'; j.reason = 'Preflight denied. Verify native account and configuration before submitting a new task.'; } });
    }
    // Persist the launch intent before spawning. A crash here is uncertain, never queued.
    const ready = this.get(id);
    if (ready.status !== 'launching') return ready;
    if (ready.cancelRequested) return this.change(id, j => { j.status = 'cancelled'; });
    let child;
    try { child = spawn(spec.command, spec.args, { cwd: job.worktree, env: spec.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { return this.change(id, j => { j.status = 'failed'; j.reason = 'Spawn failed before process creation'; }); }
    let signalDenied = false;
    const signal = sig => {
      if (!child.pid) return;
      try { process.kill(-child.pid, sig); }
      catch (error) { if (error.code !== 'ESRCH') signalDenied = true; }
    };
    let stopping = null, escalation, poll, timer, bytes = 0, pending = '', result = null, count = 0;
    const decoder = new StringDecoder('utf8');
    let protocolError = false, spawnError = false, initConfirmed = false;
    const stop = reason => {
      if (stopping) return;
      stopping = reason;
      signal('SIGINT');
      escalation = setTimeout(() => signal('SIGKILL'), 500);
    };
    return await new Promise((resolve, reject) => {
      child.once('spawn', () => {
        try {
          this.change(id, j => { if (j.status !== 'launching') throw new Error('Launch was reconciled externally'); j.status = 'running'; j.pid = child.pid; });
          timer = setTimeout(() => stop('timed_out'), job.timeoutMs);
          poll = setInterval(() => {
            try { const current = this.get(id); if (current.cancelRequested || current.status === 'uncertain') stop('cancelled'); else if (current.pauseRequested) stop('paused'); }
            catch { stop('uncertain'); }
          }, 50);
        } catch { stop('uncertain'); }
      });
      child.on('error', () => { spawnError = true; });
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { protocolError = true; stop('failed'); return; }
        pending += decoder.write(chunk);
        let split;
        while ((split = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, split); pending = pending.slice(split + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line); count++;
            const capacity = capacityFromEvent(event);
            if (capacity) {
              this.change(id, j => { j.capacity = capacity; });
              if (capacity.status === 'rejected') stop('blocked');
            }
            if (event.type === 'system' && event.subtype === 'api_retry' && ['rate_limit','authentication_failed','billing_error','oauth_org_not_allowed'].includes(event.error)) stop('blocked');
            if (event.type === 'system' && event.subtype === 'init') {
              this.change(id, j => { j.sessionId = event.session_id ?? null; j.runtime = { tools: event.tools ?? [], mcpServers: event.mcp_servers ?? [], sessionId: event.session_id ?? null }; });
              if (spec.expectedTools?.length && (spec.expectedTools.some(tool => !event.tools?.includes(tool)) || event.tools?.some(tool => !spec.expectedTools.includes(tool)))) stop('blocked');
              else initConfirmed = true;
            }
            // Only final result is retained. Tool output, stderr and auth data stay out of logs.
            if (event.type === 'result') {
              if (result) throw new Error('Duplicate final result');
              result = event;
            }
          } catch { protocolError = true; }
        }
      });
      child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) stop('failed'); });
      child.once('close', (code, sig) => {
        pending += decoder.end();
        clearTimeout(timer); clearTimeout(escalation); clearInterval(poll);
        // Cancellation owns this process group. Do not signal historical PIDs on success.
        if (stopping) signal('SIGKILL');
        try {
          resolve(this.change(id, j => {
            if (j.mode === 'project') {
              try { assertDiffScope(j.worktree, j.scope); j.checkpoint = checkpoint(j.worktree, j.scope); }
              catch { j.status = 'uncertain'; j.reason = 'Workspace changed outside scope; preserve edits and inspect'; }
            }
            if (j.status === 'uncertain') return;
            j.exitCode = code; j.exitSignal = sig; j.eventCount = count; j.finishedAt = new Date().toISOString();
            if (signalDenied) { j.status = 'uncertain'; j.reason = 'Owned process group termination could not be confirmed'; return; }
            if (stopping) { j.status = stopping; j.reason = stopping === 'uncertain' ? 'Supervisor state synchronization failed; inspect the owned process group' : 'Execution stopped by supervisor'; return; }
            if (j.cancelRequested) { j.status = 'cancelled'; return; }
            if (spawnError || code !== 0 || protocolError || pending.trim() || !result) { j.status = 'failed'; j.reason = 'Executor failed or returned incomplete structured output'; return; }
            if (spec.expectedTools?.length && !initConfirmed) { j.status = 'blocked'; j.reason = 'Required tools were not confirmed by runtime initialization'; return; }
            if (result.is_error || result.subtype !== 'success' || typeof result.result !== 'string' || result.permission_denials?.length) {
              j.status = 'blocked'; j.reason = 'Executor reported an error or denied permission; no fallback'; return;
            }
            j.status = 'reported'; j.result = result.result; j.sessionId = result.session_id ?? null; j.resultHash = digest(j.result);
          }));
        } catch (error) { reject(error); }
      });
      child.stdin.end(job.brief + (job.checkpoint ? '\nContinuation: preserved files already contain earlier work. Read before editing; finish remaining work without restarting or discarding edits.' : ''));
    });
  }
}
