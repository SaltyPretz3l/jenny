'use strict';

// Console input for the installed Windows `jenny.cmd` (row 61, decision note
// docs/plans/CLI_WINDOWS_CONSOLE_LAUNCHER.md). The installed Jenny.exe is a
// GUI-subsystem executable. Under ELECTRON_RUN_AS_NODE, Electron attaches it to
// the parent console and reopens stdout and stderr on CONOUT$ (Chromium's
// RouteStdioToConsole), but fd 0 gets no handle and Node backs it with the
// null device, so `process.stdin` is no TTY. The process is still attached to
// the console, so the console input device opens by its device-namespace path
// (plain `CONIN$` would resolve against the current directory) and gives the
// interactive loop a real TTY.

const fs = require('node:fs');
const tty = require('node:tty');

const CONSOLE_INPUT_PATH = '\\\\.\\CONIN$';
const PE_HEADER_BYTES = 4096;
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;

// The optional header's Subsystem field (offset 68 for PE32 and PE32+). False
// for anything that does not parse as a PE image.
function isGuiSubsystemExecutable(file, fsModule = fs) {
  let fd;
  try {
    fd = fsModule.openSync(file, 'r');
    const header = Buffer.alloc(PE_HEADER_BYTES);
    const read = fsModule.readSync(fd, header, 0, PE_HEADER_BYTES, 0);
    if (read < 64 || header.toString('latin1', 0, 2) !== 'MZ') return false;
    const pe = header.readUInt32LE(0x3c);
    const subsystemAt = pe + 4 + 20 + 68;
    if (subsystemAt + 2 > read || header.toString('latin1', pe, pe + 4) !== 'PE\0\0') return false;
    return header.readUInt16LE(subsystemAt) === IMAGE_SUBSYSTEM_WINDOWS_GUI;
  } catch (_error) {
    return false;
  } finally {
    if (fd !== undefined) { try { fsModule.closeSync(fd); } catch (_error) { /* closed */ } }
  }
}

// Returns a tty.ReadStream on the console input, or null when the run keeps
// its own stdin: off Windows, when stdin is already a TTY, when stdout is not
// a terminal, when fd 0 is a pipe or a file, or when the executable is a
// console-subsystem one (plain Node gets its console stdin from Windows, so a
// null-device stdin there was the caller's choice). If the process is not
// attached to a console the open fails and the caller's hint applies.
function openConsoleInput({ stdin, stdout, stdinKind, platform = process.platform, execPath = process.execPath,
  isGuiSubsystem = isGuiSubsystemExecutable, fsModule = fs, ttyModule = tty }) {
  if (platform !== 'win32' || stdin?.isTTY === true || stdout?.isTTY !== true) return null;
  if (stdinKind !== 'device' && stdinKind !== 'none') return null;
  if (!isGuiSubsystem(execPath)) return null;
  let fd;
  try {
    fd = fsModule.openSync(CONSOLE_INPUT_PATH, 'r+');
  } catch (_error) {
    return null;
  }
  try {
    if (ttyModule.isatty(fd)) return new ttyModule.ReadStream(fd);
  } catch (_error) { /* fall through and close */ }
  try { fsModule.closeSync(fd); } catch (_error) { /* already closed */ }
  return null;
}

module.exports = { CONSOLE_INPUT_PATH, isGuiSubsystemExecutable, openConsoleInput };
