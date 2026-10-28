#!/usr/bin/env node
'use strict';

// `jenny`: the agent-first command on the desktop runtime (Jenny CLI plan,
// row 9). This file is the thin IO shell: parse, resolve settings, read the
// prompt, wire signals, run, exit. Everything with behaviour lives in the
// modules it calls so the tests can drive them without a terminal.

const fs = require('node:fs');
const path = require('node:path');
const { formatDoctor, runDoctor } = require('./doctor');
const { CLI_CONTRACT, CLI_VERSION, EXIT_CODES } = require('./exit-codes');
const { createOutput } = require('./output');
const { parseArguments, resolveSettings, usage, usageError } = require('./arguments');
const { runCompletion } = require('./completion');
const { runConfig } = require('./config');
const { openConsoleInput } = require('./console-input');
const { runInteractive } = require('./interactive');
const { runMcpServe } = require('./mcp-serve');
const { runPrint } = require('./print');
const { runSessions } = require('./sessions');
const { API_VERSION } = require('../services/backend/sidecar-client');
const { resolveCliRuntime } = require('../services/cli-host/runtime-layout');

const ROOT = path.resolve(__dirname, '..');
const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const SIGNAL_EXIT = Object.freeze({ SIGINT: EXIT_CODES.SIGINT, SIGTERM: EXIT_CODES.SIGTERM });
// An installed jenny.cmd runs the GUI-subsystem Jenny.exe, whose fd 0 has no
// handle on Windows. The loop opens the console itself (console-input.js), so
// this hint is left for a run without a terminal on stdout or without a console.
const WINDOWS_NO_CONSOLE_PROMPT = 'A prompt is required. The installed jenny.cmd found no console input: pass the prompt as an argument (jenny -p "...") or pipe it (echo ... | jenny -p). The interactive session needs a terminal on stdin and stdout.';

function appVersion() {
  try { return String(require(path.join(ROOT, 'package.json')).version || ''); } catch (_error) { return ''; }
}

// <profile>/cli.json is trusted configuration, so a file that cannot be read
// as a small JSON object is a usage error, never silently ignored: a run must
// not proceed under settings other than the ones the caller wrote down.
function readProfileConfig(profilePath) {
  const file = path.join(profilePath, 'cli.json');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw usageError('profile_config_unreadable', `${file} could not be read (${error?.code || 'error'}).`);
  }
  if (!stat.isFile()) throw usageError('profile_config_unreadable', `${file} is not a file.`);
  if (stat.size > MAX_CONFIG_BYTES) throw usageError('profile_config_too_large', `${file} is larger than ${MAX_CONFIG_BYTES} bytes.`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw usageError('profile_config_invalid', `${file} is not valid JSON: ${error?.message || 'parse error'}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw usageError('profile_config_invalid', `${file} must hold a JSON object.`);
  return parsed;
}

// What fd 0 is: a caller's pipe (a FIFO on POSIX; on Windows fstat reports
// nothing and Node wraps it as a Socket), a redirected file, or the null
// device an ignored stdin maps to.
function stdinKind(stdin, fd = 0) {
  try {
    const stat = fs.fstatSync(fd);
    if (stat.isFIFO() || stat.isSocket() || stdin?.constructor?.name === 'Socket') return 'pipe';
    if (stat.isFile()) return 'file';
    return stat.isCharacterDevice() ? 'device' : 'other';
  } catch (_error) { return 'none'; }
}

function readStdin(stdin) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      total += Buffer.byteLength(chunk);
      if (total > MAX_STDIN_BYTES) { reject(new Error('The prompt on stdin is too long.')); stdin.destroy(); return; }
      chunks.push(chunk);
    });
    stdin.on('end', () => resolve(chunks.join('')));
    stdin.on('error', reject);
  });
}

// Cancellation channels (decision 9): SIGINT, SIGTERM, the caller's stdout
// closing, and, only when asked (`--cancel-on-stdin-close`), the caller's
// piped stdin closing: a parent that holds the pipe open unused, or one that
// closes it idle, must neither hang nor cancel a run by default. A second
// signal ends the process at once with the signal's code, after the hard-exit
// hooks (the sidecar's own pid) have run.
function createControl({ stdin, watchStdinClose, onHardExit }) {
  const listeners = new Set();
  const hardExitHooks = new Set();
  let cancelled = null;
  let watching = false;
  const cancel = (signalName) => {
    if (cancelled) {
      for (const hook of hardExitHooks) { try { hook(); } catch (_error) { /* exiting anyway */ } }
      onHardExit(SIGNAL_EXIT[signalName] || EXIT_CODES.SIGINT);
      return;
    }
    cancelled = signalName;
    for (const listener of listeners) listener(signalName);
  };
  const onSignal = (signalName) => () => cancel(signalName);
  const handlers = { SIGINT: onSignal('SIGINT'), SIGTERM: onSignal('SIGTERM') };
  for (const [name, handler] of Object.entries(handlers)) process.on(name, handler);
  if (watchStdinClose && typeof stdin?.resume === 'function') {
    watching = true;
    stdin.resume();
    stdin.on('end', () => cancel('SIGINT'));
    stdin.on('error', () => cancel('SIGINT'));
  }
  return {
    // A cancel that arrived before the run registered (the caller's pipe closed
    // during host start) is delivered as soon as it listens.
    onCancel: (listener) => { listeners.add(listener); if (cancelled) listener(cancelled); },
    onHardExit: (hook) => { hardExitHooks.add(hook); },
    abort: () => cancel('SIGINT'),
    dispose: () => {
      for (const [name, handler] of Object.entries(handlers)) process.off(name, handler);
      // A resumed stdin would keep the process alive after the result.
      if (watching) { try { stdin.pause(); } catch (_error) { /* closed */ } }
    },
  };
}

async function main(argv = process.argv.slice(2), { env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  runtime: injectedRuntime = null } = {}) {
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${usage()}\n`);
    return EXIT_CODES.USAGE;
  }
  if (parsed.help || parsed.command === 'help') { stdout.write(`${usage()}\n`); return EXIT_CODES.OK; }
  if (parsed.version) {
    const versions = { cli: CLI_VERSION, contract: CLI_CONTRACT, app: appVersion() || 'unknown', sidecar_api: API_VERSION };
    stdout.write(parsed.json ? `${JSON.stringify({ v: 1, kind: 'version', versions })}\n`
      : `jenny ${versions.cli} (contract ${versions.contract}, app ${versions.app}, sidecar api ${versions.sidecar_api})\n`);
    return EXIT_CODES.OK;
  }

  if (parsed.command === 'completion') return runCompletion({ shell: parsed.commandArgs[0], stdout, stderr });

  let settings;
  let profileConfig;
  try {
    const profilePath = path.resolve(parsed.flags.profile || resolveSettings({ flags: parsed.flags, env }).profilePath);
    profileConfig = readProfileConfig(profilePath);
    settings = resolveSettings({ flags: parsed.flags, env, profileConfig });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return EXIT_CODES.USAGE;
  }

  // Source tree or installed copy: where the sidecar, the lock helper and the
  // interpreters live (decision 13).
  const runtime = injectedRuntime || resolveCliRuntime({ root: ROOT, env });

  if (parsed.command === 'doctor') {
    const report = await runDoctor({ settings, env, appVersion: appVersion(), runtime });
    stdout.write(`${formatDoctor(report, { json: parsed.json })}\n`);
    return report.ok ? EXIT_CODES.OK : EXIT_CODES.RUNTIME_ERROR;
  }
  if (parsed.command === 'config') {
    return runConfig({ verb: parsed.commandArgs[0], args: parsed.commandArgs.slice(1), flags: parsed.flags, env, settings, profileConfig,
      json: parsed.json, stdout, stderr });
  }
  if (parsed.command === 'sessions') {
    return runSessions({ verb: parsed.commandArgs[0], args: parsed.commandArgs.slice(1), flags: parsed.flags, settings,
      runtime, json: parsed.json, stdout, stderr });
  }
  if (parsed.command === 'mcp') {
    if (parsed.commandArgs.length !== 1) { stderr.write('Usage: jenny mcp serve [run options]\n'); return EXIT_CODES.USAGE; }
    return runMcpServe({ settings, stdin, stdout, stderr, env, appVersion: appVersion(), runtime });
  }

  const kind = stdinKind(stdin);
  const interactive = stdin.isTTY === true;
  const logger = (level, event, data) => {
    if (level === 'ERROR' || level === 'WARN') stderr.write(`[${level.toLowerCase()}] ${event} ${JSON.stringify(data || {}).slice(0, 400)}\n`);
  };
  // The installed Windows copy: fd 0 is only the null device, but the process
  // is attached to the terminal's console (console-input.js).
  const consoleInput = !parsed.flags.print && !parsed.prompt ? openConsoleInput({ stdin, stdout, stdinKind: kind }) : null;
  if (consoleInput) {
    try {
      return await runInteractive({ settings, stdin: consoleInput, stdout, stderr, appVersion: appVersion(), runtime, logger });
    } finally {
      consoleInput.destroy();
    }
  }
  if (!parsed.flags.print && interactive && !parsed.prompt) {
    return runInteractive({ settings, stdin, stdout, stderr, appVersion: appVersion(), runtime, logger });
  }
  let prompt = parsed.prompt;
  // Without a prompt argument, a piped or redirected stdin is the prompt and
  // its end is the prompt's end. With one, stdin is left alone.
  const promptFromStdin = !prompt && !interactive && (kind === 'pipe' || kind === 'file');
  if (promptFromStdin) {
    try { prompt = (await readStdin(stdin)).trim(); } catch (error) { stderr.write(`${error.message}\n`); return EXIT_CODES.USAGE; }
  }
  if (!prompt) {
    const noConsole = runtime.mode === 'packaged' && process.platform === 'win32' && !interactive;
    stderr.write(`${noConsole ? WINDOWS_NO_CONSOLE_PROMPT : 'A prompt is required.'}\n\n${usage()}\n`);
    return EXIT_CODES.USAGE;
  }

  const control = createControl({ stdin, watchStdinClose: settings.cancelOnStdinClose && !promptFromStdin && kind === 'pipe',
    onHardExit: (code) => { stderr.write('[cancel] second signal: exiting now\n'); process.exit(code); } });
  const output = createOutput({ format: settings.outputFormat, stdout, stderr, color: settings.color,
    onStdoutClosed: () => { stderr.write('[cancel] stdout closed: stopping the run\n'); control.abort(); } });
  try {
    return await runPrint({ settings, prompt, output, control, appVersion: appVersion(),
      runtime, logger });
  } finally {
    control.dispose();
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = EXIT_CODES.RUNTIME_ERROR;
  });
}

module.exports = { main };
