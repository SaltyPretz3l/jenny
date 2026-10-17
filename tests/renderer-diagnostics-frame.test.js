'use strict';
// Diagnostics page frame (row 57): the launch picker.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createLogRenderer } = require('../renderer/shell/renderer-diagnostics-render-utils');

function paintFrame(t, snapshot) {
  const dom = new JSDOM('<div id="diagnosticsTabs"></div>'
    + '<select id="diagnosticsRunSelect"><option value="">This launch</option></select>');
  const previous = { document: global.document, window: global.window };
  Object.assign(global, { document: dom.window.document, window: dom.window });
  let paint;
  dom.window.requestAnimationFrame = (callback) => { paint = callback; return 1; };
  const state = { ui: { activeView: 'logs', logs: { activeTab: 'activity' } }, logs: [], diagnosticsSnapshot: snapshot };
  const renderer = createLogRenderer({ state });
  t.after(() => { renderer.dispose(); dom.window.close(); Object.assign(global, previous); });
  renderer.renderLogs();
  paint();
  return { select: dom.window.document.getElementById('diagnosticsRunSelect'), state, renderer, repaint: () => { renderer.renderLogs(); paint(); } };
}

test('the launch picker keeps "This launch" before the first snapshot names the launches', (t) => {
  const { select } = paintFrame(t, null);
  assert.deepEqual(Array.from(select.options, (option) => [option.value, option.textContent]), [['', 'This launch']]);
  assert.equal(select.value, '');
});

test('the launch picker names each launch by when it started, in words', (t) => {
  // Relative to today: the label shows only a time for today and adds the date for an earlier day.
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 18, 40);
  const started = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 12).toISOString();
  const prior = yesterday.toISOString();
  const { select } = paintFrame(t, {
    active_run: { run_id: 'now', started_at: started },
    prior_run: { run_id: 'before', started_at: prior },
  });
  const labels = Array.from(select.options, (option) => option.textContent);
  assert.equal(select.options[0].value, 'now');
  assert.equal(select.options[1].value, 'before');
  assert.match(labels[0], /^This launch · since \d{1,2}:12/);
  assert.match(labels[1], new RegExp(`^Previous launch · .*${yesterday.getDate()}.*\\d{1,2}:40`));
  assert.doesNotMatch(labels.join(' '), /\b\d{1,2}\/\d{1,2}\b|app launch/);
});
