'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSubagentMonitorController } = require('../renderer/chat/renderer-subagent-monitor-controller');

function setup() {
  const dom = new JSDOM(`<!doctype html><body>
    <section id="chatView"><div id="chatThreadStage">
      <div class="chat-thread-shell"><button id="origin" data-subagent-open="call-1">Open</button></div>
      <aside id="subagentInspector" hidden aria-hidden="true"></aside>
    </div></section>
  </body>`, { pretendToBeVisual: true });
  const messages = [{ tool_result: {
    call_id: 'call-1',
    metadata: { subagent_report: {
      task_id: 'child-1', label: 'Inspect persistence', status: 'completed', summary: 'Done.',
    } },
  } }];
  const controller = createSubagentMonitorController({
    state: { currentSessionId: 'session-1' },
    windowRef: dom.window,
    documentRef: dom.window.document,
    inspector: dom.window.document.getElementById('subagentInspector'),
    chatView: dom.window.document.getElementById('chatView'),
    getMessages: () => messages,
  });
  controller.bind();
  return { dom, controller };
}

test('delegated activation opens compact details without duplicating the inspector', () => {
  const { dom, controller } = setup();
  const origin = dom.window.document.getElementById('origin');
  origin.click();
  const inspector = dom.window.document.getElementById('subagentInspector');
  assert.equal(inspector.hidden, false);
  assert.equal(inspector.getAttribute('aria-hidden'), 'false');
  assert.equal(origin.getAttribute('aria-expanded'), 'true');
  assert.ok(inspector.classList.contains('is-compact'));
  assert.equal(dom.window.document.querySelectorAll('#subagentInspector').length, 1);
  controller.dispose();
  dom.window.close();
});
test('Escape closes the inspector and restores focus to the origin trigger', () => {
  const { dom, controller } = setup();
  const origin = dom.window.document.getElementById('origin');
  origin.focus();
  origin.click();
  const inspector = dom.window.document.getElementById('subagentInspector');
  inspector.querySelector('[data-subagent-close]').dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true,
  }));
  assert.equal(inspector.hidden, true);
  assert.equal(dom.window.document.activeElement, origin);
  controller.dispose();
  dom.window.close();
});

test('reconcile repaints changed evidence when the evidence count is unchanged', () => {
  const dom = new JSDOM('<section id="chatView"><button id="open" data-subagent-open="call-1">Open</button><aside id="subagentInspector" hidden></aside></section>', {
    pretendToBeVisual: true,
  });
  let relativePath = 'first.js';
  const controller = createSubagentMonitorController({
    state: { currentSessionId: 'session-1' },
    windowRef: dom.window,
    documentRef: dom.window.document,
    inspector: dom.window.document.getElementById('subagentInspector'),
    chatView: dom.window.document.getElementById('chatView'),
    getMessages: () => [{ tool_result: {
      call_id: 'call-1',
      metadata: { subagent_report: {
        task_id: 'child-1', label: 'Task', status: 'completed', summary: 'Done.',
        evidence: [{ relative_path: relativePath, summary: 'Evidence.' }],
      } },
    } }],
  });
  controller.bind();
  dom.window.document.getElementById('open').click();
  assert.equal(dom.window.document.querySelector('.subagent-evidence-title').textContent, 'first.js');

  relativePath = 'second.js';

  assert.equal(controller.reconcile(), true);
  assert.equal(dom.window.document.querySelector('.subagent-evidence-title').textContent, 'second.js');
  controller.dispose();
  dom.window.close();
});
