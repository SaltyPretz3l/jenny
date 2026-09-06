'use strict';

// Coverage for services/plugins/store/node-fs-facade.js -- the real-disk
// adapter behind the fs-facade contract.
//
// The load-bearing property here is PARITY, not "does the adapter work": every
// durability test in the plugin suite runs against createMemoryFsFacade, so a
// behavioural difference between the two facades would mean those tests prove
// something about a store that does not ship. Most cases below therefore run
// the SAME operation against both facades and assert the two agree -- on
// return values, on `error.code`, on `error.message`, and on `error.path`.

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FACADE_METHODS,
  createMemoryFsFacade,
} = require('../../../services/plugins/store/fs-facade');
const {
  createNodeFsFacade,
  resolveUnderRoot,
} = require('../../../services/plugins/store/node-fs-facade');

const createdRoots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-plugin-facade-'));
  createdRoots.push(root);
  return root;
}

function makeNodeFacade() {
  return createNodeFsFacade({ rootDir: makeRoot() });
}

after(() => {
  for (const root of createdRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Runs `body(facade)` against both implementations and returns both outcomes,
// where an outcome is either {ok:true,value} or {ok:false,code,message,path}.
async function bothFacades(body) {
  const results = [];
  for (const facade of [createMemoryFsFacade(), makeNodeFacade()]) {
    try {
      results.push({ ok: true, value: await body(facade) });
    } catch (error) {
      results.push({ ok: false, code: error.code, message: error.message, path: error.path });
    }
  }
  return { memory: results[0], node: results[1] };
}

describe('node-fs-facade conformance', () => {
  test('implements every method named by FACADE_METHODS', () => {
    const facade = makeNodeFacade();
    for (const method of FACADE_METHODS) {
      assert.equal(typeof facade[method], 'function', `${method} must be implemented`);
    }
  });

  test('exposes the same callCounts keys as the memory facade', () => {
    const memory = createMemoryFsFacade();
    const node = makeNodeFacade();
    assert.deepEqual(Object.keys(node.callCounts).sort(), Object.keys(memory.callCounts).sort());
  });

  test('rejects a relative or empty rootDir rather than resolving it silently', () => {
    assert.throws(() => createNodeFsFacade({ rootDir: 'relative/path' }), TypeError);
    assert.throws(() => createNodeFsFacade({}), TypeError);
  });
});

describe('node-fs-facade parity with the memory facade', () => {
  test('mkdir + writeFile + readFile round-trips identically', async () => {
    const { memory, node } = await bothFacades(async (facade) => {
      await facade.mkdir('generations/a');
      await facade.writeFile('generations/a/record.json', '{"x":1}');
      return facade.readFile('generations/a/record.json');
    });
    assert.deepEqual(memory, node);
    assert.equal(node.value, '{"x":1}');
  });

  test('writeFile + readFile with null encoding preserves arbitrary bytes on both facades', async () => {
    const archiveBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80]);
    const { memory, node } = await bothFacades(async (facade) => {
      await facade.mkdir('packages/a');
      await facade.writeFile('packages/a/blob', archiveBytes);
      return facade.readFile('packages/a/blob', null);
    });
    assert.deepEqual(memory, node);
    assert.equal(Buffer.isBuffer(node.value), true);
    assert.deepEqual(node.value, archiveBytes);
  });

  test('writeFile into a missing parent directory is ENOENT on both', async () => {
    const { memory, node } = await bothFacades((facade) =>
      facade.writeFile('missing/dir/file.json', 'x'));
    assert.equal(memory.ok, false);
    assert.deepEqual(memory, node);
    assert.equal(node.code, 'ENOENT');
    // The logical path, never the resolved absolute path -- a raw userData
    // path on an error object is a leak, not a diagnostic.
    assert.equal(node.path, 'missing/dir/file.json');
    assert.ok(!node.message.includes(os.tmpdir()));
  });

  test('readFile of a missing file is ENOENT on both, with the same message', async () => {
    const { memory, node } = await bothFacades((facade) => facade.readFile('nope.json'));
    assert.equal(memory.ok, false);
    assert.deepEqual(memory, node);
    assert.equal(node.code, 'ENOENT');
  });

  test('readFile of a DIRECTORY normalizes to the memory facade ENOENT', async () => {
    const { memory, node } = await bothFacades(async (facade) => {
      await facade.mkdir('adir');
      return facade.readFile('adir');
    });
    assert.equal(memory.ok, false);
    assert.deepEqual(memory, node);
    assert.equal(node.code, 'ENOENT');
  });

  test('fsyncFile requires the file to exist and is ENOENT otherwise', async () => {
    const { memory, node } = await bothFacades((facade) => facade.fsyncFile('ghost.json'));
    assert.equal(memory.ok, false);
    assert.deepEqual(memory, node);
    assert.equal(node.code, 'ENOENT');
  });

  test('fsyncFile on an existing file resolves on both', async () => {
    const { memory, node } = await bothFacades(async (facade) => {
      await facade.mkdir('d');
      await facade.writeFile('d/f.json', 'bytes');
      await facade.fsyncFile('d/f.json');
      return 'synced';
    });
    assert.deepEqual(memory, node);
    assert.equal(node.value, 'synced');
  });

  test('renameFile replaces an existing destination on both', async () => {
    const { memory, node } = await bothFacades(async (facade) => {
      await facade.mkdir('d');
      await facade.writeFile('d/old.json', 'new-bytes');
      await facade.writeFile('d/new.json', 'stale-bytes');
      await facade.renameFile('d/old.json', 'd/new.json');
      const survived = await facade.readFile('d/new.json');
      const listing = await facade.list('d');
      return { survived, listing };
    });
    assert.deepEqual(memory, node);
    assert.deepEqual(node.value, { survived: 'new-bytes', listing: ['new.json'] });
  });

  test('renameFile of a missing source is ENOENT reporting the SOURCE path', async () => {
    const { memory, node } = await bothFacades(async (facade) => {
      await facade.mkdir('d');
      return facade.renameFile('d/absent.json', 'd/target.json');
    });
    assert.equal(memory.ok, false);
    assert.deepEqual(memory, node);
    assert.equal(node.path, 'd/absent.json');
  });

  test('renameFile into a missing destination directory is ENOENT reporting the DEST path', async () => {
    const { memory, node } = await bothFacades(async (facade) => {
      await facade.mkdir('d');
      await facade.writeFile('d/src.json', 'x');
      return facade.renameFile('d/src.json', 'gone/target.json');
    });
    assert.equal(memory.ok, false);
    assert.deepEqual(memory, node);
    assert.equal(node.path, 'gone/target.json');
  });

  test('fsyncDir never throws, for a known or an unknown directory', async () => {
    const { memory, node } = await bothFacades(async (facade) => {
      await facade.mkdir('present');
      await facade.fsyncDir('present');
      await facade.fsyncDir('never/created');
      return 'no-throw';
    });
    assert.deepEqual(memory, node);
    assert.equal(node.value, 'no-throw');
  });

  test('list returns sorted child names, and [] for an absent or file path', async () => {
    const { memory, node } = await bothFacades(async (facade) => {
      await facade.mkdir('d');
      await facade.writeFile('d/b.json', '1');
      await facade.writeFile('d/a.json', '1');
      await facade.mkdir('d/sub');
      return {
        children: await facade.list('d'),
        absent: await facade.list('not/here'),
        onAFile: await facade.list('d/a.json'),
      };
    });
    assert.deepEqual(memory, node);
    assert.deepEqual(node.value.children, ['a.json', 'b.json', 'sub']);
    assert.deepEqual(node.value.absent, []);
    assert.deepEqual(node.value.onAFile, []);
  });

  test('remove is idempotent for an absent path and EISDIR for a directory', async () => {
    const { memory, node } = await bothFacades(async (facade) => {
      await facade.mkdir('d');
      await facade.remove('d/never-existed.json');
      return 'idempotent';
    });
    assert.deepEqual(memory, node);

    const directoryCase = await bothFacades(async (facade) => {
      await facade.mkdir('d');
      return facade.remove('d');
    });
    assert.equal(directoryCase.memory.ok, false);
    assert.deepEqual(directoryCase.memory, directoryCase.node);
    assert.equal(directoryCase.node.code, 'EISDIR');
  });

  test('removeTree recursively removes only the named directory and is idempotent', async () => {
    const { memory, node } = await bothFacades(async (facade) => {
      await facade.mkdir('data/plugin/settings/nested');
      await facade.writeFile('data/plugin/settings/value.json', '1');
      await facade.writeFile('data/plugin/settings/nested/value.json', '2');
      await facade.mkdir('data/plugin/keep');
      await facade.writeFile('data/plugin/keep/value.json', '3');
      await facade.removeTree('data/plugin/settings');
      await facade.removeTree('data/plugin/settings');
      return {
        removed: await facade.stat('data/plugin/settings'),
        retained: await facade.readFile('data/plugin/keep/value.json'),
      };
    });
    assert.deepEqual(memory, node);
    assert.deepEqual(node.value.removed, {
      exists: false, isFile: false, isDirectory: false, size: 0,
    });
    assert.equal(node.value.retained, '3');
  });

  test('removeTree refuses the facade root', async () => {
    const { memory, node } = await bothFacades((facade) => facade.removeTree(''));
    assert.equal(memory.ok, false);
    assert.deepEqual(memory, node);
  });

  test('stat reports files, directories, and absence identically', async () => {
    const { memory, node } = await bothFacades(async (facade) => {
      await facade.mkdir('d');
      await facade.writeFile('d/f.json', 'hello');
      return {
        file: await facade.stat('d/f.json'),
        dir: await facade.stat('d'),
        absent: await facade.stat('d/none'),
      };
    });
    assert.deepEqual(memory, node);
    assert.deepEqual(node.value.file, { exists: true, isFile: true, isDirectory: false, size: 5 });
    assert.deepEqual(node.value.dir, { exists: true, isFile: false, isDirectory: true, size: 0 });
    assert.deepEqual(node.value.absent, { exists: false, isFile: false, isDirectory: false, size: 0 });
  });

  test('every facade method increments its own call counter', async () => {
    const facade = makeNodeFacade();
    await facade.mkdir('d');
    await facade.writeFile('d/f.json', 'x');
    await facade.readFile('d/f.json');
    await facade.fsyncFile('d/f.json');
    await facade.renameFile('d/f.json', 'd/g.json');
    await facade.fsyncDir('d');
    await facade.list('d');
    await facade.stat('d/g.json');
    await facade.remove('d/g.json');
    await facade.removeTree('d');
    for (const [method, count] of Object.entries(facade.callCounts)) {
      assert.equal(count, 1, `${method} should have been counted exactly once`);
    }
  });
});

describe('node-fs-facade root containment', () => {
  test('constructing or reading an absent root does not create it', async () => {
    const parent = makeRoot();
    const root = path.join(parent, 'plugins-not-created-yet');
    const facade = createNodeFsFacade({ rootDir: root });

    assert.equal(fs.existsSync(root), false);
    assert.deepEqual(await facade.list('operations'), []);
    assert.deepEqual(await facade.stat('active-generation.json'), {
      exists: false,
      isFile: false,
      isDirectory: false,
      size: 0,
    });
    assert.equal(fs.existsSync(root), false);

    await facade.mkdir('operations');
    assert.equal(fs.statSync(root).isDirectory(), true);
  });

  test('resolveUnderRoot refuses a path that climbs out of the root', () => {
    const root = process.platform === 'win32' ? 'C:\\root' : '/root';
    assert.equal(resolveUnderRoot(root, 'a/b'), path.resolve(root, 'a/b'));
    assert.equal(resolveUnderRoot(root, ''), root);
    assert.throws(() => resolveUnderRoot(root, '../escape'), /ERR_PATH_ESCAPES_ROOT/);
    assert.throws(() => resolveUnderRoot(root, 'a/../../escape'), /ERR_PATH_ESCAPES_ROOT/);
  });

  test('an escaping write is refused and never reaches the real disk', async () => {
    const root = makeRoot();
    const facade = createNodeFsFacade({ rootDir: root });
    await assert.rejects(() => facade.writeFile('../outside.json', 'x'), /ERR_PATH_ESCAPES_ROOT/);
    assert.equal(fs.existsSync(path.join(path.dirname(root), 'outside.json')), false);
  });

  test('a linked parent cannot redirect store writes outside the anchored root', async () => {
    const root = makeRoot();
    const outside = makeRoot();
    const facade = createNodeFsFacade({ rootDir: root });
    fs.symlinkSync(outside, path.join(root, 'packages'), process.platform === 'win32' ? 'junction' : 'dir');

    await assert.rejects(
      () => facade.mkdir('packages/aaaaaaaa'),
      (error) => error?.code === 'ERR_PATH_REPARSE_POINT'
    );
    await assert.rejects(
      () => facade.writeFile('packages/escape.json', 'x'),
      (error) => error?.code === 'ERR_PATH_REPARSE_POINT'
    );
    assert.equal(fs.existsSync(path.join(outside, 'escape.json')), false);
  });

  test('stat never throws, even for an escaping path', async () => {
    const facade = makeNodeFacade();
    assert.deepEqual(await facade.stat('../../etc/passwd'), {
      exists: false,
      isFile: false,
      isDirectory: false,
      size: 0,
    });
  });
});

describe('node-fs-facade directory fsync degradation', () => {
  test('reports the platform posture explicitly instead of claiming success', async () => {
    const notices = [];
    const root = makeRoot();
    const facade = createNodeFsFacade({
      rootDir: root,
      log: (level, event, fields) => notices.push({ level, event, fields }),
    });
    assert.deepEqual(facade.directoryFsyncReport(), {
      attempted: 0,
      succeeded: 0,
      degraded: 0,
      lastCode: null,
      supported: null,
    });

    await facade.mkdir('d');
    await facade.fsyncDir('d');
    const report = facade.directoryFsyncReport();
    assert.equal(report.attempted, 1);
    // Either outcome is legitimate -- POSIX flushes, Windows cannot -- but the
    // facade must never report both zero degradations and zero successes, which
    // is what a silently swallowed fsync would look like.
    assert.equal(report.succeeded + report.degraded, 1);
    assert.equal(report.supported, report.degraded === 0);
    const degradationNotices = notices.filter((n) => n.event === 'plugins.directory_fsync_unsupported');
    assert.equal(degradationNotices.length, report.degraded === 0 ? 0 : 1);
  });

  test('degradation is logged at most once but counted every time', async () => {
    const notices = [];
    const facade = createNodeFsFacade({
      rootDir: makeRoot(),
      log: (_level, event) => {
        if (event === 'plugins.directory_fsync_unsupported') notices.push(event);
      },
    });
    // An absent directory always degrades on every platform.
    await facade.fsyncDir('never/created');
    await facade.fsyncDir('never/created');
    const report = facade.directoryFsyncReport();
    assert.equal(report.degraded, 2);
    assert.equal(report.supported, false);
    assert.equal(notices.length, 1);
  });

  test('scopes degradation severity to the expected Windows EPERM signature', () => {
    const epermNotices = [];
    const epermFacade = createNodeFsFacade({
      rootDir: makeRoot(),
      log: (level, event, fields) => epermNotices.push({ level, event, fields }),
    });
    epermFacade._recordDirFsyncDegradation('EPERM');
    assert.equal(epermNotices.length, 1);
    assert.equal(epermNotices[0].level, process.platform === 'win32' ? 'INFO' : 'WARN');

    const otherNotices = [];
    const otherFacade = createNodeFsFacade({
      rootDir: makeRoot(),
      log: (level, event, fields) => otherNotices.push({ level, event, fields }),
    });
    otherFacade._recordDirFsyncDegradation('EACCES');
    assert.equal(otherNotices.length, 1);
    assert.equal(otherNotices[0].level, 'WARN');
  });
});
