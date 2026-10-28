'use strict';

// Jenny CLI S8: the interactive readline client. The renderer and the terminal
// ask port are pure and tested as such; the loop itself is driven through a
// real pty (`@lydell/node-pty`) against the real sidecar on the replay engine:
// a streamed reply, an approval taken at the terminal, a question answered in
// place, the slash commands, Ctrl-C cancelling a running turn, and Ctrl-D or
// /exit ending the sitting with exit 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('@lydell/node-pty');

const { createRenderer } = require('../../cli/renderer');
const { choiceLegend, formatQuestion, formatRequest, parseAnswer, parseChoice } = require('../../cli/tty-decisions');
const { EXIT_CODES } = require('../../cli/exit-codes');

const ROOT = path.resolve(__dirname, '../..');
const MAIN = path.join(ROOT, 'cli/main.js');
const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
// VT control, OSC and charset sequences, and carriage returns, as the pty echoes them.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^${BEL}]*${BEL}|${ESC}[()][A-Za-z0-9]|\\r`, 'gu');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-cli-tty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'interactive fixture 7e3a');
  return { root, workspace, profile: path.join(root, 'profile') };
}

function replayScript(root, script) {
  const file = path.join(root, `replay-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...script }));
  return file;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnInteractive(t, args, { dirs, replay }) {
  const proc = pty.spawn(process.execPath, [MAIN, '--engine', 'replay', ...args], {
    cols: 160, rows: 50, cwd: dirs.workspace,
    env: { ...process.env, JENNY_PROFILE: dirs.profile, JENNY_REPLAY_SCRIPT: replay, JENNY_BACKEND_PYTHON: PYTHON, NO_COLOR: '1' },
  });
  let buffer = '';
  proc.onData((chunk) => { buffer += chunk; });
  let exited = null;
  const exit = new Promise((resolve) => proc.onExit(({ exitCode }) => { exited = exitCode; resolve(exitCode); }));
  // Always kill: the ConPTY handle the binding holds keeps the runner alive
  // until the pty is torn down, even once the child has exited on its own.
  t.after(() => { try { proc.kill(); } catch (_error) { /* gone */ } });
  const text = () => buffer.replace(ANSI_RE, '');
  const count = (re) => (text().match(new RegExp(re.source, `${re.flags.replace('g', '')}g`)) || []).length;
  async function waitFor(re, { times = 1, timeoutMs = 90_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (count(re) >= times) return;
      if (exited !== null) break;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${re} x${times} (exit ${exited}); screen tail:\n${text().slice(-1500)}`);
  }
  return { proc, write: (data) => proc.write(data), waitFor, exit, text, count };
}

test('renderer: frames become stdout text and stderr lines, with a summary after a clean result', () => {
  const r = createRenderer({ color: false, summary: true });
  const frame = (kind, payload) => ({ v: 1, kind, payload });
  assert.deepEqual(r.render(frame('delta', { text: 'Hel' })), [{ to: 'stdout', text: 'Hel' }]);
  assert.deepEqual(r.render(frame('tool_use', { tool_name: 'read_file', summary: 'fixture.txt' })),
    [{ to: 'stdout', text: '\n' }, { to: 'stderr', text: '[tool] read_file: fixture.txt\n' }]);
  assert.deepEqual(r.render(frame('tool_result', { tool_name: 'read_file', status: 'ok' })), []);
  assert.deepEqual(r.render(frame('decision', { request: 'tool_approval', tool_name: 'write_file', outcome: 'deny', by: 'policy', rule: 'not_allowed' })),
    [{ to: 'stderr', text: '[deny] write_file (not_allowed)\n' }]);
  assert.deepEqual(r.render(frame('decision', { request: 'tool_approval', tool_name: 'read_file', outcome: 'allow', by: 'user', rule: 'allowed_this_run' })),
    [{ to: 'stderr', text: '[allowed for this run] read_file\n' }]);
  assert.deepEqual(r.render(frame('decision', { request: 'user_questions', tool_name: 'ask_user', outcome: 'answer', by: 'user' })),
    [{ to: 'stderr', text: '[answered]\n' }]);
  assert.deepEqual(r.render(frame('decision', { request: 'tool_approval', tool_name: 'read_file', outcome: 'allow', by: 'policy', rule: 'pre_allowed' })), []);
  assert.deepEqual(r.render(frame('delta', { text: 'lo' })), [{ to: 'stdout', text: 'lo' }]);
  assert.deepEqual(r.render(frame('reset', { discard_scope: 'all' })), [{ to: 'stdout', text: '\n' }, { to: 'stderr', text: '[answer restarted]\n' }]);
  assert.deepEqual(r.render(frame('reset', { discard_scope: 'none' })), []);
  assert.deepEqual(r.render(frame('plan_proposed', { title: 'Do it', steps: ['one', { title: 'two' }] })),
    [{ to: 'stderr', text: '[plan] Do it\n' }, { to: 'stderr', text: '  1. one\n' }, { to: 'stderr', text: '  2. two\n' }]);
  assert.deepEqual(r.render(frame('status', { phase: 'context_compacted' })), [{ to: 'stderr', text: '[context compacted]\n' }]);
  assert.deepEqual(r.render(frame('error', { code: 'CMP-AI-0001', message: 'boom' })), [{ to: 'stderr', text: '[error CMP-AI-0001] boom\n' }]);
  // Text was streamed this turn: the result text is not repeated, only the summary follows.
  assert.deepEqual(r.render(frame('result', { subtype: 'success', is_error: false, exit_code: 0, result: 'Hello', num_turns: 2, duration_ms: 1234, usage: { output_tokens: 12 } })),
    [{ to: 'stderr', text: '[done] 2 turns · 1.2 s · 12 output tokens\n' }]);
  // Nothing streamed: the result text is printed, then the summary.
  assert.deepEqual(createRenderer({ summary: true }).render(frame('result', { subtype: 'success', is_error: false, exit_code: 0, result: 'All done.', num_turns: 1, duration_ms: 80 })),
    [{ to: 'stdout', text: 'All done.\n' }, { to: 'stderr', text: '[done] 1 turn · 0.1 s\n' }]);
  // Streamed: the open line is closed, the result text is not repeated; an error result paints red when asked.
  const colored = createRenderer({ color: true, summary: true });
  colored.render(frame('delta', { text: 'partial' }));
  assert.deepEqual(colored.render(frame('result', { subtype: 'cancelled', is_error: true, exit_code: 130, result: 'partial', num_turns: 1, duration_ms: 10 })),
    [{ to: 'stdout', text: '\n' }, { to: 'stderr', text: '\u001b[31m[cancelled] exit 130\u001b[0m\n' }]);
  assert.deepEqual(colored.render(frame('delta', { text: 'next turn' })), [{ to: 'stdout', text: 'next turn' }], 'the renderer resets per result');
  assert.deepEqual(colored.breakLine(), [{ to: 'stdout', text: '\n' }]);
  assert.deepEqual(colored.breakLine(), []);
  const plain = createRenderer({ color: false, summary: false });
  assert.deepEqual(plain.render(frame('result', { subtype: 'success', is_error: false, exit_code: 0, result: 'x', num_turns: 1, duration_ms: 1 })),
    [{ to: 'stdout', text: 'x\n' }], 'print mode has no summary line');
});

test('tty decisions: the request formats, and typed choices and answers parse', () => {
  assert.deepEqual(formatRequest({ kind: 'tool_approval', toolName: 'write_file', summary: 'out.txt', input: { path: 'out.txt', content: 'x' } }),
    ['[approval] write_file: out.txt', '  input: {"path":"out.txt","content":"x"}']);
  assert.deepEqual(formatRequest({ kind: 'tool_approval', toolName: 'run_command', one_off_only: true }),
    ['[approval] run_command (this exact call only)']);
  assert.deepEqual(formatRequest({ kind: 'plan_proposal', toolName: 'exit_plan_mode', plan: { title: 'Ship', steps: ['a', { title: 'b' }], summary: 'two steps' } }),
    ['[plan] Ship', '  1. a', '  2. b', '  two steps']);
  assert.deepEqual(formatRequest({ kind: 'user_questions', questions: [{ id: 'q' }] }), ['[questions] Jenny asks 1 question (an empty answer declines)']);
  assert.equal(formatRequest({ kind: 'tool_approval', toolName: 'x', input: 'y'.repeat(700) })[1].length, '  input: '.length + 600);
  assert.deepEqual(formatQuestion({ id: 'q1', prompt: 'Which?', options: ['alpha', 'beta'], multi_select: true, allow_other: true }, 1),
    ['1. Which?', '   1) alpha', '   2) beta', '   (numbers, comma-separated or your own answer)']);
  assert.deepEqual(formatQuestion({ id: 'q2', prompt: 'Name?', options: [] }, 2), ['2. Name?']);

  assert.equal(choiceLegend({}), '[y]es once / [r]un: allow for the rest of this run / [n]o');
  assert.equal(choiceLegend({ oneOff: true }), '[y]es once / [n]o');
  assert.equal(choiceLegend({ plan: true }), '[y]es, proceed with this plan / [n]o');
  for (const [typed, expected] of [['y', 'allow'], ['YES', 'allow'], ['r', 'allow_run'], ['always', 'allow_run'], ['n', 'deny'], ['deny', 'deny'], ['', null], ['maybe', null]]) {
    assert.equal(parseChoice(typed), expected, typed);
  }
  assert.equal(parseChoice('r', { oneOff: true }), 'allow', 'a one-off call is never remembered');
  assert.equal(parseChoice('run', { plan: true }), 'allow');

  const single = { id: 'q', prompt: 'p', options: ['alpha', 'beta'] };
  assert.equal(parseAnswer('2', single), 'beta');
  assert.equal(parseAnswer('Alpha', single), 'alpha');
  assert.equal(parseAnswer('3', single), null);
  assert.equal(parseAnswer('gamma', single), null);
  assert.equal(parseAnswer('', single), null);
  assert.equal(parseAnswer('gamma', { ...single, allow_other: true }), 'gamma');
  assert.deepEqual(parseAnswer('1, beta, 1', { ...single, multi_select: true }), ['alpha', 'beta']);
  assert.equal(parseAnswer('  free text  ', { id: 'f', prompt: 'p' }), 'free text');
});

test('interactive: a replay sitting in a real pty: banner, approval at the terminal, streamed reply, a question answered, slash commands, /exit', { timeout: 180_000 }, async (t) => {
  const dirs = tempRoot(t);
  const replay = replayScript(dirs.root, { calls: [
    { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'fixture.txt' } }] },
    { text: 'The fixture says 7e3a.' },
    { tool_calls: [{ tool_id: 'ask_user', arguments: { questions: [{ id: 'q1', prompt: 'Which one?', options: ['alpha', 'beta'] }] } }] },
    { text: 'You chose well.' },
  ] });
  const tty = spawnInteractive(t, [], { dirs, replay });
  await tty.waitFor(/\/exit or Ctrl-D quits/u);
  assert.match(tty.text(), /permissions: ask · allowed: none pre-allowed/u);
  tty.write('/help\r');
  await tty.waitFor(/\/allowed +the tools allowed/u);
  tty.write('/session\r');
  await tty.waitFor(/\[session\] \(none yet/u);

  tty.write('Read the fixture.\r');
  await tty.waitFor(/\[approval\] read_file/u);
  await tty.waitFor(/\[y\]es once \/ \[r\]un/u);
  tty.write('r\r');
  await tty.waitFor(/\[allowed for this run\] read_file/u);
  await tty.waitFor(/\[tool\] read_file/u);
  await tty.waitFor(/The fixture says 7e3a\./u);
  await tty.waitFor(/\[done\] 1 turn/u);
  tty.write('/allowed\r');
  await tty.waitFor(/\[allowed\] launch policy: none; this run: read_file/u);

  tty.write('Ask me.\r');
  await tty.waitFor(/\[questions\] Jenny asks 1 question/u);
  await tty.waitFor(/2\) beta/u);
  tty.write('2\r');
  await tty.waitFor(/\[answered\]/u);
  await tty.waitFor(/You chose well\./u);
  await tty.waitFor(/\[done\] 1 turn/u, { times: 2 });
  tty.write('/session\r');
  await tty.waitFor(/\[session\] (?!\(none)\S+/u);
  const sessionLine = tty.text().match(/\[session\] (?!\(none)(\S+)/u);
  assert.ok(sessionLine, 'the sitting has one session');

  tty.write('/exit\r');
  assert.equal(await tty.exit, EXIT_CODES.OK, tty.text().slice(-800));
  assert.equal(tty.count(/\[deny\]/u), 0, 'nothing was denied by policy');
});

test('interactive: Ctrl-C cancels the running turn and the prompt returns; Ctrl-D ends the sitting with exit 0', { timeout: 180_000 }, async (t) => {
  const dirs = tempRoot(t);
  const replay = replayScript(dirs.root, { delay_ms: 2500, calls: [{ text: 'slow answer streams in pieces' }] });
  const tty = spawnInteractive(t, ['--allowed-tools', 'read_file'], { dirs, replay });
  await tty.waitFor(/\/exit or Ctrl-D quits/u);
  assert.match(tty.text(), /allowed: read_file/u);
  tty.write('Take your time.\r');
  await tty.waitFor(/slow/u);
  tty.write('\u0003');
  await tty.waitFor(/\[cancel\] SIGINT: stopping the run/u);
  await tty.waitFor(/\[cancelled\] exit 130/u);
  // The loop is still alive after the cancel: a command answers.
  tty.write('/session\r');
  await tty.waitFor(/\[session\] (?!\(none)\S+/u);
  tty.write('\u0004');
  assert.equal(await tty.exit, EXIT_CODES.OK, tty.text().slice(-800));
});
