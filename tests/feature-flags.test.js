const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FEATURE_OVERRIDE_KEYS,
  INTERNAL_FEATURE_FLAG_KEYS,
  buildFeatureFlagDefaults,
  buildFeatureFlags,
  isFeatureEnabledByDefault,
  normalizeFeatureOverrides,
} = require('../services/feature-flags');

test('isFeatureEnabledByDefault falls back to the provided default for empty values', () => {
  assert.equal(isFeatureEnabledByDefault('', true), true);
  assert.equal(isFeatureEnabledByDefault('', false), false);
  assert.equal(isFeatureEnabledByDefault(undefined, false), false);
});

test('buildFeatureFlags keeps agent executor disabled by default', () => {
  const flags = buildFeatureFlags({});

  assert.equal(Object.hasOwn(flags, 'tips_surface'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(flags, 'cost_tracker'), false);
  assert.equal(flags.comet_personality, false);
  assert.equal(flags.pretext_layout, true);
  assert.equal(flags.agent_executor, false);
  assert.equal(flags.task_lifecycle, false);
});

test('retired thread map flag cannot be restored through environment overrides', () => {
  const flags = buildFeatureFlags({ JENNY_ENABLE_THREAD_MAP_RAIL: '1' });

  assert.equal(Object.prototype.hasOwnProperty.call(flags, 'thread_map_rail'), false);
  assert.equal(INTERNAL_FEATURE_FLAG_KEYS.includes('thread_map_rail'), false);
  assert.equal(FEATURE_OVERRIDE_KEYS.includes('thread_map_rail'), false);
});

test('buildFeatureFlags enables agent executor from env', () => {
  const flags = buildFeatureFlags({
    JENNY_ENABLE_AGENT_EXECUTOR: '1',
  });

  assert.equal(flags.agent_executor, true);
});

test('subagent batch is an internal default-off env gate', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_SUBAGENT_BATCH: '1' });
  const malformed = buildFeatureFlags({ JENNY_ENABLE_SUBAGENT_BATCH: 'maybe' });

  assert.equal(defaults.subagent_batch, false);
  assert.equal(enabled.subagent_batch, true);
  assert.equal(malformed.subagent_batch, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('subagent_batch'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('subagent_batch'));
});

test('retired guidance and cost flags cannot be restored from the environment', () => {
  const reEnabled = buildFeatureFlags({
    JENNY_ENABLE_COST_TRACKER: '1',
    JENNY_ENABLE_TIPS_SURFACES: 'on',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(reEnabled, 'cost_tracker'), false);
  assert.equal(Object.hasOwn(reEnabled, 'tips_surface'), false);
});

test('phase_events is an internal default-on flag that can be disabled from env', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_PHASE_EVENTS: '0',
  });

  assert.equal(defaults.phase_events, true);
  assert.equal(disabled.phase_events, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('phase_events'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('phase_events'));
});

test('retired chat_turn_v2 flag cannot be restored through environment overrides', () => {
  const flags = buildFeatureFlags({ JENNY_ENABLE_CHAT_TURN_V2: '1' });

  assert.equal(Object.prototype.hasOwnProperty.call(flags, 'chat_turn_v2'), false);
  assert.equal(INTERNAL_FEATURE_FLAG_KEYS.includes('chat_turn_v2'), false);
  assert.equal(FEATURE_OVERRIDE_KEYS.includes('chat_turn_v2'), false);
  assert.deepEqual(
    normalizeFeatureOverrides({ chat_turn_v2: true }),
    {}
  );
});

test('workspace_test_runner is an internal default-on flag that can be disabled from env', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_WORKSPACE_TEST_RUNNER: '0',
  });

  assert.equal(defaults.workspace_test_runner, true);
  assert.equal(disabled.workspace_test_runner, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('workspace_test_runner'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('workspace_test_runner'));
});

test('turn_activity_envelope is an internal default-on flag that can be disabled from env', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_TURN_ACTIVITY_ENVELOPE: '0',
  });

  assert.equal(defaults.turn_activity_envelope, true);
  assert.equal(disabled.turn_activity_envelope, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('turn_activity_envelope'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('turn_activity_envelope'));
});

test('artifact_renderer_registry is an internal default-on flag that can be disabled from env', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_ARTIFACT_RENDERER_REGISTRY: '0',
  });

  assert.equal(defaults.artifact_renderer_registry, true);
  assert.equal(disabled.artifact_renderer_registry, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('artifact_renderer_registry'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('artifact_renderer_registry'));
  assert.deepEqual(
    normalizeFeatureOverrides({ artifact_renderer_registry: true }),
    {}
  );
});

test('web_search_providers is an internal default-on flag that can be disabled from env', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_WEB_SEARCH_PROVIDERS: '0',
  });

  assert.equal(defaults.web_search_providers, true);
  assert.equal(disabled.web_search_providers, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('web_search_providers'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('web_search_providers'));
  assert.deepEqual(
    normalizeFeatureOverrides({ web_search_providers: true }),
    {}
  );
});

test('katex_math is an internal default-on flag that can be disabled from env', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_KATEX_MATH: '0',
  });

  assert.equal(defaults.katex_math, true);
  assert.equal(disabled.katex_math, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('katex_math'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('katex_math'));
  assert.deepEqual(
    normalizeFeatureOverrides({ katex_math: true }),
    {}
  );
});

test('compaction_manual is an internal DEFAULT-ON flag with an env rollback (JCA-003 closed: chat.send consumes the persisted compaction snapshot)', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_COMPACTION_MANUAL: '0',
  });

  assert.equal(defaults.compaction_manual, true,
    'Compact now is back on: Electron persists the compacted messages and future chat.send calls consume them');
  assert.equal(disabled.compaction_manual, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('compaction_manual'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('compaction_manual'));
  assert.deepEqual(
    normalizeFeatureOverrides({ compaction_manual: true }),
    {}
  );
});

test('chat_tool_trace_rows_fix is an internal default-on rollout flag with env rollback', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_CHAT_TOOL_TRACE_ROWS_FIX: '1',
  });
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_CHAT_TOOL_TRACE_ROWS_FIX: '0',
  });

  assert.equal(defaults.chat_tool_trace_rows_fix, true);
  assert.equal(enabled.chat_tool_trace_rows_fix, true);
  assert.equal(disabled.chat_tool_trace_rows_fix, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('chat_tool_trace_rows_fix'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('chat_tool_trace_rows_fix'));
  assert.deepEqual(
    normalizeFeatureOverrides({ chat_tool_trace_rows_fix: true }),
    {}
  );
});

test('chat_stream_paint_v2 is an internal default-on rollout flag with env rollback', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_CHAT_STREAM_PAINT_V2: '1',
  });
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_CHAT_STREAM_PAINT_V2: '0',
  });

  assert.equal(defaults.chat_stream_paint_v2, true);
  assert.equal(enabled.chat_stream_paint_v2, true);
  assert.equal(disabled.chat_stream_paint_v2, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('chat_stream_paint_v2'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('chat_stream_paint_v2'));
  assert.deepEqual(
    normalizeFeatureOverrides({ chat_stream_paint_v2: true }),
    {}
  );
});

test('stream_envelope_v2 is an internal default-off rollout flag enabled only by env', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_STREAM_ENVELOPE_V2: '1',
  });
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_STREAM_ENVELOPE_V2: '0',
  });

  assert.equal(defaults.stream_envelope_v2, false);
  assert.equal(enabled.stream_envelope_v2, true);
  assert.equal(disabled.stream_envelope_v2, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('stream_envelope_v2'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('stream_envelope_v2'));
  assert.deepEqual(
    normalizeFeatureOverrides({ stream_envelope_v2: true }),
    {}
  );
});

test('canonical_bridge is an internal default-off rollout flag enabled only by env', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_CANONICAL_BRIDGE: '1',
  });
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_CANONICAL_BRIDGE: '0',
  });

  assert.equal(defaults.canonical_bridge, false);
  assert.equal(enabled.canonical_bridge, true);
  assert.equal(disabled.canonical_bridge, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('canonical_bridge'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('canonical_bridge'));
  assert.deepEqual(
    normalizeFeatureOverrides({ canonical_bridge: true }),
    {}
  );
});

test('canonical_renderer_projection is internal, default-ON, and rolls back by env', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_CANONICAL_RENDERER_PROJECTION: '1',
  });
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_CANONICAL_RENDERER_PROJECTION: '0',
  });

  assert.equal(defaults.canonical_renderer_projection, true);
  assert.equal(enabled.canonical_renderer_projection, true);
  assert.equal(disabled.canonical_renderer_projection, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('canonical_renderer_projection'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('canonical_renderer_projection'));
  assert.deepEqual(
    normalizeFeatureOverrides({ canonical_renderer_projection: true }),
    {}
  );
});

test('canonical_m3_rollout enables the canonical stack as a grouped canary', () => {
  const flags = buildFeatureFlags({
    JENNY_ENABLE_CANONICAL_M3_ROLLOUT: '1',
  });

  assert.equal(flags.canonical_m3_rollout, true);
  assert.equal(flags.canonical_turn_events, true);
  assert.equal(flags.canonical_bridge, true);
  assert.equal(flags.canonical_renderer_projection, true);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('canonical_m3_rollout'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('canonical_m3_rollout'));
  assert.deepEqual(
    normalizeFeatureOverrides({ canonical_m3_rollout: true }),
    {}
  );
});

test('canonical_m3_rollout preserves per-flag rollback env overrides', () => {
  const flags = buildFeatureFlags({
    JENNY_ENABLE_CANONICAL_M3_ROLLOUT: '1',
    JENNY_ENABLE_CANONICAL_BRIDGE: '0',
    JENNY_ENABLE_CANONICAL_RENDERER_PROJECTION: '0',
  });

  assert.equal(flags.canonical_m3_rollout, true);
  assert.equal(flags.canonical_turn_events, true);
  assert.equal(flags.canonical_bridge, false);
  assert.equal(flags.canonical_renderer_projection, false);
});

test('workspace_manifest is an internal DEFAULT-ON flag with an env rollback (owner-directed flip 2026-07-07)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_WORKSPACE_MANIFEST: '1',
  });
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_WORKSPACE_MANIFEST: '0',
  });

  assert.equal(defaults.workspace_manifest, true);
  assert.equal(enabled.workspace_manifest, true);
  assert.equal(disabled.workspace_manifest, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('workspace_manifest'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('workspace_manifest'));
  assert.deepEqual(
    normalizeFeatureOverrides({ workspace_manifest: true }),
    {}
  );
});

test('repo_delta_resume is an internal DEFAULT-ON flag with an env rollback (owner-directed flip 2026-07-07)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_REPO_DELTA_RESUME: '1',
  });
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_REPO_DELTA_RESUME: '0',
  });

  assert.equal(defaults.repo_delta_resume, true);
  assert.equal(enabled.repo_delta_resume, true);
  assert.equal(disabled.repo_delta_resume, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('repo_delta_resume'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('repo_delta_resume'));
  assert.deepEqual(
    normalizeFeatureOverrides({ repo_delta_resume: true }),
    {}
  );
});

test('task_capsule is an internal default-off rollout flag enabled only by env', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_TASK_CAPSULE: '1',
  });

  assert.equal(defaults.task_capsule, false);
  assert.equal(enabled.task_capsule, true);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('task_capsule'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('task_capsule'));
  assert.deepEqual(
    normalizeFeatureOverrides({ task_capsule: true }),
    {}
  );
});

test('mcp_resources is an internal default-off rollout flag enabled only by env', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_MCP_RESOURCES: '1',
  });
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_MCP_RESOURCES: '0',
  });

  assert.equal(defaults.mcp_resources, false);
  assert.equal(enabled.mcp_resources, true);
  assert.equal(disabled.mcp_resources, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('mcp_resources'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('mcp_resources'));
  assert.deepEqual(
    normalizeFeatureOverrides({ mcp_resources: true }),
    {}
  );
});

test('tools_automations_enabled is an internal default-off rollout flag enabled only by env', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_TOOLS_AUTOMATIONS: '1',
  });
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_TOOLS_AUTOMATIONS: '0',
  });

  assert.equal(defaults.tools_automations_enabled, false);
  assert.equal(enabled.tools_automations_enabled, true);
  assert.equal(disabled.tools_automations_enabled, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('tools_automations_enabled'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('tools_automations_enabled'));
  assert.deepEqual(
    normalizeFeatureOverrides({ tools_automations_enabled: true }),
    {}
  );
});

test('workspace_git is an internal default-on flag with an env rollback', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_WORKSPACE_GIT: '1',
  });
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_WORKSPACE_GIT: '0',
  });

  assert.equal(defaults.workspace_git, true);
  assert.equal(enabled.workspace_git, true);
  assert.equal(disabled.workspace_git, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('workspace_git'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('workspace_git'));
  assert.deepEqual(
    normalizeFeatureOverrides({ workspace_git: true }),
    {}
  );
});

test('scratchpad_v2 is an internal default-on flag with an env opt-out', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({ JENNY_ENABLE_SCRATCHPAD_V2: '0' });

  assert.equal(defaults.scratchpad_v2, true);
  assert.equal(disabled.scratchpad_v2, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('scratchpad_v2'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('scratchpad_v2'));
});

test('workspace_auto_save is retired in favor of the sole Editor preference', () => {
  const defaults = buildFeatureFlags({});
  assert.equal(Object.prototype.hasOwnProperty.call(defaults, 'workspace_auto_save'), false);
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('workspace_auto_save'));
  assert.ok(!INTERNAL_FEATURE_FLAG_KEYS.includes('workspace_auto_save'));
  assert.deepEqual(normalizeFeatureOverrides({ workspace_auto_save: false }), {});
});

test('workspace_artifact_panel is RETIRED (W1-5 studio removal — the panel is core)', () => {
  const defaults = buildFeatureFlags({});

  // With the Artifacts studio view removed, the review side panel is the only
  // in-app artifact surface; a flag-off state would mean zero artifact access,
  // so the key is gone from defaults and the override allowlist entirely.
  assert.ok(!Object.prototype.hasOwnProperty.call(defaults, 'workspace_artifact_panel'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('workspace_artifact_panel'));
  assert.deepEqual(normalizeFeatureOverrides({ workspace_artifact_panel: false }), {});
});

test('source_citations is an internal DEFAULT-ON flag with an env rollback (owner-directed pre-soak flip 2026-07-02)', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({ JENNY_ENABLE_SOURCE_CITATIONS: '0' });

  assert.equal(defaults.source_citations, true);
  assert.equal(disabled.source_citations, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('source_citations'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('source_citations'));
  assert.deepEqual(normalizeFeatureOverrides({ source_citations: true }), {});
});

test('model_management_ui and workspace_root_nudge are DEFAULT-ON with env rollback (Bundled Engine Onboarding)', () => {
  const defaults = buildFeatureFlags({});
  const modelMgmtOff = buildFeatureFlags({ JENNY_ENABLE_MODEL_MANAGEMENT_UI: '0' });
  const nudgeOff = buildFeatureFlags({ JENNY_ENABLE_WORKSPACE_ROOT_NUDGE: '0' });

  assert.equal(defaults.model_management_ui, true);
  assert.equal(modelMgmtOff.model_management_ui, false);
  assert.equal(defaults.workspace_root_nudge, true);
  assert.equal(nudgeOff.workspace_root_nudge, false);
});

test('model_library_section is DEFAULT-ON with an env rollback', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({ JENNY_ENABLE_MODEL_LIBRARY_SECTION: '0' });

  assert.equal(defaults.model_library_section, true);
  assert.equal(disabled.model_library_section, false);
});

test('setup_hub is DEFAULT-ON with an env rollback', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({ JENNY_ENABLE_SETUP_HUB: '0' });

  assert.equal(defaults.setup_hub, true);
  assert.equal(disabled.setup_hub, false);
});

test('artifact_html_preview is an internal DEFAULT-ON flag with an env rollback (owner-directed pre-soak flip 2026-07-02)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_ARTIFACT_HTML_PREVIEW: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_ARTIFACT_HTML_PREVIEW: '0' });

  assert.equal(defaults.artifact_html_preview, true);
  assert.equal(enabled.artifact_html_preview, true);
  assert.equal(disabled.artifact_html_preview, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('artifact_html_preview'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('artifact_html_preview'));
  assert.deepEqual(normalizeFeatureOverrides({ artifact_html_preview: true }), {});
});

test('file_preview_html_render is an internal DEFAULT-ON flag with an env rollback', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_FILE_PREVIEW_HTML_RENDER: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_FILE_PREVIEW_HTML_RENDER: '0' });

  assert.equal(defaults.file_preview_html_render, true);
  assert.equal(enabled.file_preview_html_render, true);
  assert.equal(disabled.file_preview_html_render, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('file_preview_html_render'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('file_preview_html_render'));
  assert.deepEqual(normalizeFeatureOverrides({ file_preview_html_render: true }), {});
});

test('composer_turn_timer is an internal DEFAULT-ON flag with an env rollback', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_COMPOSER_TURN_TIMER: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_COMPOSER_TURN_TIMER: '0' });

  assert.equal(defaults.composer_turn_timer, true);
  assert.equal(enabled.composer_turn_timer, true);
  assert.equal(disabled.composer_turn_timer, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('composer_turn_timer'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('composer_turn_timer'));
  assert.deepEqual(normalizeFeatureOverrides({ composer_turn_timer: true }), {});
});

test('titlebar_gpu_telemetry is an internal DEFAULT-ON flag with an env rollback', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_TITLEBAR_GPU_TELEMETRY: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_TITLEBAR_GPU_TELEMETRY: '0' });

  assert.equal(defaults.titlebar_gpu_telemetry, true);
  assert.equal(enabled.titlebar_gpu_telemetry, true);
  assert.equal(disabled.titlebar_gpu_telemetry, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('titlebar_gpu_telemetry'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('titlebar_gpu_telemetry'));
  assert.deepEqual(normalizeFeatureOverrides({ titlebar_gpu_telemetry: true }), {});
});

test('artifact_panel_v2 is an internal DEFAULT-ON flag with an env rollback (Artifact Panel V2)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_ARTIFACT_PANEL_V2: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_ARTIFACT_PANEL_V2: '0' });

  assert.equal(defaults.artifact_panel_v2, true);
  assert.equal(enabled.artifact_panel_v2, true);
  assert.equal(disabled.artifact_panel_v2, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('artifact_panel_v2'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('artifact_panel_v2'));
  assert.deepEqual(normalizeFeatureOverrides({ artifact_panel_v2: true }), {});
});

test('artifact_panel_v3 is an internal DEFAULT-ON flag with an env rollback (Canvas)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_ARTIFACT_PANEL_V3: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_ARTIFACT_PANEL_V3: '0' });
  assert.equal(defaults.artifact_panel_v3, true);
  assert.equal(enabled.artifact_panel_v3, true);
  assert.equal(disabled.artifact_panel_v3, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('artifact_panel_v3'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('artifact_panel_v3'));
  assert.deepEqual(normalizeFeatureOverrides({ artifact_panel_v3: true }), {});
});

test('ide_chat_dock is an internal DEFAULT-ON flag with an env rollback (Workspace Chat Dock)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_IDE_CHAT_DOCK: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_IDE_CHAT_DOCK: '0' });

  assert.equal(defaults.ide_chat_dock, true);
  assert.equal(enabled.ide_chat_dock, true);
  assert.equal(disabled.ide_chat_dock, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('ide_chat_dock'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('ide_chat_dock'));
  assert.deepEqual(normalizeFeatureOverrides({ ide_chat_dock: true }), {});
});

test('knowledge_layer is an internal DEFAULT-ON flag with an env rollback (owner-directed pre-soak flip 2026-07-02)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_KNOWLEDGE_LAYER: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_KNOWLEDGE_LAYER: '0' });

  assert.equal(defaults.knowledge_layer, true);
  assert.equal(enabled.knowledge_layer, true);
  assert.equal(disabled.knowledge_layer, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('knowledge_layer'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('knowledge_layer'));
  assert.deepEqual(normalizeFeatureOverrides({ knowledge_layer: true }), {});
});

test('mcp_http_transport is an internal DEFAULT-ON flag with an env rollback (owner-directed pre-soak flip 2026-07-02; both-gates: inert without mcp_sse_enabled + an sse server)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_MCP_HTTP_TRANSPORT: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_MCP_HTTP_TRANSPORT: '0' });

  assert.equal(defaults.mcp_http_transport, true);
  assert.equal(enabled.mcp_http_transport, true);
  assert.equal(disabled.mcp_http_transport, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('mcp_http_transport'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('mcp_http_transport'));
  assert.deepEqual(normalizeFeatureOverrides({ mcp_http_transport: true }), {});
});

test('mcp_management_ui is an internal DEFAULT-ON flag with an env rollback, independent of mcp_http_transport (owner-approved spec 2026-07-05)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_MCP_MANAGEMENT_UI: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_MCP_MANAGEMENT_UI: '0' });
  const disabledTransportOnly = buildFeatureFlags({ JENNY_ENABLE_MCP_HTTP_TRANSPORT: '0' });

  assert.equal(defaults.mcp_management_ui, true);
  assert.equal(enabled.mcp_management_ui, true);
  assert.equal(disabled.mcp_management_ui, false);
  // Rolling back mcp_http_transport must not roll back mcp_management_ui.
  assert.equal(disabledTransportOnly.mcp_management_ui, true);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('mcp_management_ui'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('mcp_management_ui'));
  assert.deepEqual(normalizeFeatureOverrides({ mcp_management_ui: true }), {});
});

test('response_loop_display_v2 is an internal DEFAULT-ON flag with an env opt-out', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_RESPONSE_LOOP_DISPLAY_V2: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_RESPONSE_LOOP_DISPLAY_V2: '0' });

  // Shared gate for backend commentary/reasoning preservation + renderer display.
  // Tasks 1-8 landed so it ships ON; JENNY_ENABLE_RESPONSE_LOOP_DISPLAY_V2=0 rolls
  // it back. Internal (not a user override), like the other view-surface flags.
  assert.equal(defaults.response_loop_display_v2, true);
  assert.equal(enabled.response_loop_display_v2, true);
  assert.equal(disabled.response_loop_display_v2, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('response_loop_display_v2'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('response_loop_display_v2'));
  assert.deepEqual(normalizeFeatureOverrides({ response_loop_display_v2: true }), {});
});

test('buildFeatureFlags treats malformed agent executor env values as the default', () => {
  const flags = buildFeatureFlags({
    JENNY_ENABLE_AGENT_EXECUTOR: 'maybe',
    JENNY_ENABLE_TASK_LIFECYCLE: 'wat',
    JENNY_ENABLE_TIPS_SURFACES: 'nah',
    JENNY_ENABLE_PRETEXT_LAYOUT: '???',
  });

  assert.equal(Object.hasOwn(flags, 'tips_surface'), false);
  assert.equal(flags.pretext_layout, true);
  assert.equal(flags.agent_executor, false);
  assert.equal(flags.task_lifecycle, false);
});

test('buildFeatureFlags allows pretext layout to be disabled explicitly from env', () => {
  const flags = buildFeatureFlags({
    JENNY_ENABLE_PRETEXT_LAYOUT: '0',
  });

  assert.equal(flags.pretext_layout, false);
});

test('error_intake_routing defaults on with rollback overrides intact (EH-W12 soak)', () => {
  const flags = buildFeatureFlags({});
  assert.equal(flags.error_intake_routing, true);
  assert.ok(FEATURE_OVERRIDE_KEYS.includes('error_intake_routing'));
  assert.ok(!INTERNAL_FEATURE_FLAG_KEYS.includes('error_intake_routing'));
  assert.deepEqual(
    normalizeFeatureOverrides({ error_intake_routing: false }),
    { error_intake_routing: false }
  );
  const overridden = buildFeatureFlags({}, { error_intake_routing: false });
  assert.equal(overridden.error_intake_routing, false, 'the Settings Advanced toggle still rolls back');
  const envDisabled = buildFeatureFlags({ JENNY_ENABLE_ERROR_INTAKE_ROUTING: '0' });
  assert.equal(envDisabled.error_intake_routing, false, 'the env override still rolls back');
});

test('workspace_pty_terminal is an internal DEFAULT-ON flag with an env rollback (owner-directed pre-soak flip 2026-07-02, overriding the handoff ship-OFF call)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_WORKSPACE_PTY_TERMINAL: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_WORKSPACE_PTY_TERMINAL: '0' });

  assert.equal(defaults.workspace_pty_terminal, true);
  assert.equal(enabled.workspace_pty_terminal, true);
  assert.equal(disabled.workspace_pty_terminal, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('workspace_pty_terminal'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('workspace_pty_terminal'));
  assert.deepEqual(normalizeFeatureOverrides({ workspace_pty_terminal: true }), {});
});

test('thread_root_markup_memo is an internal DEFAULT-ON flag with an env rollback (Finding 3 settled-root markup memoization)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_THREAD_ROOT_MARKUP_MEMO: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_THREAD_ROOT_MARKUP_MEMO: '0' });

  assert.equal(defaults.thread_root_markup_memo, true);
  assert.equal(enabled.thread_root_markup_memo, true);
  assert.equal(disabled.thread_root_markup_memo, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('thread_root_markup_memo'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('thread_root_markup_memo'));
  assert.deepEqual(normalizeFeatureOverrides({ thread_root_markup_memo: true }), {});
});

test('auto_checkpoint is an internal DEFAULT-ON flag with an env rollback (owner-directed flip 2026-07-07)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_AUTO_CHECKPOINT: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_AUTO_CHECKPOINT: '0' });

  assert.equal(defaults.auto_checkpoint, true);
  assert.equal(enabled.auto_checkpoint, true);
  assert.equal(disabled.auto_checkpoint, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('auto_checkpoint'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('auto_checkpoint'));
  assert.deepEqual(
    normalizeFeatureOverrides({ auto_checkpoint: true }),
    {}
  );
});

test('strict_auto_run is a user-overridable DEFAULT-OFF flag with an env opt-in', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_STRICT_AUTO_RUN: '1' });

  assert.equal(defaults.strict_auto_run, false);
  assert.equal(enabled.strict_auto_run, true);
  assert.ok(FEATURE_OVERRIDE_KEYS.includes('strict_auto_run'));
  assert.ok(!INTERNAL_FEATURE_FLAG_KEYS.includes('strict_auto_run'));
  assert.deepEqual(
    normalizeFeatureOverrides({ strict_auto_run: true }),
    { strict_auto_run: true }
  );
});

test('workspace_exploded_view is an internal DEFAULT-ON flag with an env rollback (owner-directed flip 2026-07-07)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_WORKSPACE_EXPLODED_VIEW: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_WORKSPACE_EXPLODED_VIEW: '0' });

  assert.equal(defaults.workspace_exploded_view, true);
  assert.equal(enabled.workspace_exploded_view, true);
  assert.equal(disabled.workspace_exploded_view, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('workspace_exploded_view'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('workspace_exploded_view'));
  assert.deepEqual(
    normalizeFeatureOverrides({ workspace_exploded_view: true }),
    {}
  );
});

test('workspace_external_import is an internal DEFAULT-ON flag with an env rollback', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_WORKSPACE_EXTERNAL_IMPORT: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_WORKSPACE_EXTERNAL_IMPORT: '0' });

  assert.equal(defaults.workspace_external_import, true);
  assert.equal(enabled.workspace_external_import, true);
  assert.equal(disabled.workspace_external_import, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('workspace_external_import'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('workspace_external_import'));
  assert.deepEqual(normalizeFeatureOverrides({ workspace_external_import: true }), {});
});

test('chat_timeline_deterministic_row_id is an internal DEFAULT-ON flag with an env rollback (DC1 flicker cure; owner-directed flip 2026-07-07)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_CHAT_TIMELINE_DETERMINISTIC_ROW_ID: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_CHAT_TIMELINE_DETERMINISTIC_ROW_ID: '0' });

  assert.equal(defaults.chat_timeline_deterministic_row_id, true);
  assert.equal(enabled.chat_timeline_deterministic_row_id, true);
  assert.equal(disabled.chat_timeline_deterministic_row_id, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('chat_timeline_deterministic_row_id'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('chat_timeline_deterministic_row_id'));
  assert.deepEqual(
    normalizeFeatureOverrides({ chat_timeline_deterministic_row_id: true }),
    {}
  );
});

test('chat_timeline_render_telemetry is an internal DEFAULT-ON flag with an env rollback (Track A render diagnostics; owner-directed flip 2026-07-07)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_CHAT_TIMELINE_RENDER_TELEMETRY: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_CHAT_TIMELINE_RENDER_TELEMETRY: '0' });

  assert.equal(defaults.chat_timeline_render_telemetry, true);
  assert.equal(enabled.chat_timeline_render_telemetry, true);
  assert.equal(disabled.chat_timeline_render_telemetry, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('chat_timeline_render_telemetry'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('chat_timeline_render_telemetry'));
  assert.deepEqual(
    normalizeFeatureOverrides({ chat_timeline_render_telemetry: true }),
    {}
  );
});

test('chat_timeline_streaming_article_morph is an internal DEFAULT-ON flag with env rollback (Track B streaming article morph)', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({ JENNY_ENABLE_CHAT_TIMELINE_STREAMING_ARTICLE_MORPH: '1' });
  const disabled = buildFeatureFlags({ JENNY_ENABLE_CHAT_TIMELINE_STREAMING_ARTICLE_MORPH: '0' });

  assert.equal(defaults.chat_timeline_streaming_article_morph, true);
  assert.equal(enabled.chat_timeline_streaming_article_morph, true);
  assert.equal(disabled.chat_timeline_streaming_article_morph, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('chat_timeline_streaming_article_morph'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('chat_timeline_streaming_article_morph'));
  assert.deepEqual(
    normalizeFeatureOverrides({ chat_timeline_streaming_article_morph: true }),
    {}
  );
});

test('ollama_tray_remediation is a DEFAULT-ON user override with env rollback', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({ JENNY_ENABLE_OLLAMA_TRAY_REMEDIATION: '0' });

  // Gates the owner-triggered ollamaTray.* remediation IPC surface (quit tray
  // app, disable Startup shortcut, restart engine). Ships ON; the env
  // override and the Settings user-override both roll it back.
  assert.equal(defaults.ollama_tray_remediation, true);
  assert.equal(disabled.ollama_tray_remediation, false);
  assert.ok(FEATURE_OVERRIDE_KEYS.includes('ollama_tray_remediation'));
  assert.ok(!INTERNAL_FEATURE_FLAG_KEYS.includes('ollama_tray_remediation'));
  assert.deepEqual(
    normalizeFeatureOverrides({ ollama_tray_remediation: false }),
    { ollama_tray_remediation: false }
  );
  const overridden = buildFeatureFlags({}, { ollama_tray_remediation: false });
  assert.equal(overridden.ollama_tray_remediation, false);
});

test('text_spellcheck is a default-on user override with an environment default rollback', () => {
  assert.ok(FEATURE_OVERRIDE_KEYS.includes('text_spellcheck'));
  assert.ok(!INTERNAL_FEATURE_FLAG_KEYS.includes('text_spellcheck'));
  assert.equal(buildFeatureFlagDefaults({}).text_spellcheck, true);
  assert.equal(
    buildFeatureFlagDefaults({ JENNY_ENABLE_TEXT_SPELLCHECK: '0' }).text_spellcheck,
    false
  );
});

test('surface_effect_gallery is an internal flag patterned on agent_test_hooks (agent/dev launcher default, env-only override)', () => {
  const offEverywhere = buildFeatureFlags({});
  const onUnderAgentDev = buildFeatureFlags({ JENNY_AGENT_DEV: '1' });
  const explicitlyDisabledUnderAgentDev = buildFeatureFlags({
    JENNY_AGENT_DEV: '1',
    JENNY_ENABLE_SURFACE_EFFECT_GALLERY: '0',
  });
  const explicitlyEnabledOutsideAgentDev = buildFeatureFlags({
    JENNY_ENABLE_SURFACE_EFFECT_GALLERY: '1',
  });

  assert.equal(offEverywhere.surface_effect_gallery, false, 'off by default outside the agent/dev launcher');
  assert.equal(onUnderAgentDev.surface_effect_gallery, true, 'on by default under JENNY_AGENT_DEV');
  assert.equal(explicitlyDisabledUnderAgentDev.surface_effect_gallery, false, 'env override still rolls back under the launcher');
  assert.equal(explicitlyEnabledOutsideAgentDev.surface_effect_gallery, true, 'env override opts in for an owner review session');
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('surface_effect_gallery'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('surface_effect_gallery'));
  assert.deepEqual(normalizeFeatureOverrides({ surface_effect_gallery: true }), {});
});

test('surface_effect_heartbeat defaults on with an env-only rollback', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({ JENNY_ENABLE_SURFACE_EFFECT_HEARTBEAT: '0' });
  const reenabled = buildFeatureFlags({ JENNY_ENABLE_SURFACE_EFFECT_HEARTBEAT: '1' });

  assert.equal(defaults.surface_effect_heartbeat, true);
  assert.equal(disabled.surface_effect_heartbeat, false);
  assert.equal(reenabled.surface_effect_heartbeat, true);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('surface_effect_heartbeat'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('surface_effect_heartbeat'));
  assert.deepEqual(normalizeFeatureOverrides({ surface_effect_heartbeat: false }), {});
});

test('cloud_loop_profile is an internal default-on flag that can be disabled from env', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({ JENNY_ENABLE_CLOUD_LOOP_PROFILE: '0' });
  const reenabled = buildFeatureFlags({ JENNY_ENABLE_CLOUD_LOOP_PROFILE: '1' });

  assert.equal(defaults.cloud_loop_profile, true);
  assert.equal(disabled.cloud_loop_profile, false);
  assert.equal(reenabled.cloud_loop_profile, true);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('cloud_loop_profile'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('cloud_loop_profile'));
  assert.deepEqual(normalizeFeatureOverrides({ cloud_loop_profile: false }), {});
});

test('plugins default on at Stage 7 and retain the environment kill switch', () => {
  assert.equal(buildFeatureFlags({}).plugins, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_PLUGINS: '0' }).plugins, false);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_PLUGINS: '1' }).plugins, true);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('plugins'));
});

test('chat_long_thread_bounds defaults on with an internal env rollback', () => {
  assert.equal(buildFeatureFlags({}).chat_long_thread_bounds, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_CHAT_LONG_THREAD_BOUNDS: '0' }).chat_long_thread_bounds, false);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_CHAT_LONG_THREAD_BOUNDS: '1' }).chat_long_thread_bounds, true);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('chat_long_thread_bounds'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('chat_long_thread_bounds'));
  assert.deepEqual(normalizeFeatureOverrides({ chat_long_thread_bounds: false }), {});
});

test('session_offline_lockdown is internal, default-on, and rolls back by env', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({ JENNY_ENABLE_SESSION_OFFLINE_LOCKDOWN: '0' });
  const enabled = buildFeatureFlags({ JENNY_ENABLE_SESSION_OFFLINE_LOCKDOWN: '1' });

  assert.equal(defaults.session_offline_lockdown, true);
  assert.equal(disabled.session_offline_lockdown, false);
  assert.equal(enabled.session_offline_lockdown, true);
  assert.equal(INTERNAL_FEATURE_FLAG_KEYS.includes('session_offline_lockdown'), true);
  assert.equal(FEATURE_OVERRIDE_KEYS.includes('session_offline_lockdown'), false);
  assert.deepEqual(normalizeFeatureOverrides({ session_offline_lockdown: false }), {});
});

test('tools_task_board_enabled is internal, default-on, and rolls back by env', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({ JENNY_ENABLE_TOOLS_TASK_BOARD_ENABLED: '0' });
  const enabled = buildFeatureFlags({ JENNY_ENABLE_TOOLS_TASK_BOARD_ENABLED: '1' });

  assert.equal(defaults.tools_task_board_enabled, true);
  assert.equal(disabled.tools_task_board_enabled, false);
  assert.equal(enabled.tools_task_board_enabled, true);
  assert.equal(INTERNAL_FEATURE_FLAG_KEYS.includes('tools_task_board_enabled'), true);
  assert.equal(FEATURE_OVERRIDE_KEYS.includes('tools_task_board_enabled'), false);
  assert.deepEqual(normalizeFeatureOverrides({ tools_task_board_enabled: false }), {});
});
