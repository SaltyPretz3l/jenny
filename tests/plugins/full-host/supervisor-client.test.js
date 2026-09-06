'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const crypto=require('node:crypto'); const { EventEmitter }=require('node:events');
const { PassThrough }=require('node:stream');
const { digest,FullHostProcessSupervisor }=require('../../../services/plugins/full-host/process-supervisor');
const { NativeSupervisorClient,responseAuthMessage }=require('../../../services/plugins/full-host/native-supervisor-client');
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
