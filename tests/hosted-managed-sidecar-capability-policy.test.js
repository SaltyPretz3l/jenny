const os = require('os');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildManagedSidecarConfig,
} = require('../services/backend/managed-sidecar-config');

const HOSTED_ENABLED_TOOL_CAPABILITIES = [
  'tools_edit_file_enabled',
  'tools_glob_enabled',
  'tools_grep_enabled',
  'tools_mermaid_enabled',
];

test('hosted managed config applies an explicit closed tool capability policy', () => {
  const service = {
    hostMode: 'server',
    currentEngineType: 'replay',
    currentModel: 'replay-model',
    defaultModel: 'replay-model',
    options: {
      userDataPath: os.tmpdir(),
      modelEndpoint: { engine: 'replay', model: 'replay-model' },
    },
    featureFlags: {
      mcp_resources: true,
      repo_delta_resume: true,
      task_capsule: true,
      tools_automations_enabled: true,
      tools_home_enabled: true,
      tools_preview_test_enabled: true,
      tools_task_board_enabled: true,
      tools_verify_enabled: true,
      tools_workspace_present_enabled: true,
      workspace_manifest: true,
    },
    toolExecutor: {},
    configService: {
      getState: () => ({
        tools: {
          imageRead: true,
          lsp: true,
          pythonRuntime: true,
          richFiles: true,
          subagents: true,
          todo: true,
          web: true,
          worktree: true,
        },
      }),
      getToolsWorkspaceRoot: () => '',
    },
    skillsService: {
      getSidecarConfig: () => ({
        tools_future_enabled: true,
        tools_load_skill_enabled: true,
      }),
    },
    knowledgeService: {
      getSidecarConfig: () => ({ tools_knowledge_enabled: true }),
    },
  };

  const config = buildManagedSidecarConfig(service);
  const enabledToolCapabilities = Object.entries(config)
    .filter(([key, value]) => /^tools_.*_enabled$/.test(key) && value === true)
    .map(([key]) => key)
    .sort();

  assert.deepEqual(enabledToolCapabilities, HOSTED_ENABLED_TOOL_CAPABILITIES);
  assert.equal(config.tools_lsp_enabled, false);
  assert.equal(config.tools_web_enabled, false);
  assert.equal(config.tools_subagents_enabled, false);
  assert.equal(config.tools_subagent_batch_enabled, false);
  assert.equal(config.tools_connections_enabled, false);
  assert.equal(config.tools_load_skill_enabled, false);
  assert.equal(config.tools_future_enabled, false);
  assert.equal(config.electron_tool_bridge_enabled, true);
  assert.equal(config.repo_delta_resume_enabled, false);
});
