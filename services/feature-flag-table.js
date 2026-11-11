'use strict';

// The one declarative feature-flag table. services/feature-flags.js derives
// every exported list and the defaults from it; nothing else declares a flag.
//
// Row shape: { key, env, default, override?, internal?, forceDeny?, dynamicDefault? }
// - key: the flag name in the resolved flags map.
// - env: the JENNY_ENABLE_<env> suffix that sets the default (1/true/yes/on or
//   0/false/no/off; anything else keeps the default).
// - default: the boolean default. Features default ON behind the
//   JENNY_ENABLE_<env>=0 kill switch; a false default is an explicit decision.
// - override: user-overridable in Settings (FEATURE_OVERRIDE_KEYS; a stored
//   override beats the env default).
// - internal: env-only, no Settings toggle (INTERNAL_FEATURE_FLAG_KEYS).
// - forceDeny: JENNY_ENABLE_<env>=0 also beats a stored override (FORCE_DENY_ENV_KEYS).
// - dynamicDefault: the default is computed from the environment by the named
//   resolver in feature-flags.js; `default` is its fallback.
//
// Order matters: FEATURE_OVERRIDE_KEYS and INTERNAL_FEATURE_FLAG_KEYS keep the
// row order, and canonical_m3_rollout must precede the rows that follow it.
// Adding a flag = adding one row in the right section.

const FEATURE_FLAG_ROWS = [
  // ---- User-overridable in Settings (FEATURE_OVERRIDE_KEYS) ----
  { key: 'token_budget', env: 'TOKEN_BUDGET', default: true, override: true },
  { key: 'context_compaction', env: 'CONTEXT_COMPACTION', default: true, override: true },
  { key: 'api_retry', env: 'API_RETRY', default: true, override: true },
  { key: 'skills_system', env: 'SKILLS_SYSTEM', default: true, override: true },
  { key: 'shell_security', env: 'SHELL_SECURITY', default: true, override: true },
  // DEFAULT-OFF: fail-closed classification makes Auto mode chattier, so this stays opt-in.
  { key: 'strict_auto_run', env: 'STRICT_AUTO_RUN', default: false, override: true },
  { key: 'git_tracking', env: 'GIT_TRACKING', default: true, override: true },
  { key: 'pretext_layout', env: 'PRETEXT_LAYOUT', default: true, override: true },
  { key: 'command_palette', env: 'COMMAND_PALETTE', default: true, override: true },
  { key: 'agent_progress_durable', env: 'AGENT_PROGRESS_DURABLE', default: false, override: true },
  { key: 'resource_discipline', env: 'RESOURCE_DISCIPLINE', default: true, override: true },
  // Error-surfacing overhaul W7: unified error intake routing (normalize + route
  // every renderer error through one policy table), the EH intake controller
  // (W8+) and the W11 error-center recorder. Default-on since the EH-W12 soak;
  // Settings Advanced / JENNY_ENABLE_ERROR_INTAKE_ROUTING=0 roll back (the raw
  // toast controller stays wired as the rollback surface) until the flag is
  // removed at the end of the cleanup wave (the top_nav_shell precedent), so
  // rollback never needs an env var.
  { key: 'error_intake_routing', env: 'ERROR_INTAKE_ROUTING', default: true, override: true },
  // User-overridable so the idle safety fallback can be disabled without
  // removing its main-process wiring.
  { key: 'unattended_guard', env: 'UNATTENDED_GUARD', default: true, override: true },
  // The owner-triggered Ollama tray-conflict remediation surface (ollamaTray.*
  // IPC: quit the tray app, disable its Startup shortcut, restart the engine).
  // Explicit-click actions only; detection (ollama-tray-conflict.js) stays
  // always-on and unaffected by this flag. Default-ON; user-overridable in
  // Settings so it can be turned off per-user without an env var;
  // JENNY_ENABLE_OLLAMA_TRAY_REMEDIATION=0 rolls back.
  { key: 'ollama_tray_remediation', env: 'OLLAMA_TRAY_REMEDIATION', default: true, override: true },
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
  { key: 'text_spellcheck', env: 'TEXT_SPELLCHECK', default: true, override: true },
  // Row 84 mic + shortcut (Settings > Dictation); the env var force-denies it.
  { key: 'dictation', env: 'DICTATION', default: true, override: true, forceDeny: true },
  // Row 86 "While you were away" digests in the Jenny chat: DEFAULT-OFF for
  // everyone (owner, 2026-11-02), the user turns them on in Settings; the env
  // var force-denies them.
  { key: 'primary_digests', env: 'PRIMARY_DIGESTS', default: false, override: true, forceDeny: true },
  // Row 122 before and after pictures of the pages a turn changed (Settings >
  // Appearance > Chat layout). Off takes no pictures and shows none.
  { key: 'change_pictures', env: 'CHANGE_PICTURES', default: true, override: true },

  // ---- Internal, env-only (INTERNAL_FEATURE_FLAG_KEYS) ----
  // Environment OFF cannot be overridden by stored preferences.
  { key: 'session_runtime', env: 'SESSION_RUNTIME', default: true, internal: true, forceDeny: true },
  // agent_executor gates the runtime wrapper and its agent.progress notifications
  // (delegate child progress is forwarded either way: work-lifecycle-coordinator.js).
  { key: 'agent_executor', env: 'AGENT_EXECUTOR', default: false, internal: true },
  // task_lifecycle only affects task tracking and transcript repair inside the executor.
  { key: 'task_lifecycle', env: 'TASK_LIFECYCLE', default: false, internal: true },
  // multiplexer enables the Batch 4 single-pipe routed transport.
  { key: 'multiplexer', env: 'MULTIPLEXER', default: true, internal: true },
  // chat_cancel enables end-to-end chat cancellation over the routed transport.
  { key: 'chat_cancel', env: 'CHAT_CANCEL', default: true, internal: true },
  // phase_events enables Batch 5 semantic phase notifications. DEFAULT-ON
  // since 2026-08-28: chat_turn_v2 (removed) had forced it on for every
  // install since its own default-on flip, so true preserves live behavior.
  { key: 'phase_events', env: 'PHASE_EVENTS', default: true, internal: true },
  // Canonical M3 is DEFAULT-ON; this one rollout override
  // (JENNY_ENABLE_CANONICAL_M3_ROLLOUT=0) rolls both derived flags below back.
  { key: 'canonical_m3_rollout', env: 'CANONICAL_M3_ROLLOUT', default: true, internal: true },
  // Follows canonical_m3_rollout unless independently overridden.
  { key: 'canonical_turn_events', env: 'CANONICAL_TURN_EVENTS', default: false, internal: true, dynamicDefault: 'canonical_m3_rollout' },
  // Follows the same rollout and projects accepted turn.event payloads.
  { key: 'canonical_bridge', env: 'CANONICAL_BRIDGE', default: false, internal: true, dynamicDefault: 'canonical_m3_rollout' },
  // chat_stream_paint_v2 (Ht-C) gates streaming paint-minimization in the live
  // reasoning patch path: summary-only deltas morph the reasoning header in
  // place instead of destructively rewriting its innerHTML every tick.
  // DEFAULT-ON at landing (owner-directed 2026-07-05, weekend-soak sweep
  // posture); =0 rolls back to the rewrite path (byte-identical pre-Ht-C behavior).
  { key: 'chat_stream_paint_v2', env: 'CHAT_STREAM_PAINT_V2', default: true, internal: true },
  // The streaming answer token fade. OFF restores today's plain per-frame innerHTML write.
  { key: 'chat_stream_token_fade', env: 'CHAT_STREAM_TOKEN_FADE', default: true, internal: true },
  // Row 101 Phase 2: a streaming reasoning body caps at the chat viewport and
  // scrolls inside itself; =0 restores the growing panel.
  { key: 'reasoning_live_box', env: 'REASONING_LIVE_BOX', default: true, internal: true },
  // Full cumulative `aggregate` values on live delta frames. Checkpoints avoid
  // frames x final_length serialization growth and keep background-session
  // deltas under the buffered-bytes cap.
  { key: 'aggregate_checkpoints', env: 'AGGREGATE_CHECKPOINTS', default: true, internal: true },
  // Emits proven append edits plus periodic snapshots. DEFAULT-ON since
  // 2026-10-05 (owner); consumers discriminate per entry unconditionally, so
  // edit and snapshot shapes coexist. Still owed: a trace crossing the
  // truncation cap and `npm run smoke:gui`. =0 rolls back to full snapshots.
  { key: 'reasoning_wire_deltas', env: 'REASONING_WIRE_DELTAS', default: true, internal: true },
  // Routes HYDRATED rows through the live fold (renderer-stream-rehydrate
  // projectPersistedEventsWithReducer) instead of the turn-row projector, so a
  // reloaded turn and a streaming one are built by the same code. DEFAULT-ON
  // since 2026-08-25, Wave 3c of the chat-timeline consolidation: the fold now
  // loses no populated field the projector renders, asserted directly by the
  // delegation gate in tests/timeline-fold-convergence-gap.test.js. Graduated
  // out of the canonical_m3_rollout canary group by that flip.
  { key: 'canonical_renderer_projection', env: 'CANONICAL_RENDERER_PROJECTION', default: true, internal: true },
  // Runtime workspace orientation. DEFAULT-ON since 2026-07-07 (owner-directed flip for in-app testing).
  { key: 'workspace_manifest', env: 'WORKSPACE_MANIFEST', default: true, internal: true },
  // The <repository-delta> turn-start injection. DEFAULT-ON since 2026-07-07
  // (owner-directed flip for in-app testing).
  { key: 'repo_delta_resume', env: 'REPO_DELTA_RESUME', default: true, internal: true },
  // Default-off coding-turn orientation for local models.
  { key: 'task_capsule', env: 'TASK_CAPSULE', default: false, internal: true },
  // Default-off MCP resource/list/read tools.
  { key: 'mcp_resources', env: 'MCP_RESOURCES', default: false, internal: true },
  // Default-off automation list/read tools.
  { key: 'tools_automations_enabled', env: 'TOOLS_AUTOMATIONS', default: false, internal: true },
  // The workspace_present presentation tool; =0 leaves it unregistered
  // (byte-identical to flag-off behavior).
  { key: 'tools_workspace_present_enabled', env: 'TOOLS_WORKSPACE_PRESENT', default: true, internal: true },
  // The preview_test workspace HTML tester; =0 leaves it unregistered.
  { key: 'tools_preview_test_enabled', env: 'TOOLS_PREVIEW_TEST', default: true, internal: true },
  // The model-driven `browser` tool (row 114). On here, but each chat's Browser switch defaults off
  // (DEFAULT_OFF_FAMILIES in tools/tool-surface-families.js); =0 leaves the tool unregistered.
  { key: 'tools_browser_use_enabled', env: 'TOOLS_BROWSER_USE', default: true, internal: true },
  // The `verify` tool, which lets the model run one of the user's own saved
  // Workspace Test Runner configurations. DEFAULT-OFF pending owner sign-off;
  // =1 registers it (flag-off: the tool is not registered and never reaches the
  // manifest-derived contract).
  { key: 'tools_verify_enabled', env: 'TOOLS_VERIFY', default: false, internal: true },
  // The image_generate local image tool; =0 leaves it unregistered.
  { key: 'tools_image_generate_enabled', env: 'TOOLS_IMAGE_GENERATE', default: true, internal: true },
  // Row 127: image_generate on a ComfyUI model set (Jenny starts the user's ComfyUI per image); =0 refuses those sets.
  { key: 'image_comfyui_enabled', env: 'IMAGE_COMFYUI', default: true, internal: true },
  // The consolidated `home` tool (calendar, reminders, read-only scratchpad); =0 unregisters it.
  { key: 'tools_home_enabled', env: 'TOOLS_HOME', default: true, internal: true },
  // Row 97 suggest_next_step card tool; =0 unregisters it.
  { key: 'tools_next_step_enabled', env: 'TOOLS_NEXT_STEP', default: true, internal: true },
  // Durable model-authored Open Loops tasks (task_board); =0 removes the tool from both catalogs.
  { key: 'tools_task_board_enabled', env: 'TOOLS_TASK_BOARD_ENABLED', default: true, internal: true },
  // The model's read/append/replace access to the per-project note (project_notes);
  // =0 removes it from both catalogs.
  { key: 'tools_project_notes_enabled', env: 'TOOLS_PROJECT_NOTES_ENABLED', default: true, internal: true },
  // Row 69: the one profile-wide Jenny chat (=0: none is created, existing ones stay).
  { key: 'primary_chat', env: 'PRIMARY_CHAT', default: true, internal: true },
  // sessions_list/session_status/session_transcript/session_stop.
  { key: 'tools_session_directory_enabled', env: 'TOOLS_SESSION_DIRECTORY_ENABLED', default: true, internal: true },
  // Only primary + linked chats see the directory tools.
  { key: 'session_directory_tool_gate', env: 'SESSION_DIRECTORY_TOOL_GATE', default: true, internal: true },
  // Row 70: wake on delivery; a finished background job wakes its chat, and one
  // that settles mid-turn is also pushed to the live turn (background_job_notices,
  // 2026-11-01); a linked child's budget stop resumes it before its parent wakes.
  { key: 'session_message_wake', env: 'SESSION_MESSAGE_WAKE', default: true, internal: true },
  { key: 'background_job_wake', env: 'BACKGROUND_JOB_WAKE', default: true, internal: true },
  { key: 'background_job_notices', env: 'BACKGROUND_JOB_NOTICES', default: true, internal: true },
  { key: 'child_auto_resume', env: 'CHILD_AUTO_RESUME', default: true, internal: true },
  // Default-on kill switches. Row 76 (plan PRIMARY_CHAT_CONTROLS_2026-10-25.md):
  // the primary's standing launch permission, activity log and Pause/Reset/Forget
  // controls; row 88: settings_get/settings_change; row 94: chat_organize/
  // chat_configure, P2 project_create/projects_list and the propose_session fork,
  // P3 app_view, P4 session_export and the terminal_read/terminal_run pair;
  // row 85: schedule_list/schedule_change and fired checks; row 87: the Jenny
  // chat's per-action rules; row 95: absolute_path_links=0 stops chat path chips
  // and prose paths from resolving absolute paths (copy-only/inert as before),
  // data_usage_page=0 hides the Settings "Your data" group and refuses its IPC.
  { key: 'primary_launch_permission', env: 'PRIMARY_LAUNCH_PERMISSION', default: true, internal: true },
  { key: 'primary_activity_log', env: 'PRIMARY_ACTIVITY_LOG', default: true, internal: true },
  { key: 'primary_chat_controls', env: 'PRIMARY_CHAT_CONTROLS', default: true, internal: true },
  { key: 'primary_settings_writes', env: 'PRIMARY_SETTINGS_WRITES', default: true, internal: true },
  { key: 'primary_chat_manage', env: 'PRIMARY_CHAT_MANAGE', default: true, internal: true },
  { key: 'primary_chat_placement', env: 'PRIMARY_CHAT_PLACEMENT', default: true, internal: true },
  { key: 'primary_app_view', env: 'PRIMARY_APP_VIEW', default: true, internal: true },
  { key: 'primary_chat_export', env: 'PRIMARY_CHAT_EXPORT', default: true, internal: true },
  // Full auto (plan PRIMARY_FULL_AUTO_2026-11-08.md): the armed state over the Jenny chat's Auto mode;
  // =0 refuses arming and the armed read. Also off when primary_chat is off.
  { key: 'primary_full_auto', env: 'PRIMARY_FULL_AUTO', default: true, internal: true },
  // Row 112: =0 stops the model-written chat name; the clipped first-message title stays.
  { key: 'session_model_titles', env: 'SESSION_MODEL_TITLES', default: true, internal: true },
  { key: 'terminal_tools', env: 'TERMINAL_TOOLS', default: true, internal: true },
  { key: 'primary_scheduled_checks', env: 'PRIMARY_SCHEDULED_CHECKS', default: true, internal: true },
  { key: 'primary_action_rules', env: 'PRIMARY_ACTION_RULES', default: true, internal: true },
  { key: 'absolute_path_links', env: 'ABSOLUTE_PATH_LINKS', default: true, internal: true },
  { key: 'data_usage_page', env: 'DATA_USAGE_PAGE', default: true, internal: true },
  // Kill switch for agentic memory v2: the sidecar-owned `memory` tool
  // (managed-sidecar `tools_memory_enabled` derives from it), later reflection
  // and episodic recall; =0 removes the tool from the managed-sidecar catalog.
  // The user's memory toggles (pause, ask before saving) are separate and ride
  // each request.
  { key: 'memory_v2_enabled', env: 'MEMORY_V2', default: true, internal: true },
  // Kill switches only. Row 77: =0 skips the File Map Components draft on each
  // scan; row 78: =0 hides API-key providers and hands no key to the sidecar
  // (keys stay stored); row 82: =0 stops every IDE hot-exit backup read/write.
  { key: 'file_map_components', env: 'FILE_MAP_COMPONENTS', default: true, internal: true },
  { key: 'api_providers', env: 'API_PROVIDERS', default: true, internal: true },
  // Row 123 slice 1f-1: off registers no team IPC, loads no services/team module,
  // reads nothing under <userData>/team/, opens no team connection and hides the
  // Settings > Team section. DEFAULT-OFF (owner, 2026-11-10): team hosting stays
  // out of public releases while the program is in progress; JENNY_ENABLE_TEAM=1
  // turns it on for development.
  { key: 'team', env: 'TEAM', default: false, internal: true },
  { key: 'ide_hot_exit', env: 'IDE_HOT_EXIT', default: true, internal: true },
  { key: 'model_catalog_guard', env: 'MODEL_CATALOG_GUARD', default: true, internal: true },
  // Row 60 harness fixes (sidecar-only), DEFAULT-ON and A/B-measured; =0 restores the old behaviour.
  { key: 'shell_noninteractive_env', env: 'SHELL_NONINTERACTIVE_ENV', default: true, internal: true },
  { key: 'shell_head_tail_output', env: 'SHELL_HEAD_TAIL_OUTPUT', default: true, internal: true },
  { key: 'loop_result_aware_signature', env: 'LOOP_RESULT_AWARE_SIGNATURE', default: true, internal: true },
  { key: 'edit_match_fallbacks', env: 'EDIT_MATCH_FALLBACKS', default: true, internal: true },
  { key: 'compaction_reject_truncated_summary', env: 'COMPACTION_REJECT_TRUNCATED_SUMMARY', default: true, internal: true },
  { key: 'compaction_micro_first', env: 'COMPACTION_MICRO_FIRST', default: true, internal: true },
  { key: 'compaction_recall_tool', env: 'COMPACTION_RECALL_TOOL', default: true, internal: true },
  { key: 'compaction_touched_files', env: 'COMPACTION_TOUCHED_FILES', default: true, internal: true },
  // Row 58 W4 hybrid (vector + lexical) memory recall: adds the vector leg and
  // lets the conversation index pump embed memories. DEFAULT-OFF until the
  // owner's real-model qualification; =1 turns it on.
  { key: 'memory_hybrid_recall', env: 'MEMORY_HYBRID_RECALL', default: false, internal: true },
  // Every OS toast (replies, failures, permissions, questions, reminders).
  // DEFAULT-ON, off for quiet agent launches; Settings owns the user switch.
  { key: 'desktop_notifications', env: 'DESKTOP_NOTIFICATIONS', default: true, internal: true, dynamicDefault: 'agent_quiet_off' },
  // The window.__jennyAgent automation surface and DEBUG-level renderer log
  // forwarding. Defaults on under the agent/dev launcher (JENNY_AGENT_DEV) and
  // off everywhere else.
  { key: 'agent_test_hooks', env: 'AGENT_TEST_HOOKS', default: false, internal: true, dynamicDefault: 'agent_dev' },
  // The dev-only surface-effect review gallery (Background Effects v3, packet
  // S5): a full-screen overlay for visually reviewing a background effect with
  // pinned parameters (effect / palette / motion / phase / energy / pointer /
  // viewport / DPR / seed / tier). Nav-unlinked: no Settings entry point and no
  // keyboard shortcut; opened only programmatically via
  // window.__jennySurfaceGallery.open() from a dev/owner review session.
  // Defaults on under the agent/dev launcher (JENNY_AGENT_DEV) and off
  // everywhere else, same as agent_test_hooks, so it never ships reachable in
  // an end-user build. =1 opts in for an owner review session outside the
  // agent/dev launcher.
  { key: 'surface_effect_gallery', env: 'SURFACE_EFFECT_GALLERY', default: false, internal: true, dynamicDefault: 'agent_dev' },
  // Kill switch for the boot curtain's starfield (a short swirl that collapses
  // into the wordmark once the shell is ready). The per-user choice is the
  // persisted Settings > Appearance > "Startup animation" toggle, so this stays
  // env-only; =0 rolls back to the plain curtain (no stars, no minimum hold).
  { key: 'startup_animation', env: 'STARTUP_ANIMATION', default: true, internal: true },
  // The workspaceGit.* SCM-foundation IPC namespace + the Tier-2 Source Control
  // IDE slice (panel, tree decorations, diff-vs-HEAD, statusbar branch chip).
  // Default-on after the slice soaked.
  { key: 'workspace_git', env: 'WORKSPACE_GIT', default: true, internal: true },
  // The Tier-3 keyword code-search context backend task: a bounded
  // keyword/substring search over the workspace root spliced into chat context
  // so the model can cite real file:line locations. Plain keyword grounding --
  // NOT embeddings or semantic Q&A. Default-ON now that the IDE is mature. Also
  // gated by the include_codebase_context context-pref (default-on).
  { key: 'workspace_codebase_context', env: 'WORKSPACE_CODEBASE_CONTEXT', default: true, internal: true },
  // The Tier-3 "implicit active-file context + @-mentions" feature: the active
  // editor file's cursor-region slice (shown via a removable composer chip) plus
  // @-mentioned file contents are spliced into chat context per turn.
  // Default-ON for real-world soak now that the viability gate (deterministic
  // context-budget trimmer + large-file "too large to auto-context" signal,
  // 6c1cd33) is satisfied. When on, the in-composer chip defaults to active for
  // the session.
  { key: 'workspace_active_file_context', env: 'WORKSPACE_ACTIVE_FILE_CONTEXT', default: true, internal: true },
  // Legacy compatibility key. Automatic change-diff surfacing is retired:
  // Jenny's Changes remains passive until the user or model explicitly asks to
  // review a recorded change. Keep the default off while older profiles and
  // environment overrides age out; enabling it has no runtime effect.
  { key: 'workspace_ghost_edit', env: 'WORKSPACE_GHOST_EDIT', default: false, internal: true },
  // The Workspace IDE Test Runner: headless execution of a project's own test
  // commands (own process + real exit code, run through a shell) feeding a Home
  // dashboard trend widget AND the IDE bottom-panel "Test Runner" view (config
  // authoring + live run/abort). DEFAULT-ON now that the authoring UI + live
  // panel have landed.
  { key: 'workspace_test_runner', env: 'WORKSPACE_TEST_RUNNER', default: true, internal: true },
  // Shared Test Runner monitor; model awareness remains a separate, deferred gate.
  { key: 'activity_monitor', env: 'ACTIVITY_MONITOR', default: false, internal: true },
  // ONLY the Settings UI surface for the multi-provider web-search picker
  // (SearXNG/Brave/Tavily/Serper/Google PSE); the sidecar honors whatever
  // provider config it is given and DDG stays the zero-config default either
  // way. DEFAULT-ON since 2026-07-01 (owner-directed flip for live testing).
  { key: 'web_search_providers', env: 'WEB_SEARCH_PROVIDERS', default: true, internal: true },
  // Provider-aware prompt caching and bounded deferred tool search are runtime
  // policy, not routine user preferences. Both remain default-on with an
  // environment-only rollback switch.
  { key: 'prompt_cache', env: 'PROMPT_CACHE', default: true, internal: true },
  { key: 'tool_search', env: 'TOOL_SEARCH', default: true, internal: true },
  // The collector-derived `source_citations` turn-event kind (from web_search
  // tool_result citations/sources) + the renderer citation-chip row beneath the
  // answer. DEFAULT-ON since 2026-07-02 (owner-directed pre-soak flip -- live
  // soak IS the vocabulary soak). Flag-off is byte-identical: no derived events, no chips.
  { key: 'source_citations', env: 'SOURCE_CITATIONS', default: true, internal: true },
  // The user-folder "knowledge roots" registry (KnowledgeService + knowledge.*
  // IPC + knowledge_roots managed-sidecar config). DEFAULT-ON since 2026-07-02
  // (owner-directed pre-soak flip; inert until the user registers a folder).
  // Flag-off is byte-identical: the service stays inert (no knowledge.json,
  // addFolder/removeFolder return feature_disabled), the IPC handlers are not
  // registered, and no config keys are published.
  { key: 'knowledge_layer', env: 'KNOWLEDGE_LAYER', default: true, internal: true },
  // Row 41: the passive bring-your-own embedding index over the knowledge
  // folders. Local and offline, so DEFAULT-ON; inert until the user picks an
  // embedding GGUF in Settings. =0 stops the scheduler and the embedder and
  // withdraws the sidecar catalog config.
  { key: 'semantic_catalog', env: 'SEMANTIC_CATALOG', default: true, internal: true },
  { key: 'prefill_progress', env: 'PREFILL_PROGRESS', default: true, internal: true },
  // Settled-root markdown->HTML memoization in the thread-DOM renderer (finding
  // #3): unchanged settled roots reuse a cached article-markup string instead of
  // rebuilding it every full render. =0 rolls back to always-rebuild-fresh
  // (byte-identical output either way).
  { key: 'thread_root_markup_memo', env: 'THREAD_ROOT_MARKUP_MEMO', default: true, internal: true },
  // The Workspace Chat Dock: the live chat transcript + active-turn deck +
  // composer subtree relocated into a full-height side column of the Workspace
  // IDE (relocation, not duplication -- the one always-alive chat controller
  // keeps driving the moved nodes). =0 is byte-identical: nodes never leave
  // #chatView, main-chat approval-lock unchanged.
  { key: 'ide_chat_dock', env: 'IDE_CHAT_DOCK', default: true, internal: true },
  // Ht-D: content-visibility:auto paint-skip on chat transcript turn-articles
  // (.chat-entry), mirrored onto document.documentElement.dataset.chatContentVisibility
  // ('on' when ON; ATTRIBUTE ABSENT -- not 'false' -- when OFF, so the CSS rule
  // is inert and markup is byte-identical pre-Ht-D). Complements, never
  // replaces, the JS virtualizer. Exemptions (never paint-skipped): the
  // active/pending turn, turns with an unresolved approval gate, and the
  // bottom-2 turn-articles. DEFAULT-ON (owner-ratified design spec, 2026-07-05).
  { key: 'chat_render_content_visibility', env: 'CHAT_RENDER_CONTENT_VISIBILITY', default: true, internal: true },
  // The turn-finalization verification gate (sidecar routing/verification_gate.py)
  // that runs the user's designated Test Runner configuration after a typed file
  // mutation and hands a failing verdict back to the model. It also requires
  // tools_verify_enabled, since the gate reaches the Test Runner through the
  // `verify` tool. The gate can never prevent a turn from completing: a failing
  // or unrunnable gate becomes one honest sentence on the model's own response.
  // DEFAULT-OFF pending owner sign-off; =1 to try it.
  { key: 'verification_gate', env: 'VERIFICATION_GATE', default: false, internal: true },
  // Track B's in-place keyed morph for structural streaming article rebuilds.
  // DEFAULT-ON since 2026-07-11: live telemetry (streaming_article_rebuild
  // outcome=raw_innerhtml at every turn boundary) confirmed the raw-innerHTML
  // swap as the turn-boundary repaint flash (the Rank-1 flicker diagnosis), so
  // the built cure ships; =0 rolls back to the historical raw innerHTML
  // replacement path.
  { key: 'chat_timeline_streaming_article_morph', env: 'CHAT_TIMELINE_STREAMING_ARTICLE_MORPH', default: true, internal: true },
  // R2 bounded projection/virtualization: caps rebuildable renderer
  // projection/markup caches and virtualized transcript state. Electron remains
  // the canonical history owner. =0 restores the pre-R2 full-history renderer
  // cache/virtualizer retention path during the R2 soak.
  { key: 'chat_long_thread_bounds', env: 'CHAT_LONG_THREAD_BOUNDS', default: true, internal: true },
  // Chat files as a base plus append-only journal
  // (services/backend/session-journal-wiring.js). =0 makes every chat write
  // replace the whole file again (journals already on disk are still read).
  { key: 'session_journal', env: 'SESSION_JOURNAL', default: true, internal: true },
  // Per-session chat egress gate. Default-on with env-only rollback.
  { key: 'session_offline_lockdown', env: 'SESSION_OFFLINE_LOCKDOWN', default: true, internal: true },
  // The managed llama-server product surface: speculative-decoding launch args,
  // the per-model Engine/MTP controls in the Model library (row pills + Tune
  // drawer Engine section), and the `engines.updateSettings {acceleration,
  // managed}` keys. DEFAULT-ON since 2026-09-01; =0 rolls back byte-identical
  // (no probe, no args, no DOM).
  { key: 'llama_server_acceleration', env: 'LLAMA_SERVER_ACCELERATION', default: true, internal: true },
  // Row 54: the managed NInfer runtime for an eligible RTX 5090. With the flag
  // off there is no nvidia-smi probe for NInfer, no NInfer IPC data and no
  // NInfer DOM. Not user-overridable.
  { key: 'ninfer', env: 'NINFER', default: true, internal: true },
  // Row 98: the Home "Usage" widget; =0 hides it.
  { key: 'home_usage_stats', env: 'HOME_USAGE_STATS', default: true, internal: true },
  // Row 102: allowlisted read-only shell commands run without an approval card,
  // in Plan and Propose too; =0 restores the ask-first behaviour.
  { key: 'read_only_commands', env: 'READ_ONLY_COMMANDS', default: true, internal: true },
  // Row 121: Follow Jenny. Workspace shows a file while the model writes it (a
  // read-only draft tab, the chat row's four-line tail); =0 restores the 4 KB
  // argument preview and removes the draft, the tail and the status-bar switch.
  { key: 'follow_jenny', env: 'FOLLOW_JENNY', default: true, internal: true },

  // ---- Defaults only: in neither exported key list ----
  // Rows 96-97 (2026-11-01): live test-run progress, cross-process work leases on run_command.
  { key: 'test_progress', env: 'TEST_PROGRESS', default: true },
  { key: 'work_leases', env: 'WORK_LEASES', default: true },
];

const FEATURE_FLAG_TABLE = Object.freeze(FEATURE_FLAG_ROWS.map((row) => Object.freeze(row)));

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

module.exports = {
  FEATURE_FLAG_TABLE,
  RETIRED_FEATURE_FLAG_ENV_KEYS,
};
