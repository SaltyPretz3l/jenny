'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const { HostSessionManager }=require('../../../services/plugins/full-host/host-session-manager');
const { CrashQuarantineController }=require('../../../services/plugins/full-host/crash-quarantine-controller');
const { CleanupReconciler }=require('../../../services/plugins/full-host/cleanup-reconciler');
const { SessionProviderManager }=require('../../../services/plugins/full-host/session-provider-manager');
const { FullHostDiagnostics }=require('../../../services/plugins/full-host/diagnostics');
const authority={generation_id:'g',commit_epoch:1,revision:1,graph_hash:'a'.repeat(64)};

function fakeTimers(){
  const scheduled=[];
  return {
    scheduled,
    setTimeoutFn(callback,delay){const timer={callback,delay,cleared:false,unref(){}};scheduled.push(timer);return timer;},
    clearTimeoutFn(timer){if(timer)timer.cleared=true;},
  };
}
test('session acquisition deduplicates and retains accounting until tree death is proven',async()=>{
  let starts=0; const manager=new HostSessionManager({startSession:async()=>({ok:true,session:{id:`s${++starts}`}}),terminateSession:async()=>({known:true,terminated:false,tree_empty:false})});
  const [a,b]=await Promise.all([manager.acquire({authority,contributionId:'c'}),manager.acquire({authority,contributionId:'c'})]);
  assert.equal(a.session.id,b.session.id); assert.equal(starts,1); await manager.terminate({authority,contributionId:'c'}); assert.equal(manager.snapshot().active,1);
  await manager.dispose();
});
test('session limits are enforced per plugin and per contribution across generations',async()=>{
  const manager=new HostSessionManager({
    limits:{global:4,perPlugin:2,perContribution:1},
    startSession:async({contributionId})=>({ok:true,session:{id:contributionId}}),
    terminateSession:async()=>({terminated:true,tree_empty:true}),
  });
  const identity={publisher_id:'publisher',plugin_id:'plugin'};
  assert.equal((await manager.acquire({authority:{...authority,active_generation_id:'g1'},contributionId:'a',descriptor:identity})).ok,true);
  assert.equal((await manager.acquire({authority:{...authority,active_generation_id:'g2'},contributionId:'a',descriptor:identity})).reason,'host_session_contribution_limit');
  assert.equal((await manager.acquire({authority:{...authority,active_generation_id:'g2'},contributionId:'b',descriptor:identity})).ok,true);
  assert.equal((await manager.acquire({authority:{...authority,active_generation_id:'g3'},contributionId:'c',descriptor:identity})).reason,'host_session_plugin_limit');
  await manager.dispose();
});
test('pending launches reserve the global session ceiling',async()=>{
  const releases=[]; const manager=new HostSessionManager({limits:{global:2,perPlugin:2,perContribution:1},
    startSession:({contributionId})=>new Promise((resolve)=>releases.push(()=>resolve({ok:true,session:{id:contributionId}}))),
    terminateSession:async()=>({terminated:true,tree_empty:true})});
  const first=manager.acquire({authority,contributionId:'a',descriptor:{publisher_id:'p1',plugin_id:'one'}});
  const second=manager.acquire({authority,contributionId:'b',descriptor:{publisher_id:'p2',plugin_id:'two'}});
  assert.equal((await manager.acquire({authority,contributionId:'c',descriptor:{publisher_id:'p3',plugin_id:'three'}})).reason,'host_session_global_limit');
  releases.forEach((release)=>release()); await Promise.all([first,second]); await manager.dispose();
});
test('dispose terminates a session whose launch settles after shutdown begins',async()=>{
  let finishStart; const started=new Promise((resolve)=>{finishStart=resolve;}); const terminations=[];
  const manager=new HostSessionManager({
    startSession:async()=>started,
    terminateSession:async(session,reason)=>{terminations.push({session,reason});return {terminated:true,tree_empty:true};},
  });
  const pending=manager.acquire({authority,contributionId:'late'});
  const disposed=manager.dispose();
  finishStart({ok:true,session:{id:'late-session'}});
  assert.equal((await pending).reason,'session_manager_disposed');
  await disposed;
  assert.deepEqual(terminations.map(({reason})=>reason),['session_manager_disposed']);
  assert.deepEqual(manager.snapshot(),{active:0,pending:0,unusable:0});
});
test('unexpected child exit reaps and removes the exact owned session',async()=>{
  const manager=new HostSessionManager({
    startSession:async()=>({ok:true,session:{session_id:'session-crash'}}),
    terminateSession:async(_session,reason)=>({terminated:reason==='host_pipe_failed',tree_empty:true}),
  });
  await manager.acquire({authority,contributionId:'crash'});
  const result=await manager.handleUnexpectedExit('session-crash','host_pipe_failed');
  assert.equal(result.ok,true);assert.equal(result.session.contribution_id,'crash');
  assert.deepEqual(manager.snapshot(),{active:0,pending:0,unusable:0});
  await manager.dispose();
});
test('unexpected child exit never reuses a dead session while cleanup remains unproven',async()=>{
  let starts=0;let releaseTermination;let terminations=0;let invalidations=0;
  const manager=new HostSessionManager({
    startSession:async()=>({ok:true,session:{session_id:`session-${++starts}`}}),
    terminateSession:async()=>{terminations+=1;if(terminations===1){
      return new Promise((resolve)=>{releaseTermination=resolve;});
    }return {terminated:true,tree_empty:true};},
  });
  await manager.acquire({authority,contributionId:'crash'});
  const exiting=manager.handleUnexpectedExit('session-1','host_pipe_failed',async()=>{invalidations+=1;});
  assert.equal((await manager.acquire({authority,contributionId:'crash'})).reason,'host_session_cleanup_pending');
  assert.equal(manager.resolveSession('session-1').reason,'host_session_not_found');
  await new Promise((resolve)=>setImmediate(resolve));
  releaseTermination({terminated:false,tree_empty:false,reason:'tree_proof_unavailable'});
  assert.equal((await exiting).ok,false);assert.equal(invalidations,1);
  assert.deepEqual(manager.snapshot(),{active:1,pending:0,unusable:1});
  assert.equal((await manager.acquire({authority,contributionId:'crash'})).reason,'host_session_cleanup_pending');
  await manager.terminate({authority,contributionId:'crash'});
  assert.deepEqual(manager.snapshot(),{active:0,pending:0,unusable:0});
  const replacement=await manager.acquire({authority,contributionId:'crash'});
  assert.equal(replacement.ok,true);assert.equal(replacement.reused,false);assert.equal(starts,2);
  await manager.dispose();
});
test('plugin cleanup drains every owned session and returns a bounded proof',async()=>{
  const terminated=[]; const manager=new HostSessionManager({limits:{global:4,perPlugin:2,perContribution:1},
    startSession:async({contributionId})=>({ok:true,session:{session_id:`session-${contributionId}`}}),
    terminateSession:async(session,reason)=>{terminated.push([session.contribution_id,reason]);return {terminated:true,tree_empty:true};},
  });
  const descriptor={publisher_id:'p',plugin_id:'x'};
  await manager.acquire({authority,contributionId:'one',descriptor});
  await manager.acquire({authority,contributionId:'two',descriptor});
  assert.deepEqual(await manager.terminatePlugin('p','x'),{ok:true,status:'complete'});
  assert.deepEqual(terminated,[['one','plugin_uninstalled'],['two','plugin_uninstalled']]);
  assert.deepEqual(manager.snapshot(),{active:0,pending:0,unusable:0});
  await manager.dispose();
});
test('host activity refreshes idle eviction while the absolute lease remains hard',async()=>{
  const clock=fakeTimers();const reasons=[];let starts=0;
  const manager=new HostSessionManager({
    limits:{idleMs:300,absoluteMs:1000},setTimeoutFn:clock.setTimeoutFn,
    clearTimeoutFn:clock.clearTimeoutFn,
    startSession:async()=>({ok:true,session:{session_id:`session-${++starts}`,status:async()=>({ok:true})}}),
    terminateSession:async(_session,reason)=>{reasons.push(reason);return {terminated:true,tree_empty:true};},
  });
  const first=await manager.acquire({authority,contributionId:'active'});
  const firstIdle=clock.scheduled.find((timer)=>timer.delay===300);
  const firstAbsolute=clock.scheduled.find((timer)=>timer.delay===1000);
  await first.session.status({});
  const refreshedIdle=clock.scheduled.filter((timer)=>timer.delay===300).at(-1);
  assert.equal(firstIdle.cleared,true);assert.equal(firstAbsolute.cleared,false);
  refreshedIdle.callback();await new Promise((resolve)=>setImmediate(resolve));
  assert.deepEqual(reasons,['idle_eviction']);assert.equal(manager.snapshot().active,0);

  const second=await manager.acquire({authority,contributionId:'active'});
  const secondAbsolute=clock.scheduled.filter((timer)=>timer.delay===1000&&!timer.cleared).at(-1);
  await second.session.status({});
  secondAbsolute.callback();await new Promise((resolve)=>setImmediate(resolve));
  assert.deepEqual(reasons,['idle_eviction','absolute_lease_expired']);
  assert.equal(manager.snapshot().active,0);await manager.dispose();
});
test('crash quarantine, cleanup isolation, provider binding, and diagnostics remain bounded',async()=>{
  let now=0; const crash=new CrashQuarantineController({now:()=>now,limit:3,persist:async()=>{}}); const id={publisher_id:'p',plugin_id:'x',contribution_id:'c',executable_digest:'d'};
  await crash.recordCrash(id);now++;await crash.recordCrash(id);now++;assert.equal((await crash.recordCrash(id)).quarantined,true);
  const cleanup=new CleanupReconciler({reconcileReceipt:async(r)=>r.bad?Promise.reject(new Error()):({ok:true,terminated:true,tree_empty:true}),persistReceipt:async()=>{}}); assert.equal((await cleanup.reconcile([{bad:true},{}])).outcomes.length,2);
  const providers=new SessionProviderManager();
  const provider={publisher_id:'p',plugin_id:'x',contribution_id:'c'};
  assert.equal(providers.publish(authority,[provider]).ok,true);
  assert.equal(providers.resolve(authority,provider).ok,true);
  const diagnostics=new FullHostDiagnostics(); diagnostics.record('ERROR','failed',id,{secret:'no',reason:'bounded'}); assert.equal(diagnostics.snapshot().events[0].secret,undefined);
});

test('session providers use full plugin identity and reject ambiguous shorthand',()=>{
  const providers=new SessionProviderManager();
  const descriptors=[
    {publisher_id:'p',plugin_id:'one',contribution_id:'shared'},
    {publisher_id:'p',plugin_id:'two',contribution_id:'shared'},
  ];
  assert.equal(providers.publish(authority,descriptors).ok,true);
  assert.equal(providers.resolve(authority,{publisher_id:'p',plugin_id:'one',
    contribution_id:'shared'}).descriptor.plugin_id,'one');
  assert.equal(providers.resolve(authority,'shared').reason,'session_provider_ambiguous');
});

test('policy revision tombstones a pending launch and preserves unproven cleanup truth',async()=>{
  let current=true;let release;const unproven=[];
  const manager=new HostSessionManager({
    isAuthorityCurrent:()=>current,
    startSession:()=>new Promise((resolve)=>{release=resolve;}),
    terminateSession:async()=>({terminated:false,tree_empty:false,reason:'tree_proof_unavailable'}),
    onUnprovenTermination:async(record)=>unproven.push(record),
  });
  const pending=manager.acquire({authority,contributionId:'late',policyToken:{revision:1}});
  current=false;
  release({ok:true,session:{session_id:'late'}});
  assert.equal((await pending).reason,'managed_policy_revoked');
  assert.equal(unproven.length,1);
  assert.equal(unproven[0].reason,'managed_policy_revoked');
  assert.deepEqual(manager.snapshot(),{active:0,pending:0,unusable:1});
  await manager.dispose();
});
test('a proven pending-launch termination does not leave a permanent unusable marker',async()=>{
  let current=true;let release;
  const manager=new HostSessionManager({
    isAuthorityCurrent:()=>current,
    startSession:()=>new Promise((resolve)=>{release=resolve;}),
    terminateSession:async()=>({terminated:true,tree_empty:true}),
  });
  const pending=manager.acquire({authority,contributionId:'late',policyToken:{revision:1}});
  current=false;
  release({ok:true,session:{session_id:'late'}});
  assert.equal((await pending).reason,'managed_policy_revoked');
  assert.deepEqual(manager.snapshot(),{active:0,pending:0,unusable:0});
  await manager.dispose();
});
test('generation revocation tombstones and drains a pending launch before it can publish',async()=>{
  let release;const terminations=[];
  const manager=new HostSessionManager({
    startSession:()=>new Promise((resolve)=>{release=resolve;}),
    terminateSession:async(session,reason)=>{terminations.push([session.session_id,reason]);
      return {terminated:true,tree_empty:true};},
  });
  const stale={...authority,active_generation_id:'generation-a'};
  const pending=manager.acquire({authority:stale,contributionId:'late'});
  const revoking=manager.revokeGeneration('generation-a');
  assert.equal((await manager.acquire({authority:stale,contributionId:'other'})).reason,
    'generation_revoked');
  release({ok:true,session:{session_id:'late'}});
  assert.equal((await pending).reason,'generation_revoked');
  await revoking;
  assert.deepEqual(terminations,[['late','generation_revoked']]);
  assert.deepEqual(manager.snapshot(),{active:0,pending:0,unusable:0});
  await manager.dispose();
});
test('concurrent termination paths share one native termination result',async()=>{
  let release;let calls=0;const unproven=[];
  const manager=new HostSessionManager({
    startSession:async()=>({ok:true,session:{session_id:'session'}}),
    terminateSession:async()=>{calls+=1;return new Promise((resolve)=>{release=resolve;});},
    onUnprovenTermination:async(record)=>unproven.push(record),
  });
  const active={...authority,active_generation_id:'generation-concurrent'};
  await manager.acquire({authority:active,contributionId:'host'});
  const requested=manager.terminate({authority:active,contributionId:'host'});
  const revoked=manager.revokeGeneration(active.active_generation_id);
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(calls,1);
  release({terminated:true,tree_empty:true});
  const [termination,revocations]=await Promise.all([requested,revoked]);
  assert.deepEqual(termination,{terminated:true,tree_empty:true});
  assert.deepEqual(revocations,[{terminated:true,tree_empty:true}]);
  assert.deepEqual(unproven,[]);
  await manager.dispose();
});
