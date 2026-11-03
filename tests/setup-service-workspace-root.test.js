/* Setup workspace-step tests split from tests/setup-service.test.js at the
 * file-size ceiling: a cleared workspace root reopens a 'done' step. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { SetupService } = require('../services/setup-service');
const { createConfigService } = require('./helpers/setup-service-test-support');

test('a cleared workspace root reopens a done workspace step until a folder is chosen again', async () => {
  // Regression (2026-11-01): deleting the current project cleared the root but
  // the step stayed 'done', so the hub showed every step finished while
  // complete() kept refusing and the empty-chat setup hero never went away.
  const logEvents = [];
  const configService = createConfigService({
    setup: {
      seen: true,
      setupComplete: false,
      firstRunCompleted: true,
      completedAt: '2026-10-13T21:09:34.043Z',
      steps: {
        acknowledgement: 'done',
        workspaceRoot: 'done',
        localModel: 'done',
        endpoint: 'done',
        personality: 'done',
        skills: 'done',
        capabilities: 'done',
      },
    },
    toolsWorkspaceRoot: '',
  });
  const service = new SetupService({
    configService,
    mcpToolsDiscoveredProvider: () => false,
    readinessProvider: async () => ({ remote_endpoint_available: true, runtime_engine: 'openai-compatible' }),
    logger: (level, event, details) => logEvents.push({ level, event, details }),
  });

  const cleared = await service.refreshReadiness();
  assert.equal(cleared.setup_complete, false);
  assert.equal(cleared.setup_state.steps.workspace_root, 'pending');
  assert.equal(configService.getSetupState().steps.workspaceRoot, 'pending', 'the reopened step is persisted');

  const rejected = await service.complete();
  assert.equal(rejected.setup_complete, false);
  const rejection = logEvents.find((entry) => entry.event === 'setup.complete_rejected');
  assert.deepEqual(rejection.details.pending_steps, ['workspaceRoot'], 'the refusal names the folder');

  configService.setToolsWorkspaceRoot('C:/dev/jenny');
  assert.equal(service.getState().setup_state.steps.workspace_root, 'done');
  assert.equal((await service.complete()).setup_complete, true);
  assert.equal(configService.getSetupState().setupComplete, true);
});

test('a skipped workspace step stays skipped when no folder is configured', () => {
  const configService = createConfigService({
    setup: { steps: { workspaceRoot: 'skipped', localModel: 'done' } },
    toolsWorkspaceRoot: '',
  });
  const service = new SetupService({ configService, mcpToolsDiscoveredProvider: () => false });

  assert.equal(service.getState().setup_state.steps.workspace_root, 'skipped');
  assert.equal(configService.getSetupState().steps.workspaceRoot, 'skipped');
});
