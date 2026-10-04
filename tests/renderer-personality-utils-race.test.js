const test = require('node:test');
const assert = require('node:assert/strict');

const { createPersonalityEditor } = require('../renderer/features/renderer-personality-utils');

function createState(overrides = {}) {
  return {
    personality: {
      agentName: 'Jenny',
      personality: '',
      user: '',
      saved: { agentName: 'Jenny', personality: '', user: '' },
      dirty: false,
      budgets: { personality: 1500, user: 1000, memory: 1500 },
      loaded: true,
      ...overrides,
    },
  };
}

function createWindow(personalityApi) {
  return {
    jennyShell: { personality: personalityApi },
    addEventListener() {},
    removeEventListener() {},
  };
}

test('a pending personality refresh preserves edits made after the request starts', async () => {
  let releaseRefresh;
  const state = createState();
  const editor = createPersonalityEditor({
    state,
    windowRef: createWindow({
      getState() { return new Promise((resolve) => { releaseRefresh = resolve; }); },
    }),
    dom: {},
  });

  const pending = editor.refreshPersonalityWorkspace();
  state.personality.personality = 'unsaved';
  state.personality.dirty = true;
  releaseRefresh({
    agentName: 'Jenny',
    personality: 'server',
    user: '',
    budgets: state.personality.budgets,
    compiled: { text: '' },
  });
  await pending;

  assert.equal(state.personality.personality, 'unsaved');
  assert.equal(state.personality.dirty, true);
});

test('a save acknowledgement keeps a newer personality draft dirty', async () => {
  let releaseSave;
  const state = createState({ personality: 'first', dirty: true });
  const editor = createPersonalityEditor({
    state,
    windowRef: createWindow({
      save() { return new Promise((resolve) => { releaseSave = resolve; }); },
    }),
    dom: {},
  });

  const pending = editor.handlePersonalitySave();
  state.personality.personality = 'second';
  state.personality.dirty = true;
  releaseSave({ ok: true, agentName: 'Jenny', compiled: { text: '' } });
  await pending;

  assert.equal(state.personality.personality, 'second');
  assert.equal(state.personality.saved.personality, 'first');
  assert.equal(state.personality.dirty, true);
});

test('a clear acknowledgement preserves typing and the captured saved name', async () => {
  let release;
  const state = createState({ personality: 'old', user: 'old user' });
  const editor = createPersonalityEditor({ state, dom: {}, windowRef: createWindow({
    clear() { return new Promise((resolve) => { release = resolve; }); },
  }) });
  const pending = editor.handlePersonalityReset();
  state.personality.personality = 'new voice';
  state.personality.user = 'new user';
  state.personality.agentName = 'New name';
  release({ ok: true, compiled: { text: '' } });
  await pending;
  assert.equal(state.personality.personality, 'new voice');
  assert.equal(state.personality.user, 'new user');
  assert.equal(state.personality.saved.agentName, 'Jenny');
  assert.equal(state.personality.saved.personality, '');
  assert.equal(state.personality.dirty, true);
});

test('a clear completion after disposal leaves editor state untouched', async () => {
  let release;
  const state = createState({ personality: 'old' });
  const editor = createPersonalityEditor({ state, dom: {}, windowRef: createWindow({
    clear() { return new Promise((resolve) => { release = resolve; }); },
  }) });
  const pending = editor.handlePersonalityReset();
  editor.dispose();
  const snapshot = JSON.stringify(state);
  release({ ok: true });
  await pending;
  assert.equal(JSON.stringify(state), snapshot);
});

test('ART-02: before a successful load, Save and Clear never reach the service', async () => {
  const calls = [];
  const state = createState({ loaded: false, personality: 'typed over a blank field', dirty: true });
  const editor = createPersonalityEditor({ state, dom: {}, windowRef: createWindow({
    save() { calls.push('save'); return { ok: true }; },
    clear() { calls.push('clear'); return { ok: true }; },
  }) });
  assert.equal(await editor.handlePersonalitySave(), false);
  await editor.handlePersonalityReset();
  assert.deepEqual(calls, []);
});
