'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { explainIssue, mergeByExplanation } = require('../renderer/shared/diagnostics-issue-explanations');

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
        cause: 'Jenny has no specific advice for this yet. Technical details show what was recorded.',
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

test('browser UMD export resolves copy through jennyI18n and exposes only the two functions', () => {
  const context = vm.createContext({ jennyI18n: {
    t: (key, fallback, params) => key === 'diagnostics.issues.area.memory' ? 'Memoire'
      : key === 'diagnostics.issues.explain.fallback.errorTitle' ? `${params.area}: erreur` : fallback,
  } });
  vm.runInContext(fs.readFileSync(require.resolve('../renderer/shared/diagnostics-issue-explanations'), 'utf8'), context);
  const api = context.rendererDiagnosticsIssueExplanations;
  assert.deepEqual(Object.keys(api).sort(), ['explainIssue', 'mergeByExplanation']);
  const explanation = api.explainIssue({ component: 'sidecar.memory.x', severity: 'ERROR' });
  assert.equal(explanation.area, 'Memoire');
  assert.equal(explanation.title, 'Memoire: erreur');
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
