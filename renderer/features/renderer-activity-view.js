(function(root,factory){
  if(typeof module==='object'&&module.exports){module.exports=factory(require('../inventory/activity-list'));return;}
  root.rendererActivityView=factory(root.inventoryActivityList);
})(typeof globalThis!=='undefined'?globalThis:this,function(list){
  'use strict';
  const jt=(globalThis.jennyI18n&&globalThis.jennyI18n.t)||globalThis.jennyI18nFallback||((key,fallback)=>fallback);
  function createActivityView(deps={}){
    const api=deps.api||globalThis.jennyShell?.activity;
    const tests=deps.testApi||globalThis.jennyShell?.workspaceTestRunner;
    let scope=deps.defaultScope||'project', snapshot=null, stale=false, loading=true, error='';
    let bound=false,disposed=false,host=null,unsubscribe=null,timer=null,request=0,fetching=false,dirty=false;
    let wanted=null,contextKey='',markup='',pending=true,formatter=null,formatterTag;const expanded=new Set();
    const context=()=>deps.getContext?.()||{};
    function scopeQuery(){
      const ctx=context();
      if(scope==='all')return {kind:'all'};
      if(scope==='session')return ctx.sessionId?{kind:'session',session_id:ctx.sessionId}:null;
      return ctx.projectId?{kind:'project',project_id:ctx.projectId}:ctx.workspaceAvailable?{kind:'workspace'}:null;
    }
    function query(){return {schema_version:1,scope:scopeQuery(),epoch:snapshot?.epoch||'',after_revision:snapshot?.revision||0};}
    function seconds(value){
      const tag=globalThis.jennyI18n?.tag?.();
      if(!formatter||formatterTag!==tag){formatterTag=tag;formatter=new Intl.NumberFormat(tag,{style:'unit',unit:'second',unitDisplay:'narrow'});}
      return formatter.format(value);
    }
    // A fresh mount writes every duration; a timer tick rewrites only unfinished ones whose text changed.
    function tick(all=false){
      if(!host||deps.isVisible?.()===false)return;
      for(const el of host.querySelectorAll(all?'[data-activity-started]':'[data-activity-started][data-activity-finished=""]')){
        const start=Date.parse(el.dataset.activityStarted),end=Date.parse(el.dataset.activityFinished)||Date.now();
        const value=Number.isFinite(start)?seconds(Math.max(0,Math.floor((end-start)/1000))):'';
        if(el.textContent!==value)el.textContent=value;
      }
    }
    function render(){
      if(disposed)return;
      const target=deps.isVisible?.()===false?null:deps.getMountEl?.();if(!target){pending=true;return;}
      pending=false;
      if(host!==target){host?.removeEventListener('click',click);host=target;host.addEventListener('click',click);markup='';}
      const next=list.render({items:snapshot?.items||[],scope,context:context(),expanded,stale,loading,error,historyCoverage:snapshot?.history_coverage});
      host.setAttribute('aria-busy',String(loading));
      const replaced=next!==markup;
      if(replaced){
        const focused=host.ownerDocument.activeElement;
        const focusId=focused?.closest?.('[data-activity-id]')?.dataset.activityId;
        const focusAction=focused?.dataset.activityAction,focusScope=focused?.dataset.activityScope;
        const scroll=host.scrollTop;host.innerHTML=next;markup=next;host.scrollTop=scroll;
        if(focusId||focusScope){
          const buttons=[...host.querySelectorAll('button')];
          buttons.find(button=>focusScope?button.dataset.activityScope===focusScope:button.dataset.activityAction===focusAction&&button.closest('[data-activity-id]')?.dataset.activityId===focusId)?.focus({preventScroll:true});
        }
      }
      tick(replaced);
    }
    async function refresh(){
      if(disposed)return;
      if(fetching){dirty=true;return;}
      const selected=scopeQuery();
      if(!selected){snapshot=null;loading=false;stale=false;render();return;}
      if(!api?.subscribe){loading=false;stale=true;render();return;}
      fetching=true;dirty=false;const generation=request;
      try{
        const next=await api.subscribe(query());
        if(disposed||generation!==request)return;
        if(!next?.available)throw new Error('unavailable');
        if(snapshot?.epoch===next.epoch&&next.revision<snapshot.revision)return;
        snapshot=next;stale=false;loading=false;
        if(wanted&&wanted.epoch===next.epoch&&wanted.revision>next.revision)dirty=true;
        deps.onCountChange?.(next.items.filter(row=>row.group!=='finished').length,next.items.some(row=>row.group==='attention'));
      }catch{if(!disposed&&generation===request){stale=true;loading=false;}}
      finally{fetching=false;if(!disposed){render();if(dirty){dirty=false;void refresh();}}}
    }
    function changeScope(next){scope=next;request++;snapshot=null;expanded.clear();loading=true;stale=false;error='';markup='';render();void refresh();}
    async function click(event){
      const button=event.target.closest('button');if(!button||button.disabled)return;
      if(button.dataset.activityScope){changeScope(button.dataset.activityScope);return;}
      const action=button.dataset.activityAction;
      if(action==='diagnostics'){deps.onDiagnostics?.();return;}
      const id=button.closest('[data-activity-id]')?.dataset.activityId;
      if(!id||!snapshot)return;
      if(action==='details'&&expanded.has(id)){expanded.delete(id);render();return;}
      const payload={schema_version:1,scope:scopeQuery(),epoch:snapshot.epoch,activity_id:id};
      const generation=request;error='';
      try{
        if(action==='details'){
          const detail=await api.getDetail(payload);
          if(disposed||generation!==request)return;
          if(!detail?.available)throw new Error('unavailable');expanded.add(id);
        }else if(action==='output'){
          const output=await tests.getRunOutput(payload);
          if(disposed||generation!==request)return;
          if(!output?.available)throw new Error('unavailable');await deps.onOutput?.(output);
        }else if(action==='stop'){
          button.disabled=true;const result=await tests.abortRun(payload);
          if(disposed||generation!==request)return;
          if(result?.aborted!==true)throw new Error('unavailable');
        }
      }catch{if(!disposed&&generation===request)error=jt('activity.actionUnavailable','This activity action is no longer available.');}
      // Reconcile a manually disabled control even when the settled action left the markup unchanged.
      if(!disposed){markup='';render();void refresh();}
    }
    function observe(notice){
      if(disposed||notice?.schema_version!==1||!Number.isSafeInteger(notice.revision))return;
      if(snapshot?.epoch===notice.epoch&&notice.revision<=snapshot.revision)return;
      wanted=notice;void refresh();
    }
    function bind(){
      if(bound||disposed)return;bound=true;
      unsubscribe=api?.onChanged?.(observe);contextKey=JSON.stringify(context());render();void refresh();
      timer=setInterval(()=>{
        const key=JSON.stringify(context());
        if(key!==contextKey){contextKey=key;request++;snapshot=null;expanded.clear();loading=true;stale=false;error='';render();void refresh();}
        if(stale&&!fetching&&deps.isVisible?.()!==false)void refresh();
        if(pending||host!==deps.getMountEl?.())render();else tick();
      },1000);timer.unref?.();
    }
    return {bind,render,refresh,getSnapshot:()=>snapshot,setScope:changeScope,
      dispose(){disposed=true;request++;unsubscribe?.();clearInterval(timer);host?.removeEventListener('click',click);host=null;}};
  }
  return {createActivityView};
});
