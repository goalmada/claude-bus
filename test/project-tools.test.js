import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectTools } from '../src/personal/project-tools.js';
import { hash, scopedPath } from '../src/personal/workspace.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-tools-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, 'worktree'); fs.mkdirSync(worktree); fs.mkdirSync(path.join(worktree,'test'));
  const source = path.join(worktree, 'source.js'); fs.writeFileSync(source, 'export const value = 1;');
  const job = { id:'synthetic',launchId:'attempt-one',worktree,scope:{read:['source.js','test/check.test.js'],edit:['source.js','test/check.test.js'],tests:['test/check.test.js']} };
  return { root, worktree, job, tools:projectTools(job,root) };
}

test('file tools reject unassigned paths, traversal, stale content and symlinks', t => {
  const {root,worktree,tools}=fixture(t);
  assert.throws(()=>tools.read_file({file:'../outside'}),/assigned/);
  assert.throws(()=>scopedPath(worktree,'.git/config'),/scope/);
  assert.throws(()=>tools.write_file({file:'source.js',content:'x',expectedHash:'stale'}),/changed/);
  const read=tools.read_file({file:'source.js'});
  tools.write_file({file:'source.js',content:'export const value = 2;',expectedHash:read.hash});
  assert.equal(tools.read_file({file:'source.js'}).hash,hash('export const value = 2;'));
  fs.unlinkSync(path.join(worktree,'source.js')); fs.symlinkSync(path.join(root,'private'),path.join(worktree,'source.js'));
  assert.throws(()=>tools.read_file({file:'source.js'}));
  assert.throws(()=>tools.write_file({file:'source.js',content:'escape',expectedHash:null}),/Linked/);
  assert.equal(fs.existsSync(path.join(root,'private')),false);
});

test('sandbox runs real tests and denies external reads/writes, network and subprocesses', {skip:process.platform!=='darwin'}, async t => {
  const {root,worktree,tools}=fixture(t);
  const sentinel=path.join(root,'sentinel');fs.writeFileSync(sentinel,'synthetic-private-content');
  fs.writeFileSync(path.join(worktree,'test/check.test.js'),`
const {test}=require('node:test'); const assert=require('node:assert/strict');
const fs=require('node:fs'); const net=require('node:net'); const cp=require('node:child_process');
test('arithmetic',()=>assert.equal(2+3,5));
test('external read denied',()=>assert.throws(()=>fs.readFileSync(${JSON.stringify(sentinel)})));
test('source write denied',()=>assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(worktree,'source.js'))},'bad')));
test('external write denied',()=>assert.throws(()=>fs.writeFileSync(${JSON.stringify(sentinel)},'bad')));
test('subprocess denied',()=>assert.throws(()=>cp.execFileSync('/bin/echo',['bad'])));
test('network denied',async()=>await new Promise((resolve,reject)=>{const s=net.connect(4317,'127.0.0.1');s.on('connect',()=>{s.destroy();reject(new Error('network allowed'));});s.on('error',()=>resolve());}));
`);
  const result=await tools.run_tests();
  assert.equal(result.code,0,result.output);
  assert.equal(fs.readFileSync(sentinel,'utf8'),'synthetic-private-content');
  assert.match(result.output,/tests 6/);
});
