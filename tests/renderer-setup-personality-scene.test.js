const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const { createScene: createPersonalityScene } = require('../renderer/features/setup-scenes/scene-personality');

/*
 * Setup wizard -> "Personality and name". Split out of renderer-setup.test.js,
 * which is at the file-size ceiling.
 *
 * The contract these pin: re-running setup must never blank a personality the
 * owner already wrote. The step loads the workspace on mount, and a field the
 * user did not touch is omitted from the save payload entirely -- a missing key
 * leaves that file alone.
 */

function makeBackendPayload(overrides = {}) {
  return {
    setup_complete: false,
    setup_state: { steps: {}, assistant_identity: { agent_name: 'Jenny' } },
    ...overrides,
  };
}

test('re-running the personality step loads the existing files and omits untouched fields', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const saved = [];
  dom.window.jennyShell = {
    personality: {
      async getState() {
        return {
          agentName: 'Echo',
          files: {
            personality: { body: 'You are a friend, not a help desk.', chars: 33 },
            user: { body: 'Brendan. CST.', chars: 13 },
          },
          budgets: { personality: 1500, user: 1000, memory: 1500 },
          compiled: { text: '', tokensEstimate: 0, sections: [] },
          schemaVersion: 3,
        };
      },
      async save(payload) {
        saved.push(payload);
        return { ok: true, agentName: payload.agentName, compiled: { text: '', tokensEstimate: 0 } };
      },
    },
  };
  const scene = createPersonalityScene({
    state: { assistantIdentity: { agentName: 'Jenny' } },
    windowRef: dom.window,
    applyAssistantIdentity: async () => makeBackendPayload({}),
    markStep: async () => {},
    closeModal: () => {},
    showToastMessage: () => {},
    showShellErrorToast: () => {},
    appendClientLog: () => {},
  });

  scene.mount(rootEl);
  await new Promise((resolve) => setImmediate(resolve));

  // The step shows what is already on disk instead of two empty boxes.
  assert.equal(rootEl.querySelector('#setup-personality-note').value, 'You are a friend, not a help desk.');
  assert.equal(rootEl.querySelector('#setup-personality-user').value, 'Brendan. CST.');
  assert.equal(rootEl.querySelector('#setup-personality-name').value, 'Echo');

  rootEl.querySelector('[data-step-modal-action="save"]').click();
  await new Promise((resolve) => setImmediate(resolve));

  // Nothing was touched, so neither file key travels: a missing key leaves that
  // file alone, which is what stops a re-run from writing placeholders over it.
  assert.deepEqual(saved, [{ agentName: 'Echo' }]);
  scene.dispose();
  dom.window.close();
});

test('the personality step sends only the field the user actually edited', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const saved = [];
  dom.window.jennyShell = {
    personality: {
      async getState() {
        return {
          agentName: 'Jenny',
          files: { personality: { body: 'existing note' }, user: { body: 'existing about' } },
          budgets: { personality: 1500, user: 1000, memory: 1500 },
          compiled: { text: '', tokensEstimate: 0, sections: [] },
          schemaVersion: 3,
        };
      },
      async save(payload) {
        saved.push(payload);
        return { ok: true, agentName: payload.agentName, compiled: { text: '', tokensEstimate: 0 } };
      },
    },
  };
  const scene = createPersonalityScene({
    state: { assistantIdentity: { agentName: 'Jenny' } },
    windowRef: dom.window,
    markStep: async () => {},
    closeModal: () => {},
    showToastMessage: () => {},
    showShellErrorToast: () => {},
    appendClientLog: () => {},
  });

  scene.mount(rootEl);
  await new Promise((resolve) => setImmediate(resolve));

  rootEl.querySelector('#setup-personality-user').value = 'Brendan. CST.';
  rootEl.querySelector('[data-step-modal-action="save"]').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(saved, [{ agentName: 'Jenny', user: 'Brendan. CST.' }]);
  assert.equal('personality' in saved[0], false, 'the untouched note is never written');
  scene.dispose();
  dom.window.close();
});

test('a failed personality load leaves the step usable and still writes nothing untouched', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const saved = [];
  const logs = [];
  dom.window.jennyShell = {
    personality: {
      async getState() { throw new Error('bridge is down'); },
      async save(payload) {
        saved.push(payload);
        return { ok: true, agentName: payload.agentName, compiled: { text: '', tokensEstimate: 0 } };
      },
    },
  };
  const scene = createPersonalityScene({
    state: { assistantIdentity: { agentName: 'Jenny' } },
    windowRef: dom.window,
    markStep: async () => {},
    closeModal: () => {},
    showToastMessage: () => {},
    showShellErrorToast: () => {},
    appendClientLog: (level, event) => logs.push(event),
  });

  scene.mount(rootEl);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(logs.includes('setup.personality_load_failed'));
  assert.ok(rootEl.querySelector('#setup-personality-note'), 'the form still renders');

  rootEl.querySelector('[data-step-modal-action="save"]').click();
  await new Promise((resolve) => setImmediate(resolve));

  // The baseline stayed '' and nothing was typed, so a failed load can never
  // blank the files it could not read.
  assert.deepEqual(saved, [{ agentName: 'Jenny' }]);
  scene.dispose();
  dom.window.close();
});

test('a missing personality save bridge fails without marking or advancing the step', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const rootEl = dom.window.document.getElementById('root');
  const calls = { marked: 0, closed: 0, success: 0, errors: 0, logs: [] };
  const scene = createPersonalityScene({
    state: { assistantIdentity: { agentName: 'Jenny' } },
    windowRef: dom.window,
    markStep: async () => { calls.marked += 1; },
    closeModal: () => { calls.closed += 1; },
    showToastMessage: () => { calls.success += 1; },
    showShellErrorToast: () => { calls.errors += 1; },
    appendClientLog: (_level, event, details) => calls.logs.push({ event, details }),
  });

  scene.mount(rootEl);
  rootEl.querySelector('#setup-personality-note').value = 'Keep this text';
  rootEl.querySelector('[data-step-modal-action="save"]').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.marked, 0);
  assert.equal(calls.closed, 0);
  assert.equal(calls.success, 0);
  assert.equal(calls.errors, 1);
  assert.deepEqual(calls.logs, [{
    event: 'setup.personality_save_failed',
    details: { message: 'The personality save bridge is unavailable.' },
  }]);

  scene.dispose();
  dom.window.close();
});
