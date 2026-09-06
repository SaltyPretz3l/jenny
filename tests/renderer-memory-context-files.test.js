const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const { createMemoryContextEditor } = require('../renderer/features/renderer-personality-utils');

const NOTES_HTML = `
  <div id="fieldHost"></div>
  <span id="memoryNotesHint">hint</span>
  <span id="memoryNotesCounter"></span>
  <span id="counter"></span>
  <p id="lint" hidden></p>
  <span id="status"></span>
  <div id="actions"></div>`;

function createHarness(t, overrides = {}) {
  const dom = new JSDOM(NOTES_HTML);
  const { document } = dom.window;
  const durable = { body: 'Brendan drinks tea.' };
  const calls = { writes: [], resets: 0 };
  const contextFiles = {
    async getState() {
      return { body: durable.body, chars: durable.body.length, budget: 1500, compiledChars: 0 };
    },
    async writeFile(payload) {
      calls.writes.push(payload);
      durable.body = String(payload && payload.body);
      return { ok: true };
    },
    async resetFile() {
      calls.resets += 1;
      durable.body = '';
      return { ok: true };
    },
    ...overrides,
  };
  dom.window.jennyShell = { memory: { contextFiles } };
  const state = {
    memoryContextFiles: {
      body: '', savedBody: '', dirty: false, loading: false, saving: false, savedAt: 0,
      budget: 1500, actionStatus: '', loadStatus: '',
    },
  };
  const controller = createMemoryContextEditor({
    state,
    windowRef: dom.window,
    now: () => 1700000000000,
    dom: {
      memoryNotesFieldHost: document.getElementById('fieldHost'),
      memoryNotesCounter: document.getElementById('counter'),
      memoryNotesLint: document.getElementById('lint'),
      memoryContextStatus: document.getElementById('status'),
      memoryNotesActions: document.getElementById('actions'),
    },
  });
  t.after(() => {
    controller.dispose();
    dom.window.close();
  });
  return { calls, controller, document, dom, durable, state };
}

function typeNotes(harness, value) {
  const field = harness.document.getElementById('memoryNotesInput');
  field.value = value;
  field.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
}

test('Long-term notes load MEMORY.md into one textarea with its own budget', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refresh();

  const fields = harness.document.querySelectorAll('#fieldHost textarea');
  assert.equal(fields.length, 1, 'one notes textarea, no tab strip and no daily file');
  assert.equal(fields[0].value, 'Brendan drinks tea.');
  assert.equal(fields[0].getAttribute('aria-label'), 'Long-term notes');
  assert.equal(harness.document.getElementById('counter').textContent, '19 / 1,500');
  assert.equal(harness.document.getElementById('status').textContent, 'Ready');
  assert.equal(harness.document.querySelector('[data-action="memory-notes-save"]').disabled, true);
});

test('editing marks the notes dirty and enables Save; saving sends the body payload', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refresh();

  typeNotes(harness, 'Brendan drinks tea. And coffee.');
  assert.equal(harness.state.memoryContextFiles.dirty, true);
  assert.equal(harness.document.getElementById('status').textContent, 'Unsaved changes');
  assert.equal(harness.document.querySelector('[data-action="memory-notes-save"]').disabled, false);

  await harness.controller.save();
  assert.deepEqual(harness.calls.writes, [{ body: 'Brendan drinks tea. And coffee.' }]);
  assert.equal(harness.durable.body, 'Brendan drinks tea. And coffee.');
  assert.equal(harness.state.memoryContextFiles.dirty, false);
  assert.equal(harness.document.getElementById('status').textContent, 'Saved · just now');
});

test('a rejected save keeps the draft and says so', async (t) => {
  let reject = true;
  const harness = createHarness(t, {
    async writeFile() {
      if (reject) throw new Error('C:/private/path must never surface');
      return { ok: true };
    },
  });
  await harness.controller.refresh();
  typeNotes(harness, 'keep this draft');

  await harness.controller.save();
  assert.equal(harness.state.memoryContextFiles.body, 'keep this draft');
  assert.equal(harness.state.memoryContextFiles.dirty, true);
  const status = harness.document.getElementById('status').textContent;
  assert.match(status, /Save failed\. Your notes were kept\./);
  assert.doesNotMatch(status, /private/, 'the failure copy must stay bounded and redacted');

  reject = false;
  await harness.controller.save();
  assert.equal(harness.state.memoryContextFiles.dirty, false);
});

test('the over-budget counter and the placeholder lint fire on the notes body', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refresh();

  typeNotes(harness, 'x'.repeat(1512));
  const counter = harness.document.getElementById('counter');
  assert.match(counter.textContent, /1,512 \/ 1,500 — the last 12 characters won’t be sent/);
  assert.equal(counter.classList.contains('personality-counter--over'), true);

  const lint = harness.document.getElementById('lint');
  assert.equal(lint.hasAttribute('hidden'), true);
  typeNotes(harness, 'The date is {{current_date}}.');
  assert.equal(lint.hasAttribute('hidden'), false);
  assert.match(lint.textContent, /placeholders aren’t expanded/);
});

test('clearing the notes empties the textarea and does not touch approved memories', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refresh();

  await harness.controller.reset();
  assert.equal(harness.calls.resets, 1);
  assert.equal(harness.document.getElementById('memoryNotesInput').value, '');
  assert.equal(harness.state.memoryContextFiles.body, '');
  assert.equal(harness.controller.hasUnsavedChanges(), false);
});

test('the notes editor warns before unload while a draft is dirty', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refresh();
  typeNotes(harness, '# draft');

  const event = new harness.dom.window.Event('beforeunload', { cancelable: true });
  harness.dom.window.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
});

test('a failed load keeps the last draft and reports an unavailable state', async (t) => {
  const harness = createHarness(t, {
    async getState() { throw new Error('bridge is down'); },
  });
  harness.controller.setDraft('local draft');
  harness.state.memoryContextFiles.dirty = false;

  await harness.controller.refresh();

  assert.equal(harness.state.memoryContextFiles.body, 'local draft');
  assert.match(harness.document.getElementById('status').textContent, /Unable to load long-term notes/);
});

test('refresh preserves a draft typed while the snapshot request is pending', async (t) => {
  let resolveState;
  const harness = createHarness(t, {
    getState: () => new Promise((resolve) => { resolveState = resolve; }),
  });

  const pending = harness.controller.refresh();
  typeNotes(harness, 'typed during refresh');
  resolveState({ body: 'server snapshot', budget: 1500 });
  await pending;

  assert.equal(harness.state.memoryContextFiles.body, 'typed during refresh');
  assert.equal(harness.state.memoryContextFiles.dirty, true, 'the local draft remains unsaved');
});

test('save and reset lock the textarea and preserve edits made before settlement', async (t) => {
  let resolveWrite;
  const saveHarness = createHarness(t, {
    writeFile: () => new Promise((resolve) => { resolveWrite = resolve; }),
  });
  await saveHarness.controller.refresh();
  typeNotes(saveHarness, 'submitted');
  const pendingSave = saveHarness.controller.save();
  assert.equal(saveHarness.document.getElementById('memoryNotesInput').disabled, true);
  saveHarness.controller.setDraft('typed during save');
  resolveWrite({ ok: true });
  await pendingSave;
  assert.equal(saveHarness.state.memoryContextFiles.body, 'typed during save');
  assert.equal(saveHarness.state.memoryContextFiles.savedBody, 'submitted');
  assert.equal(saveHarness.state.memoryContextFiles.dirty, true);

  let resolveReset;
  const resetHarness = createHarness(t, {
    resetFile: () => new Promise((resolve) => { resolveReset = resolve; }),
  });
  await resetHarness.controller.refresh();
  const pendingReset = resetHarness.controller.reset();
  assert.equal(resetHarness.document.getElementById('memoryNotesInput').disabled, true);
  resetHarness.controller.setDraft('typed during reset');
  resolveReset({ ok: true });
  await pendingReset;
  assert.equal(resetHarness.state.memoryContextFiles.body, 'typed during reset');
  assert.equal(resetHarness.state.memoryContextFiles.savedBody, '');
  assert.equal(resetHarness.state.memoryContextFiles.dirty, true);
});

test('an oversized MEMORY.md is read-only here, with Save disabled and the open-folder message', async (t) => {
  const harness = createHarness(t, {
    async getState() {
      return { body: '', chars: 0, budget: 1500, compiledChars: 0, oversized: true };
    },
  });
  await harness.controller.refresh();

  assert.equal(harness.document.getElementById('memoryNotesInput').disabled, true);
  assert.equal(harness.document.querySelector('[data-action="memory-notes-save"]').disabled, true);
  const lint = harness.document.getElementById('lint');
  assert.equal(lint.hasAttribute('hidden'), false);
  assert.equal(lint.textContent, 'This file is larger than 64 KiB. Open the folder to edit it.');
});

test('a rejected notes save names its error code and keeps the draft', async (t) => {
  const harness = createHarness(t, {
    async writeFile() { return { ok: false, code: 'CMP-PERS-0002' }; },
  });
  await harness.controller.refresh();
  typeNotes(harness, 'keep this');

  await harness.controller.save();

  assert.equal(
    harness.document.getElementById('status').textContent,
    'Save failed (CMP-PERS-0002): This file is larger than 64 KiB. Open the folder to edit it. '
      + 'Your notes were kept.'
  );
  assert.equal(harness.state.memoryContextFiles.body, 'keep this');
  assert.equal(harness.state.memoryContextFiles.dirty, true);
});

test('a rejected notes clear names its error code and keeps the body', async (t) => {
  const harness = createHarness(t, {
    async resetFile() { return { ok: false, code: 'CMP-PERS-0001' }; },
  });
  await harness.controller.refresh();

  await harness.controller.reset();

  assert.match(
    harness.document.getElementById('status').textContent,
    /^Clear failed \(CMP-PERS-0001\): the change was not acknowledged\. Your notes were kept\.$/
  );
  assert.equal(harness.state.memoryContextFiles.body, 'Brendan drinks tea.');
});

test('the notes textarea is described by its hint, counter and lint', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refresh();

  assert.equal(
    harness.document.getElementById('memoryNotesInput').getAttribute('aria-describedby'),
    'memoryNotesHint memoryNotesCounter memoryNotesLint'
  );
});

test('the notes buttons are not rebuilt on every keystroke', async (t) => {
  const harness = createHarness(t);
  await harness.controller.refresh();

  typeNotes(harness, 'a');
  const afterFirst = harness.document.querySelector('[data-action="memory-notes-save"]');
  typeNotes(harness, 'ab');
  typeNotes(harness, 'abc');
  assert.equal(harness.document.querySelector('[data-action="memory-notes-save"]'), afterFirst);
});
