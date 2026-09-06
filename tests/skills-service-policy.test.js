const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const { SkillsService } = require('../services/skills-service');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

// Per-skill disable list, auto-index policy, and `/command` metadata
// (split from skills-service.test.js to stay under the 600-line ratchet).

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function writeSkill(rootPath, skillDirName, content) {
  const skillDir = path.join(rootPath, skillDirName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
}

test('skills service projects disabled ids and replaces the disable list wholesale', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-policy-'));
  const bundledRoot = path.join(userDataPath, 'bundled-skills');
  trackDirectory(userDataPath);
  writeSkill(bundledRoot, 'one', '---\nname: One\n---\nOne body.');
  writeSkill(bundledRoot, path.join('group', 'two'), '---\nname: Two\n---\nTwo body.');

  const configService = new ShellConfigService({ userDataPath });
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
  });

  let state = service.updateSettings({
    disabledSkillIds: ['bundled/one'],
    autoIndex: 'off',
  });
  assert.deepEqual(state.settings.disabledSkillIds, ['bundled/one']);
  assert.equal(state.settings.autoIndex, 'off');
  assert.deepEqual(
    state.entries.map((entry) => [entry.id, entry.enabled]),
    [['bundled/group/two', true], ['bundled/one', false]]
  );
  assert.equal(state.counts.total, 1);
  assert.deepEqual(service.getSidecarConfig().skills_disabled_ids, ['bundled/one']);
  assert.equal(service.getSidecarConfig().skills_auto_index, 'off');

  state = service.updateSettings({ disabledSkillIds: ['bundled/group/two'] });
  assert.deepEqual(state.settings.disabledSkillIds, ['bundled/group/two']);
  assert.equal(state.entries.find((entry) => entry.id === 'bundled/one')?.enabled, true);
  assert.equal(state.entries.find((entry) => entry.id === 'bundled/group/two')?.enabled, false);
});

test('skill commands expose valid metadata and fall back with warnings', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-commands-'));
  const bundledRoot = path.join(userDataPath, 'bundled-skills');
  trackDirectory(userDataPath);
  fs.mkdirSync(bundledRoot, { recursive: true });
  writeSkill(
    bundledRoot,
    'explicit_name',
    '---\nname: Explicit\ncommand: Verify-Now\n---\nBody'
  );
  writeSkill(bundledRoot, 'fallback_name', '---\nname: Fallback\n---\nBody');
  writeSkill(
    bundledRoot,
    'invalid_name',
    '---\nname: Invalid\ncommand: Bad Command!\n---\nBody'
  );

  const configService = new ShellConfigService({ userDataPath });
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
  });

  const state = service.getState();
  const byName = new Map(state.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get('Explicit')?.command, 'verify-now');
  assert.equal(byName.get('Fallback')?.command, 'fallback-name');
  assert.equal(byName.get('Invalid')?.command, 'invalid-name');
  assert.deepEqual(state.warnings.map((warning) => warning.code), ['invalid_command']);
});
