(function(root,factory){
  if(typeof module==='object'&&module.exports){module.exports=factory(require('./renderer-activity-view'),require('../inventory/activity-list'),require('../inventory/action-button'));return;}
  root.rendererChatActivity=factory(root.rendererActivityView,root.inventoryActivityList,root.inventoryActionButton);
})(typeof globalThis!=='undefined'?globalThis:this,function(views,inventory,actionButton){
  'use strict';
  const jt=(globalThis.jennyI18n&&globalThis.jennyI18n.t)||globalThis.jennyI18nFallback||((key,fallback)=>fallback);
  function createChatActivity(deps){
    const panel=deps.panel,doc=panel?.ownerDocument;let host=null,opened=false,bound=false,count=0,attention=false,wasCollapsed=true;
    let restore=false,opener=null;const storage=doc?.defaultView?.localStorage;
    const enabled=()=>deps.state.features?.featureFlags?.activity_monitor===true;
    try{restore=JSON.parse(storage?.getItem('jenny.contextPanel.v1')||'{}').destination==='activity';}catch{/* preferences unavailable */}
    function save(){try{const prefs=JSON.parse(storage?.getItem('jenny.contextPanel.v1')||'{}');storage?.setItem('jenny.contextPanel.v1',JSON.stringify({...prefs,destination:opened?'activity':'context'}));}catch{/* preferences unavailable */}}
    function context(){
      const sessionId=deps.sidePanel?.getSessionId?.()||deps.state.currentSessionId;
      const session=(deps.state.sessions||[]).find(item=>item.id===sessionId);
      return {sessionId:sessionId||null,projectId:session?.project_id||null};
    }
    const view=views.createActivityView({api:deps.api,testApi:deps.testApi,getMountEl:()=>host?.querySelector('.activity-panel-body'),
      getContext:context,defaultScope:'session',isVisible:()=>opened&&deps.state.ui?.activeView==='chat',
      onOutput:deps.onOutput,onDiagnostics:deps.onDiagnostics,onCountChange:(next,needsAttention)=>{count=next;attention=needsAttention;syncButtons();}});
    function syncButtons(){
      for(const button of doc?.querySelectorAll('[data-activity-open]')||[]){button.hidden=!enabled();button.setAttribute('aria-pressed',String(opened));
        const badge=button.querySelector('[data-activity-count]');if(badge){badge.textContent=String(count);badge.hidden=count===0;badge.classList.toggle('needs-attention',attention);}}
    }
    function mountButtons(){
      for(const cluster of doc?.querySelectorAll('[data-chat-node="chatTimelineUtilityCluster"]')||[]){
        if(cluster.querySelector('[data-activity-open]'))continue;
        cluster.insertAdjacentHTML('beforeend',actionButton({plain:true,className:'chat-timeline-utility-button activity-open-button',
          dataset:{'activity-open':'true'},ariaLabel:jt('activity.open','Open Activity'),title:jt('activity.open','Open Activity'),
          label:jt('activity.title','Activity')}));
        const button=cluster.querySelector('[data-activity-open]');
        const label=doc.createElement('span');label.className='chat-timeline-utility-text';label.textContent=button.textContent;
        button.replaceChildren(label);button.insertAdjacentHTML('beforeend','<span data-activity-count hidden></span>');
      }
      syncButtons();
    }
    function open({claim=true}={}){
      if(!enabled())return false;
      if(claim)deps.sidePanel?.claim?.();deps.closeArtifact?.();deps.sidePanel?.syncOwnerLine?.(panel,'context');
      if(!opened)wasCollapsed=panel.classList.contains('collapsed');
      opened=true;panel.classList.remove('collapsed');panel.classList.add('activity-mode');host.hidden=false;
      save();syncButtons();void view.refresh();view.render();deps.updateLayout?.();return true;
    }
    function close(){
      if(!opened)return false;opened=false;panel.classList.remove('activity-mode');host.hidden=true;
      panel.classList.toggle('collapsed',wasCollapsed);save();syncButtons();deps.updateLayout?.();return true;
    }
    function click(event){
      const button=event.target.closest?.('[data-activity-open]');
      if(button){opener=button;if(opened&&deps.state.currentSessionId===context().sessionId)close();else open();return;}
      if(host?.contains(event.target)&&event.target.closest?.('[data-activity-action="close"]')){close();buttonFocus();}
    }
    function keydown(event){if(opened&&event.key==='Escape'&&host?.contains(event.target)){event.preventDefault();close();buttonFocus();}}
    function buttonFocus(){/* The Activity button leaves the bar (row 115): focus goes to the More button beside it. */const button=opener?.isConnected&&!opener.hidden?opener:doc.querySelector('[data-activity-open]:not([hidden])');(button?.closest('[data-chat-node="chatTimelineUtilityCluster"]')?.querySelector('[data-transcript-view-toggle]')||button)?.focus();}
    function bind(){
      if(bound||!panel)return;bound=true;host=doc.createElement('section');host.className='chat-activity-host';host.hidden=true;
      host.setAttribute('aria-label',jt('activity.title','Activity'));host.innerHTML=inventory.panelFrame();panel.appendChild(host);
      doc.addEventListener('click',click);doc.addEventListener('keydown',keydown);mountButtons();if(enabled())view.bind();
    }
    function render(){if(!bound)return;mountButtons();if(enabled())view.bind();
      if(restore&&enabled()){restore=false;open({claim:false});}
      if(opened&&(!enabled()||panel.closest('.chat-view')?.classList.contains('artifact-review-mode')))close();
      view.render();
    }
    return {bind,render,open,close,isOpen:()=>opened,dispose(){view.dispose();doc?.removeEventListener('click',click);doc?.removeEventListener('keydown',keydown);host?.remove();for(const button of doc?.querySelectorAll('[data-activity-open]')||[])button.remove();bound=false;}};
  }
  /* Row 115 slice 2a: the chat context panel is Activity's host and nothing else. Its diagnostic log (Diagnostics
     has it) and the bar button that opened it are gone, so the panel is collapsed unless Activity is open, whatever
     an older version stored in `jenny.contextPanel.v1` (`collapsed: false` would otherwise leave an empty column
     with no way to close it). Activity still keeps its `destination` in that key. */
  function createContextPanelController(deps){
    const {state,dom,callbacks}=deps;
    const activity=(deps.createActivity||createChatActivity)({state,panel:dom.chatContextPanel,sidePanel:callbacks.sidePanel,
      closeArtifact:callbacks.closeArtifact,onOutput:callbacks.openActivityOutput,onDiagnostics:()=>callbacks.setActiveView?.('logs'),
      updateLayout:()=>callbacks.updateComposerSafeOffset?.({force:true,syncViewport:true})});
    let bound=false;
    // Activity names its owner in one-pane view too (the context list stays split-only), so it syncs as its own mode.
    function syncPanelOwnerLine(){
      if(callbacks.sidePanel)callbacks.sidePanel.syncOwnerLine(dom.chatContextPanel,activity?.isOpen()?'activity':'context');
    }
    function renderContextPanel(){
      activity?.render();
      if(!dom.chatContextPanel||(state.ui&&state.ui.activeView!=='chat'))return;
      syncPanelOwnerLine();
    }
    // With the Activity flag off nothing here can open, so a "View activity" row (the Session rail) goes to Diagnostics.
    function openActivity(){
      if(activity?.open()){syncPanelOwnerLine();return true;}
      if(callbacks.setActiveView){callbacks.setActiveView('logs');return true;}
      return false;
    }
    function bind(){
      if(bound||!dom.chatContextPanel)return;
      bound=true;activity?.bind();dom.chatContextPanel.classList.add('collapsed');
    }
    return {openActivity,renderContextPanel,bind,
      dispose(){activity?.dispose();bound=false;},
      // Split view: the pane that owned the side panel closed. Close Activity (it restores the collapsed column).
      collapseForOwnerClose:()=>Boolean(activity?.close())};
  }
  return {createChatActivity,createContextPanelController};
});
