"use strict";
const {randomUUID} = require('node:crypto');
const VERSION = 1;
const unavailable = reason => ({schema_version:VERSION,available:false,reason});
const safeLabel = value => Array.from(String(value || '')).filter(char => {
  const code=char.codePointAt(0); return code>=32 && !(code>=127&&code<=159) && !(code>=0x202a&&code<=0x202e) && !(code>=0x2066&&code<=0x2069);
}).slice(0,160).join('');
function project(row, epoch, projectName) {
  const active = ['running','cancelling','attention'].includes(row.state);
  return {schema_version:VERSION,activity_id:`test:${row.runId}`,source_kind:'workspace_test',source_id:row.runId,
    source_revision:row.sourceRevision,epoch,operation_kind:'test',label:safeLabel(row.label),
    config_id:row.configId,...row.scope,project_name:safeLabel(projectName)||null,state:row.state,
    group:row.state === 'attention' ? 'attention' : row.state === 'cancelling' ? 'waiting' : row.state === 'running' ? 'running' : 'finished',
    started_at:row.startedAt,finished_at:row.finishedAt,updated_at:row.updatedAt,freshness:'current',
    result:row.result,cleanup:row.cleanup,controls:{stop:active && row.live === true,view_output:row.outputAvailable === true}};
}
function createActivityProjection({source,resolveScope,resolveProjectName=()=>'',enabled=()=>false,notify=()=>{},epoch=randomUUID(),now=()=>new Date()} = {}) {
  let revision=0, signature='', rows=[], disposed=false, timer=null, sourceAvailable=true;
  function refresh() {
    if (disposed) return;
    try {
      const next=source.getActivityRuns();
      const serialized=JSON.stringify(next);
      const changed=serialized !== signature || !sourceAvailable;
      signature=serialized; rows=next; sourceAvailable=true;
      if (changed) {revision++; if(enabled()) notify({schema_version:VERSION,epoch,revision});}
    } catch {
      if(sourceAvailable){revision++;sourceAvailable=false;if(enabled())notify({schema_version:VERSION,epoch,revision});}
    }
    if (timer) clearTimeout(timer);
    timer=null;
    // Reconcile only what the owner still holds; restored unresolved rows stay visible without polling.
    if (enabled() && rows.some(row=>row.live === true)) {
      timer=setTimeout(refresh,5000); timer.unref?.();
    }
  }
  const unsubscribe=source.subscribeActivity(refresh);
  function read(payload) {
    if (disposed || !enabled()) return {error:unavailable('feature_disabled')};
    if (!payload || payload.schema_version !== VERSION || typeof payload.scope !== 'object') return {error:unavailable('invalid_request')};
    let resolved;
    try {resolved=resolveScope(payload.scope);} catch {return {error:unavailable('scope_unavailable')};}
    if (!resolved) return {error:unavailable('invalid_scope')};
    refresh();
    if (!sourceAvailable) return {error:unavailable('source_unavailable')};
    return {resolved, visible:rows.filter(resolved.matches)};
  }
  function present(row) {
    let name='';
    try {if(row.scope.project_id)name=resolveProjectName(row.scope.project_id);} catch { /* Deleted/unavailable project: retain stable scope fallback. */ }
    return project(row,epoch,name);
  }
  function compareFinished(a,b) {
    if(a.group!=='finished'||b.group!=='finished')return Number(a.group==='finished')-Number(b.group==='finished');
    const time=row=>Date.parse(row.finished_at)||Date.parse(row.updated_at)||0;
    return time(b)-time(a);
  }
  function getSnapshot(payload) {
    const result=read(payload); if(result.error) return result.error;
    return {schema_version:VERSION,available:true,epoch,revision,observed_at:now().toISOString(),
      scope:result.resolved.scope,items:result.visible.map(present).sort(compareFinished),omitted_count:null,history_coverage:'observed_workspaces'};
  }
  function getDetail(payload) {
    const result=read(payload); if(result.error) return result.error;
    if(payload.epoch !== epoch) return unavailable('stale_epoch');
    const row=result.visible.find(item=>`test:${item.runId}` === payload.activity_id);
    return row ? {schema_version:VERSION,available:true,epoch,revision,item:present(row)} : unavailable('not_found');
  }
  return {getSnapshot,getDetail,
    subscribe(payload) {
      if (!Number.isSafeInteger(payload?.after_revision) || payload.after_revision < 0) return unavailable('invalid_revision');
      const snapshot=getSnapshot(payload);
      return {...snapshot,reset:payload.epoch !== epoch || payload.after_revision !== snapshot.revision};
    },
    dispose() {disposed=true; unsubscribe?.(); if(timer)clearTimeout(timer); timer=null;rows=[];},
  };
}
module.exports = {createActivityProjection};
