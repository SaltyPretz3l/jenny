'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ShellConfigService } = require('../services/shell-config-service');
const { SkillsService } = require('../services/skills-service');
const { createSlashCommandRegistry } = require('../renderer/shell/renderer-slash-command-registry');
const { createSkillSlashCommands, createSendSlashDispatch } = require('../renderer/chat/renderer-skill-slash-commands');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => { await cleanupTrackedResources(); });

test('real bundled po-review metadata registers and dispatches the feature through the skill seam', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-po-review-'));
  trackDirectory(userDataPath);
  const service = new SkillsService({
    configService: new ShellConfigService({ userDataPath }),
    bundledRoot: path.resolve(__dirname, '..', 'skills'),
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
  });
  const catalog = service.getState();
  const entry = catalog.entries.find((item) => item.id === 'bundled/po-review');
  assert.ok(entry);
  assert.equal(entry.name, 'Product Owner Review');
  assert.equal(entry.command, 'po-review');
  assert.equal(entry.enabled, true);
  assert.equal(entry.body, '', 'Electron discovery stays metadata-only');
  const manifest = require('../services/tools/tool-manifest.json');
  for (const name of entry.allowedTools) {
    assert.ok(manifest.tools.some((tool) => tool.name === name), `unknown tool ${name}`);
  }

  const state = { currentSessionId: 'review-session', ui: {}, composerSessionState: new Map() };
  const registry = createSlashCommandRegistry({ state });
  const manager = createSkillSlashCommands({ registry, getSkillsState: () => catalog });
  t.after(() => manager.dispose());
  await manager.refresh();
  assert.ok(registry.listCommands().some((command) => command.name === '/po-review'));
  const chatInput = { value: '/po-review calendar keyboard navigation', focus() {} };
  const dispatch = createSendSlashDispatch({ state, registry, chatInput });
  t.after(() => dispatch.dispose());
  const result = await dispatch.dispatch(chatInput.value, {});
  assert.equal(result.handled, false);
  assert.equal(result.prompt, 'calendar keyboard navigation');
  assert.equal(result.settings.skillInvocation.id, 'bundled/po-review');
  assert.equal(result.settings.skillInvocation.command, 'po-review');
});
