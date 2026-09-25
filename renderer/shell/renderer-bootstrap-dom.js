(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBootstrapDom = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * Split view W0-4: the nodes ONE chat pane owns.
   *
   * Every one of these is reached today by id, through the one document. With
   * two panes an id is no longer unique, so each of these elements also carries
   * `data-chat-node="<its id>"` in index.html and a pane resolves its nodes
   * relative to its own root. The attribute value IS the id -- that identity is
   * what lets pane 0 keep using `getElementById` and get byte-for-byte the
   * nodes it always got.
   *
   * `chatView` and `chatSurfaceEffects` are deliberately absent: they are the
   * VIEW that hosts the panes, not a pane. So is `composerActiveFileActionHost`,
   * which lives outside the chat view entirely. `chatContextPanel` IS a pane
   * node: like the artifact review panel it shows the CURRENT session's
   * artifacts, pulse and logs, so with two sessions side by side it is per
   * pane, and its own ids are reached by traversal inside it.
   */
  const CHAT_PANE_NODE_NAMES = Object.freeze([
    'heroStage',
    'chatThreadStage',
    'chatSearchOverlayHost',
    'chatSelectionOverlayHost',
    'chatSurface',
    'chatThreadScroll',
    'chatThreadColumn',
    'chatSpriteLayer',
    'chatAssistantSprite',
    'chatOriginChip',
    'chatOriginLabel',
    'chatTimeline',
    'chatScrollSentinel',
    'jumpToTopButton',
    'jumpToLastPromptButton',
    'jumpToBottomButton',
    'chatTimelineUtilityCluster',
    'artifactSplitViewToggle',
    'timelineCollapseExpandToggle',
    'composerWayfinderHost',
    'composerWrap',
    'chatInput',
    'sendButton',
    'stopStreamButton',
    'composerTerminalShortcut',
    'artifactReviewResizer',
    'artifactReviewPanel',
    'chatContextPanel',
  ]);

  /**
   * One pane's chat nodes.
   *
   * With NO `paneRoot` this is pane 0: `documentRef.getElementById(name)`, the
   * exact lookup every call site makes today. With a `paneRoot` element the
   * lookup is scoped to that root via `[data-chat-node="<name>"]` and there is
   * NO document fallback -- a root that lacks a node yields `null`. That is the
   * load-bearing rule: a fallback would let a second pane silently resolve, and
   * then mutate, the first pane's timeline, composer or scroller.
   *
   * Only `null` / `undefined` mean pane 0. A root that was GIVEN but cannot be
   * queried (a wrapper object, a ref, a stale id) is still a pane, so it
   * resolves every name to `null` -- never through to the document.
   *
   * @param {Document} documentRef the boot document (pane 0's lookups)
   * @param {Element|null} [paneRoot] a pane's root element, or null for pane 0
   * @returns {Object} every name in CHAT_PANE_NODE_NAMES, each an Element or null
   */
  function resolveChatPaneDom(documentRef, paneRoot) {
    const scoped = paneRoot && typeof paneRoot.querySelector === 'function' ? paneRoot : null;
    const rootGivenButUnusable = paneRoot != null && !scoped;
    const byId = !scoped && !rootGivenButUnusable
      && documentRef && typeof documentRef.getElementById === 'function'
      ? documentRef
      : null;
    const resolved = {};
    for (const name of CHAT_PANE_NODE_NAMES) {
      if (scoped) {
        resolved[name] = scoped.querySelector(`[data-chat-node="${name}"]`) || null;
      } else {
        resolved[name] = byId ? (byId.getElementById(name) || null) : null;
      }
    }
    return resolved;
  }

  function resolveDomSpec(documentRef, spec) {
    if (!spec) {
      return null;
    }
    if (typeof spec === 'string') {
      return documentRef.getElementById(spec);
    }
    if (typeof spec === 'function') {
      return spec(documentRef);
    }
    if (typeof spec === 'object' && !Array.isArray(spec)) {
      if (typeof spec.id === 'string') {
        return documentRef.getElementById(spec.id);
      }
      if (typeof spec.selector === 'string') {
        return documentRef.querySelector(spec.selector);
      }
      if (typeof spec.resolve === 'function') {
        return spec.resolve(documentRef);
      }
    }
    return null;
  }

  function createLazyDomResolver(documentRef, specMap) {
    const cache = new Map();

    function isConnectedNode(value) {
      if (!value || typeof value !== 'object' || typeof value.nodeType !== 'number') {
        return true;
      }
      if (value.isConnected === false) {
        return false;
      }
      return !documentRef?.documentElement || documentRef.documentElement.contains(value);
    }

    function isCachedSliceFresh(slice) {
      if (!slice || typeof slice !== 'object') {
        return false;
      }
      const values = Object.values(slice);
      if (!values.length) {
        return false;
      }
      return values.every((value) => value != null && isConnectedNode(value));
    }

    return function resolveDomSlice(key) {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey) {
        return {};
      }
      const cached = cache.get(normalizedKey);
      if (isCachedSliceFresh(cached)) {
        return cached;
      }
      const spec = specMap && typeof specMap === 'object' && !Array.isArray(specMap)
        ? specMap[normalizedKey]
        : null;
      const slice = {};
      if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
        for (const [prop, value] of Object.entries(spec)) {
          slice[prop] = resolveDomSpec(documentRef, value);
        }
      }
      cache.set(normalizedKey, slice);
      return slice;
    };
  }

  function createRendererDomRegistry(documentRef) {
    const $ = (id) => documentRef.getElementById(id);
    const modelBadge = $('modelBadge');
    const composerModelSelect = $('composerModelSelect');
    const composerEffortSelect = $('composerEffortSelect');
    const composerHolo = $('composerHolo');
    const chatSpriteHolo = $('chatSpriteHolo');

    return {
      workspace: $('workspace'),
      workspaceRailShell: $('workspaceRailShell'),
      homeNavButton: $('homeNavButton'),
      viewPanel: $('viewPanel'),
      topRail: $('topRail'),
      topRailTabs: $('topRailTabs'),
      topRailActions: $('topRailActions'),
      topRailIndicator: $('topRailIndicator'),
      metricList: $('metricList'),
      conversationGroups: $('conversationGroups'),
      conversationCount: $('conversationCount'),
      homeView: $('homeView'),
      chatView: $('chatView'),
      ideView: $('ideView'),
      logsView: $('logsView'),
      settingsView: $('settingsView'),
      settingsAdvancedToggle: $('settingsAdvancedToggle'),
      settingsAdvancedItems: $('settingsAdvancedItems'),
      heroStack: $('heroStack'),
      chatSurfaceEffects: $('chatSurfaceEffects'),
      chatSurfaceEffectLeft: $('chatSurfaceEffectLeft'),
      chatThreadStage: $('chatThreadStage'),
      subagentInspector: $('subagentInspector'),
      chatSurface: $('chatSurface'),
      chatThreadScroll: $('chatThreadScroll'),
      chatThreadColumn: $('chatThreadColumn'),
      chatSpriteLayer: $('chatSpriteLayer'),
      chatAssistantSprite: $('chatAssistantSprite'),
      chatTimeline: $('chatTimeline'),
      attachmentTray: $('attachmentTray'),
      attachmentNotice: $('attachmentNotice'),
      composerStatusNotice: $('composerStatusNotice'),
      chatInput: $('chatInput'),
      newChatButton: $('newChatButton'),
      stopStreamButton: $('stopStreamButton'),
      sendButton: $('sendButton'),
      composerAttachShortcut: $('composerAttachShortcut'),
      composerTerminalShortcut: $('composerTerminalShortcut'),
      searchInput: $('conversationSearch'),
      sidebarResizer: $('sidebarResizer'),
      heroAvatar: $('heroAvatar'),
      heroTitle: $('heroTitle'),
      heroSubtitle: $('heroSubtitle'),
      heroRuntimeHint: $('heroRuntimeHint'),
      composerOfflineLabel: $('composerOfflineLabel'),
      composerContextUsageSlot: $('composerContextUsageSlot'),
      composerPlanUsageSlot: $('composerPlanUsageSlot'),
      composerToolToggleSlot: $('composerToolToggleSlot'),
      turnStatusPill: $('turnStatusPill'),
      titlebarStatus: documentRef.querySelector('.titlebar-status'),
      startupOverlay: $('startupOverlay'),
      startupOverlaySublabel: $('startupOverlaySublabel'),
      startupOverlaySecondary: $('startupOverlaySecondary'),
      toastViewport: $('toastViewport'),
      sessionActionButton: $('sessionActionButton'),
      logLevelFilter: $('logLevelFilter'),
      logList: $('logList'),
      logResultsLabel: $('logResultsLabel'),
      logSearchInput: $('logSearchInput'),
      logSourceFilter: $('logSourceFilter'),
      observabilityRefreshButton: $('observabilityRefreshButton'),
      toolLatencyTable: $('toolLatencyTable'),
      slowOperationsList: $('slowOperationsList'),
      recentTracesList: $('recentTracesList'),
      logAutoScrollToggle: $('logAutoScrollToggle'),
      copyLogsReportButton: $('copyLogsReportButton'),
      modelBadge,
      composerModelSelect,
      composerEffortSelect,
      composerSettingsButton: $('composerSettingsButton'),
      jumpToTopButton: $('jumpToTopButton'),
      jumpToLastPromptButton: $('jumpToLastPromptButton'),
      jumpToBottomButton: $('jumpToBottomButton'),
      composerSettingsPopover: $('composerSettingsPopover'),
      composerCommandPopover: $('composerCommandPopover'),
      composerCommandPopoverList: $('composerCommandPopoverList'),
      commandPaletteOverlay: $('commandPaletteOverlay'),
      commandPaletteInput: $('commandPaletteInput'),
      commandPaletteList: $('commandPaletteList'),
      commandPaletteScope: $('commandPaletteScope'),
      commandPaletteCount: $('commandPaletteCount'),
      commandPaletteLegend: $('commandPaletteLegend'),
      commandPaletteStatus: $('commandPaletteStatus'),
      commandPaletteFieldIcon: $('commandPaletteFieldIcon'),
      titlebarPalettePill: $('titlebarPalettePill'),
      attachFilesButton: $('attachFilesButton'),
      captureScreenButton: $('captureScreenButton'),
      openComposerSettingsViewButton: $('openComposerSettingsViewButton'),
      composerChatZoomSelect: $('composerChatZoomSelect'),
      composerChatZoomStatus: $('composerChatZoomStatus'),
      settingsModelCard: modelBadge?.closest('.settings-card') || null,
      composerModelSelectShell: composerModelSelect?.closest('.composer-select-shell') || null,
      composerEffortSelectShell: composerEffortSelect?.closest('.composer-select-shell') || null,
      appearanceBadge: $('appearanceBadge'),
      appearanceThemeBundleSelect: $('appearanceThemeBundleSelect'),
      appearancePaletteSelect: $('appearancePaletteSelect'),
      appearanceTypographySelect: $('appearanceTypographySelect'),
      appearanceFontScaleSelect: $('appearanceFontScaleSelect'),
      appearanceChatWidthMount: $('appearanceChatWidthMount'),
      appearanceSurfaceEffectSelect: $('appearanceSurfaceEffectSelect'),
      appearanceSurfaceEffectDescription: $('appearanceSurfaceEffectDescription'),
      appearanceSurfaceEffectMeta: $('appearanceSurfaceEffectMeta'),
      appearanceSurfaceEffectPreview: $('appearanceSurfaceEffectPreview'),
      appearanceHoloList: $('appearanceHoloList'),
      appearanceSpellcheckList: $('appearanceSpellcheckList'),
      appearanceAppZoomSelect: $('appearanceAppZoomSelect'),
      appearanceResetButton: $('appearanceResetButton'),
      appearanceStatus: $('appearanceStatus'),
      modelStatus: $('modelStatus'),
      modelCatalogEmpty: $('modelCatalogEmpty'),
      modelStartupLoadList: $('modelStartupLoadList'),
      skillsSettingsNavItem: $('skillsSettingsNavItem'),
      contextBadge: $('contextBadge'),
      contextStatus: $('contextStatus'),
      contextHistoryScopeSelect: $('contextHistoryScopeSelect'),
      contextSourcesList: $('contextSourcesList'),
      contextRuntimeList: $('contextRuntimeList'),
      contextCompactionTuning: $('contextCompactionTuning'),
      toolsConfigFieldList: $('toolsConfigFieldList'),
      toolsApprovalRulesList: $('toolsApprovalRulesList'),
      toolsWorkspacePath: $('toolsWorkspacePath'),
      toolsWorkspaceStatus: $('toolsWorkspaceStatus'),
      toolsWorkspaceProject: $('toolsWorkspaceProject'),
      toolsWorkspaceChooseButton: $('toolsWorkspaceChooseButton'),
      toolsSummary: $('toolsSummary'),
      editorBadge: $('editorBadge'),
      editorStatus: $('editorStatus'),
      editorSettingsFieldList: $('editorSettingsFieldList'),
      homeBadge: $('homeBadge'),
      homeStatus: $('homeStatus'),
      homeSettingsFieldList: $('homeSettingsFieldList'),
      accountBadge: $('accountBadge'),
      accountSummary: $('accountSummary'),
      localProfileSettingsMount: $('localProfileSettingsMount'),
      backendSummary: $('backendSummary'),
      setupSettingsSummary: $('setupSettingsSummary'),
      setupSettingsActions: $('setupSettingsActions'),
      setupProgressContainer: $('setupProgressContainer'),
      settingsControlTowerHost: $('settingsControlTowerHost'),
      usageSettingsNavItem: $('usageSettingsNavItem'),
      remoteSettingsSection: documentRef.querySelector('[data-settings-section="remote"]'),
      titlebar: documentRef.querySelector('.titlebar'),
      sidebar: $('viewPanel'),
      composer: documentRef.querySelector('.composer'),
      composerHolo,
      composerHoloContext: composerHolo && typeof composerHolo.getContext === 'function'
        ? composerHolo.getContext('2d')
        : null,
      chatSpriteHolo,
      chatSpriteHoloContext: chatSpriteHolo && typeof chatSpriteHolo.getContext === 'function'
        ? chatSpriteHolo.getContext('2d')
        : null,
      composerWrap: $('composerWrap'),
      composerRemoteBanner: $('composerRemoteBanner'),
      composerRemoteBannerLabel: $('composerRemoteBannerLabel'),
      composerRemoteTakeControl: $('composerRemoteTakeControl'),
      composerRemoteStop: $('composerRemoteStop'),
      workbenchHealthPillSlot: $('workbenchHealthPillSlot'),
      chatOriginChip: $('chatOriginChip'),
      chatOriginLabel: $('chatOriginLabel'),
      chatContextPanel: $('chatContextPanel'),
      contextArtifactList: $('contextArtifactList'),
      contextPulse: $('contextPulse'),
      contextSessionLogs: $('contextSessionLogs'),
      contextPanelToggle: $('contextPanelToggle'),
      contextArtifactExpand: $('contextArtifactExpand'),
    };
  }

  // `documentRef` (split view W0-4) is what the chat group's `resolvePane` is
  // bound to. It is the third parameter rather than the first so no existing
  // call site's arguments move; the boot passes its own `document`.
  function createRendererSurfaceDom(dom, lazyResolvers, documentRef) {
    return {
      status: {
        composerStatusNotice: dom.composerStatusNotice,
        startupOverlay: dom.startupOverlay,
        startupOverlaySublabel: dom.startupOverlaySublabel,
        startupOverlaySecondary: dom.startupOverlaySecondary,
        turnStatusPill: dom.turnStatusPill,
        titlebarStatus: dom.titlebarStatus,
        metricList: dom.metricList,
      },
      settings: {
        settingsView: dom.settingsView,
        settingsAdvancedToggle: dom.settingsAdvancedToggle,
        settingsAdvancedItems: dom.settingsAdvancedItems,
        composerModelSelect: dom.composerModelSelect,
        composerEffortSelect: dom.composerEffortSelect,
        composerSettingsPopover: dom.composerSettingsPopover,
        composerSettingsButton: dom.composerSettingsButton,
        composerChatZoomSelect: dom.composerChatZoomSelect,
        composerChatZoomStatus: dom.composerChatZoomStatus,
        composerCommandPopover: dom.composerCommandPopover,
        composerCommandPopoverList: dom.composerCommandPopoverList,
        composerTerminalShortcut: dom.composerTerminalShortcut,
        settingsModelCard: dom.settingsModelCard,
        composerModelSelectShell: dom.composerModelSelectShell,
        composerEffortSelectShell: dom.composerEffortSelectShell,
        appearanceBadge: dom.appearanceBadge,
        appearanceThemeBundleSelect: dom.appearanceThemeBundleSelect,
        appearancePaletteSelect: dom.appearancePaletteSelect,
        appearanceTypographySelect: dom.appearanceTypographySelect,
        appearanceFontScaleSelect: dom.appearanceFontScaleSelect,
        appearanceChatWidthMount: dom.appearanceChatWidthMount,
        appearanceSurfaceEffectSelect: dom.appearanceSurfaceEffectSelect,
        appearanceSurfaceEffectDescription: dom.appearanceSurfaceEffectDescription,
        appearanceSurfaceEffectMeta: dom.appearanceSurfaceEffectMeta,
        appearanceSurfaceEffectPreview: dom.appearanceSurfaceEffectPreview,
        appearanceHoloList: dom.appearanceHoloList,
        appearanceSpellcheckList: dom.appearanceSpellcheckList,
        appearanceAppZoomSelect: dom.appearanceAppZoomSelect,
        appearanceResetButton: dom.appearanceResetButton,
        appearanceStatus: dom.appearanceStatus,
        modelBadge: dom.modelBadge,
        modelStatus: dom.modelStatus,
        modelCatalogEmpty: dom.modelCatalogEmpty,
        modelStartupLoadList: dom.modelStartupLoadList,
        skillsSettingsNavItem: dom.skillsSettingsNavItem,
        skillsSettingsSection: dom.skillsSettingsSection,
        contextBadge: dom.contextBadge,
        contextStatus: dom.contextStatus,
        contextHistoryScopeSelect: dom.contextHistoryScopeSelect,
        contextSourcesList: dom.contextSourcesList,
        contextRuntimeList: dom.contextRuntimeList,
        contextCompactionTuning: dom.contextCompactionTuning,
        toolsConfigFieldList: dom.toolsConfigFieldList,
        toolsApprovalRulesList: dom.toolsApprovalRulesList,
        toolsWorkspacePath: dom.toolsWorkspacePath,
        toolsWorkspaceStatus: dom.toolsWorkspaceStatus,
        toolsWorkspaceProject: dom.toolsWorkspaceProject,
        toolsWorkspaceChooseButton: dom.toolsWorkspaceChooseButton,
        toolsSummary: dom.toolsSummary,
        editorBadge: dom.editorBadge,
        editorStatus: dom.editorStatus,
        editorSettingsFieldList: dom.editorSettingsFieldList,
        homeBadge: dom.homeBadge,
        homeStatus: dom.homeStatus,
        homeSettingsFieldList: dom.homeSettingsFieldList,
        accountBadge: dom.accountBadge,
        accountSummary: dom.accountSummary,
        localProfileSettingsMount: dom.localProfileSettingsMount,
        backendSummary: dom.backendSummary,
        setupSettingsSummary: dom.setupSettingsSummary,
        setupSettingsActions: dom.setupSettingsActions,
        settingsControlTowerHost: dom.settingsControlTowerHost,
        usageSettingsNavItem: dom.usageSettingsNavItem,
        remoteSettingsSection: dom.remoteSettingsSection,
        getSectionDom: typeof lazyResolvers?.getSettingsSectionDom === 'function'
          ? lazyResolvers.getSettingsSectionDom
          : function noopGetSettingsSectionDom() { return {}; },
      },
      ide: {
        ideView: dom.ideView,
        // Pre-bound to the 'ide' slice: the raw lazy resolver takes a slice
        // key and returns {} without one, which left the live IDE controller
        // with an ideView-only dom (rail/tabs/editor never rendered).
        getIdeDom: typeof lazyResolvers?.getIdeDom === 'function'
          ? function resolveIdeDom() { return lazyResolvers.getIdeDom('ide'); }
          : function noopGetIdeDom() { return {}; },
      },
      chat: {
        homeNavButton: dom.homeNavButton,
        chatInput: dom.chatInput,
        newChatButton: dom.newChatButton,
        stopStreamButton: dom.stopStreamButton,
        sendButton: dom.sendButton,
        composerTerminalShortcut: dom.composerTerminalShortcut,
        jumpToTopButton: dom.jumpToTopButton,
        jumpToLastPromptButton: dom.jumpToLastPromptButton,
        jumpToBottomButton: dom.jumpToBottomButton,
        chatView: dom.chatView,
        chatSurfaceEffects: dom.chatSurfaceEffects,
        chatThreadScroll: dom.chatThreadScroll,
        composerWrap: dom.composerWrap,
        composerRemoteBanner: dom.composerRemoteBanner,
        composerRemoteBannerLabel: dom.composerRemoteBannerLabel,
        composerRemoteTakeControl: dom.composerRemoteTakeControl,
        composerRemoteStop: dom.composerRemoteStop,
        chatTimeline: dom.chatTimeline,
        toastViewport: dom.toastViewport,
        composerModelSelect: dom.composerModelSelect,
        composerEffortSelect: dom.composerEffortSelect,
        composerSettingsButton: dom.composerSettingsButton,
        openComposerSettingsViewButton: dom.openComposerSettingsViewButton,
        composerCommandPopover: dom.composerCommandPopover,
        artifactReviewPanel: dom.artifactReviewPanel,
        // Split view W0-4: the seam the pane template resolves its nodes
        // through. Nothing calls it in production yet -- the fields above are
        // still pane 0's, resolved by id at boot -- but it is what a second
        // pane will be handed instead of the document.
        resolvePane: (paneRoot) => resolveChatPaneDom(documentRef, paneRoot),
      },
    };
  }

  return {
    CHAT_PANE_NODE_NAMES,
    createLazyDomResolver,
    createRendererDomRegistry,
    createRendererSurfaceDom,
    resolveChatPaneDom,
  };
});
