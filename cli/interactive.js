'use strict';

// The interactive client (Jenny CLI plan, decision 10): `node:readline` over
// one held host, inline and append-only, native scrollback, no alternate
// screen. Each line is one turn through the same `runTurn` print mode uses,
// in one session for the whole sitting; decisions go to the person at the
// terminal through the TTY decider (allow once, allow for this run, deny;
// questions answered in place). Ctrl-C cancels the running turn, or asks
// for a second press when idle; Ctrl-D, /exit, SIGTERM and a lost profile
// lock end the loop with the matching exit code.

const readline = require('node:readline');
const { createTtyDecider } = require('../services/cli-host/decisions-tty');
const { hostComposition } = require('../services/cli-host/host');
const { createOutput } = require('./output');
const { createReadlineAsk } = require('./tty-decisions');
const { closeHost, createTurnSignals, openHost, runTurn, withTimeout } = require('./print');
const { CLI_VERSION, EXIT_CODES } = require('./exit-codes');

const NO_SESSION = 'none';
const SECOND_INTERRUPT_MS = 2000;
const CANCELLED_TURN_GRACE_MS = 30_000;
const HELP = Object.freeze([
  '/help      this list',
  '/session   the session this sitting writes to',
  '/new       start a fresh session with the next prompt',
  '/allowed   the tools allowed by the launch policy and for this run',
  '/exit      quit (Ctrl-D does too); Ctrl-C cancels a running turn',
]);

function banner({ settings, runPolicy, appVersion }) {
  const allowed = runPolicy.allowedTools.length ? runPolicy.allowedTools.join(', ') : 'none pre-allowed';
  return [
    `jenny ${CLI_VERSION} (app ${appVersion || 'unknown'}) · ${settings.engine}${settings.model ? ` · ${settings.model}` : ''} · ${settings.workspaceRoot}`,
    `permissions: ${runPolicy.permissionMode} · allowed: ${allowed} · Ctrl-C cancels a turn, /exit or Ctrl-D quits, /help lists commands`,
  ];
}

async function runInteractive({ settings, stdin, stdout, stderr, appVersion = '', runtime, logger = () => {} }) {
  if (settings.outputFormat !== 'text') {
    stderr.write('Interactive mode prints text; use -p for json or stream-json output.\n');
    return EXIT_CODES.USAGE;
  }
  const output = createOutput({ format: 'text', stdout, stderr, color: settings.color, summary: true });
  let exitCode = null;
  let lockLost = null;
  let turnSignals = null;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const finish = (code) => { if (exitCode === null) { exitCode = code; resolveDone(); } };

  const opened = await openHost({ settings, output, startedAt: Date.now(), runtime, logger,
    onLockLost: (error) => {
      lockLost = error || new Error('The profile lock was lost.');
      turnSignals?.lockLost(lockLost);
      if (!turnSignals) output.diagnostic('[lock] the profile lock was lost: exiting', 'red');
      finish(EXIT_CODES.ENGINE_UNAVAILABLE);
    } });
  if (opened.exitCode !== undefined) return opened.exitCode;
  const { host, held } = opened;
  const { runPolicy } = hostComposition(host);
  for (const line of banner({ settings, runPolicy, appVersion })) output.diagnostic(line, 'plain');

  const rl = readline.createInterface({ input: stdin, output: stdout, prompt: '> ', terminal: true, historySize: 200 });
  const allowedThisRun = new Set();
  const ask = createReadlineAsk({ rl, write: (line) => output.diagnostic(line, 'plain'), beforePrompt: () => output.ensureLineBreak() });
  const queue = [];
  let running = null;
  let sessionId = settings.sessionId || null;
  let continueLatest = settings.continue === true;
  let lastInterrupt = 0;

  const showPrompt = () => { if (exitCode === null) rl.prompt(); };

  function command(line) {
    const [name] = line.split(/\s+/u);
    switch (name) {
      case '/help': HELP.forEach((entry) => output.diagnostic(entry, 'plain')); break;
      case '/exit': case '/quit': finish(EXIT_CODES.OK); return;
      case '/session': output.diagnostic(`[session] ${sessionId || '(none yet: the first prompt creates one)'}`, 'plain'); break;
      case '/new': sessionId = null; continueLatest = false; output.diagnostic('[session] the next prompt starts a new session', 'plain'); break;
      case '/allowed':
        output.diagnostic(`[allowed] launch policy: ${runPolicy.allowedTools.join(', ') || 'none'}; this run: ${[...allowedThisRun].sort().join(', ') || 'none'}`, 'plain');
        break;
      default: output.diagnostic(`Unknown command ${name}. /help lists the commands.`, 'yellow'); break;
    }
    showPrompt();
  }

  function turn(prompt) {
    turnSignals = createTurnSignals();
    if (lockLost) turnSignals.lockLost(lockLost);
    const turnSettings = { ...settings, sessionId, continue: !sessionId && continueLatest };
    running = runTurn({ host, settings: turnSettings, prompt, output, signals: turnSignals, appVersion, startedAt: Date.now(), logger,
      createDecider: (options) => createTtyDecider({ ...options, ask, allowedThisRun }) })
      .then(({ payload }) => {
        if (payload?.session_id && payload.session_id !== NO_SESSION) { sessionId = payload.session_id; continueLatest = false; }
      }, (error) => output.diagnostic(`[error] ${error?.message || error}`, 'red'))
      .finally(() => {
        running = null;
        turnSignals = null;
        if (exitCode !== null) return;
        if (queue.length) handleLine(queue.shift());
        else showPrompt();
      });
  }

  function handleLine(raw) {
    const line = String(raw).trim();
    if (!line) { showPrompt(); return; }
    if (line.startsWith('/')) { command(line); return; }
    turn(line);
  }

  const onInterrupt = () => {
    if (running) { turnSignals?.cancel('SIGINT'); return; }
    const now = Date.now();
    if (now - lastInterrupt < SECOND_INTERRUPT_MS) { finish(EXIT_CODES.SIGINT); return; }
    lastInterrupt = now;
    output.ensureLineBreak();
    output.diagnostic('(press Ctrl-C again to exit, or type /exit)');
    showPrompt();
  };
  const onTerminate = () => { turnSignals?.cancel('SIGTERM'); finish(EXIT_CODES.SIGTERM); };
  rl.on('line', (line) => { if (running) queue.push(line); else handleLine(line); });
  rl.on('SIGINT', onInterrupt);
  rl.on('close', () => { if (running) turnSignals?.cancel('SIGINT'); finish(EXIT_CODES.OK); });
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  showPrompt();

  await done;
  rl.close();
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  if (running) await withTimeout(running, CANCELLED_TURN_GRACE_MS, () => null);
  output.ensureLineBreak();
  await closeHost({ host, held, logger });
  return exitCode;
}

module.exports = { HELP, runInteractive };
