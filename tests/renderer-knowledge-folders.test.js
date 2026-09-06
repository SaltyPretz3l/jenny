'use strict';

// Knowledge Layer renderer UI — Settings > Tools > "Knowledge folders" group
// (knowledge_layer, INTERNAL default-off). RED-FIRST: covers flag-off parity,
// listing from knowledge.getState, inline structured add-rejection reasons
// (cleared on success), the remove confirm -> knowledge.removeFolder -> refresh
// flow, knowledge.onChanged-driven refresh, and the card-vs-nav mount scoping
// regression (nav items carry the SAME data-settings-section attribute).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createKnowledgeFoldersController,
  mapAddFolderReason,
} = require('../renderer/shell/renderer-knowledge-folders');

function makeDom() {
  // The nav item precedes the card and carries the SAME data-settings-section
  // attribute (as in the real app, where the registry-driven nav renders one
  // item per section) — the group must mount into the CARD, never the nav.
  // The nav element here is an anchor on purpose: the raw-primitive checker
  // owns real nav markup; this fixture only needs the attribute collision.
  return new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <nav id="settingsNav">
          <a href="#" data-settings-section="tools">Tools</a>
        </nav>
        <section class="settings-card tools-card" data-settings-section="tools">
          <div class="settings-group" role="group" aria-labelledby="toolsWorkspaceHeading">
            <h4 class="settings-group-heading" id="toolsWorkspaceHeading">Workspace root</h4>
          </div>
        </section>
      </body>
    </html>
  `, { pretendToBeVisual: true, url: 'http://localhost/' });
}

function makeState(overrides) {
  return {
    features: { featureFlags: { knowledge_layer: true } },
    ...overrides,
  };
}

function makeRoots() {
  return [
    { id: 'kbroot_1', path: 'C:\\Users\\me\\Documents\\Notes', label: 'Notes', addedAt: '2026-07-01T00:00:00.000Z' },
    { id: 'kbroot_2', path: 'D:\\Reference', label: '', addedAt: '2026-07-01T00:00:00.000Z' },
  ];
}

function makeKnowledgeBridgeStub(overrides) {
  return {
    getState: async () => ({ schemaVersion: 1, roots: makeRoots(), enabled: true }),
    addFolder: async () => ({ ok: false, reason: 'invalid_path' }),
    removeFolder: async () => ({ ok: true }),
    onChanged: () => () => {},
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function createHarness(t, { state, knowledge } = {}) {
  const dom = makeDom();
  const knowledgeBridge = knowledge || makeKnowledgeBridgeStub();
  const windowRef = Object.assign(dom.window, { jennyShell: { knowledge: knowledgeBridge } });
  const controller = createKnowledgeFoldersController({
    state: state || makeState(),
    windowRef,
    documentRef: dom.window.document,
    appendClientLog: () => {},
  });
  // House rule: dispose the controller, never dom.window.close() (kills
  // pending jsdom timers mid-flight and masks disposal bugs).
  t.after(() => controller.dispose());
  return { dom, controller, windowRef, knowledgeBridge };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('flag OFF renders nothing (the surface does not exist in the DOM)', async (t) => {
  const state = makeState({ features: { featureFlags: { knowledge_layer: false } } });
  let getStateCalls = 0;
  let subscribeCalls = 0;
  const knowledge = makeKnowledgeBridgeStub({
    getState: async () => { getStateCalls += 1; return { schemaVersion: 1, roots: [], enabled: false }; },
    onChanged: () => { subscribeCalls += 1; return () => {}; },
  });
  const { dom, controller } = createHarness(t, { state, knowledge });
  controller.bind();
  controller.render();
  await settle();
  assert.equal(dom.window.document.getElementById('knowledgeFoldersGroup'), null);
  // Flag off means the IPC handlers are not even registered — the UI must
  // never probe them when hidden.
  assert.equal(getStateCalls, 0, 'must not invoke knowledge.getState when the flag is off');
  assert.equal(subscribeCalls, 0, 'must not subscribe to knowledge.onChanged when the flag is off');
});

test('flag ON renders the group with rows from knowledge.getState', async (t) => {
  const { dom, controller } = createHarness(t);
  controller.bind();
  controller.render();
  await settle();
  const group = dom.window.document.getElementById('knowledgeFoldersGroup');
  assert.ok(group, 'group should render when flag is on');
  assert.match(group.textContent, /Knowledge folders/);
  const labeledRow = dom.window.document.querySelector('[data-root-id="kbroot_1"]');
  assert.ok(labeledRow, 'labeled root row renders');
  assert.match(labeledRow.textContent, /Notes/);
  assert.match(labeledRow.textContent, /C:\\Users\\me\\Documents\\Notes/);
  const unlabeledRow = dom.window.document.querySelector('[data-root-id="kbroot_2"]');
  assert.ok(unlabeledRow, 'unlabeled root row renders');
  assert.match(unlabeledRow.textContent, /D:\\Reference/);
  assert.ok(labeledRow.querySelector('[data-knowledge-folders-action="remove"]'), 'row carries a remove affordance');
});

test('empty registry shows the searchable-folders explainer line', async (t) => {
  const knowledge = makeKnowledgeBridgeStub({
    getState: async () => ({ schemaVersion: 1, roots: [], enabled: true }),
  });
  const { dom, controller } = createHarness(t, { knowledge });
  controller.bind();
  controller.render();
  await settle();
  const group = dom.window.document.getElementById('knowledgeFoldersGroup');
  assert.ok(group);
  assert.match(group.textContent, /searchable by the assistant/i);
  assert.equal(dom.window.document.querySelector('.knowledge-folders-row'), null);
});

test('addFolder rejection reason renders inline; success clears the line', async (t) => {
  let addCalls = 0;
  const knowledge = makeKnowledgeBridgeStub({
    getState: async () => ({ schemaVersion: 1, roots: [], enabled: true }),
    addFolder: async (payload) => {
      addCalls += 1;
      assert.equal(typeof payload.path, 'string');
      if (addCalls === 1) {
        return { ok: false, reason: 'sensitive_path' };
      }
      return { ok: true, root: { id: 'kbroot_9', path: payload.path, label: '', addedAt: '2026-07-02T00:00:00.000Z' } };
    },
  });
  const { dom, controller } = createHarness(t, { knowledge });
  controller.bind();
  controller.render();
  await settle();
  const doc = dom.window.document;

  const pathField = doc.getElementById('knowledgeFolderPathInput');
  assert.ok(pathField, 'path field renders');
  pathField.value = 'C:\\Users\\me\\AppData\\Roaming\\secrets';
  doc.querySelector('[data-knowledge-folders-action="add"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await settle();

  const errorLine = doc.querySelector('.knowledge-folders-error');
  assert.ok(errorLine, 'inline error line exists');
  assert.match(errorLine.textContent, /looks sensitive/i, 'sensitive_path maps to the human-readable message');

  // Second attempt succeeds — the error line must clear.
  doc.getElementById('knowledgeFolderPathInput').value = 'C:\\Users\\me\\Documents\\Notes';
  doc.querySelector('[data-knowledge-folders-action="add"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(doc.querySelector('.knowledge-folders-error').textContent.trim(), '', 'success clears the error line');
  assert.equal(addCalls, 2);
});

test('every structured addFolder reason maps to human-readable copy (no raw enum leak)', () => {
  const reasons = ['sensitive_path', 'not_a_directory', 'not_found', 'duplicate', 'limit_reached', 'feature_disabled', 'invalid_path', 'something_unknown'];
  for (const reason of reasons) {
    const message = mapAddFolderReason(reason);
    assert.equal(typeof message, 'string');
    assert.ok(message.length >= 10, `reason "${reason}" has real copy`);
    assert.ok(!message.includes('_'), `reason "${reason}" must not leak the raw enum`);
  }
});

test('remove flows through confirm -> knowledge.removeFolder -> list refresh', async (t) => {
  let removeCalledWith = null;
  let getStateCalls = 0;
  const knowledge = makeKnowledgeBridgeStub({
    getState: async () => {
      getStateCalls += 1;
      return {
        schemaVersion: 1,
        roots: removeCalledWith ? [] : makeRoots().slice(0, 1),
        enabled: true,
      };
    },
    removeFolder: async (payload) => {
      removeCalledWith = payload;
      return { ok: true };
    },
  });
  const { dom, controller } = createHarness(t, { knowledge });
  controller.bind();
  controller.render();
  await settle();
  const doc = dom.window.document;

  doc.querySelector('[data-knowledge-folders-action="remove"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const confirmBtn = doc.querySelector('[data-step-modal="knowledge-folders-confirm-remove"] [data-step-modal-action="confirm"]');
  assert.ok(confirmBtn, 'confirm dialog renders before removal');
  confirmBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await settle();

  assert.deepEqual(removeCalledWith, { id: 'kbroot_1' });
  // Two getState calls: the bind()-time initial load + the post-remove refresh.
  assert.equal(getStateCalls, 2);
  assert.equal(doc.querySelector('[data-root-id="kbroot_1"]'), null, 'removed row leaves the list');
});

test('resolved remove rejection stays visible and does not refresh the folder list', async (t) => {
  let getStateCalls = 0;
  const knowledge = makeKnowledgeBridgeStub({
    getState: async () => {
      getStateCalls += 1;
      return { schemaVersion: 1, roots: makeRoots().slice(0, 1), enabled: true };
    },
    removeFolder: async () => ({ ok: false, reason: 'not_found' }),
  });
  const { dom, controller } = createHarness(t, { knowledge });
  controller.bind();
  await settle();
  const doc = dom.window.document;

  doc.querySelector('[data-knowledge-folders-action="remove"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  doc.querySelector('[data-step-modal="knowledge-folders-confirm-remove"] [data-step-modal-action="confirm"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await settle();

  assert.equal(getStateCalls, 1, 'a rejected removal must not refresh as if it succeeded');
  assert.ok(doc.querySelector('[data-root-id="kbroot_1"]'), 'the rejected row remains visible');
  assert.match(doc.querySelector('.knowledge-folders-error').textContent, /no longer registered|could not be removed/i);
  assert.doesNotMatch(doc.querySelector('.knowledge-folders-error').textContent, /not_found/);
});

test('a pending add cannot mutate or remount the controller after dispose', async (t) => {
  const addRequest = deferred();
  let getStateCalls = 0;
  const knowledge = makeKnowledgeBridgeStub({
    getState: async () => {
      getStateCalls += 1;
      return { schemaVersion: 1, roots: [], enabled: true };
    },
    addFolder: () => addRequest.promise,
  });
  const { dom, controller } = createHarness(t, { knowledge });
  controller.bind();
  await settle();
  const doc = dom.window.document;
  doc.getElementById('knowledgeFolderPathInput').value = 'C:\\Notes';
  doc.querySelector('[data-knowledge-folders-action="add"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(controller._view.addBusy, true);

  controller.dispose();
  addRequest.resolve({ ok: true });
  await settle();

  assert.equal(controller._view.addBusy, true, 'the late result must not mutate busy state');
  assert.equal(getStateCalls, 1, 'the late result must not start a refresh');
  assert.equal(doc.getElementById('knowledgeFoldersGroup'), null, 'the late result must not remount disposed UI');
});

test('cancel and Escape dismiss the remove confirm without calling removeFolder', async (t) => {
  let removeCalls = 0;
  const knowledge = makeKnowledgeBridgeStub({
    removeFolder: async () => { removeCalls += 1; return { ok: true }; },
  });
  const { dom, controller } = createHarness(t, { knowledge });
  controller.bind();
  controller.render();
  await settle();
  const doc = dom.window.document;
  const modalSelector = '[data-step-modal="knowledge-folders-confirm-remove"]';

  doc.querySelector('[data-knowledge-folders-action="remove"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok(doc.querySelector(modalSelector), 'modal opens');
  doc.querySelector(modalSelector + ' [data-step-modal-action="cancel"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.querySelector(modalSelector), null, 'Cancel dismisses');

  doc.querySelector('[data-knowledge-folders-action="remove"]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok(doc.querySelector(modalSelector), 'modal re-opens');
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelector(modalSelector), null, 'Escape dismisses');
  assert.equal(removeCalls, 0);
});

test('knowledge.onChanged refreshes the list and dispose unsubscribes', async (t) => {
  let capturedListener = null;
  let unsubscribed = false;
  const knowledge = makeKnowledgeBridgeStub({
    getState: async () => ({ schemaVersion: 1, roots: [], enabled: true }),
    onChanged: (listener) => {
      capturedListener = listener;
      return () => { unsubscribed = true; };
    },
  });
  const { dom, controller } = createHarness(t, { knowledge });
  controller.bind();
  controller.render();
  await settle();
  const doc = dom.window.document;
  assert.equal(doc.querySelector('.knowledge-folders-row'), null);
  assert.equal(typeof capturedListener, 'function', 'controller subscribes to knowledge.onChanged');

  capturedListener({ schemaVersion: 1, roots: makeRoots(), enabled: true });
  await settle();
  assert.ok(doc.querySelector('[data-root-id="kbroot_1"]'), 'changed-event snapshot re-renders the rows');

  controller.dispose();
  assert.equal(unsubscribed, true, 'dispose tears the subscription down');
});

test('group mounts into the settings CARD, never the nav item with the same section attribute (regression)', async (t) => {
  const { dom, controller } = createHarness(t);
  controller.bind();
  controller.render();
  await settle();
  const doc = dom.window.document;
  const group = doc.getElementById('knowledgeFoldersGroup');
  assert.ok(group, 'group renders');
  assert.equal(group.closest('#settingsNav'), null, 'group must not land in the nav');
  assert.ok(group.closest('.settings-card[data-settings-section="tools"]'), 'group lands in the Tools card');
});
