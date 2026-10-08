'use strict';

// Row 34 S5 step 4: main-process-only, byte-exact recovery IO on the
// WorkspaceIdeService. It reuses the service's root lease, lexical path guard,
// realpath containment and atomic temp+rename write, so these tests pin the
// containment (dot-dot, absolute, symlink/junction escape) and the
// compare-then-write contract the safety copies rely on.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const { WorkspaceIdeService } = require('../services/workspace-ide-service');
const { WORKSPACE_FS_ERROR_CODES } = require('../services/workspace-ide-errors');
const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');
const { MISSING_STATE, sha256Bytes } = require('../services/workspace-recovery-safety-copies');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

const BYTES = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x0d, 0x0a, 0x80, 0x41]);

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createService(root, { trashItemImpl = null } = {}) {
  const coordinator = new WorkspaceRootCoordinator({
    initialRootPath: root,
    normalizeRootPath: (value) => String(value || ''),
    rootIdFactory: (value) => (value ? `root:${String(value).toLowerCase()}` : null),
  });
  return new WorkspaceIdeService({
    configService: {
      getToolsWorkspaceRoot: () => root,
      getWorkspaceRootStatus: () => ({ state: 'ready', message: '' }),
    },
    rootContextProvider: () => coordinator,
    trashItemImpl,
  });
}

async function withOperation(service, kind, callback) {
  const operation = await service.acquireRootOperation({ kind });
  try {
    return await callback(operation);
  } finally {
    operation.release();
  }
}

describe('readFileBytesForRecovery', () => {
  test('reads exact bytes and classifies missing, directories and caps', async () => {
    const root = createTrackedTempDir('jenny-recovery-io-');
    await fs.mkdir(path.join(root, 'dir'));
    await fs.writeFile(path.join(root, 'dir', 'bin.dat'), BYTES);
    const service = createService(root);
    await withOperation(service, 'read', async (operation) => {
      const file = await service.readFileBytesForRecovery({ path: 'dir/bin.dat', maxBytes: 64 }, operation);
      assert.equal(file.kind, 'file');
      assert.deepEqual(file.bytes, BYTES);
      assert.equal(file.size, BYTES.length);
      assert.equal(typeof file.mtimeMs, 'number');
      const capped = await service.readFileBytesForRecovery({ path: 'dir/bin.dat', maxBytes: 4 }, operation);
      assert.deepEqual([capped.kind, capped.bytes, capped.reason], ['file', null, 'too_large']);
      const missing = await service.readFileBytesForRecovery({ path: 'no/such/file.txt', maxBytes: 64 }, operation);
      assert.equal(missing.kind, 'missing');
      const dir = await service.readFileBytesForRecovery({ path: 'dir', maxBytes: 64 }, operation);
      assert.equal(dir.kind, 'directory');
      assert.deepEqual(service.recoveryBinding(operation), service.recoveryBinding(operation));
      assert.match(service.recoveryBinding(operation).rootId, /^root:/);
    });
  });

  test('dot-dot, absolute, drive and UNC paths are refused lexically', async () => {
    const root = createTrackedTempDir('jenny-recovery-io-');
    const service = createService(root);
    await withOperation(service, 'read', async (operation) => {
      for (const bad of ['../x.txt', '/etc/passwd', 'C:/x.txt', '\\\\server\\share\\x', 'a/../../x', 'nul\u0000.txt']) {
        await assert.rejects(
          service.readFileBytesForRecovery({ path: bad, maxBytes: 64 }, operation),
          { code: WORKSPACE_FS_ERROR_CODES.PATH_INVALID },
          bad,
        );
      }
    });
  });
});

describe('writeFileBytesForRecovery / trashFileForRecovery', () => {
  test('writes byte-exactly (parents created) only when the current state matches', async () => {
    const root = createTrackedTempDir('jenny-recovery-io-');
    await fs.writeFile(path.join(root, 'a.txt'), 'current\n');
    const service = createService(root);
    await withOperation(service, 'mutation', async (operation) => {
      const refused = await service.writeFileBytesForRecovery({
        path: 'a.txt', bytes: BYTES, expectedState: sha256Bytes(Buffer.from('something else')), maxBytes: 64,
      }, operation);
      assert.deepEqual([refused.written, refused.reason], [false, 'changed_since']);
      assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'current\n');

      const written = await service.writeFileBytesForRecovery({
        path: 'a.txt', bytes: BYTES, expectedState: sha256Bytes(Buffer.from('current\n')), maxBytes: 64,
      }, operation);
      assert.equal(written.written, true);
      assert.deepEqual(written.before.bytes, Buffer.from('current\n'), 'the pre-write state is handed back for the reverse copy');
      assert.deepEqual(await fs.readFile(path.join(root, 'a.txt')), BYTES);

      const created = await service.writeFileBytesForRecovery({
        path: 'new/deep/b.bin', bytes: BYTES, expectedState: MISSING_STATE, maxBytes: 64,
      }, operation);
      assert.equal(created.written, true);
      assert.equal(created.before.kind, 'missing');
      assert.deepEqual(await fs.readFile(path.join(root, 'new', 'deep', 'b.bin')), BYTES);
    });
    const leftovers = (await fs.readdir(root)).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'no temp files are left behind');
  });

  test('trash moves a matching file through the injected bin and refuses without one', async () => {
    const root = createTrackedTempDir('jenny-recovery-io-');
    await fs.writeFile(path.join(root, 'gone.txt'), 'bye\n');
    const trashed = [];
    const service = createService(root, { trashItemImpl: async (target) => { trashed.push(target); await fs.rm(target); } });
    const noBin = createService(root);
    const expectedState = sha256Bytes(Buffer.from('bye\n'));
    await withOperation(noBin, 'mutation', async (operation) => {
      const refused = await noBin.trashFileForRecovery({ path: 'gone.txt', expectedState, maxBytes: 64 }, operation);
      assert.deepEqual([refused.trashed, refused.reason], [false, 'trash_unavailable']);
    });
    await withOperation(service, 'mutation', async (operation) => {
      const result = await service.trashFileForRecovery({ path: 'gone.txt', expectedState, maxBytes: 64 }, operation);
      assert.equal(result.trashed, true);
    });
    assert.equal(trashed.length, 1);
    assert.equal(path.basename(trashed[0]), 'gone.txt');
  });

  test('a symlink or junction escape is refused for reads and writes', async () => {
    const root = createTrackedTempDir('jenny-recovery-io-');
    const outside = createTrackedTempDir('jenny-recovery-io-outside-');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret\n');
    fsSync.symlinkSync(outside, path.join(root, 'linkdir'), process.platform === 'win32' ? 'junction' : 'dir');
    const service = createService(root);
    await withOperation(service, 'mutation', async (operation) => {
      await assert.rejects(
        service.readFileBytesForRecovery({ path: 'linkdir/secret.txt', maxBytes: 64 }, operation),
        { code: WORKSPACE_FS_ERROR_CODES.PATH_OUTSIDE_ROOT },
      );
      await assert.rejects(
        service.writeFileBytesForRecovery({ path: 'linkdir/new.txt', bytes: BYTES, expectedState: MISSING_STATE, maxBytes: 64 }, operation),
        { code: WORKSPACE_FS_ERROR_CODES.PATH_OUTSIDE_ROOT },
      );
      const link = await service.readFileBytesForRecovery({ path: 'linkdir', maxBytes: 64 }, operation);
      assert.equal(link.kind, 'symlink', 'a link leaf is never followed');
    });
    assert.deepEqual(await fs.readdir(outside), ['secret.txt']);
  });

  test('the text writeFile path still saves through the shared atomic writer', async () => {
    const root = createTrackedTempDir('jenny-recovery-io-');
    const service = createService(root);
    const saved = await service.writeFile({ path: 'notes/today.md', content: 'line\r\n' });
    assert.equal(saved.path, 'notes/today.md');
    assert.equal(await fs.readFile(path.join(root, 'notes', 'today.md'), 'utf8'), 'line\r\n');
  });
});
