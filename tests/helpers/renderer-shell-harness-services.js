const { createSchedulerStub, createUpdatesStub, normalizeLocalModelId } = require('./renderer-shell-harness-support');
const { createCompanionStub } = require('./renderer-shell-harness-companion');
const { createSkillsStub, createTipsStub } = require('./renderer-shell-harness-guidance');
const { createWorkspaceIdeStub } = require('./renderer-shell-harness-workspace-ide');
const { createCompactionStub } = require('./renderer-shell-harness-compaction');
const { applyWorkspaceRootPayload, createWorkspaceRootStub, getProactiveStatePayload } = require('./renderer-shell-harness-workspace-root');
const { createMemoryNotesStub, createPersonalityStub } = require('./renderer-shell-harness-personality');

function activateWorkspaceSessionState(state, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return;
  const workspaceState = state.workspaceState && typeof state.workspaceState === 'object'
    ? state.workspaceState
    : { activeSessionId: '', openSessionIds: [] };
  const openSessionIds = Array.isArray(workspaceState.openSessionIds)
    ? workspaceState.openSessionIds.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (!openSessionIds.includes(id)) {
    const activeIndex = openSessionIds.indexOf(String(workspaceState.activeSessionId || '').trim());
    openSessionIds.splice(activeIndex >= 0 ? activeIndex + 1 : openSessionIds.length, 0, id);
  }
  state.workspaceState = {
    ...workspaceState,
    activeSessionId: id,
    openSessionIds,
  };
}

function createShellStubServices(context) {
  const { options, state, addListener, emitBackendStatus, emitSpeechState, emitUpdatesChanged } = context;
  const chatOptions = options.chat || {};
  const modelOptions = options.models || {};

  return {
    chatUi: {
      async getState() {
        if (typeof options.chatUi?.getState === 'function') {
          const payload = await options.chatUi.getState({ state });
          if (payload && typeof payload === 'object') {
            state.chatUiState = {
              ...state.chatUiState,
              ...payload,
            };
          }
        }
        return state.chatUiState;
      },
      async updateSettings(patch) {
        if (typeof options.chatUi?.updateSettings === 'function') {
          const payload = await options.chatUi.updateSettings(patch, { state });
          if (payload && typeof payload === 'object') {
            state.chatUiState = {
              ...state.chatUiState,
              ...payload,
            };
          }
          return state.chatUiState;
        }
        state.chatUiState = {
          ...state.chatUiState,
          ...(patch && typeof patch === 'object' ? patch : {}),
        };
        return state.chatUiState;
      },
    },
    windowUi: {
      async getState() {
        if (typeof options.windowUi?.getState === 'function') {
          const payload = await options.windowUi.getState({ state });
          if (payload && typeof payload === 'object') {
            state.windowUiState = {
              ...state.windowUiState,
              ...payload,
            };
          }
        }
        return state.windowUiState;
      },
      async updateSettings(patch) {
        if (typeof options.windowUi?.updateSettings === 'function') {
          const payload = await options.windowUi.updateSettings(patch, { state });
          if (payload && typeof payload === 'object') {
            state.windowUiState = {
              ...state.windowUiState,
              ...payload,
            };
          }
          return state.windowUiState;
        }
        state.windowUiState = {
          ...state.windowUiState,
          ...(patch && typeof patch === 'object' ? patch : {}),
        };
        return state.windowUiState;
      },
    },
    // ChatGPT plan-usage bridge (chatgptPlanUsage.*): tests seed a payload via
    // options.chatgptPlanUsage.payload and push updates with
    // shell.__emitPlanUsage(payload). Absent by default = meter hidden.
    chatgptPlanUsage: {
      async getSnapshot() {
        if (typeof options.chatgptPlanUsage?.getSnapshot === 'function') {
          return options.chatgptPlanUsage.getSnapshot({ state });
        }
        return options.chatgptPlanUsage?.payload ?? null;
      },
      onSnapshot(listener) {
        return addListener('planUsage', listener);
      },
    },
    status: {
      async get() {
        if (typeof options.status?.get === 'function') {
          return options.status.get();
        }
        return {
          tokens: { used: 0, max: 131072 },
          effective_context_length: 262144,
          configured_context_length: 262144,
          native_context_length: 262144,
        };
      },
    },
    ...createSchedulerStub(options, state),
    suggestions: {
      async generate() {
        if (typeof options.suggestions?.generate === 'function') {
          return options.suggestions.generate({ state });
        }
        return { suggestions: [] };
      },
    },
    system: {
      async getStats() {
        return {
          cpuPercent: 0,
          ramPercent: 0,
          battery: 'AC',
          arch: 'x64',
          gpuMemory: {
            available: false,
            usedMb: 0,
            totalMb: 0,
            gpuType: '',
            source: 'unavailable',
            sampledAt: new Date().toISOString(),
          },
        };
      },
      onStats(listener) {
        return addListener('system', listener);
      },
    },
    logs: {
      async list() {
        return Array.isArray(state.logEntries) ? state.logEntries.slice() : [];
      },
      onAppend(listener) {
        return addListener('logs', listener);
      },
    },
    personality: createPersonalityStub(options.personality, state),
    artifacts: {
      async read(_sessionId, artifactId) {
        if (typeof options.artifacts?.read === 'function') {
          return options.artifacts.read(_sessionId, artifactId, { state });
        }
        return {
          artifact: {
            artifact_id: artifactId,
            title: 'Scratch artifact',
            editable: true,
            status: 'available',
            language: 'markdown',
            absolute_path: `C:/workspace/.jenny/artifacts/${artifactId}.md`,
            display_path: `.jenny/artifacts/${artifactId}.md`,
          },
          content: '',
        };
      },
      async save(_sessionId, artifactId, content) {
        if (typeof options.artifacts?.save === 'function') {
          return options.artifacts.save(_sessionId, artifactId, content, { state });
        }
        return {
          artifact: {
            artifact_id: artifactId,
            editable: true,
            status: 'available',
          },
        };
      },
      async reveal(_sessionId, artifactId) {
        if (typeof options.artifacts?.reveal === 'function') {
          return options.artifacts.reveal(_sessionId, artifactId, { state });
        }
        return { ok: true, artifact: { artifact_id: artifactId } };
      },
      async openExternal(_sessionId, artifactId) {
        if (typeof options.artifacts?.openExternal === 'function') {
          return options.artifacts.openExternal(_sessionId, artifactId, { state });
        }
        return { ok: true, artifact: { artifact_id: artifactId } };
      },
      async delete(_sessionId, artifactId) {
        if (typeof options.artifacts?.delete === 'function') {
          return options.artifacts.delete(_sessionId, artifactId, { state });
        }
        return { status: 'deleted', artifact_id: artifactId };
      },
    },
    memory: {
      contextFiles: createMemoryNotesStub(options.memory, state),
      async status() { return typeof options.memory?.status === 'function' ? options.memory.status({ state }) : { available: true, schema_version: 7, recall_index: 'fts5', counts: { approved: 0, pending: 0, quarantined: 0 }, storage: { state: 'ready', physical_bytes: 0, capacity_bytes: 50 * 1024 * 1024 }, repair_required: false, degraded_reasons: [] }; },
      async suggestForSession(sessionId) {
        if (typeof options.memory?.suggestForSession === 'function') {
          return options.memory.suggestForSession(sessionId, { state });
        }
        return { suggestions: [] };
      },
      async save(sessionId, candidate) {
        if (typeof options.memory?.save === 'function') {
          return options.memory.save(sessionId, candidate, { state });
        }
        return { created: true, memory: candidate || null };
      },
      async listApproved() {
        if (typeof options.memory?.listApproved === 'function') {
          return options.memory.listApproved({ state });
        }
        return { memories: [] };
      },
      async listPending() {
        if (typeof options.memory?.listPending === 'function') {
          return options.memory.listPending({ state });
        }
        return { candidates: [] };
      },
      async update(memoryId, patch) {
        if (typeof options.memory?.update === 'function') {
          return options.memory.update(memoryId, patch, { state });
        }
        return {
          updated: true,
          memory: {
            id: memoryId,
            ...patch,
          },
        };
      },
      async delete(memoryId) {
        if (typeof options.memory?.delete === 'function') {
          return options.memory.delete(memoryId, { state });
        }
        return { deleted: true, memory_id: memoryId };
      },
      async deletePending(sessionId, contentFingerprint) {
        if (typeof options.memory?.deletePending === 'function') {
          return options.memory.deletePending(sessionId, contentFingerprint, { state });
        }
        return { deleted: Boolean(sessionId && contentFingerprint) };
      },
      async dismiss(fingerprint) {
        if (typeof options.memory?.dismiss === 'function') {
          return options.memory.dismiss(fingerprint, { state });
        }
        return { dismissed: Boolean(fingerprint) };
      },
    },
    harness: {
      async inspect(optionsPayload) {
        if (typeof options.harness?.inspect === 'function') {
          return options.harness.inspect({ state, options: optionsPayload });
        }
        return state.harnessSnapshot || {
          generated_at: new Date().toISOString(),
          sections: ['tools', 'memories', 'skills', 'runtime', 'workspace', 'shell'],
          tools: { items: [], counts: { total: 0, enabled: 0, disabled: 0 } },
          memories: { approved: [], pending: [], counts: { approved: 0, pending: 0, provenance: { user_approved: 0, automatic: 0, unknown_legacy: 0 } } },
          skills: { items: [], scopes: [], counts: { total: 0, bundled: 0, user: 0, project: 0 } },
          runtime: {},
          workspace: { blockers: [] },
          shell: {},
        };
      },
    },
    diagnostics: {
      async reportRendererError(payload) {
        state.rendererErrors.push(payload);
        return { ok: true };
      },
      logs: {
        async getSnapshot(snapshotOptions) {
          if (typeof options.diagnostics?.logs?.getSnapshot === 'function') {
            return options.diagnostics.logs.getSnapshot(snapshotOptions, { state });
          }
          const entries = Array.isArray(state.logEntries) ? state.logEntries.slice() : [];
          return {
            schema_version: 1,
            generated_at: new Date().toISOString(),
            active_run: { run_id: 'harness-current', started_at: new Date().toISOString() },
            prior_run: null,
            entries,
            sources: {},
            integrity: { complete: true, partial_reasons: [], dropped_by_source: {}, capture_policy: {} },
          };
        },
        onEntry(listener) {
          return addListener('logs', listener);
        },
        appendRendererBatch(batch) {
          const entries = Array.isArray(batch?.entries) ? batch.entries : [];
          state.logEntries.push(...entries.map((entry) => ({ ...entry, run_id: entry.run_id || 'harness-current' })));
        },
      },
      async getJennyStatus(statusOptions) {
        if (typeof options.diagnostics?.getJennyStatus === 'function') {
          return options.diagnostics.getJennyStatus(statusOptions, { state });
        }
        return { schema_version: 4, backend: { phase: state.backendStatus?.phase || 'ready' } };
      },
      phasePercentiles: {
        async get() {
          if (typeof options.diagnostics?.phasePercentiles?.get === 'function') {
            return options.diagnostics.phasePercentiles.get({ state });
          }
          return state.phasePercentilesPayload || {
            generated_at: new Date().toISOString(),
            retention: { samples_per_phase: 256 },
            targets: {},
            phases: {},
          };
        },
        async reset() {
          state.phasePercentilesResetCalls += 1;
          if (typeof options.diagnostics?.phasePercentiles?.reset === 'function') {
            return options.diagnostics.phasePercentiles.reset({ state });
          }
          state.phasePercentilesPayload = {
            generated_at: new Date().toISOString(),
            retention: { samples_per_phase: 256 },
            targets: state.phasePercentilesPayload?.targets || {},
            phases: {},
          };
          return state.phasePercentilesPayload;
        },
      },
    },
    proactive: {
      async getState() {
        if (typeof options.proactive?.getState === 'function') {
          return options.proactive.getState({ state });
        }
        return getProactiveStatePayload(state);
      },
      async chooseWorkspaceRoot() {
        if (typeof options.proactive?.chooseWorkspaceRoot === 'function') {
          return options.proactive.chooseWorkspaceRoot({ state });
        }
        applyWorkspaceRootPayload(state, {
          workspaceRoot: 'G:/workspace/selected',
          workspaceRootStatus: {
            state: 'ready',
            message: 'Workspace root is configured.',
          },
        });
        return this.getState();
      },
      async clearWorkspaceRoot() {
        if (typeof options.proactive?.clearWorkspaceRoot === 'function') {
          return options.proactive.clearWorkspaceRoot({ state });
        }
        applyWorkspaceRootPayload(state, {
          workspaceRoot: '',
          workspaceRootStatus: {
            state: 'missing',
            message: 'No workspace root is configured yet.',
          },
        });
        return this.getState();
      },
      async upsertReminder(reminder) {
        if (typeof options.proactive?.upsertReminder === 'function') {
          return options.proactive.upsertReminder(reminder, { state });
        }
        const id = String(reminder?.id || `rem-${state.proactiveState.proactive.reminders.length + 1}`).trim();
        state.proactiveState = {
          ...state.proactiveState,
          proactive: {
            ...state.proactiveState.proactive,
            reminders: [
              ...state.proactiveState.proactive.reminders.filter((entry) => String(entry?.id || '').trim() !== id),
              {
                ...reminder,
                id,
                createdAt: reminder?.createdAt || new Date().toISOString(),
                lastFiredAt: reminder?.lastFiredAt || '',
              },
            ],
          },
        };
        return this.getState();
      },
      async deleteReminder(reminderId) {
        if (typeof options.proactive?.deleteReminder === 'function') {
          return options.proactive.deleteReminder(reminderId, { state });
        }
        state.proactiveState = {
          ...state.proactiveState,
          proactive: {
            ...state.proactiveState.proactive,
            reminders: state.proactiveState.proactive.reminders.filter(
              (entry) => String(entry?.id || '').trim() !== String(reminderId || '').trim()
            ),
          },
        };
        return this.getState();
      },
    },
    setup: {
      async getState() {
        if (typeof options.setup?.getState === 'function') {
          const payload = await options.setup.getState({ state });
          if (payload && typeof payload === 'object') {
            state.setupState = payload;
          }
        }
        return state.setupState;
      },
      async updateState(patch) {
        state.setupUpdateStateCalls.push(patch);
        if (typeof options.setup?.updateState === 'function') {
          const payload = await options.setup.updateState(patch, { state });
          if (payload && typeof payload === 'object') {
            state.setupState = payload;
          }
          return state.setupState;
        }
        state.setupState = {
          ...state.setupState,
          setup_complete: patch?.setupComplete === false ? false : state.setupState.setup_complete,
          setup_state: {
            ...state.setupState.setup_state,
            dismissed: patch?.dismissed === false ? false : state.setupState.setup_state.dismissed,
            setup_complete: patch?.setupComplete === false ? false : state.setupState.setup_state.setup_complete,
            updated_at: new Date().toISOString(),
          },
        };
        return state.setupState;
      },
      async complete() {
        state.setupState = {
          ...state.setupState,
          setup_complete: true,
          setup_state: {
            ...state.setupState.setup_state,
            setup_complete: true,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        };
        return state.setupState;
      },
      async reset() {
        state.setupResetCalls += 1;
        if (typeof options.setup?.reset === 'function') {
          const payload = await options.setup.reset({ state });
          if (payload && typeof payload === 'object') {
            state.setupState = payload;
          }
          return state.setupState;
        }
        state.setupState = {
          ...state.setupState,
          setup_complete: false,
          setup_state: {
            ...state.setupState.setup_state,
            setup_complete: false,
            dismissed: false,
            updated_at: new Date().toISOString(),
          },
        };
        return state.setupState;
      },
      async factoryReset() {
        state.setupFactoryResetCalls += 1;
        if (typeof options.setup?.factoryReset === 'function') {
          const payload = await options.setup.factoryReset({ state });
          if (payload && typeof payload === 'object') {
            state.setupState = payload;
          }
          return state.setupState;
        }
        state.setupState = {
          setup_complete: false, factoryResetResult: { completed: true },
          setup_state: {
            seen: false,
            dismissed: false,
            setup_complete: false,
            completed_at: '',
            updated_at: new Date().toISOString(),
            steps: {
              workspace_root: 'pending',
              local_model: 'pending',
              endpoint: 'pending',
              personality: 'pending',
              skills: 'pending',
            },
            tools_workspace_root_configured: true,
            mcp_tools_discovered: false,
            assistant_identity: { agentName: 'Jenny', profile: 'balanced', customText: '', updatedAt: '' },
          },
        };
        return state.setupState;
      },
      async validateEndpoint() {
        return { ok: true, engineType: 'ollama', checkedUrl: '', status: 200, code: 'ok', message: 'ok' };
      },
      async startOllamaPull(payload) {
        return { requestId: payload?.requestId || 'req-test', model: payload?.model || '', status: 'running', summary: 'Starting' };
      },
      async cancelOllamaPull(payload) {
        return { cancelled: true, requestId: payload?.requestId || '', model: payload?.model || '', status: 'cancelled', summary: 'Cancelled' };
      },
      onModelPullProgress() {
        return () => {};
      },
    },
    workspaceRoot: createWorkspaceRootStub(options, state),
    companion: createCompanionStub(options, state),
    workspace: {
      async getState() {
        if (typeof options.workspace?.getState === 'function') {
          const payload = await options.workspace.getState({ state });
          if (payload && typeof payload === 'object') {
            state.workspaceState = {
              activeSessionId: String(payload.activeSessionId || '').trim(),
              openSessionIds: Array.isArray(payload.openSessionIds) ? payload.openSessionIds.slice() : [],
            };
          }
        }
        return {
          activeSessionId: String(state.workspaceState.activeSessionId || '').trim(),
          openSessionIds: Array.isArray(state.workspaceState.openSessionIds)
            ? state.workspaceState.openSessionIds.slice()
            : [],
        };
      },
      async updateState(patch) {
        state.workspaceUpdateCalls.push(patch);
        if (typeof options.workspace?.updateState === 'function') {
          const payload = await options.workspace.updateState(patch, { state });
          if (payload && typeof payload === 'object') {
            state.workspaceState = {
              ...state.workspaceState,
              ...payload,
              openSessionIds: Array.isArray(payload.openSessionIds)
                ? payload.openSessionIds.slice()
                : state.workspaceState.openSessionIds,
            };
          }
        } else {
          state.workspaceState = {
            ...state.workspaceState,
            ...(patch && typeof patch === 'object' ? patch : {}),
            openSessionIds: Array.isArray(patch?.openSessionIds)
              ? patch.openSessionIds.slice()
              : state.workspaceState.openSessionIds,
          };
        }
        return this.getState();
      },
    },
    workspaceIde: createWorkspaceIdeStub(options.workspaceIde, state),
    skills: createSkillsStub({ ...options, addListener }, state),
    mcpDiscovery: {
      async getState() {
        if (typeof options.mcpDiscovery?.getState === 'function') {
          const payload = await options.mcpDiscovery.getState({ state });
          if (payload && typeof payload === 'object') {
            state.mcpDiscoveryState = payload;
          }
        }
        return state.mcpDiscoveryState;
      },
      async refresh() {
        state.mcpDiscoveryRefreshCalls += 1;
        if (typeof options.mcpDiscovery?.refresh === 'function') {
          const payload = await options.mcpDiscovery.refresh({ state });
          if (payload && typeof payload === 'object') {
            state.mcpDiscoveryState = payload;
          }
        }
        return state.mcpDiscoveryState;
      },
      ...Object.fromEntries(['createServer', 'updateServer', 'removeServer', 'testServer',
        'approveServer', 'setServerEnabled'].map((method) => [method, async (payload) => {
        state.mcpDiscoveryOperationCalls.push({ method, payload });
        if (typeof options.mcpDiscovery?.[method] === 'function') {
          return options.mcpDiscovery[method]({ state, payload });
        }
        return { ok: true, state: state.mcpDiscoveryState };
      }])),
    },
    tips: createTipsStub(options, state, addListener),
    updates: createUpdatesStub(options, state, addListener, emitUpdatesChanged),
    features: {
      async getState() {
        if (typeof options.features?.getState === 'function') {
          const payload = await options.features.getState({ state, emitBackendStatus });
          if (payload && typeof payload === 'object') {
            state.featuresState = {
              ...state.featuresState,
              ...payload,
              tools: {
                ...state.featuresState.tools,
                ...(payload.tools || {}),
              },
              featureFlags: {
                ...state.featuresState.featureFlags,
                ...(payload.featureFlags || {}),
              },
              featureOverrides: {
                ...state.featuresState.featureOverrides,
                ...(payload.featureOverrides || {}),
              },
            };
          }
        }
        return state.featuresState;
      },
      async updateSettings(patch) {
        if (typeof options.features?.updateSettings === 'function') {
          const payload = await options.features.updateSettings(patch, { state });
          if (payload && typeof payload === 'object') {
            state.featuresState = {
              ...state.featuresState,
              ...payload,
              tools: {
                ...state.featuresState.tools,
                ...(payload.tools || {}),
              },
              featureFlags: {
                ...state.featuresState.featureFlags,
                ...(payload.featureFlags || {}),
              },
              featureOverrides: {
                ...state.featuresState.featureOverrides,
                ...(payload.featureOverrides || {}),
              },
            };
          }
          return state.featuresState;
        }
        state.featuresState = {
          ...state.featuresState,
          tools: { ...state.featuresState.tools, ...(patch?.tools || {}) },
          memory: { ...state.featuresState.memory, ...(patch?.memory || {}) },
          featureFlags: { ...state.featuresState.featureFlags, ...(patch?.featureFlags || {}) },
          featureOverrides: { ...state.featuresState.featureOverrides, ...(patch?.featureOverrides || {}) },
        };
        return state.featuresState;
      },
      onChanged(listener) {
        return addListener('features', listener);
      },
    },
    offline: {
      async getState() {
        if (typeof options.offline?.getState === 'function') {
          const payload = await options.offline.getState({ state });
          if (payload && typeof payload === 'object') {
            state.offlineState = payload;
          }
        }
        return state.offlineState;
      },
      async updateSettings(patch) {
        state.offlineUpdateCalls.push(patch);
        if (typeof options.offline?.updateSettings === 'function') {
          const payload = await options.offline.updateSettings(patch, { state });
          if (payload && typeof payload === 'object') {
            state.offlineState = payload;
          }
          return state.offlineState;
        }
        const next = {
          ...state.offlineState,
          ...(patch && typeof patch === 'object' ? patch : {}),
        };
        const localModelIds = Array.isArray(next.localCatalog?.models)
          ? next.localCatalog.models.map((entry) => normalizeLocalModelId(entry)).filter(Boolean)
          : [];
        const selectedModelEntry = Array.isArray(next.localCatalog?.models)
          ? next.localCatalog.models.find((entry) => normalizeLocalModelId(entry) === String(next.preferredLocalModel || '').trim()) || null
          : null;
        const selectedModelInstalled = Boolean(
          next.preferredLocalModel && localModelIds.includes(next.preferredLocalModel)
        );
        state.offlineState = {
          ...next,
          selectedLocalModelInstalled: selectedModelInstalled,
          localChatReady:
            next.mode === 'local_only'
            && next.managedSidecar?.ready === true
            && selectedModelInstalled,
          localVisionReady:
            next.mode === 'local_only'
            && next.managedSidecar?.ready === true
            && selectedModelInstalled
            && (
              selectedModelEntry?.capabilities?.vision === true
              || String(next.preferredLocalModel || '').toLowerCase().includes('llava')
            ),
          unavailableReason: selectedModelInstalled
            ? ''
            : 'Select a local inference model in Model Library.',
          summary:
            next.mode === 'local_only'
              ? (selectedModelInstalled
                ? `Cloud inference is disabled for chat. Jenny will use ${next.preferredLocalModel}.`
                : 'Select a local inference model in Model Library.')
              : (selectedModelInstalled
                ? `Local chat is ready with ${next.preferredLocalModel}.`
                : 'Choose a local model to prepare fully local chat.'),
        };
        return state.offlineState;
      },
    },
    chat: {
      async startStream(payload) {
        state.chatCalls.push(payload);
        if (typeof chatOptions.startStream === 'function') {
          return chatOptions.startStream(payload, { state, emitChat: context.emitChat });
        }
        const sessionId = payload.sessionId || `session-${state.sessionCounter++}`;
        if (!state.sessions.find((session) => session.id === sessionId)) {
          state.sessions = [{
            id: sessionId,
            title: 'New Chat',
            conversation_mode: 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            context_preferences: {
              history_scope: payload?.contextPreferences?.historyScope || 'session',
              include_personality: payload?.contextPreferences?.includePersonality !== false,
              include_memory: payload?.contextPreferences?.includeMemory !== false,
            },
            linked_session_ids: [],
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
        }
        state.messagesBySession.set(sessionId, []);
        activateWorkspaceSessionState(state, sessionId);
        return { sessionId, streamId: 'stream-test-1' };
      },
      async editAndRegenerate(payload) {
        state.chatCalls.push(payload);
        if (typeof chatOptions.editAndRegenerate === 'function') {
          return chatOptions.editAndRegenerate(payload, { state, emitChat: context.emitChat });
        }
        const sessionId = String(payload?.sessionId || '').trim();
        const editedMessageId = String(payload?.editedMessageId || '').trim();
        const messages = state.messagesBySession.get(sessionId) || [];
        const anchorIndex = messages.findIndex((message) =>
          String(message?.id || '').trim() === editedMessageId
            && String(message?.role || '').trim() === 'user');
        if (!sessionId || anchorIndex < 0) throw new Error('Invalid edit-and-regenerate anchor.');
        state.messagesBySession.set(sessionId, messages.slice(0, anchorIndex + 1));
        return { sessionId, streamId: `stream-edit-${state.chatCalls.length}`,
          identity: { userMessageId: editedMessageId } };
      },
      async getActiveTurnState(sessionId) {
        if (typeof chatOptions.getActiveTurnState === 'function') {
          return chatOptions.getActiveTurnState(sessionId, { state, emitChat: context.emitChat });
        }
        return null;
      },
      async cancelStream(streamId) {
        state.cancelCalls.push(streamId);
        if (typeof chatOptions.cancelStream === 'function') {
          return chatOptions.cancelStream(streamId, { state, emitChat: context.emitChat });
        }
        return { ok: true };
      },
      async compactNow(sessionId) {
        state.compactNowCalls = state.compactNowCalls || [];
        state.compactNowCalls.push(sessionId);
        if (typeof chatOptions.compactNow === 'function') {
          return chatOptions.compactNow(sessionId, { state });
        }
        return { status: 'ok', compacted: true, strategy: 'full', tokens_before: 4000, tokens_after: 1200 };
      },
      onStream(listener) {
        return addListener('chat', listener);
      },
    },
    compaction: createCompactionStub({ options, state }),
    attachments: {
      async pick() {
        if (typeof options.attachments?.pick === 'function') {
          return options.attachments.pick({ state });
        }
        return { accepted: [], rejected: [] };
      },
      async prepare(filePaths) {
        if (typeof options.attachments?.prepare === 'function') {
          return options.attachments.prepare(filePaths, { state });
        }
        return { accepted: [], rejected: [] };
      },
      async saveImageAsset(payload) {
        state.attachmentSaveCalls.push(payload);
        if (typeof options.attachments?.saveImageAsset === 'function') {
          return options.attachments.saveImageAsset(payload, { state });
        }
        return {
          id: `image-${state.attachmentSaveCalls.length}`,
          kind: 'image',
          displayName: payload?.displayName || 'Image.png',
          mimeType: payload?.mimeType || 'image/png',
          sizeBytes: payload?.bytes?.length || 0,
          width: 320,
          height: 200,
          assetPath: `C:/attachments/image-${state.attachmentSaveCalls.length}.png`,
          sourceKind: payload?.sourceKind || 'clipboard',
        };
      },
      async saveAudioAsset(payload) {
        state.attachmentSaveCalls.push(payload);
        if (typeof options.attachments?.saveAudioAsset === 'function') {
          return options.attachments.saveAudioAsset(payload, { state });
        }
        return {
          id: `audio-${state.attachmentSaveCalls.length}`,
          kind: 'audio',
          displayName: payload?.displayName || 'Voice Clip.webm',
          mimeType: payload?.mimeType || 'audio/webm',
          sizeBytes: payload?.bytes?.length || 0,
          durationMs: Number(payload?.durationMs || 0),
          assetPath: `C:/attachments/audio-${state.attachmentSaveCalls.length}.webm`,
          sourceKind: payload?.sourceKind || 'microphone',
          transcriptStatus: payload?.transcriptStatus || 'pending',
          transcriptText: payload?.transcriptText || '',
          transcriptLanguage: payload?.transcriptLanguage || '',
        };
      },
      async releaseAssets(assetPaths) {
        state.attachmentReleaseCalls.push(assetPaths);
        if (typeof options.attachments?.releaseAssets === 'function') {
          return options.attachments.releaseAssets(assetPaths, { state });
        }
        return { deletedCount: Array.isArray(assetPaths) ? assetPaths.length : 0, deletedPaths: assetPaths || [] };
      },
    },
    speech: {
      async getState() {
        if (typeof options.speech?.getState === 'function') {
          const payload = await options.speech.getState({ state, emitSpeechState });
          if (payload && typeof payload === 'object') {
            await emitSpeechState(payload);
          }
        }
        return state.speechState;
      },
      async updateSettings(patch) {
        state.speechUpdateCalls.push(patch);
        if (typeof options.speech?.updateSettings === 'function') {
          const payload = await options.speech.updateSettings(patch, { state, emitSpeechState });
          if (payload && typeof payload === 'object') {
            await emitSpeechState(payload);
          }
          return state.speechState;
        }
        await emitSpeechState({
          ...patch,
          detail: state.speechState.featureEnabled
            ? 'Local speech is ready for turn-based transcription.'
            : 'Local speech is disabled.',
        });
        return state.speechState;
      },
      async transcribeDraft(payload) {
        state.speechTranscribeCalls.push(payload);
        if (typeof options.speech?.transcribeDraft === 'function') {
          return options.speech.transcribeDraft(payload, { state, emitSpeechState });
        }
        return {
          requestId: payload?.requestId || `speech-${state.speechTranscribeCalls.length}`,
          text: 'Transcribed voice draft',
          language: 'en',
          durationMs: Number(payload?.durationMs || 0),
          provider: state.speechState.sttProvider,
          model: state.speechState.sttModel,
        };
      },
      async cancel(requestId) {
        state.speechCancelCalls.push(requestId);
        if (typeof options.speech?.cancel === 'function') {
          return options.speech.cancel(requestId, { state, emitSpeechState });
        }
        await emitSpeechState({
          requestInFlight: false,
          activeRequestId: '',
        });
        return { cancelled: true, requestId: String(requestId || '').trim() };
      },
      onState(listener) {
        return addListener('speech', listener);
      },
    },
    clipboard: {
      async writeText() {
        return { ok: true };
      },
    },
    // Carved into a sibling at the 1015-line cap; overrides via options.tools.
    tools: require('./renderer-shell-harness-services-tools')
      .createToolsServiceStub({ options, state }),
    window: {
      async getState() { return { ok: true, maximized: false, minimized: false }; },
      onStateChanged() { return () => {}; },
    },
    async windowControl() { return { ok: true, maximized: false, minimized: false }; },
    models: {
      async list() {
        if (typeof modelOptions.list === 'function') {
          return modelOptions.list({ state });
        }
        return {
          object: 'list',
          active_model: '',
          available: true,
          reason: '',
          data: [{ id: 'gpt-test', name: 'GPT Test', loaded: true }],
        };
      },
      async load(model) {
        if (typeof modelOptions.load === 'function') {
          return modelOptions.load(model, { state });
        }
        return { ok: true };
      },
      async unload() {
        if (typeof modelOptions.unload === 'function') {
          return modelOptions.unload({ state });
        }
        return { ok: true };
      },
    },
  };
}

module.exports = {
  activateWorkspaceSessionState,
  createShellStubServices,
};
