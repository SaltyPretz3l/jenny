const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');
const {
  createManagedService,
  createManagedServiceWithConfig,
} = require('../helpers/managed-sidecar-runtime-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar config keeps tools blocked until a workspace root is explicitly set', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-config-'));
  trackDirectory(userDataPath);

  const originalWorkspaceRoot = process.env.JENNY_TOOLS_WORKSPACE_ROOT;
  const originalOllamaModels = process.env.OLLAMA_MODELS;
  delete process.env.JENNY_TOOLS_WORKSPACE_ROOT;
  delete process.env.OLLAMA_MODELS;
  try {
    const service = createManagedService(userDataPath);
    const config = service._buildManagedSidecarConfig();
    assert.equal(config.tools_workspace_root, null);
    assert.equal(config.tools_shell_enabled, false);
    assert.equal(config.tools_todo_enabled, true);
    assert.equal(config.tools_workspace_manifest_enabled, false);
    assert.equal(config.ollama_models_dir, null);
  } finally {
    if (originalWorkspaceRoot == null) {
      delete process.env.JENNY_TOOLS_WORKSPACE_ROOT;
    } else {
      process.env.JENNY_TOOLS_WORKSPACE_ROOT = originalWorkspaceRoot;
    }
    if (originalOllamaModels == null) {
      delete process.env.OLLAMA_MODELS;
    } else {
      process.env.OLLAMA_MODELS = originalOllamaModels;
    }
  }
});

test('managed sidecar config prefers the persisted workspace root over env fallback', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-config-store-'));
  trackDirectory(userDataPath);
  const ollamaModelsDir = path.join(userDataPath, 'ollama-models');
  fs.mkdirSync(ollamaModelsDir, { recursive: true });

  const originalWorkspaceRoot = process.env.JENNY_TOOLS_WORKSPACE_ROOT;
  const originalOllamaModels = process.env.OLLAMA_MODELS;
  process.env.JENNY_TOOLS_WORKSPACE_ROOT = 'C:/env/workspace';
  process.env.OLLAMA_MODELS = ollamaModelsDir;
  try {
    const service = createManagedServiceWithConfig(userDataPath, {
      getState() {
        return {
          toolsWorkspaceRoot: 'C:/persisted/workspace',
        };
      },
    });
    const config = service._buildManagedSidecarConfig();
    assert.equal(config.tools_workspace_root, 'C:/persisted/workspace');
    assert.equal(config.tools_shell_enabled, true);
    assert.equal(config.ollama_models_dir, ollamaModelsDir);
  } finally {
    if (originalWorkspaceRoot == null) {
      delete process.env.JENNY_TOOLS_WORKSPACE_ROOT;
    } else {
      process.env.JENNY_TOOLS_WORKSPACE_ROOT = originalWorkspaceRoot;
    }
    if (originalOllamaModels == null) {
      delete process.env.OLLAMA_MODELS;
    } else {
      process.env.OLLAMA_MODELS = originalOllamaModels;
    }
  }
});

test('managed sidecar config forwards tool permission snapshot', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-policy-snapshot-'));
  trackDirectory(userDataPath);

  const snapshot = {
    version: 2,
    legacy_policies: { read_file: 'auto' },
    rules: [
      {
        id: 'deny-writes',
        decision: 'deny',
        reason: 'Writes disabled',
        match: { tool_id: 'write_file' },
      },
    ],
  };
  const service = createManagedService(userDataPath);
  service.toolPermissionStore = {
    getSnapshot() {
      return snapshot;
    },
  };

  const config = service._buildManagedSidecarConfig();

  assert.deepEqual(config.tool_policy_snapshot, snapshot);
});

test('managed runtime keeps the legacy batch input inert but compatible for one release', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-subagent-batch-'));
  trackDirectory(userDataPath);
  let subagentsEnabled = true;
  const service = createManagedServiceWithConfig(
    userDataPath,
    {
      getState() {
        return { tools: { subagents: subagentsEnabled } };
      },
    },
    { featureFlags: { subagent_batch: false } }
  );

  let config = service._buildManagedSidecarConfig();
  assert.equal(config.tools_subagents_enabled, true);
  assert.equal(config.tools_subagent_batch_enabled, false);

  service.featureFlags.subagent_batch = true;
  config = service._buildManagedSidecarConfig();
  assert.equal(config.tools_subagents_enabled, true);
  assert.equal(config.tools_subagent_batch_enabled, true);
  subagentsEnabled = false;
  config = service._buildManagedSidecarConfig();
  assert.equal(config.tools_subagents_enabled, false);
  assert.equal(config.tools_subagent_batch_enabled, false);
});

test('managed runtime defaults delegate on but preserves an explicit off preference', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-delegate-default-'));
  trackDirectory(userDataPath);
  let state = {};
  const service = createManagedServiceWithConfig(userDataPath, {
    getState() {
      return state;
    },
  });

  assert.equal(service._buildManagedSidecarConfig().tools_subagents_enabled, true);
  state = { tools: { subagents: false } };
  assert.equal(service._buildManagedSidecarConfig().tools_subagents_enabled, false);
});

test('managed sidecar config ignores an unusable OLLAMA_MODELS path', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-config-bad-ollama-models-'));
  trackDirectory(userDataPath);

  const originalOllamaModels = process.env.OLLAMA_MODELS;
  process.env.OLLAMA_MODELS = path.join(userDataPath, 'missing-ollama-models');
  try {
    const service = createManagedService(userDataPath);
    const config = service._buildManagedSidecarConfig();
    assert.equal(config.ollama_models_dir, null);
  } finally {
    if (originalOllamaModels == null) {
      delete process.env.OLLAMA_MODELS;
    } else {
      process.env.OLLAMA_MODELS = originalOllamaModels;
    }
  }
});

test('managed sidecar config forwards the personality workspace root when available', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-config-personality-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  service.personalityWorkspace = {
    workspacePath: 'C:/Users/test/AppData/Roaming/Jenny/personality',
  };

  const config = service._buildManagedSidecarConfig();

  // Personality v3: the sidecar never read this key; Electron no longer sends it.
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'personality_workspace_root'), false);
  assert.equal(
    config.background_runtime_root,
    path.join(userDataPath, 'background-memory')
  );
});

test('managed sidecar config forwards hidden tool-cap and diagnostics settings when present', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-config-hidden-'));
  trackDirectory(userDataPath);

  const service = createManagedServiceWithConfig(userDataPath, {
    getState() {
      return {
        maxToolsPerTurn: 9,
        maxBudgetUsd: 42.75,
        modelTuning: { streamInactivitySecondsByModel: { 'mock-v1': 240 } },
        diagnosticsLogLevel: 'warning',
        diagnosticsCaptureMode: 'sanitized_snippets',
        ollamaRequestTimeoutSeconds: 420,
      };
    },
  });

  const config = service._buildManagedSidecarConfig();

  assert.equal(config.max_tools_per_turn, 9);
  assert.equal(config.max_budget_usd, 42.75);
  assert.equal(config.chunk_inactivity_seconds, 240);
  assert.equal(config.chunk_inactivity_seconds_is_override, true);
  assert.equal(config.diagnostics_log_level, 'warning');
  assert.equal(config.diagnostics_capture_mode, 'sanitized_snippets');
  assert.equal(config.ollama_request_timeout_seconds, 420);
});

test('managed sidecar config only enables the todo tool when explicitly configured', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-config-todo-'));
  trackDirectory(userDataPath);

  const service = createManagedServiceWithConfig(userDataPath, {
    getState() {
      return {
        tools: { todo: true },
      };
    },
  });

  const config = service._buildManagedSidecarConfig();

  assert.equal(config.tools_todo_enabled, true);
});

test('managed sidecar config reads the canonical nested tools settings shape', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-config-tools-shape-'));
  trackDirectory(userDataPath);

  const service = createManagedServiceWithConfig(userDataPath, {
    getState() {
      return {
        toolsWorkspaceRoot: userDataPath,
        tools: {
          web: true,
          browser: true,
          worktree: true,
          mermaid: true,
          lsp: true,
          imageRead: true,
          pythonRuntime: true,
          todo: true,
          fileTools: true,
        },
      };
    },
  });

  service.toolExecutor = {};
  const config = service._buildManagedSidecarConfig();

  assert.equal(config.tools_web_enabled, true);
  assert.equal(config.tools_worktree_enabled, true);
  assert.equal(config.electron_tool_bridge_enabled, true);
  assert.equal(config.tools_mermaid_enabled, true);
  assert.equal(config.tools_lsp_enabled, true);
  assert.equal(config.tools_image_read_enabled, true);
  assert.equal(config.tools_python_runtime_enabled, true);
  assert.equal(config.tools_todo_enabled, true);
});

test('managed sidecar config forwards agent executor feature flags from Electron', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-config-agent-executor-'));
  trackDirectory(userDataPath);

  const service = createManagedServiceWithConfig(
    userDataPath,
    {
      getState() {
        return {};
      },
    },
    {
      featureFlags: {
        agent_executor: true,
        task_lifecycle: false,
        multiplexer: true,
        chat_cancel: true,
      },
    }
  );

  const config = service._buildManagedSidecarConfig();

  assert.equal(config.feature_flags.agent_executor, true);
  assert.equal(config.feature_flags.task_lifecycle, false);
  assert.equal(config.feature_flags.multiplexer, true);
  assert.equal(config.feature_flags.chat_cancel, true);
});

test('managed sidecar config derives sidecar feature-flag config from Electron feature flags', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-config-feature-flags-'));
  trackDirectory(userDataPath);

  const service = createManagedServiceWithConfig(
    userDataPath,
    {
      getState() {
        return {};
      },
    },
    {
      featureFlags: {
        workspace_manifest: true,
        repo_delta_resume: true,
      },
    }
  );

  const config = service._buildManagedSidecarConfig();

  assert.equal(config.tools_workspace_manifest_enabled, true);
  assert.equal(config.feature_flags.workspace_manifest, true);
  assert.equal(config.repo_delta_resume_enabled, true);
  assert.equal(config.feature_flags.repo_delta_resume, true);
});

test('managed sidecar config derives task capsule flag from Electron feature flag', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-config-task-capsule-'));
  trackDirectory(userDataPath);

  const service = createManagedServiceWithConfig(
    userDataPath,
    {
      getState() {
        return {};
      },
    },
    {
      featureFlags: {
        task_capsule: true,
      },
    }
  );

  const config = service._buildManagedSidecarConfig();

  assert.equal(config.tools_task_capsule_enabled, true);
  assert.equal(config.feature_flags.task_capsule, true);
});

test('managed sidecar config enables phase events when stream envelope v2 is enabled', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-config-stream-envelope-v2-'));
  trackDirectory(userDataPath);

  const service = createManagedServiceWithConfig(
    userDataPath,
    {
      getState() {
        return {};
      },
    },
    {
      featureFlags: {
        stream_envelope_v2: true,
        phase_events: false,
      },
    }
  );

  const config = service._buildManagedSidecarConfig();

  assert.equal(config.feature_flags.stream_envelope_v2, true);
  assert.equal(config.feature_flags.phase_events, true);
});
