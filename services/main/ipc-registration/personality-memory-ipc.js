const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const { resolveSkillsAuthority } = require('../../skills-project-scope');
const { PERSONALITY_ERROR_CODES } = require('../../backend/error-codes');
const { isPlainObject } = require('../../value-utils');
const { createMemorySettingsIpcHandlers } = require('../memory-settings-ipc-handlers');
const { normalizeSkillsScopePayload } = require('./guidance-ipc');

// Personality and memory domain IPC: the personality v3 note/about-you bodies
// joined to the shell-config agent name, the context-file notes, and the
// approved/pending memory channels with their Settings import/export.

// Personality v3 agent-name seam. The name is shell-config state, not a
// workspace file, so the personality IPC composes the two owners here. Both
// helpers degrade to the default name rather than throwing across the preload
// seam: a failed name write must not discard the note the user just typed.
function readAgentName(shellConfigService) {
  try {
    const identity = typeof shellConfigService?.getAssistantIdentity === 'function'
      ? shellConfigService.getAssistantIdentity()
      : null;
    return String(identity?.agentName || '').trim() || 'Jenny';
  } catch (_error) {
    return 'Jenny';
  }
}

// Returns `{ agentName, persisted }`. `persisted` is the honest signal the
// caller needs: reporting ok:true with the OLD name after a failed write is how
// a user silently loses a rename. The name is compared by nothing -- the
// service clips to 80 chars, so only the write outcome decides.
function persistAgentName(shellConfigService, value, logEvent) {
  const next = String(value ?? '').trim();
  if (!next) return { agentName: readAgentName(shellConfigService), persisted: true };
  if (typeof shellConfigService?.updateAssistantIdentity !== 'function') {
    return { agentName: readAgentName(shellConfigService), persisted: false };
  }
  try {
    const identity = shellConfigService.updateAssistantIdentity({ agentName: next });
    return {
      agentName: String(identity?.agentName || next).trim() || 'Jenny',
      persisted: true,
    };
  } catch (error) {
    logEvent?.('WARN', 'personality.agent_name_write_failed', {
      reason: String(error?.code || 'write_failed').slice(0, 64),
    });
    return { agentName: readAgentName(shellConfigService), persisted: false };
  }
}

function registerPersonalityIpcHandlers(ipcMain, {
  backendService,
  shellConfigService,
  personalityWorkspace,
  log,
  workspaceAuthorization,
}) {
  const personalityPreviewOptions = (payload, bodyFields = []) => {
    const source = payload ?? {};
    const fields = ['session_id', 'project_id', ...bodyFields];
    if (typeof source !== 'object' || Array.isArray(source)
      || Object.keys(source).some((key) => !fields.includes(key))) throw new TypeError('Invalid personality scope.');
    const scope = Object.fromEntries(Object.entries(source).filter(([key]) => key === 'session_id' || key === 'project_id'));
    return {
      projectId: resolveSkillsAuthority(backendService?.projectAuthority, normalizeSkillsScopePayload(scope)).project_id,
      uiLanguage: shellConfigService?.getUiLanguage?.() || 'en',
    };
  };
  registerIpcInvokeHandlers(ipcMain, {
    // Personality v3. The agent NAME lives in shell-config (assistantIdentity)
    // while the note/about-you bodies live in the personality workspace, so the
    // one-call contract is composed here rather than inside either service.
    'personality.getState': (_, payload) => personalityWorkspace.getState({
      ...personalityPreviewOptions(payload),
      agentName: readAgentName(shellConfigService),
    }),
    'personality.save': async (_, payload) => {
      const options = personalityPreviewOptions(payload, ['agentName', 'personality', 'user', 'force']);
      const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      const name = Object.prototype.hasOwnProperty.call(source, 'agentName')
        ? persistAgentName(shellConfigService, source.agentName, log)
        : { agentName: readAgentName(shellConfigService), persisted: true };
      // Files are saved either way -- a rejected rename must not discard the
      // note the user just typed -- but the result has to say the name failed.
      const result = await personalityWorkspace.save({ ...source, ...options, agentName: name.agentName });
      if (name.persisted) return result;
      return {
        ...result,
        ok: false,
        code: result?.code || PERSONALITY_ERROR_CODES.SAVE_PARTIAL_FAILURE,
        failed: [...(Array.isArray(result?.failed) ? result.failed : []), 'agentName'],
        agentName: name.agentName,
      };
    },
    'personality.clear': (_, payload) => personalityWorkspace.clear({
      ...personalityPreviewOptions(payload, ['agentName']),
      agentName: readAgentName(shellConfigService),
    }),
    'personality.openWorkspaceFolder': () => personalityWorkspace.openWorkspaceFolder(),
    'memory.contextFiles.getState': () => personalityWorkspace.getNotesState(),
    'memory.contextFiles.writeFile': (_, payload) => personalityWorkspace.writeNotes(payload),
    'memory.contextFiles.resetFile': () => personalityWorkspace.resetNotes(),
  }, workspaceAuthorization);
}

const plainOptions = (options) => (isPlainObject(options) ? options : {});

function registerMemoryIpcHandlers(ipcMainLike, {
  backendService,
  personalityWorkspace,
  dialog,
  getMainWindow,
  getProtectedRoots,
  log,
  ipcAuthorization,
}) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'memory.status': () => backendService.getMemoryStatus(),
    'memory.save': (_, sessionId, candidate) =>
      backendService.saveMemoryForSession(sessionId, candidate),
    'memory.listApproved': () => backendService.listApprovedMemories(),
    'memory.listPending': () => backendService.listPendingMemories(),
    'memory.update': (_, memoryId, patch, projectId, options) =>
      backendService.updateApprovedMemory(memoryId, patch, projectId, plainOptions(options)),
    'memory.delete': (_, memoryId, projectId, options) =>
      backendService.deleteApprovedMemory(memoryId, projectId, plainOptions(options)),
    // Settings names the listed candidate's own project; the chat card omits it.
    'memory.acceptPending': (_, sessionId, contentFingerprint, projectId) =>
      backendService.acceptPendingMemory(sessionId, contentFingerprint, projectId),
    'memory.undoChange': (_, operationId, projectId) =>
      backendService.undoApprovedMemoryChange(operationId, projectId),
    'memory.deletePending': (_, sessionId, contentFingerprint, projectId) =>
      backendService.deletePendingMemory(sessionId, contentFingerprint, projectId),
    'memory.undo': (_, request) =>
      backendService.undoMemoryOperation(request?.sessionId, request?.operationId),
    ...createMemorySettingsIpcHandlers({
      backendService, personalityWorkspace, dialog, getMainWindow, getProtectedRoots, log,
    }),
  }, ipcAuthorization);
}

module.exports = {
  registerMemoryIpcHandlers,
  registerPersonalityIpcHandlers,
};
