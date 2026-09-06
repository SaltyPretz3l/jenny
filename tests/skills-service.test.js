const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const {
  SkillsService,
  buildEntryFromFile,
  listSkillFiles,
  parseFrontmatter,
} = require('../services/skills-service');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function writeSkill(rootPath, skillDirName, content) {
  const skillDir = path.join(rootPath, skillDirName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
}

test('skills service resolves scopes, parses metadata, and blocks project scope without a workspace root', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-'));
  const bundledRoot = path.join(userDataPath, '.companion', 'skills');
  trackDirectory(userDataPath);
  fs.mkdirSync(bundledRoot, { recursive: true });
  writeSkill(
    bundledRoot,
    'ops',
    [
      '---',
      'name: Health Checks',
      'description: Validate local services before responding.',
      'whenToUse: When the user asks for runtime diagnosis.',
      'allowedTools:',
      '  - read_file',
      '  - web_search',
      'metadata:',
      '  nanobot:',
      '    always: true',
      '---',
      'Run health checks.',
      '',
    ].join('\n')
  );

  const configService = new ShellConfigService({ userDataPath });
  configService.updateSkillsSettings({ projectEnabled: true });
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
  });

  const state = service.getState();

  assert.equal(state.featureEnabled, true);
  assert.equal(state.counts.total, 1);
  assert.equal(state.entries[0]?.id, 'bundled/ops');
  assert.equal(state.entries[0]?.enabled, true);
  assert.equal(state.scopes.find((scope) => scope.scope === 'bundled')?.entries[0]?.name, 'Health Checks');
  assert.deepEqual(
    state.scopes.find((scope) => scope.scope === 'bundled')?.entries[0]?.allowedTools,
    ['read_file', 'web_search']
  );
  assert.equal(
    state.scopes.find((scope) => scope.scope === 'project')?.status,
    'blocked'
  );
});

test('skills service normalizes legacy allowed tool aliases to canonical runtime ids', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-aliases-'));
  const bundledRoot = path.join(userDataPath, 'bundled-skills');
  trackDirectory(userDataPath);
  fs.mkdirSync(bundledRoot, { recursive: true });
  writeSkill(
    bundledRoot,
    'aliases',
    [
      '---',
      'name: Alias Skill',
      'allowedTools:',
      '  - bash',
      '  - glob',
      '  - grep',
      '---',
      'Body',
      '',
    ].join('\n')
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
  assert.deepEqual(state.entries[0]?.allowedTools, ['run_command', 'glob_files', 'grep_search']);
});

test('skill frontmatter does not treat unrelated YAML lists as allowed tools', () => {
  const metadata = parseFrontmatter([
    'name: Demo',
    'tags:',
    '  - edit_file',
  ].join('\n'));

  assert.deepEqual(metadata.allowedTools, []);
});

test('skill always metadata prefers Jenny and accepts the Nanobot alias', () => {
  const parseAlways = (lines) => parseFrontmatter(['metadata:', ...lines].join('\n')).always;
  assert.equal(parseAlways(['  jenny:', '    always: true']), true);
  assert.equal(parseAlways(['  nanobot:', '    always: true']), true);
  assert.equal(parseAlways([
    '  nanobot:', '    always: true', '  jenny:', '    always: false',
  ]), false);
});

test('skills discovery enforces per-scope count and depth bounds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-bounds-'));
  trackDirectory(root);
  writeSkill(root, 'one', '---\nname: One\n---\nBody');
  writeSkill(root, path.join('a', 'b', 'c'), '---\nname: Deep\n---\nBody');

  assert.equal(listSkillFiles(root, { maxFiles: 1, maxDepth: 4 }).length, 1);
  assert.equal(listSkillFiles(root, { maxFiles: 10, maxDepth: 1 }).length, 1);
  assert.equal(listSkillFiles(root, { maxFiles: 10, maxDepth: 4 }).length, 2);
  assert.equal(listSkillFiles(root, { maxFiles: 10, maxDepth: 0 }).length, 0);
  assert.equal(listSkillFiles(root, { maxFiles: null, maxDepth: null }).length, 2);
});

test('skills discovery selects a deterministic bounded subset', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-deterministic-'));
  trackDirectory(root);
  ['zeta', 'alpha', 'middle'].forEach((name) => writeSkill(root, name, `---\nname: ${name}\n---\nBody`));

  const selected = listSkillFiles(root, { maxFiles: 2, maxDepth: 4 })
    .map((filePath) => path.basename(path.dirname(filePath)));

  assert.deepEqual(selected, ['alpha', 'middle']);
});

test('skills discovery never lets non-finite bounds exceed production ceilings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-ceiling-'));
  trackDirectory(root);
  for (let index = 0; index < 130; index += 1) {
    writeSkill(root, `skill-${String(index).padStart(3, '0')}`, `---\nname: ${index}\n---\nBody`);
  }

  assert.equal(listSkillFiles(root, { maxFiles: Infinity, maxDepth: Infinity }).length, 128);
});

test('skills discovery rejects a candidate whose real path escapes its source root', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-containment-'));
  const bundledRoot = path.join(userDataPath, 'bundled-skills');
  trackDirectory(userDataPath);
  fs.mkdirSync(bundledRoot, { recursive: true });
  writeSkill(bundledRoot, 'escape', '---\nname: Escape\n---\nBody');
  const configService = new ShellConfigService({ userDataPath });
  const realRoot = path.resolve(bundledRoot);
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
    realpathImpl(targetPath) {
      return targetPath === bundledRoot
        ? realRoot
        : path.resolve(userDataPath, 'outside', 'SKILL.md');
    },
  });

  const bundled = service.getState().scopes.find((scope) => scope.scope === 'bundled');
  assert.deepEqual(bundled.entries, []);
  assert.equal(bundled.warnings[0]?.code, 'skill_read_failed');
});

test('skills discovery reads the contained real path while retaining the lexical display path', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-validated-open-'));
  const bundledRoot = path.join(userDataPath, 'bundled-skills');
  trackDirectory(userDataPath);
  fs.mkdirSync(bundledRoot, { recursive: true });
  writeSkill(bundledRoot, 'safe', '---\nname: Safe\n---\nBody');
  const lexicalPath = path.join(bundledRoot, 'safe', 'SKILL.md');
  const validatedPath = path.join(bundledRoot, 'validated', 'SKILL.md');
  const observed = [];
  const configService = new ShellConfigService({ userDataPath });
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
    realpathImpl(targetPath) {
      if (targetPath === bundledRoot) return path.resolve(bundledRoot);
      if (targetPath === lexicalPath) return validatedPath;
      return path.resolve(targetPath);
    },
    buildEntryFromFileImpl(scope, rootPath, openedPath, _realpathImpl, _readFileImpl, displayPath) {
      observed.push({ openedPath, displayPath });
      return {
        scope,
        name: 'Safe',
        description: '',
        whenToUse: '',
        allowedTools: [],
        always: false,
        body: '',
        path: displayPath,
        realPath: openedPath,
        relPath: path.relative(rootPath, openedPath),
      };
    },
  });

  const state = service.getState();
  assert.equal(state.entries.length, 1);
  assert.ok(observed.length >= 1);
  assert.ok(observed.every((entry) => (
    entry.openedPath === validatedPath && entry.displayPath === lexicalPath
  )));
  assert.equal(state.entries[0].path, lexicalPath);
});

test('skills service dedupes skill files by real path across scopes', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-dedupe-'));
  trackDirectory(userDataPath);
  const configService = new ShellConfigService({ userDataPath });
  const sharedRoot = path.join(userDataPath, '.companion', 'skills');
  fs.mkdirSync(sharedRoot, { recursive: true });
  writeSkill(
    sharedRoot,
    'shared',
    ['---', 'name: Shared Skill', 'description: Shared copy.', '---', 'Body', ''].join('\n')
  );

  const service = new SkillsService({
    configService,
    bundledRoot: sharedRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
  });

  const state = service.getState();

  assert.equal(state.counts.total, 1);
  assert.equal(state.scopes.find((scope) => scope.scope === 'bundled')?.entries.length, 1);
  assert.equal(state.scopes.find((scope) => scope.scope === 'user')?.entries.length, 0);
});

test('skills service creates missing user scope folders when opening them', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-open-'));
  trackDirectory(userDataPath);
  const openedPaths = [];
  const configService = new ShellConfigService({ userDataPath });
  const service = new SkillsService({
    configService,
    bundledRoot: path.join(userDataPath, 'bundled-skills'),
    homedir: () => userDataPath,
    openPathImpl: async (targetPath) => {
      openedPaths.push(targetPath);
      return '';
    },
    featureEnabled: true,
  });

  await service.openScopeFolder('user');

  const expectedPath = path.join(userDataPath, '.companion', 'skills');
  assert.equal(openedPaths[0], expectedPath);
  assert.equal(fs.existsSync(expectedPath), true);
});

test('skills service refreshes for transactional workspace-root apply and rollback', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-root-transaction-'));
  trackDirectory(userDataPath);
  const service = new SkillsService({
    configService: new ShellConfigService({ userDataPath }),
    bundledRoot: path.join(userDataPath, 'bundled-skills'),
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
  });
  const reasons = [];
  service.refreshState = ({ reason }) => { reasons.push(reason); };

  service._handleConfigChanged({}, { reason: 'workspace_root_transaction_applied' });
  service._handleConfigChanged({}, { reason: 'workspace_root_transaction_rolled_back' });

  assert.deepEqual(reasons, [
    'workspace_root_transaction_applied',
    'workspace_root_transaction_rolled_back',
  ]);
  service.dispose();
});

test('skills service excludes disabled scope entries from visible inventory counts', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-disabled-'));
  const workspaceRoot = path.join(userDataPath, 'workspace');
  const bundledRoot = path.join(userDataPath, 'bundled-skills');
  const userRoot = path.join(userDataPath, '.companion', 'skills');
  const projectRoot = path.join(workspaceRoot, '.jenny', 'skills');
  trackDirectory(userDataPath);
  fs.mkdirSync(bundledRoot, { recursive: true });
  fs.mkdirSync(userRoot, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  writeSkill(userRoot, 'user-skill', ['---', 'name: User Skill', '---', 'Body', ''].join('\n'));
  writeSkill(projectRoot, 'project-skill', ['---', 'name: Project Skill', '---', 'Body', ''].join('\n'));

  const configService = new ShellConfigService({ userDataPath });
  configService.setToolsWorkspaceRoot(workspaceRoot);
  configService.updateSkillsSettings({
    bundledEnabled: true,
    userEnabled: false,
    projectEnabled: false,
  });
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
  });

  const state = service.getState();

  assert.equal(state.counts.total, 0);
  assert.deepEqual(state.entries.map((entry) => entry.name), []);
  assert.equal(state.scopes.find((scope) => scope.scope === 'user')?.status, 'disabled');
  assert.equal(state.scopes.find((scope) => scope.scope === 'user')?.entries.length, 0);
  assert.equal(state.scopes.find((scope) => scope.scope === 'project')?.status, 'disabled');
  assert.equal(state.scopes.find((scope) => scope.scope === 'project')?.entries.length, 0);
});

test('skills service reports non-empty shell openPath results as folder-open failures', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-open-fail-'));
  trackDirectory(userDataPath);
  const configService = new ShellConfigService({ userDataPath });
  const service = new SkillsService({
    configService,
    bundledRoot: path.join(userDataPath, 'bundled-skills'),
    homedir: () => userDataPath,
    openPathImpl: async () => 'simulated shell.openPath failure',
    featureEnabled: true,
    watchIntervalMs: 0,
  });

  await assert.rejects(
    () => service.openScopeFolder('user'),
    /simulated shell\.openPath failure/i
  );
});

test('skills service skips bad skill entries and surfaces warnings for surviving state', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-warnings-'));
  const bundledRoot = path.join(userDataPath, 'bundled-skills');
  trackDirectory(userDataPath);
  fs.mkdirSync(bundledRoot, { recursive: true });
  writeSkill(
    bundledRoot,
    'healthy',
    ['---', 'name: Healthy Skill', 'description: Safe skill.', '---', 'Body', ''].join('\n')
  );
  writeSkill(
    bundledRoot,
    'broken',
    ['---', 'name: Broken Skill', 'description: Broken skill.', '---', 'Body', ''].join('\n')
  );

  const warnings = [];
  const configService = new ShellConfigService({ userDataPath });
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
    logger: (_level, event, details) => {
      warnings.push({ event, details });
    },
    buildEntryFromFileImpl(scope, rootPath, skillPath, realpathImpl, readFileImpl) {
      if (skillPath.includes(`${path.sep}broken${path.sep}`)) {
        throw new Error('Simulated frontmatter parse failure.');
      }
      return buildEntryFromFile(scope, rootPath, skillPath, realpathImpl, readFileImpl);
    },
    watchIntervalMs: 0,
  });

  const state = service.getState();

  assert.equal(state.counts.total, 1);
  assert.equal(state.counts.warnings, 1);
  assert.equal(state.entries[0]?.name, 'Healthy Skill');
  assert.equal(state.warnings[0]?.code, 'skill_load_failed');
  assert.match(state.warnings[0]?.message || '', /simulated frontmatter parse failure/i);
  assert.equal(
    warnings.some((entry) => entry.event === 'skills.skill_load_failed'),
    true
  );
});

test('skills service emits changed when skill folders change on disk', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-watch-'));
  const bundledRoot = path.join(userDataPath, 'bundled-skills');
  const userRoot = path.join(userDataPath, '.companion', 'skills');
  trackDirectory(userDataPath);
  fs.mkdirSync(bundledRoot, { recursive: true });
  fs.mkdirSync(userRoot, { recursive: true });

  const configService = new ShellConfigService({ userDataPath });
  configService.updateSkillsSettings({ bundledEnabled: false, userEnabled: true });
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 25,
  });

  const changedState = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      service.dispose();
      reject(new Error('Timed out waiting for skills change event.'));
    }, 1000);
    service.on('changed', (state, context) => {
      if (context?.reason !== 'skills_files_changed') {
        return;
      }
      clearTimeout(timeout);
      service.dispose();
      resolve(state);
    });
    writeSkill(
      userRoot,
      'watched',
      ['---', 'name: Watched Skill', 'description: Added later.', '---', 'Body', ''].join('\n')
    );
  });

  assert.equal(changedState.counts.total, 1);
  assert.equal(changedState.entries[0]?.name, 'Watched Skill');
});

test('unchanged skills use one stat-only walk and a changed tree reparses', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-single-walk-'));
  const userRoot = path.join(userDataPath, '.companion', 'skills');
  const skillPath = path.join(userRoot, 'watched', 'SKILL.md');
  trackDirectory(userDataPath);
  writeSkill(userRoot, 'watched', '---\nname: Before\n---\nBody');
  const configService = new ShellConfigService({ userDataPath });
  configService.updateSkillsSettings({ bundledEnabled: false, userEnabled: true });
  const walkedPaths = [];
  let skillReads = 0;
  const fsImpl = {
    existsSync: (targetPath) => fs.existsSync(targetPath),
    readdirSync: (targetPath, options) => {
      walkedPaths.push(targetPath);
      return fs.readdirSync(targetPath, options);
    },
    readFileSync: (targetPath, encoding) => {
      if (path.basename(targetPath) === 'SKILL.md') {
        skillReads += 1;
      }
      return fs.readFileSync(targetPath, encoding);
    },
    statSync: (targetPath) => fs.statSync(targetPath),
  };
  const service = new SkillsService({
    configService,
    bundledRoot: path.join(userDataPath, 'bundled-skills'),
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
    fsImpl,
    readFileImpl: fsImpl.readFileSync,
  });
  walkedPaths.length = 0;
  skillReads = 0;

  const unchanged = service.getState();

  assert.equal(unchanged.entries[0]?.name, 'Before');
  assert.deepEqual(walkedPaths, [userRoot, path.dirname(skillPath)]);
  assert.equal(skillReads, 0);

  fs.writeFileSync(skillPath, '---\nname: After Change\n---\nBody changed', 'utf8');
  walkedPaths.length = 0;
  skillReads = 0;
  const changed = service.getState();

  assert.equal(changed.entries[0]?.name, 'After Change');
  assert.deepEqual(walkedPaths, [userRoot, path.dirname(skillPath)]);
  assert.equal(skillReads, 1);
});

test('bundled skills are resolved once and reused for later refreshes', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-bundled-fixed-'));
  const bundledRoot = path.join(userDataPath, 'bundled-skills');
  trackDirectory(userDataPath);
  writeSkill(bundledRoot, 'initial', '---\nname: Initial\n---\nBody');
  const configService = new ShellConfigService({ userDataPath });
  const walkedPaths = [];
  let skillReads = 0;
  const fsImpl = {
    existsSync: (targetPath) => fs.existsSync(targetPath),
    readdirSync: (targetPath, options) => {
      walkedPaths.push(targetPath);
      return fs.readdirSync(targetPath, options);
    },
    readFileSync: (targetPath, encoding) => {
      if (path.basename(targetPath) === 'SKILL.md') {
        skillReads += 1;
      }
      return fs.readFileSync(targetPath, encoding);
    },
    statSync: (targetPath) => fs.statSync(targetPath),
  };
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
    fsImpl,
    readFileImpl: fsImpl.readFileSync,
  });
  walkedPaths.length = 0;
  skillReads = 0;
  writeSkill(bundledRoot, 'later', '---\nname: Later\n---\nBody');

  const state = service.getState();

  assert.deepEqual(state.entries.map((entry) => entry.name), ['Initial']);
  assert.deepEqual(walkedPaths, []);
  assert.equal(skillReads, 0);
});

test('F4: force:true busts the bundled skills cache so an edited/deleted skill is observed', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-bundled-force-'));
  const bundledRoot = path.join(userDataPath, 'bundled-skills');
  trackDirectory(userDataPath);
  writeSkill(bundledRoot, 'initial', '---\nname: Initial\n---\nBody');
  const configService = new ShellConfigService({ userDataPath });
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
  });

  const before = service.getState();
  assert.deepEqual(before.entries.map((entry) => entry.name), ['Initial']);

  // Simulate the dev-loop edit: add a skill and edit the existing one.
  writeSkill(bundledRoot, 'later', '---\nname: Later\n---\nBody');
  writeSkill(bundledRoot, 'initial', '---\nname: Initial Renamed\n---\nBody');

  // Without force, the memoized bundled scan/state must still be served.
  const unforced = service.getState();
  assert.deepEqual(unforced.entries.map((entry) => entry.name), ['Initial']);

  // force:true must actually observe the edits -- this is the bug: pre-fix,
  // _bundledScan/_bundledScopeState are consulted inside _buildWatchSignature
  // / _buildState below the force check, so force only bypassed the
  // signature comparison and still served the stale bundled scope.
  const forced = service.refreshState({ force: true });
  assert.deepEqual(
    forced.entries.map((entry) => entry.name).sort(),
    ['Initial Renamed', 'Later'],
    'force:true must re-scan the bundled scope, not serve the memoized one'
  );

  // Deleting the bundled root entirely must also be observable after force.
  fs.rmSync(bundledRoot, { recursive: true, force: true });
  const afterDelete = service.refreshState({ force: true });
  assert.deepEqual(afterDelete.entries, [], 'force:true must observe a deleted bundled root too');
});

test('skills service defaults the fallback poll interval to 5000 ms', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-interval-'));
  trackDirectory(userDataPath);
  const configService = new ShellConfigService({ userDataPath });
  const service = new SkillsService({
    configService,
    bundledRoot: path.join(userDataPath, 'bundled-skills'),
    homedir: () => userDataPath,
    featureEnabled: true,
  });

  assert.equal(service.watchIntervalMs, 5000);
  service.dispose();
});

test('skills service skips a second poll scan while one is in flight', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-in-flight-'));
  trackDirectory(userDataPath);
  const configService = new ShellConfigService({ userDataPath });
  const service = new SkillsService({
    configService,
    bundledRoot: path.join(userDataPath, 'bundled-skills'),
    homedir: () => userDataPath,
    featureEnabled: false,
  });
  let scans = 0;
  service._buildWatchSignature = () => {
    scans += 1;
    service._pollForChanges();
    return service._lastWatchSignature;
  };

  service._pollForChanges();

  assert.equal(scans, 1, 'the re-entrant tick does not start another scan');
  assert.equal(service._watchScanInFlight, false, 'the guard clears after the scan');
  service.dispose();
});

test('skills service polls only while the feature is enabled', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-disabled-watch-'));
  const bundledRoot = path.join(userDataPath, 'bundled-skills');
  trackDirectory(userDataPath);
  fs.mkdirSync(bundledRoot, { recursive: true });

  const configService = new ShellConfigService({ userDataPath });
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: false,
    watchIntervalMs: 25,
  });

  assert.equal(service._watchTimer, null);
  service.setFeatureEnabled(true);
  assert.notEqual(service._watchTimer, null);
  service.setFeatureEnabled(false);
  assert.equal(service._watchTimer, null);
  service.dispose();
});

test('skills service returns isolated state snapshots', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-isolated-'));
  const bundledRoot = path.join(userDataPath, 'bundled-skills');
  trackDirectory(userDataPath);
  fs.mkdirSync(bundledRoot, { recursive: true });
  writeSkill(
    bundledRoot,
    'ops',
    [
      '---',
      'name: Health Checks',
      'allowedTools:',
      '  - read_file',
      '---',
      'Body',
      '',
    ].join('\n')
  );

  const configService = new ShellConfigService({ userDataPath });
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
  });

  const firstState = service.getState();
  firstState.settings.bundledEnabled = false;
  firstState.settings.disabledSkillIds.push('bundled/ops');
  firstState.entries[0].name = 'Mutated';
  firstState.entries[0].allowedTools.push('edit_file');
  firstState.scopes[0].entries[0].body = 'Changed body';
  firstState.counts.total = 99;

  const nextState = service.getState();
  assert.equal(nextState.settings.bundledEnabled, true);
  assert.deepEqual(nextState.settings.disabledSkillIds, []);
  assert.equal(nextState.entries[0].name, 'Health Checks');
  assert.deepEqual(nextState.entries[0].allowedTools, ['read_file']);
  assert.equal(nextState.scopes[0].entries[0].body, '', 'Electron discovery never loads skill bodies');
  assert.equal(nextState.counts.total, 1);
});

test('phase7D bundled skills are pruned to the supported six', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-phase7d-'));
  trackDirectory(userDataPath);
  const configService = new ShellConfigService({ userDataPath });
  const bundledRoot = path.resolve(__dirname, '..', 'skills');
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
  });
  const expected = new Set([
    'claude_code_delegation',
    'deep_research',
    'humanizer',
    'meeting_notes',
    'mermaid-artifact-workflow',
    'verification-specialist',
  ]);
  const textOnly = new Set(['claude_code_delegation', 'deep_research', 'humanizer', 'meeting_notes']);

  const state = service.getState();
  const byDir = new Map(
    state.entries.map((entry) => [path.dirname(entry.relPath).replace(/\\/g, '/'), entry])
  );

  assert.deepEqual(new Set(byDir.keys()), expected);

  for (const dirName of expected) {
    const entry = byDir.get(dirName);
    assert.ok(entry, `expected bundled skill ${dirName}`);
    if (textOnly.has(dirName)) {
      assert.deepEqual(entry.allowedTools, [], `${dirName} should stay text-only in Phase 7`);
    }
    assert.doesNotMatch(entry.body, /thoth/i, `${dirName} should not mention Thoth`);
  }
});

test('getState reflects a settings-only change when no skill file changed', () => {
  // Regression: refreshState() memoizes on the watch signature, so getState()
  // no longer rebuilds unconditionally. entry.enabled is derived from
  // settings.disabledSkillIds inside _buildState, so a signature keyed only on
  // file stats would keep serving the stale snapshot after a skill was
  // disabled. The config 'changed' event force-refreshes, so this drives the
  // settings change WITHOUT emitting -- otherwise the force path would carry
  // the test and it would pass against the unfixed code.
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-settings-sig-'));
  const bundledRoot = path.join(userDataPath, '.companion', 'skills');
  trackDirectory(userDataPath);
  fs.mkdirSync(bundledRoot, { recursive: true });
  writeSkill(
    bundledRoot,
    'ops',
    ['---', 'name: Health Checks', '---', 'Body', ''].join('\n')
  );

  let disabledSkillIds = [];
  const configService = {
    getState: () => ({ skills: { disabledSkillIds: [...disabledSkillIds] }, toolsWorkspaceRoot: '' }),
    on: () => {},
  };
  const service = new SkillsService({
    configService,
    bundledRoot,
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
  });

  const before = service.getState();
  const opsBefore = before.entries.find((entry) => entry.id === 'bundled/ops');
  assert.ok(opsBefore, 'the bundled ops skill is discovered');
  assert.equal(opsBefore.enabled, true);
  assert.equal(before.counts.total, 1);

  // No file touched -- only the settings the service reads.
  disabledSkillIds = ['bundled/ops'];

  const after = service.getState();
  const opsAfter = after.entries.find((entry) => entry.id === 'bundled/ops');
  assert.equal(opsAfter.enabled, false, 'a settings-only change must invalidate the memoized state');
  assert.equal(after.counts.total, 0, 'counts.total only counts enabled skills');
});
