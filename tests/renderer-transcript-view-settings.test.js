'use strict';

// Transcript view default: how the persisted chatUi value reaches renderer
// state at boot (both seed paths) and how the per-session view choice follows a
// session's lifecycle (rekey on promotion, forget on removal) through the real
// shell. The Settings select handler lives in renderer-settings-chat-ui-fields.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { segmentedGroup, segmentedValue } = require('./helpers/segmented-control');
const transcriptViewUtils = require('../renderer/chat/renderer-transcript-view-utils.js');
const { createRendererBootstrap } = require('../renderer/shell/renderer-bootstrap-utils.js');

const SEED_CASES = [
  ['answers', 'answers'],
  ['everything', 'everything'],
  ['thinking', 'thinking'],
  ['verbose', 'thinking'],
  [undefined, 'thinking'],
];

async function bootSeed(saved) {
  const documentStub = {
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const previous = { shell: globalThis.jennyShell, utils: globalThis.rendererTranscriptViewUtils };
  globalThis.jennyShell = { chatUi: { async getState() { return { transcriptViewDefault: saved }; } } };
  globalThis.rendererTranscriptViewUtils = transcriptViewUtils;
  try {
    const bootstrap = createRendererBootstrap({
      document: documentStub,
      getDefaultAppearancePreferences: () => ({}),
      appearanceUtils: { STORAGE_KEY: 'jenny.appearance.test' },
    });
    await waitForUiTick();
    return bootstrap.state.transcriptViewDefault;
  } finally {
    globalThis.jennyShell = previous.shell;
    globalThis.rendererTranscriptViewUtils = previous.utils;
  }
}

const waitForUiTick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('renderer bootstrap seeds transcriptViewDefault from chatUi state and falls back to thinking', async () => {
  for (const [saved, expected] of SEED_CASES) {
    assert.equal(await bootSeed(saved), expected, `saved ${String(saved)} seeds ${expected}`);
  }
});

test('a real renderer boot applies the persisted default to the timeline and the Settings control', async () => {
  for (const [saved, expected] of [SEED_CASES[0], SEED_CASES[1], SEED_CASES[3]]) {
    const app = await loadRendererApp({ shell: { chatUi: { getState: () => ({ transcriptViewDefault: saved }) } } });
    try {
      const { window } = app;
      await waitForUi(window, 40);
      assert.equal(window.document.getElementById('chatTimeline').dataset.transcriptView, expected, `timeline view for saved ${saved}`);
      window.document.getElementById('settingsTopRailTab').click();
      await waitForUi(window, 60);
      window.document.querySelector('.settings-nav-item[data-settings-section="appearance"]')?.click();
      await waitForUi(window, 60);
      assert.ok(segmentedGroup(window.document, 'transcriptViewDefaultSelect'), 'the Settings control renders');
      assert.equal(segmentedValue(window.document, 'transcriptViewDefaultSelect'), expected, `selected view for saved ${saved}`);
    } finally {
      await app.dispose();
    }
  }
});

function spyOnController(window) {
  const controller = window.rendererTranscriptViewController;
  assert.ok(controller, 'the app publishes its transcript view controller');
  const calls = { rekey: [], forget: [] };
  const original = { rekeySession: controller.rekeySession, forgetSession: controller.forgetSession };
  controller.rekeySession = (...args) => { calls.rekey.push(args); return original.rekeySession(...args); };
  controller.forgetSession = (...args) => { calls.forget.push(args); return original.forgetSession(...args); };
  return calls;
}

test('removing a session forgets its transcript view choice', async (t) => {
  const app = await loadRendererApp({});
  t.after(() => app.dispose());
  const { window, shell } = app;
  const calls = spyOnController(window);
  shell.__state.sessions = [{
    id: 'session-forget', title: 'Forget Me', conversation_mode: 'chat', preferred_model: 'gpt-test', reasoning_effort: 'default',
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    interactive_round_count: 0, interactive_sequence_state: 'idle', pending_question_batch: null, linked_session_ids: [],
    message_count: 1, last_message_preview: 'x', updated_at: '2026-06-12T08:00:00.000Z', created_at: '2026-06-12T08:00:00.000Z',
    pinned: false, archived_at: null,
  }];
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 40);

  window.document.querySelector('[data-session-action="menu"][data-session-id="session-forget"]').click();
  await waitForUi(window, 10);
  [...window.document.querySelectorAll('.inv-context-menu-item')].find((b) => b.textContent.trim() === 'Delete').click();
  await waitForUi(window, 30);
  window.document.querySelector('[data-toast-action-id="session-delete-now"]').click();
  await waitForUi(window, 80);

  assert.deepEqual(calls.forget, [['session-forget']]);
});

test('promoting a first-send chat rekeys its transcript view choice to the accepted session id', async (t) => {
  const app = await loadRendererApp({});
  t.after(() => app.dispose());
  const { window } = app;
  const calls = spyOnController(window);
  const input = window.document.getElementById('chatInput');
  input.value = 'hello';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.getElementById('sendButton').click();
  await waitForUi(window, 80);

  assert.equal(calls.rekey.length, 1, 'one promotion rekeys once');
  const [from, to] = calls.rekey[0];
  assert.ok(from && to && from !== to, 'rekey moves from the optimistic id to the accepted id');
  assert.match(to, /^session-/);
});
