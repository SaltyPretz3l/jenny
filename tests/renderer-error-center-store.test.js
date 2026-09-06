/**
 * EH-W11 gate: bounded in-memory error center store
 * (renderer/shell/renderer-error-center-store.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createErrorCenterStore } = require('../renderer/shell/renderer-error-center-store');

test('record keeps warning/danger, drops info, and newest entries come first', () => {
  let now = 1000;
  const store = createErrorCenterStore({ now: () => now });

  assert.equal(store.record({ code: 'CMP-AI-0005', title: 'Provider issue', severity: 'danger' }), true);
  now += 1;
  assert.equal(store.record({ title: 'Memory refresh failed', severity: 'warning', surface: 'settings-refresh' }), true);
  assert.equal(store.record({ title: 'Response stopped', severity: 'info' }), false, 'info never recorded');
  assert.equal(store.record({ severity: 'danger' }), false, 'entries need a title or code');

  const entries = store.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, 'Memory refresh failed');
  assert.equal(entries[1].code, 'CMP-AI-0005');
  assert.equal(entries[0].at, 1001);
});

test('intake envelopes record via their errorCode/recoveryTitle aliases', () => {
  const store = createErrorCenterStore({ now: () => 5 });
  store.record({ errorCode: 'CMP-CHAT-0002', recoveryTitle: 'Connection issue', origin: 'chat-stream', severity: 'danger' });
  const [entry] = store.list();
  assert.equal(entry.code, 'CMP-CHAT-0002');
  assert.equal(entry.title, 'Connection issue');
  assert.equal(entry.surface, 'chat-stream');
});

test('ring is bounded to maxEntries, oldest dropped', () => {
  const store = createErrorCenterStore({ maxEntries: 3, now: () => 1 });
  for (let i = 1; i <= 5; i += 1) {
    store.record({ title: `error ${i}`, severity: 'danger' });
  }
  const titles = store.list().map((entry) => entry.title);
  assert.deepEqual(titles, ['error 5', 'error 4', 'error 3']);
});

test('keyed records dedupe in place and preserve seen state across re-renders', () => {
  const store = createErrorCenterStore({ now: () => 1 });
  store.record({ key: 'error-card:msg-1', title: 'Turn failed', severity: 'danger' });
  assert.equal(store.getUnseenCount(), 1);
  store.markSeen();
  assert.equal(store.getUnseenCount(), 0);
  /* A re-render records the same key again — must not re-badge. */
  store.record({ key: 'error-card:msg-1', title: 'Turn failed', severity: 'danger' });
  assert.equal(store.list().length, 1, 'same key never duplicates');
  assert.equal(store.getUnseenCount(), 0, 'seen state preserved through keyed refresh');
});

test('unseen count, markSeen, clear, and subscribe lifecycle', () => {
  const store = createErrorCenterStore({ now: () => 1 });
  const notifications = [];
  const unsubscribe = store.subscribe(() => notifications.push(store.getUnseenCount()));

  store.record({ title: 'one', severity: 'warning' });
  store.record({ title: 'two', severity: 'danger' });
  assert.equal(store.getUnseenCount(), 2);
  store.markSeen();
  assert.equal(store.getUnseenCount(), 0);
  store.record({ title: 'three', severity: 'danger' });
  assert.equal(store.getUnseenCount(), 1);
  store.clear();
  assert.deepEqual(store.list(), []);
  assert.equal(store.getUnseenCount(), 0);
  store.clear(); /* empty clear does not notify */

  assert.deepEqual(notifications, [1, 2, 0, 1, 0]);
  unsubscribe();
  store.record({ title: 'four', severity: 'danger' });
  assert.equal(notifications.length, 5, 'unsubscribed listeners stay silent');
});
