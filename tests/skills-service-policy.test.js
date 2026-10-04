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


test('skills listing rejects oversized UTF-8 files and discovers depth eight', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-limits-'));
  trackDirectory(root);
  const bundledRoot = path.join(root, 'bundled');
  writeSkill(bundledRoot, 'oversized', '---\nname: Too big\n---\n' + 'x'.repeat(20 * 1024));
  writeSkill(bundledRoot, 'multibyte', '---\nname: Too big UTF-8\n---\n' + '\u00e9'.repeat(8000));
  writeSkill(bundledRoot, path.join('a', 'b', 'c', 'd', 'e', 'f', 'g', 'deep'), '---\nname: Deep\n---\nBody');
  const configService = new ShellConfigService({ userDataPath: root });
  const service = new SkillsService({ configService, bundledRoot, homedir: () => root,
    featureEnabled: true, watchIntervalMs: 0 });
  const state = service.getState();
  assert.deepEqual(state.entries.map((entry) => entry.name), ['Deep']);
  assert.equal(state.warnings.length, 2);
  assert.ok(state.warnings.every((warning) => /15|size|large/i.test(warning.message)));
});

test('skill directory enumeration stops at the entry budget and reports partial discovery', () => {
  const { listSkillFiles } = require('../services/skills-service');
  let reads = 0;
  let closed = false;
  const fsImpl = {
    existsSync: () => true,
    readdirSync: () => Array.from({ length: 10000 }, (_, i) => ({ name: String(i),
      isFile: () => false, isDirectory: () => false })),
    opendirSync: () => ({ readSync() {
      reads += 1;
      return { name: String(reads), isFile: () => false, isDirectory: () => false };
    }, closeSync() { closed = true; } }),
  };
  const files = listSkillFiles('fake-root', { fsImpl });
  assert.equal(reads, 2048);
  assert.equal(closed, true);
  assert.equal(files.partial, true);
});


test('packaged bundled skills retain ASAR directory reads on Electron 43', () => {
  const { listSkillFiles } = require('../services/skills-service');
  let opened = false;
  const files = listSkillFiles('C:/Jenny/app.asar/skills', { bundled: true, fsImpl: {
    readdirSync: () => [{ name: 'SKILL.md', isFile: () => true, isDirectory: () => false }],
    opendirSync() { opened = true; throw new Error('ASAR opendir unsupported'); },
  } });
  assert.equal(files.length, 1);
  assert.equal(opened, false);
});
