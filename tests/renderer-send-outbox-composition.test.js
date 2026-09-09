const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="sendOutbox"></div><div id="timeline"></div>');
// Chrome captures its document at module load, as in production script order.
global.window = dom.window;
global.document = dom.window.document;
global.rendererSendOutboxRender = require('../renderer/chat/renderer-send-outbox-render');
const { createPipelineHarness } = require('./helpers/render-pipeline-test-harness');
const { createChatShellController } = require('../renderer/chat/renderer-chat-shell-controller');
const { createSendOutbox } = require('../renderer/chat/renderer-send-outbox');

test('real shell -> render pipeline -> chrome queue controls mutate current store entries', async () => {
  let shell = null;
  const composerDom = {};
  for (const name of ['chatInput', 'sendButton', 'composer', 'composerModelSelect', 'composerEffortSelect', 'composerSettingsButton']) {
    composerDom[name] = dom.window.document.createElement(name === 'chatInput' ? 'textarea' : 'div');
  }
  const { state, pipeline } = createPipelineHarness({ dom, composerDom,
    controllers: { getSendOutboxActions: () => shell?.sendOutboxActions } });
  const store = createSendOutbox(state);
  state.sendOutboxController = store;
  const host = dom.window.document.getElementById('sendOutbox');
  const first = store.enqueue(state.currentSessionId, { prompt: 'First' });
  pipeline.renderComposerState();
  assert.ok(host.querySelector('.send-outbox__preview').disabled, 'initialization gap is visibly disabled');
  const dispatches = [];
  shell = createChatShellController({ state, windowRef: dom.window, dom: composerDom,
    slashDependencies: {}, controllers: {},
    callbacks: { renderComposerState: () => pipeline.renderComposerState(), renderSessions() {} },
    factories: { composerFlowUtils: { createComposerV2FlowController: () => ({}) }, sendUtils: { createSendController: () => ({ dispatchQueuedSendForSession: async (id) => dispatches.push(id) }) } },
  });
  pipeline.renderComposerState();
  host.querySelector('.send-outbox__preview').click();
  await store.settleContextCapture(first, Promise.resolve({ captured: true }));
  // Click the row rendered BEFORE the capture revision changed.
  host.querySelector('textarea').value = 'Saved edit';
  [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save').click();
  assert.equal(store.peek(state.currentSessionId).prompt, 'Saved edit');
  assert.equal(store.peek(state.currentSessionId).meta.captured, true);
  assert.deepEqual(dispatches, [state.currentSessionId]);
  const second = store.enqueue(state.currentSessionId, { prompt: 'Cancel after capture' });
  pipeline.renderComposerState();
  await store.settleContextCapture(second, Promise.resolve({}));
  host.querySelector(`[data-outbox-item-id="${second.id}"] .send-outbox__action--cancel`).click();
  assert.equal(store.list(state.currentSessionId).length, 1);
  // An old enabled row must not cancel a dispatch which has already started.
  pipeline.renderComposerState();
  const cancel = host.querySelector('.send-outbox__action--cancel');
  store.replace(store.peek(state.currentSessionId), { status: 'sending' });
  cancel.click();
  assert.equal(store.peek(state.currentSessionId).status, 'sending');
  assert.equal(await shell.sendOutboxActions.edit(first, 'Too late'), null);
  store.dispose();
  global.rendererSendOutboxRender.disposeSendOutboxRender(host);
});
