/* renderer/shell/renderer-bootstrap-utils.js - Renderer bootstrap constants, state, and DOM lookup helpers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-support'));
    return;
  }
  root.rendererBootstrapUtils = factory(root.rendererSettingsSupport);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (settingsSupport) {
  const MAX_CACHED_SESSION_MESSAGE_SETS = 6;
  const globalRoot = typeof globalThis !== 'undefined' ? globalThis : null;
  const bootstrapDom = globalRoot?.rendererBootstrapDom
    || (typeof require === 'function' ? require('./renderer-bootstrap-dom') : null);
  const createLazyDomResolver = bootstrapDom?.createLazyDomResolver
    || function missingLazyDomResolver() { return function emptyDomResolver() { return {}; }; };
  const createRendererDomRegistry = bootstrapDom?.createRendererDomRegistry
    || function missingRendererDomRegistry() { return {}; };
  const createRendererSurfaceDom = bootstrapDom?.createRendererSurfaceDom
    || function missingRendererSurfaceDom() { return { status: {}, settings: {}, chat: {} }; };
  const settingsNavUtils = globalRoot?.rendererSettingsNavUtils
    || (typeof require === 'function' ? require('./renderer-settings-nav-utils') : null);
  const inventoryActionButton = globalRoot?.inventoryActionButton
    || (typeof require === 'function' ? require('../inventory/action-button') : null);
  const inventorySelectField = globalRoot?.inventorySelectField
    || (typeof require === 'function' ? require('../inventory/select-field') : null);
  const inventoryTextField = globalRoot?.inventoryTextField
    || (typeof require === 'function' ? require('../inventory/text-field') : null);

  const normalizeRunMode = settingsSupport.normalizeRunMode;

  function renderDiagnosticsControls(documentRef) {
    const put = (id, markup) => { const host = documentRef.getElementById(id); if (host && !host.firstElementChild) host.innerHTML = markup; };
    if (typeof inventorySelectField === 'function') {
      put('diagnosticsRunControl', inventorySelectField({ id: 'diagnosticsRunSelect', label: 'Evidence window', ariaLabel: 'Diagnostic run', options: [{ value: '', label: 'Current run' }] }));
      put('diagnosticsLevelControl', inventorySelectField({ id: 'logLevelFilter', label: 'Severity', options: ['all', 'error', 'warn', 'info', 'debug'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })) }));
      put('diagnosticsSourceControl', inventorySelectField({ id: 'logSourceFilter', label: 'Source', options: ['all', 'electron', 'renderer', 'sidecar'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })) }));
    }
    if (typeof inventoryTextField === 'function') put('diagnosticsSearchControl', inventoryTextField({ id: 'logSearchInput', ariaLabel: 'Search activity', placeholder: 'Search events, messages, or IDs…', className: 'logs-search-shell' }));
    if (typeof inventoryActionButton === 'function') {
      put('diagnosticsCopyControl', inventoryActionButton({ id: 'copy-diagnostic-report', domId: 'copyLogsReportButton', label: 'Copy diagnostic report', className: 'page-button' }));
      put('diagnosticsResetControl', inventoryActionButton({ id: 'reset-phase-percentiles', domId: 'phasePercentilesResetButton', label: 'Reset samples', variant: 'ghost', size: 'sm' }));
      put('diagnosticsRefreshControl', inventoryActionButton({ id: 'refresh-diagnostics', domId: 'observabilityRefreshButton', label: 'Refresh', variant: 'ghost', size: 'sm' }));
      put('diagnosticsFollowControl', inventoryActionButton({ id: 'follow-latest', domId: 'logAutoScrollToggle', label: 'Follow latest', variant: 'ghost', size: 'sm', ariaPressed: true }));
      put('contextPersonalityLinkHost', inventoryActionButton({ id: 'open-personality-page', label: 'Open Personality', variant: 'secondary' }));
      put('contextMemoryLinkHost', inventoryActionButton({ id: 'open-memory-page', label: 'Manage recalled memories', variant: 'secondary' }));
    }
  }

  function createRendererBootstrap(deps) {
    const {
      document,
      getDefaultAppearancePreferences,
      appearanceUtils,
    } = deps;

    const staticModel = {
      tabs: [
        { id: 'home', label: 'Home' },
        { id: 'chat', label: 'Chat' },
        { id: 'ide', label: 'Workspace' },
        { id: 'logs', label: 'Diagnostics' },
        { id: 'settings', label: 'Settings' },
      ],
      suggestions: ['Tell me something interesting', 'Help me brainstorm ideas', 'Explain a topic in depth'],
    };
    const ACTIVITY_SCOPE = {
      backendFailed: 'backend.failed', backendRetrying: 'backend.retrying', backendStarting: 'backend.starting',
      composerRunMode: 'composer.runMode',
      composerPreferredModel: 'composer.preferredModel', composerReasoningEffort: 'composer.reasoningEffort',
      personalityReset: 'personality.reset', personalitySave: 'personality.save',
      personalityWorkspaceLoad: 'personality.workspaceLoad', settingsModelLoad: 'settings.modelLoad',
      settingsModelUnload: 'settings.modelUnload', settingsPreferredModel: 'settings.preferredModel',
      settingsReasoningEffort: 'settings.reasoningEffort', settingsWorkspaceToggle: 'settings.workspaceToggle',
      settingsContextPreferences: 'settings.contextPreferences',
    };
    const TOAST_SOURCE = {
      sessionAction: 'shell.session-action', composerAction: 'shell.composer-action',
      shellAction: 'shell.action',
      attachments: 'shell.attachments', chatStream: 'shell.chat-stream',
      logs: 'shell.logs', memory: 'shell.memory', settings: 'shell.settings',
      backend: 'shell.backend',
    };
    const state = {
      authMode: 'login',
      auth: { authenticated: false, user: null },
      backend: { phase: 'starting', detail: 'Connecting to backend...' },
      sessions: [],
      currentSessionId: '',
      workspace: { activeSessionId: '', openSessionIds: [] },
      workspaceRoot: {
        path: '',
        status: {
          state: 'missing',
          message: 'No workspace root is configured yet.',
        },
      },
      messagesBySession: new Map(),
      sessionMessageAccessOrder: new Map(),
      bufferedStreamEventsByStream: new Map(),
      degradedBufferedStreamsByStream: new Map(),
      pendingStreams: new Map(),
      streamThinkingStatusByStream: new Map(),
      activeStreamId: '',
      activeStreamSessionId: '',
      sendPreflight: null,
      pendingToolApprovals: new Map(),
      toolCallsByStream: new Map(),
      queuedSendBySession: new Map(),
      turnClockBySession: new Map(),
      sendOutboxBySession: new Map(),
      status: null,
      modelList: null,
      lifecycleProgress: {
        active: false,
        scenario: '',
        phase: '',
        detail: '',
        stepIndex: 0,
        stepCount: 0,
        percent: 0,
        startedAt: 0,
        error: '',
      },
      runtimeDraft: {
        preferredModel: '',
        reasoningEffort: 'default',
        runMode: 'ask',
        // New-chat defaults come from the config defaultRunMode (hydrated
        // below); the Wave-G sticky localStorage key is retired. planMode
        // remains only as the legacy projection fallback.
        planMode: false,
        contextPreferences: {
          historyScope: 'session',
          includePersonality: true,
          includeMemory: true,
        },
      },
      // Personality v3: one draft object, one dirty flag, one Save.
      personality: {
        agentName: 'Jenny', personality: '', user: '',
        saved: { agentName: 'Jenny', personality: '', user: '' },
        notesBody: '', dirty: false, loading: false, saving: false, savedAt: 0,
        actionStatus: '', loadStatus: '', schemaVersion: 0,
        budgets: { personality: 1500, user: 1000, memory: 1500 },
        compiled: { text: '', chars: 0, tokensEstimate: 0, sections: [] },
      },
      memoryContextFiles: {
        body: '', savedBody: '', dirty: false, loading: false, saving: false, savedAt: 0,
        budget: 1500, actionStatus: '', loadStatus: '',
      },
      memoryManager: {
        memories: [], loading: false, loaded: false, unavailable: false,
        pendingCandidates: [],
        pendingLoading: false,
        pendingLoaded: false,
        pendingUnavailable: false,
        pendingStatus: 'Open Memory while signed in to load the review queue.',
        pendingFilter: 'all',
        pendingSort: 'newest',
        pendingFocusKey: '',
        pendingFocusAppliedKey: '',
        status: 'Open Memory while signed in to load approved memories.',
        statusSnapshot: null,
        statusLoading: false,
        statusLoaded: false,
        statusUnavailable: false,
        filter: 'all',
        searchQuery: '',
        editingMemoryId: null,
        draftsById: new Map(),
        pendingActionById: new Map(),
        pendingReviewActionByKey: new Map(),
        approvedVisibleLimit: 200,
        pendingVisibleLimit: 200,
      },
      proactive: {
        loaded: false,
        workspaceRoot: '',
        workspaceRootStatus: {
          state: 'missing',
          message: 'Workspace-dependent proactive behaviors are blocked until a workspace root is configured.',
        },
        reminders: [],
      },
      skills: {
        loaded: false,
        featureEnabled: false,
        settings: {
          bundledEnabled: true,
          userEnabled: true,
          projectEnabled: true,
        },
        scopes: [],
        counts: {
          total: 0,
          always: 0,
        },
      },
      tips: {
        loaded: false,
        featureEnabled: false,
        settings: {
          enabled: true,
          sessionCount: 0,
          historyByTipId: {},
        },
        relevantTips: [],
        activeTip: null,
      },
      features: {
        loaded: false,
        // Tier C #12: this seed stays deliberately optimistic-permissive
        // (managedSidecarActive: true, empty tools/featureFlags below) so
        // controls remain usable before the real payload lands — do not
        // tighten it. availabilityResolved is display-only: it tells status
        // chips (renderer-status-chip-utils.js) whether availability below
        // reflects a real backend answer yet, without touching gating.
        // Flipped true in applyFeatureStatePayload (renderer-shell-state-
        // runtime-utils.js) once a real payload has been merged in.
        availabilityResolved: false,
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
          skills_system: true,
          shell_security: true,
          git_tracking: true,
          settings_search: true,
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
          tools: {},
          featureFlags: {},
        },
      },
      companion: {
        loaded: false,
        mode: 'planner',
        modeMeta: {
          key: 'planner',
          label: 'Planner',
          description: '',
          homePrompt: '',
          secondaryPrompts: [],
        },
        briefing: {
          dateKey: '',
          dateLabel: '',
          timeZone: '',
          items: [],
        },
        todayCards: [],
        reminders: [],
        openLoopsBoard: {
          active: [],
          deferred: [],
          recentResolved: [],
          archived: [],
          counts: {
            active: 0,
            deferred: 0,
            recentResolved: 0,
            archived: 0,
          },
        },
        openLoops: [],
        deferredLoops: [],
        openLoopSummary: {
          activeCount: 0,
          deferredCount: 0,
        },
        availableDeferPresets: [],
        suggestedActions: [],
        workspaceSnapshot: {
          workspaceRoot: '',
          workspaceRootStatus: {
            state: 'missing',
            message: 'No workspace root is configured yet.',
          },
          activeSessionId: '',
          openSessionIds: [],
          sessionCount: 0,
        },
      },
      suggestions: { status: 'idle', items: [], requestId: 0 },
      offline: {
        // Least-invasive "first real payload landed" seam: normalizeOfflineState
        // (renderer-offline-utils.js) always returns resolved: true, and it is
        // only ever invoked from applyOfflinePayload — never for this seed — so
        // this literal false is the only place resolved starts false. Display-
        // only, same as features.availabilityResolved above.
        resolved: false,
        mode: 'disabled',
        preferredLocalModel: '',
        localCatalog: { available: false, reason: '', models: [] },
        managedSidecar: { mode: '', phase: 'stopped', ready: false },
        currentEngine: '',
        currentModel: '',
        engineFallback: null,
        selectedLocalModelInstalled: false,
        localChatReady: false,
        localVisionReady: false,
        unavailableReason: 'Managed sidecar is not ready yet.',
        visionUnavailableReason: 'Offline local chat must be ready before image analysis can run locally.',
        summary: 'Checking local offline readiness...',
      },
      artifacts: {
        filter: 'all',
        selectedArtifactId: '',
        selectedSessionId: '',
        loadedArtifactId: '',
        loadedArtifactContent: '',
        dirtyContent: '',
        loading: false,
        savePending: false,
        lastError: '',
        deletedArtifactIds: [],
        // UIUX-007: bumped by renderer-artifact-operation-target.js on every
        // selection change (and on controller disposal) so a stale
        // read/save/delete completion can detect it no longer targets the
        // live selection before mutating shared UI state.
        operationGeneration: 0,
      },
      attachments: { queued: [], notice: '', dragDepth: 0 },
      systemStats: {
        cpuPercent: 0,
        ramPercent: 0,
        battery: 'N/A',
        arch: '',
        gpuMemory: {
          available: false,
          usedMb: 0,
          totalMb: 0,
          gpuType: '',
          source: 'unavailable',
          sampledAt: '',
        },
      },
      logs: [],
      diagnosticsSnapshot: { entries: [] },
      diagnosticsStatus: {},
      interactiveDraftsBySession: new Map(),
      ui: {
        activeView: 'chat',
        activeSettingsSection: 'models',
        ide: {
          openTabs: [],
          activeTabPath: '',
          dirtyByPath: {},
          expandedDirs: new Set(),
          treeRootLoaded: false,
          railPanel: 'explorer',
          railSide: 'left',
          railWidth: 300,
          search: { query: '', results: [], busy: false },
          monaco: { ready: false, failed: false },
        },
        artifactReview: {
          enabled: false,
          collapsed: false,
          width: 420,
        },
        logs: {
          activeTab: 'overview',
          selectedRunId: '',
          levelFilter: 'all',
          query: '',
          sourceFilter: 'all',
          autoScroll: true,
          selectedEntryId: '',
          issueScope: null,
        },
        chatMode: 'empty',
        followLatest: true,
        animateNextChatActivation: false,
        composerPopoverOpen: false,
        commandPopoverOpen: false,
        contextOverheadTokens: 0,
        composerStatusNotice: '',
        composerStatusNoticeAt: 0,
        composerStatusNoticeOwner: '',
        composerStatusNoticeTone: 'default',
        composerStatusNoticeSpinner: false,
        composerStatusNoticeBadgeText: '',
        interactiveFocusRequest: null,
        interactiveRecapExpandedBySession: new Map(),
        reasoningPhaseExpansionBySession: new Map(),
        threadBranchesCollapsedBySession: new Map(),
        chatSendLifecycleBySession: new Map(),
        chatSendFailuresBySession: new Map(),
        chatTimelineRowModelBySession: new Map(),
        chatTimelineRowModelMetaBySession: new Map(),
        chatTimelineLiveStateBySession: new Map(),
        chatTimelineBatch4FastPathEnabled: false,
        appearance: getDefaultAppearancePreferences(),
        chatZoomPercent: 100,
        appZoomPercent: 100,
        osReducedMotion: false,
      },
    };

    Promise.resolve(globalRoot?.jennyShell?.chatUi?.getState?.()).then((config) => {
      const defaultRunMode = normalizeRunMode(config?.defaultRunMode);
      state.defaultRunMode = defaultRunMode;
      if (!state.currentSessionId) state.runtimeDraft.runMode = defaultRunMode;
    }).catch(() => {});

    // Generate the Settings nav rail from the section registry before resolving DOM ids.
    if (settingsNavUtils && typeof settingsNavUtils.renderSettingsNav === 'function') {
      settingsNavUtils.renderSettingsNav(document, {
        searchEnabled: state.features.featureFlags.settings_search !== false,
      });
    }
    renderDiagnosticsControls(document);
    const dom = createRendererDomRegistry(document);
    const getSettingsSectionDom = createLazyDomResolver(document, {
      skills: {
        skillsSettingsSection: 'skillsSettingsSection',
      },
      advanced: {
        advancedTuningStatus: 'advancedTuningStatus',
        advancedTuningProfileSwitch: 'advancedTuningProfileSwitch',
        advancedTuningFields: 'advancedTuningFields',
        advancedTuningActions: 'advancedTuningActions',
      },
      offline: {
        offlineBadge: 'offlineBadge',
        offlineSummary: 'offlineSummary',
        offlineStatus: 'offlineStatus',
        offlineLocalOnlyList: 'offlineLocalOnlyList',
        offlineModelStatus: 'offlineModelStatus',
        offlineModelActions: 'offlineModelActions',
      },
      personality: {
        personalityFormHost: 'personalityFormHost',
        personalityActions: 'personalityActions',
        personalityTokenLine: 'personalityTokenLine',
        personalityExactHost: 'personalityExactHost',
        personalityExactPanelHost: 'personalityExactPanelHost',
        personalityStatus: 'personalityStatus',
      },
      memories: {
        memoryNotesFieldHost: 'memoryNotesFieldHost',
        memoryNotesCounter: 'memoryNotesCounter',
        memoryNotesLint: 'memoryNotesLint',
        memoryNotesActions: 'memoryNotesActions',
        memoryContextStatus: 'memoryContextStatus',
      },
      usage: {
        usageBadge: 'usageBadge',
        usageScope: 'usageScope',
        usageStats: 'usageStats',
        usageByModel: 'usageByModel',
        usageRecentMeta: 'usageRecentMeta',
        usageRecentTurns: 'usageRecentTurns',
        usageMore: 'usageMore',
        usageRetentionSummary: 'usageRetentionSummary',
        usageRecordWarning: 'usageRecordWarning',
        usageActions: 'usageActions',
        usageActionStatus: 'usageActionStatus',
      },
    });
    const getHomeDom = createLazyDomResolver(document, {
      home: {
        homeOpenLoopCount: 'homeOpenLoopCount',
        homeOpenLoopStatus: 'homeOpenLoopStatus',
        homeOpenLoopList: 'homeOpenLoopList',
        homeDeferredSection: 'homeDeferredSection',
        homeDeferredLoopCount: 'homeDeferredLoopCount',
        homeDeferredLoopStatus: 'homeDeferredLoopStatus',
        homeDeferredLoopList: 'homeDeferredLoopList',
        homeRecentResolvedSection: 'homeRecentResolvedSection',
        homeRecentResolvedCount: 'homeRecentResolvedCount',
        homeRecentResolvedStatus: 'homeRecentResolvedStatus',
        homeRecentResolvedList: 'homeRecentResolvedList',
        homeArchivedSection: 'homeArchivedSection',
        homeArchivedLoopCount: 'homeArchivedLoopCount',
        homeArchivedLoopStatus: 'homeArchivedLoopStatus',
        homeArchivedLoopList: 'homeArchivedLoopList',
        homeArchivedLoopToggle: 'homeArchivedLoopToggle',
        homeOpenLoopAddButton: 'homeOpenLoopAddButton',
        homeOpenLoopForm: 'homeOpenLoopForm',
        homeOpenLoopFormHeading: 'homeOpenLoopFormHeading',
        homeOpenLoopFormNote: 'homeOpenLoopFormNote',
        homeOpenLoopTitleInput: 'homeOpenLoopTitleInput',
        homeOpenLoopNotesInput: 'homeOpenLoopNotesInput',
        homeOpenLoopDeferSelect: 'homeOpenLoopDeferSelect',
        homeOpenLoopSaveButton: 'homeOpenLoopSaveButton',
        homeOpenLoopCancelButton: 'homeOpenLoopCancelButton',
        homeInfoStrip: 'homeInfoStrip',
        homeDashboardGrid: 'homeDashboardGrid',
        homeDaybook: 'homeDaybook',
        homeDashboardRail: 'homeDashboardRail',
        homeRailResizer: 'homeRailResizer',
        homeRailGrip: 'homeRailGrip',
      },
    });
    // Artifact DOM resolver serves the split review panel only.
    const getArtifactDom = createLazyDomResolver(document, {
      artifacts: {
        artifactSplitViewToggle: 'artifactSplitViewToggle',
        artifactReviewResizer: 'artifactReviewResizer',
        artifactReviewPanel: 'artifactReviewPanel',
        artifactReviewStatus: 'artifactReviewStatus',
        artifactReviewCollapseButton: 'artifactReviewCollapseButton',
        artifactReviewDetailEmpty: 'artifactReviewDetailEmpty',
        artifactReviewDetailPanel: 'artifactReviewDetailPanel',
        artifactReviewDetailKicker: 'artifactReviewDetailKicker',
        artifactReviewDetailTitle: 'artifactReviewDetailTitle',
        artifactReviewDetailPath: 'artifactReviewDetailPath',
        artifactReviewDetailStatus: 'artifactReviewDetailStatus',
        artifactReviewDetailMeta: 'artifactReviewDetailMeta',
        artifactReviewDetailNote: 'artifactReviewDetailNote',
        artifactReviewPreviewContent: 'artifactReviewPreviewContent',
        artifactReviewEditorShell: 'artifactReviewEditorShell',
        artifactReviewEditorHost: 'artifactReviewEditorHost',
        artifactReviewEditorFallback: 'artifactReviewEditorFallback',
        artifactReviewSaveButton: 'artifactReviewSaveButton',
        artifactReviewRevertButton: 'artifactReviewRevertButton',
        artifactReviewRevealButton: 'artifactReviewRevealButton',
        artifactReviewOpenExternalButton: 'artifactReviewOpenExternalButton',
        artifactReviewJumpButton: 'artifactReviewJumpButton',
        artifactReviewDeleteButton: 'artifactReviewDeleteButton',
        artifactReviewProvenanceTimeline: 'artifactReviewProvenanceTimeline',
      },
    });
    const getIdeDom = createLazyDomResolver(document, {
      ide: {
        ideView: 'ideView',
        ideShell: 'ideShell',
        ideMain: 'ideMain',
        ideTabStrip: 'ideTabStrip',
        ideBreadcrumbs: 'ideBreadcrumbs',
        ideDiffToolbar: 'ideDiffToolbar',
        ideStatusBar: 'ideStatusBar',
        ideEditorStage: 'ideEditorStage',
        ideEditorHost: 'ideEditorHost',
        ideEditorFallback: 'ideEditorFallback',
        ideEmptyState: 'ideEmptyState',
        ideEmptyStateCopy: 'ideEmptyStateCopy',
        ideEmptyStateAction: 'ideEmptyStateAction',
        ideMapHost: 'ideMapHost',
        ideExplodedHost: 'ideExplodedHost',
        idePreviewHost: 'idePreviewHost',
        ideViewModeBar: 'ideViewModeBar',
        ideRail: 'ideRail',
        ideRailResizer: 'ideRailResizer',
        ideActivityBar: 'ideActivityBar',
        ideRailPanel: 'ideRailPanel',
        ideBottomResizer: 'ideBottomResizer',
        ideBottomPanel: 'ideBottomPanel',
        ideBottomTabs: 'ideBottomTabs',
        ideBottomPanelContent: 'ideBottomPanelContent',
        ideBottomTerminalHost: 'ideBottomTerminalHost',
        ideBottomHandle: 'ideBottomHandle',
        ideSecondarySidebar: 'ideSecondarySidebar',
        ideSecondarySidebarResizer: 'ideSecondarySidebarResizer',
        ideSecondarySidebarHeader: 'ideSecondarySidebarHeader',
        ideSecondarySidebarPanel: 'ideSecondarySidebarPanel',
        ideChatDock: 'ideChatDock',
        ideChatDockResizer: 'ideChatDockResizer',
        ideChatDockHeader: 'ideChatDockHeader',
        ideChatDockBody: 'ideChatDockBody',
      },
    });

    return {
      MAX_CACHED_SESSION_MESSAGE_SETS,
      staticModel,
      ACTIVITY_SCOPE,
      TOAST_SOURCE,
      state,
      dom,
      surfaceDom: createRendererSurfaceDom(dom, {
        getSettingsSectionDom,
        getIdeDom,
      }),
      lazyDom: {
        getHomeDom: function getLazyHomeDom() {
          return getHomeDom('home');
        },
        getArtifactsDom: function getLazyArtifactDom() {
          return getArtifactDom('artifacts');
        },
        getIdeDom: function getLazyIdeDom() {
          return getIdeDom('ide');
        },
      },
      constants: {
        APPEARANCE_STORAGE_KEY: appearanceUtils.STORAGE_KEY || 'jenny.appearance.v2',
        SIDEBAR_STORAGE_KEY: 'jenny.sidebar.v1',
        PANEL_STORAGE_KEY: 'jenny.panels.v2',
        SIDEBAR_DEFAULT_WIDTH: 320,
        SIDEBAR_MIN_WIDTH: 248,
        SIDEBAR_MAX_WIDTH: 420,
        SIDEBAR_COLLAPSED_WIDTH: 84,
        SIDEBAR_MAIN_STAGE_MIN_WIDTH: 720,
        SIDEBAR_KEYBOARD_STEP: 24,
      },
    };
  }

  return {
    createRendererBootstrap,
  };
});
