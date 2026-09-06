const path = require('path');
const {
  loadRendererApp: loadRendererDomHarness,
  waitForUi,
} = require('./renderer-shell-harness-dom');
const {
  createBackendStub,
  createDefaultBackendStatus,
  emitBackendStatus: emitBackendStatusUpdate,
} = require('./renderer-shell-harness-backend');
const {
  createDefaultCompanionState,
  syncFollowUpOpenLoops,
} = require('./renderer-shell-harness-companion');
const { createDefaultSkillsState, createDefaultTipsState, emitGuidanceState } = require('./renderer-shell-harness-guidance');
const {
  initializeWorkspaceRootHarnessState,
} = require('./renderer-shell-harness-workspace-root');
const {
  activateWorkspaceSessionState,
  createShellStubServices,
} = require('./renderer-shell-harness-services');
const ROOT = path.resolve(__dirname, '..', '..');

function createShellStub(options = {}) {
  const listeners = { auth: [], backend: [], chat: [], logs: [], proactive: [], skills: [], tips: [], system: [], features: [], speech: [], updates: [], planUsage: [] };
  const state = {
    authState: { authenticated: true, user: { email: 'local@jenny.local', display_name: 'Local User' } },
    sessions: [],
    messagesBySession: new Map(),
    chatCalls: [],
    cancelCalls: [],
    setPreferenceCalls: [],
    renameCalls: [],
    setMetaCalls: [],
    sweepCalls: [],
    workspaceState: { activeSessionId: '', openSessionIds: [] },
    chatUiState: {
      zoomPercent: Number(options.chatUi?.state?.zoomPercent || 100),
    },
    windowUiState: {
      appZoomPercent: Number(options.windowUi?.state?.appZoomPercent || 100),
    },
    workspaceUpdateCalls: [],
    phasePercentilesPayload: options.phasePercentilesPayload || null,
    phasePercentiles: { payload: null, loading: false, error: '', loadedAt: 0, revision: 0 },
    phasePercentilesResetCalls: 0,
    attachmentSaveCalls: [],
    attachmentReleaseCalls: [],
    speechTranscribeCalls: [],
    speechCancelCalls: [],
    speechUpdateCalls: [],
    offlineUpdateCalls: [],
    updatesGetStateCalls: 0,
    updatesCheckCalls: 0,
    updatesState: {
      status: 'idle',
      reason: '',
      currentVersion: String(options.updates?.state?.currentVersion || '0.0.0-test'),
      latestVersion: '',
      releaseNotesMarkdown: '',
      downloadProgress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
    },
    featuresState: {
      tools: {
        web: false,
        mermaid: false,
        imageRead: false,
        pythonRuntime: false,
        todo: false,
      },
      memory: {
        captureSuggestions: true,
      },
      featureFlags: {
        token_budget: true,
        context_compaction: true,
        api_retry: true,
        prompt_cache: true,
        tool_search: true,
        skills_system: true,
        local_speech: true,
        shell_security: true,
        git_tracking: true,
        pretext_layout: false,
        // Mirrors production: artifact_panel_v2 is DEFAULT-ON
        // (services/feature-flags.js). The renderer boot seed omits it, so the
        // real feature payload delivers it; the shell artifact bridge only
        // trusts the V2-vs-legacy decision once this key is present in state.
        artifact_panel_v2: true,
        artifact_panel_v3: true,
      },
      featureOverrides: {},
      availability: {
        runtime: {
          managedSidecarActive: true,
          windowsOnly: true,
          workspaceRootStatus: {
            state: 'missing',
            message: 'No workspace root is configured yet.',
          },
        },
        tools: {
          web: { enabled: true, managedSidecarRequired: true },
          mermaid: { enabled: true, managedSidecarRequired: true },
          imageRead: { enabled: true, managedSidecarRequired: true },
          pythonRuntime: { enabled: true, managedSidecarRequired: true, windowsOnly: true },
          todo: { enabled: false, managedSidecarRequired: true, workspaceRootRequired: true },
          glob_files: { enabled: false, managedSidecarRequired: true, workspaceRootRequired: true },
          grep_search: { enabled: false, managedSidecarRequired: true, workspaceRootRequired: true },
          edit_file: { enabled: false, managedSidecarRequired: true, workspaceRootRequired: true },
          shell: { enabled: false, managedSidecarRequired: true, workspaceRootRequired: true },
          background_shell: { enabled: false, managedSidecarRequired: true, workspaceRootRequired: true },
          checkpoint_backups: { enabled: false, electronOnly: true, workspaceRootRequired: true },
        },
        featureFlags: {},
      },
    },
    companionCalls: {
      addFollowUp: [],
      updateFollowUp: [],
      deferFollowUp: [],
      activateFollowUp: [],
      resolveFollowUp: [],
      archiveFollowUp: [],
      unarchiveFollowUp: [],
      deleteFollowUp: [],
    },
    sessionCounter: 1,
    backendStatus: createDefaultBackendStatus(),
    setupState: options.setup?.state || {
      setup_complete: true,
      setup_state: {
        seen: true,
        dismissed: true,
        setup_complete: true,
        completed_at: '2026-05-07T12:00:00.000Z',
        updated_at: '2026-05-07T12:00:00.000Z',
        steps: {
          workspace_root: 'done',
          local_model: 'done',
          endpoint: 'done',
          personality: 'done',
          skills: 'done',
        },
        tools_workspace_root_configured: true,
        mcp_tools_discovered: false,
        assistant_identity: { agentName: 'Jenny', profile: 'balanced', customText: '', updatedAt: '' },
      },
    },
    setupResetCalls: 0,
    setupFactoryResetCalls: 0,
    setupUpdateStateCalls: [],
    offlineState: null,
    logEntries: [],
    rendererErrors: [],
    proactiveState: null,
    workspaceRootState: null,
    skillsState: options.skills?.state || createDefaultSkillsState(),
    mcpDiscoveryState: options.mcpDiscovery?.state || {
      configPath: 'C:/Users/dev/AppData/Roaming/jenny/mcp-servers.json',
      servers: [],
    },
    mcpDiscoveryRefreshCalls: 0,
    mcpDiscoveryOperationCalls: [],
    tipsState: createDefaultTipsState(),
    harnessSnapshot: null,
    lifecycleReadySignals: 0,
    speechState: {
      featureEnabled: true,
      backendReady: true,
      requestInFlight: false,
      activeRequestId: '',
      inputMode: 'push_to_talk',
      sttProvider: 'faster_whisper',
      sttModel: 'small',
      inputDeviceId: '',
      ttsProvider: 'piper',
      ttsExecutablePath: '',
      ttsVoice: '',
      keepSourceAudio: true,
      autoPlayReplies: false,
      liveModeEnabled: false,
      readiness: { stt: true, tts: false, live: false },
      health: { stt: 'ready', tts: 'planned', live: 'planned' },
      detail: 'Local speech is ready for turn-based transcription.',
      lastError: '',
      updatedAt: new Date().toISOString(),
    },
  };
  const defaultOfflineState = {
    mode: 'disabled',
    preferredLocalModel: '',
    localCatalog: {
      available: true,
      reason: '',
      models: ['qwen3.5:9b', 'llava:7b'],
    },
    managedSidecar: {
      mode: 'managed-dev',
      phase: 'ready',
      ready: true,
    },
    currentEngine: 'mock',
    currentModel: '',
    engineFallback: null,
    selectedLocalModelInstalled: false,
    localChatReady: false,
    localVisionReady: false,
    unavailableReason: 'Select a local inference model in Model Library.',
    visionUnavailableReason: 'Offline local chat must be ready before image analysis can run locally.',
    summary: 'Choose a local model to prepare fully local chat.',
  };
  state.offlineState = JSON.parse(JSON.stringify(options.offline?.state || defaultOfflineState));
  state.featuresState = {
    ...state.featuresState,
    ...(options.features?.state || {}),
    tools: {
      ...state.featuresState.tools,
      ...(options.features?.state?.tools || {}),
    },
    memory: {
      ...state.featuresState.memory,
      ...(options.features?.state?.memory || {}),
    },
    featureFlags: {
      ...state.featuresState.featureFlags,
      ...(options.features?.state?.featureFlags || {}),
    },
    featureOverrides: {
      ...state.featuresState.featureOverrides,
      ...(options.features?.state?.featureOverrides || {}),
    },
  };
  state.companionState = syncFollowUpOpenLoops(
    JSON.parse(JSON.stringify(options.companion?.state || createDefaultCompanionState()))
  );
  state.speechState = {
    ...state.speechState,
    ...(options.speech?.state || {}),
    readiness: {
      ...state.speechState.readiness,
      ...(options.speech?.state?.readiness || {}),
    },
    health: {
      ...state.speechState.health,
      ...(options.speech?.state?.health || {}),
    },
  };
  initializeWorkspaceRootHarnessState(options, state);
  async function emitChat(payload) { await Promise.all(listeners.chat.map((listener) => listener(payload))); }
  async function emitBackendStatus(payload) {
    await emitBackendStatusUpdate(listeners, state, payload);
  }
  async function emitTipsChanged(payload) {
    await emitGuidanceState(listeners, 'tips', state, 'tipsState', payload);
  }
  async function emitSkillsChanged(payload) {
    await emitGuidanceState(listeners, 'skills', state, 'skillsState', payload);
  }
  async function emitAuthState(payload) {
    const nextAuthState = payload && typeof payload === 'object'
      ? {
          authenticated: payload.authenticated === true,
          user:
            payload.user && typeof payload.user === 'object' && !Array.isArray(payload.user)
              ? payload.user
              : null,
        }
      : { authenticated: false, user: null };
    state.authState = nextAuthState;
    await Promise.all(listeners.auth.map((listener) => listener(nextAuthState)));
  }
  async function emitFeaturesChanged(payload) {
    const nextFeaturesState = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? {
          ...state.featuresState,
          ...payload,
          tools: {
            ...state.featuresState.tools,
            ...(payload.tools || {}),
          },
          memory: {
            ...state.featuresState.memory,
            ...(payload.memory || {}),
          },
          featureFlags: {
            ...state.featuresState.featureFlags,
            ...(payload.featureFlags || {}),
          },
          featureOverrides: {
            ...state.featuresState.featureOverrides,
            ...(payload.featureOverrides || {}),
          },
        }
      : state.featuresState;
    state.featuresState = nextFeaturesState;
    await Promise.all(listeners.features.map((listener) => listener(nextFeaturesState)));
  }
  async function emitSpeechState(payload) {
    const nextSpeechState = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? {
          ...state.speechState,
          ...payload,
          readiness: {
            ...state.speechState.readiness,
            ...(payload.readiness || {}),
          },
          health: {
            ...state.speechState.health,
            ...(payload.health || {}),
          },
          updatedAt: payload.updatedAt || new Date().toISOString(),
        }
      : state.speechState;
    state.speechState = nextSpeechState;
    await Promise.all(listeners.speech.map((listener) => listener(nextSpeechState)));
  }
  async function emitLogAppend(payload) {
    const entry = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...payload }
      : {};
    state.logEntries = Array.isArray(state.logEntries) ? state.logEntries : [];
    state.logEntries.push(entry);
    await Promise.all(listeners.logs.map((listener) => listener(entry)));
  }
  async function emitUpdatesChanged(payload) {
    if (payload && typeof payload === 'object') {
      state.updatesState = { ...state.updatesState, ...payload };
    }
    await Promise.all(listeners.updates.map((listener) => listener({ ...state.updatesState })));
  }
  function addListener(bucket, listener) {
    const targetBucket = listeners[bucket];
    if (!Array.isArray(targetBucket) || typeof listener !== 'function') {
      return () => {};
    }
    targetBucket.push(listener);
    return () => {
      const index = targetBucket.indexOf(listener);
      if (index !== -1) {
        targetBucket.splice(index, 1);
      }
    };
  }
  return {
    __options: options,
    __state: state,
    __emitChat: emitChat,
    __emitBackendStatus: emitBackendStatus,
    __emitPlanUsage: async (payload) => { await Promise.all(listeners.planUsage.map((listener) => listener(payload))); },
    __emitAuthState: emitAuthState,
    __emitFeaturesChanged: emitFeaturesChanged,
    __emitLogAppend: emitLogAppend,
    __emitSkillsChanged: emitSkillsChanged,
    __emitTipsChanged: emitTipsChanged,
    __emitSpeechState: emitSpeechState,
    __emitUpdatesState: emitUpdatesChanged,
    __getListenerCounts() {
      return { auth: listeners.auth.length, backend: listeners.backend.length, chat: listeners.chat.length, logs: listeners.logs.length, proactive: listeners.proactive.length, skills: listeners.skills.length, tips: listeners.tips.length, system: listeners.system.length, features: listeners.features.length, speech: listeners.speech.length, planUsage: listeners.planUsage.length };
    },
    backend: createBackendStub(options, state, listeners, addListener),
    auth: {
      async getState() {
        return state.authState;
      },
      async login() {
        state.authState = { authenticated: true, user: { email: 'dev@example.com' } };
        return state.authState;
      },
      async register() {
        state.authState = { authenticated: true, user: { email: 'dev@example.com' } };
        return state.authState;
      },
      async logout() {
        state.authState = { authenticated: false, user: null };
        return state.authState;
      },
      async updateLocalProfile(payload) {
        const displayName = String(payload?.displayName || '').trim();
        if (!displayName) throw new Error('Profile name is required.');
        state.authState = {
          authenticated: true,
          user: { email: 'local@jenny.local', display_name: displayName },
        };
        return state.authState;
      },
      onState(listener) {
        return addListener('auth', listener);
      },
    },
    lifecycle: {
      signalReady() {
        state.lifecycleReadySignals += 1;
        if (typeof options.lifecycle?.signalReady === 'function') {
          return options.lifecycle.signalReady({ state });
        }
        return undefined;
      },
      onProgress() {
        return () => {};
      },
    },
    sessions: {
      async list() {
        return { data: state.sessions.slice() };
      },
      async create(payload) {
        const id = `session-${state.sessionCounter++}`;
        const summary = {
          id,
          title: payload?.title || 'New Chat',
          conversation_mode: payload?.preferences?.conversation_mode || 'chat',
          preferred_model: payload?.preferences?.preferred_model || 'gpt-test',
          reasoning_effort: payload?.preferences?.reasoning_effort || 'default',
          context_preferences: {
            history_scope: payload?.preferences?.context_preferences?.history_scope || 'session',
            include_personality: payload?.preferences?.context_preferences?.include_personality !== false,
            include_memory: payload?.preferences?.context_preferences?.include_memory !== false,
          },
          interactive_round_count: 0,
          interactive_sequence_state: 'idle',
          pending_question_batch: null,
          linked_session_ids: [],
          updated_at: new Date().toISOString(),
        };
        state.sessions = [summary];
        state.messagesBySession.set(id, []);
        activateWorkspaceSessionState(state, id);
        return { data: summary };
      },
      async rename(sessionId, title) {
        state.renameCalls.push({ sessionId, title });
        const session = state.sessions.find((entry) => entry.id === sessionId);
        if (session) {
          session.title = title;
        }
        return { ok: true };
      },
      async setMeta(sessionId, meta) {
        state.setMetaCalls.push({ sessionId, meta });
        const session = state.sessions.find((entry) => entry.id === sessionId);
        if (!session) {
          return null;
        }
        if (Object.prototype.hasOwnProperty.call(meta || {}, 'pinned')) {
          session.pinned = meta.pinned === true;
        }
        if (Object.prototype.hasOwnProperty.call(meta || {}, 'archived_at')) {
          session.archived_at = meta.archived_at ? String(meta.archived_at) : null;
        }
        // Mirrors the store: a non-empty title is clipped and written without
        // bumping updated_at (renderer auto-title/backfill path).
        const nextTitle = String(meta?.title || '').replace(/\s+/g, ' ').trim();
        if (nextTitle) {
          session.title = nextTitle.length > 80 ? `${nextTitle.slice(0, 77).trim()}...` : nextTitle;
        }
        return { ...session };
      },
      async delete(sessionId) {
        state.sessions = state.sessions.filter((session) => session.id !== sessionId);
        state.messagesBySession.delete(sessionId);
        return { ok: true };
      },
      // Mirrors sweepEmptySessions in electron-session-store.js: skip the
      // current session, pinned sessions, sessions with messages, and
      // custom-titled sessions; dry runs only size the batch.
      async sweepEmpty(options = {}) {
        const dryRun = options?.dryRun === true;
        const currentSessionId = options?.currentSessionId || null;
        state.sweepCalls.push({ dryRun, currentSessionId });
        const candidateIds = [];
        for (const session of state.sessions) {
          if (session.id === currentSessionId) continue;
          if (session.pinned === true) continue;
          if (Number(session.message_count || 0) > 0) continue;
          const title = String(session.title || '').trim();
          if (title && title !== 'New Chat') continue;
          candidateIds.push(session.id);
        }
        if (dryRun) {
          return { candidateIds, deleted: 0 };
        }
        state.sessions = state.sessions.filter((session) => !candidateIds.includes(session.id));
        for (const sessionId of candidateIds) {
          state.messagesBySession.delete(sessionId);
        }
        return { candidateIds, deleted: candidateIds.length };
      },
      async getMessages(sessionId) {
        return { data: state.messagesBySession.get(sessionId) || [] };
      },
      async setPreferences(sessionId, preferences) {
        state.setPreferenceCalls.push({ sessionId, preferences });
        const session = state.sessions.find((entry) => entry.id === sessionId);
        if (!session) {
          return { ok: true };
        }
        Object.assign(session, {
          preferred_model: Object.prototype.hasOwnProperty.call(preferences || {}, 'preferred_model')
            ? preferences.preferred_model
            : session.preferred_model,
          reasoning_effort: Object.prototype.hasOwnProperty.call(preferences || {}, 'reasoning_effort')
            ? preferences.reasoning_effort
            : session.reasoning_effort,
          conversation_mode: Object.prototype.hasOwnProperty.call(preferences || {}, 'conversation_mode')
            ? preferences.conversation_mode
            : session.conversation_mode,
          plan_mode: Object.prototype.hasOwnProperty.call(preferences || {}, 'plan_mode')
            ? preferences.plan_mode
            : session.plan_mode,
          context_preferences: Object.prototype.hasOwnProperty.call(preferences || {}, 'context_preferences')
            ? {
                history_scope: preferences.context_preferences?.history_scope || 'session',
                include_personality: preferences.context_preferences?.include_personality !== false,
                include_memory: preferences.context_preferences?.include_memory !== false,
              }
            : session.context_preferences,
          pending_question_batch: Object.prototype.hasOwnProperty.call(preferences || {}, 'pending_question_batch')
            ? preferences.pending_question_batch
            : session.pending_question_batch,
          interactive_sequence_state: Object.prototype.hasOwnProperty.call(preferences || {}, 'interactive_sequence_state')
            ? preferences.interactive_sequence_state
            : session.interactive_sequence_state,
          interactive_round_count: Object.prototype.hasOwnProperty.call(preferences || {}, 'interactive_round_count')
            ? preferences.interactive_round_count
            : session.interactive_round_count,
          linked_session_ids: Object.prototype.hasOwnProperty.call(preferences || {}, 'linked_session_ids')
            ? (Array.isArray(preferences.linked_session_ids) ? preferences.linked_session_ids.slice() : [])
            : session.linked_session_ids,
          tool_category_overrides: Object.prototype.hasOwnProperty.call(preferences || {}, 'tool_category_overrides')
            ? { ...(preferences.tool_category_overrides || {}) }
            : session.tool_category_overrides,
        });
        return session;
      },
      async updateMessage() {
        return { ok: true };
      },
    },
    ...createShellStubServices({
      options,
      state,
      addListener,
      emitChat,
      emitBackendStatus,
      emitSpeechState,
      emitUpdatesChanged,
    }),
  };
}

module.exports = {
  loadRendererApp(options = {}) {
    return loadRendererDomHarness({
      options,
      root: ROOT,
      createShellStub,
    });
  },
  waitForUi,
};
