'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaletteProviders } = require('../renderer/shell/renderer-command-palette-providers');

test('skill palette rows precede slash commands and attach through slash execution', () => {
  const calls = [];
  const providers = createPaletteProviders({
    state: { ui: {}, sessions: [] },
    callbacks: {
      listSlashCommands: () => [
        { name: '/help', action: 'run', actionLabel: 'Run', description: 'List commands', available: true },
        {
          name: '/verify', action: 'attach', actionLabel: 'Attach', description: 'Check evidence', available: true,
          skill: { id: 'bundled/verify', name: 'Verification specialist', scope: 'bundled', command: 'verify' },
        },
      ],
      tryExecuteSlashCommand: (prompt) => calls.push(prompt),
    },
  });
  const items = providers.snapshot();
  const skill = items.find((item) => item.id === 'skill:bundled/verify');
  const slash = items.find((item) => item.id === 'slash:/help');
  assert.deepEqual(
    { group: skill.group, label: skill.label, description: skill.description, hint: skill.hint },
    { group: 'Skills', label: '/verify', description: 'Verification specialist \u2014 Check evidence', hint: 'Attach' }
  );
  assert.ok(items.indexOf(skill) < items.indexOf(slash));
  skill.run();
  assert.deepEqual(calls, ['/verify']);
  assert.equal(items.some((item) => item.id === 'slash:/verify'), false);
});
