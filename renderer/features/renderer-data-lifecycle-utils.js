(function exposeDataLifecycleUtils(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.dataLifecycleUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function dataLifecycleUtilsFactory() {
  'use strict';

  function formatCount(value, singular, plural) {
    var count = Math.max(0, Math.floor(Number(value) || 0));
    return count.toLocaleString() + ' ' + (count === 1 ? singular : plural);
  }

  function formatBytes(value) {
    var bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return Math.round(bytes) + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var index = -1;
    do {
      bytes /= 1024;
      index += 1;
    } while (bytes >= 1024 && index < units.length - 1);
    return bytes.toFixed(bytes >= 10 ? 0 : 1) + ' ' + units[index];
  }

  function normalizeOverview(result) {
    var source = result && result.ok ? result : {};
    var counts = source.counts || {};
    return {
      chats: Math.max(0, Number(counts.chats) || 0),
      attachments: Math.max(0, Number(counts.attachments) || 0),
      memory: Math.max(0, Number(counts.memory) || 0),
      workspace: Math.max(0, Number(counts.workspace) || 0),
      workspaceAvailable: source.workspace && source.workspace.available === true,
      workspaceName: String(source.workspace && source.workspace.name || ''),
      defaultArchiveRoot: String(source.defaultArchiveRoot || ''),
      appearance: source.appearance && typeof source.appearance === 'object'
        ? source.appearance
        : { paletteId: 'obsidian' },
    };
  }

  return { formatBytes: formatBytes, formatCount: formatCount, normalizeOverview: normalizeOverview };
});
