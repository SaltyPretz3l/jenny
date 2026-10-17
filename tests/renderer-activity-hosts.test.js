"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {createChatActivity}=require('../renderer/features/renderer-chat-activity');
const {createIdeActivityWiring}=require('../renderer/features/renderer-ide-activity-wiring');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('Chat explicit open claims ownership, restores destination, closes by keyboard and tears down',async()=>{
 const dom=new JSDOM('<div data-chat-node="chatTimelineUtilityCluster"></div><aside id="p" class="collapsed"></aside>',{url:'https://jenny.test'});
 let owner='one',claims=0,unsubscribed=0;
 const state={features:{featureFlags:{activity_monitor:true}},ui:{activeView:'chat'},currentSessionId:'two',sessions:[{id:'one',project_id:'p'},{id:'two',project_id:'q'}]};
 const queries=[];const api={onChanged:()=>()=>unsubscribed++,subscribe:async q=>{queries.push(q);return{available:true,epoch:'e',revision:1,items:[]};}};
 const deps={state,panel:dom.window.document.getElementById('p'),api,sidePanel:{claim:()=>{claims++;owner=state.currentSessionId;},getSessionId:()=>owner}};
 const host=createChatActivity(deps);host.bind();host.open();await flush();
 assert.equal(claims,1);assert.equal(queries.at(-1).scope.session_id,'two');
 state.currentSessionId='one';await host.render();assert.equal(owner,'two','focus alone cannot retarget');
 dom.window.document.querySelector('[data-activity-open]').click();await flush();assert.equal(host.isOpen(),true);assert.equal(owner,'one');assert.equal(claims,2);
 assert.equal(JSON.parse(dom.window.localStorage.getItem('jenny.contextPanel.v1')).destination,'activity');
 host.dispose();assert.equal(unsubscribed,1);assert.equal(dom.window.document.querySelector('.chat-activity-host'),null);
 const restored=createChatActivity(deps);restored.bind();restored.render();await flush();assert.equal(restored.isOpen(),true);assert.equal(claims,2);
 const close=dom.window.document.querySelector('[data-activity-action="close"]');close.focus();close.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(restored.isOpen(),false);assert.equal(dom.window.document.activeElement.hasAttribute('data-activity-open'),true);
 restored.dispose();dom.window.close();
});
test('Workspace exact output selection rejects mismatched run identity and disables foreign-root rerun',()=>{
 const dom=new JSDOM('<div id="test-output"></div><div id="test-runner"></div><div id="activity"></div>');
 const shown=[];const workbench={viewDeps:id=>({getMountEl:()=>dom.window.document.getElementById(id),isActivePanel:()=>true}),isVisible:()=>true,showPanel:id=>shown.push(id),render:()=>{}};
 const state={ui:{activeView:'ide'},workspaceRoot:{rootId:'current'}};
 const wiring=createIdeActivityWiring({state,workbench,windowRef:dom.window,requestRender:()=>{},actionButton:require('../renderer/inventory/action-button'),escapeHtml:require('../renderer/shared/string-utils').escapeHtml});
 assert.equal(wiring.activityView.showOutput({available:true,runId:'one',record:{runId:'two'}}),false);
 assert.equal(wiring.activityView.showOutput({available:true,runId:'one',configId:'unit',label:'Original',rootId:'foreign',record:{runId:'one',status:'passed',stdoutTail:'EXACT OLD OUTPUT'}}),true);
 assert.match(dom.window.document.body.textContent,/EXACT OLD OUTPUT/);assert.equal(dom.window.document.querySelector('[data-ide-task-footer-action="rerun"]').disabled,true);
 assert.deepEqual(shown,['test-output']);wiring.activityView.dispose();wiring.testRunnerWiring.dispose();wiring.testOutputPanel.dispose();dom.window.close();
});
test('a new run of the Activity-selected config repaints the output panel',async()=>{
 const dom=new JSDOM('<div id="test-output"></div><div id="test-runner"></div><div id="activity"></div>');
 dom.window.jennyShell={workspaceTestRunner:{run:async({configId})=>({configId,runId:'new-run',status:'failed',exitCode:1,stdoutTail:'NEW OUTPUT',stderrTail:''})}};
 const workbench={viewDeps:id=>({getMountEl:()=>dom.window.document.getElementById(id),isActivePanel:()=>true}),isVisible:()=>true,showPanel:()=>{},render:()=>{}};
 const state={ui:{activeView:'ide'},workspaceRoot:{rootId:'current'}};
 const wiring=createIdeActivityWiring({state,workbench,windowRef:dom.window,requestRender:()=>wiring?.testOutputPanel.render(),actionButton:require('../renderer/inventory/action-button'),escapeHtml:require('../renderer/shared/string-utils').escapeHtml});
 assert.equal(wiring.activityView.showOutput({available:true,runId:'old-run',configId:'unit',label:'Unit',rootId:'current',record:{runId:'old-run',status:'passed',exitCode:0,stdoutTail:'OLD OUTPUT'}}),true);
 await wiring.testRunnerWiring.runConfig('unit');await flush();wiring.testOutputPanel.render();
 const text=dom.window.document.getElementById('test-output').textContent;
 assert.match(text,/NEW OUTPUT/);assert.doesNotMatch(text,/OLD OUTPUT/);
 wiring.activityView.dispose();wiring.testRunnerWiring.dispose();wiring.testOutputPanel.dispose();dom.window.close();
});
test('an unrelated root finishing the same config keeps the selected exact-run output and its disabled rerun',async t=>{
 const dom=new JSDOM('<div id="test-output"></div><div id="test-runner"></div><div id="activity"></div>');
 let finish;dom.window.jennyShell={workspaceTestRunner:{run:({configId})=>new Promise(resolve=>{finish=()=>resolve({configId,runId:'b-run',status:'passed',exitCode:0,stdoutTail:'ROOT B OUTPUT',stderrTail:''});})}};
 const workbench={viewDeps:id=>({getMountEl:()=>dom.window.document.getElementById(id),isActivePanel:()=>true}),isVisible:()=>true,showPanel:()=>{},render:()=>{}};
 const state={ui:{activeView:'ide'},workspaceRoot:{rootId:'root-b'}};
 const wiring=createIdeActivityWiring({state,workbench,windowRef:dom.window,requestRender:()=>wiring?.testOutputPanel.render(),actionButton:require('../renderer/inventory/action-button'),escapeHtml:require('../renderer/shared/string-utils').escapeHtml});
 t.after(()=>{wiring.activityView.dispose();wiring.testRunnerWiring.dispose();wiring.testOutputPanel.dispose();dom.window.close();});
 const running=wiring.testRunnerWiring.runConfig('unit');await flush();
 assert.equal(wiring.activityView.showOutput({available:true,runId:'a-run',configId:'unit',label:'Unit A',rootId:'root-a',record:{runId:'a-run',status:'failed',exitCode:1,stdoutTail:'ROOT A OUTPUT'}}),true);
 finish();await running;await flush();wiring.testOutputPanel.render();
 const text=dom.window.document.getElementById('test-output').textContent;
 assert.match(text,/ROOT A OUTPUT/);assert.doesNotMatch(text,/ROOT B OUTPUT/);
 assert.equal(dom.window.document.querySelector('[data-ide-task-footer-action="rerun"]').disabled,true);
});
function rootSwitchWiring(t,run){
 const dom=new JSDOM('<div id="test-output"></div><div id="test-runner"></div><div id="activity"></div>');
 dom.window.jennyShell={workspaceTestRunner:{run}};
 const workbench={viewDeps:id=>({getMountEl:()=>dom.window.document.getElementById(id),isActivePanel:()=>true}),isVisible:()=>true,showPanel:()=>{},render:()=>{}};
 const state={ui:{activeView:'ide'},workspaceRoot:{rootId:'root-b'}};
 const wiring=createIdeActivityWiring({state,workbench,windowRef:dom.window,requestRender:()=>wiring?.testOutputPanel.render(),actionButton:require('../renderer/inventory/action-button'),escapeHtml:require('../renderer/shared/string-utils').escapeHtml});
 t.after(()=>{wiring.activityView.dispose();wiring.testRunnerWiring.dispose();wiring.testOutputPanel.dispose();});
 const showA=()=>wiring.activityView.showOutput({available:true,runId:'a-run',configId:'unit',label:'Unit A',rootId:'root-a',record:{runId:'a-run',status:'failed',exitCode:1,stdoutTail:'ROOT A OUTPUT'}});
 const read=()=>{wiring.testOutputPanel.render();return{text:dom.window.document.getElementById('test-output').textContent,rerunDisabled:dom.window.document.querySelector('[data-ide-task-footer-action="rerun"]').disabled};};
 return {state,wiring,showA,read};
}
const bResult=configId=>({configId,runId:'b-run',status:'passed',exitCode:0,stdoutTail:'ROOT B OUTPUT',stderrTail:''});
test('selecting another root\'s exact output and then starting the current root\'s same config keeps that output',async t=>{
 let finish;const {wiring,showA,read}=rootSwitchWiring(t,({configId})=>new Promise(resolve=>{finish=()=>resolve(bResult(configId));}));
 assert.equal(showA(),true);
 const running=wiring.testRunnerWiring.runConfig('unit');await flush();
 finish();await running;await flush();
 const after=read();
 assert.match(after.text,/ROOT A OUTPUT/);assert.doesNotMatch(after.text,/ROOT B OUTPUT/);assert.equal(after.rerunDisabled,true);
});
test('a failed follow request is not consumed by an earlier run of the same config finishing',async t=>{
 const finishes=[];const {state,wiring,showA,read}=rootSwitchWiring(t,({configId})=>finishes.length?Promise.resolve({error:{code:'CONFIG_ACTIVE_RUN',message:'busy'}}):new Promise(resolve=>finishes.push(()=>resolve(bResult(configId)))));
 const earlier=wiring.testRunnerWiring.runConfig('unit');await flush();
 state.workspaceRoot={rootId:'root-a'};assert.equal(showA(),true);
 assert.equal((await wiring.testRunnerWiring.runConfig('unit')).ok,false);
 state.workspaceRoot={rootId:'root-b'};finishes[0]();await earlier;await flush();
 const after=read();
 assert.match(after.text,/ROOT A OUTPUT/);assert.doesNotMatch(after.text,/ROOT B OUTPUT/);assert.equal(after.rerunDisabled,true);
});
