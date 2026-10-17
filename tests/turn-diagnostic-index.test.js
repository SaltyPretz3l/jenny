'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTurnDiagnosticIndex } = require('../services/backend/turn-diagnostic-index');
const {
  cleanupTrackedResources,
} = require('./helpers/resource-cleanup');
const {
  createTrackedUserDataPath,
  writeTurnDiagnostic,
} = require('./helpers/turn-diagnostic-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('index parses the requested rows plus five slack candidates and only counts read failures', async (t) => {
  const userDataPath = createTrackedUserDataPath('jenny-turn-diagnostic-index-reads-');
  const date = '2026-10-14';
  const dir = path.join(userDataPath, 'diagnostics', date);
  for (let index = 0; index < 30; index += 1) {
    const id = `stream-${index}`;
    writeTurnDiagnostic(userDataPath, date, id, {
      stream_id: id, session_id: 'wanted',
      // The last slack candidate wins despite an older mtime.
      written_at: new Date(Date.UTC(2026, 9, 14, 12, index === 8 ? 1 : 0)).toISOString(),
    });
    const file = path.join(dir, `${id}.json`);
    if (index === 0 || index === 9) fs.writeFileSync(file, '{broken');
    if (index === 1) fs.writeFileSync(file, JSON.stringify({ session_id: 'other' }));
    if (index === 2) fs.writeFileSync(file, 'null');
    const mtime = new Date(Date.UTC(2026, 9, 14, 12, 0, 30 - index));
    fs.utimesSync(file, mtime, mtime);
  }
  const originalRead = fs.promises.readFile;
  const originalParse = JSON.parse;
  let reads = 0;
  let parses = 0;
  t.mock.method(fs.promises, 'readFile', async function (file, ...args) {
    if (String(file).startsWith(dir)) reads += 1;
    return originalRead.call(this, file, ...args);
  });
  t.mock.method(JSON, 'parse', (...args) => { parses += 1; return originalParse(...args); });
  const index = await buildTurnDiagnosticIndex({ userDataPath, sessionId: 'wanted', limit: 1 });
  assert.equal(reads, 9);
  assert.equal(parses, 9);
  assert.equal(index.skipped_count, 2);
  assert.equal(index.recent[0].stream_id, 'stream-8');
});

test('index leaves unmeasured duration and markers unknown and prefers provider total', async () => {
  const userDataPath = createTrackedUserDataPath('jenny-turn-diagnostic-index-unknown-');
  const payloads = [
    { stream_id: 'absent' },
    { stream_id: 'invalid', timing_markers: [
      { name: 'missing' }, { name: 'null', relative_ms: null, ts_ms: null },
    ] },
    { stream_id: 'provider', provider_diagnostics: { total_duration_ms: 345 } },
    { stream_id: 'provider-null', provider_diagnostics: { total_duration_ms: null } },
    { stream_id: 'both', timing_markers: [{ name: 'done', relative_ms: 100 }],
      provider_diagnostics: { total_duration_ms: 200 } },
    { stream_id: 'zero', timing_markers: [{ name: 'start', relative_ms: 0 }] },
    { stream_id: 'stamped', timing_markers: [{ name: 'send', ts_ms: 1_000 }, { name: 'done', ts_ms: 1_120 }] },
  ];
  for (const payload of payloads) writeTurnDiagnostic(userDataPath, '2026-10-14', payload.stream_id, payload);
  const index = await buildTurnDiagnosticIndex({ userDataPath, limit: 10 });
  const rows = new Map(index.recent.map((row) => [row.stream_id, row]));
  assert.equal(rows.get('absent').duration_ms, null);
  assert.equal(rows.get('invalid').duration_ms, null);
  assert.deepEqual(rows.get('invalid').timing_markers, []);
  assert.equal(rows.get('provider').duration_ms, 345);
  assert.equal(rows.get('provider-null').duration_ms, null);
  assert.equal(rows.get('both').duration_ms, 200);
  assert.equal(rows.get('zero').duration_ms, 0);
  assert.equal(rows.get('stamped').duration_ms, 120);
  assert.deepEqual(rows.get('stamped').timing_markers, [{ name: 'send', relative_ms: 0 }, { name: 'done', relative_ms: 120 }]);
});

test('turn diagnostic index returns display-safe metadata for recent session diagnostics', async () => {
  const userDataPath = createTrackedUserDataPath('jenny-turn-diagnostic-index-');
  writeTurnDiagnostic(userDataPath, '2026-05-07', 'stream-a', {
    schema_version: 1,
    written_at: '2026-05-07T12:00:00.000Z',
    request_id: 'request-a',
    stream_id: 'stream-a',
    session_id: 'session-a',
    trace_id: 'trace-a',
    terminal_status: 'complete',
    engine_type: 'ollama',
    model: 'qwen3:8b',
    mode: 'chat',
    timing_markers: [
      { name: 'created', ts_ms: 1_000, relative_ms: 0 },
      { name: 'provider_request_start', ts_ms: 1_120, relative_ms: 120 },
      { name: 'first_chunk', ts_ms: 1_500, relative_ms: 500 },
      { name: 'done', ts_ms: 1_750, relative_ms: 750 },
    ],
    provider_diagnostics: {
      time_to_provider_request_start_ms: 120,
      time_to_first_chunk_ms: 500,
      time_to_first_visible_token_ms: 610,
      visible_tokens_per_second_estimate: 18.5,
      context_tokens_estimate: 2048,
      provider_debug_text: 'private provider detail',
    },
    tool_events: [
      {
        call_id: 'call-1',
        name: 'read_file',
        phase: 'executing',
        ts_ms: 1_200,
        arguments: { path: 'G:/secret.txt' },
      },
      {
        call_id: 'call-1',
        name: 'read_file',
        phase: 'result',
        ts_ms: 1_260,
        output: 'private tool output',
      },
    ],
    assistant_content: 'private assistant text',
    reasoning_text: 'private reasoning text',
  });
  writeTurnDiagnostic(userDataPath, '2026-05-07', 'stream-b', {
    schema_version: 1,
    written_at: '2026-05-07T12:05:00.000Z',
    request_id: 'request-b',
    stream_id: 'stream-b',
    session_id: 'session-b',
    trace_id: 'trace-b',
    terminal_status: 'error',
  });

  const index = await buildTurnDiagnosticIndex({
    userDataPath,
    sessionId: 'session-a',
    limit: 5,
  });

  assert.equal(index.available, true);
  assert.equal(index.count, 1);
  assert.equal(index.recent.length, 1);
  const recent = index.recent[0];
  assert.equal(recent.session_id, 'session-a');
  assert.equal(recent.stream_id, 'stream-a');
  assert.equal(recent.request_id, 'request-a');
  assert.equal(recent.trace_id, 'trace-a');
  assert.equal(recent.terminal_status, 'complete');
  assert.equal(recent.model, 'qwen3:8b');
  assert.equal(recent.mode, 'chat');
  assert.deepEqual(recent.diagnostic_ref, {
    kind: 'turn_diagnostic',
    date: '2026-05-07',
    stream_id: 'stream-a',
    relative_path: 'diagnostics/2026-05-07/stream-a.json',
  });
  assert.deepEqual(
    recent.timing_markers.map((entry) => [entry.name, entry.relative_ms]),
    [
      ['created', 0],
      ['provider_request_start', 120],
      ['first_chunk', 500],
      ['done', 750],
    ]
  );
  assert.deepEqual(recent.timing_spans[0], {
    from: 'created',
    to: 'provider_request_start',
    duration_ms: 120,
  });
  assert.equal(recent.duration_ms, 750);
  assert.equal(recent.provider_timing.time_to_first_chunk_ms, 500);
  assert.equal(recent.provider_timing.time_to_first_visible_token_ms, 610);
  assert.equal(recent.provider_timing.provider_debug_text, undefined);
  assert.deepEqual(recent.tool_events, {
    total: 2,
    by_phase: {
      executing: 1,
      result: 1,
    },
    tool_names: ['read_file'],
  });

  const exposed = JSON.stringify(index);
  assert.equal(exposed.includes('private assistant text'), false);
  assert.equal(exposed.includes('private reasoning text'), false);
  assert.equal(exposed.includes('private provider detail'), false);
  assert.equal(exposed.includes('private tool output'), false);
  assert.equal(exposed.includes('G:/secret.txt'), false);
});

test('turn diagnostic index sorts recent diagnostics and bounds the returned window', async () => {
  const userDataPath = createTrackedUserDataPath('jenny-turn-diagnostic-index-sort-');
  writeTurnDiagnostic(userDataPath, '2026-05-06', 'stream-old', {
    schema_version: 1,
    written_at: '2026-05-06T09:00:00.000Z',
    stream_id: 'stream-old',
    session_id: 'session-a',
  });
  writeTurnDiagnostic(userDataPath, '2026-05-07', 'stream-new', {
    schema_version: 1,
    written_at: '2026-05-07T09:00:00.000Z',
    stream_id: 'stream-new',
    session_id: 'session-a',
  });
  writeTurnDiagnostic(userDataPath, '2026-05-07', 'stream-mid', {
    schema_version: 1,
    written_at: '2026-05-07T08:00:00.000Z',
    stream_id: 'stream-mid',
    session_id: 'session-a',
  });
  fs.writeFileSync(
    path.join(userDataPath, 'diagnostics', '2026-05-07', 'malformed.json'),
    '{not-json',
    'utf8'
  );

  const index = await buildTurnDiagnosticIndex({
    userDataPath,
    limit: 2,
  });

  assert.equal(index.available, true);
  assert.deepEqual(
    index.recent.map((entry) => entry.stream_id),
    ['stream-new', 'stream-mid']
  );
  assert.equal(index.retention.recent_limit, 2);
  assert.equal(index.skipped_count, 1);
});

test('turn diagnostic index applies scan cap after per-day mtime ordering', async () => {
  const userDataPath = createTrackedUserDataPath('jenny-turn-diagnostic-index-cap-');
  const dateSegment = '2026-05-07';
  for (let index = 0; index < 255; index += 1) {
    const streamId = `stream-${String(index).padStart(3, '0')}`;
    writeTurnDiagnostic(userDataPath, dateSegment, streamId, {
      schema_version: 1,
      written_at: '2026-05-07T08:00:00.000Z',
      stream_id: streamId,
      session_id: 'session-a',
    });
    fs.utimesSync(
      path.join(userDataPath, 'diagnostics', dateSegment, `${streamId}.json`),
      new Date('2026-05-07T08:00:00.000Z'),
      new Date('2026-05-07T08:00:00.000Z')
    );
  }
  writeTurnDiagnostic(userDataPath, dateSegment, 'stream-z-newest', {
    schema_version: 1,
    written_at: '2026-05-07T12:00:00.000Z',
    stream_id: 'stream-z-newest',
    session_id: 'session-a',
  });
  fs.utimesSync(
    path.join(userDataPath, 'diagnostics', dateSegment, 'stream-z-newest.json'),
    new Date('2026-05-07T12:00:00.000Z'),
    new Date('2026-05-07T12:00:00.000Z')
  );

  const index = await buildTurnDiagnosticIndex({
    userDataPath,
    limit: 1,
  });

  assert.deepEqual(
    index.recent.map((entry) => entry.stream_id),
    ['stream-z-newest']
  );
});

test('turn diagnostic index surfaces the provider call count of a multi-call turn', async () => {
  // A three-call turn (answer, internal reasoning summary, continuation) is
  // indistinguishable from a single call in the index unless the per-call
  // count rides the display-safe timing block.
  const userDataPath = createTrackedUserDataPath('jenny-turn-diagnostic-index-calls-');
  writeTurnDiagnostic(userDataPath, '2026-09-20', 'stream-calls', {
    schema_version: 1,
    written_at: '2026-09-20T20:30:06.823Z',
    request_id: 'request-calls',
    stream_id: 'stream-calls',
    session_id: 'session-calls',
    terminal_status: 'runtime_error',
    provider_diagnostics: {
      time_to_provider_request_start_ms: 1000,
      time_to_first_chunk_ms: 11000,
      provider_call_count: 3,
      provider_call_purpose: 'checkpoint_continuation',
      provider_calls: [{ ordinal: 1, purpose: 'turn', usage: null }],
    },
  });

  const index = await buildTurnDiagnosticIndex({
    userDataPath,
    sessionId: 'session-calls',
    limit: 5,
  });

  assert.equal(index.count, 1);
  const recent = index.recent[0];
  assert.equal(recent.provider_timing.provider_call_count, 3);
  assert.equal(recent.provider_timing.time_to_provider_request_start_ms, 1000);
  assert.equal(recent.provider_timing.provider_calls, undefined);
  assert.equal(recent.provider_timing.provider_call_purpose, undefined);
});
