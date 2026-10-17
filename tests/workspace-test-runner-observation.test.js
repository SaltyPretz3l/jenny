"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {createTestRunnerObservation}=require('../services/workspace-test-runner-observation');
test('retention caps completed runs/output, preserves unresolved and restores only attributed metadata',()=>{
 let time=Date.parse('2026-10-08T12:00:00Z');const owner=createTestRunnerObservation({now:()=>new Date(time)});
 const begin=runId=>owner.begin({runId,configId:'c',label:'Test',startedAt:new Date(time).toISOString(),scope:{schema_version:1,project_id:'p'}});
 begin('unresolved');owner.result('unresolved',{status:'aborted'},null);owner.settle('unresolved',false);
 for(let i=0;i<205;i++){const id='r'+i;begin(id);owner.result(id,{status:'passed'},{stdoutTail:'x'.repeat(70000)});owner.settle(id,true);time++;}
 const rows=owner.snapshot();assert.equal(rows.length,201);assert.equal(rows.filter(r=>r.outputAvailable).length,8);
 assert.equal(Buffer.byteLength(owner.output('r204').stdoutTail),65536);
 time+=86400001;assert.deepEqual(owner.snapshot().map(r=>r.runId),['unresolved']);
 owner.restore({byConfig:{c:[{runId:'legacy',status:'passed'},{runId:'restored',configId:'c',status:'interrupted',startedAt:new Date(time).toISOString(),activity:{schema_version:1,label:'Original',scope:{schema_version:1,project_id:'original'}}}]}});
 const restored=owner.snapshot().find(r=>r.runId==='restored');assert.equal(restored.scope.project_id,'original');assert.equal(restored.cleanup,'unknown');assert.equal(restored.outputAvailable,false);assert.equal(owner.snapshot().some(r=>r.runId==='legacy'),false);
});
test('an idle subscriber loses an expired completed row through one one-shot timer cleared on dispose',t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-10-08T12:00:00Z')});
 const owner=createTestRunnerObservation({now:()=>new Date()});
 owner.begin({runId:'done',configId:'c',label:'Test',startedAt:new Date().toISOString(),scope:{schema_version:1,project_id:'p'}});
 owner.result('done',{status:'passed'},null);owner.settle('done',true);
 owner.begin({runId:'stuck',configId:'c',label:'Test',startedAt:new Date().toISOString(),scope:{schema_version:1,project_id:'p'}});
 owner.result('stuck',{status:'aborted'},null);owner.settle('stuck',false);
 const seen=[];owner.subscribe(()=>seen.push(owner.snapshot().map(row=>row.runId)));
 t.mock.timers.tick(86400000);assert.deepEqual(seen,[],'nothing expires before the retention boundary');
 t.mock.timers.tick(1000);assert.deepEqual(seen,[['stuck']],'the subscriber is told once without another request');
 t.mock.timers.tick(10*86400000);assert.equal(seen.length,1,'no further wakeups once nothing can expire');
 owner.begin({runId:'later',configId:'c',label:'Test',startedAt:new Date().toISOString(),scope:{schema_version:1,project_id:'p'}});
 owner.result('later',{status:'passed'},{stdoutTail:'kept'});owner.settle('later',true);seen.length=0;
 owner.dispose();t.mock.timers.tick(2*86400000);assert.deepEqual(seen,[]);
 assert.equal(owner.output('later')?.stdoutTail,'kept','dispose cleared the expiry timer, so nothing pruned after close');
});
