/**
 * JSDoc typedefs for the Jenny preload bridge IPC contract.
 *
 * Types-only module with no runtime exports. These typedefs document the
 * shapes carried over the channels declared in ipc-contract.js.
 *
 * @module ipc-contract-types
 */

/** @typedef {'starting'|'ready'|'error'|'stopped'} BackendPhase */

/** @typedef {'session'|'recent'|'fresh'} HistoryScope */

/**
 * @typedef {Object} DataLifecycleResult
 * @property {boolean} ok
 * @property {string} operationId
 * @property {string} status
 * @property {Object} counts
 * @property {string[]} warnings
 * @property {{code: string, reason: string}} [error]
 */

/**
 * @typedef {Object} DataLifecycleProgress
 * @property {string} operationId
 * @property {string} phase
 * @property {number} percent
 * @property {number} completedBytes
 * @property {number} totalBytes
 * @property {string} label
 */

/**
 * @typedef {Object} DataArchiveOptions
 * @property {boolean} encrypted
 * @property {string} [passphrase]
 * @property {string} [passphraseConfirmation]
 * @property {string} [destinationRoot]
 * @property {boolean} [includeWorkspace]
 */

/**
 * @typedef {Object} DataRestoreOptions
 * @property {string} archivePath
 * @property {string} [passphrase]
 * @property {boolean} [includeWorkspace]
 */

/**
 * @typedef {Object} PluginInstallLocalPackageFromPathPayload
 * @property {string} client_request_id Bounded idempotency key.
 * @property {string} path Absolute local `.jenny-plugin` path, bounded to 4096 characters.
 */

/**
 * @typedef {Object} ContextPreferences
 * @property {HistoryScope} history_scope
 * @property {boolean} include_personality
 * @property {boolean} include_memory
 * @property {boolean} include_git_context
 * @property {boolean} include_codebase_context
 * @property {boolean} include_active_file_context
 */

/**
 * @typedef {Object} NextTurnContextSummary
 * @property {'estimated'|'unavailable'} status
 * @property {HistoryScope} [history_scope]
 * @property {number} [history_message_count]
 * @property {number} [available_history_message_count]
 * @property {boolean} [automatic_narrowing]
 * @property {string} [narrowing_reason]
 * @property {boolean} [compaction_snapshot_present]
 * @property {number} [linked_session_count]
 * @property {{personality: boolean, approved_memory: boolean, git: boolean, codebase: boolean, active_file: boolean, mentions: boolean, attachments: number}} [context_categories]
 * @property {string} [reason]
 */

/**
 * @typedef {Object} ModelGenerationProfile
 * @property {number} [temperature]
 * @property {number} [topP]
 * @property {number} [topK]
 * @property {number} [minP]
 * @property {number} [presencePenalty]
 * @property {number} [repetitionPenalty]
 * @property {number} [maxOutputTokens]
 */

/**
 * @typedef {Object} ModelTuningUpdateResult
 * @property {'applied'|'rolled_back'|'degraded'|'rejected'} status
 * @property {string} [reason]
 * @property {boolean} [runtimeAcknowledged]
 * @property {Object} state Bounded persisted tuning projection.
 * @property {Object} [preflight] Resource-fit evidence without raw hardware paths or prompts.
 */

/**
 * @typedef {Object} SessionSummary
 * @property {string} id
 * @property {string} title
 * @property {string} session_type
 * @property {string} created_at
 * @property {string} updated_at
 * @property {number} message_count
 * @property {string} last_message_preview
 * @property {string} last_model_used
 * @property {string} preferred_model
 * @property {string} reasoning_effort
 * @property {string} conversation_mode
 * @property {boolean} pinned
 * @property {string|null} archived_at ISO timestamp when archived; null = active.
 * @property {ContextPreferences} context_preferences
 * @property {{version: 1|2, created_at: string, strategy: 'full'|'micro', tokens_before: number, tokens_after: number, replacement_tokens?: number, boundary_message_count: number}|null} compaction_context Bounded renderer-safe projection; never includes compacted message content or boundary ids.
 * @property {{version: 1, used_tokens: number, context_window: number, compact_threshold_tokens: number, model: string, usage_source: 'provider'|'estimate', updated_at: string}|null} context_usage Last authoritative terminal context reading; seeds the composer ring's fallback estimate on a cold reopen and is dropped when history is rewritten.
 * @property {string[]} linked_session_ids
 * @property {{source_session_id: string, source_message_id: string, source_title: string, created_at: string}|null} branch_origin
 */

/**
 * @typedef {Object} SessionMessage
 * @property {string} id
 * @property {'user'|'assistant'} role
 * @property {string} kind
 * @property {string} content
 * @property {string} timestamp
 * @property {string} status
 * @property {string|null} finalizedAt
 * @property {string} model_used
 * @property {string} client_message_id
 * @property {Object} [reasoning] Per-message reasoning bundle.  Individual
 *   `reasoning_phases[]` entries may carry optional `iteration` (int, defaults
 *   to 1 when absent), `summary` (short synthesized reason text), and
 *   `tokens_per_second` (float chunk-timing meta) fields surfaced by the
 *   sidecar `chat.phase_started`, `chat.phase_completed`, and `chat.thinking`
 *   notifications.
 * @property {AttachmentMeta[]} attachments
 * @property {ToolCallMeta|null} tool_call
 * @property {ToolResultMeta|null} tool_result
 * @property {AgentStatusMeta|null} [agent_status]
 * @property {ProactiveSuggestionMeta|null} proactive_suggestion
 * @property {Object<string, MessageReaction>} message_reactions Allowed keys:
 *   `thumbs_up`, `saved`, and `note`.
 */

/**
 * @typedef {Object} MessageReaction
 * @property {true} selected
 * @property {string} updated_at
 */

/**
 * @typedef {Object} AttachmentMeta
 * @property {string} id
 * @property {'text'|'image'|'audio'} kind
 * @property {string} displayName
 * @property {string} mimeType
 * @property {number} sizeBytes
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [durationMs]
 * @property {string} assetPath
 * @property {string} sourceKind
 * @property {string} [transcriptText]
 * @property {'pending'|'complete'|'error'} [transcriptStatus]
 * @property {string} [transcriptLanguage]
 */

/**
 * @typedef {Object} ToolCallMeta
 * @property {string} call_id
 * @property {string} tool_name
 * @property {string} input_json
 * @property {Object} input
 * @property {string} summary
 * @property {string} status
 * @property {string} approval_state
 * @property {string} [policy_scope]
 * @property {string} [policy_consequence]
 * @property {string} [reason]
 * @property {number} duration_ms
 * @property {string} parent_stream_id
 */

/**
 * @typedef {Object} ToolResultMeta
 * @property {string} call_id
 * @property {string} tool_name
 * @property {string} output_text
 * @property {string} summary
 * @property {boolean} is_error
 * @property {string} error_code
 * @property {number|null} exit_code
 * @property {number} duration_ms
 * @property {string} parent_stream_id
 * @property {GeneratedArtifact[]} generated_artifacts
 * @property {Object} metadata
 */

/**
 * @typedef {Object} AgentStatusMeta
 * @property {string} streamId
 * @property {string} sessionId
 * @property {string} requestId
 * @property {string} taskId
 * @property {string} taskType
 * @property {string} source
 * @property {string} status
 * @property {string} stage
 * @property {number} percent
 * @property {string} summary
 * @property {boolean} terminal
 * @property {boolean} success
 * @property {string} [toolCallId]
 * @property {string} [agentId]
 * @property {string} [parentAgentId]
 * @property {string} [childTaskId]
 * @property {string} [childAgentId]
 * @property {number} [childOrdinal]
 * @property {number} [childCount]
 * @property {string} [childLabel]
 * @property {boolean} [childTerminal]
 * @property {boolean} [childSuccess]
 * @property {string} [model]
 * @property {string} [provider]
 * @property {SubagentUsage} [usage]
 * @property {string} [terminalReason]
 */

/**
 * @typedef {Object} SubagentUsage
 * @property {number} [input_tokens]
 * @property {number} [output_tokens]
 * @property {number} [total_tokens]
 * @property {number} [last_request_input_tokens]
 * @property {number} [context_tokens_estimate]
 * @property {number} [context_window]
 * @property {number} [compact_threshold_tokens]
 * @property {string} [provider]
 * @property {string} [model]
 * @property {boolean} estimated
 */

/**
 * @typedef {Object} GeneratedArtifact
 * @property {string} artifact_id
 * @property {string} relative_path
 * @property {string} display_name
 * @property {string} content_type
 */

/**
 * @typedef {Object} ProactiveSuggestionMeta
 * @property {string} id
 * @property {string} kind
 * @property {string} title
 * @property {string} body
 * @property {string} promptSuggestion
 * @property {string} createdAt
 * @property {string} dedupeKey
 * @property {Object} sourceMeta
 */

/**
 * @typedef {Object} SchemaVersionEntry
 * @property {string} id
 * @property {string} surface
 * @property {string} owner
 * @property {string} kind
 * @property {string|number} version
 * @property {string} forward_policy
 * @property {string} source
 */

/**
 * @typedef {Object} BackendStatus
 * @property {BackendPhase} phase
 * @property {string} detail
 * @property {string} [error]
 * @property {string} [launchSource]
 * @property {string} [packagedLaunchDetail]
 * @property {SchemaVersionEntry[]} [schemaVersions]
 * @property {boolean} [setup_complete]
 * @property {Object|null} [setup_state]
 */

/**
 * @typedef {Object} ChatGptPlanUsageWindow
 * @property {number} used_percent
 * @property {number} [window_minutes]
 * @property {number} reset_at
 */

/**
 * @typedef {Object} ChatGptPlanUsageRecord
 * @property {1} version
 * @property {string} account_key
 * @property {ChatGptPlanUsageWindow|null} primary
 * @property {ChatGptPlanUsageWindow} [secondary]
 * @property {'primary'|'secondary'} [rate_limit_reached_type]
 * @property {number} captured_at_ms
 * @property {'chat_done'|'chat_error'} source
 */

/**
 * @typedef {Object} ChatGptPlanUsageAccount
 * @property {string} email
 * @property {string} plan_type
 */

/**
 * Payload carried by both chatgptPlanUsage.getSnapshot (invoke) and
 * chatgptPlanUsage.onSnapshot (subscribe push) -- see ipc-contract.js and
 * services/main/chatgpt-plan-usage-ipc.js.
 * @typedef {Object} ChatGptPlanUsagePayload
 * @property {boolean} ok
 * @property {'chatgpt'} provider_id
 * @property {boolean} engine_active
 * @property {ChatGptPlanUsageAccount|null} account
 * @property {ChatGptPlanUsageRecord|null} snapshot
 */

/**
 * @typedef {Object} ModelInfo
 * @property {string} id
 * @property {string} name
 * @property {Object} capabilities
 * @property {string} provider
 */

/**
 * @typedef {Object} ModelListPayload
 * @property {"list"} object
 * @property {string} active_model
 * @property {string} engine_type
 * @property {boolean} available
 * @property {string} reason
 * @property {boolean} [stale]
 * @property {string} [source]
 * @property {string} [cached_at]
 * @property {string} [expires_at]
 * @property {string} [last_error]
 * @property {string} [daemon_version]
 * @property {ModelInfo[]} data
 */

/**
 * @typedef {Object} WorkspaceState
 * @property {string} activeSessionId
 * @property {string[]} openSessionIds
 */

/**
 * @typedef {Object} WorkspaceRootState
 * @property {string} workspaceRoot
 * @property {{state: string, message: string}} workspaceRootStatus
 * @property {boolean} [changed]
 * @property {boolean} [canceled]
 */

/**
 * @typedef {Object} ChatUiState
 * @property {number} zoomPercent
 */

/**
 * @typedef {Object} WindowUiState
 * @property {number} appZoomPercent
 */

/**
 * @typedef {Object} ToolConfigField
 * @property {string} key
 * @property {string} label
 * @property {string} fieldType
 * @property {string} storage
 * @property {boolean|string|number|Array|Object|null} default
 * @property {string} helpText
 * @property {string} configFlag
 * @property {string[]} toolIds
 */

/**
 * @typedef {Object} FeatureAvailabilityMeta
 * @property {boolean} [managedSidecarRequired]
 * @property {boolean} [windowsOnly]
 * @property {boolean} [workspaceRootRequired]
 * @property {boolean} [electronOnly]
 * @property {boolean} [enabled]
 */

/**
 * @typedef {Object} FeatureSettingsState
 * @property {{web: boolean, imageRead: boolean, pythonRuntime: boolean, todo: boolean, mermaid?: boolean}} tools
 * @property {{schemaVersion: number, fields: ToolConfigField[]}} [toolConfig]
 * @property {Object<string, boolean>} featureFlags
 * @property {Object<string, boolean>} featureOverrides
 * @property {{
 *   runtime: {managedSidecarActive: boolean, windowsOnly: boolean, workspaceRootStatus: {state: string, message: string}},
 *   tools: Object<string, FeatureAvailabilityMeta>,
 *   featureFlags: Object<string, FeatureAvailabilityMeta>
 * }} availability
 */

/**
 * @typedef {Object} MemoryCandidate
 * @property {string} kind
 * @property {string} title
 * @property {string} lesson_text
 * @property {string} [fingerprint]
 */

/**
 * @typedef {Object} ApprovedMemory
 * @property {number} id
 * @property {string} session_id
 * @property {string} lesson_kind
 * @property {string} title
 * @property {string} lesson_text
 * @property {number} confidence
 * @property {string} source_excerpt
 * @property {string} content_fingerprint
 * @property {string} family_key
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} PendingMemoryCandidate
 * @property {number} id
 * @property {string} session_id
 * @property {string} source_request_id
 * @property {string} title
 * @property {string} lesson_text
 * @property {string} lesson_kind
 * @property {number} confidence
 * @property {string} source_excerpt
 * @property {string} content_fingerprint
 * @property {string} family_key
 * @property {string} category
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {Object} StreamEvent
 * @property {string} type
 * @property {string} streamId
 * @property {string} sessionId
 * @property {string} [requestId]
 * @property {string} [traceId]
 * @property {Object} data
 */

/**
 * @typedef {Object} StreamEnvelopeV2
 * @property {number} [schemaVersion]
 * @property {string} streamId
 * @property {string} turnId
 * @property {number} [sequence]
 * @property {number} [sequenceEnd]
 * @property {'reasoning'|'response'|'tool'|'phase'|'control'} channel
 * @property {number} [channelSequence]
 * @property {number} [channelSequenceEnd]
 * @property {'delta'|'started'|'completed'|'reset'|'terminal'} eventKind
 * @property {Object|null} [phase]
 * @property {Object} payload
 * @property {number} [emittedAtMs]
 * @property {number} [bridgedAtMs]
 */

/**
 * @typedef {Object} ActiveTurnPendingApproval
 * @property {string} [approval_id]
 * @property {string} call_id
 * @property {string} tool_name
 * @property {string} [policy_scope]
 * @property {string} [policy_consequence]
 * @property {string} [reason]
 * @property {string} summary
 */

/**
 * Tool approval response sent from Electron to sidecar in reply to a
 * `tool.request_approval` JSON-RPC request.
 *
 * Wire-level schema owner: `sidecar/protocol.py` + `sidecar/runtime/approval.py`
 * (see `approval_decision_from_response`). This typedef documents the
 * cross-boundary shape for Electron consumers; any schema change must land
 * on the sidecar side first and update this JSDoc in the same commit.
 *
 * The response is a standard JSON-RPC 2.0 result envelope whose `result`
 * object carries either `approved: boolean` (preferred) or a string
 * `decision` field accepted for compatibility with older renderers.
 *
 * @typedef {Object} ToolApprovalResponseResult
 * @property {boolean} [approved] Preferred form. `true` resumes the tool
 *   call; `false` classifies the tool as denied and terminates the loop
 *   iteration without executing the tool.
 * @property {"approve"|"approved"|"allow"|"allowed"|"deny"|"denied"|"block"|"blocked"} [decision]
 *   Fallback form. Strings matching the approve set are treated as
 *   approval; any other value is treated as denial.
 * @property {"this_call"|"session"|"always"} [remember] Optional scope for
 *   persisting the decision to the tool permission store.
 * @property {string} [reason] Optional denial reason surfaced in renderer
 *   telemetry.
 *
 * @typedef {Object} ToolApprovalResponse
 * @property {"2.0"} jsonrpc
 * @property {number} id Must match the `id` of the originating
 *   `tool.request_approval` request.
 * @property {ToolApprovalResponseResult} result
 */

/**
 * @typedef {Object} ActiveTurnState
 * @property {string} request_id
 * @property {string} stream_id
 * @property {string} [trace_id]
 * @property {string} session_id
 * @property {string} user_message_id
 * @property {string} started_at
 * @property {string} last_event_at
 * @property {'awaiting_assistant'|'streaming'} status
 * @property {string} state
 * @property {string|null} phase
 * @property {string|null} terminal_reason
 * @property {string|null} terminal_subcode
 * @property {ActiveTurnPendingApproval} [pending_approval]
 */

/**
 * @typedef {Object} AgentStatusStreamEvent
 * @property {'agent_status'} type
 * @property {string} streamId
 * @property {string} sessionId
 * @property {string} requestId
 * @property {string} taskId
 * @property {string} taskType
 * @property {string} source
 * @property {string} status
 * @property {string} stage
 * @property {number} percent
 * @property {string} summary
 * @property {boolean} terminal
 * @property {boolean} success
 */

/**
 * @typedef {Object} ChatStartPayload
 * @property {string} sessionId
 * @property {string} prompt
 * @property {string} [visiblePrompt]
 * @property {string} [traceId]
 * @property {string} [preferredModel]
 * @property {string} [reasoningEffort]
 * @property {Array<Object>} [attachments]
 * @property {Object|null} [interactiveResponse]
 * @property {number} [interactiveRoundCount]
 * @property {boolean} [planMode]
 * @property {'prompt'|'auto_run'} [approvalMode]
 * @property {Object|null} [contextPreferences]
 * @property {Object|null} [activeFileContext]
 * @property {Array<Object>} [mentionContents]
 * @property {{web_search?: boolean, browser?: boolean, Bash?: boolean, python_execute?: boolean, file_tools?: boolean}} [toolPreferences]
 * @property {{disableThinking?: boolean, leanContext?: boolean, plainChatMode?: boolean}} [debugOptions]
 * @property {{send_started_at_ms?: number, optimistic_rendered_at_ms?: number, local_render_latency_ms?: number}} [clientTiming]
 * @property {Object} [pluginCommandInvocation] Frozen PluginCommandInvocationV2 wire value.
 * @property {{id: string}} [skillInvocation] One-turn skill selection; Electron resolves metadata.
 * @property {string} [editedMessageId]
 * Runtime validation is generated from config/chat-lifecycle-v2.schema.json.
 */

/**
 * @typedef {Object} SessionTemplate
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {ContextPreferences} context_preferences
 * @property {string} preferred_model
 * @property {string} reasoning_effort
 * @property {string} conversation_mode
 * @property {string[]} linked_session_ids
 * @property {string} created_at
 */


module.exports = {};
