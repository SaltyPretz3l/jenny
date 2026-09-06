'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

test('Chat Send disables empty drafts and tracks live composer input', async (t) => {
  const app = await loadRendererApp();
  t.after(() => app.dispose());
  const { window, shell } = app;
  const input = window.document.getElementById('chatInput');
  const send = window.document.getElementById('sendButton');

  assert.equal(send.disabled, true);
  input.value = '   ';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(send.disabled, true);

  const before = [...shell.__state.messagesBySession.values()].flat().length;
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await waitForUi(window);
  assert.equal([...shell.__state.messagesBySession.values()].flat().length, before);

  input.value = 'Ready to send';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(send.disabled, false);
  input.value = '';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(send.disabled, true);
});
