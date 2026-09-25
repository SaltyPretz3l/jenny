'use strict';

/**
 * tests/renderer-turn-pause.test.js
 *
 * Runtime UX A2 (JEN-044) gate — the composer Pause control. The interaction
 * owns exactly one decision: one in-flight pause per click, for the session the
 * composer is actually looking at. Every notice belongs to the durable-send
 * controller, so nothing here may claim a pause happened.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createTurnPauseInteraction, mountTurnPauseButton } = require('../renderer/chat/renderer-turn-pause-interaction');
const inventoryActionButton = require('../renderer/inventory/action-button');

function harness({ disabled = false, sessionId = 'session-1', pauseSession = null } = {}) {
  const dom = new JSDOM('<button id="pauseTurnButton" type="button"></button>');
  const button = dom.window.document.getElementById('pauseTurnButton');
  button.disabled = disabled;
  const logs = [];
  const state = { runtimeSendController: pauseSession ? { pauseSession } : null };
  const interaction = createTurnPauseInteraction({
    button,
    state,
    getCurrentSessionId: () => sessionId,
    appendClientLog: (level, event, data) => logs.push([level, event, data]),
  });
  return { dom, button, interaction, logs, state };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('one click pauses the session the composer is looking at, and a second waits its turn', async () => {
  const calls = [];
  let settle;
  const h = harness({ pauseSession: (id) => { calls.push(id); return new Promise((done) => { settle = done; }); } });

  h.button.click();
  h.button.click();
  assert.deepEqual(calls, ['session-1'], 'a claim in flight swallows the repeat click');

  settle(true);
  await tick();
  h.button.click();
  assert.deepEqual(calls, ['session-1', 'session-1'], 'the claim is released once the runtime answers');

  h.interaction.dispose();
  h.dom.window.close();
});

test('a disabled Pause button asks the runtime for nothing', () => {
  const calls = [];
  const h = harness({ disabled: true, pauseSession: (id) => { calls.push(id); } });
  h.button.click();
  assert.deepEqual(calls, []);
  h.interaction.dispose();
  h.dom.window.close();
});

test('a click with no session and a click with no controller are both inert', () => {
  const calls = [];
  const withoutSession = harness({ sessionId: '', pauseSession: (id) => { calls.push(id); } });
  withoutSession.button.click();
  withoutSession.interaction.dispose();
  withoutSession.dom.window.close();

  const withoutController = harness();
  withoutController.button.click();
  withoutController.interaction.dispose();
  withoutController.dom.window.close();

  assert.deepEqual(calls, []);
});

test('a pause that throws is logged and releases its claim instead of dead-locking the button', async () => {
  let attempts = 0;
  const h = harness({ pauseSession: () => { attempts += 1; throw new Error('bridge_gone'); } });
  h.button.click();
  await tick();
  assert.equal(attempts, 1);
  assert.equal(h.logs.at(-1)[1], 'chat.turn_pause_failed');
  assert.equal(JSON.stringify(h.logs).includes('bridge_gone'), true);
  h.button.click();
  await tick();
  assert.equal(attempts, 2, 'a failed pause does not strand the claim');
  h.interaction.dispose();
  h.dom.window.close();
});

test('disposing detaches the listener and a second dispose is harmless', () => {
  const calls = [];
  const h = harness({ pauseSession: (id) => { calls.push(id); } });
  h.interaction.dispose();
  h.interaction.dispose();
  h.button.click();
  assert.deepEqual(calls, []);
  h.dom.window.close();
});

test('the control is built through the inventory primitive, placed before Stop, and mounted once', () => {
  const dom = new JSDOM('<div class="composer-actions"><button id="stopStreamButton" type="button"></button></div>');
  const document = dom.window.document;
  const stop = document.getElementById('stopStreamButton');
  const button = mountTurnPauseButton({ anchor: stop, actionButton: inventoryActionButton });
  assert.equal(button.id, 'pauseTurnButton');
  assert.equal(button.nextElementSibling, stop, 'Pause precedes Stop in the same row');
  assert.equal(button.getAttribute('type'), 'button');
  assert.deepEqual([...button.classList], ['composer-pause-button', 'hidden']);
  assert.equal(button.getAttribute('aria-label'), 'Pause this reply');
  assert.equal(button.dataset.i18nAriaLabel, 'composer.pauseReply', 'translated at boot like Stop');
  assert.equal(button.dataset.i18nTitle, 'composer.pauseReplyTitle');
  assert.equal(button.querySelectorAll('svg rect').length, 2, 'two bars');
  assert.equal(button.querySelector('svg').getAttribute('aria-hidden'), 'true');
  assert.equal(button.querySelector('.sr-only'), null, 'aria-label is the accessible name; no dead screen-reader span');
  assert.equal(button.title, 'Pause at the next approval');
  assert.equal(mountTurnPauseButton({ anchor: stop, actionButton: inventoryActionButton }), button, 'a second mount returns the same control');
  assert.equal(document.querySelectorAll('.composer-pause-button').length, 1);
  dom.window.close();
});

test('the control is not built without an anchor in the document or without the primitive', () => {
  const dom = new JSDOM('<button id="stopStreamButton" type="button"></button>');
  const stop = dom.window.document.getElementById('stopStreamButton');
  assert.equal(mountTurnPauseButton({ anchor: stop, actionButton: null }), null);
  assert.equal(mountTurnPauseButton({ anchor: null, actionButton: inventoryActionButton }), null);
  assert.equal(mountTurnPauseButton(), null);
  assert.equal(mountTurnPauseButton({ anchor: stop, actionButton: () => '' }), null, 'an empty render mounts nothing');
  assert.equal(dom.window.document.querySelector('.composer-pause-button'), null);
  dom.window.close();
});

test('a missing button yields a disposable no-op instead of throwing at construction', () => {
  const interaction = createTurnPauseInteraction({ button: null, state: {}, getCurrentSessionId: () => 's' });
  assert.equal(typeof interaction.dispose, 'function');
  interaction.dispose();
  assert.equal(typeof createTurnPauseInteraction().dispose, 'function');
});
