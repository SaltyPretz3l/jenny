/* Ordered Settings scripts, loaded together on first use. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsScriptManifest = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Settings > Team (row 123, slice 1g-1): loaded on its own, only while the `team` flag is on and the
  // Team section is shown (renderer-settings-utils.js `syncTeamSettingsSection`), never with the group below.
  const teamStrings = Object.freeze(['renderer/shell/renderer-settings-team-strings.js', 'rendererSettingsTeamStrings']);
  const teamStoreScript = Object.freeze(['renderer/team/renderer-team-store.js', 'rendererTeamStore']);
  // Row 173: channel management. The menu holds the rules the channel helpers read, so it loads first wherever they do.
  const teamChannelMenuScript = Object.freeze(['renderer/team/renderer-team-channel-menu.js', 'rendererTeamChannelMenu']);
  // Row 175 (item 14): the column rows' own menu, read by the channel menu when it builds.
  const teamChannelRowMenuScript = Object.freeze(['renderer/team/renderer-team-channel-row-menu.js', 'rendererTeamChannelRowMenu']);
  const teamChannelsScript = Object.freeze(['renderer/team/renderer-team-channels.js', 'rendererTeamChannels']);
  const teamExportScript = Object.freeze(['renderer/team/renderer-team-export.js', 'rendererTeamExport']);
  const teamView = Object.freeze(['renderer/shell/renderer-settings-team-view.js', 'rendererSettingsTeamView']);
  const teamOwnerView = Object.freeze(['renderer/shell/renderer-settings-team-owner-view.js', 'rendererSettingsTeamOwnerView']);
  // Row 170: the stopped server's page and rows, shared by the tab (before its view and start page) and the Settings page.
  const teamServerScript = Object.freeze(['renderer/team/renderer-team-server.js', 'rendererTeamServer']);
  // The chat store (slice 2a-5a): loaded by the gate once this Jenny is a member of a team (the tab's number).
  const teamChatStoreScript = Object.freeze(['renderer/team/renderer-team-chat-store.js', 'rendererTeamChatStore']);
  // Its read marks (E59), loaded right before it wherever it loads.
  const teamChatReadsScript = Object.freeze(['renderer/team/renderer-team-chat-reads.js', 'rendererTeamChatReads']);
  // Slice 6-7: model sharing's store, with the gate (the tab's number), the tab (its notice) and the page; its words are
  // the team strings' `modelWords`; the Library's rows load with the gate's list only.
  const teamModelStoreScript = Object.freeze(['renderer/team/renderer-team-model-store.js', 'rendererTeamModelStore']);
  const teamShareRowsScript = Object.freeze(['renderer/shell/model-library/model-library-share-rows.js', 'modelLibraryShareRows']);
  // The export (2a-6c) loads with the page too, after the channel helpers it shares with the tab: Leave offers it first.
  const teamSection = Object.freeze([teamStrings, teamStoreScript, teamChatReadsScript, teamChatStoreScript, teamChannelRowMenuScript, teamChannelMenuScript, teamChannelsScript, teamExportScript, teamView, teamOwnerView, teamServerScript,
    Object.freeze(['renderer/shell/renderer-settings-team-gpu.js', 'rendererSettingsTeamGpu']), // slice 4e: the GPU groups
    Object.freeze(['renderer/shell/renderer-settings-team-network.js', 'rendererSettingsTeamNetwork']), // slice 5-6: Network
    Object.freeze(['renderer/shell/renderer-settings-team-lifecycle.js', 'rendererSettingsTeamLifecycle']), // 5-6: delete, export
    teamModelStoreScript, Object.freeze(['renderer/shell/renderer-settings-team-models.js', 'rendererSettingsTeamModels']), // 6-7: Model sharing
    Object.freeze(['renderer/shell/renderer-settings-team-files.js', 'rendererSettingsTeamFiles']), // row 123: Project files (file tools on a team host)
    Object.freeze(['renderer/shell/renderer-settings-team-section.js', 'rendererSettingsTeamSection']),
  ]);
  // The Team tab's gate (slice 1g-2): loaded by the top-nav shell after first paint, only while the `team`
  // flag is on. It also holds the one loader for every list here (`ensureTeamAssets`).
  const teamGate = Object.freeze([Object.freeze(['renderer/team/renderer-team-tab-gate.js', 'rendererTeamTabGate'])]);
  // The Team tab (slice 1g-2; the channel since 2a-5a, its composer and actions since 2a-5b): loaded by the gate
  // on the tab's first activation. It shares the strings, the stores and the two Settings views with the page
  // above; each script loads once, search, jump and message links included.
  const teamTab = Object.freeze([teamStrings, teamStoreScript, teamChatReadsScript, teamChatStoreScript, teamView, teamOwnerView, teamServerScript,
    teamChannelRowMenuScript, teamChannelMenuScript, teamChannelsScript,
    Object.freeze(['renderer/team/renderer-team-dm-picker.js', 'rendererTeamDmPicker']),
    Object.freeze(['renderer/team/renderer-team-channel-form.js', 'rendererTeamChannelForm']), // row 173: the New channel view
    Object.freeze(['renderer/team/renderer-team-gpus.js', 'rendererTeamGpus']), // slice 4e: the GPUs section
    Object.freeze(['renderer/team/renderer-team-chat-writes.js', 'rendererTeamChatWrites']),
    Object.freeze(['renderer/team/renderer-team-link.js', 'rendererTeamLink']),
    Object.freeze(['renderer/team/renderer-team-message-row.js', 'rendererTeamMessageRow']),
    // Slice 2b-2: reactions, pins, earlier versions and "Seen by" load with the tab, the header's button before the tab view.
    Object.freeze(['renderer/team/renderer-team-pop.js', 'rendererTeamPop']),
    Object.freeze(['renderer/team/renderer-team-marks.js', 'rendererTeamMarks']),
    Object.freeze(['renderer/team/renderer-team-receipts.js', 'rendererTeamReceipts']),
    Object.freeze(['renderer/team/renderer-team-pins.js', 'rendererTeamPins']),
    // Slice 3-10: shared projects; the column before the tab view that draws it, the rest before the tab.
    Object.freeze(['renderer/team/renderer-team-project-store.js', 'rendererTeamProjectStore']),
    Object.freeze(['renderer/team/renderer-team-project-column.js', 'rendererTeamProjectColumn']),
    Object.freeze(['renderer/team/renderer-team-tab-view.js', 'rendererTeamTabView']),
    Object.freeze(['renderer/team/renderer-team-message-actions.js', 'rendererTeamMessageActions']),
    Object.freeze(['renderer/team/renderer-team-files.js', 'rendererTeamFiles']),
    Object.freeze(['renderer/team/renderer-team-timeline.js', 'rendererTeamTimeline']),
    Object.freeze(['renderer/team/renderer-team-attach.js', 'rendererTeamAttach']),
    Object.freeze(['renderer/team/renderer-team-composer.js', 'rendererTeamComposer']),
    Object.freeze(['renderer/team/renderer-team-thread-data.js', 'rendererTeamThreadData']),
    Object.freeze(['renderer/team/renderer-team-thread.js', 'rendererTeamThread']),
    Object.freeze(['renderer/team/renderer-team-project-files.js', 'rendererTeamProjectFiles']), // row 175 (D13): the project file explorer
    Object.freeze(['renderer/team/renderer-team-project-file-pane.js', 'rendererTeamProjectFilePane']), // row 175 (D13): its column and workspace panel
    Object.freeze(['renderer/team/renderer-team-preview.js', 'rendererTeamPreview']), // row 167: the file preview column
    Object.freeze(['renderer/team/renderer-team-search.js', 'rendererTeamSearch']),
    teamModelStoreScript, // slice 6-7: the notice's model offers
    Object.freeze(['renderer/team/renderer-team-notice.js', 'rendererTeamNotice']),
    Object.freeze(['renderer/team/renderer-team-notify.js', 'rendererTeamNotify']),
    teamExportScript,
    Object.freeze(['renderer/team/renderer-team-project-rules.js', 'rendererTeamProjectRules']),
    Object.freeze(['renderer/team/renderer-team-project-activity.js', 'rendererTeamProjectActivity']),
    Object.freeze(['renderer/team/renderer-team-project-page.js', 'rendererTeamProjectPage']),
    Object.freeze(['renderer/team/renderer-team-project-box.js', 'rendererTeamProjectBox']),
    Object.freeze(['renderer/team/renderer-team-project-timeline.js', 'rendererTeamProjectTimeline']), // row 169: the conversation's timeline builders, before the conversation
    Object.freeze(['renderer/team/renderer-team-project-conversation-parts.js', 'rendererTeamProjectConversationParts']), // row 169: the conversation's controllers, after the timeline
    Object.freeze(['renderer/team/renderer-team-project-rows.js', 'rendererTeamProjectRows']), // row 171: the channel's rows, after the message row and the timeline
    Object.freeze(['renderer/team/renderer-team-turn-adapter.js', 'rendererTeamTurnAdapter']), // row 171: host messages to the local chat's shape, before the popover
    Object.freeze(['renderer/team/renderer-team-turn-pop-patch.js', 'rendererTeamTurnPopPatch']), // row 175: the popover's in-place patcher and focus keeper
    Object.freeze(['renderer/team/renderer-team-turn-pop-follow.js', 'rendererTeamTurnPopFollow']), // row 175: the popover's scroll follow
    Object.freeze(['renderer/team/renderer-team-turn-pop.js', 'rendererTeamTurnPop']), // row 171: the turn's transcript popover
    Object.freeze(['renderer/team/renderer-team-project-queue.js', 'rendererTeamProjectQueue']), // row 171: the send queue
    Object.freeze(['renderer/team/renderer-team-project-channel.js', 'rendererTeamProjectChannel']), // row 171: the channel's view model, before the conversation
    Object.freeze(['renderer/team/renderer-team-conversation-controls.js', 'rendererTeamConversationControls']), // row 172: the Tools chip and model pill, before the conversation
    Object.freeze(['renderer/team/renderer-team-project-find.js', 'rendererTeamProjectFind']), // row 175 (D15): find in a project conversation
    Object.freeze(['renderer/team/renderer-team-project-paths.js', 'rendererTeamProjectPaths']), // row 175 (D13): path chips, the Files button and @file
    Object.freeze(['renderer/team/renderer-team-project-plan.js', 'rendererTeamProjectPlan']), // row 175 (D14): the plan row and the Plan chip
    Object.freeze(['renderer/team/renderer-team-project-actions.js', 'rendererTeamProjectActions']), // row 175 (D7, D8, F18): message menu, redo, ask, hand-off
    Object.freeze(['renderer/team/renderer-team-project-drafts.js', 'rendererTeamProjectDrafts']), // row 175 (F6): the box text kept on this PC
    Object.freeze(['renderer/team/renderer-team-project-conversation.js', 'rendererTeamProjectConversation']),
    Object.freeze(['renderer/team/renderer-team-project-tab.js', 'rendererTeamProjectTab']),
    Object.freeze(['renderer/team/renderer-team-tab-focus.js', 'rendererTeamTabFocus']), // slice 3-10: moved out of the tab, unchanged
    Object.freeze(['renderer/team/renderer-team-start.js', 'rendererTeamStart']), // row 168: the start page, with no team yet
    Object.freeze(['renderer/team/renderer-team-overview.js', 'rendererTeamOverview']), // row 168: the Overview page of the column
    Object.freeze(['renderer/team/renderer-team-tab-notify-menu.js', 'rendererTeamTabNotifyMenu']), // row 175: the channel notify-level menu, moved out of the tab
    Object.freeze(['renderer/team/renderer-team-tab-frame.js', 'rendererTeamTabFrame']), // row 201 (OD-10): the team's frame and its swappable main pane
    Object.freeze(['renderer/team/renderer-team-tab.js', 'rendererTeamTab']),
  ]);
  // The shared store alone: loaded by the gate, which reads the team state and the tab's count through it.
  const teamStore = Object.freeze([teamStoreScript]);
  // The gate loads it after the store, which it needs; presence reports (2a-5b) start with it, and so do the team
  // desktop notifications and the palette's team rows (2a-6c), which read the conversation titles of the channels module.
  // Slice 6-7: model sharing's store (the tab's number counts offers) and the Library's share rows (Settings › Models
  // draws them once they load), with the team words their refusals are said in. The send and accept drawers are
  // `teamShareDrawers`, loaded by the share section on first use.
  const teamChat = Object.freeze([teamChatReadsScript, teamChatStoreScript, Object.freeze(['renderer/team/renderer-team-presence.js', 'rendererTeamPresence']), teamStrings, teamChannelRowMenuScript, teamChannelMenuScript, teamChannelsScript,
    Object.freeze(['renderer/team/renderer-team-notify.js', 'rendererTeamNotify']), Object.freeze(['renderer/team/renderer-team-palette.js', 'rendererTeamPalette']),
    teamModelStoreScript, teamShareRowsScript,
    Object.freeze(['renderer/shell/model-library/model-library-share-section.js', 'modelLibraryShareSection']),
    // Row 175 (D5): Post to Team… from a local answer; the item says why it is greyed until this loads.
    Object.freeze(['renderer/chat/renderer-chat-post-to-team.js', 'rendererChatPostToTeam'])]);
  const teamShareDrawers = Object.freeze([teamStrings, teamShareRowsScript,
    Object.freeze(['renderer/shell/model-library/model-library-share-send.js', 'modelLibraryShareSend']),
    Object.freeze(['renderer/shell/model-library/model-library-share-accept.js', 'modelLibraryShareAccept'])]);
  // A team project's boards in the Board tab (row 151 slice T7, D30): loaded by the Board page (board-page.js
  // `attachTeam`) through the gate's loader, so only while the `team` flag is on. The Board's own scripts are
  // renderer-board-script-manifest.js; none of these is in it.
  const teamBoard = Object.freeze([teamStrings, teamStoreScript,
    Object.freeze(['renderer/features/board/board-source-team.js', 'rendererBoardSourceTeam']),
    // The page's team half: its four parts, then the file that joins them (board-team.js, last).
    Object.freeze(['renderer/features/board/board-team-menu.js', 'rendererBoardTeamMenu']),
    Object.freeze(['renderer/features/board/board-team-chat.js', 'rendererBoardTeamChat']),
    Object.freeze(['renderer/features/board/board-team-presence.js', 'rendererBoardTeamPresence']),
    Object.freeze(['renderer/features/board/board-team-history.js', 'rendererBoardTeamHistory']),
    Object.freeze(['renderer/features/board/board-team.js', 'rendererBoardTeam']),
  ]);
  return Object.freeze(Object.assign([
    // Page renderers, in dependency order.
    Object.freeze(['renderer/shell/renderer-settings-control-tower-utils.js', 'rendererSettingsControlTowerUtils']),
    Object.freeze(['renderer/shell/renderer-settings-core-renderers.js', 'rendererSettingsCoreRenderers']),
    Object.freeze(['renderer/shell/renderer-settings-lazy-renderers.js', 'rendererSettingsLazyRenderers']),
    Object.freeze(['renderer/shell/renderer-settings-v2-surfaces.js', 'rendererSettingsV2Surfaces']),
    Object.freeze(['renderer/shell/renderer-settings-utils.js', 'rendererSettingsUtils']),
    // Section rendering and search.
    Object.freeze(['renderer/shell/renderer-settings-editor-section.js', 'rendererSettingsEditorSection']),
    Object.freeze(['renderer/shell/renderer-settings-home-section.js', 'rendererSettingsHomeSection']),
    Object.freeze(['renderer/shell/renderer-settings-notifications-section.js', 'rendererSettingsNotificationsSection']),
    Object.freeze(['renderer/shell/renderer-settings-dictation-section.js', 'rendererSettingsDictationSection']),
    // Section bindings and runtime.
    Object.freeze(['renderer/shell/renderer-settings-advanced-section.js', 'rendererSettingsAdvancedSection']),
    Object.freeze(['renderer/shell/renderer-settings-session-runtime.js', 'rendererSettingsSessionRuntime']),
    Object.freeze(['renderer/shell/renderer-settings-subagents.js', 'rendererSettingsSubagents']),
    Object.freeze(['renderer/shell/renderer-settings-section-binders.js', 'rendererSettingsSectionBinders']),
    // Settings integrations.
    Object.freeze(['renderer/shell/renderer-settings-command-sandbox.js', 'rendererSettingsCommandSandboxUtils']),
    Object.freeze(['renderer/shell/renderer-settings-conversation-transfer.js', 'rendererSettingsConversationTransfer']),
    Object.freeze(['renderer/shell/renderer-settings-cloud-models.js', 'rendererSettingsCloudModels']),
    Object.freeze(['renderer/shell/renderer-settings-api-providers-view.js', 'rendererSettingsApiProvidersView']),
    Object.freeze(['renderer/shell/renderer-settings-api-providers.js', 'rendererSettingsApiProviders']),
    Object.freeze(['renderer/shell/renderer-settings-pdf-addon.js', 'rendererSettingsPdfAddonUtils']),
    Object.freeze(['renderer/shell/renderer-settings-cli-path.js', 'rendererSettingsCliPath']),
    // Models ▸ Engines and providers: the services table and its shared Manage drawer. Owners resolve it at call time.
    Object.freeze(['renderer/shell/model-library/model-library-services.js', 'modelLibraryServices']),
    // Row 200: the Strata block (Engines row, Manage drawer, Library input) and the Tune drawer's Strata section; both resolve at call time.
    Object.freeze(['renderer/shell/model-library/model-library-strata.js', 'modelLibraryStrata']),
    Object.freeze(['renderer/shell/renderer-model-tuning-strata.js', 'rendererModelTuningStrata']),
    // GGUF folders ▸ Move and add (row 107); the folders row adds in place until it loads.
    Object.freeze(['renderer/shell/model-library/model-library-add-move.js', 'modelLibraryAddMove']),
    // llama-server builds (row 142): "Use build N" after a failed load, Get build, the runtime folders list; each stays hidden until it loads.
    Object.freeze(['renderer/shell/model-library/model-library-runtime-builds.js', 'modelLibraryRuntimeBuilds']),
    Object.freeze(['renderer/shell/model-library/model-library-runtime-folders.js', 'modelLibraryRuntimeFolders']),
    // Tune drawer ▸ Engine ▸ Drafter file and Vision rows (row 140); the rows stay hidden until it loads.
    Object.freeze(['renderer/shell/renderer-model-tuning-companions.js', 'rendererModelTuningCompanions']),
    // Image engine ▸ ComfyUI block and Model sets (row 127); kept out of the eager byte budget.
    Object.freeze(['renderer/shell/model-library/model-library-image-engine-comfyui.js', 'modelLibraryImageEngineComfyui']),
  ], { teamSection, teamTab, teamStore, teamChat, teamGate, teamShareDrawers, teamBoard }));
});
