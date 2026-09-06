'use strict';

const { workspaceRootId } = require('./workspace-root-identity');
const {
  createWorkspaceIdeStoreFromFlat,
  normalizeWorkspaceIdeStore,
} = require('./workspace-ide-config-schema');

function isStructuredWorkspaceIde(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (
      Object.prototype.hasOwnProperty.call(value, 'preferences')
      || Object.prototype.hasOwnProperty.call(value, 'rootLru')
      || Object.prototype.hasOwnProperty.call(value, 'roots')
    );
}

function migrateWorkspaceIdeV36(flatWorkspaceIde, toolsWorkspaceRoot) {
  if (isStructuredWorkspaceIde(flatWorkspaceIde)) {
    return normalizeWorkspaceIdeStore(flatWorkspaceIde);
  }
  return createWorkspaceIdeStoreFromFlat(
    flatWorkspaceIde,
    workspaceRootId(toolsWorkspaceRoot) || ''
  );
}

function collectWorkspaceIdeDropCounts(value, toolsWorkspaceRoot) {
  const counts = Object.create(null);
  const recordDrop = (reason, amount = 1) => {
    counts[reason] = (counts[reason] || 0) + Math.max(1, Number(amount) || 1);
  };
  if (isStructuredWorkspaceIde(value)) {
    normalizeWorkspaceIdeStore(value, { onDrop: recordDrop });
    return counts;
  }
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const hasLocalState = (Array.isArray(source.openTabs) && source.openTabs.length > 0)
    || (Array.isArray(source.expandedDirs) && source.expandedDirs.length > 0)
    || Boolean(String(source.activeTabPath || '').trim())
    || Boolean(String(source.previewPath || '').trim())
    || (source.activeStageSurface && source.activeStageSurface !== 'editor');
  if (!workspaceRootId(toolsWorkspaceRoot) && hasLocalState) recordDrop('unscoped_root_state');
  return counts;
}

module.exports = { collectWorkspaceIdeDropCounts, migrateWorkspaceIdeV36 };
