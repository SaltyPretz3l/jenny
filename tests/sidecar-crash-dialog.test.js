const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readSidecarLogTail,
  showSidecarCrashDialog,
} = require('../services/sidecar-crash-dialog');

test('readSidecarLogTail reads from the end of the log without requiring readFileSync', () => {
  const lines = Array.from({ length: 200 }, (_entry, index) => `line-${index + 1}`);
  const content = `${lines.join('\n')}\n`;
  const source = Buffer.from(content, 'utf8');
  let closed = false;
  let readCalls = 0;

  const tail = readSidecarLogTail({
    homeDir: '/unused',
    maxLines: 3,
    fsImpl: {
      openSync(targetPath, flags) {
        assert.match(targetPath, /sidecar\.log$/);
        assert.equal(flags, 'r');
        return 99;
      },
      fstatSync(fd) {
        assert.equal(fd, 99);
        return { size: source.length };
      },
      readSync(fd, buffer, offset, length, position) {
        assert.equal(fd, 99);
        readCalls += 1;
        const slice = source.subarray(position, position + length);
        slice.copy(buffer, offset);
        return slice.length;
      },
      closeSync(fd) {
        assert.equal(fd, 99);
        closed = true;
      },
      readFileSync() {
        throw new Error('readFileSync should not be used for tail reads');
      },
    },
  });

  assert.equal(tail, 'line-198\nline-199\nline-200');
  assert.ok(readCalls >= 1);
  assert.equal(closed, true);
});

test('readSidecarLogTail preserves UTF-8 characters split across reverse-read chunks', () => {
  const source = Buffer.concat([Buffer.from('😀'), Buffer.alloc(4093, 0x61)]);
  const tail = readSidecarLogTail({
    homeDir: '/unused',
    maxLines: 1,
    fsImpl: {
      openSync() { return 99; },
      fstatSync() { return { size: source.length }; },
      readSync(_fd, buffer, offset, length, position) {
        const slice = source.subarray(position, position + length);
        slice.copy(buffer, offset);
        return slice.length;
      },
      closeSync() {},
    },
  });

  assert.equal(tail.codePointAt(0), 0x1f600);
  assert.equal(tail.includes('\ufffd'), false);
});

test('showSidecarCrashDialog includes normalized detail and tail output', async () => {
  let dialogPayload = null;

  await showSidecarCrashDialog({
    ownerWindow: { id: 'main' },
    detail: '',
    appVersion: '0.1.0',
    logTail: 'recent log line',
    dialogImpl: {
      async showMessageBox(ownerWindow, payload) {
        dialogPayload = { ownerWindow, payload };
      },
    },
  });

  assert.deepEqual(dialogPayload.ownerWindow, { id: 'main' });
  assert.equal(dialogPayload.payload.title, 'Jenny Background Runtime Stopped');
  assert.match(dialogPayload.payload.detail, /App version: 0\.1\.0/);
  assert.match(dialogPayload.payload.detail, /The sidecar exited without a detailed reason\./);
  assert.match(dialogPayload.payload.detail, /recent log line/);
});
