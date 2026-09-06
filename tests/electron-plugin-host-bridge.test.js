'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {createElectronPluginHostBridge}=require('../services/backend/electron-plugin-host-bridge');
const authority={active_generation_id:'g',commit_epoch:1,registry_revision:2,dependency_graph_hash:'a'.repeat(64)};
test('fixed plugin host bridge accepts only enumerated operations and exact authority',async()=>{const calls=[];const bridge=createElectronPluginHostBridge({currentAuthority:async()=>authority,streamBroker:{start:async(x)=>(calls.push(x.operation),{ok:true}),acknowledge:async()=>({ok:true}),cancel:async()=>({ok:true})}});assert.equal((await bridge({operation:'plugin_defined_rpc',authority})).reason,'plugin_host_operation_rejected');assert.equal((await bridge({operation:'start',authority:{...authority,commit_epoch:2}})).reason,'plugin_host_authority_stale');assert.equal((await bridge({operation:'start',authority})).ok,true);assert.deepEqual(calls,['start']);});
