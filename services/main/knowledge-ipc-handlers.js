'use strict';

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { t } = require('../i18n-main');

const MAX_ID_CHARS = 256;

function failure(reason) {
  return { ok: false, reason };
}

function normalizeToken(value) {
  const token = String(value || '').trim();
  return token && token.length <= MAX_ID_CHARS ? token : '';
}

function authorityFailure(error) {
  return failure(normalizeToken(error?.reason) || 'project_authority_unavailable');
}

function captureKnowledgeAuthority(projectAuthority, payload) {
  if (!projectAuthority || typeof projectAuthority.captureSession !== 'function'
    || typeof projectAuthority.requireCurrent !== 'function') {
    return { error: failure('project_authority_unavailable') };
  }
  const sessionId = normalizeToken(payload?.session_id);
  const projectId = normalizeToken(payload?.project_id);
  if (!sessionId || !projectId) return { error: failure('invalid_scope') };
  try {
    const authority = projectAuthority.captureSession(sessionId);
    if (authority?.project_id !== projectId) return { error: failure('project_mismatch') };
    return { authority, projectId, sessionId };
  } catch (error) {
    return { error: authorityFailure(error) };
  }
}

function sameAuthority(left, right) {
  return Boolean(left && right
    && left.project_id === right.project_id
    && left.root_path === right.root_path
    && left.root_id === right.root_id
    && left.root_revision === right.root_revision
    && left.device_id === right.device_id
    && left.inode === right.inode);
}

function requireCurrent(projectAuthority, captured) {
  try {
    const sessionAuthority = projectAuthority.captureSession(captured.sessionId);
    if (!sameAuthority(sessionAuthority, captured.authority)) {
      return failure('project_authority_stale');
    }
    projectAuthority.requireCurrent(captured.authority);
    return null;
  } catch (error) {
    return authorityFailure(error);
  }
}

function revisionFrom(payload) {
  const value = payload?.expected_revision;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function scopedMutationInput(captured, payload, extra) {
  const expectedRevision = revisionFrom(payload);
  if (expectedRevision === null) return { error: failure('invalid_expected_revision') };
  return {
    value: {
      ...extra,
      projectId: captured.projectId,
      expectedRevision,
    },
  };
}

function registerKnowledgeIpcHandlers(
  ipcMainLike,
  knowledgeService,
  {
    enabled = false,
    dialog = null,
    getOwnerWindow = () => null,
    projectAuthority,
    authorization,
  } = {},
) {
  if (!enabled || !knowledgeService) return [];

  // Isolated/legacy UI compositions predate session project authority. Keep
  // that explicit mode compatible, while a configured-but-unavailable owner
  // fails closed instead of falling back to General.
  const legacyMode = projectAuthority === undefined;
  if (legacyMode) {
    return registerIpcInvokeHandlers(ipcMainLike, {
      'knowledge.getState': () => knowledgeService.getStateSnapshot(),
      'knowledge.addFolder': (_, payload) => knowledgeService.addFolder(payload || {}),
      'knowledge.removeFolder': (_, payload) => knowledgeService.removeFolder(payload || {}),
      'knowledge.chooseFolder': async () => {
        if (!dialog || typeof dialog.showOpenDialog !== 'function') {
          return failure('picker_unavailable');
        }
        const result = await dialog.showOpenDialog(getOwnerWindow(), {
          title: t('main.dialog.knowledge.addFolder', 'Add Knowledge Folder'),
          properties: ['openDirectory'],
        });
        if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
          return failure('canceled');
        }
        return knowledgeService.addFolder({ path: result.filePaths[0] });
      },
    }, authorization);
  }

  function capture(payload) {
    return captureKnowledgeAuthority(projectAuthority, payload);
  }

  function mutate(captured, input) {
    const stale = requireCurrent(projectAuthority, captured);
    return stale || knowledgeService.addFolder(input);
  }

  return registerIpcInvokeHandlers(ipcMainLike, {
    'knowledge.getState': (_, payload) => {
      const captured = capture(payload);
      if (captured.error) return captured.error;
      const stale = requireCurrent(projectAuthority, captured);
      return stale || knowledgeService.getStateSnapshot({ projectId: captured.projectId });
    },
    'knowledge.addFolder': (_, payload) => {
      const captured = capture(payload);
      if (captured.error) return captured.error;
      const input = scopedMutationInput(captured, payload, { path: payload?.path });
      if (input.error) return input.error;
      return mutate(captured, input.value);
    },
    'knowledge.removeFolder': (_, payload) => {
      const captured = capture(payload);
      if (captured.error) return captured.error;
      const input = scopedMutationInput(captured, payload, { id: payload?.id });
      if (input.error) return input.error;
      const stale = requireCurrent(projectAuthority, captured);
      return stale || knowledgeService.removeFolder(input.value);
    },
    'knowledge.chooseFolder': async (_, payload) => {
      const captured = capture(payload);
      if (captured.error) return captured.error;
      const input = scopedMutationInput(captured, payload, {});
      if (input.error) return input.error;
      if (!dialog || typeof dialog.showOpenDialog !== 'function') {
        return failure('picker_unavailable');
      }
      const result = await dialog.showOpenDialog(getOwnerWindow(), {
        title: t('main.dialog.knowledge.addFolder', 'Add Knowledge Folder'),
        properties: ['openDirectory'],
      });
      if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
        return failure('canceled');
      }
      return mutate(captured, { ...input.value, path: result.filePaths[0] });
    },
  }, authorization);
}

module.exports = {
  captureKnowledgeAuthority,
  registerKnowledgeIpcHandlers,
};
