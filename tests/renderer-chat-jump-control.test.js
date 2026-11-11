'use strict';

/* The one bottom-edge jump control (merged wayfinder + return-to-latest): the composer chrome renders it from the
 * wayfinder's published model, matched to the pane's own session. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const composerChrome = require('../renderer/chat/renderer-render-pipeline-chrome-composer');

function build(t, { chatWayfinder = null, following: followingStart = true, messages = [{ id: 'u1' }], paneSessionId = 'session-a' } = {}) {
  const { window } = new JSDOM(`<!doctype html><body>
    <div class="composer-jump-tools hidden"><button id="top"></button></div>
    <button id="bottom" class="chat-jump-latest" data-visible="false" inert aria-label="Jump to bottom of chat"><svg></svg></button>
    <textarea id="input"></textarea></body>`);
  t.after(() => window.close());
  const doc = window.document;
  const state = { ui: { chatWayfinder } };
  const following = { value: followingStart };
  const chrome = composerChrome.createComposerChrome({
    state,
    documentRef: doc,
    getPaneSessionId: () => paneSessionId,
    isFollowingLatest: () => following.value,
    dom: {
      chatInput: doc.getElementById('input'),
      jumpToTopButton: doc.getElementById('top'),
      jumpToBottomButton: doc.getElementById('bottom'),
    },
    callbacks: {
      getVisibleSessionMessages: () => messages,
    },
  });
  return { state, doc, following, button: doc.getElementById('bottom'), tools: doc.querySelector('.composer-jump-tools'), render: chrome.renderComposerJumpControls };
}

const tip = (button) => button.getAttribute('data-tooltip');

test('at the live end the control stays hidden, whatever the wayfinder names', (t) => {
  const { button, tools, render } = build(t, { following: true, chatWayfinder: { visible: true, state: 'unread', label: 'Jump to first unread', messageId: 'a1', sessionId: 'session-a' } });
  render();
  assert.equal(button.dataset.visible, 'false');
  assert.equal(button.hasAttribute('inert'), true);
  assert.equal(tools.classList.contains('hidden'), true);
});

test('once the reader scrolls up, first unread takes the control and names itself only in the tooltip', (t) => {
  const { button, tools, render } = build(t, { following: false, chatWayfinder: { visible: true, state: 'unread', label: 'Jump to first unread', messageId: 'a1', sessionId: 'session-a' } });
  render();
  assert.equal(button.textContent.trim(), '', 'the control has no words of its own');
  assert.equal(button.querySelector('.chat-jump-latest-label'), null);
  assert.equal(button.dataset.jumpState, 'unread');
  assert.equal(button.dataset.visible, 'true');
  assert.equal(button.hasAttribute('inert'), false);
  assert.equal(button.getAttribute('aria-label'), 'Jump to first unread');
  assert.equal(tip(button), 'Jump to first unread');
  assert.equal(button.hasAttribute('title'), false, 'the tooltip system deletes title on hover; a render must not restore it');
  assert.equal(tools.classList.contains('hidden'), true, 'the top button yields to the pick, as before');
});

test('with no wayfinder pick the control is "Latest" while away from the live end, named Return to latest', (t) => {
  const { button, tools, render } = build(t, { following: false });
  render();
  assert.equal(tip(button), 'Return to latest');
  assert.equal(button.dataset.jumpState, 'latest');
  assert.equal(button.dataset.visible, 'true');
  assert.equal(button.getAttribute('aria-label'), 'Return to latest');
  assert.equal(tools.classList.contains('hidden'), false, 'the top button stays available when only Latest is offered');
});

test('the wayfinder publishing "latest" itself still leaves the top button available', (t) => {
  const { button, tools, render } = build(t, {
    following: false,
    chatWayfinder: { visible: true, state: 'latest', label: 'Return to latest', messageId: '', sessionId: 'session-a' },
  });
  render();
  assert.equal(button.dataset.jumpState, 'latest');
  assert.equal(button.dataset.visible, 'true');
  assert.equal(tools.classList.contains('hidden'), false);
});

test('a second pane\'s latest-only control ignores the wayfinder even when the session matches', (t) => {
  const { button, render } = build(t, {
    following: false,
    chatWayfinder: { visible: true, state: 'unread', label: 'Jump to first unread', messageId: 'a1', sessionId: 'session-a' },
  });
  button.dataset.jumpLatestOnly = 'true';
  render();
  assert.equal(button.dataset.jumpState, 'latest');
});

test('a jump change refreshes a tooltip still showing, and a fade-out closes it', (t) => {
  const { state, following, button, render } = build(t, {
    following: false,
    chatWayfinder: { visible: true, state: 'unread', label: 'Jump to first unread', messageId: 'a1', sessionId: 'session-a' },
  });
  let refreshes = 0;
  let hides = 0;
  globalThis.inventoryTooltip = { refresh: () => { refreshes += 1; }, hide: () => { hides += 1; } };
  t.after(() => { delete globalThis.inventoryTooltip; });
  button.matches = () => true;
  render();
  assert.equal(refreshes, 1, 'first text write');
  render();
  assert.equal(refreshes, 1, 'an unchanged render does nothing');
  state.ui.chatWayfinder = null;
  render();
  assert.equal(refreshes, 2, 'unread became latest');
  assert.equal(hides, 0);
  state.ui.chatWayfinder = null;
  following.value = true;
  render();
  assert.equal(hides, 1, 'the control faded out under the pointer');
});

test('the control fades out and leaves the focus order once the reader is back at the live end', (t) => {
  const { button, doc, render } = build(t, { following: true });
  button.removeAttribute('inert');
  button.dataset.visible = 'true';
  button.focus();
  assert.equal(doc.activeElement, button);
  render();
  assert.equal(button.dataset.visible, 'false');
  assert.equal(button.hasAttribute('inert'), true);
  assert.notEqual(doc.activeElement, button, 'focus returns to the composer');
});

test('a model naming another session is ignored, so two panes never share a pick', (t) => {
  const { button, render } = build(t, {
    following: false,
    paneSessionId: 'session-b',
    chatWayfinder: { visible: true, state: 'unread', label: 'Jump to first unread', messageId: 'a1', sessionId: 'session-a' },
  });
  render();
  assert.equal(tip(button), 'Return to latest');
  assert.equal(button.dataset.jumpState, 'latest');
});

test('an empty chat shows no control', (t) => {
  const { button, render } = build(t, { messages: [], following: false });
  render();
  assert.equal(button.dataset.visible, 'false');
  assert.equal(button.hasAttribute('inert'), true);
});
