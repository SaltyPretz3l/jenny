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
  assert.deepEqual([...host.querySelectorAll('.send-outbox__input')].map((node) => node.value), ['First', 'Second']);
  assert.equal(host.querySelectorAll('.send-outbox__action--retry').length, 1);
  const ids = [...host.querySelectorAll('[id]')].map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, 'every row control id is unique');
  const secondRow = host.querySelector('[data-outbox-item-id="two"]');
  secondRow.querySelector('.send-outbox__input').value = 'Second edited';
  [...secondRow.querySelectorAll('button')].find((button) => button.textContent === 'Save').click();
  secondRow.querySelector('.send-outbox__action--retry').click();
  secondRow.querySelector('.send-outbox__action--cancel').click();
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
  assert.match(host.querySelector('.send-outbox__heading').textContent, /Destination/);
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

test('visible outbox hides for an empty active session', () => {
  const dom = new JSDOM('<div id="outbox"></div>');
  const host = dom.window.document.getElementById('outbox');
  assert.equal(renderSendOutbox({ state: { currentSessionId: '', sendOutboxBySession: new Map() }, host }), 0);
  assert.equal(host.hidden, true);
  dom.window.close();
});
