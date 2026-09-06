/* Composer V2 blocked-send tooltip — MutationObserver-driven title resolver
 * that surfaces a human-readable reason when #sendButton is disabled. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createComposerBlockedSendTooltipRenderer } = require('../renderer/chat/renderer-composer-v2-render');

function buildHarness(t, { defaultTitle = 'Send' } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="sendButton" type="button" title="' + defaultTitle + '">Send</button></body>');
  const doc = dom.window.document;
  const sendButton = doc.getElementById('sendButton');
  return { dom, doc, sendButton };
}

function waitMicrotask(win) {
  return new Promise((resolve) => win.setTimeout(resolve, 0));
}

test('tooltip initial render leaves default title when button is enabled', (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerBlockedSendTooltipRenderer({
    sendButton: harness.sendButton,
    getReason: () => 'should not be used',
  });
  t.after(() => renderer.destroy());
  assert.equal(harness.sendButton.getAttribute('title'), 'Send');
});

test('tooltip swaps to reason text when button is disabled via .disabled property', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerBlockedSendTooltipRenderer({
    sendButton: harness.sendButton,
    getReason: () => 'Wait for the current response to finish, or stop it.',
  });
  t.after(() => renderer.destroy());
  harness.sendButton.disabled = true;
  await waitMicrotask(harness.dom.window);
  assert.equal(
    harness.sendButton.getAttribute('title'),
    'Wait for the current response to finish, or stop it.',
  );
});

test('tooltip restores default title when button is re-enabled', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerBlockedSendTooltipRenderer({
    sendButton: harness.sendButton,
    getReason: () => 'Type a message or attach a file.',
  });
  t.after(() => renderer.destroy());
  harness.sendButton.disabled = true;
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.sendButton.getAttribute('title'), 'Type a message or attach a file.');
  harness.sendButton.disabled = false;
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.sendButton.getAttribute('title'), 'Send');
});

test('tooltip restores the static Send keyboard hint when button is re-enabled', async (t) => {
  const harness = buildHarness(t, { defaultTitle: 'Send message (Enter)' });
  const renderer = createComposerBlockedSendTooltipRenderer({
    sendButton: harness.sendButton,
    getReason: () => 'Type a message or attach a file.',
  });
  t.after(() => renderer.destroy());
  harness.sendButton.disabled = true;
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.sendButton.getAttribute('title'), 'Type a message or attach a file.');
  harness.sendButton.disabled = false;
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.sendButton.getAttribute('title'), 'Send message (Enter)');
});

test('tooltip falls back when getReason returns empty', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerBlockedSendTooltipRenderer({
    sendButton: harness.sendButton,
    getReason: () => '',
  });
  t.after(() => renderer.destroy());
  harness.sendButton.disabled = true;
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.sendButton.getAttribute('title'), 'Send is currently unavailable.');
});

test('tooltip resilient to getReason throwing', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerBlockedSendTooltipRenderer({
    sendButton: harness.sendButton,
    getReason: () => { throw new Error('boom'); },
  });
  t.after(() => renderer.destroy());
  harness.sendButton.disabled = true;
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.sendButton.getAttribute('title'), 'Send is currently unavailable.');
});

test('tooltip honors aria-disabled="true" as a blocked signal', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerBlockedSendTooltipRenderer({
    sendButton: harness.sendButton,
    getReason: () => 'Sign in to send messages.',
  });
  t.after(() => renderer.destroy());
  harness.sendButton.setAttribute('aria-disabled', 'true');
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.sendButton.getAttribute('title'), 'Sign in to send messages.');
});

test('tooltip destroy() restores default title and stops observing', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerBlockedSendTooltipRenderer({
    sendButton: harness.sendButton,
    getReason: () => 'Connecting to the model…',
  });
  harness.sendButton.disabled = true;
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.sendButton.getAttribute('title'), 'Connecting to the model…');
  renderer.destroy();
  assert.equal(harness.sendButton.getAttribute('title'), 'Send');
  // Mutation after destroy should not change the title
  harness.sendButton.disabled = true;
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.sendButton.getAttribute('title'), 'Send');
});

test('tooltip throws clear errors when deps are missing', () => {
  assert.throws(() => createComposerBlockedSendTooltipRenderer({}), /sendButton is required/);
  assert.throws(
    () => createComposerBlockedSendTooltipRenderer({ sendButton: {} }),
    /getReason must be a function/,
  );
});

test('tooltip preserves explicit defaultTitle override', async (t) => {
  const harness = buildHarness(t, { defaultTitle: 'original' });
  const renderer = createComposerBlockedSendTooltipRenderer({
    sendButton: harness.sendButton,
    getReason: () => 'Reason here.',
    defaultTitle: 'Override Send',
  });
  t.after(() => renderer.destroy());
  harness.sendButton.disabled = true;
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.sendButton.getAttribute('title'), 'Reason here.');
  harness.sendButton.disabled = false;
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.sendButton.getAttribute('title'), 'Override Send');
});
