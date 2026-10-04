const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSendArgs,
  modeMismatch,
  runSend,
  runModel,
} = require('../scripts/eval/dogfood/dogfood-cdp');

// A stand-in for the CDP page: answers the run-mode probe, records every
// expression, and never touches a renderer.
function fakeDeps({ mode = 'auto', sendResult = true, selection = { value: 'ornith', label: 'ornith' } } = {}) {
  const calls = { evaluated: [], sent: [], baselines: 0, log: [], error: [] };
  const deps = {
    calls,
    readTextArg: (arg) => {
      if (!arg) throw new Error('missing text');
      return arg;
    },
    recordBaseline: async () => { calls.baselines += 1; },
    log: (line) => calls.log.push(line),
    error: (line) => calls.error.push(line),
    evaluate: async (expression) => {
      calls.evaluated.push(expression);
      if (expression.includes('sendPrompt(')) {
        calls.sent.push(expression);
        return sendResult;
      }
      if (expression.includes('return runMode()')) return mode;
      if (expression.includes('selectedOptions[0]')) return selection;
      if (expression.includes('composerModelSelect')) return 'selected picked';
      throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
    },
  };
  return deps;
}

test('send arguments: --mode may sit anywhere, the text and seconds stay positional', () => {
  assert.deepEqual(parseSendArgs(['@p.txt']), { positional: ['@p.txt'], expectedMode: '' });
  assert.deepEqual(parseSendArgs(['@p.txt', '--mode', 'auto']), { positional: ['@p.txt'], expectedMode: 'auto' });
  assert.deepEqual(parseSendArgs(['--mode', 'Plan', '@p.txt', '600']), { positional: ['@p.txt', '600'], expectedMode: 'plan' });
  assert.throws(() => parseSendArgs(['@p.txt', '--mode']), /--mode needs one of ask\|auto\|plan/);
  assert.throws(() => parseSendArgs(['@p.txt', '--mode', 'build']), /--mode needs one of/);
});

test('mode mismatch names both modes and the fix; a match or no expectation is fine', () => {
  assert.equal(modeMismatch('', 'plan'), '');
  assert.equal(modeMismatch('auto', 'auto'), '');
  assert.match(modeMismatch('auto', 'plan'), /in plan mode, not auto; nothing was sent \(run set-mode auto first\)/);
});

// DE-009: a new chat came up in Plan mode and two prompts went out read-only.
test('send --mode refuses with exit 2 and sends nothing when the chat is in another mode', async () => {
  const deps = fakeDeps({ mode: 'plan' });
  const code = await runSend(['fix the test', '--mode', 'auto'], deps);
  assert.equal(code, 2);
  assert.equal(deps.calls.sent.length, 0);
  assert.equal(deps.calls.baselines, 0);
  assert.match(deps.calls.error[0], /in plan mode, not auto/);
});

test('send --mode sends when the chat is already in that mode and prints the mode', async () => {
  const deps = fakeDeps({ mode: 'auto' });
  assert.equal(await runSend(['fix the test', '--mode', 'auto'], deps), 0);
  assert.equal(deps.calls.sent.length, 1);
  assert.match(deps.calls.sent[0], /sendPrompt\("fix the test"\)/);
  assert.deepEqual(deps.calls.log, ['sent (mode auto)']);
});

test('send without --mode keeps working and tells the driver which mode it sent in', async () => {
  const deps = fakeDeps({ mode: 'plan' });
  assert.equal(await runSend(['hello'], deps), 0);
  assert.equal(deps.calls.sent.length, 1);
  assert.equal(deps.calls.baselines, 1);
  assert.deepEqual(deps.calls.log, ['sent (mode plan)']);
});

test('send reports a composer that did not take the prompt', async () => {
  const deps = fakeDeps({ mode: 'ask', sendResult: false });
  assert.equal(await runSend(['hello'], deps), 1);
  assert.deepEqual(deps.calls.log, ['not sent (no composer?) (mode ask)']);
});

// DE-006: `model` with no argument matched the empty-valued "Use default"
// option and switched the owner's chat to it.
test('a bare model prints the current selection and changes nothing', async () => {
  for (const args of [[], [''], ['  ']]) {
    const deps = fakeDeps({ selection: { value: 'ornith-1.5-9b-q6_k', label: 'ornith-1.5-9b-q6_k' } });
    assert.equal(await runModel(args, deps), 0);
    assert.deepEqual(deps.calls.log, ['{"value":"ornith-1.5-9b-q6_k","label":"ornith-1.5-9b-q6_k"}']);
    assert.equal(deps.calls.evaluated.length, 1);
    assert.doesNotMatch(deps.calls.evaluated[0], /dispatchEvent|s\.value =/);
  }
});

test('model <id> still selects that option', async () => {
  const deps = fakeDeps();
  assert.equal(await runModel(['gpt-6-luna'], deps), 0);
  assert.match(deps.calls.evaluated[0], /x\.value === "gpt-6-luna"/);
  assert.match(deps.calls.evaluated[0], /dispatchEvent\(new Event\('change'/);
  assert.deepEqual(deps.calls.log, ['selected picked']);
});
