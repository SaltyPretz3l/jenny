'use strict';

// "Send to chat" (row 59 checkpoint 4): the recipient picker, the exact-text editor, prepare
// then send, and the rule that an edit after prepare starts a new operation under a new gesture.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChatSendModal } = require('../renderer/chat/renderer-chat-send-modal');
const stepModal = require('../renderer/inventory/step-modal');
const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');
const { makeBridge, flush, makeTimers } = require('./helpers/chat-messages-fixtures');

const RECIPIENTS = [
  { session_id: 'dest-1', title: 'Review the sidebar nesting copy', project_id: 'project-site', project_name: 'jenny-site', eligible: true, ineligible_reason: null },
  { session_id: 'dest-2', title: 'Memory recall: ranking review', project_id: 'project-jenny', project_name: 'jenny', eligible: true, ineligible_reason: null },
  { session_id: 'dest-3', title: 'Startup curtain timing', project_id: 'project-jenny', project_name: 'jenny', eligible: false, ineligible_reason: 'archived' },
];

function listResponse(items = RECIPIENTS) {
  return { schema_version: 1, ok: true, items, next_cursor: null, revision: 1 };
}

function harness(t, { responses = {}, items = RECIPIENTS, noBridge = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="appShell"><button id="trigger">menu</button></main></body></html>');
  const documentRef = dom.window.document;
  const timers = makeTimers();
  const bridge = makeBridge({}, {
    responses: {
      listRecipients: (request) => (request.query
        ? listResponse(items.filter((item) => item.title.toLowerCase().includes(request.query.toLowerCase())))
        : listResponse(items)),
      prepare: { schema_version: 1, ok: true, operation_id: 'op-1', envelope: {}, expires_at: '2026-10-16T00:00:00.000Z' },
      send: { schema_version: 1, ok: true, created: true, operation: { operation_id: 'op-1', state: 'delivered' } },
      cancel: { schema_version: 1, ok: true, created: false, operation: { operation_id: 'op-1', state: 'cancelled' } },
      ...responses,
    },
  });
  const toasts = [];
  const announced = [];
  let uuidCount = 0;
  const modal = createChatSendModal({
    documentRef, stepModal, actionButton, textField,
    getBridge: () => (noBridge ? null : bridge),
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    randomUUID: () => { uuidCount += 1; return `gesture-${uuidCount}`; },
    showToast: (message, options) => toasts.push({ message, options }),
    announcer: { announce: (message, options) => announced.push({ message, options }) },
  });
  t.after(() => { modal.dispose(); dom.window.close(); });
  const $ = (selector) => documentRef.querySelector(selector);
  return {
    dom, documentRef, bridge, modal, timers, toasts, announced, $,
    trigger: documentRef.getElementById('trigger'),
    open: () => modal.open({ sourceSessionId: 'source-1', sourceProjectId: 'project-jenny', trigger: documentRef.getElementById('trigger') }),
    sendButton: () => $('[data-step-modal-action="send"]'),
    option: (id) => Array.from(documentRef.querySelectorAll('[data-chat-send-option]')).find((node) => node.getAttribute('data-chat-send-option') === id),
    type(selector, value) {
      const node = $(selector);
      node.value = value;
      node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    },
    calls: (method) => bridge.calls.filter((call) => call.method === method),
  };
}

test('open renders the dialog with the sharing note and loads recipients from every project', async (t) => {
  const h = harness(t);
  assert.equal(h.open(), true);
  const dialog = h.$('[data-step-modal="chat-send-to-chat"]');
  assert.ok(dialog);
  assert.equal(dialog.querySelector('[role="dialog"]').getAttribute('aria-modal'), 'true');
  assert.match(dialog.querySelector('.inv-step-modal-title').textContent, /Share a note with another chat/u);
  assert.match(dialog.querySelector('.inv-step-modal-summary').textContent, /Only the text below is shared\. No history, files or permissions go with it, and the other chat reads it on its next turn\./u);
  await flush();
  assert.deepEqual(h.calls('listRecipients')[0].request, { schema_version: 1, source_session_id: 'source-1', limit: 50 });
  const options = Array.from(dialog.querySelectorAll('[data-chat-send-option]'));
  assert.equal(options.length, 3);
  assert.equal(dialog.querySelector('[role="listbox"]').getAttribute('aria-label'), 'Chats');
  assert.equal(options[0].getAttribute('role'), 'option');
  assert.match(options[0].textContent, /jenny-site · other project/u, 'a recipient in another project is marked');
  assert.doesNotMatch(options[1].textContent, /other project/u, 'a recipient in the source chat\'s project is not');
  assert.equal(options[2].disabled, true);
  assert.match(options[2].textContent, /archived · not available/u);
  assert.equal(h.sendButton().disabled, true);
  assert.ok(dialog.querySelector('[data-chat-send-search]'));
  assert.match(dialog.querySelector('label.inv-text-field .inv-text-field-label').textContent, /Message \(sent exactly as shown\)/u);
});

test('recipient titles and project names are escaped, never markup', async (t) => {
  const hostile = [{ session_id: 'dest-x', title: '<img src=x onerror=alert(1)>', project_id: 'p', project_name: '<b>proj</b>', eligible: true, ineligible_reason: null }];
  const h = harness(t, { items: hostile });
  h.open();
  await flush();
  assert.equal(h.documentRef.querySelector('[data-chat-send-list] img'), null);
  assert.equal(h.documentRef.querySelector('[data-chat-send-list] b'), null);
  assert.equal(h.option('dest-x').querySelector('.chat-send__option-title').textContent, '<img src=x onerror=alert(1)>');
});

test('search is debounced and sends the query; an older answer never paints over a newer one', async (t) => {
  const h = harness(t);
  h.open();
  await flush();
  h.type('[data-chat-send-search]', 'memory');
  h.type('[data-chat-send-search]', 'memory r');
  assert.equal(h.timers.queue.length, 2);
  h.timers.run();
  await flush();
  const requests = h.calls('listRecipients').map((call) => call.request);
  assert.equal(requests.length, 2, 'only the settled query was sent (the first timer saw a newer pending query)');
  assert.equal(requests[1].query, 'memory r');
  assert.equal(h.documentRef.querySelectorAll('[data-chat-send-option]').length, 1);
  h.type('[data-chat-send-search]', 'zzz');
  h.timers.run();
  await flush();
  assert.match(h.$('[data-chat-send-list]').textContent, /No chats match your search\./u);
});

test('Send enables only with an eligible recipient and a non-blank message; an archived row cannot be picked', async (t) => {
  const h = harness(t);
  h.open();
  await flush();
  h.option('dest-3').click();
  assert.equal(h.sendButton().disabled, true);
  h.option('dest-1').click();
  assert.equal(h.option('dest-1').getAttribute('aria-selected'), 'true');
  assert.equal(h.sendButton().disabled, true, 'no message yet');
  h.type('[data-chat-send-body]', '   ');
  assert.equal(h.sendButton().disabled, true, 'whitespace only');
  h.type('[data-chat-send-body]', 'Breadcrumb strings are final.');
  assert.equal(h.sendButton().disabled, false);
  h.type('[data-chat-send-body]', 'x'.repeat(16385));
  assert.equal(h.sendButton().disabled, true);
  assert.match(h.$('[data-chat-send-error]').textContent, /too long/u);
  assert.equal(h.$('[data-chat-send-error]').hidden, false);
  h.type('[data-chat-send-body]', 'ok');
  assert.equal(h.$('[data-chat-send-error]').hidden, true);
});

test('Send prepares then sends one operation, toasts the delivery and closes', async (t) => {
  const h = harness(t);
  h.open();
  await flush();
  h.option('dest-1').click();
  h.type('[data-chat-send-body]', 'Breadcrumb strings are final.');
  h.sendButton().click();
  assert.equal(h.sendButton().textContent, 'Sending…');
  await flush();
  assert.deepEqual(h.calls('prepare')[0].request, {
    schema_version: 1, source_session_id: 'source-1', destination_session_id: 'dest-1', body: 'Breadcrumb strings are final.', gesture_id: 'gesture-1',
  });
  assert.deepEqual(h.calls('send')[0].request, { schema_version: 1, operation_id: 'op-1' });
  assert.equal(h.$('[data-step-modal="chat-send-to-chat"]'), null, 'the dialog closes');
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].message, 'Sent to "Review the sidebar nesting copy"');
  assert.equal(h.calls('cancel').length, 0, 'a sent operation is not cancelled by the close');
});

test('a still-pending delivery closes with a sending toast and leaves the receipt to the strip', async (t) => {
  const h = harness(t, { responses: { send: { schema_version: 1, ok: true, created: true, operation: { operation_id: 'op-1', state: 'pending' } } } });
  h.open();
  await flush();
  h.option('dest-2').click();
  h.type('[data-chat-send-body]', 'hello');
  h.sendButton().click();
  await flush();
  assert.equal(h.toasts[0].message, 'Sending to "Memory recall: ranking review"…');
  assert.equal(h.$('[data-step-modal="chat-send-to-chat"]'), null);
});

test('a send that fails to persist keeps the dialog and the operation, and pressing Send again resends it', async (t) => {
  let sends = 0;
  const h = harness(t, {
    responses: {
      send: () => ((sends += 1) === 1
        ? { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0011', reason: 'persistence_failure', retryable: true }
        : { schema_version: 1, ok: true, created: true, operation: { operation_id: 'op-1', state: 'delivered' } }),
    },
  });
  h.open();
  await flush();
  h.option('dest-1').click();
  h.type('[data-chat-send-body]', 'first text');
  h.sendButton().click();
  await flush();
  assert.ok(h.$('[data-step-modal="chat-send-to-chat"]'), 'stays open');
  assert.match(h.$('[data-chat-send-error]').textContent, /Couldn't send the message/u);
  assert.equal(h.sendButton().disabled, false);
  assert.ok(h.announced.some((entry) => /Couldn't send/u.test(entry.message)), 'the error is announced');
  // Same text again: `send` resumes the still prepared (or pending) operation; retry would answer stale_operation.
  h.sendButton().click();
  await flush();
  assert.equal(h.calls('prepare').length, 1);
  assert.equal(h.calls('send').length, 2);
  assert.equal(h.calls('retry').length, 0);
  assert.equal(h.$('[data-step-modal="chat-send-to-chat"]'), null, 'delivered: the dialog closes');
});

test('editing the text after a prepared operation cancels it and the next Send prepares with a new gesture id', async (t) => {
  const h = harness(t, {
    responses: { send: { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0002', reason: 'unavailable', retryable: true } },
  });
  h.open();
  await flush();
  h.option('dest-1').click();
  h.type('[data-chat-send-body]', 'first text');
  h.sendButton().click();
  await flush();
  h.type('[data-chat-send-body]', 'edited text');
  await flush();
  assert.deepEqual(h.calls('cancel').map((call) => call.request), [{ schema_version: 1, operation_id: 'op-1' }]);
  h.sendButton().click();
  await flush();
  const prepares = h.calls('prepare').map((call) => call.request);
  assert.equal(prepares.length, 2);
  assert.equal(prepares[0].gesture_id, 'gesture-1');
  assert.equal(prepares[1].gesture_id, 'gesture-2');
  assert.equal(prepares[1].body, 'edited text');
});

test('picking another recipient after prepare also starts over', async (t) => {
  const h = harness(t, { responses: { send: { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0002', reason: 'unavailable', retryable: true } } });
  h.open();
  await flush();
  h.option('dest-1').click();
  h.type('[data-chat-send-body]', 'text');
  h.sendButton().click();
  await flush();
  h.option('dest-2').click();
  await flush();
  assert.equal(h.calls('cancel').length, 1);
  h.sendButton().click();
  await flush();
  assert.equal(h.calls('prepare')[1].request.destination_session_id, 'dest-2');
  assert.notEqual(h.calls('prepare')[1].request.gesture_id, h.calls('prepare')[0].request.gesture_id);
});

test('a delivery that comes back failed shows the reason and Send retries the same operation', async (t) => {
  const failed = { schema_version: 1, ok: true, created: true, operation: { operation_id: 'op-1', state: 'failed', last_error: { code: 'CMP-MESSAGE-0006', reason: 'recipient_archived', retryable: true } } };
  const h = harness(t, { responses: { send: failed, retry: { schema_version: 1, ok: true, created: false, operation: { operation_id: 'op-1', state: 'delivered' } } } });
  h.open();
  await flush();
  h.option('dest-1').click();
  h.type('[data-chat-send-body]', 'text');
  h.sendButton().click();
  await flush();
  assert.match(h.$('[data-chat-send-error]').textContent, /Couldn't deliver · that chat is archived/u);
  h.sendButton().click();
  await flush();
  assert.equal(h.calls('retry').length, 1);
  assert.equal(h.calls('prepare').length, 1);
  assert.equal(h.toasts.length, 1);
});

test('closing with a failed delivery leaves the operation to the strip (no cancel)', async (t) => {
  const failed = { schema_version: 1, ok: true, created: true, operation: { operation_id: 'op-1', state: 'failed', last_error: { code: 'CMP-MESSAGE-0006', reason: 'recipient_archived', retryable: true } } };
  const h = harness(t, { responses: { send: failed } });
  h.open();
  await flush();
  h.option('dest-1').click();
  h.type('[data-chat-send-body]', 'text');
  h.sendButton().click();
  await flush();
  h.$('[data-step-modal-action="cancel"]').click();
  await flush();
  assert.equal(h.calls('cancel').length, 0);
});

test('Cancel, the backdrop and Escape close; a prepared but unsent operation is released', async (t) => {
  const h = harness(t, { responses: { send: { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0002', reason: 'unavailable', retryable: true } } });
  h.open();
  await flush();
  h.option('dest-1').click();
  h.type('[data-chat-send-body]', 'text');
  h.sendButton().click();
  await flush();
  h.$('[data-step-modal-action="cancel"]').click();
  await flush();
  assert.equal(h.$('[data-step-modal="chat-send-to-chat"]'), null);
  assert.equal(h.calls('cancel').length, 1, 'the unsent prepared operation is released');

  h.open();
  await flush();
  h.$('.inv-step-modal-backdrop').dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.$('[data-step-modal="chat-send-to-chat"]'), null, 'a backdrop click closes');

  h.open();
  await flush();
  h.documentRef.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(h.$('[data-step-modal="chat-send-to-chat"]'), null, 'Escape closes through the step-modal lifecycle');
  assert.equal(h.documentRef.getElementById('appShell').hasAttribute('inert'), false, 'the background is released');
});

test('the dialog traps the background while open and returns focus to the row trigger on close', async (t) => {
  const h = harness(t);
  h.open();
  await flush();
  assert.equal(h.documentRef.getElementById('appShell').inert || h.documentRef.getElementById('appShell').hasAttribute('inert'), true);
  assert.equal(h.documentRef.activeElement, h.$('[data-chat-send-search]'), 'focus starts in the search field');
  h.modal.close();
  assert.equal(h.documentRef.activeElement, h.trigger);
});

test('arrow keys move through the enabled options', async (t) => {
  const h = harness(t);
  h.open();
  await flush();
  h.$('[data-chat-send-search]').dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(h.documentRef.activeElement, h.option('dest-1'));
  h.option('dest-1').dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(h.documentRef.activeElement, h.option('dest-2'));
  h.option('dest-2').dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(h.documentRef.activeElement, h.option('dest-2'), 'the disabled archived row is skipped and the list ends');
});

test('a failed recipients read offers Try again; an absent bridge refuses to open', async (t) => {
  let fail = true;
  const h = harness(t, { responses: { listRecipients: () => (fail ? { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0002', reason: 'unavailable', retryable: true } : listResponse()) } });
  h.open();
  await flush();
  assert.match(h.$('[data-chat-send-list]').textContent, /Couldn't load your chats\./u);
  fail = false;
  h.$('[data-chat-send-action="reload"]').click();
  await flush();
  assert.equal(h.documentRef.querySelectorAll('[data-chat-send-option]').length, 3);
  const bare = harness(t, { noBridge: true });
  assert.equal(bare.open(), false);
  assert.equal(bare.$('[data-step-modal="chat-send-to-chat"]'), null);
});

// ---- directional grants (row 59 cp5b-2) --------------------------------------------------------

const GRANT = { grant_id: 'grant-1', purpose: 'Benchmark hand-offs', expires_at: '2026-10-22T15:38:00.000Z', remaining_sends: 97 };
const GRANT_OK = (request) => ({ schema_version: 1, ok: true, grant: { grant_id: 'grant-new', purpose: request.purpose } });

async function pick(h, id = 'dest-1', body = 'Breadcrumb strings are final.') {
  h.open();
  await flush();
  h.option(id).click();
  h.type('[data-chat-send-body]', body);
}

function tick(h, selector) {
  const box = h.$(selector);
  box.checked = !box.checked;
  box.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  box.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
}

test('the seven-day opt-in appears once a recipient is picked and asks for a purpose', async (t) => {
  const h = harness(t);
  h.open();
  await flush();
  assert.equal(h.$('[data-chat-send-grant-toggle]'), null, 'nothing to allow before a recipient is chosen');
  h.option('dest-1').click();
  const label = h.$('[data-chat-send-grant] .inv-checkbox__label');
  assert.equal(label.textContent, 'Allow messages in this direction for seven days');
  assert.equal(h.$('[data-chat-send-grant-purpose]'), null, 'the purpose field opens with the opt-in');
  tick(h, '[data-chat-send-grant-toggle]');
  assert.ok(h.$('[data-chat-send-grant-purpose]'));
  assert.equal(h.documentRef.activeElement, h.$('[data-chat-send-grant-purpose]'));
  assert.match(h.$('[data-chat-send-grant-hint]').textContent, /Required/u);
});

test('Send waits for a purpose of 1 to 512 UTF-8 bytes when the opt-in is on', async (t) => {
  const h = harness(t);
  await pick(h);
  assert.equal(h.sendButton().disabled, false);
  tick(h, '[data-chat-send-grant-toggle]');
  assert.equal(h.sendButton().disabled, true, 'opted in with no purpose');
  h.type('[data-chat-send-grant-purpose]', '   ');
  assert.equal(h.sendButton().disabled, true, 'whitespace is not a purpose');
  h.type('[data-chat-send-grant-purpose]', 'x'.repeat(512));
  assert.equal(h.sendButton().disabled, false, '512 bytes is the limit');
  h.type('[data-chat-send-grant-purpose]', 'x'.repeat(513));
  assert.equal(h.sendButton().disabled, true);
  assert.equal(h.$('[data-chat-send-grant-hint]').getAttribute('data-invalid'), 'true');
  assert.match(h.$('[data-chat-send-grant-hint]').textContent, /too long.*512 bytes/u);
  // 170 euro signs are 170 characters but 510 bytes; 171 are 513 bytes.
  h.type('[data-chat-send-grant-purpose]', '€'.repeat(170));
  assert.equal(h.sendButton().disabled, false, 'counted in bytes, so 510 fits');
  h.type('[data-chat-send-grant-purpose]', '€'.repeat(171));
  assert.equal(h.sendButton().disabled, true, '513 bytes in 171 characters is over');
  assert.equal(h.$('[data-chat-send-grant-hint]').getAttribute('data-invalid'), 'true');
  h.type('[data-chat-send-grant-purpose]', 'ok');
  assert.equal(h.$('[data-chat-send-grant-hint]').hasAttribute('data-invalid'), false);
  tick(h, '[data-chat-send-grant-toggle]');
  assert.equal(h.sendButton().disabled, false, 'opting out clears the requirement');
});

test('an opted-in send creates the grant once, after the send, under its own fresh gesture id', async (t) => {
  const h = harness(t, { responses: { createGrant: GRANT_OK } });
  await pick(h);
  tick(h, '[data-chat-send-grant-toggle]');
  h.type('[data-chat-send-grant-purpose]', '  Hand benchmark results over  ');
  h.sendButton().click();
  h.sendButton().click(); // a second press while sending changes nothing
  await flush();
  assert.deepEqual(h.bridge.calls.map((call) => call.method).filter((method) => ['prepare', 'send', 'createGrant'].includes(method)), ['prepare', 'send', 'createGrant']);
  assert.deepEqual(h.calls('createGrant')[0].request, {
    schema_version: 1, source_session_id: 'source-1', destination_session_id: 'dest-1', purpose: 'Hand benchmark results over', gesture_id: 'gesture-2',
  });
  assert.equal(h.calls('prepare')[0].request.gesture_id, 'gesture-1');
  assert.equal(h.calls('createGrant').length, 1);
  assert.equal(h.$('[data-step-modal="chat-send-to-chat"]'), null);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].message, 'Sent to "Review the sidebar nesting copy". Messages in this direction are allowed for seven days.');
});

test('without the opt-in no grant is created, and a send that fails creates none', async (t) => {
  const plain = harness(t, { responses: { createGrant: GRANT_OK } });
  await pick(plain);
  plain.sendButton().click();
  await flush();
  assert.equal(plain.calls('createGrant').length, 0);
  assert.equal(plain.toasts[0].message, 'Sent to "Review the sidebar nesting copy"');

  const failing = harness(t, { responses: { createGrant: GRANT_OK, send: { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0002', reason: 'unavailable', retryable: true } } });
  await pick(failing);
  tick(failing, '[data-chat-send-grant-toggle]');
  failing.type('[data-chat-send-grant-purpose]', 'why');
  failing.sendButton().click();
  await flush();
  assert.equal(failing.calls('createGrant').length, 0, 'the permission follows a send that went through');
  assert.ok(failing.$('[data-step-modal="chat-send-to-chat"]'));
});

test('a grant that cannot be created never undoes the send and says why', async (t) => {
  const h = harness(t, { responses: { createGrant: { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0008', reason: 'capacity', retryable: false } } });
  await pick(h);
  tick(h, '[data-chat-send-grant-toggle]');
  h.type('[data-chat-send-grant-purpose]', 'why');
  h.sendButton().click();
  await flush();
  assert.equal(h.toasts.length, 2);
  assert.equal(h.toasts[0].message, 'Sent to "Review the sidebar nesting copy"');
  assert.equal(h.toasts[1].options.tone, 'warning');
  assert.equal(h.toasts[1].message, "Sent, but couldn't allow messages in this direction. Too many directions are already allowed from this chat. Revoke one first.");
});

test('choosing another recipient clears the opt-in: consent is per direction', async (t) => {
  const h = harness(t);
  await pick(h);
  tick(h, '[data-chat-send-grant-toggle]');
  h.type('[data-chat-send-grant-purpose]', 'why');
  h.option('dest-2').click();
  assert.equal(h.$('[data-chat-send-grant-toggle]').checked, false);
  assert.equal(h.$('[data-chat-send-grant-purpose]'), null);
  assert.equal(h.sendButton().disabled, false);
});

test('an existing grant is shown with its purpose, expiry and remaining sends, and Revoke removes it', async (t) => {
  const withGrant = RECIPIENTS.map((item) => (item.session_id === 'dest-1' ? { ...item, grant: GRANT } : { ...item, grant: null }));
  let revoked = false;
  const h = harness(t, {
    responses: {
      listRecipients: () => listResponse(revoked ? RECIPIENTS.map((item) => ({ ...item, grant: null })) : withGrant),
      revokeGrant: () => { revoked = true; return { schema_version: 1, ok: true, grant: { grant_id: 'grant-1' } }; },
    },
  });
  await pick(h);
  const slot = h.$('[data-chat-send-grant]');
  assert.match(slot.querySelector('.chat-send__grant-title').textContent, /Messages from this chat to "Review the sidebar nesting copy" are allowed/u);
  assert.match(slot.querySelector('.chat-send__grant-detail').textContent, /^Until .+ · 97 sends left$/u);
  assert.equal(slot.querySelector('.chat-send__grant-purpose').textContent, 'Purpose: Benchmark hand-offs');
  assert.equal(slot.querySelector('[data-chat-send-grant-toggle]'), null, 'already allowed: no second opt-in');
  assert.equal(h.sendButton().disabled, false);
  const revoke = slot.querySelector('[data-chat-send-action="revoke-grant"]');
  assert.equal(revoke.textContent, 'Revoke');
  assert.equal(revoke.getAttribute('aria-label'), 'Revoke messages to "Review the sidebar nesting copy"');
  const listCallsBefore = h.calls('listRecipients').length;
  revoke.click();
  revoke.click(); // a double click revokes once
  await flush();
  assert.deepEqual(h.calls('revokeGrant').map((call) => call.request), [{ schema_version: 1, source_session_id: 'source-1', grant_id: 'grant-1' }]);
  assert.equal(h.calls('listRecipients').length, listCallsBefore + 1, 'recipients are read again after a revoke');
  assert.equal(h.$('[data-chat-send-action="revoke-grant"]'), null);
  assert.ok(h.$('[data-chat-send-grant-toggle]'), 'the opt-in returns once the grant is gone');
  assert.ok(h.announced.some((entry) => /no longer allowed/u.test(entry.message)));
});

test('a revoke that fails keeps the grant on screen and shows the reason', async (t) => {
  const withGrant = RECIPIENTS.map((item) => (item.session_id === 'dest-1' ? { ...item, grant: GRANT } : item));
  const h = harness(t, { responses: { listRecipients: () => listResponse(withGrant), revokeGrant: { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0002', reason: 'unavailable', retryable: true } } });
  await pick(h);
  h.$('[data-chat-send-action="revoke-grant"]').click();
  await flush();
  assert.ok(h.$('[data-chat-send-action="revoke-grant"]'));
  assert.equal(h.$('[data-chat-send-action="revoke-grant"]').disabled, false);
  assert.equal(h.$('[data-chat-send-error]').hidden, false);
});

test('without grant support on the bridge the dialog stays a plain send', async (t) => {
  const h = harness(t);
  delete h.bridge.createGrant;
  await pick(h);
  assert.equal(h.$('[data-chat-send-grant-toggle]'), null);
  assert.equal(h.sendButton().disabled, false);
});

test('the grant purpose is one line: no pasted line break or tab reaches createGrant', async (t) => {
  const h = harness(t, { responses: { createGrant: GRANT_OK } });
  await pick(h);
  tick(h, '[data-chat-send-grant-toggle]');
  assert.equal(h.$('[data-chat-send-grant-purpose]').tagName, 'INPUT');
  h.type('[data-chat-send-grant-purpose]', 'Hand results' + '\n' + 'over' + '\t' + 'here');
  h.sendButton().click();
  await flush();
  // A single-line input drops line breaks itself; anything left becomes a space. No control character reaches the service.
  const { purpose } = h.calls('createGrant')[0].request;
  assert.doesNotMatch(purpose, /\p{Cc}/u);
  assert.match(purpose, /^Hand results ?over here$/u);
});
