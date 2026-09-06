/* renderer/chat/renderer-composer-v2-model.js - Pure Composer V2 derivation helpers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererComposerV2Model = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TOOL_TOGGLE_CATEGORIES = Object.freeze([
    { id: 'web_search', label: 'Web Search', icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M2 8h12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M8 2c1.8 1.7 2.8 3.8 2.8 6S9.8 12.3 8 14c-1.8-1.7-2.8-3.8-2.8-6S6.2 3.7 8 2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' },
    { id: 'Bash', label: 'Terminal', icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="2.2" stroke="currentColor" stroke-width="1.3"/><path d="M5 7l2 1.5L5 10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 10h2.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' },
    { id: 'python_execute', label: 'Python', icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 5L3 8l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 5l3 3-3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 3.6l-2 8.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' },
    { id: 'file_tools', label: 'Files', icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 2h5l3.5 3.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 2v3.5h3.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' },
  ]);

  /* Persistent tools.* config key per toggle category (features.updateSettings bridge). */
  const TOOL_CATEGORY_CONFIG_KEYS = Object.freeze({
    web_search: 'web',
    Bash: 'bash',
    python_execute: 'pythonRuntime',
    file_tools: 'fileTools',
  });

  const TOOL_CATEGORY_SESSION_KEYS = Object.freeze({
    web_search: 'web',
    Bash: 'terminal',
    python_execute: 'python',
    file_tools: 'files',
  });

  const PASTE_WARN_BYTES = 100 * 1024;
  const PASTE_REJECT_BYTES = 1024 * 1024;

  function getTextByteLength(value) {
    const text = String(value || '');
    let sizeBytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code < 0x80) {
        sizeBytes += 1;
      } else if (code < 0x800) {
        sizeBytes += 2;
      } else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          sizeBytes += 4;
          index += 1;
        } else {
          sizeBytes += 3;
        }
      } else {
        sizeBytes += 3;
      }
    }
    return sizeBytes;
  }

  function makePasteResult(accepted, sizeBytes, warned) {
    return {
      accepted: accepted !== false,
      sizeBytes: Math.max(0, Number(sizeBytes) || 0),
      warned: warned === true,
    };
  }

  function normalizeToolEntry(entry) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return {
        name: String(entry.name || '').trim(),
        available: entry.available !== false,
        reason: String(entry.reason || '').trim(),
      };
    }
    return {
      name: String(entry || '').trim(),
      available: true,
      reason: '',
    };
  }

  function getToolCategoryId(name) {
    const normalized = String(name || '').trim();
    if (normalized === 'web_search') return 'web_search';
    if (normalized === 'Bash' || normalized === 'run_command') return 'Bash';
    if (normalized === 'python_execute') return 'python_execute';
    if (
      normalized === 'Read' || normalized === 'Write' || normalized === 'Edit'
      || normalized === 'Glob' || normalized === 'Grep'
      || normalized === 'edit_file' || normalized === 'write_file' || normalized === 'read_file'
      || normalized === 'glob_files' || normalized === 'grep_search' || normalized === 'list_dir'
    ) {
      return 'file_tools';
    }
    return '';
  }

  return {
    PASTE_REJECT_BYTES,
    PASTE_WARN_BYTES,
    TOOL_CATEGORY_CONFIG_KEYS,
    TOOL_CATEGORY_SESSION_KEYS,
    TOOL_TOGGLE_CATEGORIES,
    getTextByteLength,
    getToolCategoryId,
    makePasteResult,
    normalizeToolEntry,
  };
});
