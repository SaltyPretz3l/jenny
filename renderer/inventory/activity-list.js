(function(root,factory){
  if(typeof module==='object' && module.exports){module.exports=factory(require('../shared/string-utils'));return;}
  root.inventoryActivityList=factory(root.stringUtils);
})(typeof globalThis!=='undefined'?globalThis:this,function(strings){
  'use strict';
  const esc=strings.escapeHtml;
  const jt=(globalThis.jennyI18n && globalThis.jennyI18n.t)||globalThis.jennyI18nFallback||((key,fallback)=>fallback);
  const unknown=()=>jt('activity.unknown','Unknown');
  const groups=()=>({attention:jt('activity.group.attention','Needs attention'),running:jt('activity.group.running','Running'),waiting:jt('activity.group.waiting','Waiting'),finished:jt('activity.group.finished','Finished')});
  function stateLabel(row){
    if(row.cleanup==='unconfirmed')return jt('activity.cleanup.unconfirmed','Cleanup not confirmed');
    if(row.state==='cancelling')return jt('activity.state.cancelling','Cancellation requested');
    if(row.state==='running')return jt('activity.state.running','Running');
    const labels={passed:jt('activity.result.passed','Passed'),failed:jt('activity.result.failed','Failed'),aborted:jt('activity.result.stopped','Stopped'),timeout:jt('activity.result.timeout','Timed out'),error:jt('activity.result.error','Could not finish'),interrupted:jt('activity.result.interrupted','Interrupted')};
    return labels[row.result?.status]||unknown();
  }
  function action(name,label,disabled=false){return `<button type="button" class="activity-action" data-activity-action="${name}"${disabled?' disabled':''}>${esc(label)}</button>`;}
  function localTime(value){
    const ms=Date.parse(value);
    return Number.isFinite(ms)?new Date(ms).toLocaleString(globalThis.jennyI18n?.tag?.(),{dateStyle:'medium',timeStyle:'short',...globalThis.jennyI18n?.timeOptions?.()}):unknown();
  }
  // Details (dates included) are built only for an expanded row.
  function detailMarkup(row){
    const details=[
      [jt('activity.detail.waiting','Waiting on'),row.state==='cancelling'?jt('activity.detail.settlement','Test process cleanup'):unknown()],
      [jt('activity.detail.resource','Resource'),jt('activity.detail.testRunner','Test Runner')],
      [jt('activity.detail.scope','Scope'),row.project_name||unknown()],
      [jt('activity.detail.conflict','Conflict'),unknown()],
      [jt('activity.detail.result','Result'),stateLabel(row)],
      [jt('activity.detail.cleanup','Cleanup'),row.cleanup==='confirmed'?jt('activity.cleanup.confirmed','Confirmed'):row.cleanup==='pending'?jt('activity.cleanup.pending','Pending'):row.cleanup==='unconfirmed'?jt('activity.cleanup.unconfirmed','Cleanup not confirmed'):unknown()],
      [jt('activity.detail.updated','Updated'),localTime(row.updated_at)],
    ];
    return `<div class="activity-detail"><dl>${details.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl></div>`;
  }
  function rowMarkup(row,expanded,stale){
    return `<article class="activity-row" data-activity-id="${esc(row.activity_id)}" data-activity-state="${esc(row.state)}"><button type="button" class="activity-row-toggle" data-activity-action="details" aria-expanded="${expanded}"><span class="activity-glyph" aria-hidden="true"></span><span class="activity-row-copy"><strong>${esc(row.label)}</strong><span>${esc(stateLabel(row))}</span></span><span class="activity-duration" data-activity-started="${esc(row.started_at||'')}" data-activity-finished="${esc(row.finished_at||'')}"></span></button>`
      +(expanded?detailMarkup(row):'')
      +'<div class="activity-actions">'+(row.controls?.view_output?action('output',jt('activity.viewOutput','View output'),stale):'')
      +(row.controls?.stop?action('stop',jt('activity.stop','Stop'),stale||row.state==='cancelling'):'')+'</div></article>';
  }
  function render({items=[],scope='project',context={},expanded=new Set(),stale=false,loading=false,error='',historyCoverage=''}){
    const choices=[['session',jt('activity.scope.chat','This chat'),!context.sessionId],['project',jt('activity.scope.project','This project'),!context.projectId&&!context.workspaceAvailable],['all',jt('activity.scope.all','All Jenny'),false]];
    let html='<div class="activity-scope" role="group" aria-label="'+esc(jt('activity.scope.label','Activity scope'))+'">'+choices.map(([key,label,disabled])=>'<button type="button" data-activity-scope="'+key+'" aria-pressed="'+(scope===key)+'"'+(disabled?' disabled':'')+'>'+esc(label)+'</button>').join('')+'</div>';
    for(const message of [loading&&jt('activity.loading','Checking activity…'),stale&&jt('activity.unavailable','Activity unavailable. Showing the last update.'),error]){
      if(message)html+=`<div class="activity-notice" role="status">${esc(message)}</div>`;
    }
    for(const [key,label] of Object.entries(groups())){
      const rows=items.filter(row=>row.group===key);if(!rows.length)continue;
      html+=`<section class="activity-group"><h3>${esc(label)} <span>${rows.length}</span></h3>${rows.map(row=>rowMarkup(row,expanded.has(row.activity_id),stale)).join('')}</section>`;
    }
    if(!items.length&&!loading&&!stale)html+='<p class="activity-notice">'+esc(jt('activity.empty','No activity in this scope.'))+'</p>';
    if(historyCoverage==='observed_workspaces')html+='<p class="activity-notice">'+esc(jt('activity.historyCoverage','Earlier activity from other workspaces may be unavailable.'))+'</p>';
    return `${html}<footer class="activity-footer">${action('diagnostics',jt('activity.diagnosticLog','Diagnostic log'))}</footer>`;
  }
  function panelFrame(){return '<div class="activity-panel-header"><strong>'+esc(jt('activity.title','Activity'))+'</strong>'+action('close',jt('activity.close','Close'))+'</div><div class="activity-panel-body"></div>';}
  return {render,stateLabel,panelFrame};
});
