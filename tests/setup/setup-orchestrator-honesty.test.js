'use strict';

// Setup's user-facing honesty: hints that match setup.sh, a --skip-model summary
// that does not read as a clean success, and no claimed Ollama restart.
const test = require('node:test');
const assert = require('node:assert/strict');

const { EXIT, runSetup } = require('../../scripts/setup/setup');
const { baseDeps, makeRunCapture, makeUi } = require('../helpers/setup-orchestrator-fixture');

// Every prereq present on macOS, but Ollama is on no PATH and nothing serves.
function noOllamaRunCapture() {
  const base = makeRunCapture();
  return (cmd, args = []) => (cmd === 'which' || cmd === 'where' ? { status: 1, stdout: '' } : base(cmd, args));
}

test('the Linux Python install hint names the venv package like setup.sh does', async () => {
  const ui = makeUi();
  const code = await runSetup({
    argv: ['--no-launch'],
    platform: 'linux',
    nodeVersion: '22.23.2',
    ui,
    deps: baseDeps({ runCapture: makeRunCapture({ pythonFound: false }) }),
  });
  assert.equal(code, EXIT.PREREQ);
  assert.ok(ui.log.some(([kind, text]) => kind === 'fail' && text.includes('python3.11-venv')));
});

test('--skip-model tolerates a missing Ollama and still completes', async () => {
  const ui = makeUi();
  const code = await runSetup({
    argv: ['--no-launch', '--skip-model'],
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui,
    deps: baseDeps({
      fetchImpl: async () => ({ ok: false }),
      runCapture: noOllamaRunCapture(),
      promptYesNo: async () => false,
    }),
  });
  assert.equal(code, EXIT.OK);
  const done = ui.log.filter(([kind, text]) => /Setup (complete|finished)/.test(text));
  assert.equal(done.length, 1);
  assert.equal(done[0][0], 'warn', 'the summary must not read as a clean success');
  assert.match(done[0][1], /without a working Ollama/);
  assert.match(done[0][1], /in-app setup|re-run setup/);
  assert.doesNotMatch(done[0][1], /Setup complete/);
});

test('--skip-model without Ollama still warns when setup goes on to launch Jenny', async () => {
  const ui = makeUi();
  const code = await runSetup({
    argv: ['--skip-model'],
    platform: 'darwin',
    nodeVersion: '22.23.2',
    ui,
    deps: baseDeps({
      isDistribution: () => false,
      fetchImpl: async () => ({ ok: false }),
      runCapture: noOllamaRunCapture(),
      // Decline the Ollama install, accept the launch.
      promptYesNo: async (question) => /Launch Jenny/.test(question),
      runStreaming: async () => ({ status: 0 }),
    }),
  });
  assert.equal(code, EXIT.OK);
  assert.ok(ui.log.some(([kind, text]) => kind === 'warn' && /launched without a working Ollama/.test(text)));
});

test('the default Ollama restart never claims a restart it cannot do and tells the user to quit and re-run', async () => {
  const ui = makeUi();
  const code = await runSetup({
    argv: ['--no-launch'],
    platform: 'win32',
    nodeVersion: '22.23.2',
    ui,
    // No restartOllamaAfterUpgrade override: the real default runs.
    deps: baseDeps({
      fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.20.4' }) }),
      runStreaming: async () => ({ status: 0 }),
    }),
  });
  assert.equal(code, EXIT.OLLAMA);
  assert.ok(!ui.log.some(([, text]) => /Restarting Ollama/.test(String(text))));
  assert.ok(ui.log.some(([kind, text]) => kind === 'warn' && /Quit the running Ollama/.test(text) && /re-run setup/.test(text)));
});
