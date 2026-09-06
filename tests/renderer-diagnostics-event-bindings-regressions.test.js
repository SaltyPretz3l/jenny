'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createLogsEventBindings } = require('../renderer/shell/renderer-diagnostics-event-bindings');

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

test('percentile reset cannot refresh, render, or re-enable its button after dispose', async (t) => {
  const dom = new JSDOM('<!doctype html><body><section id="logsView"><button id="phasePercentilesResetButton">Reset</button><div id="logList"></div></section></body>');
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  });

  const resetRequest = deferred();
  let refreshCalls = 0;
  let renderCalls = 0;
  const bindings = createLogsEventBindings({
    state: { ui: { logs: { selectedEntryId: '', autoScroll: true } } },
    dom: { logList: dom.window.document.getElementById('logList') },
    callbacks: {
      resetPhasePercentiles: () => resetRequest.promise,
      refreshPhasePercentiles: () => { refreshCalls += 1; },
      renderLogs: () => { renderCalls += 1; },
    },
  });
  bindings.bind();
  const reset = dom.window.document.getElementById('phasePercentilesResetButton');
  reset.click();
  assert.equal(reset.disabled, true);

  bindings.dispose();
  resetRequest.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(refreshCalls, 0, 'the disposed chain must not start its refresh continuation');
  assert.equal(renderCalls, 0, 'the disposed chain must not render');
  assert.equal(reset.disabled, true, 'the disposed chain must not mutate the detached button');
});
