/* The Home ask line's launcher (2026-10-21 slim): Enter opens a chat through
 * the shell's bare New chat path, prefills the composer and presses the
 * composer's own send control. The chat's model, effort and tools are the
 * composer's; Home keeps no second copy of them.
 *
 * What these tests pin:
 *  - Enter creates exactly one chat through a BARE create (no arguments, so
 *    the shell may reuse an untouched empty chat) and clicks #sendButton once.
 *  - Ctrl/Cmd+Enter stops at the prefill.
 *  - The text goes only into the chat this ask opened: if the current chat
 *    moved meanwhile, it stays in the pill (review finding 3).
 *  - A failed create keeps the question in the pill and writes nothing.
 *  - A blocked send control keeps the text in the composer, unsent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const daybookModule = require('../renderer/features/renderer-dashboard-daybook.js');
const widgetsCore = require('../renderer/features/renderer-dashboard-widgets-core.js');
const dashboardRegistryModule = require('../renderer/features/renderer-dashboard-registry.js');
const { createDashboardManager } = require('../renderer/features/renderer-dashboard-manager.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function mountLauncher(t, { createSession, sendDisabled = false } = {}) {
  const dom = new JSDOM(''
    + '<main><div class="home-daybook" id="homeDaybook">'
    + '<div id="homeInfoStrip" hidden></div>'
    + '<section id="homeDashboardGrid"></section>'
    + '<div id="homeDashboardRail"></div>'
    + '</div>'
    + '<div class="composer"><textarea id="chatInput" data-chat-node="chatInput"></textarea>'
    + `<button id="sendButton" data-chat-node="sendButton"${sendDisabled ? ' disabled' : ''}></button>`
    + '</div></main>');
  const documentRef = dom.window.document;
  globalThis.inventoryActionButton = inventoryActionButton;
  globalThis.inventoryTextField = inventoryTextField;
  t.after(() => {
    delete globalThis.inventoryActionButton;
    delete globalThis.inventoryTextField;
  });

  const calls = { creates: [], sends: 0, views: [], logs: [] };
  documentRef.getElementById('sendButton').addEventListener('click', () => { calls.sends += 1; });
  const state = {
    ui: { activeView: 'home' },
    homeConfig: { links: [], focusMode: false },
    currentSessionId: 'session_old',
  };
  const manager = createDashboardManager({
    state,
    documentRef,
    shell: null,
    dom: {
      homeInfoStrip: documentRef.getElementById('homeInfoStrip'),
      homeDashboardGrid: documentRef.getElementById('homeDashboardGrid'),
      homeDaybook: documentRef.getElementById('homeDaybook'),
      homeDashboardRail: documentRef.getElementById('homeDashboardRail'),
    },
    modules: {
      dashboardRegistry: dashboardRegistryModule,
      dashboardWidgetsCore: widgetsCore,
      dashboardDaybook: daybookModule,
    },
    callbacks: {
      appendClientLog: (level, event, details) => calls.logs.push({ level, event, details }),
      setActiveView: (view) => calls.views.push(view),
      handleCreateSession: async (...args) => {
        calls.creates.push(args);
        return createSession ? createSession(state) : '';
      },
    },
  });
  t.after(() => manager.dispose());
  manager.bind();
  manager.render();

  const pill = documentRef.getElementById('homeAskPill');
  const chatInput = documentRef.getElementById('chatInput');
  const ask = async (text, init = {}) => {
    pill.value = text;
    pill.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true, ...init,
    }));
    await settle();
  };
  return { calls, pill, chatInput, ask, state };
}

function switchTo(id) {
  return (state) => { state.currentSessionId = id; return id; };
}

test('Enter opens a chat through a bare create, prefills and presses send once', async (t) => {
  const { calls, pill, chatInput, ask } = mountLauncher(t, { createSession: switchTo('session_new') });

  await ask('why is the build red?');
  assert.deepEqual(calls.creates, [[]], 'one create, with no arguments, so an empty chat can be reused');
  assert.equal(chatInput.value, 'why is the build red?');
  assert.equal(calls.sends, 1, 'the composer send control is pressed once');
  assert.deepEqual(calls.views, ['chat']);
  assert.equal(pill.value, '', 'the pill clears on success');
});

test('Ctrl+Enter opens the chat and prefills without sending', async (t) => {
  const { calls, pill, chatInput, ask } = mountLauncher(t, { createSession: switchTo('session_new') });

  await ask('review this first', { ctrlKey: true });
  assert.equal(calls.creates.length, 1);
  assert.equal(chatInput.value, 'review this first');
  assert.equal(calls.sends, 0, 'no send');
  assert.equal(pill.value, '');
});

test('a chat switch during the create keeps the question in the pill', async (t) => {
  // The create resolves with its id, but the current chat moved elsewhere.
  const { calls, pill, chatInput, ask } = mountLauncher(t, {
    createSession: (state) => { state.currentSessionId = 'session_other'; return 'session_new'; },
  });

  await ask('not for the other chat');
  assert.equal(calls.sends, 0, 'nothing is sent into a chat the ask did not open');
  assert.equal(chatInput.value, '', 'nor written into its composer');
  assert.equal(pill.value, 'not for the other chat', 'the pill keeps the question');
  assert.equal(calls.logs.some((entry) => entry.event === 'home.ask_chat_not_opened'
    && entry.details.reason === 'session_changed'), true);
});

test('a create that returns no id keeps the question in the pill', async (t) => {
  const { calls, pill, chatInput, ask } = mountLauncher(t, { createSession: () => '' });

  await ask('still mine');
  assert.equal(calls.sends, 0);
  assert.equal(chatInput.value, '');
  assert.equal(pill.value, 'still mine');
  assert.equal(calls.logs.some((entry) => entry.details?.reason === 'missing_session_id'), true);
});

test('a failed create keeps the question in the pill and writes nothing', async (t) => {
  const { calls, pill, chatInput, ask } = mountLauncher(t, {
    createSession: () => { throw new Error('store offline'); },
  });

  await ask('keep me');
  assert.equal(pill.value, 'keep me', 'the pill keeps the question');
  assert.equal(chatInput.value, '', 'the composer is untouched');
  assert.equal(calls.sends, 0);
  assert.deepEqual(calls.views, [], 'no navigation');
  assert.equal(calls.logs.some((entry) => entry.event === 'home.ask_open_chat_failed'), true);
});

test('a blocked send control leaves the text in the composer for the user to send', async (t) => {
  const { calls, pill, chatInput, ask } = mountLauncher(t, {
    createSession: switchTo('session_new'),
    sendDisabled: true,
  });

  await ask('send me later');
  assert.equal(calls.sends, 0);
  assert.equal(chatInput.value, 'send me later');
  assert.equal(pill.value, '', 'the text is safe in the composer, so the pill clears');
});

test('empty text only navigates and creates nothing', async (t) => {
  const { calls, chatInput, ask } = mountLauncher(t, { createSession: switchTo('session_new') });

  await ask('   ');
  assert.deepEqual(calls.creates, []);
  assert.equal(chatInput.value, '');
  assert.deepEqual(calls.views, ['chat']);
});
