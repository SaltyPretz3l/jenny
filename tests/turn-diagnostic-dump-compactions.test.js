'use strict';

// FG-008: every compaction in a turn lands in the per-stream diagnostics file
// (metadata always; summary text only under agent_test_hooks).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dumpTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');
const {
  createCompactionDiagnostics,
} = require('../services/backend/turn-diagnostic-compactions');
const { isSensitiveLogKey } = require('../renderer/shared/log-contract-utils');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-diagnostic-compactions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function compactedParams(overrides = {}) {
  return {
    strategy: 'full',
    phase: 'tool_loop',
    summary_status: 'created',
    reason_code: null,
    input_complete: false,
    tokens_before: 42041,
    tokens_after: 7941,
    dropped_messages: 3,
    dropped_bytes: 1200,
    summary_source_dropped_messages: 9,
    covered_through_tool_call_id: 'call_7',
    summary_message: {
      role: 'system',
      content: '## Compacted Conversation Summary\nRead G:\\Secrets\\workspace\\march.csv. Next Step: reconcile.',
    },
    window_shape: [
      { role: 'system', kind: 'summary', chars: 7350 },
      { role: 'user', kind: 'task_pin', chars: 685 },
      { role: 'assistant', kind: 'tool_use', chars: 40, tool_name: 'read_file' },
      { role: 'tool', kind: 'tool_result', chars: 900, tool_name: 'read_file' },
      { role: 'system', kind: 'nudge', chars: 120 },
    ],
    ...overrides,
  };
}

async function dumpWith(t, compactions) {
  const userDataPath = makeTempDir(t);
  const filePath = await dumpTurnDiagnostic({
    service: { options: { userDataPath }, _emitServiceLog() {} },
    sessionId: 'session-1',
    streamId: 'stream-compactions',
    terminalStatus: 'completed',
    compactions,
    redactionPrefixes: ['G:\\Secrets\\workspace'],
  });
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha16(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

test('compactions land in the dump with summary text that survives redaction except paths', async (t) => {
  const recorder = createCompactionDiagnostics({ includeText: true });
  const params = compactedParams();
  recorder.record(params, { summaryPersisted: false });

  const written = await dumpWith(t, recorder.forDump());

  assert.equal(written.schema_version, 1);
  assert.equal(Object.hasOwn(written, 'compactions_omitted'), false);
  assert.equal(written.compactions.length, 1);
  const [entry] = written.compactions;
  assert.equal(entry.phase, 'tool_loop');
  assert.equal(entry.strategy, 'full');
  assert.equal(entry.summary_status, 'created');
  assert.equal(entry.tokens_before, 42041);
  assert.equal(entry.tokens_after, 7941);
  assert.equal(entry.dropped_messages, 3);
  assert.equal(entry.dropped_bytes, 1200);
  assert.equal(entry.summary_source_dropped_messages, 9);
  assert.equal(entry.input_complete, false);
  assert.equal(entry.covered_through_tool_call_id, 'call_7');
  assert.equal(entry.summary_persisted, false);
  assert.equal(Number.isNaN(Date.parse(entry.at)), false);
  const content = params.summary_message.content;
  assert.equal(entry.summary_chars, content.length);
  assert.equal(entry.summary_sha256_16, sha16(content));
  assert.match(entry.summary_text, /^## Compacted Conversation Summary\nRead /);
  assert.match(entry.summary_text, /Next Step: reconcile\.$/);
  assert.match(entry.summary_text, /\[redacted:path\]/);
  assert.doesNotMatch(entry.summary_text, /Secrets/);
  assert.deepEqual(entry.window, params.window_shape);
  assert.equal(Object.hasOwn(entry, 'window_rows_omitted'), false);
});

test('compaction field names are not redacted as sensitive log keys', () => {
  const recorder = createCompactionDiagnostics({ includeText: true });
  recorder.record(compactedParams(), { summaryPersisted: true });
  const [entry] = recorder.snapshot();
  for (const key of [...Object.keys(entry), 'compactions', 'compactions_omitted']) {
    assert.equal(isSensitiveLogKey(key), false, key);
  }
  for (const key of Object.keys(entry.window[0])) {
    assert.equal(isSensitiveLogKey(key), false, key);
  }
});

test('the recorder keeps the first 8 compactions and counts the rest', async (t) => {
  const recorder = createCompactionDiagnostics({ includeText: false });
  for (let index = 0; index < 11; index += 1) {
    recorder.record(compactedParams({ tokens_before: 1000 + index }), { summaryPersisted: false });
  }
  const written = await dumpWith(t, recorder.forDump());
  assert.equal(written.compactions.length, 8);
  assert.deepEqual(
    written.compactions.map((entry) => entry.tokens_before),
    [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007]
  );
  assert.equal(written.compactions_omitted, 3);
});

test('summary text is capped at 16 KB while the char count and hash cover the full text', () => {
  const recorder = createCompactionDiagnostics({ includeText: true });
  const content = `## Compacted Conversation Summary\n${'s'.repeat(20000)}`;
  recorder.record(compactedParams({ summary_message: { role: 'system', content } }), {
    summaryPersisted: false,
  });
  const [entry] = recorder.snapshot();
  assert.equal(entry.summary_text.length, 16384);
  assert.equal(entry.summary_text, content.slice(0, 16384));
  assert.equal(entry.summary_chars, content.length);
  assert.equal(entry.summary_sha256_16, sha16(content));
});

test('without includeText the entry keeps only the summary size and hash', async (t) => {
  const recorder = createCompactionDiagnostics({ includeText: false });
  const params = compactedParams();
  recorder.record(params, { summaryPersisted: false });
  const written = await dumpWith(t, recorder.forDump());
  const [entry] = written.compactions;
  assert.equal(Object.hasOwn(entry, 'summary_text'), false);
  assert.equal(entry.summary_chars, params.summary_message.content.length);
  assert.equal(entry.summary_sha256_16, sha16(params.summary_message.content));
  assert.doesNotMatch(JSON.stringify(written), /Next Step/);
});

test('long fields and windows are capped; window rows keep only shape keys', () => {
  const recorder = createCompactionDiagnostics({ includeText: false });
  const window = Array.from({ length: 200 }, (_, index) => ({
    role: 'tool', kind: 'tool_result', chars: index, tool_name: 'read_file', content: 'leak',
  }));
  recorder.record(compactedParams({
    reason_code: 'r'.repeat(200),
    covered_through_tool_call_id: 'c'.repeat(300),
    summary_message: null,
    window_shape: window,
  }), { summaryPersisted: false });
  const [entry] = recorder.snapshot();
  assert.equal(entry.reason_code.length, 80);
  assert.equal(entry.covered_through_tool_call_id.length, 128);
  assert.equal(entry.summary_chars, 0);
  assert.equal(entry.window.length, 128);
  assert.equal(entry.window_rows_omitted, 72);
  assert.deepEqual(entry.window[5], {
    role: 'tool', kind: 'tool_result', chars: 5, tool_name: 'read_file',
  });
});

test('non-string fields are dropped instead of coerced, so a malformed row cannot throw', () => {
  const recorder = createCompactionDiagnostics({ includeText: true });
  const unprintable = JSON.parse('{"toString": null}');
  recorder.record(compactedParams({
    phase: unprintable,
    reason_code: 42,
    summary_message: { content: unprintable },
    window_shape: [{ role: unprintable, kind: ['x'], chars: 'many', tool_name: unprintable }, null],
  }), { summaryPersisted: false });
  const [entry] = recorder.snapshot();
  assert.equal(entry.phase, 'preflight');
  assert.equal(entry.reason_code, '');
  assert.equal(entry.summary_text, '');
  assert.deepEqual(entry.window, [
    { role: '', kind: '', chars: 0 },
    { role: '', kind: '', chars: 0 },
  ]);
});

test('a turn without compactions dumps compactions: null', async (t) => {
  const recorder = createCompactionDiagnostics({ includeText: true });
  assert.equal(recorder.snapshot(), null);
  const written = await dumpWith(t, recorder.forDump());
  assert.equal(written.compactions, null);
  assert.equal(Object.hasOwn(written, 'compactions_omitted'), false);
  const legacy = await dumpWith(t, undefined);
  assert.equal(legacy.compactions, null);
});
