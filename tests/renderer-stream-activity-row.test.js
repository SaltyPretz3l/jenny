'use strict';

// Phantom activity row: ephemeral tail row covering silent arg-generation
// phases (renderer-stream-activity-row.js). DOM-patch only — never enters the
// row model or persistence; any stream event removes it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const {
  createStreamActivityRow,
  ACTIVITY_COPY,
  ACTIVITY_COPY_LONG,
} = require('../renderer/chat/renderer-stream-activity-row');

function makeHarness(t, { withPendingArticle = true, overrides = {} } = {}) {
  const articleHtml = withPendingArticle
    ? '<article class="chat-entry assistant pending"><div class="chat-message-content"><div class="chat-row">hi</div></div></article>'
    : '';
  const dom = new JSDOM(`<div id="chatTimeline">${articleHtml}</div>`);
  const doc = dom.window.document;
  const timeline = doc.getElementById('chatTimeline');
  const flags = { live: true, visible: true, blocking: false };
  const clock = { nowMs: 0 };
  const row = createStreamActivityRow({
    getChatTimeline: () => timeline,
    isStreamLive: () => flags.live,
    isSessionVisible: () => flags.visible,
    hasBlockingToolState: () => flags.blocking,
    now: () => clock.nowMs,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    pickCopyIndex: () => 0,
    ...overrides,
  });
  t.after(() => {
    row.dispose();
    dom.window.close();
  });
  return { dom, doc, timeline, flags, clock, row };
}

function findRow(timeline) {
  return timeline.querySelector('.turn-activity-row');
}

function noteEvent(row, type, extra = {}) {
  row.noteStreamEvent({ type, streamId: 'stream-1', sessionId: 'session-1', ...extra });
}

test('appears only after the silence threshold, inside the live article', (t) => {
  const { timeline, clock, row } = makeHarness(t);
  noteEvent(row, 'delta');
  clock.nowMs = 1000;
  row.tick();
  assert.equal(findRow(timeline), null, 'below threshold: no row');
  clock.nowMs = 1600;
  row.tick();
  const node = findRow(timeline);
  assert.ok(node, 'row mounts after 1.5s silence');
  assert.ok(
    node.parentNode.classList.contains('chat-message-content'),
    'mounts inside the streaming article content column'
  );
  assert.equal(node.querySelector('.turn-activity-label').textContent, ACTIVITY_COPY[0]);
  assert.equal(node.querySelector('.turn-activity-elapsed').textContent, '', 'elapsed hidden early');
  assert.equal(node.getAttribute('role'), 'status');
});

test('does not arm on started alone (turn start belongs to the thinking indicator)', (t) => {
  const { timeline, clock, row } = makeHarness(t);
  noteEvent(row, 'started');
  clock.nowMs = 5000;
  row.tick();
  assert.equal(findRow(timeline), null);
  // First real progress arms it.
  noteEvent(row, 'thinking_status');
  clock.nowMs = 7000;
  row.tick();
  assert.ok(findRow(timeline));
});

test('any stream event dismisses the visible row immediately', (t) => {
  const { timeline, clock, row } = makeHarness(t);
  noteEvent(row, 'delta');
  clock.nowMs = 2000;
  row.tick();
  assert.ok(findRow(timeline));
  clock.nowMs = 2100;
  noteEvent(row, 'delta');
  assert.equal(findRow(timeline), null, 'removed synchronously by the event, before any tick');
  clock.nowMs = 2500;
  row.tick();
  assert.equal(findRow(timeline), null, 'silence clock restarted');
  clock.nowMs = 3700;
  row.tick();
  assert.ok(findRow(timeline), 'reappears after renewed silence');
});

test('tool_use dismisses it and a blocking tool state keeps it suppressed', (t) => {
  const { timeline, flags, clock, row } = makeHarness(t);
  noteEvent(row, 'delta');
  clock.nowMs = 2000;
  row.tick();
  assert.ok(findRow(timeline));
  noteEvent(row, 'tool_use');
  flags.blocking = true;
  assert.equal(findRow(timeline), null);
  clock.nowMs = 9000;
  row.tick();
  assert.equal(findRow(timeline), null, 'running/awaiting tool keeps the phantom row hidden');
  // Tool settled: silence after tool_result shows it again (next arg-gen).
  flags.blocking = false;
  noteEvent(row, 'tool_result');
  clock.nowMs = 11000;
  row.tick();
  assert.ok(findRow(timeline));
});

test('terminal events untrack and remove', (t) => {
  const { timeline, clock, row } = makeHarness(t);
  noteEvent(row, 'delta');
  clock.nowMs = 2000;
  row.tick();
  assert.ok(findRow(timeline));
  noteEvent(row, 'complete');
  assert.equal(findRow(timeline), null);
  clock.nowMs = 60000;
  row.tick();
  assert.equal(findRow(timeline), null, 'completed stream never re-shows');
});

test('a stream that is no longer live is removed on the next tick', (t) => {
  const { timeline, flags, clock, row } = makeHarness(t);
  noteEvent(row, 'delta');
  clock.nowMs = 2000;
  row.tick();
  assert.ok(findRow(timeline));
  flags.live = false;
  clock.nowMs = 2500;
  row.tick();
  assert.equal(findRow(timeline), null);
});

test('hidden sessions never show the row', (t) => {
  const { timeline, flags, clock, row } = makeHarness(t);
  flags.visible = false;
  noteEvent(row, 'delta');
  clock.nowMs = 5000;
  row.tick();
  assert.equal(findRow(timeline), null);
});

test('elapsed counter reveals at 10s and copy escalates at 30s', (t) => {
  const { timeline, clock, row } = makeHarness(t);
  noteEvent(row, 'delta');
  clock.nowMs = 11000;
  row.tick();
  const node = findRow(timeline);
  const elapsed = node.querySelector('.turn-activity-elapsed');
  assert.equal(elapsed.textContent, '0:11');
  assert.equal(elapsed.getAttribute('data-turn-elapsed'), 'true');
  assert.equal(elapsed.getAttribute('data-elapsed-started-at'), '0');
  clock.nowMs = 31000;
  row.tick();
  assert.equal(node.querySelector('.turn-activity-label').textContent, ACTIVITY_COPY_LONG);
});

test('context_usage neither resets the silence clock nor dismisses the row', (t) => {
  const { timeline, clock, row } = makeHarness(t);
  noteEvent(row, 'delta');
  clock.nowMs = 2000;
  row.tick();
  assert.ok(findRow(timeline));
  noteEvent(row, 'context_usage');
  assert.ok(findRow(timeline), 'chrome-only telemetry leaves the row alone');
});

test('context compaction renders immediately and ends on the next real event', (t) => {
  const { timeline, row } = makeHarness(t);
  noteEvent(row, 'context_compacting', {
    compactionPhase: 'preflight',
    tokensBefore: 12300,
    messageCount: 14,
  });

  const node = findRow(timeline);
  assert.ok(node, 'compaction does not wait for the silence threshold');
  assert.equal(node.dataset.turnActivityKind, 'compaction');
  assert.equal(node.querySelector('.turn-activity-name').textContent, 'Compacting context');
  assert.equal(
    node.querySelector('.turn-activity-label').textContent,
    'summarizing 14 older messages · 12,300 tokens'
  );
  assert.equal(node.querySelector('.turn-activity-elapsed').textContent, '0:00');

  noteEvent(row, 'context_compacting', { compactionPhase: 'tool_loop' });
  assert.equal(findRow(timeline), node, 'the activity node is updated in place');
  assert.equal(node.querySelector('.turn-activity-name').textContent, 'Compacting context mid-task');
  assert.equal(node.querySelector('.turn-activity-label').textContent, 'summarizing older context…');

  noteEvent(row, 'context_compacted');
  assert.equal(findRow(timeline), null);
  noteEvent(row, 'context_compacting', { compactionPhase: 'preflight' });
  assert.ok(findRow(timeline));
  noteEvent(row, 'delta');
  assert.equal(findRow(timeline), null, 'ordinary stream progress clears the typed episode');
});

test('tool input renders live tool, path, size, and elapsed details', (t) => {
  const { timeline, clock, row } = makeHarness(t);
  noteEvent(row, 'tool_input_delta', {
    toolCallId: 'call-1',
    toolName: 'write_file',
    argumentsDelta: '{',
    sequence: 0,
  });

  const node = findRow(timeline);
  assert.ok(node, 'tool input does not wait for the silence threshold');
  assert.equal(node.dataset.turnActivityKind, 'tool_input');
  assert.equal(node.querySelector('.turn-activity-name').textContent, 'write_file');
  assert.equal(node.querySelector('.turn-activity-label').textContent, 'Composing…');

  const pathSuffix = '"path":"src/a.js","content":"';
  noteEvent(row, 'tool_input_delta', {
    toolCallId: 'call-1', toolName: 'write_file', argumentsDelta: pathSuffix, sequence: 1,
  });
  assert.equal(findRow(timeline), node, 'more input for the same call keeps the row mounted');
  const label = node.querySelector('.turn-activity-label');
  assert.equal(label.textContent, 'src/a.js');
  assert.equal(label.classList.contains('turn-activity-label--path'), true);

  clock.nowMs = 3000;
  let remaining = 1229 - 1 - pathSuffix.length;
  let sequence = 2;
  while (remaining > 0) {
    const chunk = 'x'.repeat(Math.min(512, remaining));
    noteEvent(row, 'tool_input_delta', {
      toolCallId: 'call-1', toolName: 'write_file', argumentsDelta: chunk, sequence,
    });
    remaining -= chunk.length;
    sequence += 1;
  }
  assert.equal(node.querySelector('.turn-activity-elapsed').textContent, '1.2 KB · 0:03');
  assert.equal(node.querySelector('.turn-activity-elapsed').hasAttribute('data-turn-elapsed'), false,
    'the shared clock must not rewrite the size · elapsed label');
  noteEvent(row, 'tool_input_delta', {
    toolCallId: 'call-1', toolName: 'write_file', argumentsDelta: '', argumentsBytes: 20480, sequence,
  });
  assert.equal(node.querySelector('.turn-activity-elapsed').textContent, '20.0 KB · 0:03',
    'a cumulative byte count from Electron wins over summed delta lengths');

  clock.nowMs = 4000;
  noteEvent(row, 'tool_input_delta', {
    toolCallId: 'call-2', toolName: 'edit_file', argumentsDelta: 'x', sequence: 0,
  });
  assert.equal(findRow(timeline), node, 'a new call reuses the DOM node');
  assert.equal(node.querySelector('.turn-activity-name').textContent, 'edit_file');
  assert.equal(node.querySelector('.turn-activity-label').textContent, 'Composing…');
  assert.equal(node.querySelector('.turn-activity-label').classList.contains('turn-activity-label--path'), false);
  assert.equal(node.querySelector('.turn-activity-elapsed').textContent, '1 B · 0:00');

  noteEvent(row, 'tool_use');
  assert.equal(findRow(timeline), null);
});

test('tool input retains only the first 4 KB while looking for a path', (t) => {
  const first = makeHarness(t);
  for (let offset = 0; offset < 3584; offset += 512) {
    noteEvent(first.row, 'tool_input_delta', {
      toolCallId: 'call-early', toolName: 'write_file', argumentsDelta: 'x'.repeat(512), sequence: offset / 512,
    });
  }
  noteEvent(first.row, 'tool_input_delta', {
    toolCallId: 'call-early', toolName: 'write_file', argumentsDelta: '"file_path":"src/early.js"', sequence: 7,
  });
  assert.equal(findRow(first.timeline).querySelector('.turn-activity-label').textContent, 'src/early.js');

  const second = makeHarness(t);
  for (let offset = 0; offset < 4096; offset += 512) {
    noteEvent(second.row, 'tool_input_delta', {
      toolCallId: 'call-late', toolName: 'write_file', argumentsDelta: 'x'.repeat(512), sequence: offset / 512,
    });
  }
  noteEvent(second.row, 'tool_input_delta', {
    toolCallId: 'call-late', toolName: 'write_file', argumentsDelta: '"path":"src/late.js"', sequence: 8,
  });
  assert.equal(findRow(second.timeline).querySelector('.turn-activity-label').textContent, 'Composing…');
});

test('typed activity honors visibility, blocking state, and live stream ownership', (t) => {
  const { timeline, flags, row } = makeHarness(t);
  flags.visible = false;
  noteEvent(row, 'context_compacting', { phase: 'preflight' });
  assert.equal(findRow(timeline), null);
  flags.visible = true;
  row.tick();
  assert.ok(findRow(timeline), 'visible session reveals the active typed episode');

  flags.blocking = true;
  noteEvent(row, 'tool_input_delta', {
    toolCallId: 'call-1', toolName: 'write_file', argumentsDelta: '{}', sequence: 0,
  });
  assert.equal(findRow(timeline), null);
  flags.blocking = false;
  row.tick();
  assert.ok(findRow(timeline), 'typed activity resumes after blocking tool state clears');

  flags.live = false;
  row.tick();
  assert.equal(findRow(timeline), null);
  flags.live = true;
  row.tick();
  assert.equal(findRow(timeline), null, 'a dead stream was untracked rather than merely hidden');
});

test('falls back to the timeline when no assistant article exists', (t) => {
  const { timeline, clock, row } = makeHarness(t, { withPendingArticle: false });
  noteEvent(row, 'delta');
  clock.nowMs = 2000;
  row.tick();
  const node = findRow(timeline);
  assert.ok(node);
  assert.equal(node.parentNode, timeline);
});

test('dispose removes the node and stops tracking', (t) => {
  const { timeline, clock, row } = makeHarness(t);
  noteEvent(row, 'delta');
  clock.nowMs = 2000;
  row.tick();
  assert.ok(findRow(timeline));
  row.dispose();
  assert.equal(findRow(timeline), null);
  clock.nowMs = 9000;
  row.tick();
  assert.equal(findRow(timeline), null);
});

test('file-operation motion is disabled under prefers-reduced-motion', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-machinery.css'), 'utf8');
  const reducedMotionBlocks = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)]
    .map((match) => match[1])
    .join('\n');

  assert.match(reducedMotionBlocks, /\.tool-call-file-operation[\s\S]*?transition:\s*none/);
  assert.match(reducedMotionBlocks, /\.tool-call-file-composing \.tool-call-file-icon[\s\S]*?animation:\s*none/);
  // The settled state has no keyframe (the composing->settled class flip is a
  // transition, covered by the first assertion), so nothing to disable here.
});
