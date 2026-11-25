#!/usr/bin/env node
'use strict';

// A stand-in for native/jenny-computer that speaks the same protocol
// (native/jenny-computer/PROTOCOL.md) from a script, so the helper host, the
// run service and the tools are tested with no screen, no window and no real
// program. Started with `--serve` (or `--version`) like the real helper.
//
// Behaviour comes from the FAKE_COMPUTER_HELPER environment variable, a JSON
// object; every key is optional:
//   available        false = answer like a helper off Windows (default true)
//   built            object overriding hello's `built` flags
//   windowDelayMs    delay before `run.window` after a start (default 10)
//   noWindow         true = a run never shows a window
//   exitOnStart      true = a run exits right after it starts (exitCode, default 1)
//   exitCode         exit code a run reports when it exits
//   closeRefuses     true = the program ignores a close: run.close asks but the run
//                    goes on, and run.stop must end the job ("ended", not "closed")
//   startFails       true = run.start answers start_failed
//   captureFails     true = capture answers capture_failed
//   captureSignature fixed capture signature (default changes on each capture)
//   outputLines      lines the run's output ring holds
//   crashOnOp        an op name; the fake exits with code 3 when it receives it
// FAKE_COMPUTER_HELPER_LOG, when set, is a file each request is appended to
// as one JSON line, for tests that check what the host sent.

const fs = require('node:fs');
const path = require('node:path');
const protocol = require(path.join(__dirname, '..', '..', 'services', 'computer-helper', 'protocol.js'));

// A 1 by 1 transparent PNG.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==';
const HWND_BASE = 0x907d0;

function readOptions() {
  try {
    const parsed = JSON.parse(process.env.FAKE_COMPUTER_HELPER || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const options = readOptions();
const available = options.available !== false;
const runs = new Map();
let nextHwnd = HWND_BASE;
let nextPid = 4000;
let captureCount = 0;

function write(line) {
  process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

function reply(id, result) {
  write(JSON.stringify({ id, ok: true, result }));
}

function fail(id, code, message) {
  write(JSON.stringify({ id, ok: false, error: { code, message } }));
}

function event(name, fields) {
  write(JSON.stringify({ event: name, ...fields }));
}

function rect(x, y, width, height) {
  return { x, y, width, height };
}

function geometryFor(hwnd) {
  return {
    hwnd,
    window: rect(93, 93, 1296, 767),
    bounds: rect(100, 100, 1282, 752),
    client: rect(101, 131, 1280, 720),
    offset: { left: 1, top: 31, right: 1, bottom: 1 },
    dpi: 96,
    scale: 1,
    minimized: false,
  };
}

function knownWindow(hwnd) {
  for (const run of runs.values()) if (run.hwnd === hwnd) return true;
  return false;
}

function exitRun(run, exitCode) {
  if (run.state === 'exited') return;
  run.state = 'exited';
  run.exitCode = exitCode;
  if (run.windowTimer) clearTimeout(run.windowTimer);
  event('run.exited', { run_id: run.runId, exit_code: exitCode });
}

function startRun(id, args) {
  const runId = args.run_id;
  if (!protocol.isValidRunId(runId)) return fail(id, 'bad_request', 'run_id is malformed');
  if (typeof args.program !== 'string' || !path.isAbsolute(args.program)) {
    return fail(id, 'bad_request', 'program must be an absolute path');
  }
  if (!Array.isArray(args.args) || !args.args.every((a) => typeof a === 'string')) {
    return fail(id, 'bad_request', 'args must be an array of strings');
  }
  if (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd)) {
    return fail(id, 'bad_request', 'cwd must be an absolute folder');
  }
  if (!args.env || typeof args.env !== 'object' || Array.isArray(args.env)) {
    return fail(id, 'bad_request', 'env must be an object');
  }
  const existing = runs.get(runId);
  if (existing && existing.state !== 'exited') return fail(id, 'run_exists', 'that run is still running');
  if (options.startFails) return fail(id, 'start_failed', 'create process failed');
  const run = {
    runId,
    pid: nextPid++,
    hwnd: null,
    state: 'starting',
    exitCode: null,
    windowTimer: null,
    lines: Array.isArray(options.outputLines) ? options.outputLines.map(String) : [],
  };
  runs.set(runId, run);
  reply(id, { run_id: runId, pid: run.pid });
  if (options.exitOnStart) {
    setImmediate(() => exitRun(run, Number.isInteger(options.exitCode) ? options.exitCode : 1));
    return undefined;
  }
  if (!options.noWindow) {
    run.windowTimer = setTimeout(() => {
      if (run.state === 'exited') return;
      run.hwnd = nextHwnd++;
      run.state = 'running';
      event('run.window', { run_id: runId, hwnd: run.hwnd, source_id: protocol.sourceIdForHwnd(run.hwnd) });
    }, Number.isInteger(options.windowDelayMs) ? options.windowDelayMs : 10);
  }
  return undefined;
}

function stopRun(id, args) {
  const run = runs.get(args.run_id);
  if (!run) return fail(id, 'no_such_run', 'no run with that id');
  runs.delete(args.run_id);
  if (run.state === 'exited') {
    return reply(id, { run_id: run.runId, how: 'already_ended', exit_code: run.exitCode });
  }
  const how = options.closeRefuses ? 'ended' : 'closed';
  const exitCode = options.closeRefuses ? 1 : 0;
  exitRun(run, exitCode);
  return reply(id, { run_id: run.runId, how, exit_code: exitCode });
}

function closeRun(id, args) {
  const run = runs.get(args.run_id);
  if (!run) return fail(id, 'no_such_run', 'no run with that id');
  if (run.state === 'exited' || run.hwnd === null) return reply(id, { run_id: run.runId, asked: false });
  reply(id, { run_id: run.runId, asked: true });
  if (!options.closeRefuses) setImmediate(() => exitRun(run, 0));
  return undefined;
}

function runOutput(id, args) {
  const run = runs.get(args.run_id);
  if (!run) return fail(id, 'no_such_run', 'no run with that id');
  const max = Number.isInteger(args.max_lines) ? Math.min(Math.max(args.max_lines, 1), 200) : 200;
  return reply(id, { run_id: run.runId, lines: run.lines.slice(-max), dropped_bytes: 0 });
}

function listWindows(id, args) {
  const windows = [];
  for (const run of runs.values()) {
    if (run.hwnd === null || run.state === 'exited') continue;
    if (args.run_id !== undefined && args.run_id !== run.runId) continue;
    windows.push({
      hwnd: run.hwnd,
      pid: run.pid,
      title: `fake (${run.runId})`,
      visible: true,
      cloaked: false,
      tool_window: false,
      bounds: geometryFor(run.hwnd).bounds,
    });
  }
  reply(id, { windows });
}

function capture(id, args) {
  if (!protocol.isValidHwnd(args.hwnd) || !knownWindow(args.hwnd)) {
    return fail(id, 'no_such_window', 'no such window');
  }
  if (options.captureFails) return fail(id, 'capture_failed', 'no frame');
  captureCount += 1;
  const signature = typeof options.captureSignature === 'string'
    ? options.captureSignature
    : captureCount.toString(16).padStart(16, '0');
  return reply(id, { png_base64: PNG_1X1, width: 1, height: 1, scale: 1, signature });
}

function hello(id) {
  const built = { windows: available, run: available, geometry: available, capture: available, input: false };
  reply(id, {
    protocol: protocol.PROTOCOL,
    version: '0.0.0-fake',
    platform: available ? 'windows' : 'linux',
    available,
    built: { ...built, ...(options.built && typeof options.built === 'object' ? options.built : {}) },
  });
}

function logRequest(message) {
  const file = process.env.FAKE_COMPUTER_HELPER_LOG;
  if (file) fs.appendFileSync(file, `${JSON.stringify(message)}\n`);
}

function handle(message) {
  logRequest(message);
  const { id, op, ...args } = message;
  if (!Number.isSafeInteger(id) || id < 0) return fail(null, 'bad_request', 'id is missing');
  if (typeof op !== 'string') return fail(id, 'bad_request', 'op is missing');
  if (options.crashOnOp === op) process.exit(3);
  if (op === 'hello') return hello(id);
  if (op === 'shutdown') {
    for (const run of runs.values()) exitRun(run, 0);
    reply(id, {});
    return process.stdout.write('', () => process.exit(0));
  }
  if (!protocol.OPS.includes(op) && !protocol.RESERVED_INPUT_OPS.includes(op)) {
    return fail(id, 'unknown_op', 'unknown op');
  }
  if (!available) return fail(id, 'not_available', 'jenny-computer supports Windows only');
  switch (op) {
    case 'windows.list': return listWindows(id, args);
    case 'window.geometry':
      return knownWindow(args.hwnd) ? reply(id, geometryFor(args.hwnd)) : fail(id, 'no_such_window', 'no such window');
    case 'window.show':
      return knownWindow(args.hwnd) ? reply(id, {}) : fail(id, 'no_such_window', 'no such window');
    case 'run.start': return startRun(id, args);
    case 'run.close': return closeRun(id, args);
    case 'run.stop': return stopRun(id, args);
    case 'run.output': return runOutput(id, args);
    case 'run.list':
      return reply(id, {
        runs: [...runs.values()].map((r) => ({
          run_id: r.runId, pid: r.pid, state: r.state, hwnd: r.hwnd, exit_code: r.exitCode,
        })),
      });
    case 'capture': return capture(id, args);
    default: return fail(id, 'not_built', `${op} is not in this build`);
  }
}

function serve() {
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) {
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          fail(null, 'bad_request', 'request is not JSON');
        }
        if (message && typeof message === 'object' && !Array.isArray(message)) handle(message);
        else if (message !== null) fail(null, 'bad_request', 'request is not an object');
      }
      newline = buffered.indexOf('\n');
    }
  });
  // The end of stdin ends every run at once, as the real helper does.
  process.stdin.on('end', () => {
    for (const run of runs.values()) if (run.windowTimer) clearTimeout(run.windowTimer);
    process.exit(0);
  });
}

const arg = process.argv[2];
if (arg === '--version') {
  process.stdout.write(`${protocol.VERSION_LINE}\n`);
} else if (arg === '--serve') {
  serve();
} else {
  process.stderr.write('usage: fake-computer-helper --serve | --version\n');
  process.exitCode = 125;
}
