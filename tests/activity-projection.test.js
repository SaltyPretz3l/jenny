"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const {createActivityProjection} = require('../services/activity-projection');
function fixture() {
  let rows=[], listener, notices=[];
  const source={getActivityRuns:()=>rows,subscribeActivity:fn=>{listener=fn;return()=>{listener=null;};}};
  const projection=createActivityProjection({source,epoch:'epoch-a',enabled:()=>true,
    resolveScope:scope=>({scope,matches:row=>scope.kind==='all' || row.scope.project_id===scope.project_id}),
    notify:notice=>notices.push(notice)});
  return {projection,notices,set:next=>{rows=next;listener?.();},disposed:()=>!listener};
}
function row(runId,project='a') {return {runId,configId:'unit',label:'<img>\u202eunsafe',scope:{schema_version:1,project_id:project},sourceRevision:1,state:'running',cleanup:'pending',live:true,startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};}
const query={schema_version:1,scope:{kind:'all'}};
test('snapshot and scoped details share identity, gaps recover, old epochs fail closed',()=>{
 const f=fixture(); f.set([row('one'),row('two','b')]);
 const snapshot=f.projection.getSnapshot({...query,scope:{kind:'project',project_id:'a'}});
 assert.equal(snapshot.history_coverage,'observed_workspaces');assert.equal(snapshot.omitted_count,null);
 assert.equal(snapshot.items.length,1); assert.equal(snapshot.items[0].activity_id,'test:one');
 assert.equal(snapshot.items[0].label,'<img>unsafe');
 assert.equal(f.projection.getDetail({...query,scope:{kind:'project',project_id:'a'},epoch:'epoch-a',activity_id:'test:two'}).available,false);
 assert.equal(f.projection.getDetail({...query,epoch:'old',activity_id:'test:one'}).available,false);
 const recovered=f.projection.subscribe({...query,epoch:'old',after_revision:0});
 assert.equal(recovered.reset,true); assert.equal(recovered.items.length,2);
 assert.equal(f.projection.getSnapshot({...query,schema_version:99}).available,false);
 f.projection.dispose(); assert.equal(f.disposed(),true);
});
test('cleanup uncertainty keeps attention and never grants unrelated or terminal controls',()=>{
 const f=fixture(); f.set([{...row('one'),state:'attention',cleanup:'unconfirmed',outputAvailable:true}]);
 const detail=f.projection.getDetail({...query,epoch:'epoch-a',activity_id:'test:one'});
 assert.equal(detail.item.group,'attention'); assert.equal(detail.item.cleanup,'unconfirmed');
 assert.equal(detail.item.controls.stop,true); assert.equal(detail.item.controls.view_output,true);
 f.set([{...row('one'),state:'finished',cleanup:'unknown'}]);
 assert.equal(f.projection.getSnapshot(query).items[0].controls.stop,false);
 f.projection.dispose();
});
test('a restored unresolved row stays in attention without Stop or background reconciliation',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let reads=0;const rows=[{...row('old'),state:'attention',cleanup:'unconfirmed',live:false}];
 const projection=createActivityProjection({source:{getActivityRuns:()=>{reads++;return rows;},subscribeActivity:()=>()=>{}},
   enabled:()=>true,resolveScope:scope=>({scope,matches:()=>true})});
 const item=projection.getSnapshot(query).items[0];
 assert.equal(item.group,'attention'); assert.equal(item.controls.stop,false);
 const before=reads; t.mock.timers.tick(50000); assert.equal(reads,before);
 projection.dispose();
});

test('source failure invalidates existing subscribers and recovery advances revision',()=>{
 let fail=false,listener;const notices=[];
 const source={getActivityRuns:()=>{if(fail)throw Error('offline');return [row('one')];},subscribeActivity:fn=>{listener=fn;return()=>{};}};
 const projection=createActivityProjection({source,enabled:()=>true,resolveScope:scope=>({scope,matches:()=>true}),notify:n=>notices.push(n)});
 const first=projection.getSnapshot(query);fail=true;listener();
 assert.equal(notices.at(-1).revision,first.revision+1);
 assert.equal(projection.getSnapshot(query).reason,'source_unavailable');
 fail=false;listener();assert.equal(projection.getSnapshot(query).revision,first.revision+2);projection.dispose();
});
