'use strict';

/* Workspace task views at the controller (row 40 W4): the terminal header's + and
 * Kill actions add and remove terminal instances through the layout (F3), the Run
 * tab names its task (F5), and the Test output tab stays hidden until a config has
 * output to show (F6). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, settle } = require('./helpers/renderer-ide-harness');

async function openIde(t) {
  const harness = createHarness();
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const q = (sel) => doc.querySelector(`#ideWorkbench ${sel}`);
  const click = (el) => el.dispatchEvent(new harness.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return { harness, doc, q, click };
}

test('the terminal header adds a second terminal beside the first, and Kill removes it again', async (t) => {
  const { harness, q, click } = await openIde(t);
  click(q('[data-wb-tab="terminal"]'));
  await settle();
  const add = q('[data-wb-action="view:new-terminal"]');
  assert.ok(add, 'the + action shows on the terminal stack');
  assert.equal(add.getAttribute('aria-label'), 'New Terminal');
  assert.ok(q('[data-wb-action="view:kill-terminal"]'), 'Kill shows beside it');

  click(add);
  await settle();
  const tab = q('[data-wb-tab="terminal-2"]');
  assert.ok(tab, 'Terminal 2 joins the stack');
  assert.equal(tab.textContent.trim(), 'Terminal 2');
  assert.equal(tab.getAttribute('aria-selected'), 'true', 'and is the active tab');
  assert.ok(harness.viewHost('terminal-2'), 'with its own view host');

  click(q('[data-wb-action="view:kill-terminal"]'));
  await settle();
  assert.equal(q('[data-wb-tab="terminal-2"]'), null, 'Kill on an extra terminal removes its view');
  assert.ok(q('[data-wb-tab="terminal"]'), 'the first terminal always stays');
});

test('the + action goes away at four terminals', async (t) => {
  const { q, click } = await openIde(t);
  click(q('[data-wb-tab="terminal"]'));
  await settle();
  for (let i = 0; i < 3; i += 1) {
    click(q('[data-wb-action="view:new-terminal"]'));
    await settle();
  }
  assert.ok(q('[data-wb-tab="terminal-4"]'), 'four terminals are open');
  assert.equal(q('[data-wb-action="view:new-terminal"]'), null, 'no fifth');
  assert.ok(q('[data-wb-action="view:kill-terminal"]'));
});

test('the Run tab reads Run before any task, and Test output stays hidden without output', async (t) => {
  const { q } = await openIde(t);
  assert.equal(q('[data-wb-tab="run"]')?.textContent.trim() || q('[data-wb-strip="run"]')?.getAttribute('aria-label'), 'Run');
  assert.equal(q('[data-wb-tab="test-output"]'), null);
  assert.equal(q('[data-wb-strip="test-output"]'), null);
});

test('Show output on a failed test run opens its Test output tab, and Ask Jenny sends the output', async (t) => {
  const { makeApi } = require('./helpers/test-runner-wiring-fixture');
  const fake = makeApi();
  fake.api.run = (payload) => Promise.resolve({ configId: payload.configId, runId: 'r1', status: 'failed', exitCode: 1, stdoutTail: '1 failing\nexpected 2', stderrTail: '' });
  const harness = createHarness({ beforeController: (win, bridge) => {
    bridge.jennyShell.workspaceTestRunner = fake.api;
    win.rendererIdeTestRunnerPanel = require('../renderer/features/renderer-ide-test-runner-panel');
    win.inventoryActionButton = require('../renderer/inventory/action-button');
    win.inventoryTextField = require('../renderer/inventory/text-field');
    win.inventorySelectField = require('../renderer/inventory/select-field');
  } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const q = (sel) => doc.querySelector(`#ideWorkbench ${sel}`);
  const click = (el) => el.dispatchEvent(new harness.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  click(q('[data-wb-tab="test-runner"]'));
  await settle();
  click(q('[data-test-runner-run]'));
  await settle();
  assert.equal(q('[data-wb-tab="test-output"]'), null, 'output kept, but nothing asked to show it yet');
  click(q('[data-test-runner-show-output]'));
  await settle();
  const tab = q('[data-wb-tab="test-output"]');
  assert.ok(tab, 'the Test output tab appears');
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  const view = harness.viewHost('test-output');
  assert.match(view.querySelector('.ide-task-output-title').textContent, /^Tests: Unit$/);
  assert.equal(view.querySelector('.ide-task-output-result').textContent, 'Failed (exit 1)');
  assert.match(view.querySelector('pre.ide-task-output').textContent, /1 failing/);
  click(view.querySelector('[data-ide-task-footer-action="ask"]'));
  assert.equal(harness.sentToJenny.length, 1);
  assert.equal(harness.sentToJenny[0].path, 'Tests: Unit');
  assert.match(harness.sentToJenny[0].code, /expected 2/);
});
test('Reset Layout keeps open terminals running in the terminal stack', async (t) => {
  const { harness, q, click } = await openIde(t);
  click(q('[data-wb-tab="terminal"]'));
  await settle();
  click(q('[data-wb-action="view:new-terminal"]'));
  await settle();
  harness.controller.getIdeCommandItems().find((row) => row.id === 'ide:reset-layout').run();
  await settle();
  assert.ok(q('[data-wb-tab="terminal-2"]') || q('[data-wb-strip="terminal-2"]'), 'Terminal 2 survives the reset');
});