'use strict';

// Settings > Memory page bridge (agentic memory v2, row 58 W4). Each method
// takes one plain request object; the backend validates the project it names
// and every other field. Export saves through the shared save-file handler
// (protected-root and junction checks); USER.md / MEMORY.md open through the
// personality workspace's injected opener.

const { buildSaveFileHandler } = require('../save-file-handler');
const { isPlainObject } = require('../value-utils');

const DEFAULT_EXPORT_TITLE = 'Export memories';
const MAX_TITLE_CHARS = 200;

const plainRequest = value => (isPlainObject(value) ? value : {});

function createMemorySettingsIpcHandlers({
  backendService, personalityWorkspace, dialog, getMainWindow, getProtectedRoots, log,
} = {}) {
  let saveFile = null;
  // Built on first use: the save handler requires a real dialog.
  const save = payload => {
    if (!saveFile) {
      saveFile = buildSaveFileHandler({
        dialog,
        getMainWindow,
        getProtectedRoots,
        log: { write: (level, event, details) => log?.(level, event, details) },
      });
    }
    return saveFile(null, payload);
  };

  async function exportMarkdown(request) {
    const built = await backendService.exportMemoriesMarkdown({ projectId: request.projectId });
    if (!built?.ok) return built;
    const title = typeof request.title === 'string' ? request.title.trim().slice(0, MAX_TITLE_CHARS) : '';
    try {
      const result = await save({
        defaultName: built.defaultName,
        content: built.markdown,
        format: 'markdown',
        title: title || DEFAULT_EXPORT_TITLE,
      });
      return result?.canceled ? { ok: true, saved: false } : { ok: true, saved: true, path: result.path };
    } catch (_error) {
      // The save handler already logged the path-safe reason.
      return { ok: false, reason: 'save_failed' };
    }
  }

  function openContextFile(request) {
    if (typeof personalityWorkspace?.openContextFile !== 'function') return { ok: false, reason: 'unavailable' };
    return personalityWorkspace.openContextFile(typeof request.name === 'string' ? request.name : '');
  }

  return {
    'memory.listArchived': (_, request) => backendService.listArchivedMemories(plainRequest(request)),
    'memory.restore': (_, request) => backendService.restoreArchivedMemory(plainRequest(request)),
    'memory.erase': (_, request) => backendService.eraseMemory(plainRequest(request)),
    'memory.clearForgotten': (_, request) => backendService.clearForgottenMemories(plainRequest(request)),
    'memory.listOperations': (_, request) => backendService.listMemoryOperations(plainRequest(request)),
    'memory.setAlwaysOn': (_, request) => backendService.setMemoryAlwaysOn(plainRequest(request)),
    'memory.exportMarkdown': (_, request) => exportMarkdown(plainRequest(request)),
    'memory.openContextFile': (_, request) => openContextFile(plainRequest(request)),
  };
}

module.exports = { createMemorySettingsIpcHandlers };
