'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createConversationTransferController } = require('../renderer/shell/renderer-settings-conversation-transfer');
function harness(t, bridge, openJenny) {
  const dom = new JSDOM('<div id="conversationTransferHost"></div>');
  const host = dom.window.document.getElementById('conversationTransferHost');
  const controller = createConversationTransferController({ windowRef: dom.window, host, openJenny,
    inventory: { actionButton: require('../renderer/inventory/action-button'),
      selectField: require('../renderer/inventory/select-field') }, getBridge: () => bridge });
  controller.bind();
  t.after(() => { controller.dispose(); dom.window.close(); });
  const click = async (action) => {
    host.querySelector('[data-transfer-action="' + action + '"]').click();
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const change = (id, value) => {
    const element = host.querySelector('#' + id); element.value = value;
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  return { dom, host, controller, click, change };
}
const previewFixture = () => ({ ok: true, previewToken: 'opaque', title: '<script>unsafe</script>',
  sourceWorkspace: '<source>', destinationWorkspace: 'General, no folder granted',
  messageCount: 2, attachmentCount: 1, warnings: ['missing original: a.txt'],
  dialogue: [{ role: 'user', content: '<img onerror=unsafe>' }, { role: 'assistant', content: 'answer' }], receipt: null });

test('source -> archived selection -> escaped preview -> copy -> open -> explicit copy again', async (t) => {
  const calls = [];
  const opened = [];
  const h = harness(t, {
    list: async (request) => { calls.push(['list', request]); return { ok: true, conversations: [{ id: 'chat', title: 'Archived', archived: true }] }; },
    preview: async (request) => { calls.push(['preview', request]); return previewFixture(); },
    copy: async (request) => { calls.push(['copy', request]); return { ok: true, receipt: { state: 'completed', operationId: 'op' } }; },
    open: async (request) => { calls.push(['open', request]); return { ok: true, destination: 'jenny', destinationId: 'destination' }; },
  }, async (id) => opened.push(id));
  assert.equal(calls.length, 0, 'binding does not start native processes');
  h.change('transferSource', 'codex');
  await h.click('list');
  assert.match(h.host.textContent, /Archived \(archived\)/);
  h.change('transferConversation', 'chat');
  await h.click('preview');
  assert.equal(h.host.querySelector('script'), null);
  assert.equal(h.host.querySelector('img'), null);
  assert.match(h.host.textContent, /missing original: a.txt/);
  await h.click('copy');
  assert.deepEqual(calls.find((row) => row[0] === 'copy')[1], { previewToken: 'opaque' });
  await h.click('open');
  assert.deepEqual(opened, ['destination']);
  await h.click('again');
  assert.equal(calls.filter((row) => row[0] === 'copy').length, 1, 'Copy again first makes a fresh preview');
  assert.equal(calls.findLast((row) => row[0] === 'preview')[1].copyAgain, true);
});

test('failure keeps the copy pending, and disposal prevents late repaint/open', async (t) => {
  let resolveCopy;
  const h = harness(t, {
    list: async () => ({ ok: true, conversations: [{ id: 'chat', title: 'Chat' }] }),
    preview: async () => previewFixture(),
    copy: () => new Promise((resolve) => { resolveCopy = resolve; }),
  });
  await h.click('list'); h.change('transferConversation', 'chat'); await h.click('preview');
  h.host.querySelector('[data-transfer-action="copy"]').click();
  const html = h.host.innerHTML;
  assert.equal(h.host.querySelector('[data-transfer-action="copy"]').disabled, true);
  h.controller.dispose();
  resolveCopy({ ok: true, receipt: { state: 'completed', operationId: 'op' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.host.innerHTML, html);
  assert.equal(h.host.querySelector('[data-transfer-action="open"]'), null);
});

test('busy selections are disabled and bridge failures produce accessible status', async (t) => {
  const h = harness(t, { list: async () => ({ ok: true, conversations: [{ id: 'busy', title: 'Busy', busy: true }] }),
    preview: async () => ({ ok: false, message: 'Wait for the source to settle.' }) });
  await h.click('list');
  assert.equal(h.host.querySelector('option[value="busy"]').disabled, true);
  h.change('transferConversation', 'busy');
  await h.click('preview');
  assert.match(h.host.querySelector('[role="status"]').textContent, /Wait for the source/);
});
