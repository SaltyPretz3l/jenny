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
