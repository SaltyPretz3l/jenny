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
  'comet_personality',
  'comet_overlay',
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

const INTERNAL_FEATURE_FLAG_KEYS = Object.freeze([
  'agent_executor',
  'task_lifecycle',
  'multiplexer',
  'chat_cancel',
  'phase_events',
  'canonical_m3_rollout',
  'canonical_turn_events',
  'canonical_bridge',
  'chat_tool_trace_rows_fix',
  'chat_stream_paint_v2',
  'chat_stream_token_fade',
  'aggregate_checkpoints',
  'reasoning_wire_deltas',
  'stream_envelope_v2',
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
  // gates the default-on consolidated `home` tool
  'tools_home_enabled',
  // gates the default-on durable Open Loops task_board tool
  'tools_task_board_enabled',
  // Compatibility-only input retained for one release. No model-facing tool
  // consumes it after Delegation V2; keep parsing it so rollback configs load.
  'subagent_batch',
  'agent_test_hooks',
  // surface_effect_gallery gates the dev-only, nav-unlinked surface-effect
  // review gallery (window.__jennySurfaceGallery.open()). Never linked from
  // Settings navigation or reachable by keyboard shortcut in an end-user
  // build. Defaults on under the agent/dev launcher (JENNY_AGENT_DEV) and off
  // everywhere else, same as agent_test_hooks.
  'surface_effect_gallery',
  // surface_effect_heartbeat gates the S11 streamed-chunk cadence term. It is
  // default-on with env-only rollback; it never changes persisted appearance.
  'surface_effect_heartbeat',
  'workspace_git',
  'workspace_codebase_context',
  'workspace_active_file_context',
  'workspace_inline_suggest',
  'workspace_ghost_edit',
  'scratchpad_v2',
  'scratchpad_pin',
  'workspace_test_runner',
  'response_loop_display_v2',
  'katex_math',
  'artifact_renderer_registry',
  'web_search_providers',
  'settings_search',
  'compaction_manual',
  // context_usage_live gates the ephemeral mid-turn `context.usage` snapshot
  // that keeps the composer context ring honest during a long agentic turn.
  // Internal, DEFAULT-ON, gated at BOTH layers (the sidecar stops emitting and
  // this process stops forwarding).
  'context_usage_live',
  // chatgpt_plan_meter gates the ChatGPT subscription plan-usage composer
  // ring (sidecar header parse + Electron ingest/store/IPC + renderer chip).
  // Internal, DEFAULT-ON, gated at every layer (sidecar stops attaching the
  // wire key, Electron stops registering the IPC channels/ingest, renderer
  // hides the chip) -- any one layer alone rolls this back byte-identically.
  'chatgpt_plan_meter',
  // Provider-aware prompt caching and bounded deferred tool search are runtime
  // policy, not routine user preferences. Both remain default-on with an
  // environment-only rollback switch.
  'prompt_cache',
  'tool_search',
  // source_citations gates the collector-derived `source_citations` turn-event
  // kind + the renderer citation-chip row (web_search provenance). Internal,
  // DEFAULT-OFF (flips after a projector-parity soak).
  'source_citations',
  // artifact_html_preview gates the sandboxed executable-HTML artifact live
  // preview (staged jenny-artifact:// iframe, sandbox="allow-scripts",
  // strict no-network CSP).
  // Internal, DEFAULT-OFF (it executes model-authored JS — flips only after
  // the owner's manual sandbox pass + CSP hardening review).
  'artifact_html_preview',
  // knowledge_layer gates the user-folder "knowledge roots" registry
  // (KnowledgeService + knowledge.* IPC + knowledge_roots managed-sidecar
  // config). Internal, DEFAULT-OFF: flag-off is byte-identical (service inert,
  // no knowledge.json, handlers not registered, no config keys published).
  'knowledge_layer',
  // artifact_panel_v2 gates the Wave-4 artifact review panel redesign
  // (utility-strip chrome + per-session width persistence). Internal,
  // DEFAULT-ON with env-only rollback (JENNY_ENABLE_ARTIFACT_PANEL_V2=0).
  'artifact_panel_v2',
  // artifact_panel_v3 gates the Canvas chrome over the V2 panel shell.
  // Internal, DEFAULT-ON with env rollback to byte-identical V2 markup.
  'artifact_panel_v3',
  // mcp_http_transport gates the real MCP Streamable-HTTP/SSE transport
  // forwarding (Electron-side kill switch). Internal, DEFAULT-OFF.
  'mcp_http_transport',
  // mcp_management_ui gates the Settings > Tools "MCP servers" group (status
  // list + auth editor) that replaces the Skills-embedded MCP discovery
  // panel. Internal, DEFAULT-OFF (flips true in buildFeatureFlagDefaults
  // below per the 2026-07-05 owner-approved spec).
  'mcp_management_ui',
  // workspace_pty_terminal gates the real ConPTY terminal (@lydell/node-pty +
  // xterm.js) in the IDE bottom panel. Internal, DEFAULT-OFF.
  'workspace_pty_terminal',
  // thread_root_markup_memo gates settled-root markdown->HTML memoization
  // (finding #3). Internal, DEFAULT-ON with env-only rollback
  // (JENNY_ENABLE_THREAD_ROOT_MARKUP_MEMO=0).
  'thread_root_markup_memo',
  // turn_activity_envelope gates the cohesive turn-shell timeline (one
  // article per turn + collapsible activity envelope). Internal, DEFAULT-ON
  // with env-only rollback (JENNY_ENABLE_TURN_ACTIVITY_ENVELOPE=0).
  'turn_activity_envelope',
  // ide_chat_dock gates the Workspace Chat Dock (the chat subtree relocated
  // into an IDE side column; same controller, no second instance). Internal,
  // DEFAULT-ON with env-only rollback (JENNY_ENABLE_IDE_CHAT_DOCK=0 —
  // flag-off is byte-identical: the nodes never leave #chatView).
  'ide_chat_dock',
  // composer_turn_timer is DEFAULT-ON with env-only rollback (JENNY_ENABLE_COMPOSER_TURN_TIMER=0).
  'composer_turn_timer',
  // chat_render_content_visibility (Ht-D) gates the chat transcript
  // content-visibility paint-skip. Internal, DEFAULT-ON with env-only
  // rollback (JENNY_ENABLE_CHAT_RENDER_CONTENT_VISIBILITY=0).
  'chat_render_content_visibility',
  // workspace_file_map gates the IDE "Map" tab (interactive file-dependency
  // graph). Internal, DEFAULT-ON with env-only rollback
  // (JENNY_ENABLE_WORKSPACE_FILE_MAP=0 — flag-off is byte-identical: the Map
  // tab/affordance never appears).
  'workspace_file_map',
  // workspace_preview_surface gates the IDE unified Preview stage surface
  // (markdown/mermaid + sandboxed HTML preview of a workspace file) and its
  // activity-bar entry. Internal, DEFAULT-ON with env-only rollback
  // (JENNY_ENABLE_WORKSPACE_PREVIEW_SURFACE=0 — flag-off hides the entry and
  // the persisted surface falls back to the editor).
  'workspace_preview_surface',
  // file_preview_html_render gates the CHAT RAIL file-preview's sandboxed HTML
  // render for .html/.htm targets (the same staged jenny-artifact:// frame the
  // IDE Preview stage and HTML artifacts use). Internal, DEFAULT-ON with
  // env-only rollback (JENNY_ENABLE_FILE_PREVIEW_HTML_RENDER=0 — flag-off is
  // byte-identical: html falls back to the existing code view, no toggle, no
  // frame).
  'file_preview_html_render',
  // titlebar_gpu_telemetry gates the titlebar GPU% metric, staleness dimming,
  // and click-to-refresh. Flag-off renders the legacy CPU + VRAM/RAM strip
  // byte-identically.
  'titlebar_gpu_telemetry',
  // auto_checkpoint gates the opt-in safety net that auto-writes a git ref
  // (refs/jenny/checkpoints/*) before the first repo mutation of a run.
  // Internal, DEFAULT-ON since 2026-07-07; set JENNY_ENABLE_AUTO_CHECKPOINT=0 to roll back.
  'auto_checkpoint',
  // verification_gate gates the turn-finalization gate that runs the user's
  // designated Test Runner configuration after a typed file mutation and hands a
  // failing verdict back to the model. Internal, DEFAULT-OFF.
  'verification_gate',
  // workspace_exploded_view gates the IDE file-tab "Exploded" view (a
  // node-graph of one TS/JS file's functions/data + call/read/import wiring).
  // Internal, DEFAULT-ON since 2026-07-07; set JENNY_ENABLE_WORKSPACE_EXPLODED_VIEW=0
  // to roll back (flag-off is byte-identical: no toggle affordance, no host DOM).
  'workspace_exploded_view',
  // workspace_explorer_qol gates Explorer multi-select and its split active-file
  // presentation. Internal, DEFAULT-ON with env-only rollback
  // (JENNY_ENABLE_WORKSPACE_EXPLORER_QOL=0).
  'workspace_explorer_qol',
  // workspace_external_import gates absolute-path drag/drop imports into the
  // workspace. Internal, DEFAULT-ON with env-only rollback
  // (JENNY_ENABLE_WORKSPACE_EXTERNAL_IMPORT=0).
  'workspace_external_import',
  // chat_timeline_deterministic_row_id gates the structural DC1 flicker cure:
  // timeline reasoning/tool/assistant/approval rows derive their row_id from a
  // deterministic identity tuple (reasoning anchored on thinking_id) so the same
  // logical row keeps one DOM data-row-id across the live -> reconciled ->
  // canonical handoffs (no blink). Renderer-only. Internal, DEFAULT-ON since
  // 2026-07-07; set JENNY_ENABLE_CHAT_TIMELINE_DETERMINISTIC_ROW_ID=0 to roll back.
  // Flag-off is byte-identical: row_id stays `row:${event_id}` everywhere and
  // reconcile keeps its slice-scoped keys, so the timeline-replay corpus + its
  // EXPECTED_CORPUS_SHA256 are untouched.
  'chat_timeline_deterministic_row_id',
  // chat_timeline_render_telemetry gates TEMPORARY render-path diagnostics for
  // the streaming-flicker investigation (Track A): morph reuse/clone/removed
  // counts from the DOM-patch morph pass + patchActiveTurnRoot rebuild-reason
  // signals, logged via recordChatTimelineRolloutSignal so the owner can read
  // shell.log from one live streaming turn. Internal, DEFAULT-ON since
  // 2026-07-07; set JENNY_ENABLE_CHAT_TIMELINE_RENDER_TELEMETRY=0 to roll back.
  // (Flag-off is byte-identical: no stats objects observed, no extra log lines.)
  'chat_timeline_render_telemetry',
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
  // quick_settings gates the Tier D quick-settings modal (JENNY_UIUX_OVERHAUL_PLAN.md
  // L91-94): the Ctrl/Cmd+, chord + command-palette "Open quick settings" entry.
  // Internal, DEFAULT-ON; set JENNY_ENABLE_QUICK_SETTINGS=0 to roll back
  // (flag-off is byte-identical: the chord no-ops, the palette item never appears).
  'quick_settings',
  // cloud_loop_profile gates the engine-keyed resource-discipline profile: when
  // the ACTIVE (post-fallback) sidecar engine is a cloud frontier engine, the
  // loop/tool budgets widen; every local engine keeps today's caps, and a cloud
  // engine that fell back to `mock` degrades to the local profile. Internal,
  // DEFAULT-ON; set JENNY_ENABLE_CLOUD_LOOP_PROFILE=0 to roll back to a single
  // engine-blind profile (byte-identical to the pre-flag behavior).
  'cloud_loop_profile',
  // Per-session chat egress gate. Default-on with env-only rollback.
  'session_offline_lockdown',
  // llama_server_acceleration gates the managed llama-server product surface:
  // speculative-decoding launch args, the per-model Engine/MTP controls in the
  // Model library (row pills + Tune drawer Engine section), and the
  // `engines.updateSettings {acceleration, managed}` keys. Internal, DEFAULT-ON
  // since 2026-09-01; JENNY_ENABLE_LLAMA_SERVER_ACCELERATION=0 rolls back
  // byte-identical (no probe, no args, no DOM).
  'llama_server_acceleration',
  // model_fit_estimates gates the pure-estimator fit computed for installed
  // local models with no catalog entry (services/model-fit-estimator.js),
  // surfaced in diagnostics as modelFitEstimates. No UI in this wave.
  // Internal, DEFAULT-ON; JENNY_ENABLE_MODEL_FIT_ESTIMATES=0 rolls back to
  // modelFitEstimates always being [].
  'model_fit_estimates',
  // chatgpt_auth_turn_retry gates the M2 request-time 401 recovery: a ChatGPT
  // token that expires mid-turn takes ONE forced refresh + managed reconfigure
  // + same-request_id retry, but only before the turn produced any output or
  // tool effect. Internal, DEFAULT-ON; set
  // JENNY_ENABLE_CHATGPT_AUTH_TURN_RETRY=0 to roll back to the pre-M2 behavior
  // (the 401 stays terminal and the stale token stays installed).
  'chatgpt_auth_turn_retry',
  // plugins gates the plugin-platform control plane (PLUGIN_SYSTEM_ARCHITECTURE
  // _AND_ROADMAP.md). Internal, DEFAULT-ON at the Stage 7 exit boundary;
  // JENNY_ENABLE_PLUGINS=0 remains the emergency kill switch. Earlier stages
  // phases: flag-off is byte-identical (no plugin service composed, no plugins.*
  // IPC registered, no userData/plugins access). Independent of the launch-level
  // plugins-safe-mode switch, which bypasses activation regardless of this flag.
  'plugins',
  // privileged_plugins gates every Stage 8 native/full-host contribution.
  // It is deliberately default-off and independent of the Stage 7 plugin
  // control plane so rollback preserves declarative/restricted/view plugins.
  'privileged_plugins',
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
  const canonicalM3Rollout = fe('CANONICAL_M3_ROLLOUT', false);
  const canonicalM3Default = (key, defaultValue = false) =>
    fe(key, canonicalM3Rollout === true ? true : defaultValue);

  return {
    skills_system: fe('SKILLS_SYSTEM'),
    token_budget: fe('TOKEN_BUDGET'),
    context_compaction: fe('CONTEXT_COMPACTION'),
    // compaction_manual gates the Settings "Compact now" button (Compaction
    // Tunability + Manual Compact) AND consumption of the persisted
    // compaction snapshot on chat.send. Internal (not user-overridable).
    // DEFAULT-ON again since 2026-07-20: JCA-003 is closed — chat.compact
    // returns the compacted messages, Electron persists them as a versioned
    // session-owned snapshot (schema v16), and chat.send substitutes them for
    // the summarized prefix (invalidated on truncate/edit/branch). Roll back
    // with JENNY_ENABLE_COMPACTION_MANUAL=0 (stops both the button and
    // snapshot consumption).
    compaction_manual: fe('COMPACTION_MANUAL', true),
    // context_usage_live gates the mid-turn `context.usage` meter snapshots
    // (sidecar emission + this process's forwarding). DEFAULT-ON; set
    // JENNY_ENABLE_CONTEXT_USAGE_LIVE=0 to roll back to the terminal-only
    // meter, which is byte-identical to pre-feature behavior.
    context_usage_live: fe('CONTEXT_USAGE_LIVE', true),
    // chatgpt_plan_meter gates the ChatGPT plan-usage composer ring end to
    // end (sidecar header parse, Electron store/IPC, renderer chip).
    // DEFAULT-ON; set JENNY_ENABLE_CHATGPT_PLAN_METER=0 to roll back.
    chatgpt_plan_meter: fe('CHATGPT_PLAN_METER', true),
    api_retry: fe('API_RETRY'),
    prompt_cache: fe('PROMPT_CACHE'),
    tool_search: fe('TOOL_SEARCH'),
    shell_security: fe('SHELL_SECURITY'),
    // DEFAULT-OFF: fail-closed classification makes Auto mode chattier, so this stays opt-in.
    strict_auto_run: fe('STRICT_AUTO_RUN', false),
    git_tracking: fe('GIT_TRACKING'),
    comet_personality: fe('COMET_PERSONALITY', false),
    comet_overlay: fe('COMET_OVERLAY', false),
    pretext_layout: fe('PRETEXT_LAYOUT', true),
    command_palette: fe('COMMAND_PALETTE', true),
    agent_progress_durable: fe('AGENT_PROGRESS_DURABLE', false),
    resource_discipline: fe('RESOURCE_DISCIPLINE', true),
    cloud_loop_profile: fe('CLOUD_LOOP_PROFILE', true),
    session_offline_lockdown: fe('SESSION_OFFLINE_LOCKDOWN', true),
    // chatgpt_auth_turn_retry gates the one-shot mid-turn ChatGPT auth recovery
    // (forced token refresh + managed reconfigure + same-request_id retry,
    // allowed only before any output or tool effect). DEFAULT-ON; set
    // JENNY_ENABLE_CHATGPT_AUTH_TURN_RETRY=0 to roll back (flag-off is
    // byte-identical: the send goes straight through and a 401 stays terminal).
    chatgpt_auth_turn_retry: fe('CHATGPT_AUTH_TURN_RETRY', true),
    // plugins: plugin-platform control plane. DEFAULT-ON after Stage 7; the
    // environment override remains the owner kill switch.
    plugins: fe('PLUGINS', true),
    // plugin_developer_profile admits unsigned local packages while retaining every check except publisher signature.
    // Developer installs remain visibly labelled and isolated by source-trust kind in the shared plugin store.
    // Default-ON for authoring; JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE=0 is the owner kill switch.
    plugin_developer_profile: fe('PLUGIN_DEVELOPER_PROFILE', true),
    privileged_plugins: fe('PRIVILEGED_PLUGINS', false),
    // reasoning_prettify gates display-time whitespace repair for thinking
    // text from models that stop emitting newlines/spaces on long reasoning
    // streams (small local models under repeat_penalty). Render-only — stored
    // entry text is untouched. DEFAULT-ON; set JENNY_ENABLE_REASONING_PRETTIFY=0
    // to roll back to the raw join (byte-identical pre-feature markup).
    reasoning_prettify: fe('REASONING_PRETTIFY', true),
    // vision_unified_turn sends current-turn images through the normal tool loop.
    // DEFAULT-ON; set JENNY_ENABLE_VISION_UNIFIED_TURN=0 to restore the legacy
    // single-shot vision path for one release.
    vision_unified_turn: fe('VISION_UNIFIED_TURN', true),
    // thread_root_markup_memo gates settled-root markdown->HTML memoization in
    // the thread-DOM renderer (finding #3): unchanged settled roots reuse a
    // cached article-markup string instead of rebuilding it every full
    // render. Internal, DEFAULT-ON; set JENNY_ENABLE_THREAD_ROOT_MARKUP_MEMO=0
    // to roll back to always-rebuild-fresh (byte-identical output either way).
    thread_root_markup_memo: fe('THREAD_ROOT_MARKUP_MEMO', true),
    // agent_executor gates the runtime wrapper and agent.progress notifications.
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
    // canonical_m3_rollout enables the full canonical stack as a manual canary.
    canonical_m3_rollout: canonicalM3Rollout,
    // canonical_turn_events emits additive turn.event notifications beside legacy stream methods.
    canonical_turn_events: canonicalM3Default('CANONICAL_TURN_EVENTS'),
    // canonical_bridge lets Electron project accepted turn.event payloads into the existing stream seam.
    canonical_bridge: canonicalM3Default('CANONICAL_BRIDGE'),
    // chat_tool_trace_rows_fix (Ht-E) gates the settled-tool trace-row
    // partition on the non-coalescing turn fallback path (the f34016f
    // regression fix). DEFAULT-ON since 2026-07-01 (owner-directed flip for
    // live testing); set JENNY_ENABLE_CHAT_TOOL_TRACE_ROWS_FIX=0 to roll back.
    chat_tool_trace_rows_fix: fe('CHAT_TOOL_TRACE_ROWS_FIX', true),
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
    // quick_settings gates the Tier D quick-settings modal + its Ctrl/Cmd+, chord
    // and command-palette entry. Internal, DEFAULT-ON since 2026-07-09; set
    // JENNY_ENABLE_QUICK_SETTINGS=0 to roll back.
    quick_settings: fe('QUICK_SETTINGS', true),
    // aggregate_checkpoints gates full cumulative `aggregate` values on live
    // delta frames. DEFAULT-ON; set JENNY_ENABLE_AGGREGATE_CHECKPOINTS=0 to
    // roll back. Checkpoints avoid frames x final_length serialization growth
    // and keep background-session deltas under the buffered-bytes cap.
    aggregate_checkpoints: fe('AGGREGATE_CHECKPOINTS', true),
    // reasoning_wire_deltas emits proven append edits plus periodic snapshots.
    // DEFAULT-OFF; consumers discriminate per entry unconditionally, so edit
    // and snapshot shapes coexist. Flipping it needs the owner's live gates: a
    // real thinking-model turn, a trace crossing the truncation cap, and
    // `npm run smoke:gui`. Do not enable it with stream_envelope_v2: that V2
    // coalescer (stream-envelope-shape.js) still replaces edits by id and must
    // be taught to fold them in a deferred slice.
    reasoning_wire_deltas: fe('REASONING_WIRE_DELTAS', false),
    // stream_envelope_v2 gates the bridge-to-renderer delta envelope rollout.
    // DEFAULT-OFF, and deliberately still off: the chat-timeline consolidation
    // closed 2026-08-26 having decided this is a SEPARATE transport migration,
    // not a render-path slice. That program owns where rows are produced; the
    // envelope is in-flight transport, and B0 (54767e4f) already discharged the
    // only obligation it had here -- a schema-version mismatch now falls back to
    // the legacy stream instead of decoding to null, pinned by
    // tests/stream-envelope-schema-contract.test.js.
    //
    // Flipping it needs TWO live stages this program never ran, neither of which
    // is reachable headless:
    //   1. a parity soak -- JENNY_STREAM_ENVELOPE_V2_PARITY=1 (dev only, unpackaged,
    //      NODE_ENV != production) makes the bridge run BOTH paths and warn on
    //      chat.stream_envelope_v2_parity_mismatch. Note the interlock: parity mode
    //      forces shouldEmitLegacyStreamEvents() true, so it proves the projection
    //      matches without the renderer ever consuming an envelope;
    //   2. an ack-proven run with parity OFF, where envelopeReceiptGate.isProven()
    //      is what actually retires the legacy emit. Until then the bridge keeps
    //      emitting legacy anyway, and the watchdog reopens it on
    //      chat.stream_envelope_v2_no_ack.
    // So the flip is low-risk by construction but unverifiable from unit tests
    // alone -- which is exactly the inference that produced this program's earlier
    // false greens. Set JENNY_ENABLE_STREAM_ENVELOPE_V2=1 to soak it.
    stream_envelope_v2: fe('STREAM_ENVELOPE_V2', false),
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
    // workspace_inline_suggest gates the local FIM inline autocomplete
    // (Monaco ghost text + Tab-to-accept) backed by a local fill-in-the-middle
    // coder model via Ollama /api/generate. Default-ON; set
    // JENNY_ENABLE_WORKSPACE_INLINE_SUGGEST=0 to disable. It stays inert until
    // the user selects a FIM model in Editor settings, and is further gated
    // per-user by workspaceIde.inlineSuggestEnabled (the status-bar toggle), so
    // turning the flag on only surfaces the toggle + model picker.
    workspace_inline_suggest: fe('WORKSPACE_INLINE_SUGGEST', true),
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
    // DEFAULT-ON; set JENNY_ENABLE_COMPOSER_TURN_TIMER=0 to roll back.
    composer_turn_timer: fe('COMPOSER_TURN_TIMER', true),
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
    // tools_home_enabled gates the consolidated `home` tool (calendar,
    // reminders, read-only scratchpad). DEFAULT-ON; set
    // JENNY_ENABLE_TOOLS_HOME=0 to roll back (the tool is not registered,
    // byte-identical to today's flag-off behavior).
    tools_home_enabled: fe('TOOLS_HOME', true),
    // tools_task_board_enabled gates durable model-authored Open Loops tasks.
    // DEFAULT-ON; set JENNY_ENABLE_TOOLS_TASK_BOARD_ENABLED=0 to remove the
    // tool from both the Electron registry and managed-sidecar catalog.
    tools_task_board_enabled: fe('TOOLS_TASK_BOARD_ENABLED', true),
    // Compatibility-only legacy batch input. Delegation V2 does not consume it.
    subagent_batch: fe('SUBAGENT_BATCH', false),
    // error_intake_routing gates the EH intake controller (W8+) + the W11
    // error-center recorder. Default-on since the EH-W12 soak; Settings
    // Advanced / JENNY_ENABLE_ERROR_INTAKE_ROUTING=0 roll back (the raw toast
    // controller stays wired as the rollback surface) until the flag is
    // removed at the end of the cleanup wave.
    error_intake_routing: fe('ERROR_INTAKE_ROUTING', true),
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
    // Aggregate streamed-chunk cadence into a bounded, low-pass surface-effect
    // energy term. DEFAULT-ON; set JENNY_ENABLE_SURFACE_EFFECT_HEARTBEAT=0 to
    // restore the base phase-energy mapping without changing user preferences.
    surface_effect_heartbeat: fe('SURFACE_EFFECT_HEARTBEAT', true),
    // scratchpad_v2 gates the Home dashboard Scratchpad multi-note upgrade:
    // named-note tabs, an actions menu (send-to-chat / save-as-file /
    // calendar / open-loop / copy), quiet save trust signals, capture-from-
    // anywhere (/note + Ctrl+Shift+Space), the Settings ▸ Home section, and the
    // opt-in markdown/checklist preview. Default-ON now that the feature is
    // mature (the multi-note schema migration is always on and harmless); when
    // off, the widget renders the legacy single-textarea pad bound to the
    // active note, so the flag only swaps the card UI. Set
    // JENNY_ENABLE_SCRATCHPAD_V2=0 to roll back to the legacy pad.
    scratchpad_v2: fe('SCRATCHPAD_V2', true),
    // scratchpad_pin gates the pinnable sticky-note overlay: a small set of
    // scratchpad notes can be pinned (tab "⋯" menu) as compact chips that float
    // bottom-right over every view and expand to an inline editor. Requires
    // scratchpad_v2 (the pin entry point lives in the v2 tab menu). Default-ON now
    // that the overlay is mature; flag-off leaves the #pinnedNoteLayer empty and
    // the pin/unpin menu item hidden (byte-identical current behavior). Set
    // JENNY_ENABLE_SCRATCHPAD_PIN=0 to roll it back for this user.
    scratchpad_pin: fe('SCRATCHPAD_PIN', true),
    // workspace_test_runner gates the Workspace IDE Test Runner: headless
    // execution of a project's own test commands (own process + real exit code,
    // run through a shell) feeding a Home dashboard trend widget AND the IDE
    // bottom-panel "Test Runner" view (config authoring + live run/abort). Now
    // that the authoring UI + live panel have landed it ships DEFAULT-ON (internal
    // flag); set JENNY_ENABLE_WORKSPACE_TEST_RUNNER=0 to roll it back for this user.
    workspace_test_runner: fe('WORKSPACE_TEST_RUNNER', true),
    // response_loop_display_v2 is the shared response-loop alignment gate: it
    // gates BOTH the backend preservation of
    // mid-turn commentary + interleaved reasoning across a tool_continuation
    // stream_reset (the canonical capture path stops discarding genuine
    // prior-iteration segments) AND the renderer display of that content (dimmed
    // commentary, "Thought for Xs" reasoning summaries, grouped collapsible
    // steps). Backend-and-frontend MUST share one gate: shipping preservation
    // without the matching display surfaces raw, undimmed/ungrouped commentary
    // bubbles. Tasks 1-8 landed (carryback/Task 9 SHELVED + inert) so it ships
    // DEFAULT-ON (internal flag); set JENNY_ENABLE_RESPONSE_LOOP_DISPLAY_V2=0 to
    // roll it back for this user.
    response_loop_display_v2: fe('RESPONSE_LOOP_DISPLAY_V2', true),
    // turn_activity_envelope gates the cohesive turn-shell timeline on top of
    // response_loop_display_v2's grouped steps: (1) the render pipeline
    // coalesces ALL of a turn's rows into ONE turn-article (one avatar, one
    // row list) instead of one article per assistant render-message, and
    // (2) the pre-answer activity rows (reasoning/tool/approval steps +
    // mid-turn commentary) are wrapped in a single collapsible envelope with
    // an aggregate "Worked for Xs · N tools" header while the final answer
    // stays outside at full emphasis. Steps default collapsed (approval-
    // pending steps force open); user toggles persist across streaming
    // repaints via the shared step-group expand Map. Renderer-only.
    // DEFAULT-ON; set JENNY_ENABLE_TURN_ACTIVITY_ENVELOPE=0 to roll back to
    // the per-message article timeline.
    turn_activity_envelope: fe('TURN_ACTIVITY_ENVELOPE', true),
    // katex_math gates renderer-side KaTeX rendering of $…$ / $$…$$ LaTeX in
    // chat markdown and .md artifact documents (protect-then-render, post-
    // DOMPurify live-DOM pass in renderer/shared/markdown-math-utils.js).
    // Renderer-only: no sidecar/IPC/CONFIG_VERSION surface. DEFAULT-ON; set
    // JENNY_ENABLE_KATEX_MATH=0 to roll back to raw $-delimited text.
    katex_math: fe('KATEX_MATH', true),
    // artifact_renderer_registry (Artifact Overhaul WS2) gates the artifact
    // renderer registry dispatch in renderer-artifacts-surface-controller.js:
    // ON = renderSelectedArtifactDetail routes through
    // renderer-artifacts-renderer-registry.js (adds the sanitized html/svg
    // kinds + the chart stub); OFF = the legacy if/else dispatch,
    // byte-identical (both paths share the per-kind implementations).
    // DEFAULT-ON since the Step-9 parity + sanitize review (2026-07-01: six
    // shipped-kind fixtures byte-identical, no P0, svg fail-closed fix
    // applied); set JENNY_ENABLE_ARTIFACT_RENDERER_REGISTRY=0 to roll back.
    artifact_renderer_registry: fe('ARTIFACT_RENDERER_REGISTRY', true),
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
    // artifact_html_preview (HTML Artifact Preview) routes EXECUTABLE html
    // artifacts (and svg carrying <script>) to a sandboxed live-preview
    // iframe: single-use jenny-artifact:// src (never srcdoc — srcdoc
    // inherits the parent CSP; the sandbox attribute pins the opaque
    // origin), sandbox exactly "allow-scripts" (NO allow-same-origin),
    // strict frame CSP
    // (default-src 'none'; connect-src 'none' — no network, no exfil), plus
    // the version-history stepper chrome. Renderer-only. It executes
    // model-authored JS inside that sandbox; the invariants are test-pinned.
    // DEFAULT-ON since 2026-07-02 (owner-directed pre-soak flip — the queue
    // #15 sandbox-probe pass runs against the live default); set
    // JENNY_ENABLE_ARTIFACT_HTML_PREVIEW=0 to roll back (WS2 inline
    // DOMPurify path, no iframe, no selector — byte-identical).
    artifact_html_preview: fe('ARTIFACT_HTML_PREVIEW', true),
    // settings_search gates the Settings ▸ nav-rail search box (renderer-only:
    // static index built from the section registry + field-copy map, filters
    // the nav rail + shows a flat results list, jumps to + flashes the hit via
    // [data-search-hit]). No sidecar/IPC/CONFIG_VERSION surface. DEFAULT-ON;
    // set JENNY_ENABLE_SETTINGS_SEARCH=0 to roll back to the plain nav rail.
    settings_search: fe('SETTINGS_SEARCH', true),
    // model_management_ui gates the Settings > Models "Model library" group
    // (pull-with-progress + guarded delete). Default-ON; set
    // JENNY_ENABLE_MODEL_MANAGEMENT_UI=0 to roll back to today's Settings >
    // Models exactly (parity: no pull row, no delete, no group rendered).
    model_management_ui: fe('MODEL_MANAGEMENT_UI'),
    // model_library_section moves the Model library out of the Settings > Models
    // card into its own registry section rendering the shared card grid
    // (renderer/shell/model-library/). Requires model_management_ui. DEFAULT-ON;
    // JENNY_ENABLE_MODEL_LIBRARY_SECTION=0 restores the legacy flat-row
    // #modelLibraryGroup inside the Models card exactly, and hides the new nav
    // item. Legacy module + this flag retire together in the cleanup wave.
    model_library_section: fe('MODEL_LIBRARY_SECTION'),
    // setup_hub replaces the linear first-run wizard with the checklist hub
    // (any-order steps, per-step skip, explicit finish gate). Renderer-only.
    // DEFAULT-ON; JENNY_ENABLE_SETUP_HUB=0 removes the guided surface entirely
    // and routes first-run/Resume to Home + Settings tiles (the pre-existing,
    // tested !hubFactory degradation) -- the old wizard is not retained.
    setup_hub: fe('SETUP_HUB'),
    // workspace_root_nudge gates the pre-send "no workspace root" composer
    // chip nudge (a follow-up slice consumes this; added here so
    // feature-flags.js is touched once). Default-ON.
    workspace_root_nudge: fe('WORKSPACE_ROOT_NUDGE'),
    // knowledge_layer gates the user-folder knowledge-roots registry
    // (KnowledgeService + knowledge.* IPC + knowledge_roots managed-sidecar
    // config). Internal. DEFAULT-ON since 2026-07-02 (owner-directed
    // pre-soak flip; inert until the user registers a folder); set
    // JENNY_ENABLE_KNOWLEDGE_LAYER=0 to roll back. Flag-off is
    // byte-identical: the service stays inert (no knowledge.json,
    // addFolder/removeFolder return feature_disabled), the IPC handlers are
    // not registered, and no config keys are published.
    knowledge_layer: fe('KNOWLEDGE_LAYER', true),
    // artifact_panel_v2 gates the Wave-4 artifact review panel redesign
    // (utility-strip chrome + per-session width persistence). DEFAULT-ON;
    // set JENNY_ENABLE_ARTIFACT_PANEL_V2=0 to roll back to the legacy panel.
    artifact_panel_v2: fe('ARTIFACT_PANEL_V2', true),
    artifact_panel_v3: fe('ARTIFACT_PANEL_V3', true),
    // mcp_http_transport gates the real MCP Streamable-HTTP/SSE transport
    // forwarding (Electron-side kill switch). Internal. DEFAULT-ON since
    // 2026-07-02 (owner-directed pre-soak flip; inert until mcp-servers.json
    // sets mcp_sse_enabled + an sse server — both gates still required); set
    // JENNY_ENABLE_MCP_HTTP_TRANSPORT=0 to roll back.
    mcp_http_transport: fe('MCP_HTTP_TRANSPORT', true),
    // mcp_management_ui gates the Settings > Tools "MCP servers" group (status
    // list + kind-aware auth editor for bearer/oauth_client_credentials
    // secrets), replacing the Skills-embedded MCP discovery panel. Own flag,
    // independent of mcp_http_transport (owner ratified 2026-07-05).
    // DEFAULT-ON since 2026-07-05 (owner-approved spec, Direction A hybrid);
    // set JENNY_ENABLE_MCP_MANAGEMENT_UI=0 to roll back to the legacy
    // Skills-embedded discovery panel rendering byte-identically.
    mcp_management_ui: fe('MCP_MANAGEMENT_UI', true),
    // ollama_tray_remediation gates the owner-triggered Ollama tray-conflict
    // remediation surface (ollamaTray.* IPC: quit the tray app, disable its
    // Startup shortcut, restart the engine). Explicit-click actions only —
    // detection (ollama-tray-conflict.js) stays always-on and unaffected by
    // this flag. Default-ON user-facing remediation surface; set
    // JENNY_ENABLE_OLLAMA_TRAY_REMEDIATION=0 to roll back. User-overridable
    // in Settings (FEATURE_OVERRIDE_KEYS).
    ollama_tray_remediation: fe('OLLAMA_TRAY_REMEDIATION', true),
    text_spellcheck: fe('TEXT_SPELLCHECK', true),
    llama_server_acceleration: fe('LLAMA_SERVER_ACCELERATION', true),
    // model_fit_estimates gates the pure-estimator fit computed for installed
    // local models that have no config/model-recommendation-catalog.json
    // entry (services/model-fit-estimator.js), surfaced in diagnostics as
    // modelFitEstimates. No UI in this wave. DEFAULT-ON; set
    // JENNY_ENABLE_MODEL_FIT_ESTIMATES=0 to roll back (modelFitEstimates is
    // always []).
    model_fit_estimates: fe('MODEL_FIT_ESTIMATES', true),
    // workspace_pty_terminal gates the real ConPTY terminal (@lydell/node-pty +
    // xterm.js) in the IDE bottom panel — first native module in the app + a
    // spawning-shells surface. DEFAULT-ON since 2026-07-02 (owner-directed
    // pre-soak flip, overriding the handoff's ship-OFF call — the owner's
    // weekend soak IS the packaged-app soak); set
    // JENNY_ENABLE_WORKSPACE_PTY_TERMINAL=0 to roll back (legacy line
    // terminal renders and node-pty is never loaded).
    workspace_pty_terminal: fe('WORKSPACE_PTY_TERMINAL', true),
    // workspace_file_map gates the IDE "Map" tab (interactive file-dependency
    // graph). DEFAULT-ON; set JENNY_ENABLE_WORKSPACE_FILE_MAP=0 to roll back
    // (the Map tab/affordance never appears; byte-identical to today).
    workspace_file_map: fe('WORKSPACE_FILE_MAP', true),
    // workspace_preview_surface gates the IDE unified Preview stage surface
    // (markdown/mermaid + sandboxed HTML preview) + its activity-bar entry.
    // DEFAULT-ON; set JENNY_ENABLE_WORKSPACE_PREVIEW_SURFACE=0 to roll back
    // (no Preview entry; persisted preview surface displays as editor).
    workspace_preview_surface: fe('WORKSPACE_PREVIEW_SURFACE', true),
    // file_preview_html_render gates the chat rail's sandboxed HTML file
    // preview. DEFAULT-ON; set JENNY_ENABLE_FILE_PREVIEW_HTML_RENDER=0 to roll
    // back to the existing code view with no toggle or frame.
    file_preview_html_render: fe('FILE_PREVIEW_HTML_RENDER', true),
    // Gates GPU%, stale-state dimming, and click-to-refresh in the titlebar.
    // DEFAULT-ON; set JENNY_ENABLE_TITLEBAR_GPU_TELEMETRY=0 to roll back.
    titlebar_gpu_telemetry: fe('TITLEBAR_GPU_TELEMETRY', true),
    // auto_checkpoint gates the opt-in safety net that auto-writes a git ref
    // (refs/jenny/checkpoints/*) before the first repo mutation of a run.
    // DEFAULT-ON since 2026-07-07 (owner-directed flip for in-app testing); set
    // JENNY_ENABLE_AUTO_CHECKPOINT=0 to roll back.
    auto_checkpoint: fe('AUTO_CHECKPOINT', true),
    // verification_gate gates the turn-finalization verification gate (sidecar
    // routing/verification_gate.py). It also requires tools_verify_enabled,
    // since the gate reaches the Test Runner through the `verify` tool. The gate
    // can never prevent a turn from completing: a failing or unrunnable gate
    // becomes one honest sentence on the model's own response. DEFAULT-OFF
    // pending owner sign-off; JENNY_ENABLE_VERIFICATION_GATE=1 to try it.
    verification_gate: fe('VERIFICATION_GATE', false),
    // workspace_exploded_view gates the IDE file-tab "Exploded" view (per-file
    // node graph of functions/data + wiring). DEFAULT-ON since 2026-07-07
    // (owner-directed flip for in-app testing); set
    // JENNY_ENABLE_WORKSPACE_EXPLODED_VIEW=0 to roll back.
    workspace_exploded_view: fe('WORKSPACE_EXPLODED_VIEW', true),
    // workspace_explorer_qol gates Explorer multi-select and its split active-file
    // presentation. DEFAULT-ON; set JENNY_ENABLE_WORKSPACE_EXPLORER_QOL=0 to roll back.
    workspace_explorer_qol: fe('WORKSPACE_EXPLORER_QOL', true),
    // workspace_external_import gates reviewed external-source copies into the
    // workspace. DEFAULT-ON; set JENNY_ENABLE_WORKSPACE_EXTERNAL_IMPORT=0 to roll back.
    workspace_external_import: fe('WORKSPACE_EXTERNAL_IMPORT', true),
    // chat_timeline_deterministic_row_id gates the DC1 flicker cure (deterministic
    // identity-tuple row_id, reasoning anchored on thinking_id). DEFAULT-ON since
    // 2026-07-07 (owner-directed flip for a live soak); set
    // JENNY_ENABLE_CHAT_TIMELINE_DETERMINISTIC_ROW_ID=0 to roll back.
    chat_timeline_deterministic_row_id: fe('CHAT_TIMELINE_DETERMINISTIC_ROW_ID', true),
    // chat_timeline_render_telemetry gates TEMPORARY render-path diagnostics
    // (Track A of the streaming-flicker investigation). DEFAULT-ON since
    // 2026-07-07 (owner-directed flip for the live-repro investigation); set
    // JENNY_ENABLE_CHAT_TIMELINE_RENDER_TELEMETRY=0 to roll back.
    chat_timeline_render_telemetry: fe('CHAT_TIMELINE_RENDER_TELEMETRY', true),
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
  };
}

function buildFeatureFlags(env = process.env, overrides = {}) {
  return {
    ...buildFeatureFlagDefaults(env),
    ...normalizeFeatureOverrides(overrides),
  };
}

module.exports = {
  FEATURE_OVERRIDE_KEYS,
  INTERNAL_FEATURE_FLAG_KEYS,
  TOOL_SETTING_KEYS,
  buildFeatureFlags,
  buildFeatureFlagDefaults,
  isFeatureEnabledByDefault,
  normalizeFeatureOverrides,
};
