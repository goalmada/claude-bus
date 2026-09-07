import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PersonalQueue } from '../src/personal/queue.js';
import { nativeClaude } from '../src/personal/claude.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-queue-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), worktree = path.join(root, 'review');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture');
  git('worktree', 'add', '--detach', worktree, 'HEAD');
  const queue = new PersonalQueue(path.join(root, 'private'));
  const input = { key: 'one', sourceTask: 'test-origin', worktree: fs.realpathSync(worktree), baseSha: git('rev-parse', 'HEAD'), brief: 'Review supplied content only', timeoutMs: 2000 };
  return { root, repo, queue, input };
}
const success = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Reviewed fixture content',session_id:'fake'}))`;
function fake(script = success) {
  return { prepare: async () => ({ command: process.execPath, args: ['-e', script], env: {} }) };
}
async function running(queue, id) {
  const deadline = Date.now() + 3000;
  while (queue.get(id).status !== 'running') {
    if (Date.now() > deadline) throw new Error('Fake process did not start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('idempotency survives reopening; conflicting input is rejected', t => {
  const { queue, input } = fixture(t);
  const job = queue.submit(input);
  assert.equal(new PersonalQueue(queue.root).submit(input).id, job.id);
  assert.throws(() => queue.submit({ ...input, brief: 'different' }), /different input/);
  assert.equal(queue.get().length, 1);
});

test('one executor lease blocks duplicates and other jobs until reconciled', async t => {
  const { queue, input } = fixture(t);
  const a = queue.submit(input);
  const other = path.join(path.dirname(input.worktree), 'other');
  execFileSync('git', ['-C', input.worktree, 'worktree', 'add', '--detach', other, 'HEAD'], { stdio: 'ignore' });
  const b = queue.submit({ ...input, key: 'two', worktree: other });
  const work = queue.run(a.id, fake('setInterval(()=>{}, 1000)'));
  await running(queue, a.id);
  await assert.rejects(queue.run(a.id, fake()), /Only queued/);
  await assert.rejects(queue.run(b.id, fake()), /One executor/);
  queue.cancel(a.id);
  assert.equal((await work).status, 'cancelled');
  assert.equal((await queue.run(b.id, fake())).status, 'reported');
});

test('queue cancellation never calls executor', async t => {
  const { queue, input } = fixture(t); const job = queue.submit(input);
  queue.cancel(job.id);
  await assert.rejects(queue.run(job.id, { prepare() { assert.fail('must not prepare'); } }), /Only queued/);
});

test('timeout kills stubborn owned process without retry', async t => {
  const { queue, input } = fixture(t);
  const job = queue.submit({ ...input, timeoutMs: 150 });
  const result = await queue.run(job.id, fake(`process.on('SIGINT',()=>{}); setInterval(()=>{},1000)`));
  assert.equal(result.status, 'timed_out');
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
  await assert.rejects(queue.run(job.id, fake()), /Only queued/);
});

test('crash launch intent is uncertain and never automatically relaunched', async t => {
  const { queue, input } = fixture(t); const job = queue.submit(input);
  queue.change(job.id, j => { j.status = 'launching'; j.launchId = 'persisted-before-crash'; });
  const reopened = new PersonalQueue(queue.root);
  assert.equal(reopened.reconcile(job.id).status, 'uncertain');
  await assert.rejects(reopened.run(job.id, fake()), /Only queued/);
  assert.throws(() => reopened.cancel(job.id), /Uncertain/);
  assert.throws(() => reopened.resolveUncertain(job.id, ''), /evidence/);
  assert.equal(reopened.resolveUncertain(job.id, 'Independent supervisor inspection confirms no owned process remains.').status, 'failed');
});

test('reported is not verified; reviewer must bind evidence to exact result', async t => {
  const { queue, input } = fixture(t); const job = queue.submit(input);
  assert.throws(() => queue.verify(job.id, { reviewer: 'test-reviewer', resultHash: 'x', evidence: 'Review independently checked.' }), /reported result/);
  const result = await queue.run(job.id, fake());
  assert.equal(result.status, 'reported');
  assert.throws(() => queue.verify(job.id, { reviewer: 'test-reviewer', resultHash: 'wrong', evidence: 'Review independently checked.' }), /reported result/);
  assert.equal(queue.verify(job.id, { reviewer: 'test-reviewer', resultHash: result.resultHash, evidence: 'Compared result with fixture input and pinned base commit.' }).status, 'verified');
});

test('denial or malformed stream cannot count as a successful report', async t => {
  for (const [key, script, expected] of [
    ['denied', `console.log(JSON.stringify({type:'result',subtype:'success',result:'x',permission_denials:[{}]}))`, 'blocked'],
    ['invalid', `console.log('not-json')`, 'failed'],
    ['missing', `console.log(JSON.stringify({type:'system'}))`, 'failed'],
    ['nonzero', `${success};process.exitCode=1`, 'failed'],
  ]) {
    const { queue, input } = fixture(t);
    const job = queue.submit({ ...input, key });
    assert.equal((await queue.run(job.id, fake(script))).status, expected);
  }
});

test('real executor stays disabled and performs no auth or model call', async t => {
  const { queue, input } = fixture(t); const job = queue.submit(input);
  assert.equal((await queue.run(job.id, nativeClaude(queue.root))).status, 'blocked');
  assert.equal(queue.get(job.id).pid, undefined);
});

test('state rejects git checkout, broad permissions and changed worktree', async t => {
  const { queue, input, repo, root } = fixture(t);
  assert.throws(() => new PersonalQueue(path.join(repo, 'state')), /outside/);
  const publicDir = path.join(root, 'public'); fs.mkdirSync(publicDir, { mode: 0o755 }); fs.chmodSync(publicDir, 0o755);
  assert.throws(() => new PersonalQueue(publicDir), /0700/);
  assert.throws(() => queue.submit({ ...input, worktree: repo }), /isolated/);
  const job = queue.submit(input);
  fs.writeFileSync(path.join(input.worktree, 'changed'), 'x');
  assert.equal((await queue.run(job.id, fake())).status, 'blocked');
});

test('native preflight strips billing overrides and rejects API auth without launching', async t => {
  const { queue } = fixture(t);
  fs.writeFileSync(path.join(queue.root, 'native-max-verification.json'), JSON.stringify({
    enabled: true, plan: 'max', extraUsageEnabled: false, available: true, checkedAt: new Date().toISOString(),
    organizationId: '00000000-0000-0000-0000-000000000000', evidence: 'Synthetic test evidence only',
  }), { mode: 0o600 });
  let checked = false;
  const inspected = (args, env) => {
    checked = true;
    assert.ok(args.includes('--safe-mode'));
    assert.deepEqual(Object.keys(env).filter(k => /ANTHROPIC|CLAUDE/.test(k)), []);
    return { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' };
  };
  await assert.rejects(nativeClaude(queue.root, inspected).prepare(), /subscription login/);
  assert.ok(checked);
  const spec = await nativeClaude(queue.root, () => ({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', orgId: '00000000-0000-0000-0000-000000000000' })).prepare();
  assert.equal(spec.args[spec.args.indexOf('--tools') + 1], '');
  assert.ok(spec.args.includes('dontAsk'));
  assert.ok(!spec.args.includes('--bare'));
  assert.ok(spec.args.includes('--no-session-persistence'));
});

test('expired Max verification never even inspects credentials', async t => {
  const { queue } = fixture(t);
  fs.writeFileSync(path.join(queue.root, 'native-max-verification.json'), JSON.stringify({
    enabled: true, plan: 'max', extraUsageEnabled: false, available: true, checkedAt: '2000-01-01T00:00:00Z',
    organizationId: '00000000-0000-0000-0000-000000000000', evidence: 'Expired synthetic evidence',
  }), { mode: 0o600 });
  await assert.rejects(nativeClaude(queue.root, () => assert.fail('No auth command expected')).prepare(), /Fresh native/);
});

test('reconciliation during preflight prevents spawning', async t => {
  const { queue, input } = fixture(t); const job = queue.submit(input);
  const result = await queue.run(job.id, { prepare: async () => {
    queue.reconcile(job.id);
    return { command: process.execPath, args: ['-e', 'process.exit(99)'], env: {} };
  } });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.pid, undefined);
});

test('stale transaction lock fails closed and is not stolen', t => {
  const { queue } = fixture(t);
  fs.mkdirSync(queue.lock, { mode: 0o700 });
  assert.throws(() => queue.transaction(() => null), /Queue locked/);
  assert.deepEqual(queue.get(), []);
  assert.ok(fs.existsSync(queue.lock));
});

test('a real supervisor crash preserves launch uncertainty across processes', async t => {
  const { queue, input } = fixture(t); const job = queue.submit(input);
  const { spawn } = await import('node:child_process');
  const moduleUrl = new URL('../src/personal/queue.js', import.meta.url).href;
  const script = `import {PersonalQueue} from ${JSON.stringify(moduleUrl)};
    const q = new PersonalQueue(process.argv[1]);
    await q.run(process.argv[2], {prepare: async()=>{process.stdout.write('ready'); return await new Promise(()=>setInterval(()=>{},1000));}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, queue.root, job.id], { env: {}, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Supervisor did not persist intent')), 3000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(queue.get(job.id).status, 'launching');
  const exited = new Promise(r => child.once('exit', r));
  child.kill('SIGKILL'); await exited;
  const reopened = new PersonalQueue(queue.root);
  assert.equal(reopened.get(job.id).status, 'launching');
  assert.equal(reopened.reconcile(job.id).status, 'uncertain');
  await assert.rejects(reopened.run(job.id, fake()), /Only queued/);
});

test('project pause preserves edits and resumes same task with a new attempt', async t => {
  const {queue,input}=fixture(t);
  const job=queue.submit({...input,mode:'project',scope:{read:[],edit:['source.js'],tests:['test/unit.test.js']}});
  const pending=queue.run(job.id,fake(`require('node:fs').writeFileSync('source.js','preserved'); setInterval(()=>{},1000)`));
  await running(queue,job.id);
  while(!fs.existsSync(path.join(input.worktree,'source.js'))) await new Promise(r=>setTimeout(r,10));
  queue.pause(job.id);
  const paused=await pending;
  assert.equal(paused.status,'paused'); assert.equal(paused.checkpoint.files['source.js'],'preserved');
  assert.equal(queue.resume(job.id).status,'queued');
  const report=await queue.run(job.id,fake(success));
  assert.equal(report.status,'reported');assert.equal(report.attempts.length,1);
  assert.equal(fs.readFileSync(path.join(input.worktree,'source.js'),'utf8'),'preserved');
  assert.ok(report.events.some(e=>e.status==='paused'));
  assert.ok(report.events.every((e,i)=>i===0 || e.revision>report.events[i-1].revision));
  queue.verify(job.id,{reviewer:'independent',resultHash:report.resultHash,evidence:'Compared preserved content with the assigned source fixture.'});
});

test('project recovery refuses changed checkpoints and out-of-scope output', async t => {
  const {queue,input}=fixture(t);
  const job=queue.submit({...input,mode:'project',scope:{read:[],edit:['source.js'],tests:['test/unit.test.js']}});
  const result=await queue.run(job.id,fake(`require('node:fs').writeFileSync('outside.js','bad');${success}`));
  assert.equal(result.status,'uncertain');
  assert.throws(()=>queue.resume(job.id),/stopped/);
  assert.equal(queue.get(job.id).events.at(-1).status,'uncertain');
});

test('required project tools must be confirmed by actual runtime initialization', async t => {
  const {queue,input}=fixture(t);const job=queue.submit(input);
  const executor=fake(success);const prepare=executor.prepare;
  executor.prepare=async()=>({...await prepare(),expectedTools:['mcp__project__write_file']});
  assert.equal((await queue.run(job.id,executor)).status,'blocked');
});
