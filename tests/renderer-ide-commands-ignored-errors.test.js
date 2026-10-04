'use strict';

// Palette commands call into other controllers; renderer-ide-commands contains a
// throw (the palette must stay usable) but forwards it to the client log at
// debug level instead of swallowing it silently (catch pruning, 2026-09-25).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeCommands } = require('../renderer/features/renderer-ide-commands');

test('a throwing palette command or editor action is contained but logged at debug level', () => {
  const logs = [];
  const commands = createIdeCommands({
    getActiveView: () => 'ide',
    editorHost: { runAction: () => { throw new Error('monaco not ready'); } },
    openFileMap: () => { throw new Error('map offline'); },
    appendClientLog: (level, event, details) => { logs.push({ level, event, details }); },
  });
  const byId = Object.fromEntries(commands.getCommandItems().map((i) => [i.id, i]));
  assert.doesNotThrow(() => byId['ide:open-file-map'].run());
  assert.doesNotThrow(() => byId['ide:format-document'].run());
  assert.deepEqual(logs.map((entry) => [entry.level, entry.event, entry.details.site, entry.details.error]), [
    ['DEBUG', 'ide.command_ignored_error', 'openFileMap', 'map offline'],
    ['DEBUG', 'ide.command_ignored_error', 'editor.action.formatDocument', 'monaco not ready'],
  ]);
});
