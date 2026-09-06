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
