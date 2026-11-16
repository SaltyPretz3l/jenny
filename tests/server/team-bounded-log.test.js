'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createFixture } = require('./helpers/team-store-fixture');
const { renameDurable } = require('../../services/host/durable-json');
const { assertSafeFile } = require('../../services/host/path-guard');
const {
  BoundedLogFile, LOG_DOCUMENT_KEYS, boundLogDocument, emptyLogDocument, utcStamp, validLogDocument,
} = require('../../server/team/bounded-log');

const SHAPE = { schemaVersion: 4, maxEntries: 10, validEntry: (entry) => Number.isSafeInteger(entry?.seq) };

function doc(entries, overrides = {}) {
  return {
    schema_version: 4, floor_seq: 1, next_seq: (entries.at(-1)?.seq ?? 0) + 1, entries, ...overrides,
  };
}

const seqs = (...values) => values.map((seq) => ({ seq }));

test('an empty document starts the floor and the next seq at 1', () => {
  assert.deepEqual(emptyLogDocument(4), { schema_version: 4, floor_seq: 1, next_seq: 1, entries: [] });
  assert.deepEqual(LOG_DOCUMENT_KEYS, ['schema_version', 'floor_seq', 'next_seq', 'entries']);
  assert.equal(validLogDocument(emptyLogDocument(4), SHAPE), true);
});

test('validLogDocument holds the document shape and the sequence rules', () => {
  assert.equal(validLogDocument(doc(seqs(1, 2, 5)), SHAPE), true);
  assert.equal(validLogDocument(doc(seqs(3, 4), { floor_seq: 3 }), SHAPE), true);
  for (const [name, bad] of Object.entries({
    not_object: [],
    null: null,
    wrong_schema: doc([], { schema_version: 5 }),
    extra_key: { ...doc([]), extra: 1 },
    missing_key: { schema_version: 4, floor_seq: 1, next_seq: 1 },
    floor_zero: doc([], { floor_seq: 0 }),
    floor_fraction: doc([], { floor_seq: 1.5 }),
    next_below_floor: doc([], { floor_seq: 3, next_seq: 2 }),
    entries_not_array: doc([], { entries: {} }),
    too_many: doc(seqs(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)),
    below_floor: doc(seqs(1, 2), { floor_seq: 2 }),
    not_increasing: doc(seqs(2, 2), { next_seq: 3 }),
    reaches_next: doc(seqs(1, 2), { next_seq: 2 }),
    entry_refused: doc([{ seq: 1 }, { seq: 'two' }], { next_seq: 3 }),
  })) {
    assert.equal(validLogDocument(bad, SHAPE), false, name);
  }
});

test('boundLogDocument drops the oldest to fit the entry bound and records the floor', () => {
  const candidate = doc(seqs(1, 2, 3, 4, 5, 6));
  const bounded = boundLogDocument(candidate, { maxEntries: 4, maxBytes: 1e6 });
  assert.deepEqual(bounded.entries.map((entry) => entry.seq), [3, 4, 5, 6]);
  assert.equal(bounded.floor_seq, 3);
  assert.equal(bounded.next_seq, 7);
  assert.equal(candidate.entries.length, 6, 'the candidate is not changed');
  assert.equal(boundLogDocument(candidate, { maxEntries: 10, maxBytes: 1e6 }), candidate, 'a fitting candidate is returned as is');
});

test('boundLogDocument drops the oldest to fit the byte bound and the result serializes inside it', () => {
  const entries = Array.from({ length: 50 }, (_unused, index) => ({ seq: index + 1, pad: 'x'.repeat(40) }));
  const maxBytes = 1000;
  const bounded = boundLogDocument(doc(entries), { maxEntries: 100, maxBytes });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= maxBytes);
  assert.equal(bounded.entries.at(-1).seq, 50);
  assert.equal(bounded.floor_seq, bounded.entries[0].seq);
  const oneMore = { ...bounded, entries: [entries[bounded.entries[0].seq - 2], ...bounded.entries] };
  assert.ok(Buffer.byteLength(JSON.stringify(oneMore)) >= maxBytes, 'it drops no more than it must');
});

test('boundLogDocument always keeps the newest entry', () => {
  const bounded = boundLogDocument(doc([{ seq: 1, pad: 'x'.repeat(500) }, { seq: 2, pad: 'y'.repeat(500) }]),
    { maxEntries: 10, maxBytes: 10 });
  assert.deepEqual(bounded.entries.map((entry) => entry.seq), [2]);
  assert.equal(bounded.floor_seq, 2);
});

function openFile(fx, options = {}) {
  return new BoundedLogFile({
    filePath: path.join(fx.dir, 'log.json'),
    readCapBytes: 4096,
    parse: (stored) => (validLogDocument(stored, SHAPE) ? stored : null),
    emptyDocument: () => emptyLogDocument(4),
    logger: fx.logger,
    events: { rejected: 'test_log.rejected', writeFailed: 'test_log.write_failed' },
    ...options,
  });
}

test('a missing file loads as the empty document and persist makes it durable', (t) => {
  const fx = createFixture(t);
  const file = openFile(fx);
  assert.deepEqual(file.load(), emptyLogDocument(4));
  assert.equal(fs.existsSync(file.filePath), false, 'loading never writes');
  const next = doc(seqs(1));
  assert.equal(file.persist(next), true);
  assert.equal(file.load(), next, 'the held document is the persisted one');
  assert.deepEqual(openFile(fx).load(), next);
});

test('a failed persist logs only the error code and the next load re-reads the file', (t) => {
  const fx = createFixture(t);
  const file = openFile(fx, {
    writeJson() { throw Object.assign(new Error('secret path C:\\x'), { code: 'EIO' }); },
  });
  const before = file.load();
  assert.equal(file.persist(doc(seqs(1))), false);
  const after = file.load();
  assert.notEqual(after, before, 'the held document was dropped');
  assert.deepEqual(after, before, 'and the file still holds what it held');
  assert.deepEqual(fx.logs, [{ level: 'ERROR', event: 'test_log.write_failed', fields: { code: 'EIO' } }]);
});

test('a write that landed before it threw is seen by the next load, so no seq is reused', (t) => {
  const fx = createFixture(t);
  const durable = require('../../services/host/durable-json');
  let throwAfterWrite = false;
  const file = openFile(fx, {
    writeJson(filePath, value) {
      durable.writeJson(filePath, value);
      if (throwAfterWrite) { throwAfterWrite = false; throw Object.assign(new Error('dir fsync'), { code: 'EIO' }); }
    },
  });
  file.load();
  assert.equal(file.persist(doc(seqs(1))), true);
  throwAfterWrite = true;
  assert.equal(file.persist(doc(seqs(1, 2))), false);
  assert.equal(file.load().next_seq, 3, 'the landed entry is held, not the document before it');
});

const osError = (code) => Object.assign(new Error(`${code}: held C:\\secret`), { code, syscall: 'open' });

test('a passing read failure answers unavailable once and the next call loads the file', (t) => {
  const passing = ['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EIO', 'EAGAIN'].map(osError);
  passing.push(new Error('metadata_changed_during_read'));
  for (const error of passing) {
    const fx = createFixture(t);
    fs.writeFileSync(path.join(fx.dir, 'log.json'), JSON.stringify(doc(seqs(1))));
    let fail = true;
    const file = openFile(fx, {
      readJson(filePath, options) {
        if (fail) { fail = false; throw error; }
        return require('../../services/host/durable-json').readJson(filePath, options);
      },
    });
    assert.equal(file.load(), null, error.message);
    assert.equal(file.persist(doc(seqs(1, 2))), false, `${error.message}: nothing is written while failing`);
    assert.equal(file.load().next_seq, 2, `${error.message}: the next call loads the file`);
    assert.equal(file.persist(doc(seqs(1, 2))), true, `${error.message}: and writes again`);
  }
});

test('refused content latches and the file is never rewritten, whatever the error looks like', (t) => {
  const refusals = [
    new Error('invalid_metadata_file'), new Error('invalid_metadata_root'), new SyntaxError('Unexpected token'),
    osError('ELOOP'), osError('EISDIR'), osError('ENOTDIR'), osError('ENOSPC_UNKNOWN'),
    Object.assign(new Error('File is not a plain file.'), { code: 'CMP-HOST-0004', reason: 'unsafe_path' }),
    new Error('anything else'), 'a string',
  ];
  for (const error of refusals) {
    const fx = createFixture(t);
    let calls = 0;
    const file = openFile(fx, { readJson() { calls += 1; if (calls === 1) throw error; return doc([]); } });
    assert.equal(file.load(), null, String(error));
    assert.equal(file.load(), null, `${error}: still refused`);
    assert.equal(file.persist(doc(seqs(1))), false, `${error}: never written`);
    assert.equal(calls, 1, `${error}: the file is not read again`);
    assert.equal(fs.existsSync(file.filePath), false);
  }
});

test('a lasting passing failure logs one line, and recovery logs one more', (t) => {
  const fx = createFixture(t);
  let busy = true;
  const file = openFile(fx, { readJson() { if (busy) throw osError('EBUSY'); return null; } });
  for (let index = 0; index < 50; index += 1) {
    assert.equal(file.load(), null);
    assert.equal(file.persist(doc(seqs(1))), false);
  }
  assert.deepEqual(fx.logs, [{ level: 'WARN', event: 'test_log.read_failed', fields: { code: 'EBUSY' } }]);
  busy = false;
  assert.deepEqual(file.load(), emptyLogDocument(4));
  file.load();
  assert.deepEqual(fx.logs.slice(1), [{ level: 'INFO', event: 'test_log.read_recovered', fields: {} }]);
  assert.equal(JSON.stringify(fx.logs).includes('secret'), false, 'never the message or a path');
});

test('a refused, unreadable or oversized file marks the log broken and is never rewritten', (t) => {
  for (const bytes of ['{"schema_version":5,"floor_seq":1,"next_seq":1,"entries":[]}', 'not json', ' '.repeat(5000)]) {
    const fx = createFixture(t);
    const file = openFile(fx);
    fs.writeFileSync(file.filePath, bytes);
    assert.equal(file.load(), null);
    for (let index = 0; index < 3; index += 1) {
      assert.equal(file.persist(doc(seqs(1))), false, 'a broken log refuses writes');
      assert.equal(file.load(), null, 'and stays broken');
    }
    assert.equal(fs.readFileSync(file.filePath, 'utf8'), bytes);
    assert.equal(fx.logs[0].event, 'test_log.rejected');
  }
});

test('the read cap is passed to the reader and assertSafePath guards both directions', (t) => {
  const fx = createFixture(t);
  const caps = [];
  const guarded = [];
  const file = openFile(fx, {
    readJson(_filePath, options) { caps.push(options.maxBytes); return null; },
    assertSafePath(filePath) { guarded.push(path.basename(filePath)); },
  });
  file.load();
  file.persist(doc(seqs(1)));
  assert.deepEqual(caps, [4096]);
  assert.deepEqual(guarded, ['log.json', 'log.json']);
  const blocked = openFile(createFixture(t), { assertSafePath() { throw new Error('junction'); } });
  assert.equal(blocked.load(), null);
});

test('a throwing logger never decides anything', (t) => {
  const fx = createFixture(t);
  const file = openFile(fx, { logger() { throw new Error('log down'); }, writeJson() { throw new Error('x'); } });
  assert.deepEqual(file.load(), emptyLogDocument(4));
  assert.equal(file.persist(doc(seqs(1))), false);
  assert.equal(file.persist(doc(seqs(1))), false, 'nothing is held after a failed write');
});

test('the constructor refuses missing pieces', () => {
  for (const missing of ['filePath', 'readCapBytes', 'parse', 'emptyDocument', 'events']) {
    const options = {
      filePath: 'x.json', readCapBytes: 1, parse: () => null, emptyDocument: () => null,
      events: { rejected: 'a', writeFailed: 'b' },
    };
    delete options[missing];
    assert.throws(() => new BoundedLogFile(options), TypeError, missing);
  }
});

// ------------------------------------------------------------------ set aside

const NOW = Date.UTC(2026, 10, 11, 12, 34, 56, 789);
const KEPT = 'log.json.unreadable-20261111123456789';
const keptOf = (fx) => fs.readdirSync(fx.dir).filter((name) => name.startsWith('log.json.unreadable-')).sort();

test('only a file refused for its content can be set aside', (t) => {
  const fx = createFixture(t);
  const filePath = path.join(fx.dir, 'log.json');
  const other = path.join(fx.dir, 'other.json');
  for (const [name, plant, refusal] of [
    ['not_json', () => fs.writeFileSync(filePath, '{nope'), 'content'],
    ['over_cap', () => fs.writeFileSync(filePath, 'x'.repeat(5000)), 'content'],
    ['sequence', () => fs.writeFileSync(filePath, JSON.stringify(doc([], { floor_seq: 3, next_seq: 2 }))), 'content'],
    ['newer', () => fs.writeFileSync(filePath, JSON.stringify(doc([], { schema_version: 5 }))), 'newer_schema'],
    ['directory', () => fs.mkdirSync(filePath), 'os'],
    ['hard_link', () => { fs.writeFileSync(filePath, '{nope'); fs.linkSync(filePath, other); }, 'os'],
  ]) {
    fs.rmSync(filePath, { recursive: true, force: true });
    fs.rmSync(other, { force: true });
    plant();
    const file = openFile(fx);
    assert.equal(file.load(), null, name);
    assert.equal(file.refusal(), refusal, name);
    const moved = file.setAside({ now: NOW });
    assert.equal(moved.ok, refusal === 'content', name);
    if (moved.ok) fs.rmSync(path.join(fx.dir, moved.keptName));
    else assert.ok(fs.existsSync(filePath), `${name}: left where it was`);
  }
  fs.rmSync(filePath, { recursive: true, force: true });
  fs.writeFileSync(filePath, '{nope');
  const guarded = openFile(fx, { assertSafePath() { throw Object.assign(new Error('x'), { reason: 'unsafe_path' }); } });
  assert.equal(guarded.load(), null);
  assert.equal(guarded.refusal(), 'unsafe_path');
  assert.equal(guarded.setAside({ now: NOW }).ok, false);
  assert.deepEqual(keptOf(fx), []);
});

test('a set-aside keeps the newest three, logs the count and starts the file afresh', (t) => {
  const fx = createFixture(t);
  for (const stamp of ['20200101000000001', '20200101000000002', '20200101000000003']) {
    fs.writeFileSync(path.join(fx.dir, `log.json.unreadable-${stamp}`), stamp);
  }
  fs.writeFileSync(path.join(fx.dir, 'log.json.unreadable-notes'), 'not a kept file');
  const file = openFile(fx);
  fs.writeFileSync(file.filePath, '{nope');
  assert.equal(file.load(), null);
  assert.deepEqual(file.setAside({ now: NOW }), { ok: true, keptName: KEPT });
  assert.deepEqual(keptOf(fx), ['log.json.unreadable-20200101000000002', 'log.json.unreadable-20200101000000003', KEPT,
    'log.json.unreadable-notes']);
  assert.equal(fs.readFileSync(path.join(fx.dir, KEPT), 'utf8'), '{nope', 'kept byte for byte');
  assert.equal(fs.existsSync(file.filePath), false);
  assert.deepEqual(file.load(), emptyLogDocument(4));
  assert.equal(file.persist(doc(seqs(1))), true);
  assert.deepEqual(fx.logs.map((entry) => [entry.level, entry.event, entry.fields]), [
    ['ERROR', 'test_log.rejected', { code: null, cause: 'content' }],
    ['ERROR', 'test_log.set_aside', { kept: 3 }],
  ]);
});

test('a rename that throws, or a kept name already taken, leaves everything as it was', (t) => {
  const fx = createFixture(t);
  const failing = openFile(fx, { renameFile() { throw Object.assign(new Error('held'), { code: 'EPERM' }); } });
  fs.writeFileSync(failing.filePath, '{nope');
  assert.equal(failing.load(), null);
  assert.deepEqual(failing.setAside({ now: NOW }), { ok: false, passing: true }, 'EPERM may clear');
  assert.equal(fs.readFileSync(failing.filePath, 'utf8'), '{nope');
  assert.deepEqual(keptOf(fx), []);
  assert.equal(failing.load(), null, 'still refused');
  assert.equal(failing.persist(doc(seqs(1))), false);
  assert.ok(fx.logs.some((entry) => entry.event === 'test_log.set_aside_failed' && entry.fields.code === 'EPERM'));

  fs.writeFileSync(path.join(fx.dir, KEPT), 'taken');
  const taken = openFile(fx);
  assert.equal(taken.load(), null);
  assert.equal(taken.setAside({ now: NOW }).ok, false);
  assert.equal(fs.readFileSync(path.join(fx.dir, KEPT), 'utf8'), 'taken');
  assert.equal(fs.readFileSync(taken.filePath, 'utf8'), '{nope');
});

test('a schema version this owner cannot have written is content unless it is a newer safe integer', (t) => {
  const fx = createFixture(t);
  for (const [name, version, refusal] of [
    ['string', '5', 'content'], ['float', 4.5, 'content'], ['missing', undefined, 'content'],
    ['unsafe', Number.MAX_SAFE_INTEGER + 2, 'content'], ['newer', 5, 'newer_schema'],
  ]) {
    const file = openFile(fx);
    fs.writeFileSync(file.filePath, JSON.stringify({ ...doc([]), schema_version: version }));
    assert.equal(file.load(), null, name);
    assert.equal(file.refusal(), refusal, name);
  }
});

test('the file just set aside is never pruned; a name of another width is not ours; a guarded name stays', (t) => {
  const fx = createFixture(t);
  const later = ['20261111133456789', '20261111143456789', '20261111153456789'];
  for (const stamp of later) fs.writeFileSync(path.join(fx.dir, `log.json.unreadable-${stamp}`), stamp);
  fs.writeFileSync(path.join(fx.dir, 'log.json.unreadable-9'), 'not ours');
  const file = openFile(fx, { assertSafePath: assertSafeFile });
  fs.writeFileSync(file.filePath, '{nope');
  assert.equal(file.load(), null);
  const moved = file.setAside({ now: NOW });
  assert.deepEqual(keptOf(fx), [KEPT, `log.json.unreadable-${later[1]}`, `log.json.unreadable-${later[2]}`,
    'log.json.unreadable-9'], 'the clock is an hour behind: the new file stays and the oldest other goes');
  assert.deepEqual(fx.logs.at(-1).fields, { kept: 3 });
  assert.deepEqual(moved, { ok: true, keptName: KEPT });

  const linked = path.join(fx.dir, KEPT);
  fs.linkSync(linked, path.join(fx.dir, 'elsewhere.bin'));
  fs.writeFileSync(file.filePath, '{nope');
  const again = openFile(fx, { assertSafePath: assertSafeFile });
  assert.equal(again.load(), null);
  assert.equal(again.setAside({ now: NOW + 1 }).ok, true);
  assert.ok(fs.existsSync(linked), 'the oldest other has a second name: the guard refuses it and it stays');
  assert.deepEqual(fx.logs.at(-1).fields, { kept: 4 }, 'and is counted');
});

test('a rename that landed and then threw counts as landed; a bad clock is a failed set-aside', (t) => {
  const fx = createFixture(t);
  const landed = openFile(fx, {
    renameFile(from, to) { fs.renameSync(from, to); throw Object.assign(new Error('sync'), { code: 'EIO' }); },
  });
  fs.writeFileSync(landed.filePath, '{nope');
  assert.equal(landed.load(), null);
  assert.deepEqual(landed.setAside({ now: NOW }), { ok: true, keptName: KEPT });
  assert.equal(fs.readFileSync(path.join(fx.dir, KEPT), 'utf8'), '{nope');
  assert.deepEqual(landed.load(), emptyLogDocument(4));
  assert.deepEqual(fx.logs.at(-1).fields, { kept: 1, directory_sync_failed: true });

  for (const now of [Number.NaN, Date.UTC(10000, 0, 1)]) {
    const file = openFile(fx);
    fs.writeFileSync(file.filePath, '{nope');
    assert.equal(file.load(), null);
    assert.deepEqual(file.setAside({ now }), { ok: false, passing: false }, String(now));
    assert.equal(fs.readFileSync(file.filePath, 'utf8'), '{nope');
    assert.equal(file.refusal(), 'content', 'still refused');
  }
});

test('renameDurable refuses a taken target and another directory, and leaves both files as they were', (t) => {
  const fx = createFixture(t);
  const from = path.join(fx.dir, 'a.json');
  const to = path.join(fx.dir, 'b.json');
  fs.writeFileSync(from, 'a');
  fs.writeFileSync(to, 'b');
  assert.throws(() => renameDurable(from, to), { code: 'EEXIST' });
  assert.deepEqual([fs.readFileSync(from, 'utf8'), fs.readFileSync(to, 'utf8')], ['a', 'b']);
  fs.mkdirSync(path.join(fx.dir, 'sub'));
  assert.throws(() => renameDurable(from, path.join(fx.dir, 'sub', 'c.json')), /rename_cross_directory/u);
  assert.equal(fs.readFileSync(from, 'utf8'), 'a');
  assert.equal(fs.existsSync(path.join(fx.dir, 'sub', 'c.json')), false);
});

test('3-4b: utcStamp is the one stamp: 17 UTC digits, null for a time that gives none', () => {
  assert.equal(utcStamp(Date.UTC(2026, 10, 12, 9, 30, 1, 7)), '20261112093001007');
  for (const bad of [Number.NaN, Infinity, 8.64e15 + 1, 'x', undefined]) assert.equal(utcStamp(bad), null, String(bad));
  assert.equal(utcStamp(Date.UTC(10000, 0, 1)), null, 'a six-digit year is not 17 digits');
});
