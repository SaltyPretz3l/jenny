const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAX_PRESERVED_COPIES,
  parsePreservedCorruptName,
  preserveCorruptFile,
} = require('../services/backend/corrupt-file-preserve');

function makeDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-corrupt-preserve-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a damaged file is moved aside with its bytes intact', (t) => {
  const root = makeDir(t);
  const filePath = path.join(root, 'shell-config.json');
  fs.writeFileSync(filePath, '{"language": "es", broken');
  const events = [];

  const result = preserveCorruptFile(filePath, {
    now: () => 1_760_000_000_000,
    logger: (level, event, data) => events.push({ level, event, data }),
  });

  assert.equal(result.preserved, true);
  assert.equal(result.preservedPath, `${filePath}.corrupt-1760000000000`);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.readFileSync(result.preservedPath, 'utf8'), '{"language": "es", broken');
  assert.deepEqual(events.map((entry) => entry.event), ['store.corrupt_file_preserved']);
  assert.equal(JSON.stringify(events).includes(root), false, 'the log carries names, never full paths');
});

test('a missing file reports nothing to preserve', (t) => {
  const root = makeDir(t);
  assert.deepEqual(
    preserveCorruptFile(path.join(root, 'absent.json')),
    { preserved: false, reason: 'missing' }
  );
});

test('a failed move leaves the damaged bytes in place and says so', (t) => {
  const root = makeDir(t);
  const filePath = path.join(root, 'secure-state.json');
  fs.writeFileSync(filePath, 'not json');
  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  t.after(() => { fs.renameSync = originalRename; });

  const result = preserveCorruptFile(filePath);

  assert.deepEqual(result, { preserved: false, reason: 'EACCES' });
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'not json');
});

test('a second damaged file in the same millisecond gets its own name', (t) => {
  const root = makeDir(t);
  const filePath = path.join(root, 'sessions.json');
  fs.writeFileSync(filePath, 'first');
  const first = preserveCorruptFile(filePath, { now: () => 1_760_000_000_000 });
  fs.writeFileSync(filePath, 'second');
  const second = preserveCorruptFile(filePath, { now: () => 1_760_000_000_000 });

  assert.notEqual(first.preservedPath, second.preservedPath);
  assert.equal(fs.readFileSync(first.preservedPath, 'utf8'), 'first');
  assert.equal(fs.readFileSync(second.preservedPath, 'utf8'), 'second');
});

test('only the newest preserved copies of one file are kept', (t) => {
  const root = makeDir(t);
  const filePath = path.join(root, 'shell-config.json');
  const neighbour = path.join(root, 'secure-state.json.corrupt-1700000000000');
  fs.writeFileSync(neighbour, 'other store');
  for (let index = 0; index < MAX_PRESERVED_COPIES + 2; index += 1) {
    fs.writeFileSync(filePath, `copy ${index}`);
    preserveCorruptFile(filePath, { now: () => 1_760_000_000_000 + index * 1000 });
  }

  const kept = fs.readdirSync(root).filter((name) => name.startsWith('shell-config.json.corrupt-')).sort();
  assert.equal(kept.length, MAX_PRESERVED_COPIES);
  assert.equal(fs.readFileSync(path.join(root, kept[kept.length - 1]), 'utf8'), `copy ${MAX_PRESERVED_COPIES + 1}`);
  assert.equal(fs.readFileSync(neighbour, 'utf8'), 'other store', 'another store\'s copies are never pruned');
});

test('preserved names parse back to their base file', () => {
  assert.deepEqual(
    parsePreservedCorruptName('shell-config.json.corrupt-1760000000000'),
    { baseName: 'shell-config.json', stampMs: 1_760_000_000_000 }
  );
  assert.equal(parsePreservedCorruptName('shell-config.json'), null);
  assert.equal(parsePreservedCorruptName('shell-config.json.corrupt-abc'), null);
});
