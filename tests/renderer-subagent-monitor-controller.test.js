'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { REHOST_EVENT, createSubagentMonitorController } = require('../renderer/chat/renderer-subagent-monitor-controller');

const ONE_CHILD = { task_id: 'child-1', label: 'Inspect persistence', status: 'completed', summary: 'Done.' };
const TWO_CHILDREN = [
  { task_id: 'a', label: 'Survey renderer', status: 'completed', summary: 'Renderer done.' },
  { task_id: 'b', label: 'Survey sidecar', status: 'completed', summary: 'Sidecar done.' },
];

function messagesFor(tasks) {
  return [{ tool_result: {
    call_id: 'call-1',
    metadata: { subagent_batch_report: { status: 'completed', tasks } },
  } }];
}

const PAGE = `<!doctype html><body>
  <section id="chatView"><div id="chatThreadStage">
    <div class="chat-thread-shell"><button id="origin" data-subagent-open="call-1">Open</button></div>
    <aside id="subagentInspector" hidden aria-hidden="true"></aside>
  </div></section>
  <div id="ideChatDock"></div>
  <aside id="artifactReviewPanel"></aside>
</body>`;

/* The panel's side of the pull contract, reduced to what the controller sees:
 * it stores the handle, writes the markup the handle returns, and calls the
 * handle back when it ends the record. */
function fakeRail(doc) {
  const rail = {
    PANEL_ID: 'artifactReviewPanel',
    calls: [],
    handle: null,
    page: '',
    open(request) {
      rail.calls.push(['open', request.key, request.page]);
      rail.handle = request.handle;
      rail.page = request.page;
      rail.repaint();
      return true;
    },
    setPage(page) { rail.page = page; },
    repaint() {
      const parts = rail.handle?.panelMarkup?.();
      if (!parts) return;
      doc.getElementById('artifactReviewPanel').innerHTML = `<div class="subagent-monitor-shell" data-subagent-page="${rail.page}">${parts.header}${parts.body}${parts.footer}</div>`;
    },
    close({ handle }) {
      rail.calls.push(['close']);
      if (handle === rail.handle) rail.handle = null;
      doc.getElementById('artifactReviewPanel').innerHTML = '';
    },
  };
  return rail;
}

function setup({ tasks = [ONE_CHILD], rail = false, dock = false, bareAside = false, extra = {} } = {}) {
  const dom = new JSDOM(PAGE, { pretendToBeVisual: true });
  const doc = dom.window.document;
  const inspector = doc.getElementById('subagentInspector');
  if (bareAside) inspector.removeAttribute('id');
  if (dock) doc.getElementById('ideChatDock').appendChild(doc.getElementById('chatThreadStage'));
  const railStub = rail ? fakeRail(doc) : null;
  let messages = messagesFor(tasks);
  const controller = createSubagentMonitorController({
    state: { currentSessionId: 'session-1' },
    windowRef: dom.window,
    documentRef: doc,
    inspector,
    rail: railStub,
    getMessages: () => messages,
    ...extra,
  });
  controller.bind();
  return {
    dom, doc, inspector, controller, rail: railStub,
    setTasks(next) { messages = messagesFor(next); },
    dispose() { controller.dispose(); dom.window.close(); },
  };
}

test('without a panel rail the pane\'s aside hosts the monitor: one child lands on its drill-in', () => {
  const rig = setup();
  const origin = rig.doc.getElementById('origin');
  origin.click();
  assert.equal(rig.inspector.hidden, false);
  assert.equal(rig.inspector.getAttribute('aria-hidden'), 'false');
  assert.equal(origin.getAttribute('aria-expanded'), 'true');
  assert.equal(origin.getAttribute('aria-controls'), 'subagentInspector', 'the card controls the aside that hosts the monitor');
  assert.equal(rig.inspector.querySelector('.subagent-monitor-shell').getAttribute('data-subagent-page'), 'detail');
  assert.ok(rig.inspector.querySelector('[data-subagent-back]'), 'the drill-in offers Back');
  assert.equal(rig.doc.querySelectorAll('#subagentInspector').length, 1);
  rig.dispose();
});

test('several children land on the tree; selecting drills in and Back returns to the tree', () => {
  const rig = setup({ tasks: TWO_CHILDREN });
  rig.doc.getElementById('origin').click();
  const shell = () => rig.inspector.querySelector('.subagent-monitor-shell');
  assert.equal(shell().getAttribute('data-subagent-page'), 'tree');
  assert.equal(rig.inspector.querySelectorAll('[data-subagent-select]').length, 2, 'one selectable row per child');
  rig.inspector.querySelector('[data-subagent-select="b"]').click();
  assert.equal(shell().getAttribute('data-subagent-page'), 'detail');
  assert.match(shell().textContent, /Sidecar done\./);
  rig.inspector.querySelector('[data-subagent-back]').click();
  assert.equal(shell().getAttribute('data-subagent-page'), 'tree');
  assert.equal(rig.doc.activeElement.getAttribute('data-subagent-select'), 'b', 'focus returns to the child that was open');
  rig.dispose();
});

test('Escape closes the monitor and restores focus to the origin trigger', () => {
  const rig = setup();
  const origin = rig.doc.getElementById('origin');
  origin.focus();
  origin.click();
  const event = new rig.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  rig.inspector.querySelector('[data-subagent-close]').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(rig.inspector.hidden, true);
  assert.equal(rig.doc.activeElement, origin);
  assert.equal(origin.getAttribute('aria-expanded'), 'false');
  rig.dispose();
});

test('reconcile repaints changed evidence when the evidence count is unchanged', () => {
  const evidence = (relativePath) => ({ ...ONE_CHILD, evidence: [{ relative_path: relativePath, summary: 'Evidence.' }] });
  const rig = setup({ tasks: [evidence('first.js')] });
  rig.doc.getElementById('origin').click();
  assert.equal(rig.doc.querySelector('.subagent-evidence-title').textContent, 'first.js');
  rig.setTasks([evidence('second.js')]);
  assert.equal(rig.controller.reconcile(), true);
  assert.equal(rig.doc.querySelector('.subagent-evidence-title').textContent, 'second.js');
  assert.equal(rig.controller.reconcile(), false, 'unchanged state repaints nothing');
  rig.dispose();
});

test('split view: an id suffix keeps the aside and its ids unique to the pane', () => {
  const rig = setup({ bareAside: true, extra: { idSuffix: '-pane1' } });
  const origin = rig.doc.getElementById('origin');
  origin.click();
  assert.equal(rig.inspector.id, 'subagentInspector-pane1');
  assert.equal(origin.getAttribute('aria-controls'), 'subagentInspector-pane1');
  assert.equal(rig.doc.getElementById(rig.inspector.getAttribute('aria-labelledby'))?.tagName, 'H2');
  assert.ok([...rig.inspector.querySelectorAll('[id]')].every((node) => node.id.endsWith('-pane1')), 'every rendered id is suffixed');
  rig.controller.close();
  assert.equal(rig.inspector.hidden, true);
  rig.dispose();
});

test('with a panel rail the controller hands its markup to the panel and leaves the aside alone', () => {
  const rig = setup({ tasks: TWO_CHILDREN, rail: true });
  const origin = rig.doc.getElementById('origin');
  origin.click();
  assert.deepEqual(rig.rail.calls[0], ['open', 'call-1', 'tree'], 'the rail is asked to open on the tree page');
  const panelShell = rig.doc.querySelector('#artifactReviewPanel .subagent-monitor-shell');
  assert.ok(panelShell, 'the panel pulled the markup');
  assert.equal(rig.inspector.hidden, true, 'the in-stage aside stays hidden');
  assert.equal(rig.inspector.innerHTML, '');
  assert.equal(origin.getAttribute('aria-controls'), 'artifactReviewPanel');
  assert.equal(origin.getAttribute('aria-expanded'), 'true');

  // Drill-in re-pulls with the detail page.
  rig.controller.select('a');
  assert.equal(rig.rail.page, 'detail');
  assert.match(rig.doc.querySelector('#artifactReviewPanel').textContent, /Renderer done\./);
  rig.controller.back();
  assert.equal(rig.rail.page, 'tree');

  // The panel forwards keys; Escape is consumed and closes through the rail.
  const escape = new rig.dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
  rig.rail.handle.handleKeydown(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(rig.rail.calls.at(-1)[0], 'close');
  assert.equal(rig.doc.querySelector('#artifactReviewPanel .subagent-monitor-shell'), null);
  assert.equal(origin.getAttribute('aria-expanded'), 'false');
  rig.dispose();
});

test('a first Open before any artifact surface exists builds the rail instead of using the aside', () => {
  const rig = setup({ tasks: TWO_CHILDREN });
  const lateRail = fakeRail(rig.doc);
  let ensureCalls = 0;
  rig.dom.window.rendererEnsureSubagentRail = () => {
    ensureCalls += 1;
    rig.dom.window.rendererSubagentRailHost = lateRail;
    return lateRail;
  };
  const origin = rig.doc.getElementById('origin');
  origin.click();
  assert.equal(ensureCalls, 1);
  assert.deepEqual(lateRail.calls[0], ['open', 'call-1', 'tree']);
  assert.ok(rig.doc.querySelector('#artifactReviewPanel .subagent-monitor-shell'), 'the panel hosts the monitor');
  assert.equal(rig.inspector.hidden, true, 'the in-stage aside is not used in Chat');
  assert.equal(origin.getAttribute('aria-controls'), 'artifactReviewPanel');
  rig.dispose();
});

test('the panel ending the record (released) resets the controller without touching focus', () => {
  const rig = setup({ rail: true });
  const origin = rig.doc.getElementById('origin');
  origin.click();
  assert.equal(origin.getAttribute('aria-expanded'), 'true');
  rig.rail.handle.released();
  assert.equal(origin.getAttribute('aria-expanded'), 'false');
  assert.equal(rig.rail.handle.panelMarkup(), null, 'a released controller offers no markup');
  assert.equal(rig.controller.render(), false);
  rig.dispose();
});

test('a stage in the IDE dock hosts the monitor in its own aside; rehost follows the stage back to Chat', () => {
  const rig = setup({ rail: true, dock: true });
  const origin = rig.doc.getElementById('origin');
  origin.click();
  assert.equal(rig.rail.calls.length, 0, 'the dock has no artifact panel, so the rail is not asked');
  assert.equal(rig.inspector.hidden, false);
  assert.ok(rig.inspector.querySelector('.subagent-monitor-shell'));
  assert.equal(origin.getAttribute('aria-controls'), 'subagentInspector');

  // The stage leaves the dock (view switch): the monitor moves to the panel.
  rig.doc.getElementById('chatView').appendChild(rig.doc.getElementById('chatThreadStage'));
  rig.dom.window.dispatchEvent(new rig.dom.window.Event(REHOST_EVENT));
  assert.deepEqual(rig.rail.calls[0], ['open', 'call-1', 'detail']);
  assert.ok(rig.doc.querySelector('#artifactReviewPanel .subagent-monitor-shell'));
  assert.equal(rig.inspector.hidden, true, 'the aside cleared');
  assert.equal(origin.getAttribute('aria-controls'), 'artifactReviewPanel');
  rig.dispose();
});

test('a refused panel open degrades to the in-stage aside', () => {
  const rig = setup({ rail: true });
  rig.rail.open = () => false;
  rig.doc.getElementById('origin').click();
  assert.equal(rig.inspector.hidden, false);
  assert.ok(rig.inspector.querySelector('.subagent-monitor-shell'));
  assert.equal(rig.doc.getElementById('origin').getAttribute('aria-controls'), rig.inspector.id || 'subagentInspector', 'the card controls the host in use');
  rig.dispose();
});
