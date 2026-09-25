'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const crypto=require('node:crypto'); const { EventEmitter }=require('node:events');
const { PassThrough }=require('node:stream');
const { digest,FullHostProcessSupervisor }=require('../../../services/plugins/full-host/process-supervisor');
const { NativeSupervisorClient,responseAuthMessage }=require('../../../services/plugins/full-host/native-supervisor-client');
const { createHostResourceAdmission }=require('../../../services/plugins/full-host/host-resource-admission');
const { ResourceBroker }=require('../../../services/session-runtime/resource-broker');

function hostResources(limit=1){
  let id=0;const broker=new ResourceBroker({limits:{native_processes:limit},
    createId:()=>`host-lease-${++id}`});
  return {broker,resources:createHostResourceAdmission({
    resourceAdmissionProvider:()=>({broker}),
  })};
}

function responsiveChild({terminateProof={known:true,reaped:true,tree_empty:true,
  output_readers_terminated:false},closeOnKill=true}={}){
  const stdin=new PassThrough();const stdout=new PassThrough();const stderr=new PassThrough();
  const secret=new PassThrough();const child=new EventEmitter();let key;
  Object.assign(child,{stdin,stdout,stderr,stdio:[stdin,stdout,stderr,secret],exitCode:null,
    kill(){if(this.exitCode!==null)return;this.exitCode=0;if(closeOnKill){
      for(const stream of this.stdio)stream.destroy();
      queueMicrotask(()=>{child.emit('exit',0);child.emit('close',0);});
    }return true;}});
  stdin.on('data',(chunk)=>{
    for(const line of chunk.toString('utf8').trim().split('\n')){
      if(!line)continue;const request=JSON.parse(line);
      if(request.auth_key)key=Buffer.from(request.auth_key,'hex');
      let result={};
      if(request.operation==='handshake')result={protocol_version:1};
      if(request.operation==='capabilities')result={capabilities:[]};
      if(request.operation==='start')result={receipt_id:'receipt'};
      if(request.operation==='terminate')result=terminateProof;
      if(request.operation==='acknowledge_termination')result={acknowledged:true};
      const response={direction:'supervisor_to_electron',sequence:request.sequence,
        request_id:request.request_id,ok:true,reason:null,result};
      response.auth_tag=crypto.createHmac('sha256',key)
        .update(responseAuthMessage(response),'utf8').digest('hex');
      stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  queueMicrotask(()=>child.emit('spawn'));
  return child;
}
test('supervisor rejects mismatched launch attestation and terminates the session', async()=>{
  let terminated=false;
  const nativeClient={capabilities:async()=>({capabilities:['suspended_launch','identity_locked_image','job_kill_on_close','tree_empty_proof','hard_process_limit','hard_memory_limit','hard_cpu_limit']}),start:async()=>({ok:true,receipt:{observed_executable_digest:'b'.repeat(64),session_id:'s',session_epoch:1}}),terminate:async()=>{terminated=true;return {ok:true};}};
  const supervisor=new FullHostProcessSupervisor({nativeClient,platform:'win32'});
  const result=await supervisor.start({authority:{registry_revision:1,dependency_graph_hash:'c'.repeat(64),commit_epoch:1,active_generation_id:'gen-1'},identity:{publisher_id:'acme',plugin_id:'plug',contribution_id:'host',artifact_digest:'d'.repeat(64)},executable:{digest:'a'.repeat(64),path:'x'},sessionId:'s',sessionEpoch:1});
  assert.equal(result.reason,'launch_attestation_rejected'); assert.equal(terminated,true);
});
test('supervisor accepts only a full authority-bound V6 launch attestation',async()=>{
  const capabilities=['suspended_launch','identity_locked_image','job_kill_on_close','tree_empty_proof','hard_process_limit','hard_memory_limit','hard_cpu_limit'];
  const authority={registry_revision:2,dependency_graph_hash:'c'.repeat(64),commit_epoch:3,active_generation_id:'gen-3'};
  const identity={publisher_id:'acme',plugin_id:'plug',contribution_id:'host',artifact_digest:'d'.repeat(64)};
  const nativeClient={capabilities:async()=>({capabilities}),start:async(request)=>{const context=JSON.parse(request.launch_context_json);return {ok:true,receipt:{attestation_schema_version:6,receipt_id:'receipt-1',...identity,executable_digest:'a'.repeat(64),observed_executable_digest:'a'.repeat(64),...authority,process_instance_id:'process-1',session_id:'session-1',session_epoch:4,launch_nonce_digest:context.launch_nonce_digest,containment_profile:'windows_job_supervised_v1',containment_capabilities_digest:digest(JSON.stringify([...capabilities].sort())),peer_identity_digest:'e'.repeat(64),created_at:context.created_at},channel:{}};},terminate:async()=>({ok:true})};
  const supervisor=new FullHostProcessSupervisor({nativeClient,platform:'win32',now:()=> '2026-08-09T00:00:00Z'});
  const result=await supervisor.start({authority,identity,executable:{digest:'a'.repeat(64),path:'x'},sessionId:'session-1',sessionEpoch:4});
  assert.equal(result.ok,true);assert.equal(result.receipt.active_generation_id,'gen-3');
});
test('official image workloads pass a signed profile to the native supervisor without changing default limits',async()=>{
  const capabilities=['suspended_launch','identity_locked_image','job_kill_on_close','tree_empty_proof','hard_process_limit','hard_memory_limit','hard_cpu_limit'];
  const authority={registry_revision:2,dependency_graph_hash:'c'.repeat(64),commit_epoch:3,active_generation_id:'gen-3'};
  const identity={publisher_id:'jenny-official',plugin_id:'local-image-generation',
    publisher_key_id:'7ed60652328f0fbbdb7417c97a9fbd4f2f54ef223af774e9d83ddf213a1291f5',
    contribution_id:'local_image_generation',artifact_digest:'d'.repeat(64)};
  let workload;
  const nativeClient={capabilities:async()=>({capabilities}),start:async(request)=>{
    const context=JSON.parse(request.launch_context_json);workload=JSON.parse(request.workload_profile_json);
    return {ok:true,receipt:{attestation_schema_version:6,receipt_id:'receipt-1',
      publisher_id:identity.publisher_id,plugin_id:identity.plugin_id,
      contribution_id:identity.contribution_id,artifact_digest:identity.artifact_digest,
      executable_digest:'a'.repeat(64),observed_executable_digest:'a'.repeat(64),...authority,
      process_instance_id:'process-1',session_id:'session-1',session_epoch:4,
      launch_nonce_digest:context.launch_nonce_digest,containment_profile:'windows_job_supervised_v1',
      containment_capabilities_digest:digest(JSON.stringify([...capabilities].sort())),
      peer_identity_digest:'e'.repeat(64),created_at:context.created_at},channel:{}};
  },terminate:async()=>({ok:true})};
  const supervisor=new FullHostProcessSupervisor({nativeClient,platform:'win32',architecture:'x64',
    now:()=> '2026-08-09T00:00:00Z'});
  const result=await supervisor.start({authority,identity,executable:{digest:'a'.repeat(64),path:'x'},
    sessionId:'session-1',sessionEpoch:4});
  assert.equal(result.ok,true);assert.equal(result.workload_profile.profile_id,'gpu_image_v1');
  assert.equal(workload.profile_id,'gpu_image_v1');assert.equal(workload.active_process_limit,192);
});
test('direct secret bytes use only the dedicated inherited pipe',async()=>{
  const sentinel='stage8-secret-sentinel'; const stdin=new PassThrough(); const stdout=new PassThrough();
  const stderr=new PassThrough(); const secretPipe=new PassThrough(); const child=new EventEmitter();
  Object.assign(child,{stdin,stdout,stderr,stdio:[stdin,stdout,stderr,secretPipe],exitCode:null,
    kill:()=>{child.exitCode=0;}});
  let key; let normalFrames=''; const secretFrames=[];
  secretPipe.on('data',(chunk)=>secretFrames.push(Buffer.from(chunk)));
  stdin.on('data',(chunk)=>{
    normalFrames+=chunk.toString('utf8');
    for(const line of chunk.toString('utf8').trim().split('\n')){
      if(!line)continue; const request=JSON.parse(line); if(request.auth_key)key=Buffer.from(request.auth_key,'hex');
      const response={direction:'supervisor_to_electron',sequence:request.sequence,
        request_id:request.request_id,ok:true,reason:null,result:request.operation==='handshake'
          ?{protocol_version:1}:{status:'ok',payload_json:JSON.stringify({ok:true,receipt_id:'secret-receipt'})}};
      response.auth_tag=crypto.createHmac('sha256',key).update(responseAuthMessage(response),'utf8').digest('hex');
      stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  const client=new NativeSupervisorClient({executablePath:'supervisor.exe',spawn:()=>child,timeoutMs:1000});
  const receipt=await client.deliverSecret({session_id:'session',session_epoch:2,grant_id:'grant',secret:sentinel});
  assert.deepEqual(receipt,{ok:true,receipt_id:'secret-receipt'});
  assert.equal(normalFrames.includes(sentinel),false);
  const dedicated=Buffer.concat(secretFrames); assert.equal(dedicated.readUInt32BE(0),Buffer.byteLength(sentinel));
  assert.equal(dedicated.subarray(4).toString('utf8'),sentinel);
  await client.dispose();
});
test('an individual host transport failure is reported once with session identity',async()=>{
  const exits=[];const client=new NativeSupervisorClient({executablePath:'supervisor.exe',
    onHostExit:async(event)=>{exits.push(event);}});
  client._request=async(request)=>{
    if(request.operation==='start')return {receipt_id:'receipt'};
    throw new Error('host_pipe_failed');
  };
  const started=await client.start({session_id:'session-crash',session_epoch:7});
  await assert.rejects(started.channel.request('engine_stream',{}),/host_pipe_failed/);
  await assert.rejects(started.channel.request('engine_stream',{}),/host_pipe_failed/);
  assert.deepEqual(exits,[{session_id:'session-crash',session_epoch:7,reason:'host_pipe_failed'}]);
  await client.dispose();
});
test('an unsupported handshake poisons the client before later requests',async()=>{
  const stdin=new PassThrough();const stdout=new PassThrough();const stderr=new PassThrough();
  const secret=new PassThrough();const child=new EventEmitter();const operations=[];
  Object.assign(child,{stdin,stdout,stderr,stdio:[stdin,stdout,stderr,secret],exitCode:null,
    kill(){this.exitCode=0;}});
  let key;
  stdin.on('data',(chunk)=>{
    for(const line of chunk.toString('utf8').trim().split('\n')){
      const request=JSON.parse(line);operations.push(request.operation);
      if(request.auth_key)key=Buffer.from(request.auth_key,'hex');
      const response={direction:'supervisor_to_electron',sequence:request.sequence,
        request_id:request.request_id,ok:true,reason:null,result:request.operation==='handshake'
          ?{protocol_version:2}:{capabilities:['old_helper_used']}};
      response.auth_tag=crypto.createHmac('sha256',key)
        .update(responseAuthMessage(response),'utf8').digest('hex');
      stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  const client=new NativeSupervisorClient({executablePath:'old.exe',spawn:()=>child});
  assert.deepEqual(await client.capabilities(),{capabilities:[]});
  for(const stream of child.stdio)stream.destroy();
  child.emit('close',0);
  assert.deepEqual(await client.capabilities(),{capabilities:[]});
  assert.deepEqual(operations,['handshake']);assert.equal(client._poisoned,true);
  await client.dispose();
});
test('cancellation during capability discovery prevents native launch',async()=>{
  let release;let starts=0;
  const nativeClient={
    capabilities:()=>new Promise((resolve)=>{release=resolve;}),
    start:async()=>{starts+=1;return {ok:false};},
    terminate:async()=>({ok:true}),
  };
  const supervisor=new FullHostProcessSupervisor({nativeClient,platform:'win32'});
  const controller=new AbortController();
  const pending=supervisor.start({authority:{},identity:{},executable:{},sessionId:'session',
    sessionEpoch:1,signal:controller.signal});
  controller.abort();
  release({capabilities:['suspended_launch','identity_locked_image','job_kill_on_close',
    'tree_empty_proof','hard_process_limit','hard_memory_limit','hard_cpu_limit']});
  const result=await pending;
  assert.equal(result.reason,'supervisor_unavailable');assert.equal(starts,0);
  let requests=0;
  const client=new NativeSupervisorClient({executablePath:'unused.exe'});
  client._request=async()=>{requests+=1;return {};};
  assert.deepEqual(await client.start({}, {signal:controller.signal}),
    {ok:false,reason:'supervisor_unavailable'});
  assert.equal(requests,0);await client.dispose();
});

test('old supervisor cleanup proof quarantines an admitted native-host lease',async()=>{
  const setup=hostResources();
  const admitted=setup.resources.tryStart({sessionId:'old-binary',sessionEpoch:1,
    identity:{publisher_id:'p',plugin_id:'x',contribution_id:'host'},validate:()=>true});
  setup.resources.markAttempted(admitted.handle);
  let complete=false;
  const supervisor=new FullHostProcessSupervisor({hostResources:setup.resources,nativeClient:{
    terminate:async()=>({ok:true,reaped:true,tree_empty:true,
      ...(complete?{output_readers_terminated:true}:{})}),
  }});
  const uncertain=await supervisor.terminate({session_id:'old-binary',session_epoch:1});
  assert.equal(uncertain.resource_cleanup.cleanup,'uncertain');
  assert.equal(setup.broker.snapshot().quarantined_count,1);
  complete=true;
  const confirmed=await supervisor.terminate({session_id:'old-binary',session_epoch:1});
  assert.equal(confirmed.resource_cleanup.cleanup,'confirmed');
  assert.equal(setup.broker.snapshot().lease_count,0);
});

test('a thrown native start returns exact identity and quarantines without full cleanup proof',async()=>{
  const setup=hostResources();
  const capabilities=['suspended_launch','identity_locked_image','job_kill_on_close',
    'tree_empty_proof','hard_process_limit','hard_memory_limit','hard_cpu_limit'];
  const supervisor=new FullHostProcessSupervisor({hostResources:setup.resources,platform:'win32',
    nativeClient:{capabilities:async()=>({capabilities}),start:async()=>{throw new Error('lost');},
      terminate:async()=>({ok:false,reason:'supervisor_request_timeout'})}});
  const result=await supervisor.start({authority:{},identity:{publisher_id:'p',plugin_id:'x',
    contribution_id:'host'},executable:{path:'x',digest:'a'.repeat(64)},
    sessionId:'start-lost',sessionEpoch:3,validateResourceAuthority:()=>true});
  assert.equal(result.ok,false);assert.equal(result.session_id,'start-lost');
  assert.equal(result.session_epoch,3);assert.equal(result.resource_cleanup.cleanup,'uncertain');
  assert.equal(setup.broker.snapshot().quarantined_count,1);
});

test('concurrent capability discovery starts one admitted helper and leaves one host slot',async()=>{
  const setup=hostResources(2);let spawns=0;let child;
  const client=new NativeSupervisorClient({executablePath:'supervisor.exe',
    hostResources:setup.resources,spawn:()=>{spawns+=1;child=responsiveChild();return child;}});
  const [first,second]=await Promise.all([client.capabilities(),client.capabilities()]);
  assert.deepEqual(first,{capabilities:[]});assert.deepEqual(second,{capabilities:[]});
  assert.equal(spawns,1);assert.equal(setup.broker.snapshot().capacity.native_processes,1);
  const host=setup.resources.tryStart({sessionId:'host',sessionEpoch:1,
    identity:{publisher_id:'p',plugin_id:'x',contribution_id:'host'},validate:()=>true});
  assert.equal(host.ok,true);
  assert.equal(setup.resources.tryStart({sessionId:'blocked',sessionEpoch:1,
    identity:{publisher_id:'p2',plugin_id:'x2',contribution_id:'host'},
    validate:()=>true}).reason,'native_host_resource_capacity');
  assert.equal(setup.broker.snapshot().waiter_count,0);
  await client.dispose();
  assert.equal(setup.broker.snapshot().lease_count,1);
});

test('helper timeout quarantines capacity until process and all streams close',async()=>{
  const setup=hostResources(2);const child=responsiveChild({closeOnKill:false});
  child.stdin.removeAllListeners('data');
  const client=new NativeSupervisorClient({executablePath:'supervisor.exe',
    hostResources:setup.resources,spawn:()=>child,timeoutMs:10,cleanupTimeoutMs:5});
  assert.deepEqual(await client.capabilities(),{capabilities:[]});
  assert.equal(setup.broker.snapshot().quarantined_count,1);
  for(const stream of child.stdio)stream.destroy();
  child.exitCode=1;child.emit('close',1);
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(setup.broker.snapshot().lease_count,0);
  await client.dispose();
});

test('synchronous dispose after spawn returns retains helper capacity until actual close',async()=>{
  const setup=hostResources(2);const child=responsiveChild({closeOnKill:false});
  child.pid=4242;
  const client=new NativeSupervisorClient({executablePath:'supervisor.exe',
    hostResources:setup.resources,spawn:()=>child,cleanupTimeoutMs:5});
  const pending=client.capabilities();const disposing=client.dispose();
  assert.equal(setup.broker.snapshot().lease_count,1);
  assert.equal(setup.broker.snapshot().quarantined_count,1);
  for(const stream of child.stdio)stream.destroy();
  child.emit('close',0);
  await Promise.all([pending,disposing]);
  assert.equal(setup.broker.snapshot().lease_count,0);
});

test('idle helper quiescence releases its slot and reopens with a lazy replacement',async()=>{
  const setup=hostResources(2);let spawns=0;
  const client=new NativeSupervisorClient({executablePath:'supervisor.exe',hostResources:setup.resources,
    spawn:()=>{spawns+=1;return responsiveChild();}});
  await client.capabilities();
  assert.equal(setup.broker.snapshot().lease_count,1);
  assert.equal((await client.quiesce()).ok,true);
  assert.equal(setup.broker.snapshot().lease_count,0);
  assert.deepEqual(client.reopenAfterQuiesce(),{ok:true});
  await client.capabilities();
  assert.equal(spawns,2);assert.equal(setup.broker.snapshot().lease_count,1);
  await client.dispose();
  assert.equal(setup.broker.snapshot().lease_count,0);
});

test('helper quiescence retains quarantine until child and every stream close',async()=>{
  const setup=hostResources(2);const child=responsiveChild({closeOnKill:false});let spawns=0;
  const client=new NativeSupervisorClient({executablePath:'supervisor.exe',hostResources:setup.resources,
    spawn:()=>{spawns+=1;return spawns===1?child:responsiveChild();},cleanupTimeoutMs:5});
  await client.capabilities();
  const quiesced=await client.quiesce();
  assert.equal(quiesced.ok,false);assert.equal(setup.broker.snapshot().quarantined_count,1);
  assert.equal(client.reopenAfterQuiesce().ok,false);
  child.exitCode=0;child.emit('exit',0);child.emit('close',0);
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(setup.broker.snapshot().lease_count,0);
  assert.deepEqual(client.reopenAfterQuiesce(),{ok:true});
  await client.capabilities();
  assert.equal(spawns,2);assert.equal(setup.broker.snapshot().lease_count,1);
  await client.dispose();
});

test('helper close does not prove cleanup while the dedicated channel remains open',async()=>{
  const setup=hostResources(2);const child=responsiveChild({closeOnKill:false});
  const client=new NativeSupervisorClient({executablePath:'supervisor.exe',
    hostResources:setup.resources,spawn:()=>child});
  await client.capabilities();
  const closeSecret=child.stdio[3].destroy.bind(child.stdio[3]);
  child.stdio[3].destroy=()=>child.stdio[3];
  child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
  child.exitCode=0;child.emit('exit',0);child.emit('close',0);
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(setup.broker.snapshot().quarantined_count,1);
  closeSecret();
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(setup.broker.snapshot().lease_count,0);
  await client.dispose();
});

test('replacement helper uses exact prior-supervisor death to finish reader proof',async()=>{
  const setup=hostResources(2);
  const host=setup.resources.tryStart({sessionId:'lost-host',sessionEpoch:4,
    identity:{publisher_id:'p',plugin_id:'x',contribution_id:'host'},validate:()=>true});
  setup.resources.markAttempted(host.handle);
  let child=responsiveChild();let spawns=0;const exits=[];
  const client=new NativeSupervisorClient({executablePath:'supervisor.exe',
    hostResources:setup.resources,spawn:()=>{spawns+=1;return child;},
    onExit:(event)=>exits.push(event)});
  assert.equal((await client.start({session_id:'lost-host',session_epoch:4})).ok,true);
  setup.resources.quarantine(host.handle,'supervisor_lost');
  for(const stream of child.stdio)stream.destroy();
  child.exitCode=1;child.emit('exit',1);child.emit('close',1);
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(exits[0].sessions[0].session_id,'lost-host');
  assert.equal(setup.broker.snapshot().lease_count,1,'helper close does not release host ownership');

  child=responsiveChild();
  const proof=await client.terminate({session_id:'lost-host',session_epoch:4});
  assert.equal(spawns,2);assert.equal(proof.previous_supervisor_terminated,true);
  assert.equal(proof.output_readers_terminated,true);
  const cleanup=setup.resources.settleTermination({sessionId:'lost-host',sessionEpoch:4,proof});
  assert.equal(cleanup.cleanup,'confirmed');
  await client.dispose();
  assert.equal(setup.broker.snapshot().lease_count,0);
});

test('a synchronous helper spawn throw releases its admission as no-start',async()=>{
  const setup=hostResources(2);
  const client=new NativeSupervisorClient({executablePath:'supervisor.exe',
    hostResources:setup.resources,spawn:()=>{throw new Error('spawn failed');}});
  assert.deepEqual(await client.capabilities(),{capabilities:[]});
  assert.equal(setup.broker.snapshot().lease_count,0);
  await client.dispose();
});

test('an invalid spawned helper contract quarantines native capacity',async()=>{
  const setup=hostResources(2);
  const client=new NativeSupervisorClient({executablePath:'supervisor.exe',
    hostResources:setup.resources,cleanupTimeoutMs:5,spawn:()=>({kill(){}})});
  assert.deepEqual(await client.capabilities(),{capabilities:[]});
  assert.equal(setup.broker.snapshot().quarantined_count,1);
  await client.dispose();
});

test('pre-dispatch containment refusal is explicit host no-start evidence',async()=>{
  let starts=0;
  const supervisor=new FullHostProcessSupervisor({platform:'linux',nativeClient:{
    capabilities:async()=>({capabilities:[]}),start:async()=>{starts+=1;return {ok:false};},
  }});
  const result=await supervisor.start({authority:{},identity:{},executable:{},
    sessionId:'never-started',sessionEpoch:1});
  assert.equal(result.ok,false);assert.equal(result.no_start,true);assert.equal(starts,0);
});
