import test from 'node:test';
import assert from 'node:assert/strict';
import {workQueue} from '../src/personal/worker.js';

test('bounded worker waits for review and stops on auth/quota block without retry',async()=>{
 let calls=0;const queue={get:()=>[]};
 const outcome=await workQueue(queue,{}, {maxRunMs:500,pollMs:25,dispatch:async()=>{
  calls++;return calls===1?{state:'waiting',reason:'review_required',taskId:'one'}:{state:'blocked',reason:'native_auth_or_quota',taskId:'two'};
 }});
 assert.equal(calls,2);assert.equal(outcome.state,'blocked');assert.equal(outcome.launched,0);
});
test('bounded worker respects job cap and has no idle auto-launch',async()=>{
 let calls=0;const queue={get:()=>[]};
 const result=await workQueue(queue,{}, {maxJobs:1,maxRunMs:500,pollMs:25,dispatch:async()=>{calls++;return {state:'reported',taskId:'one'};}});
 assert.equal(calls,1);assert.equal(result.state,'limit_reached');
 const idle=await workQueue(queue,{}, {maxRunMs:100,pollMs:25,dispatch:async()=>({state:'idle'})});
 assert.equal(idle.state,'deadline');assert.equal(idle.launched,0);
});
test('uncertain launch blocks worker before any dispatch',async()=>{
 const result=await workQueue({get:()=>[{status:'uncertain'}]}, {}, {dispatch:()=>assert.fail('no dispatch')});
 assert.equal(result.reason,'uncertain_launch');
});

test('deadline cancels only the launch claimed by this worker',async()=>{
 let cancelled=null,status='launching';
 const queue={get:id=>id?{status}:[],cancel:id=>{cancelled=id;status='cancelled';},pause:()=>assert.fail('still preparing')};
 const result=await workQueue(queue,{prepare:async()=>{await new Promise(r=>setTimeout(r,150));return {}; }},{maxRunMs:100,pollMs:25,dispatch:async(q,executor)=>{
  await executor.prepare({id:'owned'});return {state:status,taskId:'owned'};
 }});
 assert.equal(cancelled,'owned');assert.equal(result.state,'cancelled');
});

test('deadline never interrupts an occupied slot belonging to another worker',async()=>{
 const queue={get:()=>[{id:'other',status:'running'}],cancel:()=>assert.fail('not owned'),pause:()=>assert.fail('not owned')};
 const result=await workQueue(queue,{}, {maxRunMs:100,pollMs:25});
 assert.equal(result.state,'deadline');assert.equal(result.launched,0);
});
