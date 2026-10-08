'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createLogsEventBindings } = require('../renderer/shell/renderer-diagnostics-event-bindings');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

async function boot(t, shell = {}) {
  const app = await loadRendererApp({
    windowGlobals: { __jennyMonacoSharedState: {
      ready: false, failed: true, readyPromise: null, loaderConfigured: true,
      failureReason: 'harness', loggedFailure: true, requireErrorHookInstalled: true,
    } },
    shell: { ...shell, diagnostics: { logs: { getSnapshot: async () => ({
      active_run: { run_id: 'run' }, entries: [], sources: {},
      integrity: { complete: true, partial_reasons: [] },
    }) } } },
  });
  t.after(async () => app.dispose());
  return app;
}

test('boot publishes frozen issue capabilities and renderer disposal removes them', async (t) => {
  const { window } = await boot(t);
  assert.deepEqual({ ...window.rendererDiagnosticsActions }, {
    'show-diagnostics-performance': true,
    'choose-workspace-folder': true,
  });
  assert.equal(Object.isFrozen(window.rendererDiagnosticsActions), true);
  await window.__disposeRenderer();
  assert.equal(window.rendererDiagnosticsActions, undefined);
});

test('rootless workspace issues share one picker action and retain both inspection links', async (t) => {
  let pickerCalls = 0;
  const { window, shell } = await boot(t, { workspaceRoot: { prepareChoose: async () => {
    pickerCalls += 1;
    return { prepared: false, canceled: true, changed: false };
  } } });
  for (const [index, event] of ['ide.watch_start_failed', 'ide.tree_list_failed'].entries()) {
    await shell.__emitLogAppend({
      origin_entry_id: `workspace-${index}`, run_id: 'run',
      ts: `2026-10-07T00:00:0${index}Z`, level: 'WARN', layer: 'renderer',
      component: 'renderer.lifecycle', event, message: 'No workspace root is configured',
    });
  }
  const doc = window.document;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 60);
  const issues = doc.querySelectorAll('#diagnosticsIssueList .diagnostics-issue');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].dataset.issueGroup, 'noWorkspaceFolder');
  const buttons = issues[0].querySelectorAll('button[data-action="choose-workspace-folder"]');
  assert.equal(buttons.length, 1);
  const fold = issues[0].querySelector('details');
  fold.open = true;
  assert.equal(fold.querySelectorAll('[data-action="inspect-diagnostic-issue"][data-issue]').length, 2);
  assert.equal(pickerCalls, 0);
  buttons[0].click();
  await waitForUi(window, 40);
  assert.equal(pickerCalls, 1, 'the action calls jennyShell.workspaceRoot.prepareChoose');
  assert.equal(window.__rendererState.ui.logs.activeTab, 'overview');
});

test('slow request action scrolls and focuses Performance while staying in Overview', async (t) => {
  const { window, shell } = await boot(t);
  await shell.__emitLogAppend({
    entry_id: 'slow-request', run_id: 'run', sequence: 1,
    ts: '2026-10-07T00:00:00Z', level: 'WARN', layer: 'electron',
    component: 'electron.main', event: 'ipc.handler_slow', message: 'Request was slow',
    data: { channel: 'models:list', durationMs: 5200 },
  });
  const doc = window.document;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 60);
  const button = doc.querySelector('.diagnostics-issue button[data-action="show-diagnostics-performance"]');
  assert.ok(button);
  const heading = doc.getElementById('diagnosticsPerformanceHeading');
  const scrollCalls = [];
  window.HTMLElement.prototype.scrollIntoView = function (options) {
    scrollCalls.push({ node: this, options: { ...options } });
  };
  button.click();
  assert.equal(doc.activeElement, heading);
  assert.equal(heading.getAttribute('tabindex'), '-1');
  assert.deepEqual(scrollCalls, [{ node: heading, options: { block: 'start' } }]);
  assert.equal(window.__rendererState.ui.logs.activeTab, 'overview');
});

function directBindings(t, callbacks = {}) {
  const dom = new JSDOM('<div id="logsView"><div id="logList"></div></div>');
  const previous = { window: global.window, document: global.document };
  global.window = dom.window;
  global.document = dom.window.document;
  const bindings = createLogsEventBindings({
    state: { ui: { logs: {} } }, dom: { logList: dom.window.document.getElementById('logList') },
    callbacks: { renderLogs() {}, ...callbacks },
  });
  t.after(() => {
    bindings.dispose();
    dom.window.close();
    Object.assign(global, previous);
  });
  bindings.bind();
  return bindings;
}

test('direct binding without a picker advertises unavailable and cleans up on disposal', (t) => {
  const bindings = directBindings(t);
  assert.deepEqual(globalThis.rendererDiagnosticsActions, {
    'show-diagnostics-performance': true,
    'choose-workspace-folder': false,
  });
  assert.equal(Object.isFrozen(globalThis.rendererDiagnosticsActions), true);
  bindings.dispose();
  assert.equal(globalThis.rendererDiagnosticsActions, undefined);
});

test('disposing older bindings preserves the capabilities of newer bindings', (t) => {
  const older = directBindings(t);
  const newer = createLogsEventBindings({
    state: { ui: { logs: {} } }, dom: { logList: global.document.getElementById('logList') },
    callbacks: { renderLogs() {}, chooseWorkspaceRoot() {} },
  });
  t.after(() => newer.dispose());
  newer.bind();
  const actions = globalThis.rendererDiagnosticsActions;
  assert.ok(actions);
  older.dispose();
  assert.equal(globalThis.rendererDiagnosticsActions, actions);
  newer.dispose();
  assert.equal(globalThis.rendererDiagnosticsActions, undefined);
});
