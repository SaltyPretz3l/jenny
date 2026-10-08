(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
  root.rendererDiagnosticsIssueExplanations = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) {
    return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) {
      return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m;
    }) : d;
  };
  // Copy resolves at call time (not at script load) so a locale catalog that
  // registers after this script still applies.
  var AREA_LABELS = {
    workspace: function () { return jt('diagnostics.issues.area.workspace', 'Workspace'); },
    localEngine: function () { return jt('diagnostics.issues.area.localEngine', 'Local engine'); },
    memory: function () { return jt('diagnostics.issues.area.memory', 'Memory'); },
    app: function () { return jt('diagnostics.issues.area.app', 'App'); },
    appWindow: function () { return jt('diagnostics.issues.area.appWindow', 'App window'); },
    models: function () { return jt('diagnostics.issues.area.models', 'Models'); },
    tools: function () { return jt('diagnostics.issues.area.tools', 'Tools'); },
  };
  var AREA_PREFIXES = {
    'sidecar.memory': 'memory', 'memory.': 'memory',
    'ide.': 'workspace', 'renderer.workspace': 'workspace',
    'sidecar.': 'localEngine', 'electron.': 'app', 'ipc.': 'app',
    'renderer.': 'appWindow', 'models.': 'models', 'ollama.': 'models',
    'llama': 'models', 'tool.': 'tools',
  };
  // Event-id entries, first match wins; `match` tells variants of one event apart.
  var ENTRIES = [
    {
      id: 'noWorkspaceFolder', events: ['ide.watch_start_failed', 'ide.tree_list_failed'],
      match: function (group) { return /no workspace root/i.test(string(group.message)); },
      title: function () { return jt('diagnostics.issues.explain.noWorkspaceFolder.title', 'No workspace folder is open'); },
      cause: function () { return jt('diagnostics.issues.explain.noWorkspaceFolder.cause', 'Workspace tried to list and watch files, but no folder is chosen. Choose one to use the file tree and file tools. If you only chat, you can ignore this.'); },
      action: { id: 'choose-workspace-folder', label: function () { return jt('diagnostics.issues.action.chooseFolder', 'Choose folder…'); } },
      area: AREA_LABELS.workspace,
    },
    {
      id: 'workspaceReadFailed', events: ['ide.watch_start_failed', 'ide.tree_list_failed'],
      title: function () { return jt('diagnostics.issues.explain.workspaceReadFailed.title', 'Workspace could not read the folder'); },
      cause: function () { return jt('diagnostics.issues.explain.workspaceReadFailed.cause', 'Jenny could not list or watch files in the chosen folder. Check that it still exists and that you can open it.'); },
      action: null, area: AREA_LABELS.workspace,
    },
    {
      id: 'slowRequest', events: ['ipc.handler_slow'],
      title: function () { return jt('diagnostics.issues.explain.slowRequest.title', 'A background request was slow'); },
      cause: function (group) {
        var nestedMs = group.data && group.data.durationMs;
        var ms = Number.isFinite(nestedMs) ? nestedMs : group.durationMs;
        if (!Number.isFinite(ms)) {
          return jt('diagnostics.issues.explain.slowRequest.causeNoDuration', 'An app request took longer than 1 s. This is common while a model loads. If it keeps happening, compare with Performance.');
        }
        var duration = ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s';
        return jt('diagnostics.issues.explain.slowRequest.cause', 'An app request took {duration} (the target is 1 s). This is common while a model loads. If it keeps happening, compare with Performance.', { duration: duration });
      },
      action: { id: 'show-diagnostics-performance', label: function () { return jt('diagnostics.issues.action.showPerformance', 'Show performance'); } },
      area: AREA_LABELS.app,
    },
    {
      // llama.cpp's own W-level stderr lines (chat engine or the catalog embedder);
      // its E lines keep the per-area fallback.
      id: 'engineNotice', events: ['llama.server.output', 'ollama.output'],
      match: function (group) { return group.severity === 'WARN'; },
      title: function () { return jt('diagnostics.issues.explain.engineNotice.title', 'A local engine printed a warning'); },
      cause: function () { return jt('diagnostics.issues.explain.engineNotice.cause', 'llama.cpp, which runs local models and the search-by-meaning index, prints notes while it loads a model. They are usually harmless. Check them only if a model fails to load or answers strangely.'); },
      action: null, area: AREA_LABELS.localEngine,
    },
  ];
  function string(value) { return typeof value === 'string' ? value : ''; }
  function rank(severity) { return severity === 'ERROR' ? 2 : severity === 'WARN' ? 1 : 0; }
  function areaFor(component) {
    var name = string(component).toLowerCase();
    var longest = '';
    Object.keys(AREA_PREFIXES).forEach(function (prefix) {
      if (name.startsWith(prefix) && prefix.length > longest.length) longest = prefix;
    });
    return (longest ? AREA_LABELS[AREA_PREFIXES[longest]] : AREA_LABELS.app)();
  }
  function explainIssue(group) {
    group = group || {};
    var event = string(group.event);
    for (var i = 0; i < ENTRIES.length; i += 1) {
      var entry = ENTRIES[i];
      if (entry.events.includes(event) && (!entry.match || entry.match(group))) {
        return {
          id: entry.id, title: entry.title(),
          cause: entry.cause(group),
          action: entry.action ? { id: entry.action.id, label: entry.action.label() } : null,
          area: entry.area(),
        };
      }
    }
    var area = areaFor(group.component);
    return {
      id: 'fallback:' + event,
      title: group.severity === 'ERROR'
        ? jt('diagnostics.issues.explain.fallback.errorTitle', '{area} reported an error', { area: area })
        : jt('diagnostics.issues.explain.fallback.warningTitle', '{area} reported a warning', { area: area }),
      cause: jt('diagnostics.issues.explain.fallback.cause', 'Jenny has no specific advice for this yet. Technical details show what was recorded.'),
      action: null, area: area,
    };
  }
  function mergeByExplanation(groups) {
    if (!Array.isArray(groups)) return [];
    var merged = new Map();
    groups.forEach(function (member) {
      var group = member || {};
      var explanation = explainIssue(group);
      var current = merged.get(explanation.id);
      if (!current) {
        current = { explanation: explanation, severity: string(group.severity), count: 0, ts: '', members: [] };
        merged.set(explanation.id, current);
      }
      current.members.push(member);
      current.count += Number.isFinite(group.count) ? group.count : 1;
      if (rank(group.severity) > rank(current.severity)) current.severity = group.severity;
      var ts = string(group.ts);
      if (ts > current.ts) current.ts = ts;
    });
    return Array.from(merged.values()).sort(function (a, b) {
      return rank(b.severity) - rank(a.severity) || (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0);
    });
  }
  return Object.freeze({ explainIssue: explainIssue, mergeByExplanation: mergeByExplanation });
});
