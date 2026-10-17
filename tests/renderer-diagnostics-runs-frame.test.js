'use strict';
// Diagnostics › Runs frame (row 57, A1-5): the board rides the runtime console that the lazy Settings
// group publishes, so the tab must say it is loading while that group loads, and say it failed (with a
// way to try again) instead of staying blank.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createLogRenderer } = require('../renderer/shell/renderer-diagnostics-render-utils');

function mountRuns(t, ensureSettingsPage) {
  const dom = new JSDOM('<div id="diagnosticsTabs"></div><section id="diagnosticsRuns">'
    + '<div id="diagnosticsRunsState" hidden></div><div id="diagnosticsRunsMount"></div></section>');
  const previous = { document: global.document, window: global.window, console: global.rendererRuntimeConsole };
  Object.assign(global, { document: dom.window.document, window: dom.window });
  global.rendererRuntimeConsole = null;
  dom.window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  const state = { ui: { activeView: 'logs', logs: { activeTab: 'runs' } }, logs: [], diagnosticsSnapshot: null };
  const renderer = createLogRenderer({ state, callbacks: { ensureSettingsPage } });
  t.after(() => {
    renderer.dispose();
    dom.window.close();
    Object.assign(global, { document: previous.document, window: previous.window });
    global.rendererRuntimeConsole = previous.console;
  });
  return { doc: dom.window.document, renderer };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('Runs says it is loading while the Settings group loads, then shows the board', async (t) => {
  let resolveLoad;
  let loads = 0;
  const { doc, renderer } = mountRuns(t, () => { loads += 1; return new Promise((resolve) => { resolveLoad = resolve; }); });
  renderer.renderLogs();
  await tick();
  const status = doc.getElementById('diagnosticsRunsState');
  assert.equal(loads, 1);
  assert.equal(status.hidden, false, 'the tab is not blank while the board loads');
  assert.match(status.textContent, /Loading runs/);
  assert.equal(doc.getElementById('diagnosticsRunsMount').hidden, true);

  const shown = [];
  global.rendererRuntimeConsole = { showRuns: (host) => shown.push(host.id) };
  resolveLoad({});
  await tick();
  await tick();
  assert.deepEqual(shown, ['diagnosticsRunsMount']);
  assert.equal(status.hidden, true);
  assert.equal(doc.getElementById('diagnosticsRunsMount').hidden, false);
});

test('a failed Runs load says so and Try again loads it again', async (t) => {
  let loads = 0;
  let fail = true;
  const { doc, renderer } = mountRuns(t, () => {
    loads += 1;
    if (fail) return Promise.reject(new Error('settings group failed'));
    global.rendererRuntimeConsole = { showRuns() {} };
    return Promise.resolve({});
  });
  renderer.renderLogs();
  await tick();
  await tick();
  const status = doc.getElementById('diagnosticsRunsState');
  assert.equal(loads, 1);
  assert.match(status.textContent, /Runs couldn.t load/);
  const retry = status.querySelector('button[data-runs-retry]');
  assert.ok(retry, 'the failure offers a retry');

  renderer.renderLogs();
  await tick();
  assert.equal(loads, 1, 'a repaint alone does not retry a failed load');

  fail = false;
  retry.click();
  await tick();
  await tick();
  assert.equal(loads, 2);
  assert.equal(status.hidden, true);
  assert.equal(doc.getElementById('diagnosticsRunsMount').hidden, false);
  assert.equal(doc.activeElement?.dataset?.tab, 'runs', 'focus moves to the Runs tab, not the page body');
});
