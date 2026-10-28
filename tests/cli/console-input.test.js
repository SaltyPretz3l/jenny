'use strict';

// Row 61: the installed Windows jenny.cmd opens the console input itself
// (decision note docs/plans/CLI_WINDOWS_CONSOLE_LAUNCHER.md). These tests pin
// when the console is opened, the PE subsystem read that limits it to a
// GUI-subsystem executable, and that every failure leaves the caller's stdin
// alone; the real-console behaviour is the note's ConPTY probe.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { windowsOnly } = require('../helpers/platform-skips');
const { CONSOLE_INPUT_PATH, isGuiSubsystemExecutable, openConsoleInput } = require('../../cli/console-input');

const TTY_OUT = Object.freeze({ isTTY: true });
const NO_TTY_IN = Object.freeze({ isTTY: false });
const GUI = () => true;

function fakes({ openError = null, isatty = true, streamError = null } = {}) {
  const calls = { open: [], close: [], streams: [] };
  const fsModule = {
    openSync: (file, flags) => {
      calls.open.push([file, flags]);
      if (openError) throw openError;
      return 7;
    },
    closeSync: (fd) => { calls.close.push(fd); },
  };
  class ReadStream {
    constructor(fd) {
      if (streamError) throw streamError;
      this.fd = fd;
      calls.streams.push(fd);
    }
  }
  const ttyModule = { isatty: () => isatty, ReadStream };
  return { calls, fsModule, ttyModule, ReadStream };
}

function peImage({ subsystem, magic = 0x20b, lfanew = 0x80 }) {
  const image = Buffer.alloc(1024);
  image.write('MZ', 0, 'latin1');
  image.writeUInt32LE(lfanew, 0x3c);
  image.write('PE\0\0', lfanew, 'latin1');
  image.writeUInt16LE(magic, lfanew + 24);
  image.writeUInt16LE(subsystem, lfanew + 24 + 68);
  return image;
}

test('the console input is the device-namespace path, not a cwd-relative CONIN$', () => {
  assert.equal(CONSOLE_INPUT_PATH, '\\\\.\\CONIN$');
});

test('a null-device or handle-less fd 0 under a GUI-subsystem executable opens the console as a TTY stream', () => {
  for (const stdinKind of ['device', 'none']) {
    const { calls, fsModule, ttyModule, ReadStream } = fakes();
    const seen = [];
    const stream = openConsoleInput({ stdin: NO_TTY_IN, stdout: TTY_OUT, stdinKind, platform: 'win32', execPath: 'C:\\Jenny\\Jenny.exe',
      isGuiSubsystem: (file) => { seen.push(file); return true; }, fsModule, ttyModule });
    assert.ok(stream instanceof ReadStream);
    assert.equal(stream.fd, 7);
    assert.deepEqual(seen, ['C:\\Jenny\\Jenny.exe']);
    assert.deepEqual(calls.open, [[CONSOLE_INPUT_PATH, 'r+']]);
    assert.deepEqual(calls.close, []);
  }
});

test('the caller keeps its stdin off Windows, on a TTY, without a terminal on stdout, for a pipe or file, or under a console executable', () => {
  const cases = [
    { platform: 'linux', stdin: NO_TTY_IN, stdout: TTY_OUT, stdinKind: 'device' },
    { platform: 'darwin', stdin: NO_TTY_IN, stdout: TTY_OUT, stdinKind: 'device' },
    { platform: 'win32', stdin: { isTTY: true }, stdout: TTY_OUT, stdinKind: 'device' },
    { platform: 'win32', stdin: NO_TTY_IN, stdout: { isTTY: false }, stdinKind: 'device' },
    { platform: 'win32', stdin: NO_TTY_IN, stdout: undefined, stdinKind: 'device' },
    { platform: 'win32', stdin: NO_TTY_IN, stdout: TTY_OUT, stdinKind: 'pipe' },
    { platform: 'win32', stdin: NO_TTY_IN, stdout: TTY_OUT, stdinKind: 'file' },
    { platform: 'win32', stdin: NO_TTY_IN, stdout: TTY_OUT, stdinKind: 'other' },
    { platform: 'win32', stdin: NO_TTY_IN, stdout: TTY_OUT, stdinKind: 'device', isGuiSubsystem: () => false },
  ];
  for (const options of cases) {
    const { calls, fsModule, ttyModule } = fakes();
    assert.equal(openConsoleInput({ isGuiSubsystem: GUI, ...options, fsModule, ttyModule }), null, JSON.stringify(options));
    assert.deepEqual(calls.open, [], `no console open for ${JSON.stringify(options)}`);
  }
});

test('a console that cannot be opened (no attached console) leaves the hint path in charge', () => {
  const { calls, fsModule, ttyModule } = fakes({ openError: Object.assign(new Error('bad fd'), { code: 'EBADF' }) });
  assert.equal(openConsoleInput({ stdin: NO_TTY_IN, stdout: TTY_OUT, stdinKind: 'device', platform: 'win32', isGuiSubsystem: GUI, fsModule, ttyModule }), null);
  assert.equal(calls.open.length, 1);
  assert.deepEqual(calls.close, []);
});

test('a descriptor that is no TTY, or a stream that will not wrap it, is closed again', () => {
  for (const options of [{ isatty: false }, { streamError: new Error('uv_tty_init failed') }]) {
    const { calls, fsModule, ttyModule } = fakes(options);
    assert.equal(openConsoleInput({ stdin: NO_TTY_IN, stdout: TTY_OUT, stdinKind: 'device', platform: 'win32', isGuiSubsystem: GUI, fsModule, ttyModule }), null);
    assert.deepEqual(calls.close, [7]);
    assert.deepEqual(calls.streams, []);
  }
});

test('the PE subsystem read: GUI (2) is true, console (3) and non-images are false', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-console-input-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, bytes) => { const file = path.join(dir, name); fs.writeFileSync(file, bytes); return file; };
  assert.equal(isGuiSubsystemExecutable(write('gui64.exe', peImage({ subsystem: 2 }))), true);
  assert.equal(isGuiSubsystemExecutable(write('gui32.exe', peImage({ subsystem: 2, magic: 0x10b }))), true);
  assert.equal(isGuiSubsystemExecutable(write('console.exe', peImage({ subsystem: 3 }))), false);
  const beyond = peImage({ subsystem: 2 });
  beyond.writeUInt32LE(0x2000, 0x3c);
  assert.equal(isGuiSubsystemExecutable(write('beyond.exe', beyond)), false, 'a PE header past the bytes read is not trusted');
  const notPe = peImage({ subsystem: 2 });
  notPe.write('XX', 0x80, 'latin1');
  assert.equal(isGuiSubsystemExecutable(write('not-pe.exe', notPe)), false);
  assert.equal(isGuiSubsystemExecutable(write('script.cmd', '@echo off\r\n')), false);
  assert.equal(isGuiSubsystemExecutable(path.join(dir, 'missing.exe')), false);
});

test('the Node running these tests is a console-subsystem executable on Windows', { skip: windowsOnly('PE subsystem of node.exe') }, () => {
  assert.equal(isGuiSubsystemExecutable(process.execPath), false);
});
