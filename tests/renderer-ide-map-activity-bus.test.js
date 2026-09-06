'use strict';

/* tests/renderer-ide-map-activity-bus.test.js — the "watch Jenny work"
 * state machine. Locks the make-or-break contracts: the path-normalization
 * table (Windows absolute, relative, UNC, scheme://, '..' escapes,
 * out-of-root), the per-tool extraction table, turn lifecycle (new stream
 * starts a turn, complete/error end it identically), replay dedupe by
 * (streamId, callId), session isolation + LRU caps, and trail collapsing. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMapActivityBus,
  normalizeRelPath,
  TOOL_TABLE,
} = require('../renderer/features/renderer-ide-map-activity-bus');

const ROOT = 'C:\\dev\\jenny';

function makeBus(overrides) {
  let t = 1000;
  return createMapActivityBus({
    getRootPath: () => ROOT,
    now: () => { t += 1; return t; },
    ...overrides,
  });
}

function toolUse(over) {
  return {
    type: 'tool_use',
    streamId: 's1',
    sessionId: 'sess1',
    callId: over && over.callId !== undefined ? over.callId : `c${Math.abs(JSON.stringify(over || {}).length)}_${over && over.toolName}_${over && over.input && over.input.path}`,
    toolName: 'Read',
    input: {},
    ...over,
  };
}

// ── normalizeRelPath table ─────────────────────────────────────────────────

test('normalizeRelPath: table-driven identity contract', () => {
  const cases = [
    // [rawPath, expected]
    ['C:\\dev\\jenny\\renderer\\app.js', { kind: 'inside', rel: 'renderer/app.js' }],
    ['C:/dev/jenny/renderer/app.js', { kind: 'inside', rel: 'renderer/app.js' }],
    ['c:\\dev\\JENNY\\renderer\\App.js', { kind: 'inside', rel: 'renderer/App.js' }], // case-insensitive root match
    ['renderer/app.js', { kind: 'inside', rel: 'renderer/app.js' }],
    ['./renderer/app.js', { kind: 'inside', rel: 'renderer/app.js' }],
    ['renderer\\features\\x.js', { kind: 'inside', rel: 'renderer/features/x.js' }],
      ['C:\\Users\\example\\other\\file.js', { kind: 'outside' }],
    ['C:\\dev\\jenny-other\\file.js', { kind: 'outside' }], // sibling dir must not prefix-match
    ['\\\\server\\share\\file.js', { kind: 'outside' }],
    ['/etc/hosts', { kind: 'outside' }],
    ['jenny-artifact://abc/panel.html', { kind: 'rejected' }],
    ['https://example.com/x.js', { kind: 'rejected' }],
    ['../outside.js', { kind: 'rejected' }],
    ['renderer/../../escape.js', { kind: 'rejected' }],
    ['', { kind: 'rejected' }],
    ['   ', { kind: 'rejected' }],
  ];
  for (const [raw, expected] of cases) {
    assert.deepEqual(normalizeRelPath(ROOT, raw), expected, `raw: ${JSON.stringify(raw)}`);
  }
});

test('normalizeRelPath: absolute path with no root is outside', () => {
  assert.deepEqual(normalizeRelPath('', 'G:/x/y.js'), { kind: 'outside' });
});

// ── per-tool extraction ────────────────────────────────────────────────────

test('tool table: read/edit/write produce heat with the right verb; edit marks editedIds', () => {
  const bus = makeBus();
  bus.ingest(toolUse({ callId: 'c1', toolName: 'read_file', input: { path: 'a.js' } }));
  bus.ingest(toolUse({ callId: 'c2', toolName: 'edit_file', input: { path: 'b.js' } }));
  bus.ingest(toolUse({ callId: 'c3', toolName: 'write_file', input: { file_path: 'c.js' } }));
  const s = bus.getState('sess1');
  assert.equal(s.heat.get('a.js').verb, 'read');
  assert.equal(s.heat.get('b.js').verb, 'edit');
  assert.equal(s.heat.get('c.js').verb, 'edit');
  assert.deepEqual([...s.editedIds].sort(), ['b.js', 'c.js']);
  assert.equal(s.counts.touched, 3);
  assert.equal(s.counts.edited, 2);
  // read_file/edit_file/write_file normalize through the alias table only
  // when tool-call-utils resolves; both spellings must work.
  assert.ok(TOOL_TABLE.Read && TOOL_TABLE.Edit && TOOL_TABLE.Write);
});

test('tool table: grep with a resolvable dir path heats it; bash is rail-only with a truncated label', () => {
  const bus = makeBus();
  bus.ingest(toolUse({ callId: 'c1', toolName: 'Grep', input: { pattern: 'x', path: 'renderer' } }));
  bus.ingest(toolUse({ callId: 'c2', toolName: 'run_command', input: { command: 'npm test '.repeat(30) } }));
  const s = bus.getState('sess1');
  assert.equal(s.heat.get('renderer').verb, 'search');
  assert.equal(s.trail.length, 2);
  assert.equal(s.trail[1].rel, null);
  assert.equal(s.trail[1].verb, 'run');
  assert.ok(s.trail[1].label.length <= 64);
  assert.ok(s.trail[1].label.endsWith('…'));
});

test('out-of-root paths never heat the map — only the aggregate counter moves', () => {
  const bus = makeBus();
  bus.ingest(toolUse({ callId: 'c1', toolName: 'Read', input: { path: 'C:\\Windows\\notepad.exe' } }));
  bus.ingest(toolUse({ callId: 'c2', toolName: 'Write', input: { path: 'C:\\temp\\x.txt' } }));
  const s = bus.getState('sess1');
  assert.equal(s.heat.size, 0);
  assert.equal(s.trail.length, 0);
  assert.equal(s.counts.outside, 2);
  assert.equal(s.counts.edited, 0);
});

// ── turn lifecycle ─────────────────────────────────────────────────────────

test('turn lifecycle: tool starts turn, complete ends it, new stream clears the old trail', () => {
  const bus = makeBus();
  bus.ingest(toolUse({ callId: 'c1', input: { path: 'a.js' } }));
  let s = bus.getState('sess1');
  assert.equal(s.turnActive, true);

  bus.ingest({ type: 'complete', streamId: 's1', sessionId: 'sess1' });
  s = bus.getState('sess1');
  assert.equal(s.turnActive, false);
  assert.ok(s.turnEndedAt > 0);
  assert.equal(s.heat.size, 1, 'heat survives turn end (fades visually, not structurally)');

  bus.ingest(toolUse({ streamId: 's2', callId: 'c9', input: { path: 'b.js' } }));
  s = bus.getState('sess1');
  assert.equal(s.turnActive, true);
  assert.equal(s.trail.length, 1);
  assert.equal(s.trail[0].rel, 'b.js', 'new turn cleared the previous trail/heat');
  assert.ok(!s.heat.has('a.js'));
});

test('error ends the turn exactly like complete; unknown/foreign terminals are ignored', () => {
  const bus = makeBus();
  bus.ingest(toolUse({ callId: 'c1', input: { path: 'a.js' } }));
  bus.ingest({ type: 'error', streamId: 'sX', sessionId: 'sess1' }); // foreign stream
  assert.equal(bus.getState('sess1').turnActive, true);
  bus.ingest({ type: 'error', streamId: 's1', sessionId: 'sess1' });
  assert.equal(bus.getState('sess1').turnActive, false);
  assert.equal(bus.ingest({ type: 'delta', streamId: 's1', sessionId: 'sess1' }), false);
});

test('tool_approval_needed flags pending; the tool_result clears it', () => {
  const bus = makeBus();
  bus.ingest({ type: 'tool_approval_needed', streamId: 's1', sessionId: 'sess1', callId: 'c1', toolName: 'Bash', input: {} });
  assert.equal(bus.getState('sess1').pendingApproval, true);
  bus.ingest({ type: 'tool_result', streamId: 's1', sessionId: 'sess1', callId: 'c1' });
  assert.equal(bus.getState('sess1').pendingApproval, false);
  // Orphan result for an unseen stream: ignored, no throw.
  assert.equal(bus.ingest({ type: 'tool_result', streamId: 'zz', sessionId: 'sess1' }), false);
});

// ── dedupe / trail / caps ──────────────────────────────────────────────────

test('replay dedupe: same (streamId, callId) ingests once', () => {
  const bus = makeBus();
  const evt = toolUse({ callId: 'dup1', toolName: 'Edit', input: { path: 'a.js' } });
  assert.equal(bus.ingest(evt), true);
  assert.equal(bus.ingest({ ...evt }), false);
  const s = bus.getState('sess1');
  assert.equal(s.trail.length, 1);
  assert.equal(s.trail[0].count, 1);
});

test('trail collapses consecutive same-file same-verb touches into ×N', () => {
  const bus = makeBus();
  for (let i = 0; i < 5; i += 1) {
    bus.ingest(toolUse({ callId: `e${i}`, toolName: 'Edit', input: { path: 'a.js' } }));
  }
  bus.ingest(toolUse({ callId: 'r1', toolName: 'Read', input: { path: 'a.js' } }));
  const s = bus.getState('sess1');
  assert.equal(s.trail.length, 2);
  assert.equal(s.trail[0].count, 5);
  assert.equal(s.trail[1].verb, 'read');
});

test('caps: trail stops at 200 steps; heat LRU-evicts past 500', () => {
  const bus = makeBus();
  for (let i = 0; i < 620; i += 1) {
    bus.ingest(toolUse({ callId: `c${i}`, toolName: 'Read', input: { path: `f${i}.js` } }));
  }
  const s = bus.getState('sess1');
  assert.equal(s.trail.length, 200);
  assert.equal(s.heat.size, 500);
  assert.ok(!s.heat.has('f0.js'), 'oldest evicted');
  assert.ok(s.heat.has('f619.js'));
});

test('sessions are isolated and LRU-capped at 4', () => {
  const bus = makeBus();
  for (const sess of ['a', 'b', 'c', 'd', 'e']) {
    bus.ingest(toolUse({ sessionId: sess, streamId: `s-${sess}`, callId: 'c1', input: { path: 'x.js' } }));
  }
  assert.equal(bus.getState('a'), null, 'oldest session evicted');
  assert.ok(bus.getState('e'));
  assert.equal(bus.getState('e').heat.has('x.js'), true);
  assert.equal(bus.getState('b').heat.size, 1);
});

test('subscribe notifies on change with the sessionId; clearAll wipes root-relative state', () => {
  const bus = makeBus();
  const seen = [];
  const unsub = bus.subscribe((sessionId) => seen.push(sessionId));
  bus.ingest(toolUse({ callId: 'c1', input: { path: 'a.js' } }));
  bus.ingest(toolUse({ callId: 'c1', input: { path: 'a.js' } })); // dupe: no notify
  assert.deepEqual(seen, ['sess1']);
  bus.clearAll();
  assert.equal(bus.getState('sess1'), null);
  unsub();
  bus.ingest(toolUse({ callId: 'c2', input: { path: 'b.js' } }));
  assert.deepEqual(seen, ['sess1'], 'unsubscribed');
});

test('dispose: ingest becomes a no-op', () => {
  const bus = makeBus();
  bus.dispose();
  assert.equal(bus.ingest(toolUse({ callId: 'c1', input: { path: 'a.js' } })), false);
  assert.equal(bus.getState('sess1'), null);
});
