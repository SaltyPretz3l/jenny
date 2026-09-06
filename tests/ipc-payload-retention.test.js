'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_PAYLOAD_GRACE_MS,
  collectReferencedPayloadPaths,
  payloadPathsFromMessages,
  selectOrphanPayloads,
} = require('../services/backend/ipc-payload-retention');

const NOW_MS = 10_000;
const GRACE_MS = 1_000;

function payloadMessage(kind, externalPayloads) {
  return { [kind]: { external_payloads: externalPayloads } };
}

function select(entries, referenced = new Set()) {
  return selectOrphanPayloads({ entries, referenced, nowMs: NOW_MS, graceMs: GRACE_MS });
}

test('exports a one-hour grace sized for long agentic turns', () => {
  assert.equal(DEFAULT_PAYLOAD_GRACE_MS, 3_600_000);
});

test('counts a payload referenced only by tool_call metadata', () => {
  const messages = [payloadMessage('tool_call', {
    input: { path: 'call-only.json' },
  })];

  assert.deepEqual(payloadPathsFromMessages(messages), new Set(['call-only.json']));
});

test('counts a payload referenced only by tool_result metadata', () => {
  const messages = [payloadMessage('tool_result', {
    output: { path: 'result-only.json' },
  })];

  assert.deepEqual(payloadPathsFromMessages(messages), new Set(['result-only.json']));
});

test('deduplicates every field referenced across both metadata kinds', () => {
  const messages = [
    payloadMessage('tool_call', {
      input: { path: 'call-input.json' },
      context: { path: 'shared.json' },
    }),
    payloadMessage('tool_result', {
      output: { path: 'result-output.json' },
      context: { path: 'shared.json' },
    }),
  ];

  assert.deepEqual(payloadPathsFromMessages(messages), new Set([
    'call-input.json',
    'shared.json',
    'result-output.json',
  ]));
});

test('ignores malformed message and metadata shapes without throwing', () => {
  const garbageInputs = [
    null,
    undefined,
    'not-an-array',
    [null, undefined, {}, { tool_call: null }, { tool_result: {} }],
    [payloadMessage('tool_call', [])],
    [payloadMessage('tool_result', 'not-an-object')],
    [payloadMessage('tool_call', { input: null, output: {}, other: { path: 42 } })],
  ];

  for (const messages of garbageInputs) {
    assert.doesNotThrow(() => payloadPathsFromMessages(messages));
    assert.deepEqual(payloadPathsFromMessages(messages), new Set());
  }
});

test('counts references carrying an unrecognised root_kind', () => {
  const messages = [payloadMessage('tool_call', {
    input: { path: 'unknown-root.json', root_kind: 'future-root' },
  })];

  assert.deepEqual(payloadPathsFromMessages(messages), new Set(['unknown-root.json']));
});

test('unions payload references across sessions', () => {
  const messagesBySession = new Map([
    ['one', [payloadMessage('tool_call', { input: { path: 'one.json' } })]],
    ['two', [payloadMessage('tool_result', {
      output: { path: 'two.json' },
      duplicate: { path: 'ONE.JSON' },
    })]],
  ]);

  const referenced = collectReferencedPayloadPaths(
    ['one', 'two'],
    (sessionId) => messagesBySession.get(sessionId)
  );

  assert.deepEqual(referenced, new Set(['one.json', 'two.json']));
});

test('propagates session read failures instead of returning a partial reference set', () => {
  assert.throws(
    () => collectReferencedPayloadPaths(['readable', 'unreadable'], (sessionId) => {
      if (sessionId === 'unreadable') throw new Error('session unreadable');
      return [payloadMessage('tool_call', { input: { path: 'live.json' } })];
    }),
    /session unreadable/
  );
});

test('selects an unreferenced payload at or beyond the grace age', () => {
  assert.deepEqual(select([
    { name: 'old.json', mtimeMs: NOW_MS - GRACE_MS },
  ]), ['old.json']);
});

test('keeps an unreferenced payload newer than the grace age', () => {
  assert.deepEqual(select([
    { name: 'in-flight.json', mtimeMs: NOW_MS - GRACE_MS + 1 },
  ]), []);
});

test('keeps referenced payloads regardless of age', () => {
  assert.deepEqual(select([
    { name: 'live.json', mtimeMs: 0 },
  ], new Set(['live.json'])), []);
});

test('normalizes backslash references to match forward-slash listing keys', () => {
  const referenced = payloadPathsFromMessages([
    payloadMessage('tool_call', { input: { path: 'Nested\\Payload.JSON' } }),
  ]);

  assert.deepEqual(referenced, new Set(['nested/payload.json']));
  assert.deepEqual(selectOrphanPayloads({
    entries: [{ name: 'Nested/Payload.JSON', mtimeMs: 0 }],
    referenced,
    nowMs: NOW_MS,
    graceMs: GRACE_MS,
  }), []);
});

test('keeps a referenced payload when only its case differs', () => {
  const referenced = payloadPathsFromMessages([
    payloadMessage('tool_result', { output: { path: 'LIVE-PAYLOAD.JSON' } }),
  ]);

  assert.deepEqual(select([
    { name: 'live-payload.json', mtimeMs: 0 },
  ], referenced), []);
});

test('keeps payloads with non-finite, non-numeric, or future mtimes', () => {
  const entries = [
    { name: 'missing.json' },
    { name: 'string.json', mtimeMs: '0' },
    { name: 'nan.json', mtimeMs: Number.NaN },
    { name: 'infinity.json', mtimeMs: Number.POSITIVE_INFINITY },
    { name: 'negative-infinity.json', mtimeMs: Number.NEGATIVE_INFINITY },
    { name: 'future.json', mtimeMs: NOW_MS + 1 },
  ];

  assert.deepEqual(select(entries), []);
});

test('never selects names containing a separator or dot-dot', () => {
  const entries = [
    { name: 'nested/payload.json', mtimeMs: 0 },
    { name: 'nested\\payload.json', mtimeMs: 0 },
    { name: '..', mtimeMs: 0 },
    { name: 'payload..json', mtimeMs: 0 },
  ];

  assert.deepEqual(select(entries), []);
});
