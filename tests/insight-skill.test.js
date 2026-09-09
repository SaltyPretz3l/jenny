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

test('bundled insight registers and dispatches a retrospective without execution tools', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-insight-'));
  trackDirectory(userDataPath);
  const service = new SkillsService({
    configService: new ShellConfigService({ userDataPath }),
    bundledRoot: path.resolve(__dirname, '..', 'skills'),
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
  });
  const catalog = service.getState();
  const entry = catalog.entries.find((item) => item.id === 'bundled/insight');
  assert.ok(entry);
  assert.equal(entry.name, 'Harness Insight');
  assert.equal(entry.command, 'insight');
  assert.equal(entry.enabled, true);
  assert.deepEqual(entry.allowedTools, []);
  assert.equal(entry.body, '', 'discovery remains metadata-only');

  const state = { currentSessionId: 'insight-session', ui: {}, composerSessionState: new Map() };
  const registry = createSlashCommandRegistry({ state });
  const manager = createSkillSlashCommands({ registry, getSkillsState: () => catalog });
  t.after(() => manager.dispose());
  await manager.refresh();
  assert.ok(registry.listCommands().some((command) => command.name === '/insight'));
  const chatInput = { value: '/insight focus on recovery after tool failures', focus() {} };
  const dispatch = createSendSlashDispatch({ state, registry, chatInput });
  t.after(() => dispatch.dispose());
  const result = await dispatch.dispatch(chatInput.value, {});
  assert.equal(result.handled, false);
  assert.equal(result.prompt, 'focus on recovery after tool failures');
  assert.equal(result.settings.skillInvocation.id, 'bundled/insight');
  assert.equal(result.settings.skillInvocation.command, 'insight');

  // Prompt contract checks, not proof that any particular model follows it.
  const body = fs.readFileSync(entry.realPath, 'utf8');
  assert.match(body, /Do not run commands/);
  assert.match(body, /suspected causes/);
  assert.match(body, /Model\/tool use/);
  assert.match(body, /earlier assistant summaries/);
  assert.match(body, /not hidden chain-of-thought/);
  assert.match(body, /Do not manufacture criticism or praise/);
});
