'use strict';

// replayJournal applies every record to one working copy (linear in the
// journal) instead of copying the whole session per record, which was
// quadratic for the session index (one top-level key per chat). The result
// must equal folding applyOps record by record, including at a damaged record.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyOps,
  encodeHeader,
  encodeRecord,
  replayJournal,
} = require('../services/backend/session-journal');

function journalOf(records, { sessionId = 'sess', epoch = 1 } = {}) {
  const parts = [encodeHeader({ sessionId, epoch })];
  for (const ops of records) parts.push(encodeRecord(ops) || Buffer.alloc(0));
  return Buffer.concat(parts);
}

// The reference semantics: applyOps per record, stopping at the first record
// that throws (the session before it is kept).
function foldApplyOps(base, records) {
  let session = base;
  let applied = 0;
  for (const ops of records) {
    try {
      session = applyOps(session, ops);
    } catch (error) {
      void error;
      break;
    }
    applied += 1;
  }
  return { session, applied };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomOp(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const kind = pick(['set', 'set', 'unset', 'm', 'm', 'mt', 'e', 'et', 'set_array', 'bad']);
  const key = pick(['title', 'count', 'messages', 'turn_events', 'x']);
  switch (kind) {
    case 'set': return { o: 'set', k: key, v: pick([1, 'a', null, { n: random() }, [1, 2]]) };
    case 'set_array': return { o: 'set', k: pick(['messages', 'turn_events']), v: [{ id: 'z' }] };
    case 'unset': return { o: 'unset', k: key };
    case 'm': return { o: 'm', i: Math.floor(random() * 6), v: { id: `m${Math.floor(random() * 100)}` } };
    case 'e': return { o: 'e', i: Math.floor(random() * 4), v: { id: 'e' } };
    case 'mt': return { o: 'mt', n: Math.floor(random() * 5) };
    case 'et': return { o: 'et', n: Math.floor(random() * 3) };
    default: return pick([{ o: 'nope' }, { o: 'set', k: 3, v: 1 }, { o: 'm', i: -1, v: 1 }, { o: 'mt', n: 1.5 }]);
  }
}

test('replay equals folding applyOps record by record, including at a record that does not apply', () => {
  const random = seededRandom(20261019);
  for (let round = 0; round < 400; round += 1) {
    const base = {
      title: 't',
      messages: [{ id: 'm0' }, { id: 'm1' }],
      turn_events: [{ id: 'e0' }],
    };
    const frozen = JSON.stringify(base);
    const baseMessages = base.messages;
    const records = [];
    const recordCount = 1 + Math.floor(random() * 8);
    for (let r = 0; r < recordCount; r += 1) {
      const ops = [];
      const opCount = 1 + Math.floor(random() * 5);
      for (let o = 0; o < opCount; o += 1) ops.push(randomOp(random));
      records.push(ops);
    }
    const expected = foldApplyOps(base, records);
    const result = replayJournal(base, journalOf(records), { sessionId: 'sess', epoch: 1 });
    assert.deepEqual(result.session, expected.session, `round ${round}`);
    assert.equal(result.records, expected.applied, `round ${round}`);
    // A record that does not apply is damage when a valid record follows it.
    const status = expected.applied === records.length ? 'ok'
      : expected.applied < records.length - 1 ? 'corrupt' : 'torn_tail';
    assert.equal(result.status, status, `round ${round}`);
    assert.equal(JSON.stringify(base), frozen, 'the base is never mutated');
    assert.equal(base.messages, baseMessages);
  }
});

test('a journal without records returns the base itself', () => {
  const base = { a: 1 };
  const result = replayJournal(base, journalOf([]), { sessionId: 'sess', epoch: 1 });
  assert.equal(result.session, base);
  assert.equal(result.records, 0);
});

test('an index-shaped journal replays in linear time', () => {
  // 20000 chats as top-level keys and 3000 records: the per-record copy made
  // this about 60 million property copies (seconds); one working copy is
  // milliseconds.
  const base = {};
  for (let i = 0; i < 20000; i += 1) base[`sess_${i}`] = { id: `sess_${i}`, title: `Chat ${i}` };
  const records = [];
  for (let r = 0; r < 3000; r += 1) {
    records.push([{ o: 'set', k: `sess_${r % 20000}`, v: { id: `sess_${r}`, title: `Renamed ${r}` } }]);
  }
  const buffer = journalOf(records, { sessionId: '_index', epoch: 2 });
  const started = performance.now();
  const result = replayJournal(base, buffer, { sessionId: '_index', epoch: 2 });
  const elapsed = performance.now() - started;
  assert.equal(result.records, 3000);
  assert.equal(result.session.sess_2999.title, 'Renamed 2999');
  assert.equal(base.sess_2999.title, 'Chat 2999');
  assert.ok(elapsed < 750, `replay took ${elapsed.toFixed(0)} ms`);
});
