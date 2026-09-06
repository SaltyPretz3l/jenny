'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createStage8ControlPlane}=require('../../services/plugins/stage8-control-plane');
const {buildFeatureFlagDefaults}=require('../../services/feature-flags');
test('privileged feature is independently default-off and cleanup remains available',async()=>{assert.equal(buildFeatureFlagDefaults({}).privileged_plugins,false);let cleanup=0;const plane=createStage8ControlPlane({enabled:false,cleanupReconciler:{reconcile:async()=>{cleanup++;return {ok:true};}}});assert.equal((await plane.acquireHost({})).reason,'privileged_plugins_disabled');assert.equal((await plane.cleanupOnly([])).ok,true);assert.equal(cleanup,1);});

test('a launched candidate is terminated when its descriptor is rejected',async()=>{
  const terminations=[]; const authority={active_generation_id:'generation-1',commit_epoch:1,
    registry_revision:1,dependency_graph_hash:'a'.repeat(64)};
  const content={publisher_id:'publisher',plugin_id:'plugin',contribution_id:'host',
    kind:'hook',artifact_digest:'b'.repeat(64),executable_digest:'c'.repeat(64),
    containment_profile_digest:'d'.repeat(64)};
  const plane=createStage8ControlPlane({enabled:true,sessionManager:{
    acquire:async()=>({ok:true,session:{describe:async()=>({ok:false})}}),
    terminate:async(request)=>{terminations.push(request);return {terminated:true,tree_empty:true};},
  }});
  const result=await plane.compile({authority,packages:[{entry:{publisher_id:'publisher',plugin_id:'plugin'},
    verdict:{manifest:{contributions:[{contribution_id:'host',content_sha256:'e'.repeat(64)}]},
      full_host_contents:[content]}}]});
  assert.equal(result.ok,true); assert.equal(result.expected_rejections.length,1);
  assert.deepEqual(terminations.map(({reason})=>reason),['descriptor_rejected']);
});

test('descriptor probes release the one-per-plugin lease before compiling the next contribution',async()=>{
  const authority={active_generation_id:'generation-1',commit_epoch:1,
    registry_revision:1,dependency_graph_hash:'a'.repeat(64)};
  const kinds=['native_mcp','engine_adapter']; let active=false; const terminations=[];
  const contents=kinds.map((kind,index)=>({publisher_id:'publisher',plugin_id:'plugin',
    contribution_id:`host_${index}`,kind,artifact_digest:'b'.repeat(64),
    executable_digest:'c'.repeat(64),containment_profile_digest:'d'.repeat(64)}));
  const plane=createStage8ControlPlane({enabled:true,sessionManager:{
    acquire:async({descriptor})=>{
      if(active)return {ok:false,reason:'host_session_plugin_limit'};
      active=true;
      return {ok:true,session:{describe:async()=>({ok:true,descriptor:{...descriptor,
        active_generation_id:authority.active_generation_id,commit_epoch:authority.commit_epoch,
        binding_digest:'f'.repeat(64),...(descriptor.kind==='native_mcp'?{
          binding_schema_version:6,server_id:'server',tools:[]}:{adapter_schema_version:6,
          adapter_id:'adapter',supports_streaming:true,supports_cancellation:true,
          max_input_bytes:1024,max_stream_bytes:4096})}})}};
    },
    terminate:async(request)=>{active=false;terminations.push(request);return {terminated:true,tree_empty:true};},
  }});
  const result=await plane.compile({authority,packages:[{entry:{publisher_id:'publisher',plugin_id:'plugin'},
    verdict:{manifest:{contributions:contents.map((content)=>({contribution_id:content.contribution_id,
      content_sha256:'e'.repeat(64)}))},full_host_contents:contents}}]});
  assert.equal(result.ok,true); assert.equal(result.expected_rejections.length,0);
  assert.deepEqual(result.started_contributions,['host_0','host_1']);
  assert.deepEqual(terminations.map(({reason})=>reason),
    ['descriptor_probe_complete','descriptor_probe_complete']);
});

test('successful generation publication revokes the prior full-host generation',async()=>{
  const revoked=[];const cancelled=[]; const runtimeCoordinator={
    prepare:async()=>({ok:true,commit:async()=>({ok:true})}),getState:()=>({}),
  };
  const plane=createStage8ControlPlane({enabled:true,runtimeCoordinator,
    sessionManager:{revokeGeneration:async(id)=>{revoked.push(id);},snapshot:()=>({active:0,pending:0})},
    engineBroker:{cancelAll:async(reason)=>{cancelled.push(reason);return {ok:true};}},
    nativeMcpRegistry:{publish:()=>({ok:true})},sessionProviders:{publish:()=>({ok:true})}});
  const compiled=(id,epoch)=>({snapshot:{active_generation_id:id,commit_epoch:epoch,
    registry_revision:epoch,dependency_graph_hash:'a'.repeat(64)},privileged:{}});
  const first=await plane.runtimeCoordinator.prepare({compiled:compiled('generation-1',1)});
  assert.equal((await first.commit()).ok,true);
  const second=await plane.runtimeCoordinator.prepare({compiled:compiled('generation-2',2)});
  assert.equal((await second.commit()).ok,true);
  assert.deepEqual(revoked,['generation-1']);
  assert.deepEqual(cancelled,['generation_changed']);
});

test('an unusable crashed host reports termination failure instead of ready',()=>{
  const plane=createStage8ControlPlane({enabled:true,
    sessionManager:{snapshot:()=>({active:1,pending:0,unusable:1})},
    cleanupReconciler:{state:()=>({cleanup_status:'not_required'})},
    runtimeCoordinator:{getState:()=>({})}});
  const state=plane.runtimeCoordinator.getState();
  assert.equal(state.privileged_runtime_status,'termination_failed');
  assert.equal(state.privileged_cleanup_status,'termination_failed');
  assert.deepEqual(state.host_sessions,{active:1,pending:0,unusable:1});
});

test('prior committed compilation reuses the published privileged snapshot without relaunching code',async()=>{
  const authority={active_generation_id:'generation-1',commit_epoch:1,
    registry_revision:1,dependency_graph_hash:'a'.repeat(64)};
  let acquires=0;
  const runtimeCoordinator={prepare:async()=>({ok:true,commit:async()=>({ok:true})}),getState:()=>({})};
  const plane=createStage8ControlPlane({enabled:true,runtimeCoordinator,sessionManager:{
    acquire:async()=>{acquires++;return {ok:false};},snapshot:()=>({active:0,pending:0}),
    revokeGeneration:async()=>({ok:true}),
  }});
  const privileged={native_descriptors:[],session_provider_descriptors:[],
    engine_descriptors:[],active_hook_descriptors:[],marker:'published'};
  const prepared=await plane.runtimeCoordinator.prepare({compiled:{snapshot:{
    active_generation_id:authority.active_generation_id,commit_epoch:authority.commit_epoch,
    registry_revision:authority.registry_revision,dependency_graph_hash:authority.dependency_graph_hash,
  },privileged}});
  assert.equal((await prepared.commit()).ok,true);
  const compiled=await plane.compile({phase:'prior_committed',authority,packages:[{}]});
  assert.equal(compiled.ok,true);
  assert.equal(compiled.marker,'published');
  assert.equal(acquires,0);
});

test('managed denial compiles privilege-empty and revokes every live Stage 8 route',async()=>{
  let revision=1;let allowed=false;const calls=[];
  const managedPolicy={capture:()=>({revision,policy_digest:`${revision}`.padStart(64,'0')}),
    isCurrent:(token)=>token?.revision===revision,
    guard:(token)=>token&&token.revision!==revision?{ok:false,reason:'managed_policy_authority_stale'}
      :(allowed?{ok:true}:{ok:false,reason:'managed_policy_privileged_denied'})};
  const plane=createStage8ControlPlane({enabled:true,managedPolicy,
    sessionManager:{acquire:async()=>{calls.push('acquire');return {ok:false};},
      revokeAll:async()=>{calls.push('sessions');return {ok:true,status:'complete'};},snapshot:()=>({})},
    nativeMcpRegistry:{clear:()=>calls.push('native')},sessionProviders:{clear:()=>calls.push('providers')},
    engineBroker:{cancelAll:async()=>{calls.push('engines');return {ok:true};}},
    hookDispatcher:{revokeAll:async()=>{calls.push('hooks');return {ok:true};}},
    secretDelivery:{revokeAll:async()=>{calls.push('secrets');return {ok:true};}},
    consent:{cancel:()=>calls.push('consent')}});
  const compiled=await plane.compile({authority:{},packages:[{verdict:{full_host_contents:[{}]}}]});
  assert.equal(compiled.ok,true);assert.deepEqual(compiled.full_host_descriptors,[]);
  assert.equal(calls.includes('acquire'),false);
  revision=2;await plane.applyManagedPolicy();
  assert.deepEqual(new Set(calls),new Set(['native','providers','engines','hooks','secrets','sessions','consent']));
  assert.equal((await plane.acquireHost({})).reason,'managed_policy_privileged_denied');
});

test('a policy change tombstones old authority even after policy allows again',async()=>{
  let revision=1;let acquires=0;let deliveries=0;const authority={active_generation_id:'generation-1',
    commit_epoch:1,registry_revision:1,dependency_graph_hash:'a'.repeat(64)};
  const managedPolicy={capture:()=>({revision,policy_digest:`${revision}`.padStart(64,'0')}),
    isCurrent:(token)=>token?.revision===revision,
    guard:(token)=>token&&token.revision!==revision?{ok:false,reason:'managed_policy_authority_stale'}:{ok:true}};
  const runtimeCoordinator={prepare:async()=>({ok:true,commit:async()=>({ok:true})}),getState:()=>({})};
  const plane=createStage8ControlPlane({enabled:true,managedPolicy,runtimeCoordinator,
    sessionManager:{acquire:async()=>{acquires+=1;return {ok:true};},revokeGeneration:async()=>({ok:true}),
      revokeAll:async()=>({ok:true,status:'complete'}),snapshot:()=>({})},
    nativeMcpRegistry:{publish:()=>({ok:true}),clear:()=>{}},
    sessionProviders:{publish:()=>({ok:true}),clear:()=>{}},
    secretDelivery:{consumeAndDeliver:async()=>{deliveries+=1;return {ok:true};},revokeAll:async()=>({ok:true})}});
  const prepared=await plane.runtimeCoordinator.prepare({compiled:{snapshot:authority,privileged:{}}});
  assert.equal((await prepared.commit()).ok,true);
  assert.equal((await plane.acquireHost({authority})).ok,true);
  assert.equal((await plane.acquireHost({authority:{...authority,registry_revision:2}})).reason,
    'privileged_runtime_unavailable');
  revision=2;await plane.applyManagedPolicy();revision=3;await plane.applyManagedPolicy();
  assert.equal((await plane.acquireHost({authority})).reason,'privileged_runtime_unavailable');
  assert.equal((await plane.consumeSecretDelivery({binding:{active_generation_id:'generation-1',
    commit_epoch:1}})).reason,'privileged_runtime_unavailable');
  assert.equal(acquires,1);assert.equal(deliveries,0);
});

test('secret consent authority uses the V6 generation_id shape and policy revision fencing',async()=>{
  let revision=1;let preparedGrant=null;
  const authority={active_generation_id:'generation-1',commit_epoch:1,
    registry_revision:1,dependency_graph_hash:'a'.repeat(64)};
  const managedPolicy={capture:()=>({revision,policy_digest:`${revision}`.padStart(64,'0')}),
    isCurrent:(token)=>token?.revision===revision,
    guard:(token)=>token?.revision===revision?{ok:true}:{ok:false,reason:'managed_policy_authority_stale'}};
  const plane=createStage8ControlPlane({enabled:true,managedPolicy,
    runtimeCoordinator:{prepare:async()=>({ok:true,commit:async()=>({ok:true})}),getState:()=>({})},
    sessionManager:{snapshot:()=>({}),revokeGeneration:async()=>({ok:true})},
    nativeMcpRegistry:{publish:()=>({ok:true})},sessionProviders:{publish:()=>({ok:true})},
    consent:{request:async()=>({ok:true,receipt_id:'receipt'}),consume:()=>({ok:true})},
    secretDelivery:{prepare:async(grant)=>{preparedGrant=grant;return {ok:true};}}});
  const commit=await plane.runtimeCoordinator.prepare({compiled:{snapshot:authority,privileged:{}}});
  assert.equal((await commit.commit()).ok,true);
  const canonical={authority:{generation_id:'generation-1',commit_epoch:1}};
  assert.equal((await plane.requestSecretDelivery({canonical,grant:{grant_id:'grant'}})).ok,true);
  assert.equal(preparedGrant.approval_id,'receipt');
  revision=2;
  assert.equal((await plane.requestSecretDelivery({canonical,grant:{}})).reason,
    'managed_policy_authority_stale');
});

test('engine starts require the exact current four-field authority',async()=>{
  const starts=[];const authority={active_generation_id:'generation-1',commit_epoch:1,
    registry_revision:7,dependency_graph_hash:'a'.repeat(64)};
  const plane=createStage8ControlPlane({enabled:true,
    runtimeCoordinator:{prepare:async()=>({ok:true,commit:async()=>({ok:true})}),getState:()=>({})},
    sessionManager:{snapshot:()=>({}),revokeGeneration:async()=>({ok:true})},
    nativeMcpRegistry:{publish:()=>({ok:true})},sessionProviders:{publish:()=>({ok:true})},
    engineBroker:{start:(request)=>{starts.push(request);return {ok:true};}}});
  const prepared=await plane.runtimeCoordinator.prepare({compiled:{snapshot:authority,privileged:{
    engine_descriptors:[{adapter_id:'adapter'}],
  }}});
  assert.equal((await prepared.commit()).ok,true);
  assert.equal(plane.invokeEngine({adapterId:'adapter',authority}).ok,true);
  assert.equal(plane.engineStream.start({adapter_id:'adapter',authority}).ok,true);
  for(const field of ['active_generation_id','commit_epoch','registry_revision','dependency_graph_hash']){
    const stale={...authority,[field]:field==='dependency_graph_hash'?'b'.repeat(64):
      (field==='active_generation_id'?'generation-old':authority[field]+1)};
    assert.equal(plane.engineStream.start({adapter_id:'adapter',authority:stale}).reason,
      'privileged_runtime_unavailable');
  }
  assert.equal(starts.length,2);
});

test('managed revocation reports rejected session cleanup as termination_failed',async()=>{
  const logs=[];
  const plane=createStage8ControlPlane({enabled:true,
    sessionManager:{revokeAll:async()=>{throw new Error('termination failed');},snapshot:()=>({})},
    log:(level,event,details)=>logs.push({level,event,details})});
  const result=await plane.applyManagedPolicy();
  assert.deepEqual(result,{ok:false,cleanup_status:'termination_failed'});
  assert.equal(logs.at(-1).level,'WARN');
  assert.equal(logs.at(-1).details.cleanup_status,'termination_failed');
});
