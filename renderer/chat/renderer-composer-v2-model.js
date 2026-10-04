/* renderer/chat/renderer-composer-v2-model.js - Pure Composer V2 derivation helpers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererComposerV2Model = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (k, d, p) => {
    const translate = globalThis.jennyI18n?.t || globalThis.jennyI18nFallback;
    return translate ? translate(k, d, p) : p ? String(d).replace(/\{(\w+)\}/g,
      (m, n) => Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m) : d;
  };
  const TOOL_TOGGLE_CATEGORIES = Object.freeze([
    { id: 'web_search', label: jt('composer.tools.webSearch', 'Web Search'), icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M2 8h12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M8 2c1.8 1.7 2.8 3.8 2.8 6S9.8 12.3 8 14c-1.8-1.7-2.8-3.8-2.8-6S6.2 3.7 8 2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' },
    { id: 'Bash', label: jt('composer.tools.terminal', 'Terminal'), icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="2.2" stroke="currentColor" stroke-width="1.3"/><path d="M5 7l2 1.5L5 10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 10h2.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' },
    { id: 'python_execute', label: 'Python', icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 5L3 8l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 5l3 3-3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 3.6l-2 8.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' },
    { id: 'file_tools', label: jt('composer.tools.files', 'Files'), icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 2h5l3.5 3.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 2v3.5h3.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' },
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

  const familyDefinitions = [
    ['files', 'project', () => jt('composer.toolFamily.files.label', 'Files'), () => jt('composer.toolFamily.files.description', 'Read, edit, move and search'), 'fileTools', 3],
    ['terminal', 'project', () => jt('composer.toolFamily.terminal.label', 'Terminal'), () => jt('composer.toolFamily.terminal.description', 'Commands, scripts and background jobs'), 'bash', 1],
    ['git', 'project', () => jt('composer.toolFamily.git.label', 'Git'), () => jt('composer.toolFamily.git.description', 'Status, history, diffs and worktrees'), '', '<path d="M4 3v7a3 3 0 0 0 3 3h3M4 7h5a3 3 0 0 0 3-3"/><circle cx="4" cy="3" r="1.5"/><circle cx="12" cy="3" r="1.5"/>'],
    ['python', 'project', () => jt('composer.toolFamily.python.label', 'Python'), () => jt('composer.toolFamily.python.description', 'Run code in a scratch runtime'), 'pythonRuntime', 2],
    ['code', 'project', () => jt('composer.toolFamily.code.label', 'Code intelligence'), () => jt('composer.toolFamily.code.description', 'Diagnostics, symbols and references'), 'lsp', '<path d="m5 4-4 4 4 4m6-8 4 4-4 4M9 2 7 14"/>'],
    ['checks', 'project', () => jt('composer.toolFamily.checks.label', 'Preview and checks'), () => jt('composer.toolFamily.checks.description', 'Preview the workspace and run saved checks'), '', '<rect x="2" y="2" width="12" height="12" rx="2"/><path d="m4 8 3 3 5-6"/>'],
    ['artifacts', 'create', () => jt('composer.toolFamily.artifacts.label', 'Artifacts and diagrams'), () => jt('composer.toolFamily.artifacts.description', 'Pages, charts and diagrams'), '', '<rect x="1" y="2" width="5" height="4" rx="1"/><rect x="10" y="10" width="5" height="4" rx="1"/><path d="M4 6v6h6"/>'],
    ['images', 'create', () => jt('composer.toolFamily.images.label', 'Images'), () => jt('composer.toolFamily.images.description', 'Generate images locally'), '', '<rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="6" cy="6" r="1"/><path d="m2 12 4-4 3 3 2-2 3 3"/>'],
    ['web', 'reach', () => jt('composer.toolFamily.web.label', 'Web'), () => jt('composer.toolFamily.web.description', 'Search and read pages'), 'web', 0],
    ['knowledge', 'reach', () => jt('composer.toolFamily.knowledge.label', 'Knowledge'), () => jt('composer.toolFamily.knowledge.description', 'Search your knowledge folders'), '', '<path d="M8 4C6 2 3 2 1 3v10c2-1 5-1 7 1 2-2 5-2 7-1V3c-2-1-5-1-7 1Zm0 0v10"/>'],
    ['home', 'reach', () => jt('composer.toolFamily.home.label', 'Home and tasks'), () => jt('composer.toolFamily.home.description', 'Calendar, reminders, tasks and automations'), '', '<path d="m1 7 7-6 7 6M3 6v8h10V6M6 14V9h4v5"/>'],
    ['helpers', 'reach', () => jt('composer.toolFamily.helpers.label', 'Helpers'), () => jt('composer.toolFamily.helpers.description', 'Delegate read-only research'), 'subagents', '<circle cx="5" cy="5" r="2"/><circle cx="12" cy="6" r="2"/><path d="M1 14v-2a4 4 0 0 1 8 0v2m1-4a3 3 0 0 1 5 2v2"/>'],
  ];
  const SURFACE_FAMILY_UI = Object.freeze(familyDefinitions.map(([id, section, label, description, configKey, icon]) => Object.freeze({
    id, section, label, description, configKey,
    icon: typeof icon === 'number' ? TOOL_TOGGLE_CATEGORIES[icon].icon
      : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' + icon + '</svg>',
  })));

  function familyLabel(id) {
    return SURFACE_FAMILY_UI.find((entry) => entry.id === id)?.label() ?? '';
  }

  function familyDescription(id) {
    return SURFACE_FAMILY_UI.find((entry) => entry.id === id)?.description() ?? '';
  }

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
    const tool = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : { name: entry };
    const stringField = (key) => typeof tool[key] === 'string' ? tool[key].trim() : '';
    return {
      name: String(tool.name || '').trim(), available: tool.available !== false,
      reason: stringField('reason'), surfaceFamily: stringField('surfaceFamily'),
      connectionId: stringField('connectionId'), serverName: stringField('serverName'),
      sourceKind: stringField('sourceKind'), toolFamily: stringField('toolFamily'),
      sideEffecting: tool.sideEffecting === true,
      approvalDefault: tool.approvalDefault === 'ask' ? 'ask' : 'auto',
      lockdownAvailable: tool.lockdownAvailable === true,
    };
  }

  return {
    SURFACE_FAMILY_UI,
    familyLabel,
    familyDescription,
    PASTE_REJECT_BYTES,
    PASTE_WARN_BYTES,
    TOOL_CATEGORY_CONFIG_KEYS,
    TOOL_CATEGORY_SESSION_KEYS,
    TOOL_TOGGLE_CATEGORIES,
    getTextByteLength,
    makePasteResult,
    normalizeToolEntry,
  };
});
