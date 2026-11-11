const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_HIDDEN_EVENT_PREFIXES,
  createDevConsoleFormatter,
  resolveDevConsoleMode,
  resolveHiddenEventPrefixes,
} = require('../scripts/dev/dev-console-formatter');

const REDRAW = '\x1b[1A\x1b[2K';

function entry(event, extra = {}) {
  return `${JSON.stringify({
    ts: '2026-11-10T15:22:20.314Z', level: 'INFO', layer: 'electron', event, message: event,
    status: 'ok', data: {}, ...extra,
  })}\n`;
}

function harness(options = {}) {
  const writes = [];
  const formatter = createDevConsoleFormatter({
    write: (text) => writes.push(text),
    getColumns: () => 140,
    color: false,
    ...options,
  });
  return { formatter, writes, text: () => writes.join('') };
}

test('mode: only a person at a terminal gets the readable console', () => {
  assert.equal(resolveDevConsoleMode({ env: {}, agentMode: false, stdoutIsTTY: true }), 'pretty');
  assert.equal(resolveDevConsoleMode({ env: {}, agentMode: false, stdoutIsTTY: false }), 'raw');
  assert.equal(resolveDevConsoleMode({ env: {}, agentMode: true, stdoutIsTTY: true }), 'raw');
  assert.equal(resolveDevConsoleMode({ env: { JENNY_DEV_CONSOLE: 'raw' }, stdoutIsTTY: true }), 'raw');
  assert.equal(resolveDevConsoleMode({ env: { JENNY_DEV_CONSOLE: ' Verbose ' }, stdoutIsTTY: true }), 'verbose');
  // Cursor rewrites need a terminal, so a forced mode never applies to a pipe.
  assert.equal(resolveDevConsoleMode({ env: { JENNY_DEV_CONSOLE: 'verbose' }, stdoutIsTTY: false }), 'raw');
  assert.equal(resolveDevConsoleMode(), 'raw');
});

test('hidden events: the env list adds to the defaults', () => {
  assert.deepEqual(resolveHiddenEventPrefixes({}), [...DEFAULT_HIDDEN_EVENT_PREFIXES]);
  assert.deepEqual(
    resolveHiddenEventPrefixes({ JENNY_DEV_CONSOLE_HIDE: ' ui.view_changed, ,ollama. ' }),
    [...DEFAULT_HIDDEN_EVENT_PREFIXES, 'ui.view_changed', 'ollama.']
  );
});

test('an entry becomes one aligned row with its useful fields and no identifiers', () => {
  const { formatter, writes } = harness();
  formatter.push(entry('ninfer.server.spawn', {
    data: { sessionId: 'sess_1', port: 8034, mtp: true, ratio: 1.26, nested: { a: 1 }, empty: '' },
  }));
  assert.equal(writes.length, 1);
  const row = writes[0];
  assert.match(row, /^\d\d:\d\d:\d\d {2}INFO {3}electron {2}ninfer\.server\.spawn +port=8034 mtp=true ratio=1\.3\n$/);
  assert.equal(row.includes('sess_1'), false);
  assert.equal(row.includes('nested'), false);
});

test('a message that differs from the event leads the detail, and an unusual status shows', () => {
  const { formatter, text } = harness();
  formatter.push(entry('workspace_file.temp_recovery', {
    layer: 'sidecar', message: 'Scan stopped early', status: 'partial', data: { deleted: 0 },
  }));
  assert.match(text(), /sidecar {3}workspace_file\.temp_recovery +Scan stopped early {2}status=partial {2}deleted=0\n/);
});

test('consecutive repeats redraw one row with a running count', () => {
  const { formatter, writes } = harness();
  formatter.push(entry('backend.status', { data: { phase: 'starting' } }));
  formatter.push(entry('backend.status', { data: { phase: 'loading' } }));
  formatter.push(entry('backend.status', { data: { phase: 'ready' } }));
  formatter.push(entry('window.ready'));
  assert.equal(writes.length, 4);
  assert.equal(writes[1].startsWith(REDRAW), true);
  assert.match(writes[1], /×2 {2}phase=loading\n$/);
  assert.match(writes[2], /×3 {2}phase=ready\n$/);
  // A different event starts a fresh row instead of redrawing.
  assert.equal(writes[3].includes('\x1b['), false);
  // The same event later is a new group, not a continuation.
  formatter.push(entry('backend.status', { data: { phase: 'stopping' } }));
  assert.equal(writes[4].includes('×'), false);
});

test('engine output folds to its latest line under the engine source', () => {
  const { formatter, writes } = harness();
  formatter.push(entry('ninfer.server.output', { message: 'slot 0 busy', data: { stream: 'stderr', line: 'slot 0 busy' } }));
  formatter.push(entry('ninfer.server.output', { message: 'slot 0 released', data: { stream: 'stderr', line: 'slot 0 released' } }));
  assert.match(writes[0], /INFO {3}engine {4}ninfer\.server\.output +slot 0 busy\n$/);
  assert.match(writes[1], /×2 {2}slot 0 released\n$/);
});

test('quiet events and DEBUG are hidden by default and counted; verbose shows them', () => {
  const quiet = harness();
  quiet.formatter.push(entry('chat.scroll_move'));
  quiet.formatter.push(entry('chat_timeline.row_model_rollout_signal', { layer: 'renderer' }));
  quiet.formatter.push(entry('some.debug_detail', { level: 'DEBUG' }));
  assert.equal(quiet.writes.length, 0);
  assert.equal(quiet.formatter.stats.hidden, 3);
  quiet.formatter.end();
  assert.match(quiet.text(), /3 quiet entries hidden \(JENNY_DEV_CONSOLE=verbose shows them\)/);

  const verbose = harness({ verbose: true });
  verbose.formatter.push(entry('chat.scroll_move'));
  verbose.formatter.push(entry('some.debug_detail', { level: 'DEBUG' }));
  assert.equal(verbose.writes.length, 2);
  assert.equal(verbose.formatter.stats.hidden, 0);
});

test('a warning is never hidden and keeps its whole text', () => {
  const { formatter, writes } = harness();
  const long = 'x'.repeat(300);
  formatter.push(entry('chat.scroll_move', { level: 'WARN', layer: 'renderer', message: long }));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].includes(long), true);
  // It took more than one row, so a repeat adds a count row instead of redrawing it.
  formatter.push(entry('chat.scroll_move', { level: 'WARN', layer: 'renderer', message: long }));
  formatter.push(entry('chat.scroll_move', { level: 'WARN', layer: 'renderer', message: long }));
  assert.equal(writes[1].startsWith(REDRAW), false);
  assert.match(writes[1], /repeated ×1 more\n$/);
  assert.equal(writes[2].startsWith(REDRAW), true);
  assert.match(writes[2], /repeated ×2 more\n$/);
  assert.equal(formatter.stats.warnings, 3);
});

test('an ordinary row never exceeds the terminal width', () => {
  const { formatter, writes } = harness({ getColumns: () => 80 });
  formatter.push(entry('ollama.keep_alive_default', { message: 'm'.repeat(500) }));
  formatter.push(entry('ollama.keep_alive_default', { message: 'm'.repeat(500) }));
  assert.equal(writes[0].trimEnd().length <= 79, true);
  assert.equal(writes[1].replace(REDRAW, '').trimEnd().length <= 79, true);
  assert.equal(writes[0].trimEnd().endsWith('…'), true);
});

test('a chat turn gets a rule line and a one-line ending', () => {
  const { formatter, writes } = harness();
  // The hidden preamble opens the turn; the rule waits for the first visible row
  // so it can name the model.
  formatter.push(entry('chat.first_notification_forwarded', { data: { streamId: 'stream_a' } }));
  formatter.push(entry('chat.context_assembly_started', { data: { streamId: 'stream_a', model: 'qwen3.8-27b' } }));
  assert.equal(writes.length, 0);
  formatter.push(entry('chat.sidecar_request_sent', { data: { streamId: 'stream_a', model: 'qwen3.8-27b' } }));
  formatter.push(entry('chat.stream_summary', {
    data: { stream_id: 'stream_a', type: 'complete', durationMs: 6832, toolEventCount: 3 },
  }));
  assert.match(writes[0], /^── turn 1 · qwen3\.8-27b ─+\n$/);
  assert.equal(writes[0].trimEnd().length, 139);
  assert.match(writes[2], /chat\.stream_summary +complete · 6\.8s · 3 tool events\n$/);

  formatter.push(entry('chat.sidecar_request_sent', { data: { streamId: 'stream_b' } }));
  assert.match(writes[3], /^── turn 2 ─+\n$/);
  // A late entry from the first stream does not open a third turn.
  formatter.push(entry('chat.turn_diagnostic_dumped', { data: { streamId: 'stream_a' } }));
  assert.equal(writes.length, 6);
  assert.equal(formatter.end().turns, 2);
});

test('an engine line loses its own timestamp and level', () => {
  const { formatter, writes } = harness();
  formatter.push(entry('ninfer.server.output', { message: '2026-11-10 09:25:49.275  INFO  req#5 done' }));
  formatter.push(entry('ollama.output', { message: 'time=2026-11-10T09:22:24.206-06:00 level=INFO source=routes.go:2373' }));
  assert.match(writes[0], /ninfer\.server\.output +req#5 done\n$/);
  assert.match(writes[1], /ollama\.output +source=routes\.go:2373\n$/);
});

test('lines that are not entries pass through whole, and identical ones fold', () => {
  const { formatter, writes } = harness();
  formatter.push('[1234:ERROR:gpu_process_host.cc] GPU process exited\n', 'stderr');
  formatter.push('[1234:ERROR:gpu_process_host.cc] GPU process exited\n', 'stderr');
  formatter.push('{"not":"an entry"}\n', 'stderr');
  formatter.push('{broken json\n', 'stderr');
  assert.match(writes[0], /^ {10}\[1234:ERROR:gpu_process_host\.cc\] GPU process exited\n$/);
  assert.match(writes[1], /GPU process exited {2}×2\n$/);
  assert.match(writes[2], /\{"not":"an entry"\}/);
  assert.match(writes[3], /\{broken json/);
});

test('chunks split mid-line and mid-character are reassembled per stream', () => {
  const { formatter, writes } = harness();
  const bytes = Buffer.from(entry('session_title.generated', { message: 'Título — ✓' }), 'utf8');
  const cut = bytes.indexOf(Buffer.from('✓', 'utf8')) + 1;
  formatter.push(bytes.subarray(0, cut), 'stdout');
  formatter.push('stderr noise\n', 'stderr');
  formatter.push(bytes.subarray(cut), 'stdout');
  assert.equal(writes.length, 2);
  assert.match(writes[0], /stderr noise/);
  assert.match(writes[1], /session_title\.generated +Título — ✓\n$/);
  assert.equal(writes[1].includes('\ufffd'), false);
});

test('control sequences in a message cannot move the cursor', () => {
  const { formatter, writes } = harness();
  formatter.push(entry('ollama.output', { message: '\x1b[31mred\x1b[0m\ttext\x1b[2J' }));
  assert.equal(writes[0].includes('\x1b'), false);
  assert.match(writes[0], /red text\n$/);
});

test('end flushes an unterminated line and prints the totals', () => {
  const { formatter, writes } = harness();
  formatter.push(entry('app.ready'));
  formatter.push(entry('ipc.handler_slow', { level: 'ERROR' }));
  formatter.push('trailing text without a newline', 'stderr');
  const totals = formatter.end();
  assert.match(writes[2], /trailing text without a newline/);
  assert.match(writes[3], /^── Jenny stopped · 2 entries · 0 warnings · 1 errors ─+\n$/);
  assert.deepEqual(totals, { entries: 2, warnings: 0, errors: 1, hidden: 0, turns: 0 });
});

test('colour wraps the level and source without changing the text', () => {
  const { formatter, writes } = harness({ color: true });
  formatter.push(entry('ipc.handler_slow', { level: 'WARN', data: { durationMs: 900 } }));
  assert.equal(writes[0].includes('\x1b[33mWARN \x1b[0m'), true);
  assert.equal(writes[0].includes('\x1b[36melectron\x1b[0m'), true);
  // eslint-disable-next-line no-control-regex
  assert.match(writes[0].replace(/\x1b\[[0-9;]*m/g, ''), /WARN {3}electron {2}ipc\.handler_slow +durationMs=900\n$/);
});

test('a write function is required', () => {
  assert.throws(() => createDevConsoleFormatter({}), TypeError);
});
