'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { explainIssue, mergeByExplanation } = require('../renderer/shared/diagnostics-issue-explanations');
const { groupIssues } = require('../renderer/shared/diagnostics-issue-utils');

test('workspace events distinguish a missing folder from a read failure', () => {
  for (const event of ['ide.watch_start_failed', 'ide.tree_list_failed']) {
    assert.deepEqual(explainIssue({ event, message: 'Failed: NO WORKSPACE ROOT is set' }), {
      id: 'noWorkspaceFolder',
      title: 'No workspace folder is open',
      cause: 'Workspace tried to list and watch files, but no folder is chosen. Choose one to use the file tree and file tools. If you only chat, you can ignore this.',
      action: { id: 'choose-workspace-folder', label: 'Choose folder\u2026' },
      area: 'Workspace',
    });
    const failed = {
      id: 'workspaceReadFailed',
      title: 'Workspace could not read the folder',
      cause: 'Jenny could not list or watch files in the chosen folder. Check that it still exists and that you can open it.',
      action: null,
      area: 'Workspace',
    };
    assert.deepEqual(explainIssue({ event, message: 'Permission denied' }), failed);
    assert.deepEqual(explainIssue({ event }), failed);
  }
});

// Gate 2026-10-14 F4: the tray conflict showed the generic "no specific advice".
test('the Ollama tray-app conflict explains itself with the toast copy', () => {
  assert.deepEqual(explainIssue({ event: 'ollama.tray_app_conflict_detected', severity: 'WARN' }), {
    id: 'ollamaTrayConflict',
    title: 'Ollama Tray App Conflict',
    cause: "The Ollama tray app can silently kill Jenny's engine. Quit it or disable its Startup shortcut to prevent unexpected restarts.",
    action: null,
    area: 'Models',
  });
});

test('slow requests format finite nested or top-level durations', () => {
  for (const [fields, duration] of [
    [{ data: { durationMs: 1532 } }, '1.5 s'],
    [{ durationMs: 240 }, '240 ms'],
    [{ data: { durationMs: 240 } }, '240 ms'],
    [{ durationMs: 1532 }, '1.5 s'],
    [{ durationMs: 999.4 }, '999 ms'],
    [{ durationMs: 1000 }, '1.0 s'],
    [{ data: { durationMs: NaN }, durationMs: 240 }, '240 ms'],
  ]) {
    assert.deepEqual(explainIssue({ event: 'ipc.handler_slow', ...fields }), {
      id: 'slowRequest',
      title: 'A background request was slow',
      cause: `An app request took ${duration} (the target is 1 s). This is common while a model loads. If it keeps happening, compare with Performance.`,
      action: { id: 'show-diagnostics-performance', label: 'Show performance' },
      area: 'App',
    });
  }
});

test('slow requests without finite duration use the general cause', () => {
  for (const fields of [{}, { durationMs: Infinity }, { data: { durationMs: NaN } }, { durationMs: '240' }]) {
    assert.equal(explainIssue({ event: 'ipc.handler_slow', ...fields }).cause,
      'An app request took longer than 1 s. This is common while a model loads. If it keeps happening, compare with Performance.');
  }
});

test('fallback chooses the longest component prefix and translates the severity title', () => {
  for (const [component, area] of [
    ['SIDECAR.MEMORY.x', 'Memory'], ['memory.store', 'Memory'],
    ['ide.tree', 'Workspace'], ['renderer.workspace.tree', 'Workspace'],
    ['sidecar.engine', 'Local engine'], ['electron.main', 'App'], ['ipc.handler', 'App'],
    ['renderer.chat', 'App window'], ['models.load', 'Models'], ['ollama.load', 'Models'],
    ['llama-server', 'Models'], ['tool.run', 'Tools'], ['zzz.unknown', 'App'],
  ]) {
    for (const severity of ['ERROR', 'WARN', 'INFO']) {
      assert.deepEqual(explainIssue({ component, event: 'unknown.event', severity }), {
        id: 'fallback:unknown.event',
        title: `${area} reported ${severity === 'ERROR' ? 'an error' : 'a warning'}`,
        cause: 'Jenny has no specific advice for this yet. Open Details to see what was recorded.',
        action: null,
        area,
      });
    }
  }
});

test('malformed rows do not throw and use App as the last resort', () => {
  for (const row of [{}, null, undefined, 17, 'bad', { component: 42, event: null }]) {
    assert.doesNotThrow(() => explainIssue(row));
    assert.equal(explainIssue(row).area, 'App');
    assert.equal(explainIssue(row).action, null);
  }
});

test('workspace groups merge with summed counts, highest severity and newest timestamp', () => {
  const groups = [
    { event: 'ide.watch_start_failed', message: 'no workspace root', severity: 'WARN', ts: '2026-10-07T01:00:00Z' },
    { event: 'ide.tree_list_failed', message: 'no workspace root', severity: 'ERROR', ts: '2026-10-07T02:00:00Z' },
  ];
  assert.deepEqual(mergeByExplanation(groups), [{
    explanation: explainIssue(groups[0]), severity: 'ERROR', count: 2,
    ts: '2026-10-07T02:00:00Z', members: groups,
  }]);
  assert.equal(mergeByExplanation(groups)[0].members[0], groups[0]);
  assert.equal(mergeByExplanation(groups)[0].members[1], groups[1]);
});

test('unknown events stay separate and ERROR sorts before a newer WARN', () => {
  const groups = [
    { event: 'new.warning', severity: 'WARN', ts: '2026-10-07T03:00:00Z' },
    { event: 'old.error', severity: 'ERROR', ts: '2026-10-07T01:00:00Z' },
  ];
  assert.deepEqual(mergeByExplanation(groups).map(row => row.explanation.id), [
    'fallback:old.error', 'fallback:new.warning',
  ]);
});

test('merging uses explicit counts and missing timestamps never replace a timestamp', () => {
  const groups = [
    { event: 'same', count: 0, severity: 'INFO' },
    { event: 'same', count: 3, severity: 'WARN', ts: '2026-10-07T02:00:00Z' },
    { event: 'same', count: 2, severity: 'ERROR', ts: '2026-10-07T01:00:00Z' },
    { event: 'same', severity: 'WARN' },
  ];
  const [merged] = mergeByExplanation(groups);
  assert.equal(merged.count, 6);
  assert.equal(merged.severity, 'ERROR');
  assert.equal(merged.ts, '2026-10-07T02:00:00Z');
  assert.deepEqual(merged.members, groups);
});

test('sort uses newest timestamps then first appearance, with WARN above other severities', () => {
  const groups = [
    { event: 'info', severity: 'INFO', ts: '2026-10-07T05:00:00Z' },
    { event: 'older', severity: 'WARN', ts: '2026-10-07T01:00:00Z' },
    { event: 'first', severity: 'WARN', ts: '2026-10-07T02:00:00Z' },
    { event: 'second', severity: 'WARN', ts: '2026-10-07T02:00:00Z' },
    { event: 'missing', severity: 'WARN' },
  ];
  assert.deepEqual(mergeByExplanation(groups).map(row => row.explanation.id), [
    'fallback:first', 'fallback:second', 'fallback:older', 'fallback:missing', 'fallback:info',
  ]);
});

test('merging does not mutate the array or its rows and rejects non-arrays', () => {
  const groups = Object.freeze([
    Object.freeze({ event: 'a', severity: 'WARN' }),
    Object.freeze({ event: 'b', severity: 'ERROR' }),
  ]);
  const before = structuredClone(groups);
  mergeByExplanation(groups);
  assert.deepEqual(groups, before);
  for (const input of [null, undefined, {}, 'bad']) assert.deepEqual(mergeByExplanation(input), []);
});

test('browser UMD exports resolve copy and grouping predicates in renderer load order', () => {
  const context = vm.createContext({ jennyI18n: {
    t: (key, fallback, params) => key === 'diagnostics.issues.area.memory' ? 'Memoire'
      : key === 'diagnostics.issues.explain.fallback.errorTitle' ? `${params.area}: erreur` : fallback,
  } });
  vm.runInContext(fs.readFileSync(require.resolve('../renderer/shared/diagnostics-issue-utils'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(require.resolve('../renderer/shared/diagnostics-issue-explanations'), 'utf8'), context);
  const api = context.rendererDiagnosticsIssueExplanations;
  assert.deepEqual(Object.keys(api).sort(), ['explainIssue', 'matchIssueVariant', 'mergeByExplanation']);
  const explanation = api.explainIssue({ component: 'sidecar.memory.x', severity: 'ERROR' });
  assert.equal(explanation.area, 'Memoire');
  assert.equal(explanation.title, 'Memoire: erreur');
  const groups = context.diagnosticsIssueUtils.groupIssues([
    { level: 'WARN', event: 'ide.watch_start_failed', message: 'no workspace root' },
    { level: 'WARN', event: 'ide.watch_start_failed', message: 'EACCES' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(api.mergeByExplanation(groups).length, 2);
});

test('Python logger prefixes and unknown components use the recorded layer for area labels', () => {
  for (const [component, layer, area] of [
    ['ai.engines.ollama', 'sidecar', 'Local engine'],
    ['runtime.diagnostics', '', 'Local engine'],
    ['unknown', 'sidecar', 'Local engine'],
    ['unknown', 'renderer', 'App window'],
    ['unknown', 'electron', 'App'],
    ['unknown', 'other', 'App'],
    ['ide.tree', 'sidecar', 'Workspace'],
  ]) assert.equal(explainIssue({ component, layer, severity: 'ERROR' }).area, area);
});

test('grouped workspace advice, engine notices and slow-request durations survive modeling and merging', () => {
  const groups = groupIssues([
    { level: 'WARN', event: 'ide.watch_start_failed', message: 'no workspace root' },
    { level: 'WARN', event: 'ide.watch_start_failed', message: 'EACCES' },
    { level: 'WARN', event: 'ollama.output', message: 'notice' },
    { level: 'ERROR', event: 'ollama.output', message: 'failed' },
    { level: 'WARN', event: 'ipc.handler_slow', data: { durationMs: 1532 } },
  ]);
  const merged = mergeByExplanation(groups);
  assert.deepEqual(merged.map(row => row.explanation.id).sort(), [
    'engineNotice', 'fallback:ollama.output', 'noWorkspaceFolder', 'slowRequest', 'workspaceReadFailed',
  ]);
  assert.match(merged.find(row => row.explanation.id === 'slowRequest').explanation.cause, /1\.5 s/);
});

test('matched explanations inspect every member of an explanation group', () => {
  const group = { event: 'ide.watch_start_failed', message: 'EACCES', members: [
    { event: 'ide.watch_start_failed', message: 'no workspace root' },
    { event: 'ide.watch_start_failed', message: 'EACCES' },
  ] };
  assert.equal(explainIssue(group).id, 'noWorkspaceFolder');
  assert.equal(mergeByExplanation([group])[0].explanation.id, 'noWorkspaceFolder');
});

test('explanation merging and sorting parse timestamps before existing string tie-breaks', () => {
  const groups = [
    { event: 'same', severity: 'WARN', ts: '2026-10-07T02:00:00Z' },
    { event: 'same', severity: 'WARN', ts: '2026-10-07T02:00:00.500+00:00' },
    { event: 'other', severity: 'WARN', ts: '2026-10-07T02:00:00.750+00:00' },
  ];
  const merged = mergeByExplanation(groups);
  assert.equal(merged[0].explanation.id, 'fallback:other');
  assert.equal(merged[1].ts, groups[1].ts);
});

test('explanations use the shared severity rank for INFO and DEBUG as well as issues', () => {
  const merged = mergeByExplanation([
    { event: 'debug', severity: 'DEBUG', ts: '2026-10-08T02:00:00Z' },
    { event: 'info', severity: 'INFO', ts: '2026-10-07T02:00:00Z' },
    { event: 'same', severity: 'DEBUG' },
    { event: 'same', severity: 'INFO' },
  ]);
  assert.deepEqual(merged.map(row => row.explanation.id), ['fallback:info', 'fallback:same', 'fallback:debug']);
  assert.equal(merged[1].severity, 'INFO');
});

test('local engine stderr warnings get their own plain explanation; engine errors keep the fallback', () => {
  const expected = {
    id: 'engineNotice',
    title: 'A local engine printed a warning',
    cause: 'llama.cpp, which runs local models and the search-by-meaning index, prints notes while it loads a model. They are usually harmless. Check them only if a model fails to load or answers strangely.',
    action: null,
    area: 'Local engine',
  };
  for (const event of ['llama.server.output', 'ollama.output']) {
    assert.deepEqual(explainIssue({ event, severity: 'WARN', message: 'W srv load_model: speculative decoding not supported by this context' }), expected);
    assert.equal(explainIssue({ event, severity: 'ERROR', message: 'E failed to load model' }).id, 'fallback:' + event);
  }
});

// Owner launch 2026-10-20: one stopped model server on :8033 surfaced as five
// separate "Local engine reported a warning" cards with no advice.
test('every record of one unreachable model server merges into a single card', () => {
  const at = (s) => `2026-10-20T17:17:${s}.000Z`;
  const message = 'Model "m" is unavailable: EngineConnectionError: [CMP-AI-0002] server is not reachable';
  const groups = groupIssues([
    { level: 'WARN', component: 'ai.engines.factory', layer: 'sidecar', event: 'ai.engines.factory.init_failed', ts: at(29),
      message: 'OpenAI-compatible engine initialization failed; falling back to MockEngine', data: { error_type: 'EngineConnectionError' } },
    { level: 'WARN', component: 'electron.main', layer: 'electron', event: 'backend.managed_sidecar_initialize_failed', ts: at(30),
      message, data: { errorCode: 'CMP-AI-0002' } },
    { level: 'WARN', component: 'electron.main', layer: 'electron', event: 'backend.start_model_unavailable', ts: at(31),
      message, data: { errorCode: 'CMP-AI-0002' } },
    { level: 'ERROR', component: 'electron.main', layer: 'electron', event: 'sidecar.config_refresh_failed', ts: at(31),
      message, data: { reason: 'ninfer_stopped', message } },
    { level: 'WARN', component: 'ai.engines.catalog', layer: 'sidecar', event: 'ai.engines.catalog.openai_compatible_discovery_failed', ts: at(32),
      message: 'Could not query OpenAI-compatible server: connection_error', data: { classification: 'connection_error' } },
  ]);
  const merged = mergeByExplanation(groups);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].explanation.id, 'engineUnreachable');
  assert.equal(merged[0].explanation.title, "Jenny can't reach your model server");
  assert.equal(merged[0].explanation.area, 'Local engine');
  assert.equal(merged[0].severity, 'ERROR');
  assert.equal(merged[0].count, 5);
});

test('a model start failure that is not a connection error keeps the fallback card', () => {
  const explained = explainIssue({ event: 'backend.start_model_unavailable', severity: 'WARN',
    component: 'electron.main', message: 'Model "m" was not found', data: { errorCode: 'CMP-AI-0009' } });
  assert.equal(explained.id, 'fallback:backend.start_model_unavailable');
});

test('a degraded workspace orientation explains the git fallback', () => {
  const explained = explainIssue({ event: 'ai.tools.workspace_manifest.orientation_degraded', severity: 'WARN',
    component: 'ai.tools.workspace_manifest', data: { inventory_reason: 'command_failed' } });
  assert.equal(explained.id, 'workspaceGitFallback');
  assert.equal(explained.title, 'Git could not read this workspace');
  assert.equal(explained.area, 'Workspace');
  assert.equal(explained.action, null);
});
