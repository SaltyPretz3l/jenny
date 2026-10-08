const {
  TOOL_SETTING_KEYS,
} = require('./tool-config-schema');

function isFeatureEnabledByDefault(envValue, defaultValue = true) {
  const normalized = String(envValue || '').trim().toLowerCase();
  if (!normalized) {
    return defaultValue === true;
  }
  if (/^(1|true|yes|on)$/.test(normalized)) {
    return true;
  }
  if (/^(0|false|no|off)$/.test(normalized)) {
    return false;
  }
  return defaultValue === true;
}

const FEATURE_OVERRIDE_KEYS = Object.freeze([
  'token_budget',
  'context_compaction',
  'api_retry',
  'skills_system',
  'shell_security',
  'strict_auto_run',
  'git_tracking',
  'pretext_layout',
  'command_palette',
  'agent_progress_durable',
  'resource_discipline',
  // Error-surfacing overhaul W7: unified error intake routing (normalize +
  // route every renderer error through one policy table). Default-on since the
  // EH-W12 soak; Settings Advanced / JENNY_ENABLE_ERROR_INTAKE_ROUTING=0 roll
  // back until the flag is removed at the end of the cleanup wave (the
  // top_nav_shell precedent), so rollback never needs an env var.
  'error_intake_routing',
  // unattended_guard is user-overridable so the idle safety fallback can be
  // disabled without removing its main-process wiring.
  'unattended_guard',
  // ollama_tray_remediation is user-overridable (Settings) so the owner-
  // triggered Ollama tray-conflict remediation actions (quit tray app,
  // disable Startup shortcut, restart engine) can be turned off per-user
  // without an env var.
  'ollama_tray_remediation',
  // text_spellcheck is user-overridable (Settings > Appearance > "Check
  // spelling as you type") and default-ON; JENNY_ENABLE_TEXT_SPELLCHECK=0 sets
  // the default off while a stored user override still wins.
  //
  // OFF IS NOT A ROLLBACK TO PRE-CHANGE BEHAVIOUR, deliberately. It disables
  // Chromium's spellchecker for the whole default session (see
  // services/main/spellcheck-session-controller.js), so the chat composer also
  // loses the squiggles and correction suggestions it had BEFORE this flag
  // existed -- Chromium spellchecks it by webPreferences default, which is why
  // spellcheck-menu-bridge.js predates this flag. That is the only coherent
  // reading of the user-facing toggle: "check spelling as you type: off" that
  // still underlines your chat message would be a bug. An operator who wants
  // only the DELEGATED menu gone with the composer untouched must revert the
  // change, not set the env var.
  //
  // The DOM keeps its inert spellcheck="true" attributes while off, so flag-off
  // is behaviourally coherent but NOT byte-identical markup.
  'text_spellcheck',
]);

const FORCE_DENY_ENV_KEYS = Object.freeze({
  session_runtime: 'JENNY_ENABLE_SESSION_RUNTIME',
});

// Retired flags whose JENNY_ENABLE_* name is still ACCEPTED AND IGNORED until
// the listed release, so a leftover operator setting stays harmless: no flag
// key is emitted and nothing reads the env var. Drop each entry at removeIn.
// The plugin platform's own `plugins` and `plugin_developer_profile` flags went
// with its deletion (owner, 2026-10-05).
// Failed-attempt reasoning capture for retries was deleted unreplayed, and the
// unproven stream envelope v2 transport was deleted (owner, 2026-10-05).
const RETIRED_FEATURE_FLAG_ENV_KEYS = Object.freeze({
  failure_retry_reasoning_carry: Object.freeze({ env: 'JENNY_ENABLE_FAILURE_RETRY_REASONING_CARRY', removeIn: '1.4.0' }),
  stream_envelope_v2: Object.freeze({ env: 'JENNY_ENABLE_STREAM_ENVELOPE_V2', removeIn: '1.4.0' }),
  plugins: Object.freeze({ env: 'JENNY_ENABLE_PLUGINS', removeIn: '1.5.0' }),
  plugin_developer_profile: Object.freeze({ env: 'JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE', removeIn: '1.5.0' }),
  // Row 39 (owner, 2026-10-06): default-ON flags collapsed to their ON
  // behaviour, and the compatibility-only subagent_batch input dropped.
  chatgpt_auth_turn_retry: Object.freeze({ env: 'JENNY_ENABLE_CHATGPT_AUTH_TURN_RETRY', removeIn: '1.5.0' }),
  reasoning_prettify: Object.freeze({ env: 'JENNY_ENABLE_REASONING_PRETTIFY', removeIn: '1.5.0' }),
  quick_settings: Object.freeze({ env: 'JENNY_ENABLE_QUICK_SETTINGS', removeIn: '1.5.0' }),
  composer_turn_timer: Object.freeze({ env: 'JENNY_ENABLE_COMPOSER_TURN_TIMER', removeIn: '1.5.0' }),
  scratchpad_pin: Object.freeze({ env: 'JENNY_ENABLE_SCRATCHPAD_PIN', removeIn: '1.5.0' }),
  turn_activity_envelope: Object.freeze({ env: 'JENNY_ENABLE_TURN_ACTIVITY_ENVELOPE', removeIn: '1.5.0' }),
  katex_math: Object.freeze({ env: 'JENNY_ENABLE_KATEX_MATH', removeIn: '1.5.0' }),
  artifact_renderer_registry: Object.freeze({ env: 'JENNY_ENABLE_ARTIFACT_RENDERER_REGISTRY', removeIn: '1.5.0' }),
  artifact_html_preview: Object.freeze({ env: 'JENNY_ENABLE_ARTIFACT_HTML_PREVIEW', removeIn: '1.5.0' }),
  settings_search: Object.freeze({ env: 'JENNY_ENABLE_SETTINGS_SEARCH', removeIn: '1.5.0' }),
  setup_hub: Object.freeze({ env: 'JENNY_ENABLE_SETUP_HUB', removeIn: '1.5.0' }),
  mcp_management_ui: Object.freeze({ env: 'JENNY_ENABLE_MCP_MANAGEMENT_UI', removeIn: '1.5.0' }),
  model_management_ui: Object.freeze({ env: 'JENNY_ENABLE_MODEL_MANAGEMENT_UI', removeIn: '1.5.0' }),
  chat_timeline_render_telemetry: Object.freeze({ env: 'JENNY_ENABLE_CHAT_TIMELINE_RENDER_TELEMETRY', removeIn: '1.5.0' }),
  workspace_root_nudge: Object.freeze({ env: 'JENNY_ENABLE_WORKSPACE_ROOT_NUDGE', removeIn: '1.5.0' }),
  workspace_preview_surface: Object.freeze({ env: 'JENNY_ENABLE_WORKSPACE_PREVIEW_SURFACE', removeIn: '1.5.0' }),
  file_preview_html_render: Object.freeze({ env: 'JENNY_ENABLE_FILE_PREVIEW_HTML_RENDER', removeIn: '1.5.0' }),
  titlebar_gpu_telemetry: Object.freeze({ env: 'JENNY_ENABLE_TITLEBAR_GPU_TELEMETRY', removeIn: '1.5.0' }),
  workspace_explorer_qol: Object.freeze({ env: 'JENNY_ENABLE_WORKSPACE_EXPLORER_QOL', removeIn: '1.5.0' }),
  workspace_external_import: Object.freeze({ env: 'JENNY_ENABLE_WORKSPACE_EXTERNAL_IMPORT', removeIn: '1.5.0' }),
  surface_effect_heartbeat: Object.freeze({ env: 'JENNY_ENABLE_SURFACE_EFFECT_HEARTBEAT', removeIn: '1.5.0' }),
  workspace_file_map: Object.freeze({ env: 'JENNY_ENABLE_WORKSPACE_FILE_MAP', removeIn: '1.5.0' }),
  mcp_http_transport: Object.freeze({ env: 'JENNY_ENABLE_MCP_HTTP_TRANSPORT', removeIn: '1.5.0' }),
  model_fit_estimates: Object.freeze({ env: 'JENNY_ENABLE_MODEL_FIT_ESTIMATES', removeIn: '1.5.0' }),
  subagent_batch: Object.freeze({ env: 'JENNY_ENABLE_SUBAGENT_BATCH', removeIn: '1.5.0' }),
  // Row 39 B1 (2026-10-06): the legacy vision and plain-chat live-stream paths
  // these gated are deleted from the sidecar.
  vision_unified_turn: Object.freeze({ env: 'JENNY_ENABLE_VISION_UNIFIED_TURN', removeIn: '1.5.0' }),
  canonical_text_primary: Object.freeze({ env: 'JENNY_ENABLE_CANONICAL_TEXT_PRIMARY', removeIn: '1.5.0' }),
});

const INTERNAL_FEATURE_FLAG_KEYS = Object.freeze([
  'session_runtime',
  'agent_executor',
  'task_lifecycle',
  'multiplexer',
  'chat_cancel',
  'phase_events',
  'canonical_m3_rollout',
  'canonical_turn_events',
  'canonical_bridge',
  'chat_stream_paint_v2',
  'chat_stream_token_fade',
  'aggregate_checkpoints',
  'reasoning_wire_deltas',
  'canonical_renderer_projection',
  'workspace_manifest',
  'repo_delta_resume',
  'task_capsule',
  'mcp_resources',
  'tools_automations_enabled',
  // gates the default-on workspace_present presentation tool
  'tools_workspace_present_enabled',
  // gates the default-on preview_test workspace HTML tester
  'tools_preview_test_enabled',
  // gates the default-OFF verify tool (runs the user's saved Test Runner configs)
  'tools_verify_enabled',
  // gates the default-on image_generate local image tool
  'tools_image_generate_enabled',
  // gates the default-on consolidated `home` tool
  'tools_home_enabled',
  // gates the default-on durable Open Loops task_board tool
  'tools_task_board_enabled',
  // gates the default-on per-project note tool (project_notes)
  'tools_project_notes_enabled',
  // gates the default-on OS toast notifier; Settings owns the user switch
  'desktop_notifications',
  'agent_test_hooks',
  // surface_effect_gallery gates the dev-only, nav-unlinked surface-effect
  // review gallery (window.__jennySurfaceGallery.open()). Never linked from
  // Settings navigation or reachable by keyboard shortcut in an end-user
  // build. Defaults on under the agent/dev launcher (JENNY_AGENT_DEV) and off
  // everywhere else, same as agent_test_hooks.
  'surface_effect_gallery',
  // startup_animation is the kill switch for the boot curtain's starfield; the
  // user choice is the persisted appearance toggle, so this stays env-only.
  'startup_animation',
  'workspace_git',
  'workspace_codebase_context',
  'workspace_active_file_context',
  'workspace_ghost_edit',
  'workspace_test_runner',
  'web_search_providers',
  // Provider-aware prompt caching and bounded deferred tool search are runtime
  // policy, not routine user preferences. Both remain default-on with an
  // environment-only rollback switch.
  'prompt_cache',
  'tool_search',
  // source_citations gates the collector-derived `source_citations` turn-event
  // kind + the renderer citation-chip row (web_search provenance). Internal,
  // DEFAULT-ON since 2026-07-02; JENNY_ENABLE_SOURCE_CITATIONS=0 rolls back.
  'source_citations',
  // knowledge_layer gates the user-folder "knowledge roots" registry
  // (KnowledgeService + knowledge.* IPC + knowledge_roots managed-sidecar
  // config). Internal, DEFAULT-ON since 2026-07-02; flag-off (=0) is byte-identical
  // (service inert, no knowledge.json, handlers not registered, no config keys).
  'knowledge_layer',
  // semantic_catalog gates the passive bring-your-own embedding index over the
  // knowledge folders (row 41). Internal, DEFAULT-ON (inert until the user picks
  // an embedding model); JENNY_ENABLE_SEMANTIC_CATALOG=0 is the kill switch.
  'semantic_catalog',
  // thread_root_markup_memo gates settled-root markdown->HTML memoization
  // (finding #3). Internal, DEFAULT-ON with env-only rollback
  // (JENNY_ENABLE_THREAD_ROOT_MARKUP_MEMO=0).
  'thread_root_markup_memo',
  // ide_chat_dock gates the Workspace Chat Dock (the chat subtree relocated
  // into an IDE side column; same controller, no second instance). Internal,
  // DEFAULT-ON with env-only rollback (JENNY_ENABLE_IDE_CHAT_DOCK=0 —
  // flag-off is byte-identical: the nodes never leave #chatView).
  'ide_chat_dock',
  // chat_render_content_visibility (Ht-D) gates the chat transcript
  // content-visibility paint-skip. Internal, DEFAULT-ON with env-only
  // rollback (JENNY_ENABLE_CHAT_RENDER_CONTENT_VISIBILITY=0).
  'chat_render_content_visibility',
  // verification_gate gates the turn-finalization gate that runs the user's
  // designated Test Runner configuration after a typed file mutation and hands a
  // failing verdict back to the model. Internal, DEFAULT-OFF.
  'verification_gate',
  // chat_timeline_streaming_article_morph gates Track B's in-place keyed morph
  // for structural streaming article rebuilds. Internal, DEFAULT-ON since
  // 2026-07-11 (live telemetry confirmed the raw-innerHTML swap as the
  // turn-boundary repaint flash); set
  // JENNY_ENABLE_CHAT_TIMELINE_STREAMING_ARTICLE_MORPH=0 to roll back to the
  // historical raw innerHTML replacement path.
  'chat_timeline_streaming_article_morph',
  // chat_long_thread_bounds caps rebuildable renderer projection/markup
  // caches and virtualized transcript state. Electron remains the canonical
  // history owner. Internal, DEFAULT-ON; set
  // JENNY_ENABLE_CHAT_LONG_THREAD_BOUNDS=0 to restore the prior full-history
  // renderer cache/virtualizer path during the R2 soak.
  'chat_long_thread_bounds',
  // session_journal stores chat files as a base plus append-only journal
  // (services/backend/session-journal-wiring.js). Internal, DEFAULT-ON; set
  // JENNY_ENABLE_SESSION_JOURNAL=0 to make every chat write replace the whole
  // file again (journals already on disk are still read).
  'session_journal',
  // Per-session chat egress gate. Default-on with env-only rollback.
  'session_offline_lockdown',
  // llama_server_acceleration gates the managed llama-server product surface:
  // speculative-decoding launch args, the per-model Engine/MTP controls in the
  // Model library (row pills + Tune drawer Engine section), and the
  // `engines.updateSettings {acceleration, managed}` keys. Internal, DEFAULT-ON
  // since 2026-09-01; JENNY_ENABLE_LLAMA_SERVER_ACCELERATION=0 rolls back
  // byte-identical (no probe, no args, no DOM).
  'llama_server_acceleration',
]);

function normalizeBooleanOverride(value) {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  return null;
}

function normalizeFeatureOverrides(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const key of FEATURE_OVERRIDE_KEYS) {
    const candidate = normalizeBooleanOverride(source[key]);
    if (candidate == null) {
      continue;
    }
    normalized[key] = candidate;
  }
  return normalized;
}

function buildFeatureFlagDefaults(env = process.env) {
  const fe = (key, defaultValue = true) =>
    isFeatureEnabledByDefault(env[`JENNY_ENABLE_${key}`], defaultValue);
  // Canonical M3 is DEFAULT-ON; one rollout override rolls both derived flags back.
  // Set JENNY_ENABLE_CANONICAL_M3_ROLLOUT=0 to disable both derived flags.
  const canonicalM3Rollout = fe('CANONICAL_M3_ROLLOUT', true);
  const canonicalM3Default = (key, defaultValue = false) =>
    fe(key, canonicalM3Rollout === true ? true : defaultValue);

  return {
    skills_system: fe('SKILLS_SYSTEM'),
    token_budget: fe('TOKEN_BUDGET'),
    context_compaction: fe('CONTEXT_COMPACTION'),
    api_retry: fe('API_RETRY'),
    prompt_cache: fe('PROMPT_CACHE'),
    tool_search: fe('TOOL_SEARCH'),
    shell_security: fe('SHELL_SECURITY'),
    // DEFAULT-OFF: fail-closed classification makes Auto mode chattier, so this stays opt-in.
    strict_auto_run: fe('STRICT_AUTO_RUN', false),
    git_tracking: fe('GIT_TRACKING'),
    pretext_layout: fe('PRETEXT_LAYOUT', true),
    command_palette: fe('COMMAND_PALETTE', true),
    agent_progress_durable: fe('AGENT_PROGRESS_DURABLE', false),
    resource_discipline: fe('RESOURCE_DISCIPLINE', true),
    session_offline_lockdown: fe('SESSION_OFFLINE_LOCKDOWN', true),
    // thread_root_markup_memo gates settled-root markdown->HTML memoization in
    // the thread-DOM renderer (finding #3): unchanged settled roots reuse a
    // cached article-markup string instead of rebuilding it every full
    // render. Internal, DEFAULT-ON; set JENNY_ENABLE_THREAD_ROOT_MARKUP_MEMO=0
    // to roll back to always-rebuild-fresh (byte-identical output either way).
    thread_root_markup_memo: fe('THREAD_ROOT_MARKUP_MEMO', true),
    // agent_executor gates the runtime wrapper and its agent.progress notifications
    // (delegate child progress is forwarded either way: work-lifecycle-coordinator.js).
    agent_executor: fe('AGENT_EXECUTOR', false),
    // task_lifecycle only affects task tracking and transcript repair inside the executor.
    task_lifecycle: fe('TASK_LIFECYCLE', false),
    // multiplexer enables the Batch 4 single-pipe routed transport.
    multiplexer: fe('MULTIPLEXER', true),
    // chat_cancel enables end-to-end chat cancellation over the routed transport.
    chat_cancel: fe('CHAT_CANCEL', true),
    // phase_events enables Batch 5 semantic phase notifications. DEFAULT-ON
    // since 2026-08-28: chat_turn_v2 (removed) had forced it on for every
    // install since its own default-on flip, so true preserves live behavior.
    // Set JENNY_ENABLE_PHASE_EVENTS=0 to roll back.
    phase_events: fe('PHASE_EVENTS', true),
    // canonical_m3_rollout keeps the canonical stack default-on with one rollback.
    canonical_m3_rollout: canonicalM3Rollout,
    // canonical_turn_events follows canonical_m3_rollout unless independently overridden.
    canonical_turn_events: canonicalM3Default('CANONICAL_TURN_EVENTS'),
    // canonical_bridge follows the same rollout and projects accepted turn.event payloads.
    canonical_bridge: canonicalM3Default('CANONICAL_BRIDGE'),
    // chat_stream_paint_v2 (Ht-C) gates streaming paint-minimization in the
    // live reasoning patch path: summary-only deltas morph the reasoning
    // header in place instead of destructively rewriting its innerHTML every
    // tick. Internal. DEFAULT-ON at landing (owner-directed 2026-07-05,
    // weekend-soak sweep posture); set JENNY_ENABLE_CHAT_STREAM_PAINT_V2=0
    // to roll back to the rewrite path (byte-identical pre-Ht-C behavior).
    chat_stream_paint_v2: fe('CHAT_STREAM_PAINT_V2', true),
    // chat_stream_token_fade gates the streaming answer token fade.
    // OFF restores today's plain per-frame innerHTML write; default ON.
    // Set JENNY_ENABLE_CHAT_STREAM_TOKEN_FADE=0 to roll back.
    chat_stream_token_fade: fe('CHAT_STREAM_TOKEN_FADE', true),
    // aggregate_checkpoints gates full cumulative `aggregate` values on live
    // delta frames. DEFAULT-ON; set JENNY_ENABLE_AGGREGATE_CHECKPOINTS=0 to
    // roll back. Checkpoints avoid frames x final_length serialization growth
    // and keep background-session deltas under the buffered-bytes cap.
    aggregate_checkpoints: fe('AGGREGATE_CHECKPOINTS', true),
    // reasoning_wire_deltas emits proven append edits plus periodic snapshots.
    // DEFAULT-ON since 2026-10-05 (owner); consumers discriminate per entry
    // unconditionally, so edit and snapshot shapes coexist. Still owed: a trace
    // crossing the truncation cap and `npm run smoke:gui`.
    // JENNY_ENABLE_REASONING_WIRE_DELTAS=0 rolls back to full snapshots.
    reasoning_wire_deltas: fe('REASONING_WIRE_DELTAS', true),
    // canonical_renderer_projection routes HYDRATED rows through the live fold
    // (renderer-stream-rehydrate projectPersistedEventsWithReducer) instead of the
    // turn-row projector, so a reloaded turn and a streaming one are built by the
    // same code. DEFAULT-ON since 2026-08-25, Wave 3c of the chat-timeline
    // consolidation: the fold now loses no populated field the projector renders,
    // asserted directly by the delegation gate in
    // tests/timeline-fold-convergence-gap.test.js. Graduated out of the
    // canonicalM3Default canary group by that flip. Set
    // JENNY_ENABLE_CANONICAL_RENDERER_PROJECTION=0 to roll back.
    canonical_renderer_projection: fe('CANONICAL_RENDERER_PROJECTION', true),
    // workspace_manifest gates runtime workspace orientation. DEFAULT-ON since
    // 2026-07-07 (owner-directed flip for in-app testing); set
    // JENNY_ENABLE_WORKSPACE_MANIFEST=0 to roll back.
    workspace_manifest: fe('WORKSPACE_MANIFEST', true),
    // repo_delta_resume gates the <repository-delta> turn-start injection.
    // DEFAULT-ON since 2026-07-07 (owner-directed flip for in-app testing); set
    // JENNY_ENABLE_REPO_DELTA_RESUME=0 to roll back.
    repo_delta_resume: fe('REPO_DELTA_RESUME', true),
    // workspace_git gates the workspaceGit.* SCM-foundation IPC namespace + the
    // Tier-2 Source Control IDE slice (panel, tree decorations, diff-vs-HEAD,
    // statusbar branch chip). Default-on after the slice soaked; set
    // JENNY_ENABLE_WORKSPACE_GIT=0 to roll back.
    workspace_git: fe('WORKSPACE_GIT', true),
    // workspace_codebase_context gates the Tier-3 keyword code-search context
    // backend task: a bounded keyword/substring search over the workspace root
    // spliced into chat context so the model can cite real file:line locations.
    // It is plain keyword grounding — NOT embeddings or semantic Q&A. Default-ON
    // now that the IDE is mature; set JENNY_ENABLE_WORKSPACE_CODEBASE_CONTEXT=0 to
    // roll back. Also gated by the include_codebase_context context-pref (default-on).
    workspace_codebase_context: fe('WORKSPACE_CODEBASE_CONTEXT', true),
    // workspace_active_file_context gates the Tier-3 "implicit active-file
    // context + @-mentions" feature: the active editor file's cursor-region
    // slice (shown via a removable composer chip) plus @-mentioned file contents
    // are spliced into chat context per turn. Default-ON for real-world soak now
    // that the viability gate (deterministic context-budget trimmer + large-file
    // "too large to auto-context" signal, 6c1cd33) is satisfied; set
    // JENNY_ENABLE_WORKSPACE_ACTIVE_FILE_CONTEXT=0 to roll back. When on, the
    // in-composer chip defaults to active for the session.
    workspace_active_file_context: fe('WORKSPACE_ACTIVE_FILE_CONTEXT', true),
    // Legacy compatibility key. Automatic change-diff surfacing is retired:
    // Jenny's Changes remains passive until the user or model explicitly asks
    // to review a recorded change. Keep the default off while older profiles
    // and environment overrides age out; enabling it has no runtime effect.
    workspace_ghost_edit: fe('WORKSPACE_GHOST_EDIT', false),
    // ide_chat_dock gates the Workspace Chat Dock: the live chat transcript +
    // active-turn deck + composer subtree relocated into a full-height side
    // column of the Workspace IDE (relocation, not duplication — the one
    // always-alive chat controller keeps driving the moved nodes). DEFAULT-ON;
    // set JENNY_ENABLE_IDE_CHAT_DOCK=0 to roll back (byte-identical: nodes
    // never leave #chatView, main-chat approval-lock unchanged).
    ide_chat_dock: fe('IDE_CHAT_DOCK', true),
    // chat_render_content_visibility (Ht-D) gates content-visibility:auto
    // paint-skip on chat transcript turn-articles (.chat-entry), mirrored
    // onto document.documentElement.dataset.chatContentVisibility ('on' when
    // ON; ATTRIBUTE ABSENT — not 'false' — when OFF, so the CSS rule is
    // inert and markup is byte-identical pre-Ht-D). Complements, never
    // replaces, the JS virtualizer. Exemptions (never paint-skipped): the
    // active/pending turn, turns with an unresolved approval gate, and the
    // bottom-2 turn-articles. DEFAULT-ON (owner-ratified design spec,
    // 2026-07-05); set JENNY_ENABLE_CHAT_RENDER_CONTENT_VISIBILITY=0 to roll
    // back to pre-Ht-D behavior.
    chat_render_content_visibility: fe('CHAT_RENDER_CONTENT_VISIBILITY', true),
    // task_capsule gates default-off coding-turn orientation for local models.
    task_capsule: fe('TASK_CAPSULE', false),
    // mcp_resources gates default-off MCP resource/list/read tools.
    mcp_resources: fe('MCP_RESOURCES', false),
    // tools_automations_enabled gates default-off automation list/read tools.
    tools_automations_enabled: fe('TOOLS_AUTOMATIONS', false),
    // tools_workspace_present_enabled gates the workspace_present
    // presentation tool. DEFAULT-ON; set JENNY_ENABLE_TOOLS_WORKSPACE_PRESENT=0
    // to roll back (the tool is not registered, byte-identical to today's
    // flag-off behavior).
    tools_workspace_present_enabled: fe('TOOLS_WORKSPACE_PRESENT', true),
    // tools_preview_test_enabled gates the preview_test workspace HTML tester.
    // DEFAULT-ON; set JENNY_ENABLE_TOOLS_PREVIEW_TEST=0 to roll back (the tool
    // is not registered, byte-identical to flag-off behavior).
    tools_preview_test_enabled: fe('TOOLS_PREVIEW_TEST', true),
    // tools_verify_enabled gates the `verify` tool, which lets the model run
    // one of the user's own saved Workspace Test Runner configurations.
    // DEFAULT-OFF pending owner sign-off; set JENNY_ENABLE_TOOLS_VERIFY=1 to
    // register it (flag-off is byte-identical to today: the tool is not
    // registered and never reaches the manifest-derived contract).
    tools_verify_enabled: fe('TOOLS_VERIFY', false),
    // tools_image_generate_enabled gates the image_generate local image tool.
    // DEFAULT-ON; set JENNY_ENABLE_TOOLS_IMAGE_GENERATE=0 to roll back (the tool
    // is not registered, byte-identical to flag-off behavior).
    tools_image_generate_enabled: fe('TOOLS_IMAGE_GENERATE', true),
    // tools_home_enabled gates the consolidated `home` tool (calendar,
    // reminders, read-only scratchpad). DEFAULT-ON; set
    // JENNY_ENABLE_TOOLS_HOME=0 to roll back (the tool is not registered,
    // byte-identical to today's flag-off behavior).
    tools_home_enabled: fe('TOOLS_HOME', true),
    // tools_task_board_enabled gates durable model-authored Open Loops tasks.
    // DEFAULT-ON; set JENNY_ENABLE_TOOLS_TASK_BOARD_ENABLED=0 to remove the
    // tool from both the Electron registry and managed-sidecar catalog.
    tools_task_board_enabled: fe('TOOLS_TASK_BOARD_ENABLED', true),
    // tools_project_notes_enabled gates the model's read/append/replace access to
    // the per-project note. DEFAULT-ON; set
    // JENNY_ENABLE_TOOLS_PROJECT_NOTES_ENABLED=0 to remove the tool from both
    // the Electron registry and the managed-sidecar catalog.
    tools_project_notes_enabled: fe('TOOLS_PROJECT_NOTES_ENABLED', true),
    // error_intake_routing gates the EH intake controller (W8+) + the W11
    // error-center recorder. Default-on since the EH-W12 soak; Settings
    // Advanced / JENNY_ENABLE_ERROR_INTAKE_ROUTING=0 roll back (the raw toast
    // controller stays wired as the rollback surface) until the flag is
    // removed at the end of the cleanup wave.
    error_intake_routing: fe('ERROR_INTAKE_ROUTING', true),
    unattended_guard: fe('UNATTENDED_GUARD', true),
    // desktop_notifications gates the OS toast notifier for finished replies,
    // failed runs, permission requests and questions (services/main/
    // desktop-notifier.js). DEFAULT-ON kill switch
    // JENNY_ENABLE_DESKTOP_NOTIFICATIONS=0; not user-overridable because
    // Settings owns the user switch (windowUi.notifications.enabled).
    desktop_notifications: fe('DESKTOP_NOTIFICATIONS', true),
    // agent_test_hooks gates the window.__jennyAgent automation surface and
    // DEBUG-level renderer log forwarding. Defaults on under the agent/dev
    // launcher (JENNY_AGENT_DEV) and off everywhere else.
    agent_test_hooks: fe(
      'AGENT_TEST_HOOKS',
      isFeatureEnabledByDefault(env.JENNY_AGENT_DEV, false)
    ),
    // surface_effect_gallery gates the dev-only surface-effect review
    // gallery (Background Effects v3, packet S5): a full-screen overlay for
    // visually reviewing a background effect with pinned parameters (effect /
    // palette / motion / phase / energy / pointer / viewport / DPR / seed /
    // tier). It is nav-unlinked -- there is no Settings entry point and no
    // keyboard shortcut -- and is opened only programmatically via
    // window.__jennySurfaceGallery.open() from a dev/owner review session.
    // Defaults on under the agent/dev launcher (JENNY_AGENT_DEV) and off
    // everywhere else, so it never ships reachable in an end-user build. Set
    // JENNY_ENABLE_SURFACE_EFFECT_GALLERY=1 to opt in for an owner review
    // session outside the agent/dev launcher.
    surface_effect_gallery: fe(
      'SURFACE_EFFECT_GALLERY',
      isFeatureEnabledByDefault(env.JENNY_AGENT_DEV, false)
    ),
    // startup_animation gates the boot curtain's starfield (a short swirl that
    // collapses into the wordmark once the shell is ready). The per-user choice
    // is Settings > Appearance > "Startup animation" (persisted appearance);
    // this is the kill switch. DEFAULT-ON; set JENNY_ENABLE_STARTUP_ANIMATION=0
    // to roll back to the plain curtain (no stars, no minimum hold).
    startup_animation: fe('STARTUP_ANIMATION', true),
    // workspace_test_runner gates the Workspace IDE Test Runner: headless
    // execution of a project's own test commands (own process + real exit code,
    // run through a shell) feeding a Home dashboard trend widget AND the IDE
    // bottom-panel "Test Runner" view (config authoring + live run/abort). Now
    // that the authoring UI + live panel have landed it ships DEFAULT-ON (internal
    // flag); set JENNY_ENABLE_WORKSPACE_TEST_RUNNER=0 to roll it back for this user.
    workspace_test_runner: fe('WORKSPACE_TEST_RUNNER', true),
    // web_search_providers gates ONLY the Settings UI surface for the
    // multi-provider web-search picker (SearXNG/Brave/Tavily/Serper/Google
    // PSE); the sidecar honors whatever provider config it is given and DDG
    // stays the zero-config default either way. DEFAULT-ON since 2026-07-01
    // (owner-directed flip for live testing); set
    // JENNY_ENABLE_WEB_SEARCH_PROVIDERS=0 to roll back.
    web_search_providers: fe('WEB_SEARCH_PROVIDERS', true),
    // source_citations (Citations) derives a persisted `source_citations`
    // turn-event kind from web_search tool_result citations/sources in the
    // canonical turn-event collector and renders clickable citation chips
    // beneath the answer. DEFAULT-ON since 2026-07-02 (owner-directed
    // pre-soak flip — live soak IS the vocabulary soak); set
    // JENNY_ENABLE_SOURCE_CITATIONS=0 to roll back.
    // Flag-off is byte-identical: no derived events, no chips.
    source_citations: fe('SOURCE_CITATIONS', true),
    // knowledge_layer gates the user-folder knowledge-roots registry
    // (KnowledgeService + knowledge.* IPC + knowledge_roots managed-sidecar
    // config). Internal. DEFAULT-ON since 2026-07-02 (owner-directed
    // pre-soak flip; inert until the user registers a folder); set
    // JENNY_ENABLE_KNOWLEDGE_LAYER=0 to roll back. Flag-off is
    // byte-identical: the service stays inert (no knowledge.json,
    // addFolder/removeFolder return feature_disabled), the IPC handlers are
    // not registered, and no config keys are published.
    knowledge_layer: fe('KNOWLEDGE_LAYER', true),
    // semantic_catalog: the passive embedding index over knowledge folders
    // (row 41). Local and offline, so DEFAULT-ON; inert until the user picks an
    // embedding GGUF in Settings. JENNY_ENABLE_SEMANTIC_CATALOG=0 stops the
    // scheduler and the embedder and withdraws the sidecar catalog config.
    semantic_catalog: fe('SEMANTIC_CATALOG', true),
    // ollama_tray_remediation gates the owner-triggered Ollama tray-conflict
    // remediation surface (ollamaTray.* IPC: quit the tray app, disable its
    // Startup shortcut, restart the engine). Explicit-click actions only —
    // detection (ollama-tray-conflict.js) stays always-on and unaffected by
    // this flag. Default-ON user-facing remediation surface; set
    // JENNY_ENABLE_OLLAMA_TRAY_REMEDIATION=0 to roll back. User-overridable
    // in Settings (FEATURE_OVERRIDE_KEYS).
    ollama_tray_remediation: fe('OLLAMA_TRAY_REMEDIATION', true),
    text_spellcheck: fe('TEXT_SPELLCHECK', true),
    session_runtime: fe('SESSION_RUNTIME', true),
    llama_server_acceleration: fe('LLAMA_SERVER_ACCELERATION', true),
    // verification_gate gates the turn-finalization verification gate (sidecar
    // routing/verification_gate.py). It also requires tools_verify_enabled,
    // since the gate reaches the Test Runner through the `verify` tool. The gate
    // can never prevent a turn from completing: a failing or unrunnable gate
    // becomes one honest sentence on the model's own response. DEFAULT-OFF
    // pending owner sign-off; JENNY_ENABLE_VERIFICATION_GATE=1 to try it.
    verification_gate: fe('VERIFICATION_GATE', false),
    // chat_timeline_streaming_article_morph gates Track B's in-place keyed
    // morph for structural streaming article rebuilds. DEFAULT-ON since
    // 2026-07-11: live telemetry (streaming_article_rebuild outcome=
    // raw_innerhtml at every turn boundary) confirmed the Rank-1 flicker
    // diagnosis, so the built cure ships; set
    // JENNY_ENABLE_CHAT_TIMELINE_STREAMING_ARTICLE_MORPH=0 to roll back.
    chat_timeline_streaming_article_morph: fe('CHAT_TIMELINE_STREAMING_ARTICLE_MORPH', true),
    // R2 bounded projection/virtualization. Flag-off keeps the pre-R2
    // full-history renderer caches and virtualizer retention behavior.
    chat_long_thread_bounds: fe('CHAT_LONG_THREAD_BOUNDS', true),
    // session_journal gates append-only chat-file journals. DEFAULT-ON; set
    // JENNY_ENABLE_SESSION_JOURNAL=0 to roll back to whole-file chat writes.
    session_journal: fe('SESSION_JOURNAL', true),
  };
}

function buildFeatureFlags(env = process.env, overrides = {}) {
  const flags = {
    ...buildFeatureFlagDefaults(env),
    ...normalizeFeatureOverrides(overrides),
  };
  for (const [key, envKey] of Object.entries(FORCE_DENY_ENV_KEYS)) {
    if (isFeatureEnabledByDefault(env[envKey], true) === false) {
      flags[key] = false;
    }
  }
  return flags;
}

module.exports = {
  FEATURE_OVERRIDE_KEYS,
  FORCE_DENY_ENV_KEYS,
  INTERNAL_FEATURE_FLAG_KEYS,
  RETIRED_FEATURE_FLAG_ENV_KEYS,
  TOOL_SETTING_KEYS,
  buildFeatureFlags,
  buildFeatureFlagDefaults,
  isFeatureEnabledByDefault,
  normalizeFeatureOverrides,
};
