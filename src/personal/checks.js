import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { hash, checkpoint, assertDiffScope } from './workspace.js';
import { testProfile } from './project-tools.js';

const recipes = { 'npm-test': ['test'], 'npm-build': ['run', 'build'] };
export function approveCheck(queue, id, { recipe, reviewer, evidence, outputs = [] }) {
  if (!Object.hasOwn(recipes, recipe) || !reviewer || typeof evidence !== 'string' || evidence.length < 20) throw new Error('Known recipe and independent review evidence required');
  if (!Array.isArray(outputs) || outputs.some(p => !['dist', 'build', '.next'].includes(p))) throw new Error('Unsupported build output directory');
  if (recipe === 'npm-test' && outputs.length) throw new Error('Tests cannot write source/build directories');
  return queue.change(id, job => {
    if (job.mode !== 'project' || job.status !== 'reported') throw new Error('Review the stopped project report before approving a command');
    if(execFileSync('git',['-C',job.worktree,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==job.baseSha)throw new Error('Base commit changed before review');
    assertDiffScope(job.worktree, job.scope);
    const current = checkpoint(job.worktree, job.scope);
    if (current.hash !== job.checkpoint?.hash) throw new Error('Edits changed since report');
    const pkg = JSON.parse(fs.readFileSync(path.join(job.worktree, 'package.json'), 'utf8'));
    const script = pkg.scripts?.[recipe === 'npm-test' ? 'test' : 'build'];
    if (typeof script !== 'string' || !script) throw new Error('Project has no requested npm script');
    job.checkApproval = { recipe, reviewer, evidence, outputs, checkpointHash: current.hash, scriptHash: hash(script), at: new Date().toISOString() };
  });
}

export async function runApprovedCheck(queue, id) {
  const initial = queue.get(id), approval = initial.checkApproval;
  if (!approval || initial.status !== 'reported') throw new Error('Independent command approval required');
  if (queue.get().some(j => ['launching','running','uncertain','checking'].includes(j.status))) throw new Error('Executor slot is occupied');
  if(execFileSync('git',['-C',initial.worktree,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==initial.baseSha)throw new Error('Base commit changed after review');
  assertDiffScope(initial.worktree, initial.scope);
  if (checkpoint(initial.worktree, initial.scope).hash !== approval.checkpointHash) throw new Error('Approved edits changed');
  const pkg = JSON.parse(fs.readFileSync(path.join(initial.worktree, 'package.json'), 'utf8'));
  if (hash(pkg.scripts[approval.recipe === 'npm-test' ? 'test' : 'build']) !== approval.scriptHash) throw new Error('Approved npm script changed');
  if (process.platform !== 'darwin') throw new Error('Required command sandbox unavailable');
  const npmPath = [path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js', '/usr/local/lib/node_modules/npm/bin/npm-cli.js'].find(file=>fs.existsSync(file));
  if(!npmPath)throw new Error('Approved npm runtime not found');
  const npm = fs.realpathSync(npmPath);
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approved-project-check-')));
  const profile = testProfile(initial.worktree, temporary) + '\n(allow process-fork)\n(allow signal (target same-sandbox))\n(allow process-exec (literal "/bin/sh") (literal "/bin/bash") (literal "/usr/bin/git") (literal "/usr/bin/xcrun") (literal "/usr/bin/sandbox-exec") (subpath "/Library/Developer/CommandLineTools"))\n(allow file-read* (subpath "/Library/Developer/CommandLineTools"))\n' +
    approval.outputs.map(dir => `(allow file-write* (subpath ${JSON.stringify(path.join(initial.worktree,dir))}))`).join('\n');
  fs.writeFileSync(path.join(temporary,'user-npmrc'),''); fs.writeFileSync(path.join(temporary,'global-npmrc'),'');
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: temporary, LANG: 'en_US.UTF-8', GIT_CONFIG_NOSYSTEM: '1', NPM_CONFIG_USERCONFIG: path.join(temporary,'user-npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(temporary,'global-npmrc'), NPM_CONFIG_CACHE: path.join(temporary,'npm-cache'), NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false' };
  queue.transaction(state => {
    if (state.jobs.some(j => ['launching','running','uncertain','checking'].includes(j.status))) throw new Error('Executor slot is occupied');
    const job=queue.find(state,id);if(job.status!=='reported'||job.checkApproval?.at!==approval.at)throw new Error('Approval changed');
    job.status='checking';
  });
  let output='', capped=false, signalled=false;
  try {
    const result = await new Promise((resolve,reject) => {
      const child=spawn('/usr/bin/sandbox-exec',['-p',profile,process.execPath,npm,...recipes[approval.recipe],'--ignore-scripts'],{cwd:initial.worktree,env,detached:true,stdio:['ignore','pipe','pipe']});
      const stop=()=>{signalled=true;try{process.kill(-child.pid,'SIGKILL');}catch{}};
      const timer=setTimeout(stop,120000);
      const poll=setInterval(()=>{try{if(queue.get(id).cancelRequested)stop();}catch{stop();}},100);
      child.once('spawn',()=>{try{queue.change(id,j=>{j.checkPid=child.pid;});}catch{stop();}});
      child.once('error',error=>{clearTimeout(timer);clearInterval(poll);reject(error);});
      for(const s of [child.stdout,child.stderr])s.on('data',chunk=>{output+=chunk.toString();if(Buffer.byteLength(output)>1024*1024){capped=true;stop();}});
      child.once('close',(code,signal)=>{clearTimeout(timer);clearInterval(poll);resolve({code,signal,capped,signalled});});
    });
    const log=path.join(queue.root,`${id}-approved-check.txt`);fs.writeFileSync(log,output.slice(0,1024*1024),{mode:0o600});
    return queue.change(id,j=>{j.checkResult={...result,recipe:approval.recipe,outputHash:hash(output),checkpointHash:approval.checkpointHash,at:new Date().toISOString()};j.status=result.signalled?'uncertain':'reported';});
  } catch { return queue.change(id,j=>{j.status='uncertain';j.reason='Approved check did not complete; inspect the recorded process before retry';}); }
  finally {fs.rmSync(temporary,{recursive:true,force:true});}
}
