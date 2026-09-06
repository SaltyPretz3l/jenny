const test = require('node:test');
const assert = require('node:assert/strict');

const { buildScratchpadMenu } = require('../renderer/features/renderer-dashboard-scratchpad-menu.js');

function labelsOf(items) {
  return items.filter((item) => !item.separator).map((item) => item.label);
}

test('builds the full actionable item set when a workspace is open', () => {
  const actions = {
    sendToChat: () => ({ ok: true }),
    promoteToLoop: () => ({ ok: true }),
    createCalendarEvent: () => ({ ok: true }),
    saveToFile: () => ({ ok: true, path: '.jenny/notes/x.md' }),
  };
  const items = buildScratchpadMenu({
    actions,
    text: 'WHOLE',
    title: 'X',
    canSaveFile: true,
    copyText: () => true,
    onResult: () => {},
  });
  assert.deepEqual(labelsOf(items), [
    'Send to chat',
    'Copy',
    'Add to Open Loops',
    'New calendar event',
    'Save as note file',
  ]);
  const fileItem = items.find((item) => item.label === 'Save as note file');
  assert.equal(fileItem.disabled, false);
  assert.equal(fileItem.shortcutHint, '.jenny/notes');
});

test('save-as-file is disabled with a hint and no action when no workspace is open', () => {
  const items = buildScratchpadMenu({
    actions: { saveToFile: () => ({}) },
    text: 'x',
    canSaveFile: false,
  });
  const fileItem = items.find((item) => item.label === 'Save as note file');
  assert.equal(fileItem.disabled, true);
  assert.equal(fileItem.shortcutHint, 'Open a folder');
  assert.equal(typeof fileItem.action, 'undefined');
});

test('items are omitted when their action / copy impl is absent', () => {
  const items = buildScratchpadMenu({ actions: {}, text: 'x' });
  assert.deepEqual(labelsOf(items), []);
});

test('send-to-chat and copy scope to the selection, falling back to the whole note', async () => {
  const calls = [];
  const items = buildScratchpadMenu({
    actions: { sendToChat: (t) => { calls.push(['send', t]); return { ok: true }; } },
    text: 'WHOLE',
    selection: 'SEL',
    copyText: (t) => { calls.push(['copy', t]); return true; },
    onResult: () => {},
  });
  items.find((i) => i.label === 'Send to chat').action();
  items.find((i) => i.label === 'Copy').action();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['send', 'SEL'], ['copy', 'SEL']]);
});

test('structural routes always take the whole note, never the selection', async () => {
  const calls = [];
  const items = buildScratchpadMenu({
    actions: {
      promoteToLoop: (t) => { calls.push(['loop', t]); return { ok: true }; },
      createCalendarEvent: (t) => { calls.push(['cal', t]); return { ok: true }; },
    },
    text: 'WHOLE',
    selection: 'SEL',
    onResult: () => {},
  });
  items.find((i) => i.label === 'Add to Open Loops').action();
  items.find((i) => i.label === 'New calendar event').action();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['loop', 'WHOLE'], ['cal', 'WHOLE']]);
});

test('a routing error (object or rejection) is reported to onResult as an error', async () => {
  const results = [];
  const items = buildScratchpadMenu({
    actions: {
      promoteToLoop: () => ({ error: 'nope' }),
      createCalendarEvent: () => Promise.reject(new Error('boom')),
    },
    text: 'x',
    onResult: (message, isError) => results.push([message, isError]),
  });
  items.find((i) => i.label === 'Add to Open Loops').action();
  items.find((i) => i.label === 'New calendar event').action();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(results, [['nope', true], ['boom', true]]);
});

test('a copy failure is reported as an error, success as a confirmation', async () => {
  const results = [];
  const okItems = buildScratchpadMenu({
    actions: {},
    text: 'x',
    copyText: () => true,
    onResult: (m, e) => results.push([m, e]),
  });
  okItems.find((i) => i.label === 'Copy').action();
  const failItems = buildScratchpadMenu({
    actions: {},
    text: 'x',
    copyText: () => false,
    onResult: (m, e) => results.push([m, e]),
  });
  failItems.find((i) => i.label === 'Copy').action();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(results, [['Copied.', false], ['Could not copy.', true]]);
});
