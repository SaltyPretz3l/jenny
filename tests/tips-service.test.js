const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const { SkillsService } = require('../services/skills-service');
const { TipsService } = require('../services/tips-service');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createConfigService() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-tips-service-'));
  trackDirectory(userDataPath);
  return new ShellConfigService({ userDataPath });
}

function writeSkill(rootPath, skillDirName, content) {
  const skillDir = path.join(rootPath, skillDirName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
}

test('tips service disables active tips when settings are off', () => {
  const configService = createConfigService();
  configService.updateTipsSettings({ enabled: false });
  const service = new TipsService({
    configService,
    featureEnabled: true,
    skillsService: { getState: () => ({ counts: { total: 0 } }) },
    offlineIntelligenceService: { getState: () => ({ mode: 'disabled' }) },
  });

  const state = service.getState();

  assert.equal(state.featureEnabled, true);
  assert.equal(state.settings.enabled, false);
  assert.equal(state.activeTip, null);
});

test('tips service selects the least recently shown relevant tip on session initialize', () => {
  const configService = createConfigService();
  configService.setToolsWorkspaceRoot('C:/workspace');
  configService.updateTipsSettings({
    sessionCount: 4,
    historyByTipId: {
      'offline-local': 4,
      'followups-loop': 1,
    },
  });

  const service = new TipsService({
    configService,
    featureEnabled: true,
    skillsService: { getState: () => ({ counts: { total: 3 } }) },
    offlineIntelligenceService: { getState: () => ({ mode: 'disabled' }) },
  });

  const state = service.initializeSession();

  assert.equal(state.activeTip?.id, 'followups-loop');
  assert.equal(state.settings.sessionCount, 5);
  assert.equal(state.settings.historyByTipId['followups-loop'], 5);
});

test('tips service refreshes relevant tips from shell-owned state', () => {
  const configService = createConfigService();
  const service = new TipsService({
    configService,
    featureEnabled: true,
    skillsService: { getState: () => ({ counts: { total: 0 } }) },
    offlineIntelligenceService: { getState: () => ({ mode: 'disabled' }) },
  });

  const state = service.getState();

  assert.equal(
    state.relevantTips.some((tip) => tip.id === 'workspace-root'),
    true
  );
  assert.equal(
    state.relevantTips.some((tip) => tip.id === 'skills-surface'),
    true
  );
});

test('tips service refreshes for transactional workspace-root apply and rollback', () => {
  const service = new TipsService({
    configService: createConfigService(),
    featureEnabled: true,
    skillsService: { getState: () => ({ counts: { total: 0 } }) },
    offlineIntelligenceService: { getState: () => ({ mode: 'disabled' }) },
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

test('tips service still recommends skills setup when existing skills are only in disabled scopes', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-tips-service-disabled-skills-'));
  const workspaceRoot = path.join(userDataPath, 'workspace');
  const userRoot = path.join(userDataPath, '.companion', 'skills');
  const projectRoot = path.join(workspaceRoot, '.jenny', 'skills');
  trackDirectory(userDataPath);
  writeSkill(userRoot, 'user-skill', ['---', 'name: User Skill', '---', 'Body', ''].join('\n'));
  writeSkill(projectRoot, 'project-skill', ['---', 'name: Project Skill', '---', 'Body', ''].join('\n'));

  const configService = new ShellConfigService({ userDataPath });
  configService.setToolsWorkspaceRoot(workspaceRoot);
  configService.updateSkillsSettings({
    bundledEnabled: false,
    userEnabled: false,
    projectEnabled: false,
  });
  const skillsService = new SkillsService({
    configService,
    bundledRoot: path.join(userDataPath, 'bundled-skills'),
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
  });
  const service = new TipsService({
    configService,
    featureEnabled: true,
    skillsService,
    offlineIntelligenceService: { getState: () => ({ mode: 'local_only' }) },
  });

  const state = service.getState();

  assert.equal(state.relevantTips.some((tip) => tip.id === 'skills-surface'), true);
});

test('tips service enforces cooldown sessions before re-showing the same tip', () => {
  const configService = createConfigService();
  configService.setToolsWorkspaceRoot('C:/workspace');
  configService.updateTipsSettings({
    sessionCount: 1,
    historyByTipId: {
      'followups-loop': 1,
    },
  });

  const service = new TipsService({
    configService,
    featureEnabled: true,
    skillsService: { getState: () => ({ counts: { total: 1 } }) },
    offlineIntelligenceService: { getState: () => ({ mode: 'local_only' }) },
  });

  const state = service.getState();

  assert.equal(state.relevantTips.some((tip) => tip.id === 'followups-loop'), false);
  assert.equal(state.activeTip, null);
});

test('tips service recomputes and emits when skills change during a live session', async () => {
  const configService = createConfigService();
  configService.setToolsWorkspaceRoot('C:/workspace');
  configService.upsertFollowUp({
    id: 'followup-1',
    label: 'Existing loop',
    body: 'Already tracked.',
    createdAt: new Date().toISOString(),
    sessionId: 'sess-1',
  });
  const skillsService = new EventEmitter();
  let skillsCount = 0;
  skillsService.getState = () => ({ counts: { total: skillsCount } });

  const service = new TipsService({
    configService,
    featureEnabled: true,
    skillsService,
    offlineIntelligenceService: { getState: () => ({ mode: 'local_only' }) },
  });

  const initialState = service.getState();
  assert.equal(initialState.activeTip?.id, 'skills-surface');

  const changedState = await new Promise((resolve) => {
    service.on('changed', (state, context) => {
      if (context?.reason === 'skills_state_refreshed') {
        resolve(state);
      }
    });
    skillsCount = 1;
    skillsService.emit('changed', { counts: { total: skillsCount } }, { reason: 'skills_files_changed' });
  });

  assert.equal(changedState.relevantTips.some((tip) => tip.id === 'skills-surface'), false);
  assert.equal(changedState.activeTip, null);
});

test('tips service getState returns an isolated snapshot', () => {
  const configService = createConfigService();
  const service = new TipsService({
    configService,
    featureEnabled: true,
    skillsService: { getState: () => ({ counts: { total: 0 } }) },
    offlineIntelligenceService: { getState: () => ({ mode: 'disabled' }) },
  });

  const state = service.getState();
  state.settings.historyByTipId['workspace-root'] = 999;
  state.relevantTips[0].title = 'Mutated';

  const fresh = service.getState();
  assert.equal(fresh.settings.historyByTipId['workspace-root'], undefined);
  assert.notEqual(fresh.relevantTips[0]?.title, 'Mutated');
});

// Regression: registry entries carry an isRelevant() predicate and
// _resolveRelevantTips returns those entries directly, so a spread-based clone
// put the function on the wire. Electron's structured clone rejects functions,
// and tips:get-state died with "An object could not be cloned" -- which blocked
// the workspace-root setup flow on a fresh install.
// The exact serializable surface of a tip record. Asserting the key set both
// proves the isRelevant predicate is gone and catches a data field being
// dropped by the explicit pick.
const TIP_RECORD_KEYS = [
  'actionLabel',
  'body',
  'cooldownSessions',
  'id',
  'settingsSection',
  'title',
];

test('tips service getState snapshot survives the structured clone IPC seam', () => {
  const configService = createConfigService();
  const service = new TipsService({
    configService,
    featureEnabled: true,
    skillsService: { getState: () => ({ counts: { total: 0 } }) },
    offlineIntelligenceService: { getState: () => ({ mode: 'disabled' }) },
  });

  const state = service.getState();

  // Guard the fixture: a snapshot with no tips would pass vacuously.
  assert.ok(state.relevantTips.length > 0, 'fixture: expected at least one relevant tip');
  assert.equal(state.activeTip.id, 'workspace-root');
  assert.deepEqual(Object.keys(state.activeTip).sort(), TIP_RECORD_KEYS);
  for (const tip of state.relevantTips) {
    assert.deepEqual(Object.keys(tip).sort(), TIP_RECORD_KEYS);
  }
  // structuredClone is the exact algorithm Electron applies on the IPC seam:
  // deep-equal round-trip proves both that it survives and that it stays faithful.
  assert.deepEqual(structuredClone(state), state);
});

test('tips service changed-event snapshot survives the structured clone IPC seam', () => {
  const configService = createConfigService();
  const service = new TipsService({
    configService,
    featureEnabled: true,
    skillsService: { getState: () => ({ counts: { total: 0 } }) },
    offlineIntelligenceService: { getState: () => ({ mode: 'disabled' }) },
  });

  // backend-service-wiring.js forwards this snapshot to the renderer over the
  // tips.onChanged bridge event -- the path that fired when a workspace root
  // was set, because the config change refreshes tips state and re-emits.
  const emitted = [];
  service.on('changed', (snapshot) => {
    emitted.push(snapshot);
  });
  service.updateSettings({ enabled: false });
  emitted.length = 0;
  service.updateSettings({ enabled: true });

  assert.equal(emitted.length, 1);
  const snapshot = emitted[0];
  assert.ok(snapshot.relevantTips.length > 0, 'fixture: expected at least one relevant tip');
  assert.equal(snapshot.activeTip.id, 'workspace-root');
  assert.deepEqual(Object.keys(snapshot.activeTip).sort(), TIP_RECORD_KEYS);
  assert.deepEqual(structuredClone(snapshot), snapshot);
});
