'use strict';

// Row 64: the bundled /review skill registers through the skill seam and may only name real tools,
// report_findings among them.

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

function loadCatalog() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-review-skill-'));
  trackDirectory(userDataPath);
  const service = new SkillsService({
    configService: new ShellConfigService({ userDataPath }),
    bundledRoot: path.resolve(__dirname, '..', 'skills'),
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
  });
  return service.getState();
}

test('the bundled review skill is /review, read-only, and reports through report_findings', async (t) => {
  const catalog = loadCatalog();
  const entry = catalog.entries.find((item) => item.id === 'bundled/review');
  assert.ok(entry);
  assert.equal(entry.name, 'Code Review');
  assert.equal(entry.command, 'review');
  assert.equal(entry.enabled, true);
  const manifest = require('../services/tools/tool-manifest.json');
  assert.ok(entry.allowedTools.includes('report_findings'));
  for (const name of entry.allowedTools) {
    const tool = manifest.tools.find((item) => item.name === name);
    assert.ok(tool, `unknown tool ${name}`);
    assert.equal(tool.read_only, true, `${name} is read-only`);
  }

  const state = { currentSessionId: 'review-session', ui: {}, composerSessionState: new Map() };
  const registry = createSlashCommandRegistry({ state });
  const manager = createSkillSlashCommands({ registry, getSkillsState: () => catalog });
  t.after(() => manager.dispose());
  await manager.refresh();
  assert.ok(registry.listCommands().some((command) => command.name === '/review'));
  const chatInput = { value: '/review src/cart.js', focus() {} };
  const dispatch = createSendSlashDispatch({ state, registry, chatInput });
  t.after(() => dispatch.dispose());
  const result = await dispatch.dispatch(chatInput.value, {});
  assert.equal(result.handled, false);
  assert.equal(result.prompt, 'src/cart.js');
  assert.equal(result.settings.skillInvocation.id, 'bundled/review');
});

test('the skill body tells the model to call report_findings once and not repeat the findings', () => {
  const body = fs.readFileSync(path.resolve(__dirname, '..', 'skills', 'review', 'SKILL.md'), 'utf8');
  assert.match(body, /Call `report_findings` once/);
  assert.match(body, /Do not repeat them/);
  assert.match(body, /Do not report style, formatting/);
});
