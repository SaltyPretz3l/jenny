'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  dumpTurnDiagnostic,
  mergeClientTimingIntoTurnDiagnostic,
  pruneTurnDiagnostics,
} = require('../services/backend/turn-diagnostic-dump');
const { pipeChildLogs } = require('../services/backend/child-process-logging');
const { normalizeLogEntry } = require('../services/log-entry-normalizer');
const { redactLogReportValue } = require('../renderer/shared/log-contract-utils');
const { EventEmitter } = require('node:events');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-diagnostic-dump-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('dumpTurnDiagnostic redacts sensitive payload fields before writing', async (t) => {
  const userDataPath = makeTempDir(t);
  const service = {
    options: { userDataPath },
    sidecarClient: {
      async harnessTurnDiagnostic() {
        return {
          provider_diagnostics: {
            excerpt: 'prompt fragment at G:\\Secrets\\workspace with OPENAI_API_KEY=sk-providersecret',
          },
        };
      },
    },
    _emitServiceLog() {},
  };

  const filePath = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-1',
    streamId: 'stream-1',
    requestId: 'request-1',
    traceId: 'trace-1',
    terminalStatus: 'runtime_error',
    terminalError: {
      message: 'failed in G:\\Secrets\\workspace with bearer abcdef12345',
    },
    contextContributions: {
      prompt: 'user prompt from G:/Secrets/workspace/file.txt',
    },
    redactionPrefixes: ['G:\\Secrets\\workspace', 'G:/Secrets/workspace'],
  });

  const written = fs.readFileSync(filePath, 'utf8');
  assert.equal(written.includes('sk-providersecret'), false);
  assert.equal(written.includes('abcdef12345'), false);
  assert.equal(written.includes('G:\\Secrets\\workspace'), false);
  assert.equal(written.includes('G:/Secrets/workspace'), false);
  assert.match(written, /\[redacted/);
});

test('pruneTurnDiagnostics removes old files and caps retained diagnostics', async (t) => {
  const userDataPath = makeTempDir(t);
  const diagnosticsRoot = path.join(userDataPath, 'diagnostics');
  const oldDir = path.join(diagnosticsRoot, '2026-01-01');
  const newDir = path.join(diagnosticsRoot, '2026-04-26');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  const oldFile = path.join(oldDir, 'old.json');
  fs.writeFileSync(oldFile, '{}', 'utf8');

  const recentFiles = [];
  for (let index = 0; index < 4; index += 1) {
    const file = path.join(newDir, `recent-${index}.json`);
    fs.writeFileSync(file, '{}', 'utf8');
    const timestamp = Date.UTC(2026, 3, 26, 12, index);
    fs.utimesSync(file, new Date(timestamp), new Date(timestamp));
    recentFiles.push(file);
  }

  const result = await pruneTurnDiagnostics({
    userDataPath,
    now: new Date(Date.UTC(2026, 3, 26, 13)),
    maxAgeDays: 30,
    maxFiles: 2,
  });

  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(result.removedCount, 3);
  assert.equal(fs.existsSync(recentFiles[0]), false);
  assert.equal(fs.existsSync(recentFiles[1]), false);
  assert.equal(fs.existsSync(recentFiles[2]), true);
  assert.equal(fs.existsSync(recentFiles[3]), true);
});

test('pruneTurnDiagnostics retains a boundary UTC day with late-in-day diagnostics', async (t) => {
  const userDataPath = makeTempDir(t);
  const diagnosticsRoot = path.join(userDataPath, 'diagnostics');
  const expiredDir = path.join(diagnosticsRoot, '2026-03-26');
  const boundaryDir = path.join(diagnosticsRoot, '2026-03-27');
  fs.mkdirSync(expiredDir, { recursive: true });
  fs.mkdirSync(boundaryDir, { recursive: true });
  const expiredFile = path.join(expiredDir, 'expired.json');
  const boundaryFile = path.join(boundaryDir, 'late.json');
  fs.writeFileSync(expiredFile, '{}', 'utf8');
  fs.writeFileSync(boundaryFile, '{}', 'utf8');
  const lateTimestamp = new Date(Date.UTC(2026, 2, 27, 23, 59));
  fs.utimesSync(boundaryFile, lateTimestamp, lateTimestamp);

  const result = await pruneTurnDiagnostics({
    userDataPath,
    now: new Date(Date.UTC(2026, 3, 26, 13)),
    maxAgeDays: 30,
    maxFiles: 10,
  });

  assert.equal(result.removedCount, 1);
  assert.equal(fs.existsSync(expiredFile), false);
  assert.equal(fs.existsSync(boundaryFile), true);
});

test('mergeClientTimingIntoTurnDiagnostic merges renderer counters into the dumped file', async (t) => {
  const { mergeClientTimingIntoTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');
  const userDataPath = makeTempDir(t);
  const service = { options: { userDataPath }, _emitServiceLog() {} };

  const filePath = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-1',
    streamId: 'stream_merge_1',
    terminalStatus: 'completed',
    clientTiming: { send_started_at_ms: 1000 },
  });
  assert.ok(filePath);

  const merged = await mergeClientTimingIntoTurnDiagnostic({
    service,
    streamId: 'stream_merge_1',
    clientTiming: {
      deltas_received: 42,
      stream_reveal_patches_applied: 17,
      full_renders: 2,
      noop_renders: 3,
      first_delta_at_ms: 1500,
      first_paint_at_ms: 1540,
      first_delta_to_first_paint_ms: 40,
      not_a_known_field: 'dropped',
    },
    attempts: 1,
    delayMs: 1,
  });
  assert.equal(merged, filePath);

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload.client_timing.send_started_at_ms, 1000);
  assert.equal(payload.client_timing.deltas_received, 42);
  assert.equal(payload.client_timing.stream_reveal_patches_applied, 17);
  assert.equal(payload.client_timing.full_renders, 2);
  assert.equal(payload.client_timing.noop_renders, 3);
  assert.equal(payload.client_timing.first_delta_to_first_paint_ms, 40);
  assert.equal('not_a_known_field' in payload.client_timing, false);
});

test('client_timing keeps the renderer full_render_reasons histogram (bounded, counts only)', async (t) => {
  // A degraded dump (full_renders >> stream_reveal_patches_applied) is useless
  // for RCA without the per-reason breakdown the renderer already computes.
  const { mergeClientTimingIntoTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');
  const userDataPath = makeTempDir(t);
  const service = { options: { userDataPath }, _emitServiceLog() {} };
  const filePath = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-1',
    streamId: 'stream_reasons_1',
    terminalStatus: 'completed',
    clientTiming: { send_started_at_ms: 1000 },
  });
  assert.ok(filePath);

  const oversized = {};
  for (let i = 0; i < 40; i += 1) oversized[`reason_${i}`] = 1;
  const merged = await mergeClientTimingIntoTurnDiagnostic({
    service,
    streamId: 'stream_reasons_1',
    clientTiming: {
      full_renders: 7,
      full_render_reasons: {
        'cannot_patch:streaming_id_mismatch': 5,
        projection_revision_changed: 2,
        ['k'.repeat(100)]: 1,
        zero_count: 0,
        not_a_number: 'nope',
      },
    },
    attempts: 1,
    delayMs: 1,
  });
  assert.equal(merged, filePath);
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload.client_timing.full_renders, 7);
  assert.deepEqual(payload.client_timing.full_render_reasons, {
    'cannot_patch:streaming_id_mismatch': 5,
    projection_revision_changed: 2,
    ['k'.repeat(64)]: 1,
  });

  // Bounded to 32 reasons; an all-junk histogram is dropped, not emitted empty.
  await mergeClientTimingIntoTurnDiagnostic({
    service,
    streamId: 'stream_reasons_1',
    clientTiming: { full_render_reasons: oversized },
    attempts: 1,
    delayMs: 1,
  });
  const bounded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(Object.keys(bounded.client_timing.full_render_reasons).length, 32);
  assert.equal(await mergeClientTimingIntoTurnDiagnostic({
    service,
    streamId: 'stream_reasons_1',
    clientTiming: { full_render_reasons: { junk: 'x' }, fullRenderReasons: [] },
    attempts: 1,
    delayMs: 1,
  }), null);
});

test('client_timing preserves Ht-C reasoning header morph/rewrite counters shipped by the renderer', async (t) => {
  // Regression (#23): renderer-stream-client-metrics.take() ships
  // reasoning_header_morphs / reasoning_header_rewrites (and
  // last_delta_to_terminal_ms), but the diagnostics field allowlist predated
  // them, so _normalizeClientTiming silently dropped them from every dumped
  // stream. They must survive both the initial dump and the later merge.
  const { mergeClientTimingIntoTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');
  const userDataPath = makeTempDir(t);
  const service = { options: { userDataPath }, _emitServiceLog() {} };

  // (a) Initial dump path preserves the counters.
  const dumped = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-htc',
    streamId: 'stream_htc_1',
    terminalStatus: 'completed',
    clientTiming: {
      deltas_received: 12,
      reasoning_header_morphs: 5,
      reasoning_header_rewrites: 2,
      last_delta_to_terminal_ms: 87,
    },
  });
  assert.ok(dumped);
  const dumpedPayload = JSON.parse(fs.readFileSync(dumped, 'utf8'));
  assert.equal(dumpedPayload.client_timing.reasoning_header_morphs, 5);
  assert.equal(dumpedPayload.client_timing.reasoning_header_rewrites, 2);
  assert.equal(dumpedPayload.client_timing.last_delta_to_terminal_ms, 87);

  // (b) Merge path preserves the counters when the renderer reports them late.
  const merged = await mergeClientTimingIntoTurnDiagnostic({
    service,
    streamId: 'stream_htc_1',
    clientTiming: {
      deltas_received: 12,
      reasoning_header_morphs: 9,
      reasoning_header_rewrites: 4,
      last_delta_to_terminal_ms: 120,
    },
    attempts: 1,
    delayMs: 1,
  });
  assert.equal(merged, dumped);
  const mergedPayload = JSON.parse(fs.readFileSync(dumped, 'utf8'));
  assert.equal(mergedPayload.client_timing.reasoning_header_morphs, 9);
  assert.equal(mergedPayload.client_timing.reasoning_header_rewrites, 4);
  assert.equal(mergedPayload.client_timing.last_delta_to_terminal_ms, 120);
});

test('client_timing initial dump captures camelCase send-phase markers (no null-by-construction)', async (t) => {
  // Regression (#23 null-persist): managed-sidecar-chat feeds dumpTurnDiagnostic
  // the normalizePhaseClientTiming() shape, which is camelCase
  // (sendStartedAtMs/...), while the on-disk client_timing is snake_case. Before
  // this fix _normalizeClientTiming found zero matching keys and returned null,
  // so EVERY initial dump wrote client_timing:null and only a later renderer
  // merge could populate it — streams whose merge never landed stayed null.
  const userDataPath = makeTempDir(t);
  const service = { options: { userDataPath }, _emitServiceLog() {} };

  const dumped = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-phase',
    streamId: 'stream_phase_1',
    terminalStatus: 'completed',
    // The camelCase shape produced by normalizePhaseClientTiming().
    clientTiming: {
      sendStartedAtMs: 1000,
      optimisticRenderedAtMs: 1120,
      localRenderLatencyMs: 120,
    },
  });
  assert.ok(dumped);
  const payload = JSON.parse(fs.readFileSync(dumped, 'utf8'));
  assert.notEqual(payload.client_timing, null);
  assert.equal(payload.client_timing.send_started_at_ms, 1000);
  assert.equal(payload.client_timing.optimistic_rendered_at_ms, 1120);
  assert.equal(payload.client_timing.local_render_latency_ms, 120);
});

test('mergeClientTimingIntoTurnDiagnostic queues an early renderer report until dump exists', async (t) => {
  const { mergeClientTimingIntoTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');
  const userDataPath = makeTempDir(t);
  const events = [];
  const service = {
    options: { userDataPath },
    _emitServiceLog(level, event) { events.push(`${level}:${event}`); },
  };
  const merged = await mergeClientTimingIntoTurnDiagnostic({
    service,
    streamId: 'stream_missing',
    clientTiming: { deltas_received: 1 },
    attempts: 2,
    delayMs: 1,
  });
  assert.equal(merged, null);
  assert.ok(events.includes('INFO:chat.turn_diagnostic_client_timing_pending'));
  assert.equal(events.some((entry) => entry.includes('orphaned')), false);

  const originalWriteFile = fs.promises.writeFile;
  let writeCalls = 0;
  fs.promises.writeFile = async (...args) => {
    writeCalls += 1;
    return originalWriteFile.call(fs.promises, ...args);
  };
  t.after(() => { fs.promises.writeFile = originalWriteFile; });
  const dumped = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-pending',
    streamId: 'stream_missing',
    terminalStatus: 'completed',
  });
  const payload = JSON.parse(fs.readFileSync(dumped, 'utf8'));
  assert.equal(payload.client_timing.deltas_received, 1);
  assert.equal(writeCalls, 1, 'pending timing is included in the initial atomic payload write');
  assert.ok(events.includes('INFO:chat.turn_diagnostic_client_timing_merged'));
});

test('dumpTurnDiagnostic restores queued client timing after a write failure', async (t) => {
  const userDataPath = makeTempDir(t);
  const service = { options: { userDataPath }, _emitServiceLog() {} };
  await mergeClientTimingIntoTurnDiagnostic({
    service,
    streamId: 'stream_retry',
    clientTiming: { deltas_received: 7 },
    attempts: 1,
    delayMs: 0,
  });

  const originalWriteFile = fs.promises.writeFile;
  let failNextWrite = true;
  fs.promises.writeFile = async (...args) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('simulated write failure');
    }
    return originalWriteFile.call(fs.promises, ...args);
  };
  t.after(() => { fs.promises.writeFile = originalWriteFile; });

  const first = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-retry',
    streamId: 'stream_retry',
    terminalStatus: 'completed',
  });
  assert.equal(first, null);

  const second = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-retry',
    streamId: 'stream_retry',
    terminalStatus: 'completed',
  });
  const payload = JSON.parse(fs.readFileSync(second, 'utf8'));
  assert.equal(payload.client_timing.deltas_received, 7);
});

test('atomic dump publication and merge read failures keep late client timing pending', async (t) => {
  const userDataPath = makeTempDir(t);
  const service = { options: { userDataPath }, _emitServiceLog() {} };
  const originalRename = fs.promises.rename;
  const originalReadFile = fs.promises.readFile;
  let releaseRename;
  let observeRename;
  const renameStarted = new Promise((resolve) => { observeRename = resolve; });
  const renameGate = new Promise((resolve) => { releaseRename = resolve; });
  fs.promises.rename = async (tempPath, filePath) => {
    observeRename({ tempPath, filePath });
    await renameGate;
    return originalRename.call(fs.promises, tempPath, filePath);
  };
  t.after(() => {
    fs.promises.rename = originalRename;
    fs.promises.readFile = originalReadFile;
  });

  const dumpPromise = dumpTurnDiagnostic({
    service,
    sessionId: 'session-interleaved',
    streamId: 'stream_interleaved',
    terminalStatus: 'completed',
  });
  const publishing = await renameStarted;
  assert.equal(fs.existsSync(publishing.tempPath), true);
  assert.equal(fs.existsSync(publishing.filePath), false);

  const duringWrite = await mergeClientTimingIntoTurnDiagnostic({
    service,
    streamId: 'stream_interleaved',
    clientTiming: { deltas_received: 3 },
    attempts: 1,
    delayMs: 0,
  });
  assert.equal(duringWrite, null);
  releaseRename();
  await dumpPromise;
  fs.promises.rename = originalRename;

  fs.promises.readFile = async (filePath, ...args) => {
    if (filePath === publishing.filePath) {
      throw new Error('controlled read interleaving failure');
    }
    return originalReadFile.call(fs.promises, filePath, ...args);
  };
  const failedMerge = await mergeClientTimingIntoTurnDiagnostic({
    service,
    streamId: 'stream_interleaved',
    clientTiming: { full_renders: 2 },
    attempts: 1,
    delayMs: 0,
  });
  assert.equal(failedMerge, null);
  fs.promises.readFile = originalReadFile;

  const rewritten = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-interleaved',
    streamId: 'stream_interleaved',
    terminalStatus: 'completed',
  });
  const payload = JSON.parse(fs.readFileSync(rewritten, 'utf8'));
  assert.equal(payload.client_timing.deltas_received, 3);
  assert.equal(payload.client_timing.full_renders, 2);
});

test('mergeClientTimingIntoTurnDiagnostic rejects path-escaping stream ids and empty timing', async (t) => {
  const { mergeClientTimingIntoTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');
  const userDataPath = makeTempDir(t);
  const service = { options: { userDataPath }, _emitServiceLog() {} };
  assert.equal(await mergeClientTimingIntoTurnDiagnostic({
    service,
    streamId: '..\\..\\evil',
    clientTiming: { deltas_received: 1 },
    attempts: 1,
    delayMs: 1,
  }), null);
  assert.equal(await mergeClientTimingIntoTurnDiagnostic({
    service,
    streamId: 'stream_ok',
    clientTiming: { nothing_numeric: 'x' },
    attempts: 1,
    delayMs: 1,
  }), null);
});

// ---------------------------------------------------------------------------
// F17 REQUIRED REGRESSION — one sentinel set, three surfaces.
//
// Sentinel probes proved these shapes survived the general log path all the way
// into the user-facing log-report copy: the artifact a user pastes into a bug
// report. services/log-entry-normalizer.js is the single require seam into
// renderer/shared/log-contract-utils.js, so the persisted main log, the
// turn-diagnostic dump and the report copy must now all fail identically.
// ---------------------------------------------------------------------------
const SENTINEL_CHILD_SECRETS = [
  'ghp_SENTINEL01234567',
  'hf_SENTINELabcdefghijklmnopqrstuvwx',
  'xoxb-SENTINEL-1234567890-abcdefghij',
  'AKIAIOSFODNN7EXAMPLE',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTRU5USU5FTCJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
];
const SENTINEL_POSIX_ROOT = '/home/ci-runner/.config/jenny/credentials';

function sentinelStderrLine() {
  return `codex auth failed: ${SENTINEL_CHILD_SECRETS.join(' ')} reading ${SENTINEL_POSIX_ROOT}`;
}

function assertNoSentinels(serialized, where) {
  for (const secret of SENTINEL_CHILD_SECRETS) {
    assert.equal(serialized.includes(secret), false, `${secret} leaked into ${where}`);
  }
  assert.equal(
    serialized.includes(SENTINEL_POSIX_ROOT),
    false,
    `POSIX root path leaked into ${where}`
  );
}

test('sentinel secrets in child stderr never reach a persisted main log entry', () => {
  const stderr = new EventEmitter();
  stderr.setEncoding = () => {};
  const raw = [];
  pipeChildLogs({ stderr }, {
    prefix: 'codex.cli',
    logger: (level, event, details) => raw.push({ level, event, details }),
  });
  stderr.emit('data', `${sentinelStderrLine()}\n`);

  // Pre-redaction the line is verbatim — the sentinel really is in the pipe.
  assert.equal(raw.length, 1);
  assert.equal(raw[0].details.line.includes(SENTINEL_CHILD_SECRETS[0]), true);

  // Every persisted log goes through normalizeLogEntry.
  const persisted = normalizeLogEntry({
    level: raw[0].level,
    event: raw[0].event,
    details: raw[0].details,
  });
  assertNoSentinels(JSON.stringify(persisted), 'the persisted main log entry');
  assert.match(JSON.stringify(persisted), /\[redacted/);
});

test('sentinel secrets in child stderr never reach the user-facing log-report copy', () => {
  const report = redactLogReportValue({
    stream: 'stderr',
    line: sentinelStderrLine(),
    nested: { tail: [sentinelStderrLine()] },
  });
  assertNoSentinels(JSON.stringify(report), 'the log-report copy');
});

test('sentinel secrets in child stderr never reach a written turn diagnostic', async (t) => {
  const userDataPath = makeTempDir(t);
  const service = {
    options: { userDataPath },
    sidecarClient: {
      async harnessTurnDiagnostic() {
        return { provider_diagnostics: { excerpt: sentinelStderrLine() } };
      },
    },
    _emitServiceLog() {},
  };

  const filePath = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-sentinel',
    streamId: 'stream-sentinel',
    requestId: 'request-sentinel',
    traceId: 'trace-sentinel',
    terminalStatus: 'runtime_error',
    terminalError: { message: sentinelStderrLine() },
    contextContributions: { prompt: sentinelStderrLine() },
  });

  assertNoSentinels(fs.readFileSync(filePath, 'utf8'), 'the written turn diagnostic');
});

test('dumpTurnDiagnostic rejects path-escaping stream ids before file IO', async (t) => {
  const userDataPath = makeTempDir(t);
  const events = [];
  const service = {
    options: { userDataPath },
    _emitServiceLog(_level, event) { events.push(event); },
  };
  const result = await dumpTurnDiagnostic({
    service,
    streamId: '..\\..\\outside',
    terminalStatus: 'completed',
  });
  assert.equal(result, null);
  assert.deepEqual(events, ['chat.turn_diagnostic_stream_id_rejected']);
  assert.equal(fs.existsSync(path.join(userDataPath, 'outside.json')), false);
});
