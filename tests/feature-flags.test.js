const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FEATURE_OVERRIDE_KEYS,
  FORCE_DENY_ENV_KEYS,
  INTERNAL_FEATURE_FLAG_KEYS,
  RETIRED_FEATURE_FLAG_ENV_KEYS,
  buildFeatureFlagDefaults,
  buildFeatureFlags,
  isFeatureEnabledByDefault,
  normalizeFeatureOverrides,
} = require('../services/feature-flags');

test('session runtime defaults on and environment OFF cannot be overridden by stored preferences', () => {
  assert.equal(buildFeatureFlags({}).session_runtime, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_SESSION_RUNTIME: '0' }, { session_runtime: true }).session_runtime, false);
  assert.equal(FORCE_DENY_ENV_KEYS.session_runtime, 'JENNY_ENABLE_SESSION_RUNTIME');
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('session_runtime'));
  assert.deepEqual(normalizeFeatureOverrides({ session_runtime: true }), {});
});

test('isFeatureEnabledByDefault falls back to the provided default for empty values', () => {
  assert.equal(isFeatureEnabledByDefault('', true), true);
  assert.equal(isFeatureEnabledByDefault('', false), false);
  assert.equal(isFeatureEnabledByDefault(undefined, false), false);
});

test('buildFeatureFlags keeps agent executor disabled by default', () => {
  const flags = buildFeatureFlags({});

  assert.equal(Object.hasOwn(flags, 'tips_surface'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(flags, 'cost_tracker'), false);
  // Comet companion removed (sweep S9): both retired flags are gone from the map.
  assert.equal(Object.hasOwn(flags, 'comet_personality'), false);
  assert.equal(Object.hasOwn(flags, 'comet_overlay'), false);
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

test('image_generate is an internal default-on flag that can be disabled from env', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_TOOLS_IMAGE_GENERATE: '0',
  });

  assert.equal(defaults.tools_image_generate_enabled, true);
  assert.equal(disabled.tools_image_generate_enabled, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('tools_image_generate_enabled'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('tools_image_generate_enabled'));
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

test('stream_envelope_v2 is retired with the stream envelope v2 transport (owner, 2026-10-05)', () => {
  assert.deepEqual(RETIRED_FEATURE_FLAG_ENV_KEYS.stream_envelope_v2, {
    env: 'JENNY_ENABLE_STREAM_ENVELOPE_V2',
    removeIn: '1.4.0',
  });
  for (const value of ['0', '1']) {
    const flags = buildFeatureFlags({ JENNY_ENABLE_STREAM_ENVELOPE_V2: value }, { stream_envelope_v2: true });
    assert.equal(Object.hasOwn(flags, 'stream_envelope_v2'), false, 'no flag key is emitted');
  }
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('stream_envelope_v2'));
  assert.ok(!INTERNAL_FEATURE_FLAG_KEYS.includes('stream_envelope_v2'));
  assert.deepEqual(normalizeFeatureOverrides({ stream_envelope_v2: true }), {});
});

test('canonical_bridge is an internal default-on rollout flag that rolls back by env', () => {
  const defaults = buildFeatureFlags({});
  const enabled = buildFeatureFlags({
    JENNY_ENABLE_CANONICAL_BRIDGE: '1',
  });
  const disabled = buildFeatureFlags({
    JENNY_ENABLE_CANONICAL_BRIDGE: '0',
  });

  assert.equal(defaults.canonical_bridge, true);
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

test('canonical_m3_rollout defaults the canonical stack on with one env rollback', () => {
  const flags = buildFeatureFlags({});
  const rolledBack = buildFeatureFlags({
    JENNY_ENABLE_CANONICAL_M3_ROLLOUT: '0',
  });

  assert.equal(flags.canonical_m3_rollout, true);
  assert.equal(flags.canonical_turn_events, true);
  assert.equal(flags.canonical_bridge, true);
  assert.equal(flags.canonical_renderer_projection, true);
  assert.equal(rolledBack.canonical_m3_rollout, false);
  assert.equal(rolledBack.canonical_turn_events, false);
  assert.equal(rolledBack.canonical_bridge, false);
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

test('semantic_catalog is an internal DEFAULT-ON flag with an env kill switch (row 41)', () => {
  assert.equal(buildFeatureFlags({}).semantic_catalog, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_SEMANTIC_CATALOG: '0' }).semantic_catalog, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('semantic_catalog'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('semantic_catalog'));
  assert.deepEqual(normalizeFeatureOverrides({ semantic_catalog: false }), {});
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

test('failure_retry_reasoning_carry is retired with the failed-attempt reasoning capture (owner, 2026-10-05)', () => {
  assert.deepEqual(RETIRED_FEATURE_FLAG_ENV_KEYS.failure_retry_reasoning_carry, {
    env: 'JENNY_ENABLE_FAILURE_RETRY_REASONING_CARRY',
    removeIn: '1.4.0',
  });
  const baseline = buildFeatureFlags({});
  for (const value of ['0', '1']) {
    assert.deepEqual(buildFeatureFlags({ JENNY_ENABLE_FAILURE_RETRY_REASONING_CARRY: value }), baseline);
  }
  assert.equal(Object.hasOwn(baseline, 'failure_retry_reasoning_carry'), false, 'no flag key is emitted');
  assert.ok(!INTERNAL_FEATURE_FLAG_KEYS.includes('failure_retry_reasoning_carry'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('failure_retry_reasoning_carry'));
  assert.deepEqual(normalizeFeatureOverrides({ failure_retry_reasoning_carry: true }), {});
});

test('desktop_notifications is a default-on internal kill switch, not a user override', () => {
  assert.equal(buildFeatureFlagDefaults({}).desktop_notifications, true);
  assert.equal(
    buildFeatureFlagDefaults({ JENNY_ENABLE_DESKTOP_NOTIFICATIONS: '0' }).desktop_notifications,
    false
  );
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('desktop_notifications'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('desktop_notifications'));
  assert.deepEqual(normalizeFeatureOverrides({ desktop_notifications: false }), {});
});

test('unattended_guard is a default-on user override with env rollback', () => {
  assert.equal(buildFeatureFlagDefaults({}).unattended_guard, true);
  assert.equal(
    buildFeatureFlagDefaults({ JENNY_ENABLE_UNATTENDED_GUARD: '0' }).unattended_guard,
    false
  );
  assert.ok(FEATURE_OVERRIDE_KEYS.includes('unattended_guard'));
  assert.ok(!INTERNAL_FEATURE_FLAG_KEYS.includes('unattended_guard'));
  assert.deepEqual(
    normalizeFeatureOverrides({ unattended_guard: false }),
    { unattended_guard: false }
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

test('plugins and plugin_developer_profile are retired with the plugin platform (owner, 2026-10-05)', () => {
  const retiredFlags = [
    ['plugins', 'JENNY_ENABLE_PLUGINS'],
    ['plugin_developer_profile', 'JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE'],
  ];
  const baseline = buildFeatureFlags({});
  for (const [key, env] of retiredFlags) {
    assert.deepEqual(RETIRED_FEATURE_FLAG_ENV_KEYS[key], { env, removeIn: '1.5.0' });
    for (const value of ['0', '1']) {
      const flags = buildFeatureFlags({ [env]: value }, { [key]: true });
      assert.deepEqual(flags, baseline, 'the env var and a stored override are ignored');
    }
    assert.equal(Object.hasOwn(baseline, key), false, 'no flag key is emitted');
    assert.ok(!INTERNAL_FEATURE_FLAG_KEYS.includes(key));
    assert.ok(!FEATURE_OVERRIDE_KEYS.includes(key));
    // A profile that stored the override loses it on load, so no config bump is needed.
    assert.deepEqual(normalizeFeatureOverrides({ [key]: true }), {});
  }
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

test('tools_project_notes_enabled is internal, default-on, and rolls back by env', () => {
  const defaults = buildFeatureFlags({});
  const disabled = buildFeatureFlags({ JENNY_ENABLE_TOOLS_PROJECT_NOTES_ENABLED: '0' });
  const enabled = buildFeatureFlags({ JENNY_ENABLE_TOOLS_PROJECT_NOTES_ENABLED: '1' });

  assert.equal(defaults.tools_project_notes_enabled, true);
  assert.equal(disabled.tools_project_notes_enabled, false);
  assert.equal(enabled.tools_project_notes_enabled, true);
  assert.equal(INTERNAL_FEATURE_FLAG_KEYS.includes('tools_project_notes_enabled'), true);
  assert.equal(FEATURE_OVERRIDE_KEYS.includes('tools_project_notes_enabled'), false);
  assert.deepEqual(normalizeFeatureOverrides({ tools_project_notes_enabled: false }), {});
});

// Row 39 (owner, 2026-10-06): these default-ON flags were collapsed to their
// ON behaviour and the compatibility-only subagent_batch input was dropped.
// Their JENNY_ENABLE_<KEY> names stay accepted-and-ignored until 1.5.0.
const RETIRED_2026_10_06 = Object.freeze([
  'chatgpt_auth_turn_retry',
  'reasoning_prettify',
  'quick_settings',
  'composer_turn_timer',
  'scratchpad_pin',
  'turn_activity_envelope',
  'katex_math',
  'artifact_renderer_registry',
  'artifact_html_preview',
  'settings_search',
  'setup_hub',
  'mcp_management_ui',
  'model_management_ui',
  'chat_timeline_render_telemetry',
  'workspace_root_nudge',
  'workspace_preview_surface',
  'file_preview_html_render',
  'titlebar_gpu_telemetry',
  'workspace_explorer_qol',
  'workspace_external_import',
  'surface_effect_heartbeat',
  'workspace_file_map',
  'mcp_http_transport',
  'model_fit_estimates',
  'subagent_batch',
  'vision_unified_turn',
  'canonical_text_primary',
]);

test('retired 2026-10-06 flags are gone from the registry and their env names are silently ignored', () => {
  const defaults = buildFeatureFlags({});
  const defaultsViaHelper = buildFeatureFlagDefaults({});
  for (const key of RETIRED_2026_10_06) {
    const env = `JENNY_ENABLE_${key.toUpperCase()}`;
    assert.deepEqual(RETIRED_FEATURE_FLAG_ENV_KEYS[key], { env, removeIn: '1.5.0' });
    assert.equal(INTERNAL_FEATURE_FLAG_KEYS.includes(key), false, `${key} left INTERNAL_FEATURE_FLAG_KEYS`);
    assert.equal(FEATURE_OVERRIDE_KEYS.includes(key), false, `${key} is not user-overridable`);
    assert.equal(Object.hasOwn(defaults, key), false, `${key} is not emitted`);
    assert.equal(Object.hasOwn(defaultsViaHelper, key), false, `${key} has no default`);
    assert.equal(Object.values(FORCE_DENY_ENV_KEYS).includes(env), false);
  }
  // A stale stored override for a retired key is dropped, not rejected.
  const staleOverrides = Object.fromEntries(RETIRED_2026_10_06.map((key) => [key, false]));
  assert.deepEqual(normalizeFeatureOverrides(staleOverrides), {});
  // Both kill-switch values are accepted and change nothing.
  for (const value of ['0', '1', 'false', 'true']) {
    const env = Object.fromEntries(RETIRED_2026_10_06.map((key) => [`JENNY_ENABLE_${key.toUpperCase()}`, value]));
    let flags;
    assert.doesNotThrow(() => { flags = buildFeatureFlags(env, staleOverrides); });
    assert.deepEqual(flags, defaults, `JENNY_ENABLE_*=${value} for retired keys must be ignored`);
  }
});
