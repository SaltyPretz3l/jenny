const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const { resolveSkillsAuthority } = require('../../skills-project-scope');
const { registerKnowledgeIpcHandlers } = require('../knowledge-ipc-handlers');

// Guidance domain IPC: skills (one catalog per Workspace or per chat scope), the
// knowledge layer and the semantic catalog. The latter two stay unregistered
// while their feature flags are off.

// skills.getState(): the open Workspace's catalog (Settings). skills.getState
// ({ session_id?, project_id? }): one chat's catalog, its project scope read from
// the chat's canonical binding (a draft's project_id only before it persists).
function normalizeSkillsScopePayload(payload) {
  const valid = payload && typeof payload === 'object' && !Array.isArray(payload)
    && Object.keys(payload).every((key) => key === 'session_id' || key === 'project_id')
    && Object.values(payload).every((value) => typeof value === 'string' && value.length <= 256);
  if (!valid) throw new TypeError('Invalid skills scope.');
  return { sessionId: payload.session_id || '', projectId: payload.project_id || '' };
}

function registerGuidanceIpcHandlers(
  ipcMainLike, skillService, { authorization = {}, projectAuthority = null } = {}
) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'skills.getState': (_, payload) => (payload === undefined || payload === null
      ? skillService.getState()
      : skillService.getState({
        authority: resolveSkillsAuthority(projectAuthority, normalizeSkillsScopePayload(payload)),
      })),
    'skills.updateSettings': (_, patch) => skillService.updateSettings(patch),
    'skills.openScopeFolder': (_, scope) => skillService.openScopeFolder(scope),
  }, authorization);
}

function registerGuidanceKnowledgeIpcHandlers(ipcMain, {
  backendService,
  skillsService,
  knowledgeService,
  shellConfigService,
  dialog,
  getMainWindow,
  workspaceAuthorization,
}) {
  registerGuidanceIpcHandlers(
    ipcMain, skillsService, {
      authorization: workspaceAuthorization,
      projectAuthority: backendService?.projectAuthority || null,
    }
  );
  registerKnowledgeIpcHandlers(ipcMain, knowledgeService, {
    enabled: backendService?.featureFlags?.knowledge_layer === true,
    dialog,
    getOwnerWindow: getMainWindow,
    projectAuthority: backendService?.projectAuthority || null,
    authorization: workspaceAuthorization,
  });
  require('../catalog-ipc-handlers').registerCatalogIpcHandlers(ipcMain, {
    enabled: backendService?.featureFlags?.semantic_catalog === true,
    getCatalogService: () => backendService?.semanticCatalogService || null,
    shellConfigService, dialog, getOwnerWindow: getMainWindow, authorization: workspaceAuthorization,
  });
}

module.exports = {
  normalizeSkillsScopePayload,
  registerGuidanceIpcHandlers,
  registerGuidanceKnowledgeIpcHandlers,
};
