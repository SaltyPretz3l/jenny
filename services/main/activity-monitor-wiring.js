"use strict";
const {createActivityProjection} = require('../activity-projection');
const {registerIpcInvokeHandlers} = require('../ipc-contract');
const {resolveRealPathSafe} = require('../backend/path-utils');
const {workspaceRootId} = require('../workspace-root-identity');
function captureWorkspaceActivityScope(backendService, shellConfigService) {
  const root=resolveRealPathSafe(shellConfigService?.getToolsWorkspaceRoot?.() || '');
  if (!root) return {schema_version:1};
  const rootId=workspaceRootId(root);
  const projects=(backendService.projectService?.list?.() || []).filter(project=>project.root_id === rootId);
  const project=projects.length === 1 ? projects[0] : null;
  return {schema_version:1,project_id:project?.id || null,session_id:null,root_id:rootId,root_revision:project?.root_revision ?? null};
}
function createActivityScopeResolver(backendService, shellConfigService) {
  return scope=>{
    if (!scope || Array.isArray(scope)) return null;
    const keys=Object.keys(scope).sort().join(',');
    if (scope.kind === 'all' && keys === 'kind') return {scope:{kind:'all'},matches:()=>true};
    if (scope.kind === 'workspace' && keys === 'kind') {
      const captured=captureWorkspaceActivityScope(backendService,shellConfigService);
      if (!captured.root_id) return null;
      return {scope:{kind:'workspace',root_id:captured.root_id},matches:row=>row.scope.root_id === captured.root_id};
    }
    if (scope.kind === 'session' && keys === 'kind,session_id' && typeof scope.session_id === 'string') {
      const authority=backendService.projectAuthority.captureSession(scope.session_id);
      return {scope:{kind:'session',session_id:scope.session_id},
        matches:row=>row.scope.session_id === scope.session_id && row.scope.project_id === authority.project_id};
    }
    if (scope.kind === 'project' && keys === 'kind,project_id' && typeof scope.project_id === 'string') {
      const authority=backendService.projectAuthority.captureProject(scope.project_id);
      return {scope:{kind:'project',project_id:authority.project_id},matches:row=>row.scope.project_id === authority.project_id};
    }
    return null;
  };
}
function registerActivityMonitor({ipcMain,backendService,shellConfigService,source,authorization,sendBridgeEvent}) {
  const projection=createActivityProjection({source,
    enabled:()=>backendService.featureFlags?.activity_monitor === true,
    resolveScope:createActivityScopeResolver(backendService,shellConfigService),
    resolveProjectName:id=>id?backendService.projectService?.get?.(id)?.name:null,
    notify:payload=>sendBridgeEvent('activity.onChanged',payload)});
  const getDetail=payload=>projection.getDetail(payload);
  registerIpcInvokeHandlers(ipcMain,{
    'activity.getSnapshot':(_,payload)=>projection.getSnapshot(payload),
    'activity.getDetail':(_,payload)=>getDetail(payload),
    'activity.subscribe':(_,payload)=>projection.subscribe(payload),
    'workspaceTestRunner.abortRun':(_,payload)=>{
      const detail=getDetail(payload);
      if (!detail.available || !detail.item.controls.stop) return {aborted:false,reason:detail.reason || 'not_active'};
      return source.abortRun({expectedRunId:detail.item.source_id});
    },
    'workspaceTestRunner.getRunOutput':(_,payload)=>{
      const detail=getDetail(payload);
      if (!detail.available) return {available:false,reason:detail.reason};
      const output=source.getRunOutput(detail.item.source_id);
      return output ? {available:true,record:output,label:detail.item.label,configId:detail.item.config_id,
        rootId:detail.item.root_id,runId:detail.item.source_id} : {available:false,reason:'output_unavailable'};
    },
  },authorization);
  return projection;
}
module.exports={registerActivityMonitor,createActivityScopeResolver,captureWorkspaceActivityScope};
