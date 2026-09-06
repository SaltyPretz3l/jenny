const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  JOURNAL_SCHEMA_VERSION,
  TurnEventJournal,
} = require('../services/backend/turn-event-journal');

const trackedDirectories = [];

test.after(() => {
  for (const directory of trackedDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function freshPath(prefix = 'jenny-turn-journal-v2-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedDirectories.push(directory);
  return path.join(directory, 'turn-event-journal.json');
}

function partitionFiles(journalPath) {
  const root = `${journalPath}.journal${path.sep}v2`;
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => fs.readdirSync(path.join(root, entry.name))
      .filter((name) => name.endsWith('.ndjson'))
      .map((name) => path.join(root, entry.name, name)));
}

test('journal v2 appends only hashed target partitions and dedupes after restart', () => {
  const journalPath = freshPath();
  let journal = new TurnEventJournal(journalPath);
  journal.append('session/one', 'turn/one', [{ event_id: 'event-1', kind: 'chat_token' }]);
  journal.append('session/one', 'turn/two', [{ event_id: 'event-2', kind: 'chat_done' }]);
  journal.flush();

  const files = partitionFiles(journalPath);
  assert.equal(files.length, 2);
  assert.equal(files.some((file) => file.includes('session/one') || file.includes('turn/one')), false);

  journal = new TurnEventJournal(journalPath);
  assert.equal(journal.append('session/one', 'turn/one', [{ event_id: 'event-1' }]).appended, 0);
  assert.deepEqual(journal.list('session/one', 'turn/one').map((event) => event.event_id), ['event-1']);
});

test('journal v2 compacts only the affected turn partition', () => {
  const journalPath = freshPath();
  const journal = new TurnEventJournal(journalPath, { compactionRecordLimit: 3 });
  journal.append('session-a', 'turn-a', [{ event_id: 'a1' }]);
  journal.append('session-b', 'turn-b', [{ event_id: 'b1' }]);
  const files = partitionFiles(journalPath);
  const fileByIdentity = new Map(files.map((file) => {
    const first = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n')[0]);
    return [`${first.session_id}:${first.turn_id}`, file];
  }));
  const untouchedBefore = fs.readFileSync(fileByIdentity.get('session-b:turn-b'), 'utf8');
  journal.append('session-a', 'turn-a', [{ event_id: 'a2' }]);
  journal.append('session-a', 'turn-a', [{ event_id: 'a3' }]);

  const compactedLines = fs.readFileSync(fileByIdentity.get('session-a:turn-a'), 'utf8').trim().split('\n');
  assert.equal(compactedLines.length, 1);
  assert.equal(JSON.parse(compactedLines[0]).op, 'snapshot');
  assert.equal(fs.readFileSync(fileByIdentity.get('session-b:turn-b'), 'utf8'), untouchedBefore);
});

test('journal v2 migrates legacy schema once and retires the source after durable import', () => {
  const journalPath = freshPath();
  fs.writeFileSync(journalPath, JSON.stringify({
    schema_version: 1,
    sessions: {
      legacy_session: {
        turns: {
          legacy_turn: [{ event_id: 'legacy-event', kind: 'chat_done' }],
        },
      },
    },
  }));

  let journal = new TurnEventJournal(journalPath);
  assert.equal(JOURNAL_SCHEMA_VERSION, 2);
  assert.deepEqual(journal.list('legacy_session', 'legacy_turn').map((event) => event.event_id), ['legacy-event']);
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(fs.existsSync(`${journalPath}.v1.migrated`), true);

  journal = new TurnEventJournal(journalPath);
  assert.deepEqual(journal.list('legacy_session', 'legacy_turn').map((event) => event.event_id), ['legacy-event']);
});

test('journal v2 recovers a crash-truncated final line but blocks a corrupt complete record', () => {
  const journalPath = freshPath();
  let journal = new TurnEventJournal(journalPath);
  journal.append('session-corrupt', 'turn-corrupt', [{ event_id: 'good' }]);
  journal.flush();
  const [partition] = partitionFiles(journalPath);
  fs.appendFileSync(partition, '{"schema_version":2');

  journal = new TurnEventJournal(journalPath);
  assert.deepEqual(journal.list('session-corrupt', 'turn-corrupt').map((event) => event.event_id), ['good']);
  journal.append('session-corrupt', 'turn-corrupt', [{ event_id: 'after-tail' }]);

  fs.appendFileSync(partition, '\nnot-json\n');
  journal = new TurnEventJournal(journalPath);
  assert.throws(
    () => journal.append('session-corrupt', 'turn-corrupt', [{ event_id: 'blocked' }]),
    /blocked pending recovery/
  );
});

test('journal v2 blocks storage when a corrupt partition has no recoverable identity', () => {
  const journalPath = freshPath();
  let journal = new TurnEventJournal(journalPath);
  journal.append('session-corrupt', 'turn-corrupt', [{ event_id: 'good' }]);
  journal.flush();
  const [partition] = partitionFiles(journalPath);
  fs.writeFileSync(partition, 'not-json\n');

  journal = new TurnEventJournal(journalPath);
  assert.throws(
    () => journal.append('session-corrupt', 'turn-corrupt', [{ event_id: 'must-not-vanish' }]),
    /storage is blocked pending recovery/
  );
});

test('journal v2 blocks all writes when startup partition metadata is unreadable', () => {
  const journalPath = freshPath();
  let journal = new TurnEventJournal(journalPath);
  journal.append('session-stat', 'turn-stat', [{ event_id: 'good' }]);
  journal.flush();
  const [partition] = partitionFiles(journalPath);
  const originalStatSync = fs.statSync;
  fs.statSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(partition)) {
      const error = new Error('stat refused');
      error.code = 'EACCES';
      throw error;
    }
    return originalStatSync(target, ...args);
  };
  try {
    journal = new TurnEventJournal(journalPath);
  } finally {
    fs.statSync = originalStatSync;
  }

  assert.throws(
    () => journal.append('other-session', 'other-turn', [{ event_id: 'must-not-write' }]),
    /storage is blocked pending recovery/
  );
});

test('journal v2 preserves and blocks a partially malformed legacy source', () => {
  const journalPath = freshPath();
  fs.writeFileSync(journalPath, JSON.stringify({
    schema_version: 1,
    sessions: {
      malformed: { turns: { turn_bad: [{ event_id: 'good' }, 'not-an-event'] } },
    },
  }));
  const journal = new TurnEventJournal(journalPath);
  assert.equal(fs.existsSync(journalPath), true);
  assert.equal(fs.existsSync(`${journalPath}.v1.migrated`), false);
  assert.throws(
    () => journal.append('malformed', 'turn_bad', [{ event_id: 'later' }]),
    /blocked pending recovery/
  );
});

test('journal v2 rejects an oversized legacy source before parsing it', () => {
  const journalPath = freshPath();
  const logs = [];
  fs.writeFileSync(journalPath, JSON.stringify({
    schema_version: 1,
    sessions: { legacy: { turns: { turn: [{ event_id: 'x'.repeat(128) }] } } },
  }));

  const journal = new TurnEventJournal(journalPath, {
    maxStartupBytes: 32,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  assert.equal(fs.existsSync(journalPath), true);
  assert.equal(logs.some((entry) => (
    entry.event === 'turn_journal.legacy_migration_blocked'
    && entry.details.reason === 'source_too_large'
  )), true);
  assert.throws(
    () => journal.append('legacy', 'turn', [{ event_id: 'later' }]),
    /storage is blocked pending recovery/
  );
});

test('journal v2 rejects a partition whose hashed path does not match its identity', () => {
  const journalPath = freshPath();
  let journal = new TurnEventJournal(journalPath);
  journal.append('session-path', 'turn-path', [{ event_id: 'event-path' }]);
  journal.flush();
  const [partition] = partitionFiles(journalPath);
  const misplaced = path.join(path.dirname(partition), `${'f'.repeat(64)}.ndjson`);
  fs.renameSync(partition, misplaced);

  journal = new TurnEventJournal(journalPath);
  assert.deepEqual(journal.list('session-path', 'turn-path'), []);
  assert.throws(
    () => journal.append('session-path', 'turn-path', [{ event_id: 'later' }]),
    /partition is blocked pending recovery/
  );
});

test('journal v2 recovers orphan partitions when the completion manifest is missing', () => {
  const journalPath = freshPath();
  let journal = new TurnEventJournal(journalPath);
  journal.append('orphan-session', 'orphan-turn', [{ event_id: 'orphan-event' }]);
  journal.flush();
  fs.unlinkSync(`${journalPath}.journal${path.sep}v2${path.sep}manifest.json`);

  journal = new TurnEventJournal(journalPath);
  assert.deepEqual(journal.list('orphan-session', 'orphan-turn').map((event) => event.event_id), ['orphan-event']);
});

test('journal v2 fails closed at configured startup and per-turn bounds', () => {
  const journalPath = freshPath();
  let journal = new TurnEventJournal(journalPath, { maxEventsPerTurn: 1 });
  journal.append('bounded', 'turn', [{ event_id: 'one' }]);
  assert.throws(
    () => journal.append('bounded', 'turn', [{ event_id: 'two' }]),
    /event limit/
  );
  journal.flush();

  journal = new TurnEventJournal(journalPath, { maxStartupBytes: 1 });
  assert.throws(
    () => journal.append('bounded', 'other', [{ event_id: 'blocked' }]),
    /blocked pending recovery/
  );
});

test('journal v2 enforces partition-count and aggregate-byte bounds while running', () => {
  const partitionBoundPath = freshPath();
  let journal = new TurnEventJournal(partitionBoundPath, { maxPartitions: 1 });
  journal.append('bounded', 'turn-one', [{ event_id: 'one' }]);
  assert.throws(
    () => journal.append('bounded', 'turn-two', [{ event_id: 'two' }]),
    /runtime partition count limit/
  );
  assert.deepEqual(journal.list('bounded', 'turn-two'), []);

  const aggregateBoundPath = freshPath();
  journal = new TurnEventJournal(aggregateBoundPath, { maxStartupBytes: 256 });
  assert.throws(
    () => journal.append('bounded', 'turn', [{ event_id: 'large', text: 'x'.repeat(512) }]),
    /runtime aggregate byte limit/
  );
  assert.deepEqual(journal.list('bounded', 'turn'), []);
});

test('journal v2 reclaims cleared partitions and restores capacity across restart', () => {
  const journalPath = freshPath();
  const proof = {
    ok: true, applied: true, durable: true, reason: null,
    commitEpoch: 1, dirtyEpoch: 1, durableEpoch: 1, value: null,
  };
  let journal = new TurnEventJournal(journalPath, { maxPartitions: 1 });
  journal.append('bounded', 'turn-one', [{ event_id: 'one' }]);

  assert.deepEqual(journal.clear('bounded', 'turn-one', { commitResult: proof }), {
    ok: true, cleared: true, durable: true, reason: null,
  });
  assert.equal(partitionFiles(journalPath).length, 0);
  journal.append('bounded', 'turn-two', [{ event_id: 'two' }]);

  journal = new TurnEventJournal(journalPath, { maxPartitions: 1 });
  assert.deepEqual(journal.list('bounded', 'turn-one'), []);
  assert.deepEqual(journal.list('bounded', 'turn-two').map((event) => event.event_id), ['two']);
});

test('journal v2 restores a cleared partition when durable deletion fails', () => {
  const journalPath = freshPath();
  const proof = {
    ok: true, applied: true, durable: true, reason: null,
    commitEpoch: 1, dirtyEpoch: 1, durableEpoch: 1, value: null,
  };
  const journal = new TurnEventJournal(journalPath, { maxPartitions: 1 });
  journal.append('bounded', 'turn-one', [{ event_id: 'one' }]);
  const originalFsyncDirectory = journal._fsyncDirectory.bind(journal);
  let fsyncCalls = 0;
  journal._fsyncDirectory = (directoryPath) => {
    fsyncCalls += 1;
    if (fsyncCalls === 1) throw new Error('directory fsync failed');
    return originalFsyncDirectory(directoryPath);
  };

  assert.deepEqual(journal.clear('bounded', 'turn-one', { commitResult: proof }), {
    ok: false, cleared: true, durable: false, reason: 'journal_write_failed',
  });
  assert.deepEqual(journal.list('bounded', 'turn-one').map((event) => event.event_id), ['one']);
  assert.equal(partitionFiles(journalPath).length, 1);
  assert.throws(
    () => journal.append('bounded', 'turn-two', [{ event_id: 'two' }]),
    /runtime partition count limit/
  );
});

test('journal v2 reclaims legacy clear-record partitions during startup', () => {
  const journalPath = freshPath();
  let journal = new TurnEventJournal(journalPath, { maxPartitions: 1 });
  journal.append('bounded', 'turn-one', [{ event_id: 'one' }]);
  journal.flush();
  const [partition] = partitionFiles(journalPath);
  fs.appendFileSync(partition, `${JSON.stringify({
    schema_version: 2,
    session_id: 'bounded',
    turn_id: 'turn-one',
    op: 'clear',
  })}\n`);

  journal = new TurnEventJournal(journalPath, { maxPartitions: 1 });
  assert.equal(partitionFiles(journalPath).length, 0);
  journal.append('bounded', 'turn-two', [{ event_id: 'two' }]);
  assert.deepEqual(journal.list('bounded', 'turn-two').map((event) => event.event_id), ['two']);
});

// append() merges against the stored array by reference rather than deep-cloning
// the whole turn per event. These pin the two isolation boundaries that keeps
// safe, so the optimization cannot be undone by a later in-place mutation.
test('journal v2 isolates stored events from caller-supplied event objects', () => {
  const journal = new TurnEventJournal(freshPath());
  const source = { event_id: 'mut-1', kind: 'tool_result', payload: { text: 'original' } };
  journal.append('sess-iso', 'turn-iso', [source]);

  source.kind = 'mutated';
  source.payload.text = 'mutated';

  const [stored] = journal.list('sess-iso', 'turn-iso');
  assert.equal(stored.kind, 'tool_result');
  assert.equal(stored.payload.text, 'original');
});

// listSession() is the scoped counterpart to listAll(): the hot chat.send path
// (interrupted-turn-receipts.js) only ever needs one session's partitions, so
// it must not pay for a deep clone of every other session on every call.
test('journal v2 listSession scopes to one session and matches listAll()[sessionId] exactly', () => {
  const journal = new TurnEventJournal(freshPath());
  journal.append('session-a', 'turn-a1', [{ event_id: 'a1-e1' }]);
  journal.append('session-a', 'turn-a2', [{ event_id: 'a2-e1' }]);
  journal.append('session-b', 'turn-b1', [{ event_id: 'b1-e1' }]);

  const scoped = journal.listSession('session-a');
  assert.deepEqual(Object.keys(scoped.turns).sort(), ['turn-a1', 'turn-a2']);
  assert.deepEqual(scoped.turns['turn-a1'].map((event) => event.event_id), ['a1-e1']);
  assert.equal('session-b' in scoped, false);
  assert.deepEqual(scoped, journal.listAll()['session-a']);
});

test('journal v2 listSession clones are mutation-safe like listAll()', () => {
  const journal = new TurnEventJournal(freshPath());
  journal.append('session-mut', 'turn-mut', [{ event_id: 'e1', payload: { text: 'original' } }]);

  const scoped = journal.listSession('session-mut');
  scoped.turns['turn-mut'][0].payload.text = 'mutated';
  scoped.turns['turn-mut'].push({ event_id: 'injected' });

  assert.deepEqual(
    journal.list('session-mut', 'turn-mut').map((event) => event.event_id),
    ['e1']
  );
  assert.equal(journal.list('session-mut', 'turn-mut')[0].payload.text, 'original');
});

test('journal v2 listSession returns an empty object for an unknown or empty session', () => {
  const journal = new TurnEventJournal(freshPath());
  assert.deepEqual(journal.listSession('never-appended'), {});

  journal.append('session-cleared', 'turn-cleared', [{ event_id: 'e1' }]);
  const proof = {
    ok: true, applied: true, durable: true, reason: null,
    commitEpoch: 1, dirtyEpoch: 1, durableEpoch: 1, value: null,
  };
  journal.clear('session-cleared', 'turn-cleared', { commitResult: proof });
  assert.deepEqual(journal.listSession('session-cleared'), {});
});

test('journal v2 isolates stored events from mutations made to list() results', () => {
  const journal = new TurnEventJournal(freshPath());
  journal.append('sess-iso', 'turn-iso', [{ event_id: 'mut-2', payload: { text: 'original' } }]);

  const listed = journal.list('sess-iso', 'turn-iso');
  listed[0].payload.text = 'mutated';
  listed.push({ event_id: 'injected' });

  // A second append must merge against pristine storage, not the mutated view.
  journal.append('sess-iso', 'turn-iso', [{ event_id: 'mut-3' }]);
  const after = journal.list('sess-iso', 'turn-iso');
  assert.deepEqual(after.map((event) => event.event_id), ['mut-2', 'mut-3']);
  assert.equal(after[0].payload.text, 'original');
});
