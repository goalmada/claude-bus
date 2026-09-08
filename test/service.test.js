import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalQueue } from '../src/personal/queue.js';
import { configureService, serviceTick, serviceState } from '../src/personal/service.js';
import { publishEvents } from '../src/personal/service-events.js';
import { capacityFromEvent } from '../src/personal/capacity.js';

function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'service-test-'));fs.chmodSync(root,0o700);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const queue=new PersonalQueue(root);
 queue.transaction(state=>state.jobs.push({id:'task-one',owner:'test-owner',sourceTask:'test-source',createdAt:'2026-01-01T00:00:00.000Z',status:'queued',brief:'PRIVATE_SECRET',result:'PRIVATE_RESULT'}));
 configureService(queue,{authorizationId:'fixture-batch',enabled:true,launches:2,evidence:'Explicit synthetic service test authorization'});
 return queue;
}
function writeGate(queue, overrides = {}) {
 const gate={enabled:true,plan:'max',extraUsageEnabled:false,available:true,checkedAt:new Date().toISOString(),organizationId:'00000000-0000-0000-0000-000000000000',evidence:'Synthetic private gate evidence',...overrides};
 fs.writeFileSync(path.join(queue.root,'native-max-verification.json'),JSON.stringify(gate),{mode:0o600});
}
test('missing native verification cannot consume launch allowance',t=>{
 const q=fixture(t);assert.equal(serviceTick(q,{launch:()=>assert.fail('must not launch')}).reason,'native_gate_missing');
 assert.equal(serviceState(q).remaining,2);
});
test('durable reservation survives supervisor reconnect without a duplicate',t=>{
 const q=fixture(t);writeGate(q);let launches=0;
 serviceTick(q,{launch:()=>{launches++;}});
 const reconnected=new PersonalQueue(q.root);
 assert.equal(serviceTick(reconnected,{launch:()=>launches++}).reason,'runner_starting');
 q.transaction(state=>Object.assign(state.service.runner,{pid:123,birth:'identity'}));
 assert.equal(serviceTick(reconnected,{birth:()=> 'identity',launch:()=>launches++}).state,'running');
 assert.equal(launches,1);assert.equal(serviceState(q).remaining,1);
});
test('dead runner becomes uncertain and never relaunches',t=>{
 const q=fixture(t);writeGate(q);
 serviceTick(q,{launch:()=>{}});q.transaction(state=>Object.assign(state.service.runner,{pid:123,birth:'old'}));
 assert.equal(serviceTick(q,{birth:()=>null,launch:()=>assert.fail('no retry')}).reason,'runner_uncertain');
 assert.equal(q.get('task-one').status,'uncertain');
});
test('reported output holds next queued task for independent verification',t=>{
 const q=fixture(t);q.change('task-one',j=>{j.status='reported';});
 assert.equal(serviceTick(q,{launch:()=>assert.fail('review first')}).reason,'review_required');
});
test('event outbox is revisioned, replayable and excludes private text',t=>{
 const q=fixture(t);q.change('task-one',j=>{j.status='reported';j.runtime={};});
 publishEvents(q);const directory=path.join(q.root,'events');const before=fs.readdirSync(directory).map(p=>fs.readFileSync(path.join(directory,p),'utf8'));
 assert.equal(publishEvents(q),0);assert.equal(before.some(s=>s.includes('PRIVATE')),false);
 q.change('task-one',j=>{j.status='verified';j.verification={at:new Date().toISOString(),revision:j.revision+1,resultHash:j.resultHash};});publishEvents(q);
 const event=JSON.parse(fs.readFileSync(path.join(directory,`task-one.${q.get('task-one').revision}.json`)));
 assert.equal(event.independentlyVerified,true);assert.equal(event.suggestedStatus,'done');assert.equal(event.userAction,null);
});
test('provider capacity preserves unknown utilization and rejects unknown status',()=>{
 assert.equal(capacityFromEvent({type:'rate_limit_event',rate_limit_info:{status:'allowed'}}).utilization,null);
 assert.equal(capacityFromEvent({type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:123}}).resetsAt,123);
 assert.equal(capacityFromEvent({type:'rate_limit_event',rate_limit_info:{status:'invented'}}),null);
});

test('coordinator result reads require exact ownership and a complete report',t=>{
 const q=fixture(t),identity={owner:'test-owner',sourceTask:'test-source'};
 assert.throws(()=>q.readResult('task-one',identity),/complete/);
 q.change('task-one',j=>{j.status='reported';j.result='review me';j.resultHash='hash';});
 assert.throws(()=>q.readResult('task-one',{...identity,owner:'another'}),/ownership/);
 assert.equal(q.readResult('task-one',identity).result,'review me');
});

test('manual dispatch cannot take a durable service reservation',async t=>{
 const q=fixture(t);writeGate(q);serviceTick(q,{launch:()=>{}});
 await assert.rejects(q.run('task-one',{prepare:()=>assert.fail('not owner')}),/owns the executor reservation/);
 assert.equal(q.get('task-one').status,'queued');
});

test('expired or malformed gate diagnostics preserve queued task and allowance',t=>{
 const q=fixture(t);writeGate(q,{checkedAt:'2000-01-01T00:00:00.000Z'});
 assert.equal(serviceTick(q,{launch:()=>assert.fail('no native call')}).reason,'native_gate_expired');
 assert.equal(q.get('task-one').status,'queued');assert.equal(serviceState(q).remaining,2);
 assert.deepEqual(serviceState(q).nativeGate,{ok:false,reason:'native_gate_expired'});
 fs.writeFileSync(path.join(q.root,'native-max-verification.json'),'{invalid');
 assert.equal(serviceTick(q,{launch:()=>assert.fail('no native call')}).reason,'native_gate_invalid');
 assert.equal(serviceState(q).remaining,2);
});

test('exhausted authorization and uncertain identity remain distinct and never refill',t=>{
 const q=fixture(t);writeGate(q);
 configureService(q,{authorizationId:'fixture-revoke',enabled:false,launches:0,evidence:'Explicit zero-allowance test configuration'});
 q.transaction(state=>{state.service.enabled=true;});
 assert.equal(serviceTick(q,{launch:()=>assert.fail('no launch')}).reason,'launch_authorization_exhausted');
 assert.equal(serviceState(q).remaining,0);
 q.change('task-one',j=>{j.status='uncertain';});
 assert.equal(serviceTick(q,{launch:()=>assert.fail('no launch')}).reason,'executor_identity_uncertain');
 assert.equal(q.get('task-one').status,'uncertain');
});

test('batch approval replay preserves consumed allowance and original history',t=>{
 const q=fixture(t);writeGate(q);serviceTick(q,{launch:()=>{}});
 const reservation=serviceState(q).runner;
 assert.equal(reservation.authorizationId,'fixture-batch');
 const replay=configureService(q,{authorizationId:'fixture-batch',enabled:true,launches:2,evidence:'Explicit synthetic service test authorization'});
 assert.equal(replay.remaining,1);
 assert.equal(replay.runner.id,reservation.id);
 assert.throws(()=>configureService(q,{authorizationId:'fixture-batch',enabled:true,launches:5,evidence:'Explicit synthetic service test authorization'}));
 assert.equal(serviceState(q).remaining,1);
});
