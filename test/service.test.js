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
 configureService(queue,{enabled:true,launches:2,evidence:'Explicit synthetic service test authorization'});
 return queue;
}
test('missing native verification cannot consume launch allowance',t=>{
 const q=fixture(t);assert.equal(serviceTick(q,{launch:()=>assert.fail('must not launch')}).reason,'fresh_native_verification_required');
 assert.equal(serviceState(q).remaining,2);
});
test('durable reservation survives supervisor reconnect without a duplicate',t=>{
 const q=fixture(t);fs.writeFileSync(path.join(q.root,'native-max-verification.json'),'{}');let launches=0;
 serviceTick(q,{launch:()=>{launches++;}});
 const reconnected=new PersonalQueue(q.root);
 assert.equal(serviceTick(reconnected,{launch:()=>launches++}).reason,'runner_starting');
 q.transaction(state=>Object.assign(state.service.runner,{pid:123,birth:'identity'}));
 assert.equal(serviceTick(reconnected,{birth:()=> 'identity',launch:()=>launches++}).state,'running');
 assert.equal(launches,1);assert.equal(serviceState(q).remaining,1);
});
test('dead runner becomes uncertain and never relaunches',t=>{
 const q=fixture(t);fs.writeFileSync(path.join(q.root,'native-max-verification.json'),'{}');
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
 q.change('task-one',j=>{j.status='verified';j.verification={at:new Date().toISOString()};});publishEvents(q);
 const event=JSON.parse(fs.readFileSync(path.join(directory,`task-one.${q.get('task-one').revision}.json`)));
 assert.equal(event.independentlyVerified,true);assert.equal(event.suggestedStatus,'done');assert.equal(event.userAction,null);
});
test('provider capacity preserves unknown utilization and rejects unknown status',()=>{
 assert.equal(capacityFromEvent({type:'rate_limit_event',rate_limit_info:{status:'allowed'}}).utilization,null);
 assert.equal(capacityFromEvent({type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:123}}).resetsAt,123);
 assert.equal(capacityFromEvent({type:'rate_limit_event',rate_limit_info:{status:'invented'}}),null);
});
