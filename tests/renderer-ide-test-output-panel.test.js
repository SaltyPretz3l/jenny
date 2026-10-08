'use strict';

/* Row 40 W4 (owner decision F6): the read-only "Tests: <name>" output view. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeTestOutputPanel } = require('../renderer/features/renderer-ide-test-output-panel');
const { MAX_ASK_OUTPUT_CHARS } = require('../renderer/features/renderer-ide-run-task-footer');
const actionButton = require('../renderer/inventory/action-button');

function setup(initial = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const state = {
    selection: { configId: 'unit' },
    outputs: { unit: { configId: 'unit', runId: 'r1', status: 'failed', exitCode: 1, stdoutTail: 'out <b>1</b>', stderrTail: 'err 2', finishedAt: 'F' } },
    active: true,
    ...initial,
  };
  const calls = { again: [], ask: [] };
  const panel = createIdeTestOutputPanel({
    getMountEl: () => host,
    isActivePanel: () => state.active,
    getSelection: () => state.selection,
    getRunOutput: (id) => state.outputs[id] || null,
    getConfigLabel: (id) => (id === 'unit' ? 'Unit <tests>' : id),
    onRunAgain: (id) => calls.again.push(id),
    onAskJenny: (payload) => calls.ask.push(payload),
    actionButton,
    escapeHtml: require('../renderer/shared/string-utils').escapeHtml,
  });
  panel.bindEvents();
  const click = (name) => host.querySelector(`[data-ide-task-footer-action="${name}"]`).dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  return { dom, host, state, calls, panel, click };
}

test('renders the header, the result and the escaped output', () => {
  const h = setup();
  h.panel.render();
  assert.equal(h.host.querySelector('.ide-task-output-header .ide-task-output-title').textContent, 'Tests: Unit <tests>');
  assert.equal(h.host.querySelector('.ide-task-output-result').textContent, 'Failed (exit 1)');
  const pre = h.host.querySelector('pre.ide-task-output');
  assert.equal(pre.textContent, 'out <b>1</b>\nerr 2');
  assert.equal(pre.querySelector('b'), null, 'output is escaped text, never markup');
  assert.ok(h.host.querySelector('.ide-task-footer .ide-task-footer-actions'));
});

test('result variants: Passed, Failed without a code, Stopped', () => {
  const cases = [
    [{ status: 'passed', exitCode: 0 }, 'Passed'],
    [{ status: 'failed', exitCode: null }, 'Failed'],
    [{ status: 'timeout', exitCode: null }, 'Failed'],
    [{ status: 'aborted', exitCode: null }, 'Stopped'],
  ];
  for (const [patch, label] of cases) {
    const h = setup();
    h.state.outputs.unit = { ...h.state.outputs.unit, ...patch };
    h.panel.render();
    assert.equal(h.host.querySelector('.ide-task-output-result').textContent, label, JSON.stringify(patch));
  }
});

test('Run again routes the selected config id', () => {
  const h = setup();
  h.panel.render();
  h.click('rerun');
  assert.deepEqual(h.calls.again, ['unit']);
});

test('Ask Jenny to fix appears only for a failed run and sends the bounded output', () => {
  const failed = setup();
  failed.state.outputs.unit.stdoutTail = `${'z'.repeat(20000)}END`;
  failed.panel.render();
  failed.click('ask');
  assert.equal(failed.calls.ask.length, 1);
  assert.equal(failed.calls.ask[0].title, 'Tests: Unit <tests>');
  assert.equal(failed.calls.ask[0].output.length, MAX_ASK_OUTPUT_CHARS);
  assert.ok(failed.calls.ask[0].output.endsWith('err 2'), 'stderr rides last, tail kept');

  for (const status of ['passed', 'aborted']) {
    const h = setup();
    h.state.outputs.unit = { ...h.state.outputs.unit, status };
    h.panel.render();
    assert.equal(h.host.querySelector('[data-ide-task-footer-action="ask"]'), null, `${status}: no Ask Jenny`);
    assert.ok(h.host.querySelector('[data-ide-task-footer-action="rerun"]'));
  }
});

test('render guard: an identical state does not rewrite the DOM; a new run does', () => {
  const h = setup();
  h.panel.render();
  const pre = h.host.querySelector('pre.ide-task-output');
  h.panel.render();
  assert.equal(h.host.querySelector('pre.ide-task-output'), pre, 'same node on an idle re-render');
  h.state.outputs.unit = { ...h.state.outputs.unit, runId: 'r2', stdoutTail: 'new' };
  h.panel.render();
  assert.notEqual(h.host.querySelector('pre.ide-task-output'), pre);
  assert.equal(h.host.querySelector('pre.ide-task-output').textContent, 'new\nerr 2');
});

test('render repaints when a sibling view replaced the host content', () => {
  const h = setup();
  h.panel.render();
  h.host.innerHTML = '';
  h.panel.render();
  assert.ok(h.host.querySelector('pre.ide-task-output'));
});

test('events are bound once and ignored while the view is not the active panel', () => {
  const h = setup();
  h.panel.render();
  h.panel.bindEvents();
  h.panel.render();
  h.click('rerun');
  assert.equal(h.calls.again.length, 1, 'a single listener handled the click');
  h.state.active = false;
  h.click('rerun');
  assert.equal(h.calls.again.length, 1, 'inactive: ignored');
});

test('hasOutput follows the selection; an empty view shows a placeholder', () => {
  const h = setup();
  assert.equal(h.panel.hasOutput(), true);
  h.state.selection = { configId: 'other' };
  assert.equal(h.panel.hasOutput(), false);
  h.state.selection = null;
  assert.equal(h.panel.hasOutput(), false);
  h.panel.render();
  assert.match(h.host.textContent, /No test output yet/);
  assert.equal(h.host.querySelector('.ide-task-footer'), null);
});

test('dispose removes the listener', () => {
  const h = setup();
  h.panel.render();
  h.panel.dispose();
  h.click('rerun');
  assert.deepEqual(h.calls.again, []);
});
