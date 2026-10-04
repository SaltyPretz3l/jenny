'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { DataLifecycleService } = require('../services/data-lifecycle/data-lifecycle-service');

for (const [encrypted, spooled] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`cancel destroys a stalled ${encrypted ? 'encrypted' : 'plain'} ${spooled ? 'spooled' : 'file'} entry and retires the operation`, async (t) => {
    fs.mkdirSync(path.join(__dirname, '..', '.tmp'), { recursive: true });
    const root = fs.mkdtempSync(path.join(__dirname, '..', '.tmp', 'mem-cancel-'));
    const profile = path.join(root, 'profile');
    const archives = path.join(root, 'archives');
    const sourcePath = path.join(profile, 'personality', 'default-workspace', 'stalled.bin');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    if (!spooled) fs.writeFileSync(sourcePath, 'unfinished file');
    let source;
    let destination;
    let spoolPath;
    let cleanupRetried = false;
    let announceStarted;
    const started = new Promise((resolve) => { announceStarted = resolve; });
    const originalRead = fs.createReadStream;
    const originalWrite = fs.createWriteStream;
    const originalRemove = fs.promises.rm;
    t.mock.method(fs.promises, 'rm', async (file, ...args) => {
      if (spooled && encrypted && !cleanupRetried && path.basename(String(file)).startsWith('.inventory-')) {
        cleanupRetried = true;
        throw Object.assign(new Error('temporary staging cleanup failure'), { code: 'EPERM' });
      }
      return originalRemove(file, ...args);
    });
    t.mock.method(fs, 'createReadStream', (file, ...args) => {
      if (spooled ? !String(file).includes('.inventory-') : String(file) !== sourcePath) return originalRead(file, ...args);
      if (spooled) spoolPath = String(file);
      source = new Readable({ read() {} });
      source.push(Buffer.from('partial'));
      return source;
    });
    t.mock.method(fs, 'createWriteStream', (file, ...args) => {
      const stream = originalWrite(file, ...args);
      if (source && !destination) {
        destination = stream;
        stream.once('open', announceStarted);
      }
      return stream;
    });
    const service = new DataLifecycleService({
      userDataPath: profile, documentsPath: path.join(root, 'documents'),
      sessionStore: spooled ? {
        listSessions: () => [{ id: 'sess_stalled' }],
        getSession: () => ({ id: 'sess_stalled', title: 'Keep this chat', messages: [] }),
      } : null,
    });
    let timeout;
    const operation = service.createArchive({ destinationRoot: archives, encrypted,
      passphrase: 'archive cancel passphrase', passphraseConfirmation: 'archive cancel passphrase' });
    try {
      await started;
      const operationId = service.activeOperation.id;
      assert.equal(service.cancel(operationId).status, 'cancel_requested');
      const result = await Promise.race([operation, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('cancel must interrupt the current file within 1 s')), 1000);
      })]);
      assert.equal(result.ok, false);
      assert.equal(result.error.reason, 'operation_cancelled');
      assert.equal(source.destroyed, true, 'stalled source must be destroyed');
      assert.equal(destination.destroyed, true, 'partial destination must be destroyed');
      assert.equal(service.activeOperation, null, 'cancelled operation must be retired');
      assert.deepEqual(fs.readdirSync(archives), [], 'partial archive must be removed');
      if (spooled) assert.equal(fs.existsSync(spoolPath), false, 'cancel must remove the current spool file');
      else assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'unfinished file');
      if (spooled && encrypted) assert.equal(cleanupRetried, true, 'outer partial cleanup must preserve cancellation and retry removal');
    } finally {
      clearTimeout(timeout);
      source?.destroy(new Error('test cleanup'));
      await operation;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
