(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./diagnostics-issue-utils')); return; }
  root.rendererDiagnosticsIssueExplanations = factory(root.diagnosticsIssueUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (issueUtils) {
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
    'ai.': 'localEngine', 'runtime.': 'localEngine',
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
      // One down model server was 4-5 cards per launch: the sidecar's engine init
      // and catalog probe, then main's start/refresh records of the same failure.
      id: 'engineUnreachable',
      events: ['backend.start_model_unavailable', 'backend.managed_sidecar_initialize_failed',
        'sidecar.config_refresh_failed', 'ai.engines.factory.init_failed',
        'ai.engines.catalog.openai_compatible_discovery_failed'],
      match: function (group) {
        var data = group.data || {};
        return string(group.error_code) === 'CMP-AI-0002' || /CMP-AI-0002/.test(string(group.message))
          || data.error_type === 'EngineConnectionError' || data.classification === 'connection_error';
      },
      title: function () { return jt('diagnostics.issues.explain.engineUnreachable.title', "Jenny can't reach your model server"); },
      cause: function () { return jt('diagnostics.issues.explain.engineUnreachable.cause', 'The engine chosen in Settings is not answering, so chat cannot run until it does. Start that server, or choose another engine or model in Settings. Details shows the address Jenny tried.'); },
      action: null, area: AREA_LABELS.localEngine,
    },
    {
      id: 'workspaceGitFallback', events: ['ai.tools.workspace_manifest.orientation_degraded'],
      title: function () { return jt('diagnostics.issues.explain.workspaceGitFallback.title', 'Git could not read this workspace'); },
      cause: function () { return jt('diagnostics.issues.explain.workspaceGitFallback.cause', 'Jenny lists workspace files with Git, and that failed here, so it used a simpler listing. File tools still work. Run git status in the folder to see why; a folder owned by another Windows user is a common cause.'); },
      action: null, area: AREA_LABELS.workspace,
    },
    {
      // The toast's own copy, so Needs attention says what the warning means.
      id: 'ollamaTrayConflict', events: ['ollama.tray_app_conflict_detected'],
      title: function () { return jt('models.ollama.tray.conflictTitle', 'Ollama Tray App Conflict'); },
      cause: function () { return jt('models.ollama.tray.conflictMessage', "The Ollama tray app can silently kill Jenny's engine. Quit it or disable its Startup shortcut to prevent unexpected restarts."); },
      action: null, area: AREA_LABELS.models,
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
  function matchesEntry(entry, group) {
    return entry.events.includes(string(group.event)) && (!entry.match || entry.match(group)
      || Array.isArray(group.members) && group.members.some(function (member) { return member && matchesEntry(entry, member); }));
  }
  function matchIssueVariant(group) {
    return ENTRIES.some(function (entry) { return entry.match && matchesEntry(entry, group || {}); });
  }
  function areaFor(component, layer) {
    var name = string(component).toLowerCase();
    var longest = '';
    Object.keys(AREA_PREFIXES).forEach(function (prefix) {
      if (name.startsWith(prefix) && prefix.length > longest.length) longest = prefix;
    });
    var layerArea = { sidecar: 'localEngine', renderer: 'appWindow', electron: 'app' }[string(layer)];
    return (longest ? AREA_LABELS[AREA_PREFIXES[longest]] : AREA_LABELS[layerArea] || AREA_LABELS.app)();
  }
  function explainIssue(group) {
    group = group || {};
    var event = string(group.event);
    for (var i = 0; i < ENTRIES.length; i += 1) {
      var entry = ENTRIES[i];
      if (matchesEntry(entry, group)) {
        return {
          id: entry.id, title: entry.title(),
          cause: entry.cause(group),
          action: entry.action ? { id: entry.action.id, label: entry.action.label() } : null,
          area: entry.area(),
        };
      }
    }
    var area = areaFor(group.component, group.layer);
    return {
      id: 'fallback:' + event,
      title: group.severity === 'ERROR'
        ? jt('diagnostics.issues.explain.fallback.errorTitle', '{area} reported an error', { area: area })
        : jt('diagnostics.issues.explain.fallback.warningTitle', '{area} reported a warning', { area: area }),
      cause: jt('diagnostics.issues.explain.fallback.cause', 'Jenny has no specific advice for this yet. Open Details to see what was recorded.'),
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
      if (issueUtils.severityRank(group.severity) > issueUtils.severityRank(current.severity)) current.severity = group.severity;
      var ts = string(group.ts);
      var chronological = issueUtils.compareEntriesChronologically({ ts: ts }, { ts: current.ts });
      if (chronological > 0 || chronological === 0 && ts > current.ts) current.ts = ts;
    });
    return Array.from(merged.values()).sort(function (a, b) {
      return issueUtils.severityRank(b.severity) - issueUtils.severityRank(a.severity)
        || issueUtils.compareEntriesChronologically(b, a) || (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0);
    });
  }
  return Object.freeze({ explainIssue: explainIssue, mergeByExplanation: mergeByExplanation, matchIssueVariant: matchIssueVariant });
});
