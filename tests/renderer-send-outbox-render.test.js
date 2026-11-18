const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { renderSendOutbox } = require('../renderer/chat/renderer-send-outbox-render');

test('visible outbox renders FIFO status and exact item controls', () => {
  const dom = new JSDOM('<div id="outbox"></div>');
  const host = dom.window.document.getElementById('outbox');
  const first = Object.freeze({ id: 'one', revision: 2, sessionId: 'session-1', prompt: 'First', status: 'ready' });
  const second = Object.freeze({ id: 'two', revision: 4, sessionId: 'session-1', prompt: 'Second', status: 'failed' });
  const calls = [];
  const count = renderSendOutbox({
    state: {
      currentSessionId: 'session-1',
      sendOutboxBySession: new Map([['session-1', [first, second]]]),
    },
    host,
    actions: {
      edit: (entry, prompt) => calls.push(['edit', entry.id, entry.revision, prompt]),
      retry: (entry) => calls.push(['retry', entry.id, entry.revision]),
      cancel: (entry) => calls.push(['cancel', entry.id, entry.revision]),
    },
  });

  assert.equal(count, 2);
  assert.equal(host.hidden, false);
  assert.deepEqual([...host.querySelectorAll('.send-outbox__preview')].map((node) => node.textContent), ['First', 'Second']);
  assert.equal(host.querySelectorAll('textarea').length, 0);
  assert.equal(host.querySelectorAll('.send-outbox__action--retry').length, 1);
  const ids = [...host.querySelectorAll('[id]')].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, 'every row control id is unique');
  host.querySelector('[data-outbox-item-id="two"] .send-outbox__preview').click();
  host.querySelector('textarea').value = 'Second edited';
  host.querySelector('.send-outbox__save').click();
  host.querySelector('.send-outbox__action--retry').click();
  host.querySelector('[data-outbox-item-id="two"] .send-outbox__action--cancel').click();
  assert.deepEqual(calls, [
    ['edit', 'two', 4, 'Second edited'],
    ['retry', 'two', 4],
    ['cancel', 'two', 4],
  ]);
  dom.window.close();
});

test('outbox control ids stay item-keyed across reorder and old listeners are detached', () => {
  const dom = new JSDOM('<div id="outbox"></div>');
  const host = dom.window.document.getElementById('outbox');
  const one = { id: 'one', sessionId: 's1', prompt: 'One', status: 'ready' };
  const two = { id: 'two', sessionId: 's1', prompt: 'Two', status: 'ready' };
  const state = { currentSessionId: 's1', sessions: [{ id: 's1', title: 'Destination' }], sendOutboxBySession: new Map([['s1', [one, two]]]) };
  const calls = [];
  renderSendOutbox({ state, host, actions: { cancel: (entry) => calls.push(entry.id) } });
  const firstIds = new Map([...host.querySelectorAll('[data-outbox-item-id]')].map((row) => [row.dataset.outboxItemId, row.id]));
  const detachedCancel = host.querySelector('[data-outbox-item-id="one"] .send-outbox__action--cancel');
  state.sendOutboxBySession.set('s1', [two, one]);
  renderSendOutbox({ state, host, actions: { cancel: (entry) => calls.push(entry.id) } });
  const secondIds = new Map([...host.querySelectorAll('[data-outbox-item-id]')].map((row) => [row.dataset.outboxItemId, row.id]));
  assert.equal(secondIds.get('one'), firstIds.get('one'));
  assert.equal(secondIds.get('two'), firstIds.get('two'));
  detachedCancel.click();
  assert.deepEqual(calls, []);
  assert.match(host.querySelector('.send-outbox__list').getAttribute('aria-label'), /Destination/);
  dom.window.close();
});

test('malformed duplicate queue ids never create duplicate DOM ids', () => {
  const dom = new JSDOM('<div id="outbox"></div>');
  const host = dom.window.document.getElementById('outbox');
  renderSendOutbox({
    state: {
      currentSessionId: 's1',
      sendOutboxBySession: new Map([['s1', [
        { id: 'duplicate', sessionId: 's1', prompt: 'One', status: 'ready' },
        { id: 'duplicate', sessionId: 's1', prompt: 'Two', status: 'ready' },
      ]]]),
    },
    host,
  });
  const ids = [...host.querySelectorAll('[id]')].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  dom.window.close();
});

test('queue rerender retains unsaved text, focus and selection', () => {
  const dom = new JSDOM('<div id="outbox"></div>');
  const host = dom.window.document.getElementById('outbox');
  const item = { id: 'one', sessionId: 's1', prompt: 'Original', status: 'capturing_context' };
  const state = { currentSessionId: 's1', sendOutboxBySession: new Map([['s1', [item]]]) };
  const actions = { edit() {}, cancel() {} };
  renderSendOutbox({ state, host, actions });
  host.querySelector('.send-outbox__preview').click();
  const input = host.querySelector('textarea');
  input.value = 'Unsaved draft';
  input.focus();
  input.setSelectionRange(2, 6);
  state.sendOutboxBySession.set('s1', [{ ...item, revision: 2, status: 'ready' }]);
  renderSendOutbox({ state, host, actions });
  const next = host.querySelector('textarea');
  assert.equal(next.value, 'Unsaved draft');
  assert.equal(dom.window.document.activeElement, next);
  assert.equal(next.selectionStart, 2);
  assert.equal(next.selectionEnd, 6);
  state.currentSessionId = 's2';
  renderSendOutbox({ state, host, actions });
  state.currentSessionId = 's1';
  renderSendOutbox({ state, host, actions });
  assert.equal(host.querySelector('textarea').value, 'Unsaved draft');
  dom.window.close();
});

test('missing queue handlers disable controls', () => {
  const dom = new JSDOM('<div id="outbox"></div>');
  const host = dom.window.document.getElementById('outbox');
  renderSendOutbox({ state: { currentSessionId: 's1', sendOutboxBySession: new Map([['s1', [{ id: 'one', status: 'ready' }]]]) }, host });
  assert.ok([...host.querySelectorAll('.send-outbox__row button, textarea')].every((node) => node.disabled));
  dom.window.close();
});

test('minimal editing keeps the same input on stream refresh, isolates Enter, and discards with Escape', () => {
  const dom = new JSDOM('<div id="outbox"></div>');
  const host = dom.window.document.getElementById('outbox');
  const state = { currentSessionId: 's1', sendOutboxBySession: new Map([['s1', [{ id: 'one', prompt: '<b>Original</b>', status: 'ready' }]]]) };
  let edits = 0;
  const actions = { edit() { edits++; }, cancel() {} };
  renderSendOutbox({ state, host, actions });
  assert.equal(host.querySelector('b'), null, 'preview is plain text');
  host.querySelector('.send-outbox__preview').click();
  const input = host.querySelector('textarea');
  input.value = 'Unsaved';
  renderSendOutbox({ state, host, actions });
  assert.equal(host.querySelector('textarea'), input, 'unrelated rendering preserves DOM and IME');
  let bubbled = false;
  host.addEventListener('keydown', () => { bubbled = true; });
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(bubbled, false);
  assert.equal(edits, 0);
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(host.querySelector('textarea'), null);
  assert.equal(dom.window.document.activeElement, host.querySelector('.send-outbox__preview'));
  host.querySelector('.send-outbox__preview').click();
  assert.equal(host.querySelector('textarea').value, '<b>Original</b>');
  dom.window.close();
});

test('collapse preserves drafts and queue scroll without changing the timeline scroll', () => {
  const dom = new JSDOM('<div id="timeline"></div><div id="outbox"></div>');
  const host = dom.window.document.getElementById('outbox');
  const timeline = dom.window.document.getElementById('timeline');
  timeline.scrollTop = 123;
  const state = { currentSessionId: 's1', sendOutboxBySession: new Map([['s1', [{ id: 'one', prompt: 'Original', status: 'ready' }]]]) };
  const actions = { edit() {}, cancel() {} };
  renderSendOutbox({ state, host, actions });
  host.querySelector('.send-outbox__preview').click();
  host.querySelector('textarea').value = 'Unsaved';
  host.querySelector('.send-outbox__list').scrollTop = 45;
  host.querySelector('.send-outbox__toggle').click();
  assert.equal(host.querySelector('.send-outbox__list').hidden, true);
  assert.equal(host.querySelector('.send-outbox__toggle').getAttribute('aria-expanded'), 'false');
  host.querySelector('.send-outbox__toggle').click();
  assert.equal(host.querySelector('textarea').value, 'Unsaved');
  assert.equal(timeline.scrollTop, 123);
  const oldCancel = host.querySelector('.send-outbox__action--cancel');
  require('../renderer/chat/renderer-send-outbox-render').disposeSendOutboxRender(host);
  oldCancel.click();
  assert.equal(host.querySelector('.send-outbox__list').hidden, false);
  dom.window.close();
});

test('visible outbox hides for an empty active session', () => {
  const dom = new JSDOM('<div id="outbox"></div>');
  const host = dom.window.document.getElementById('outbox');
  assert.equal(renderSendOutbox({ state: { currentSessionId: '', sendOutboxBySession: new Map() }, host }), 0);
  assert.equal(host.hidden, true);
  dom.window.close();
});

function renderRows(items, extra = {}) {
  const dom = new JSDOM('<div id="outbox"></div>');
  const host = dom.window.document.getElementById('outbox');
  const state = { currentSessionId: 's1', sendOutboxBySession: new Map([['s1', items]]), ...extra };
  renderSendOutbox({ state, host, actions: { edit() {}, cancel() {}, retry() {} } });
  return { dom, host, state };
}

test('an offered row says Jenny reads it at the next step, cannot be edited, and keeps a live ×', () => {
  const withdrawn = [];
  const { dom, host } = renderRows(
    [{ id: 'one', prompt: 'Take this', status: 'offered', revision: 3 }],
    { sendSteerController: { withdraw: (item) => withdrawn.push([item.id, item.revision]) } }
  );
  const row = host.querySelector('[data-outbox-item-id="one"]');
  assert.match(row.querySelector('.send-outbox__status').textContent, /^Jenny reads this at the next step$/);
  assert.equal(row.querySelector('.send-outbox__preview').disabled, true, 'locked for editing');
  const cancel = row.querySelector('.send-outbox__action--cancel');
  assert.equal(cancel.disabled, false, '× stays enabled to withdraw');
  cancel.click();
  assert.deepEqual(withdrawn, [['one', 3]]);
  dom.window.close();
});

test('a waiting row names why it waits, and shows no line when no reason is known', () => {
  const reasons = {
    slash_command: 'slash command',
    model_change: 'changes the model',
    mode_change: 'changes the mode',
    mentions: 'has @-mentions',
    needs_new_turn: 'needs a new turn',
    behind_waiting_item: 'waits for the message above',
  };
  const items = Object.keys(reasons).map((reason, index) => ({
    id: `item${index}`, prompt: reason, status: index % 2 ? 'waiting_for_turn' : 'ready', steerReason: reason,
  }));
  items.push({ id: 'plain', prompt: 'plain', status: 'ready' });
  items.push({ id: 'refused', prompt: 'refused', status: 'waiting_for_turn', steerReason: null });
  const { dom, host } = renderRows(items);
  Object.entries(reasons).forEach(([reason, text], index) => {
    const status = host.querySelector(`[data-outbox-item-id="item${index}"] .send-outbox__status`);
    assert.equal(status.textContent, `Sends after this turn · ${text}`, reason);
  });
  assert.equal(host.querySelector('[data-outbox-item-id="plain"] .send-outbox__status'), null);
  assert.equal(host.querySelector('[data-outbox-item-id="refused"] .send-outbox__status'), null);
  dom.window.close();
});

test('a reason change redraws the row and the lost-race row says Jenny already read it', () => {
  const dom = new JSDOM('<div id="outbox"></div>');
  const host = dom.window.document.getElementById('outbox');
  const item = { id: 'one', prompt: 'x', status: 'ready', revision: 1 };
  const state = { currentSessionId: 's1', sendOutboxBySession: new Map([['s1', [item]]]) };
  renderSendOutbox({ state, host });
  assert.equal(host.querySelector('.send-outbox__status'), null);
  state.sendOutboxBySession.set('s1', [{ ...item, steerReason: 'mentions' }]);
  renderSendOutbox({ state, host });
  assert.match(host.querySelector('.send-outbox__status').textContent, /has @-mentions/);
  state.sendOutboxBySession.set('s1', [{ ...item, status: 'taken' }]);
  renderSendOutbox({ state, host });
  assert.equal(host.querySelector('.send-outbox__status').textContent, 'Jenny already read this');
  assert.equal(host.querySelector('.send-outbox__action--cancel').disabled, true);
  dom.window.close();
});
