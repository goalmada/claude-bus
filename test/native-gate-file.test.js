import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectNativeGate } from '../src/personal/native-gate-file.js';
import { nativeClaude } from '../src/personal/claude.js';

test('private gate file errors are distinct and never expose its contents or invoke auth',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gate-file-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'native-max-verification.json');
 assert.deepEqual(inspectNativeGate(root),{ok:false,reason:'native_gate_missing'});
 fs.writeFileSync(file,'PRIVATE_INVALID_JSON',{mode:0o600});
 assert.deepEqual(inspectNativeGate(root),{ok:false,reason:'native_gate_invalid'});
 fs.chmodSync(file,0o644);assert.equal(inspectNativeGate(root).reason,'native_gate_unsafe_file');
 fs.unlinkSync(file);fs.writeFileSync(path.join(root,'other'),'PRIVATE_OTHER',{mode:0o600});fs.symlinkSync(path.join(root,'other'),file);
 assert.equal(inspectNativeGate(root).reason,'native_gate_unsafe_file');
 fs.unlinkSync(file);
 const gate={enabled:true,plan:'max',extraUsageEnabled:false,available:true,checkedAt:'2000-01-01T00:00:00Z',organizationId:'00000000-0000-0000-0000-000000000000',evidence:'PRIVATE_EVIDENCE'};
 fs.writeFileSync(file,JSON.stringify(gate),{mode:0o600});
 const blocked=inspectNativeGate(root);assert.deepEqual(blocked,{ok:false,reason:'native_gate_expired'});assert.equal(JSON.stringify(blocked).includes('PRIVATE'),false);
 await assert.rejects(nativeClaude(root,()=>assert.fail('No auth call on stale evidence')).prepare(),error=>error.code==='native_gate_expired');
 gate.checkedAt=new Date().toISOString();fs.writeFileSync(file,JSON.stringify(gate),{mode:0o600});assert.equal(inspectNativeGate(root).ok,true);
});
