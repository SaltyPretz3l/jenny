"use strict";
const test=require('node:test'), assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {createActivityView}=require('../renderer/features/renderer-activity-view');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('two hosts share source identity, escaped labels and recover a revision gap',async()=>{
 const dom=new JSDOM('<div id="one"></div><div id="two"></div>');let revision=1;const listeners=new Set();
 const api={onChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},subscribe:async()=>({schema_version:1,available:true,epoch:'e',revision,items:[{activity_id:'test:one',source_id:'one',label:'<img src=x>',group:'running',state:'running',cleanup:'pending',controls:{stop:true}}]})};
 const views=['one','two'].map(id=>createActivityView({api,getMountEl:()=>dom.window.document.getElementById(id),getContext:()=>({workspaceAvailable:true}),defaultScope:'project',isVisible:()=>true}));
 for(const view of views)view.bind();await flush();
 assert.equal(dom.window.document.querySelectorAll('[data-activity-id="test:one"]').length,2);
 assert.equal(dom.window.document.querySelector('img'),null);
 revision=4;for(const fn of listeners)fn({schema_version:1,epoch:'e',revision});await flush();
 assert.equal(views[0].getSnapshot().revision,4);
 for(const view of views)view.dispose(); assert.equal(listeners.size,0);dom.window.close();
});
test('failed refresh preserves stale rows and disables controls',async()=>{
 const dom=new JSDOM('<div id="host"></div>');let fail=false,notice;
 const api={onChanged:fn=>{notice=fn;return()=>{};},subscribe:async()=>{if(fail)throw new Error('offline');return {available:true,epoch:'e',revision:1,items:[{activity_id:'test:x',label:'Unit',group:'running',state:'running',cleanup:'pending',controls:{stop:true}}]};}};
 const view=createActivityView({api,getMountEl:()=>dom.window.document.getElementById('host'),getContext:()=>({workspaceAvailable:true}),defaultScope:'project',isVisible:()=>true});view.bind();await flush();fail=true;notice({schema_version:1,epoch:'e',revision:2});await flush();
 assert.match(dom.window.document.body.textContent,/Unit/);assert.equal(dom.window.document.querySelector('[data-activity-action="stop"]').disabled,true);
 view.dispose();dom.window.close();
});
test('a hidden view does not poll an unavailable scope',async t=>{
 const dom=new JSDOM('<div id="host"></div>');t.mock.timers.enable({apis:['setInterval']});let calls=0;
 const api={onChanged:()=>()=>{},subscribe:async()=>{calls++;return {schema_version:1,available:false,reason:'scope_unavailable'};}};
 const view=createActivityView({api,getMountEl:()=>dom.window.document.getElementById('host'),getContext:()=>({sessionId:'s'}),defaultScope:'session',isVisible:()=>false});
 view.bind();await flush();const start=calls;
 for(let i=0;i<30;i++){t.mock.timers.tick(1000);await flush();}
 assert.equal(calls,start);view.dispose();dom.window.close();
});


test('Finished rows show newest completion first without moving other groups or mutating the snapshot',()=>{
 const list=require('../renderer/inventory/activity-list');
 const items=[
  {activity_id:'old',group:'finished',finished_at:'2026-10-08T11:00:00Z'},
  {activity_id:'running',group:'running'},
  {activity_id:'new',group:'finished',finished_at:'2026-10-08T12:00:00Z'},
  {activity_id:'attention',group:'attention'},
  {activity_id:'unknown',group:'finished',finished_at:'invalid'},
 ];
 const before=structuredClone(items);
 const {createActivityProjection}=require('../services/activity-projection');
 const projection=createActivityProjection({enabled:()=>true,resolveScope:scope=>({scope,matches:()=>true}),
  source:{subscribeActivity:()=>()=>{},getActivityRuns:()=>items.map(row=>({runId:row.activity_id,state:row.group,scope:{},finishedAt:row.finished_at}))}});
 const projected=projection.getSnapshot({schema_version:1,scope:{kind:'all'}}).items;
 const dom=new JSDOM(list.render({items:projected}));
 projection.dispose();
 assert.deepEqual([...dom.window.document.querySelectorAll('[data-activity-id]')].map(el=>el.dataset.activityId),['test:attention','test:running','test:new','test:old','test:unknown']);
 assert.deepEqual(items,before);dom.window.close();
});

test('details use the safe project display name and locale/time preference instead of opaque scope and UTC',t=>{
 const old=globalThis.jennyI18n;
 globalThis.jennyI18n={tag:()=> 'de-DE',timeOptions:()=>({hourCycle:'h23'})};
 t.after(()=>{globalThis.jennyI18n=old;});
 const list=require('../renderer/inventory/activity-list');
 const updated='2026-10-08T23:43:12Z';
 const row={activity_id:'one',group:'finished',project_id:'project_opaque',session_id:'session_opaque',project_name:'Garden <img src=x>',updated_at:updated};
 const dom=new JSDOM(list.render({items:[row],expanded:new Set(['one'])}));
 t.after(()=>dom.window.close());
 const values=[...dom.window.document.querySelectorAll('dd')].map(el=>el.textContent);
 assert.equal(values[2],'Garden <img src=x>');assert.equal(dom.window.document.querySelector('img'),null);
 assert.equal(values[6],new Intl.DateTimeFormat('de-DE',{dateStyle:'medium',timeStyle:'short',hourCycle:'h23'}).format(new Date(updated)));
 const fallback=new JSDOM(list.render({items:[{...row,project_name:null,updated_at:'bad'}],expanded:new Set(['one'])}));
 assert.equal(fallback.window.document.querySelectorAll('dd')[2].textContent,'Unknown');
 assert.equal(fallback.window.document.querySelectorAll('dd')[6].textContent,'Unknown');fallback.window.close();
});

test('Stop stays retryable after successive unconfirmed cleanup attempts on an unchanged collapsed row',async t=>{
 const dom=new JSDOM('<div id="host"></div>');t.after(()=>{view.dispose();dom.window.close();});
 const row={activity_id:'test:run',source_id:'run',label:'Unit',group:'attention',state:'attention',cleanup:'unconfirmed',controls:{stop:true}};
 const api={onChanged:()=>()=>{},subscribe:async()=>({schema_version:1,available:true,epoch:'e',revision:1,items:[row]})};
 const aborts=[];const testApi={abortRun:async payload=>{aborts.push(payload.activity_id);return {aborted:true,runId:'run',terminationConfirmed:false,reason:'kill_unconfirmed'};}};
 const view=createActivityView({api,testApi,getMountEl:()=>dom.window.document.getElementById('host'),getContext:()=>({workspaceAvailable:true}),defaultScope:'project',isVisible:()=>true});
 view.bind();await flush();
 const stop=()=>dom.window.document.querySelector('[data-activity-action="stop"]');
 stop().click();await flush();await flush();
 assert.equal(stop().disabled,false,'an unconfirmed retry leaves Stop available');
 stop().click();await flush();await flush();
 assert.deepEqual(aborts,['test:run','test:run']);
});

test('an idle tick rewrites only active durations and formats no Finished row',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date'],now:Date.parse('2026-10-11T12:00:10Z')});
 const dom=new JSDOM('<div id="host"></div>');t.after(()=>{view.dispose();dom.window.close();});
 const finished=Array.from({length:200},(_,i)=>({activity_id:'test:f'+i,label:'Done '+i,group:'finished',state:'finished',cleanup:'confirmed',
  started_at:'2026-10-11T11:00:00Z',finished_at:'2026-10-11T11:00:05Z',updated_at:'2026-10-11T11:00:05Z',result:{status:'passed'},controls:{}}));
 const active={activity_id:'test:live',label:'Live',group:'running',state:'running',cleanup:'pending',started_at:'2026-10-11T12:00:00Z',finished_at:null,controls:{stop:true}};
 const api={onChanged:()=>()=>{},subscribe:async()=>({schema_version:1,available:true,epoch:'e',revision:1,items:[active,...finished]})};
 const view=createActivityView({api,getMountEl:()=>dom.window.document.getElementById('host'),getContext:()=>({workspaceAvailable:true}),defaultScope:'project',isVisible:()=>true});
 view.bind();await flush();
 const host=dom.window.document.getElementById('host');
 const duration=id=>host.querySelector(`[data-activity-id="${id}"] .activity-duration`);
 assert.equal(duration('test:f0').textContent.length>0,true);const before=duration('test:live').textContent;
 const writes=[];const observer=new dom.window.MutationObserver(records=>writes.push(...records));
 observer.observe(host,{subtree:true,childList:true,characterData:true});
 const dates=t.mock.method(Date.prototype,'toLocaleString');const formats=t.mock.method(Intl,'NumberFormat');
 t.mock.timers.tick(1000);await flush();observer.takeRecords().forEach(record=>writes.push(record));observer.disconnect();
 assert.notEqual(duration('test:live').textContent,before,'the active duration advances');
 const rowOf=node=>(node.closest?node:node.parentElement).closest('[data-activity-id]')?.dataset.activityId;
 assert.equal(writes.length>0,true);assert.deepEqual(writes.filter(record=>rowOf(record.target)!=='test:live'),[],'no Finished-row text writes');
 assert.equal(dates.mock.callCount(),0,'collapsed rows format no dates');
 assert.equal(formats.mock.callCount(),0,'the duration formatter is reused');
});
