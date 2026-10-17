"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceTestRunnerService } = require('../services/workspace-test-runner-service');
const { createTestRunnerHistory } = require('../services/workspace-test-runner-history');
function fixture() {
  let data = { byConfig: {} }, resolveRun, count = 0;
  const history = createTestRunnerHistory({store:{read:()=>data,write:value=>{data=value;}}});
  const service = createWorkspaceTestRunnerService({
    rootProvider:()=>process.cwd(), configProvider:()=>[{id:'unit',label:'Unit <test>',command:'echo unit'}],
    history, makeRunId:()=>`run-${++count}`,
    activityScopeProvider:()=>({schema_version:1,project_id:'project-a',session_id:null,root_id:'root-a',root_revision:2}),
    runner:{runTestCommand: options=>new Promise(resolve=>{resolveRun={resolve,options};})},
  });
  return {service,history,pending:()=>resolveRun,finish:(extra={})=>resolveRun.resolve({status:'passed',exitCode:0,stdoutTail:'first output',stderrTail:'',terminationConfirmed:true,...extra})};
}
test('owner captures scope and output by run, with targeted cancellation', async()=>{
  const f=fixture(); const pending=f.service.run({configId:'unit',includeOutput:true,project_id:'spoof'});
  const first=f.service.getActivityRuns()[0];
  assert.equal(first.scope.project_id,'project-a'); assert.equal(first.state,'running');
  assert.equal(f.service.abort({expectedRunId:'old'}).aborted,false);
  assert.equal(f.pending().options.abortSignal.aborted,false);
  f.finish(); await pending;
  assert.equal(f.service.getActivityRuns()[0].cleanup,'confirmed');
  assert.equal(f.service.getRunOutput('run-1').stdoutTail,'first output');
  const next=f.service.run({configId:'unit'});
  assert.equal(f.service.abort({expectedRunId:'run-1'}).aborted,false);
  assert.equal(f.service.getRunOutput('run-1').stdoutTail,'first output');
  assert.equal(f.service.abort({expectedRunId:'run-2'}).aborted,true);
  assert.equal(f.service.getActivityRuns().find(r=>r.runId==='run-2').state,'cancelling');
  f.finish({status:'aborted',stdoutTail:'second output'}); await next;
  assert.equal(f.history.getHistory('unit')[0].activity.scope.project_id,'project-a');
});
test('unconfirmed cleanup stays unresolved and observer failures do not derail execution', async()=>{
  const f=fixture(); f.service.subscribeActivity(()=>{throw new Error('observer');});
  const pending=f.service.run({configId:'unit'});
  f.finish({status:'aborted',terminationConfirmed:false}); await pending;
  const record=f.service.getActivityRuns()[0];
  assert.equal(record.cleanup,'unconfirmed'); assert.equal(record.state,'attention');
  assert.equal(f.service.getState().activeRun,'run-1');
});

test('successful cleanup retry updates durable history before a restart',async()=>{
 const f=fixture();const pending=f.service.run({configId:'unit'});
 f.finish({status:'aborted',terminationConfirmed:false,retryTermination:async()=>({confirmed:true})});await pending;
 const stopped=await f.service.abortAndWait({expectedRunId:'run-1'});
 assert.equal(stopped.terminationConfirmed,true);
 assert.equal(f.history.getHistory('unit')[0].terminationConfirmed,true);
});

test('failed cleanup retry returns to attention and permits another owner retry',async()=>{
 const f=fixture();const pending=f.service.run({configId:'unit'});
 f.finish({status:'timeout',terminationConfirmed:false,retryTermination:async()=>({confirmed:false})});await pending;
 const result=await f.service.abortAndWait({expectedRunId:'run-1'});assert.equal(result.terminationConfirmed,false);
 assert.equal(f.service.getActivityRuns()[0].state,'attention');
});

test('legacy Tests-panel Stop leaves a settled unconfirmed cleanup in attention and live',async()=>{
 const f=fixture();const pending=f.service.run({configId:'unit'});
 f.finish({status:'timeout',terminationConfirmed:false});await pending;
 assert.equal(f.service.abort().aborted,true);await new Promise(resolve=>setImmediate(resolve));
 const row=f.service.getActivityRuns()[0];
 assert.equal(row.state,'attention');assert.equal(row.live,true);
});
