const test = require('node:test');
const assert = require('node:assert/strict');

const { createNoteCommandHandler } = require('../renderer/chat/renderer-slash-note-command.js');

function harness(overrides = {}) {
  const toasts = [];
  const logs = [];
  const deps = {
    showToastMessage: (msg, meta) => toasts.push([msg, meta]),
    appendClientLog: (...args) => logs.push(args),
    ...overrides,
  };
  return { deps, toasts, logs };
}

test('empty args toast a hint and never call capture', () => {
  const captured = [];
  const { deps, toasts } = harness({ captureToScratchpad: (t) => { captured.push(t); return Promise.resolve({ ok: true }); } });
  const result = createNoteCommandHandler(deps)({ args: '   ' });
  assert.equal(captured.length, 0);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0][0], /Type something/);
  assert.equal(toasts[0][1].tone, 'warning');
  assert.deepEqual(result, { ok: false, handled: true, code: 'empty_args' });
});

test('a successful capture toasts the note title', async () => {
  const captured = [];
  const { deps, toasts } = harness({
    captureToScratchpad: (text) => { captured.push(text); return Promise.resolve({ ok: true, noteTitle: 'Ideas' }); },
  });
  const result = await createNoteCommandHandler(deps)({ args: '  ship it  ' });
  // The registry trims args before the handler; the handler trims defensively too.
  assert.deepEqual(captured, ['ship it']);
  assert.deepEqual(toasts, [['Added to Ideas.', { title: 'Scratchpad', tone: 'success' }]]);
  assert.deepEqual(result, { ok: true, code: 'note_saved' });
});

test('missing capture dependency reports the feature is unavailable', () => {
  const { deps, toasts } = harness({ captureToScratchpad: undefined });
  createNoteCommandHandler(deps)({ args: 'hello' });
  assert.equal(toasts.length, 1);
  assert.match(toasts[0][0], /unavailable/);
});

test('an error result is surfaced to the user', async () => {
  const { deps, toasts } = harness({ captureToScratchpad: () => Promise.resolve({ error: 'Notes are unavailable.' }) });
  createNoteCommandHandler(deps)({ args: 'hello' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(toasts, [['Could not save the note.', { title: 'Scratchpad', tone: 'warning' }]]);
});

test('the allowlisted note-full failure stays actionable', async () => {
  const { deps, toasts } = harness({
    captureToScratchpad: () => Promise.resolve({ error: 'This note is full — switch to another note.' }),
  });
  const result = await createNoteCommandHandler(deps)({ args: 'hello' });
  assert.equal(result.code, 'note_full');
  assert.match(toasts[0][0], /note is full/i);
});

test('a thrown capture is logged and toasts a friendly failure', async () => {
  const { deps, toasts, logs } = harness({ captureToScratchpad: () => Promise.reject(new Error('disk full')) });
  createNoteCommandHandler(deps)({ args: 'hello' });
  await new Promise((r) => setImmediate(r));
  assert.match(toasts[0][0], /Could not save/);
  const failureLog = logs.find((entry) => entry[1] === 'slash.note_failed');
  assert.equal(failureLog[2].message, undefined);
  assert.doesNotMatch(JSON.stringify(failureLog), /disk full/);
});
