'use strict';

// Owner option C (2026-10-20, Claude Code parity): a queued send is its own user bubble in the
// conversation, greyed until it starts, with one line of state and actions under it. Withdraw
// puts the text back in the composer as a draft; Up in an empty composer takes them all back.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const queueView = require('../renderer/chat/renderer-runtime-queue-view');

function setup(t, ids = ['user_a', 'user_b']) {
  const dom = new JSDOM(`<!doctype html><html><body><div class="chat-timeline" id="timeline">${ids
    .map((id) => `<article class="chat-entry" data-message-id="${id}"><div class="chat-bubble">${id}</div>`
      + '<div class="chat-hover-row"></div></article>').join('')}</div><textarea id="input"></textarea></body></html>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  return { dom, doc, timeline: doc.getElementById('timeline'), input: doc.getElementById('input') };
}

function row(overrides = {}) {
  return { key: 'durable_a', workId: 'work_a', userId: 'user_a', prompt: 'Say hello in five words.', status: 'pending',
    queued: true, position: 1, wait: null, resumable: true, ...overrides };
}

const article = (doc, id) => doc.querySelector(`.chat-entry[data-message-id="${id}"]`);

test('a queued send greys its own bubble and gets a "Queued" line with Withdraw; the strip keeps nothing for it', (t) => {
  const { doc, timeline } = setup(t);
  const shown = queueView.syncQueuedBubbles({ timeline, rows: [row()], actions: { withdraw: () => true } });
  assert.deepEqual([...shown], ['durable_a']);
  const node = article(doc, 'user_a');
  assert.equal(node.getAttribute('data-queued-send'), 'queued');
  const meta = node.querySelector('[data-queued-send-meta]');
  assert.match(meta.textContent, /^Queued\s*Withdraw$/u);
  assert.equal(meta.querySelector('button').disabled, false);
  assert.equal(article(doc, 'user_b').hasAttribute('data-queued-send'), false);
});

test('an idle direct send, a running send, a detached paused reply and a bubble not drawn are not decorated', (t) => {
  const { doc, timeline } = setup(t);
  const shown = queueView.syncQueuedBubbles({ timeline, actions: {}, rows: [
    row({ key: 'idle', queued: false }),
    row({ key: 'run', status: 'running' }),
    row({ key: 'work:x', userId: '', detached: true, status: 'paused' }),
    row({ key: 'missing', userId: 'user_zz' }),
  ] });
  assert.equal(shown.size, 0);
  assert.equal(doc.querySelectorAll('[data-queued-send]').length, 0);
});

test('Withdraw withdraws the send and puts its text back in the composer ahead of what is typed', async (t) => {
  const { doc, timeline, input } = setup(t);
  const withdrawn = [];
  const inputs = [];
  input.addEventListener('input', () => inputs.push(input.value));
  input.value = 'half typed';
  const actions = {
    withdraw: async (target) => { withdrawn.push(target.key); return true; },
    putDraft: (texts) => queueView.putBackInComposer(input, texts),
  };
  queueView.syncQueuedBubbles({ timeline, rows: [row()], actions });
  article(doc, 'user_a').querySelector('.queued-send-meta__action--withdraw').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(withdrawn, ['durable_a']);
  assert.equal(input.value, 'Say hello in five words.\nhalf typed');
  assert.deepEqual(inputs, ['Say hello in five words.\nhalf typed'], 'the composer hears the same input event as typing');
});

test('a refused withdrawal keeps the composer as it was', async (t) => {
  const { doc, timeline, input } = setup(t);
  const actions = { withdraw: async () => false, putDraft: (texts) => queueView.putBackInComposer(input, texts) };
  queueView.syncQueuedBubbles({ timeline, rows: [row()], actions });
  article(doc, 'user_a').querySelector('.queued-send-meta__action--withdraw').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.value, '');
});

test('the line follows the send: withdrawing, paused with Resume, stuck with Restart engine, then gone once it starts', (t) => {
  const { doc, timeline } = setup(t);
  const actions = { withdraw: () => true, resume: () => true, restartEngine: () => true };
  queueView.syncQueuedBubbles({ timeline, rows: [row({ status: 'withdrawing' })], actions });
  const meta = () => article(doc, 'user_a').querySelector('[data-queued-send-meta]');
  assert.match(meta().textContent, /Withdrawing…/u);
  assert.equal(meta().querySelector('.queued-send-meta__action--withdraw').disabled, true);
  queueView.syncQueuedBubbles({ timeline, rows: [row({ status: 'paused' })], actions });
  assert.equal(article(doc, 'user_a').getAttribute('data-queued-send'), 'paused');
  assert.ok(meta().querySelector('.queued-send-meta__action--resume'));
  queueView.syncQueuedBubbles({ timeline, rows: [row({ wait: { reason: 'cleanup_unconfirmed' } })], actions });
  assert.equal(article(doc, 'user_a').getAttribute('data-queued-send'), 'stuck');
  assert.ok(meta().querySelector('.queued-send-meta__action--restart'));
  queueView.syncQueuedBubbles({ timeline, rows: [row({ status: 'running' })], actions });
  assert.equal(article(doc, 'user_a').hasAttribute('data-queued-send'), false);
  assert.equal(meta(), null);
});

test('an unchanged line is not rebuilt, so focus stays on its button', (t) => {
  const { doc, timeline } = setup(t);
  const actions = { withdraw: () => true };
  queueView.syncQueuedBubbles({ timeline, rows: [row()], actions });
  const button = article(doc, 'user_a').querySelector('.queued-send-meta__action--withdraw');
  button.focus();
  queueView.syncQueuedBubbles({ timeline, rows: [row()], actions });
  assert.equal(article(doc, 'user_a').querySelector('.queued-send-meta__action--withdraw'), button);
  assert.equal(doc.activeElement, button);
});

test('Up in an empty composer takes every queued send back, in order, as one draft', async (t) => {
  const { dom, input } = setup(t);
  const withdrawn = [];
  const rows = [row(), row({ key: 'durable_b', workId: 'work_b', userId: 'user_b', prompt: 'Draft the release note.', position: 2 })];
  const actions = {
    withdraw: async (target) => { withdrawn.push(target.key); return true; },
    putDraft: (texts) => queueView.putBackInComposer(input, texts),
  };
  const up = () => new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true });
  const event = up();
  assert.equal(queueView.handleTakeBackKeydown(event, { input, rows, actions }), true);
  assert.equal(event.defaultPrevented, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(withdrawn, ['durable_a', 'durable_b']);
  assert.equal(input.value, 'Say hello in five words.\nDraft the release note.');
  // With text in the composer, or nothing to take back, Up is the composer's own key.
  assert.equal(queueView.handleTakeBackKeydown(up(), { input, rows, actions }), false);
  input.value = '';
  assert.equal(queueView.handleTakeBackKeydown(up(), { input, rows: [row({ workId: '' })], actions }), false);
  assert.equal(queueView.handleTakeBackKeydown(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true }),
    { input, rows, actions }), false);
});
