'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {JSDOM}=require('jsdom');
const draft=require('../renderer/features/renderer-image-edit-draft');
const {createControllerHarness,buildMessageSequence}=require('./helpers/send-controller-harness');
const record={sessionId:'session-1',artifactId:'original',width:1024,height:1024,region:{kind:'box',points:[[250,250],[750,750]]}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('split-session draft previews persist only metadata and survive reload without stealing the other composer',async(t)=>{
  const dom=new JSDOM('<div class="composer"><textarea id="one"></textarea></div><div class="composer"><textarea id="two"></textarea></div>',{url:'https://jenny.local'});
  const doc=dom.window.document;let bindings=[{sessionId:'session-1',input:doc.querySelector('#one')},{sessionId:'session-2',input:doc.querySelector('#two')}];
  const readArtifact=async(session,id)=>({artifact:{title:session+' '+id},asset_data_url:'data:image/png;base64,YQ=='});
  const options={documentRef:doc,windowRef:dom.window,storage:dom.window.localStorage,getBindings:()=>bindings,readArtifact};
  let controller=draft.createController(options);t.after(()=>{controller.dispose();dom.window.close()});
  assert.equal(await controller.add(record),bindings[0].input);await tick();
  assert.equal(doc.querySelector('#one').parentElement.querySelectorAll('.image-edit-draft').length,1);
  assert.equal(doc.querySelector('#two').parentElement.querySelectorAll('.image-edit-draft').length,0);
  assert.equal(controller.snapshot('session-2'),null);
  assert.equal(dom.window.localStorage.getItem('jenny.image-edit-drafts.v1').includes('base64'),false);
  controller.dispose();controller=draft.createController(options);await tick();
  assert.equal(controller.snapshot('session-1').artifactId,'original');
  const captured=controller.snapshot('session-1');await controller.add({...record,artifactId:'newer'});controller.consume(captured);
  assert.equal(controller.snapshot('session-1').artifactId,'newer','late acceptance preserves a newer selection');
  bindings=[{sessionId:'session-2',input:doc.querySelector('#one')}];controller.refresh();
  assert.equal(doc.querySelectorAll('.image-edit-draft').length,0);
});

test('send includes selected source only in model prompt, and consumes it after accepted send',async(t)=>{
  const h=createControllerHarness(buildMessageSequence());t.after(()=>h.restore());let consumed=0;
  global.window.rendererImageEditDraft=draft;
  global.window.rendererImageEditDraftController={snapshot:id=>id==='session-1'?record:null,consume:r=>{assert.equal(r.artifactId,record.artifactId);consumed++}};
  await h.controller.startPromptSend('Make the apple purple', { attachImageEditDraft: true });
  const payload=h.calls.startStream[0];
  assert.match(payload.prompt,/source_artifact_id/);assert.match(payload.prompt,/original/);
  assert.equal(payload.visiblePrompt,'Make the apple purple');assert.equal(consumed,1);
});


test('programmatic sends leave staged edits untouched', async(t) => {
  const h=createControllerHarness(buildMessageSequence());t.after(()=>h.restore());let consumed=0;
  global.window.rendererImageEditDraft=draft;
  global.window.rendererImageEditDraftController={snapshot:()=>record,consume:()=>consumed++};
  await h.controller.startPromptSend('resume');
  assert.equal(h.calls.startStream[0].prompt,'resume');assert.equal(consumed,0);
});

test('send claims once before preflight, restores on failure, and retry clears only its own chip', async () => {
  let current={...record,revision:'first'};let release;const sent=[];
  const controller={snapshot:()=>current,consume:r=>{if(current?.revision===r.revision)current=null;},restore:r=>{current ||= r;}};
  const send=async(prompt,settings)=>{sent.push(settings);return new Promise(resolve=>{release=resolve;});};
  const first=draft.sendWithDraft(send,'edit',{attachImageEditDraft:true},controller,'session-1');
  assert.equal(current,null);const finish=release;
  const second=draft.sendWithDraft(async(p,s)=>{sent.push(s);return {queued:true};},'next',{attachImageEditDraft:true},controller,'session-1');
  await second;assert.equal(sent[1].imageEditSnapshot,null);finish(null);await first;assert.equal(current.artifactId,'original');
  await draft.sendWithDraft(async(p,s)=>{assert.equal(s.imageEditContextIncluded,true);return {streamId:'retry'};},'already contextualized',{},controller,'session-1',{imageEditSnapshot:current});
  assert.equal(current,null);
  current={...record,revision:'newer'};
  await draft.sendWithDraft(async()=>({streamId:'retry'}),'retry',{},controller,'session-1',{imageEditSnapshot:{...record,revision:'older'}});
  assert.equal(current.revision,'newer');
});

test('draft normalization strips extra keys and rejects oversized or malformed geometry', () => {
  const normalized=draft.normalize({...record,evil:'injected',region:{...record.region,command:'injected'}});
  assert.equal(JSON.stringify(normalized).includes('injected'),false);
  assert.equal(draft.valid({...record,width:4096,height:4096}),false);
  assert.equal(draft.valid({...record,region:{kind:'freehand',points:[[1,1],[2,2]]}}),false);
  assert.equal(draft.valid({...record,region:{kind:'freehand',points:Array(129).fill([1,1])}}),false);
});

test('a chat switch during slash-command preflight rejects the send and restores the draft to its chat',async(t)=>{
  let releaseSkills=null;const reads=[];
  const registry={register:()=>true,unregister:()=>true,execute:()=>({matched:false})};
  const skills={getState:(scope)=>{reads.push(scope);return releaseSkills?new Promise(resolve=>{const release=releaseSkills;releaseSkills=null;release(()=>resolve({scopes:[]}));}):Promise.resolve({scopes:[]});}};
  const h=createControllerHarness(buildMessageSequence(),{slashCommandRegistry:registry,shell:{skills}});t.after(()=>h.restore());
  await tick();
  let current={...record};const restored=[];
  global.window.rendererImageEditDraft=draft;
  global.window.rendererImageEditDraftController={snapshot:id=>current?.sessionId===id?current:null,consume:()=>{current=null;},restore:r=>{restored.push(r);current ||= r;}};
  // The skills catalog for this chat needs a refresh, which is still loading when the user switches chats.
  h.state.sessions[0].project_id='project-1';
  let finishRead;releaseSkills=resolveRead=>{finishRead=resolveRead;};
  const pending=h.controller.startPromptSend('/unmatched edit the image',{attachImageEditDraft:true});
  await tick();assert.equal(current,null,'the draft is claimed before the preflight');
  h.state.sessions.push({id:'session-2',title:'Session 2'});h.state.currentSessionId='session-2';
  finishRead();const result=await pending;
  assert.equal(h.calls.startStream.length,0,'nothing is sent to the chat that became current');
  assert.equal(result?.rejected,true);
  assert.equal(current?.sessionId,'session-1','the draft returns to its own chat');assert.equal(restored.length,1);
});
