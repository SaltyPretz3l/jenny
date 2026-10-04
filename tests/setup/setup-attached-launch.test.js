'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { EXIT, runSetup } = require('../../scripts/setup/setup');
const { baseDeps, makeUi } = require('../helpers/setup-orchestrator-fixture');

test('attached setup launch rejects an immediate application failure', async () => {
  const code = await runSetup({
    argv: ['--existing-server', '--yes'], platform: 'darwin', nodeVersion: '22.23.2',
    ui: makeUi(), deps: baseDeps({
      runStreaming: async (_command, args) => ({ status: args[0] === 'run' ? 1 : 0 }),
    }),
  });
  assert.equal(code, EXIT.UNKNOWN);
});

test('attached setup treats a non-zero exit long after launch as the app closing', async () => {
  let now = 0;
  const code = await runSetup({
    argv: ['--existing-server', '--yes'], platform: 'darwin', nodeVersion: '22.23.2',
    ui: makeUi(), deps: baseDeps({
      nowMs: () => now,
      runStreaming: async (_command, args) => {
        if (args[0] === 'run') now += 60 * 60 * 1000;
        return { status: args[0] === 'run' ? 130 : 0 };
      },
    }),
  });
  assert.notEqual(code, EXIT.UNKNOWN);
});
