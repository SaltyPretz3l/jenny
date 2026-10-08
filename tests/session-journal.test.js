'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');

const {
  JOURNAL_VERSION,
  applyOps,
  createDeltaEncoder,
  encodeHeader,
  encodeRecord,
  journalFileName,
  parseJournalFileName,
  replayJournal,
} = require('../services/backend/session-journal');

const SESSION_ID = 'session-1';
const EPOCH = 1;
const IDENTITY = { sessionId: SESSION_ID, epoch: EPOCH };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createRng(seed) {
  let state = seed >>> 0;
  function float() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    int: (limit) => Math.floor(float() * limit),
    pick: (list) => list[Math.floor(float() * list.length)],
  };
}

const WORDS = [
  'alpha', 'beta', 'gamma', 'ledger', 'invoice', 'reconcile', 'party \u{1F389}',
  '日本語のテスト', 'naïve café', '\u{1F469}‍\u{1F4BB} dev',
  'line\nbreak', 'quote "x"', 'back\\slash', 'tab\there',
];

function makeText(ctx, wordCount) {
  const count = wordCount || 1 + ctx.rng.int(12);
  const parts = [];
  for (let i = 0; i < count; i += 1) parts.push(ctx.rng.pick(WORDS));
  ctx.counter += 1;
  return `${parts.join(' ')} #${ctx.counter}`;
}

function makeMessage(ctx, content) {
  ctx.counter += 1;
  return {
    id: `m${ctx.counter}`,
    role: ctx.rng.pick(['user', 'assistant', 'tool']),
    content: content || makeText(ctx),
    created_at: 1700000000000 + ctx.counter,
    meta: { tokens: ctx.rng.int(500), tags: [ctx.rng.pick(WORDS)] },
  };
}

function makeEvent(ctx) {
  ctx.counter += 1;
  return {
    id: `e${ctx.counter}`,
    kind: ctx.rng.pick(['text', 'tool_call', 'tool_result', 'status']),
    data: { n: ctx.rng.int(100), text: makeText(ctx, 4) },
  };
}

function makeSession(ctx) {
  const session = {
    title: makeText(ctx, 2),
    updated_at: 1700000000000,
    message_count: 0,
    active_turn: null,
    messages: [],
    turn_events: [],
  };
  const messageCount = 3 + ctx.rng.int(8);
  for (let i = 0; i < messageCount; i += 1) session.messages.push(makeMessage(ctx));
  const eventCount = ctx.rng.int(10);
  for (let i = 0; i < eventCount; i += 1) session.turn_events.push(makeEvent(ctx));
  session.message_count = session.messages.length;
  return session;
}

const MUTATIONS = [
  { name: 'append_message', apply: (ctx, s) => { s.messages.push(makeMessage(ctx)); } },
  {
    name: 'replace_message',
    apply: (ctx, s) => {
      if (!s.messages.length) return;
      const index = ctx.rng.int(s.messages.length);
      s.messages[index] = { ...s.messages[index], content: makeText(ctx) };
    },
  },
  {
    name: 'truncate_messages',
    apply: (ctx, s) => { s.messages.length = ctx.rng.int(s.messages.length + 1); },
  },
  { name: 'recreate', apply: () => {} },
  {
    name: 'scalar',
    apply: (ctx, s) => {
      s.title = makeText(ctx, 2);
      s.updated_at += 1 + ctx.rng.int(1000);
      s.message_count = s.messages.length;
    },
  },
  { name: 'set_draft', apply: (ctx, s) => { s.composer_draft = makeText(ctx); } },
  { name: 'remove_draft', apply: (ctx, s) => { delete s.composer_draft; } },
  {
    name: 'snapshot_object',
    apply: (ctx, s) => { s.compaction_snapshot = { upto: s.messages.length, summary: makeText(ctx) }; },
  },
  { name: 'snapshot_null', apply: (ctx, s) => { s.compaction_snapshot = null; } },
  {
    name: 'append_events',
    apply: (ctx, s) => {
      const count = 1 + ctx.rng.int(4);
      for (let i = 0; i < count; i += 1) s.turn_events.push(makeEvent(ctx));
    },
  },
  {
    name: 'replace_events_fewer',
    apply: (ctx, s) => {
      const keep = ctx.rng.int(s.turn_events.length + 1);
      const next = s.turn_events.slice(0, ctx.rng.int(keep + 1));
      while (next.length < keep) next.push(makeEvent(ctx));
      s.turn_events = next;
    },
  },
  {
    name: 'active_turn_object',
    apply: (ctx, s) => { s.active_turn = { turn_id: `t${ctx.counter}`, phase: ctx.rng.pick(['a', 'b']) }; },
  },
  { name: 'active_turn_null', apply: (ctx, s) => { s.active_turn = null; } },
  {
    name: 'non_ascii',
    apply: (ctx, s) => {
      s.messages.push(makeMessage(ctx, '\u{1F389}\u{1F469}‍\u{1F4BB} 日本語 中文 café \u{10348}'));
    },
  },
];

function runChain(start, states) {
  const encoder = createDeltaEncoder(start);
  const chunks = [encodeHeader(IDENTITY)];
  const steps = [];
  for (const state of states) {
    const prepared = encoder.prepare(state);
    steps.push(prepared);
    if (prepared.record) chunks.push(prepared.record);
    prepared.commit();
  }
  return { buffer: Buffer.concat(chunks), chunks, steps };
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const crc = zlib.crc32(body).toString(16).padStart(8, '0');
  return Buffer.concat([Buffer.from(`J1 ${body.length} ${crc} `), body, Buffer.from('\n')]);
}

function parseFrame(buffer) {
  const prefix = /^J1 (\d+) ([0-9a-f]{8}) /.exec(buffer.toString('latin1'));
  assert.ok(prefix, 'line has the J1 prefix');
  assert.equal(buffer[buffer.length - 1], 0x0a);
  const body = buffer.subarray(prefix[0].length, buffer.length - 1);
  return { declaredLength: Number(prefix[1]), declaredCrc: prefix[2], body };
}

function offsetsOf(chunks) {
  const offsets = [];
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
    offsets.push(total);
  }
  return offsets;
}

// Five states where every step changes something, so every step writes a record.
function buildStates() {
  const start = {
    title: 'start',
    messages: [{ id: 1, content: 'a' }],
    turn_events: [],
  };
  const s1 = { ...start, messages: [...start.messages, { id: 2, content: 'b \u{1F389}' }] };
  const s2 = { ...s1, title: 'second', composer_draft: 'typing' };
  const s3 = { ...s2, turn_events: [{ id: 'e1', kind: 'text' }, { id: 'e2', kind: 'status' }] };
  const s4 = { ...s3, messages: [{ id: 1, content: 'a2' }, s3.messages[1]] };
  const s5 = { ...s4, active_turn: { turn_id: 't1' }, messages: [...s4.messages, { id: 3, content: 'c' }] };
  return { start, states: [s1, s2, s3, s4, s5] };
}

test('journal file names round trip, including dotted stems', () => {
  assert.equal(JOURNAL_VERSION, 1);
  assert.equal(journalFileName('session-a', 7), 'session-a.7.journal');
  assert.deepEqual(parseJournalFileName('session-a.7.journal'), { stem: 'session-a', epoch: 7 });
  assert.deepEqual(parseJournalFileName(journalFileName('a.b.c', 12)), { stem: 'a.b.c', epoch: 12 });
  assert.deepEqual(parseJournalFileName('a.1.2.journal'), { stem: 'a.1', epoch: 2 });
  assert.deepEqual(
    parseJournalFileName(journalFileName('s', Number.MAX_SAFE_INTEGER)),
    { stem: 's', epoch: Number.MAX_SAFE_INTEGER },
  );
});

test('journal file names reject non-canonical epochs and other shapes', () => {
  for (const name of [
    'a.01.journal', 'a.0.journal', 'a.-1.journal', 'a.journal', 'a.1.json', 'a.1.journal.tmp',
    '.1.journal', 'a.1.5.journal.bak', 'a.9007199254740993.journal', 'a.1e3.journal', 'a. 1.journal',
    'a.1.journal\n', '', null, undefined, 42,
  ]) {
    assert.equal(parseJournalFileName(name), null, `rejects ${JSON.stringify(name)}`);
  }
  for (const epoch of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null, undefined]) {
    assert.throws(() => journalFileName('a', epoch), TypeError, `epoch ${String(epoch)}`);
  }
  assert.throws(() => journalFileName('', 1), TypeError);
  assert.throws(() => journalFileName(5, 1), TypeError);
});

test('encoded lines declare the UTF-8 byte length and CRC of their JSON', () => {
  const ops = [{ o: 'set', k: 'title', v: '日本語 \u{1F389}' }, { o: 'unset', k: 'composer_draft' }];
  const record = encodeRecord(ops);
  const parsedRecord = parseFrame(record);
  assert.equal(parsedRecord.declaredLength, parsedRecord.body.length);
  assert.ok(parsedRecord.body.length > parsedRecord.body.toString('utf8').length, 'non-ASCII makes bytes exceed chars');
  assert.equal(parsedRecord.declaredCrc, zlib.crc32(parsedRecord.body).toString(16).padStart(8, '0'));
  assert.deepEqual(JSON.parse(parsedRecord.body.toString('utf8')), { t: 'delta', ops });
  assert.equal(parsedRecord.body.includes(0x0a), false);

  const header = parseFrame(encodeHeader({ sessionId: 'sess-é', epoch: 3 }));
  assert.equal(header.declaredLength, header.body.length);
  assert.equal(header.declaredCrc, zlib.crc32(header.body).toString(16).padStart(8, '0'));
  assert.deepEqual(JSON.parse(header.body.toString('utf8')), {
    t: 'header', v: 1, session_id: 'sess-é', epoch: 3,
  });

  assert.equal(encodeRecord([]), null);
  assert.throws(() => encodeHeader({ sessionId: 5, epoch: 1 }), TypeError);
  assert.throws(() => encodeHeader({ sessionId: 's', epoch: 0 }), TypeError);
});

test('random mutation sequences replay to the final session in far fewer bytes', () => {
  const SEQUENCES = 150;
  const STEPS = 25;
  let journalBytes = 0;
  let wholeBytes = 0;
  let recreateChecked = 0;
  for (let seq = 0; seq < SEQUENCES; seq += 1) {
    const ctx = { rng: createRng(7000 + seq), counter: 0 };
    const start = makeSession(ctx);
    const states = [];
    const names = [];
    let current = start;
    for (let step = 0; step < STEPS; step += 1) {
      const mutation = ctx.rng.pick(MUTATIONS);
      const next = clone(current);
      mutation.apply(ctx, next);
      states.push(next);
      names.push(mutation.name);
      wholeBytes += Buffer.byteLength(JSON.stringify(next));
      current = next;
    }
    const { buffer, chunks, steps } = runChain(start, states);
    steps.forEach((prepared, index) => {
      if (names[index] !== 'recreate') return;
      assert.equal(prepared.ops.length, 0, `sequence ${seq} step ${index}: re-created objects produce no ops`);
      assert.equal(prepared.record, null);
      assert.equal(prepared.bytes, 0);
      recreateChecked += 1;
    });
    const replay = replayJournal(clone(start), buffer, IDENTITY);
    assert.equal(replay.status, 'ok', `sequence ${seq}`);
    assert.equal(replay.validBytes, buffer.length);
    assert.equal(replay.records, chunks.length - 1);
    assert.deepStrictEqual(replay.session, clone(current), `sequence ${seq}`);
    journalBytes += buffer.length;
  }
  assert.ok(recreateChecked > 50, `exercised re-creation ${recreateChecked} times`);
  assert.ok(
    journalBytes * 4 < wholeBytes,
    `journal bytes ${journalBytes} should be far below whole-session bytes ${wholeBytes}`,
  );
});

test('odd session shapes still round trip through replay', () => {
  const start = { title: 't', messages: [{ a: 1 }], turn_events: [{ b: 2 }] };
  const states = [
    { title: 'a', messages: 'oops', turn_events: null, gone: undefined, fn: () => 1 },
    { title: 'a', messages: [], turn_events: [] },
    { title: 't' },
    { title: 't', messages: [undefined, () => 1, { x: undefined, y: 1 }], turn_events: [{ z: [undefined] }] },
    { title: 't', messages: [undefined, () => 1, { x: undefined, y: 1 }], turn_events: 7 },
    { title: 't', messages: [{ a: 1 }], turn_events: [{ b: 2 }] },
    JSON.parse('{"title":"t","__proto__":{"polluted":true},"messages":[],"turn_events":[]}'),
    { title: 't', messages: [], turn_events: [] },
  ];
  const { chunks, steps } = runChain(start, states);
  const offsets = offsetsOf(chunks);
  let recordIndex = 0;
  states.forEach((state, index) => {
    if (steps[index].record) recordIndex += 1;
    const prefix = Buffer.concat(chunks.slice(0, recordIndex + 1));
    assert.equal(prefix.length, offsets[recordIndex]);
    const replay = replayJournal(clone(start), prefix, IDENTITY);
    assert.equal(replay.status, 'ok', `state ${index}`);
    assert.deepStrictEqual(replay.session, clone(state), `state ${index}`);
  });
  assert.equal(Object.prototype.polluted, undefined);
});

test('prepare does not advance the baseline until commit, and reset replaces it', () => {
  const start = { title: 'a', messages: [], turn_events: [] };
  const next = { title: 'b', messages: [{ id: 1 }], turn_events: [] };
  const encoder = createDeltaEncoder(start);

  const first = encoder.prepare(next);
  const second = encoder.prepare(next);
  assert.ok(first.ops.length > 0);
  assert.deepEqual(second.ops, first.ops);
  assert.deepEqual(second.record, first.record);
  assert.equal(first.bytes, first.record.length);

  first.commit();
  const afterCommit = encoder.prepare(next);
  assert.deepEqual(afterCommit.ops, []);
  assert.equal(afterCommit.record, null);
  assert.equal(afterCommit.bytes, 0);

  encoder.reset(start);
  assert.deepEqual(encoder.prepare(next).ops, first.ops);
  encoder.reset(next);
  assert.deepEqual(encoder.prepare(next).ops, []);
});

test('the baseline stores serialized content, so in-place mutation is detected', () => {
  const session = { title: 'a', messages: [{ id: 1, content: 'one' }], turn_events: [{ id: 'e', n: 1 }] };
  const encoder = createDeltaEncoder(session);
  encoder.prepare(session).commit();
  assert.deepEqual(encoder.prepare(session).ops, []);

  session.messages[0].content = 'changed in place';
  session.turn_events[0].n = 2;
  session.title = 'b';
  const prepared = encoder.prepare(session);
  const kinds = prepared.ops.map((op) => `${op.o}${op.i === undefined ? '' : `:${op.i}`}`).sort();
  assert.deepEqual(kinds, ['e:0', 'm:0', 'set']);
  prepared.commit();
  assert.deepEqual(encoder.prepare(session).ops, []);

  const start = { messages: [{ id: 1 }], turn_events: [] };
  const mutated = createDeltaEncoder(start);
  start.messages[0].id = 2;
  assert.equal(mutated.prepare(start).ops.length, 1, 'constructor snapshot is isolated from later mutation');
});

test('ops are ordered truncations first, then ascending element sets', () => {
  const start = {
    messages: [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }],
    turn_events: [{ e: 0 }, { e: 1 }],
  };
  const next = {
    messages: [{ i: 0 }, { i: 'one' }, { i: 'two' }],
    turn_events: [{ e: 0 }, { e: 1 }, { e: 2 }, { e: 3 }],
  };
  const { ops } = createDeltaEncoder(start).prepare(next);
  assert.deepEqual(ops, [
    { o: 'mt', n: 3 },
    { o: 'm', i: 1, v: { i: 'one' } },
    { o: 'm', i: 2, v: { i: 'two' } },
    { o: 'e', i: 2, v: { e: 2 } },
    { o: 'e', i: 3, v: { e: 3 } },
  ]);
  assert.deepEqual(applyOps(start, ops), next);
});

test('replay stops cleanly at every torn tail position', () => {
  const { start, states } = buildStates();
  const { chunks, steps } = runChain(start, states);
  assert.equal(steps.every((step) => step.record !== null), true);
  const buffer = Buffer.concat(chunks);
  const offsets = offsetsOf(chunks);
  const lastStart = offsets[offsets.length - 2];
  const priorState = clone(states[states.length - 2]);

  const complete = replayJournal(clone(start), buffer, IDENTITY);
  assert.equal(complete.status, 'ok');
  assert.equal(complete.validBytes, buffer.length);
  assert.equal(complete.records, states.length);

  const atBoundary = replayJournal(clone(start), buffer.subarray(0, lastStart), IDENTITY);
  assert.equal(atBoundary.status, 'ok');
  assert.equal(atBoundary.validBytes, lastStart);
  assert.deepStrictEqual(atBoundary.session, priorState);

  for (let length = lastStart + 1; length < buffer.length; length += 1) {
    const result = replayJournal(clone(start), buffer.subarray(0, length), IDENTITY);
    assert.equal(result.status, 'torn_tail', `length ${length}`);
    assert.equal(result.validBytes, lastStart, `length ${length}`);
    assert.equal(result.records, states.length - 1, `length ${length}`);
    assert.deepStrictEqual(result.session, priorState, `length ${length}`);
  }
});

test('a record whose ops cannot apply is a torn tail at the end and corrupt in the middle', () => {
  const start = { messages: [], turn_events: [] };
  const good = encodeRecord([{ o: 'm', i: 0, v: { id: 1 } }]);
  const bad = encodeRecord([{ o: 'm', i: 0, v: { id: 'x' } }, { o: 'm', i: 9, v: { id: 'y' } }]);
  const head = encodeHeader(IDENTITY);

  const atEnd = replayJournal(start, Buffer.concat([head, good, bad]), IDENTITY);
  assert.equal(atEnd.status, 'torn_tail');
  assert.equal(atEnd.validBytes, head.length + good.length);
  assert.deepStrictEqual(atEnd.session, { messages: [{ id: 1 }], turn_events: [] });

  const inMiddle = replayJournal(start, Buffer.concat([head, good, bad, good]), IDENTITY);
  assert.equal(inMiddle.status, 'corrupt');
  assert.equal(inMiddle.validBytes, head.length + good.length);
  assert.equal(inMiddle.records, 1);
});

test('a corrupted byte in a middle record is corruption, not a torn tail', () => {
  const { start, states } = buildStates();
  const { chunks } = runChain(start, states);
  const offsets = offsetsOf(chunks);
  const buffer = Buffer.concat(chunks);
  const recordIndex = 3;
  const recordStart = offsets[recordIndex - 1];
  const record = chunks[recordIndex];
  const flipAt = recordStart + Math.floor(record.length * 0.75);
  assert.ok(flipAt < recordStart + record.length - 1, 'flip lands inside the line body');

  const damaged = Buffer.from(buffer);
  damaged[flipAt] ^= 0x01;
  const result = replayJournal(clone(start), damaged, IDENTITY);
  assert.equal(result.status, 'corrupt');
  assert.equal(result.validBytes, recordStart);
  assert.equal(result.records, recordIndex - 1);
  assert.deepStrictEqual(result.session, clone(states[recordIndex - 2]));
});

test('a damaged length field is corrupt when records follow it', () => {
  const { start, states } = buildStates();
  const { chunks } = runChain(start, states);
  const offsets = offsetsOf(chunks);
  const buffer = Buffer.concat(chunks);
  const recordStart = offsets[1];
  const record = chunks[2];
  const lengthEnd = record.indexOf(0x20, 3);
  const damaged = Buffer.concat([
    buffer.subarray(0, recordStart),
    Buffer.from('J1 '),
    Buffer.from('7'),
    record.subarray(lengthEnd),
    buffer.subarray(offsets[2]),
  ]);
  const result = replayJournal(clone(start), damaged, IDENTITY);
  assert.equal(result.status, 'corrupt');
  assert.equal(result.validBytes, recordStart);
  assert.equal(result.records, 1);
});

test('header problems yield header_mismatch and leave the base session alone', () => {
  const base = { title: 'base', messages: [], turn_events: [] };
  const record = encodeRecord([{ o: 'set', k: 'title', v: 'changed' }]);
  const cases = {
    empty: Buffer.alloc(0),
    garbage: Buffer.from('hello world\n'),
    binary: Buffer.from([0xff, 0xfe, 0x00, 0x0a]),
    wrongSession: Buffer.concat([encodeHeader({ sessionId: 'other', epoch: EPOCH }), record]),
    wrongEpoch: Buffer.concat([encodeHeader({ sessionId: SESSION_ID, epoch: 2 }), record]),
    wrongVersion: Buffer.concat([frame({ t: 'header', v: 2, session_id: SESSION_ID, epoch: EPOCH }), record]),
    wrongType: Buffer.concat([frame({ t: 'delta', ops: [] }), record]),
    recordFirst: record,
    tornHeader: encodeHeader(IDENTITY).subarray(0, 12),
    headerWithoutNewline: encodeHeader(IDENTITY).subarray(0, encodeHeader(IDENTITY).length - 1),
    wrongMagic: Buffer.from(encodeHeader(IDENTITY).toString('latin1').replace('J1', 'J2'), 'latin1'),
  };
  for (const [name, buffer] of Object.entries(cases)) {
    const result = replayJournal(base, buffer, IDENTITY);
    assert.equal(result.status, 'header_mismatch', name);
    assert.equal(result.session, base, name);
    assert.equal(result.validBytes, 0, name);
    assert.equal(result.records, 0, name);
  }
  const headerOnly = replayJournal(base, encodeHeader(IDENTITY), IDENTITY);
  assert.deepEqual(
    [headerOnly.status, headerOnly.validBytes, headerOnly.records, headerOnly.session],
    ['ok', encodeHeader(IDENTITY).length, 0, base],
  );
});

test('applyOps rejects unknown ops and out-of-range indices', () => {
  const session = { title: 't', messages: [{ id: 1 }, { id: 2 }], turn_events: [{ e: 1 }] };
  const rejected = [
    [{ o: 'nope' }],
    [null],
    [{ o: 'set', k: 'title' }],
    [{ o: 'set', v: 1 }],
    [{ o: 'm', i: 3, v: {} }],
    [{ o: 'm', i: -1, v: {} }],
    [{ o: 'm', i: 0 }],
    [{ o: 'mt', n: -1 }],
    [{ o: 'mt', n: 3 }],
    [{ o: 'et', n: 2 }],
    [{ o: 'm', i: 0, v: { id: 9 } }, { o: 'm', i: 9, v: {} }],
  ];
  for (const ops of rejected) {
    const before = JSON.stringify(session);
    assert.throws(() => applyOps(session, ops), JSON.stringify(ops));
    assert.equal(JSON.stringify(session), before, `input untouched after ${JSON.stringify(ops)}`);
  }
  assert.throws(() => applyOps(session, 'not an array'));
  assert.throws(() => applyOps({ title: 't' }, [{ o: 'm', i: 0, v: {} }]), 'element ops need an array');
});

test('applyOps returns a new session and shares unchanged messages', () => {
  const session = {
    title: 't',
    gone: 1,
    messages: [{ id: 1 }, { id: 2 }],
    turn_events: [{ e: 1 }],
  };
  const frozenCopy = clone(session);
  const messagesBefore = session.messages;
  const eventsBefore = session.turn_events;
  const next = applyOps(session, [
    { o: 'set', k: 'title', v: 'u' },
    { o: 'unset', k: 'gone' },
    { o: 'unset', k: 'never_there' },
    { o: 'mt', n: 1 },
    { o: 'm', i: 1, v: { id: 3 } },
    { o: 'm', i: 2, v: { id: 4 } },
    { o: 'e', i: 1, v: { e: 2 } },
  ]);
  assert.deepStrictEqual(session, frozenCopy);
  assert.equal(session.messages, messagesBefore);
  assert.equal(session.turn_events, eventsBefore);
  assert.notEqual(next, session);
  assert.deepStrictEqual(next, {
    title: 'u', messages: [{ id: 1 }, { id: 3 }, { id: 4 }], turn_events: [{ e: 1 }, { e: 2 }],
  });
  assert.equal(next.messages[0], session.messages[0]);
  assert.equal(next.turn_events[0], session.turn_events[0]);

  const noop = applyOps(session, []);
  assert.deepStrictEqual(noop, session);
  assert.notEqual(noop, session);
});

test('absurd or damaged length fields are rejected without throwing or allocating', () => {
  const base = { messages: [], turn_events: [] };
  const header = encodeHeader(IDENTITY);
  const body = JSON.stringify({ t: 'delta', ops: [{ o: 'set', k: 'title', v: 'x' }] });
  const crc = zlib.crc32(Buffer.from(body)).toString(16).padStart(8, '0');
  const good = encodeRecord([{ o: 'set', k: 'title', v: 'ok' }]);
  const started = Date.now();
  for (const declared of [
    '999999999999', '999999999', '268435457', '4294967296', '00012', '-5', '0', '12x', '', String(body.length + 1),
  ]) {
    const line = Buffer.from(`J1 ${declared} ${crc} ${body}\n`);
    for (const tail of [Buffer.alloc(0), good]) {
      const result = replayJournal(base, Buffer.concat([header, line, tail]), IDENTITY);
      assert.notEqual(result.status, 'ok', `declared ${declared}`);
      assert.equal(result.validBytes, header.length, `declared ${declared}`);
      assert.equal(result.records, 0, `declared ${declared}`);
      assert.equal(result.status, tail.length ? 'corrupt' : 'torn_tail', `declared ${declared}`);
      assert.equal(result.session, base);
    }
  }
  assert.ok(Date.now() - started < 2000, 'rejects quickly');
});

test('replay never throws on malformed input', () => {
  const { start, states } = buildStates();
  const { buffer } = runChain(start, states);
  const rng = createRng(99);
  for (let round = 0; round < 200; round += 1) {
    const damaged = Buffer.from(buffer);
    const flips = 1 + rng.int(4);
    for (let i = 0; i < flips; i += 1) damaged[rng.int(damaged.length)] = rng.int(256);
    const cut = damaged.subarray(0, rng.int(damaged.length + 1));
    const result = replayJournal(clone(start), cut, IDENTITY);
    assert.ok(['ok', 'torn_tail', 'corrupt', 'header_mismatch'].includes(result.status));
    assert.ok(result.validBytes <= cut.length);
  }
  assert.equal(replayJournal(start, Buffer.from('J1 5 '), IDENTITY).status, 'header_mismatch');
  assert.doesNotThrow(() => replayJournal(null, buffer, IDENTITY));
});
