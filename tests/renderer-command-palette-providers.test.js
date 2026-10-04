'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaletteProviders } = require('../renderer/shell/renderer-command-palette-providers');

test('the palette cycles the focused session\'s transcript view and names the current and next view', (t) => {
  const previous = { controller: globalThis.rendererTranscriptViewController, utils: globalThis.rendererTranscriptViewUtils };
  const cycleCalls = [];
  globalThis.rendererTranscriptViewUtils = require('../renderer/chat/renderer-transcript-view-utils');
  globalThis.rendererTranscriptViewController = { getView: () => 'thinking', cycle: (...args) => cycleCalls.push(args) };
  t.after(() => { globalThis.rendererTranscriptViewController = previous.controller; globalThis.rendererTranscriptViewUtils = previous.utils; });
  const providers = createPaletteProviders({
    state: { ui: {}, sessions: [{ id: 'sess_a', title: 'A' }], currentSessionId: 'sess_a' },
    callbacks: { listSlashCommands: () => [], tryExecuteSlashCommand: () => {} },
  });
  const item = providers.snapshot().find((entry) => entry.id === 'action:transcript-view');
  assert.ok(item, 'the action exists for the focused session');
  assert.equal(item.group, 'Actions');
  assert.equal(item.label, 'Cycle transcript view');
  assert.equal(item.description, 'Now Thinking; next Everything');
  item.run();
  assert.deepEqual(cycleCalls, [['sess_a', { source: 'palette' }]]);

  globalThis.rendererTranscriptViewController = undefined;
  const without = createPaletteProviders({
    state: { ui: {}, sessions: [{ id: 'sess_a', title: 'A' }], currentSessionId: 'sess_a' },
    callbacks: { listSlashCommands: () => [], tryExecuteSlashCommand: () => {} },
  });
  assert.equal(without.snapshot().some((entry) => entry.id === 'action:transcript-view'), false, 'no controller, no action');
});

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

test('"Reload window" runs the guarded reload (the removed title-bar tile\'s route)', async () => {
  const reloads = [];
  const globalRef = { rendererWindowControlsUtils: { reloadWindow: (options) => { reloads.push(options); return Promise.resolve(null); } } };
  const providers = createPaletteProviders({ state: { ui: {}, sessions: [] }, globalRef });
  const item = providers.snapshot().find((entry) => entry.id === 'action:reload-window');
  assert.ok(item, 'the palette lists the reload command');
  assert.deepEqual(
    { group: item.group, label: item.label, hint: item.hint },
    { group: 'Actions', label: 'Reload window', hint: 'Ctrl Shift R' },
  );
  item.run();
  assert.equal(reloads.length, 1);
  assert.equal(reloads[0].windowRef, globalRef, 'reloads the palette\'s own window');

  const without = createPaletteProviders({ state: { ui: {}, sessions: [] }, globalRef: {} }).snapshot();
  assert.equal(without.some((entry) => entry.id === 'action:reload-window'), false, 'absent-safe: no seam, no row');
});
