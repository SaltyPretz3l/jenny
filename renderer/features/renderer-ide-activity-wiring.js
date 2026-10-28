(function(root,factory){
  if(typeof module==='object'&&module.exports){module.exports=factory(require('./renderer-activity-view'),require('./renderer-ide-test-runner-wiring'),require('./renderer-ide-test-output-panel'));return;}
  root.rendererIdeActivityWiring=factory(root.rendererActivityView,root.rendererIdeTestRunnerWiring,root.rendererIdeTestOutputPanel);
})(typeof globalThis!=='undefined'?globalThis:this,function(views,runners,outputs){
  'use strict';
  // Keep the existing Tests/output workflow and Activity's exact-run selection together.
  function createIdeActivityWiring(deps){
    // follow: the ticket of the run request (selected config, its own root) the output follows; the wrapped
    // bridge run binds its request's ticket to its runId, or drops the follow when that run fails.
    let output=null,configId='',follow=null,pending=null;const tickets=new Map();const {state,workbench}=deps;
    const panel=id=>workbench.viewDeps(id);
    const getApi=()=>{const api=deps.windowRef?.jennyShell?.workspaceTestRunner;return typeof api?.run!=='function'?api||null:Object.create(api,{run:{value:a=>{const t=pending;pending=null;
      const done=r=>{if(t&&r?.runId&&!r.error&&r.available!==false)tickets.set(r.runId,t);else if(follow===t)follow=null;return r;};
      return Promise.resolve(api.run(a)).then(done,e=>{done();throw e;});}}});};
    const testRunnerWiring=runners.createIdeTestRunnerWiring({windowRef:deps.windowRef,getApi,actionButton:deps.actionButton,
      getMountEl:()=>panel('test-runner').getMountEl(),isActiveView:()=>workbench.isVisible('test-runner'),
      showShellErrorToast:deps.showShellErrorToast,onAvailabilityChange:deps.requestRender,
      onShowOutput:id=>{output=null;follow=null;configId=String(id||'');revealOutput();},
      onRunRequest:id=>{pending=output&&String(output.configId)===String(id)&&output.rootId===state.workspaceRoot?.rootId?{}:null;if(pending)follow=pending;},
      onOutputChange:id=>{const runId=testRunnerWiring.getLastRunOutput(id)?.runId,ticket=tickets.get(runId);tickets.delete(runId);
        if(ticket&&ticket===follow&&String(output?.configId)===String(id)){output=null;follow=null;}if(state.ui?.activeView==='ide')deps.requestRender();}});
    const testOutputPanel=outputs.createIdeTestOutputPanel({...panel('test-output'),actionButton:deps.actionButton,
      escapeHtml:deps.escapeHtml,onAskJenny:deps.onAskJenny,getRootPath:()=>state.workspaceRoot?.path||'',getSelection:()=>configId?{configId}:null,
      getRunOutput:id=>output?.record||testRunnerWiring.getLastRunOutput(id),
      getConfigLabel:id=>output?.label||testRunnerWiring.getConfigLabel(id)||id,
      canRunAgain:()=>!output||output.rootId===state.workspaceRoot?.rootId,
      onRunAgain:id=>{if(!output||output.rootId===state.workspaceRoot?.rootId)testRunnerWiring.runConfig(id);}});
    function revealOutput(){workbench.showPanel('test-output');testOutputPanel.render();}
    function showOutput(value){
      if(!value?.available||value.record?.runId!==value.runId)return false;
      output=value;configId=value.configId;follow=null;revealOutput();return true;
    }
    const view=views.createActivityView({...panel('activity'),defaultScope:'project',api:deps.windowRef?.jennyShell?.activity,testApi:deps.windowRef?.jennyShell?.workspaceTestRunner,
      isVisible:()=>state.ui?.activeView==='ide'&&workbench.isVisible('activity'),
      getContext:()=>({workspaceAvailable:!!state.workspaceRoot?.rootId,rootId:state.workspaceRoot?.rootId}),
      onDiagnostics:()=>deps.setActiveView?.('logs'),onOutput:showOutput,
      onCountChange:()=>{if(state.ui?.activeView==='ide')workbench.render();}});
    const activityView={...view,showOutput,clearOutput:()=>{output=null;}};
    return {testRunnerWiring,testOutputPanel,activityView};
  }
  return {createIdeActivityWiring};
});
