/* Ordered Board page scripts and styles, loaded together the first time the Board tab opens (row 150, slice B4).
 * This file is itself loaded lazily by the top-nav shell; nothing here is in index.html. The workbench and
 * layout modules also appear in the Workspace's list (renderer-ide-script-manifest.js): the script loader
 * injects each file once, so whichever page opens first loads them and the other finds them there. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardScriptManifest = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const scripts = [
    // The canvas primitives (inventory), then the board rules (services/boards: placement, ops, text, then the model).
    ['renderer/inventory/canvas-surface.js', 'inventoryCanvasSurface'],
    ['renderer/inventory/note-markup.js', 'inventoryNoteMarkup'],
    ['renderer/inventory/board-card.js', 'inventoryBoardCard'],
    ['renderer/inventory/connector-layer.js', 'inventoryConnectorLayer'],
    ['services/boards/board-placement.js', 'jennyBoardPlacement'],
    ['services/boards/board-model-ops.js', 'jennyBoardModelOps'],
    ['services/boards/board-text.js', 'jennyBoardText'],
    ['services/boards/board-model.js', 'jennyBoardModel'],
    // A chain of connected cards as a row, and cards that follow their arrows (cards first, 2026-11-15): pure, shared with
    // the main process, read by Break apart and by Tidy, so it loads before board-tidy.js.
    ['services/boards/board-flow-layout.js', 'jennyBoardFlowLayout'],
    // Arranging cards in a grid (slice B9): pure, shared with the main process, read by the editor when Tidy runs.
    ['services/boards/board-tidy.js', 'jennyBoardTidy'],
    // The workbench: layout model, solver, ops, then the chrome, sash, tree, focus and drag helpers and the workbench itself.
    ['renderer/shared/workbench-layout-model.js', 'jennyWorkbenchLayoutModel'],
    ['renderer/shared/workbench-layout-solve.js', 'jennyWorkbenchLayoutSolve'],
    ['renderer/shared/workbench-layout-ops.js', 'jennyWorkbenchLayoutOps'],
    ['renderer/features/renderer-ide-workbench-chrome.js', 'rendererIdeWorkbenchChrome'],
    ['renderer/features/renderer-ide-workbench-sash.js', 'rendererIdeWorkbenchSash'],
    ['renderer/features/renderer-ide-workbench-tree.js', 'rendererIdeWorkbenchTree'],
    ['renderer/features/renderer-ide-workbench-focus.js', 'rendererIdeWorkbenchFocus'],
    ['renderer/features/renderer-ide-workbench-dnd.js', 'rendererIdeWorkbenchDnd'],
    ['renderer/features/renderer-ide-workbench.js', 'rendererIdeWorkbench'],
    // The chat dock the Board shares with the Workspace (slice C1): the picker, the scroll anchors, then the controller.
    ['renderer/features/renderer-ide-chat-session-picker.js', 'rendererIdeChatSessionPicker'],
    ['renderer/features/renderer-ide-chat-dock-anchors.js', 'rendererIdeChatDockAnchors'],
    ['renderer/features/renderer-ide-chat-dock.js', 'rendererIdeChatDock'],
    // The page, in dependency order; board-page.js is the entry point. The in-memory source (board-source-memory.js) is
    // not listed: the page makes one only for a caller that passes `allowMemorySource`, and only tests do.
    ['renderer/features/board/board-source-bridge.js', 'rendererBoardSourceBridge'],
    ['renderer/features/board/board-project.js', 'rendererBoardProject'],
    ['renderer/features/board/board-layout-store.js', 'rendererBoardLayoutStore'],
    // The outline, find, the keyboard map and the view switch (slice B5); find first, the outline reads its text helpers.
    ['renderer/features/board/board-find.js', 'rendererBoardFind'],
    // What a screen reader hears from the outline (row 150 P5): names, set sizes, movement keys, the live region.
    ['renderer/features/board/board-outline-a11y.js', 'rendererBoardOutlineA11y'],
    ['renderer/features/board/board-outline-view.js', 'rendererBoardOutlineView'],
    ['renderer/features/board/board-keyboard.js', 'rendererBoardKeyboard'],
    ['renderer/features/board/board-view-switch.js', 'rendererBoardViewSwitch'],
    // Editing (slice B6): the editor every view commands, then the canvas's own parts. The card kinds seam comes
    // before any kind module, which registers with it when it loads.
    ['renderer/features/board/board-editor.js', 'rendererBoardEditor'],
    ['renderer/features/board/board-card-kinds.js', 'rendererBoardCardKinds'],
    // Tells the main process which cards are selected, for a turn sent from the docked chat (slice C2).
    ['renderer/features/board/board-selection-report.js', 'rendererBoardSelectionReport'],
    // Picture, file and chat cards, and paste and drop (slice B7). The file chooser primitive comes first.
    ['renderer/inventory/file-input.js', 'inventoryFileInput'],
    ['renderer/features/board/board-card-media.js', 'rendererBoardCardMedia'],
    ['renderer/features/board/board-card-file.js', 'rendererBoardCardFile'],
    ['renderer/features/board/board-card-chat.js', 'rendererBoardCardChat'],
    ['renderer/features/board/board-drop-paste.js', 'rendererBoardDropPaste'],
    // Diagram cards (slice B8): the still pictures drawn by the sketch frame, then the card kind that shows them.
    ['renderer/features/board/board-card-diagram-pictures.js', 'rendererBoardCardDiagramPictures'],
    // Break apart (slice B9): the builder the diagram card reads when it loads, then the card, then the Tidy tool.
    ['renderer/features/board/board-diagram-break.js', 'rendererBoardDiagramBreak'],
    ['renderer/features/board/board-card-diagram.js', 'rendererBoardCardDiagram'],
    ['renderer/features/board/board-tidy-tool.js', 'rendererBoardTidyTool'],
    // "Ask Jenny" on the toolbar (slice C5): opens the docked chat for the selected cards.
    ['renderer/features/board/board-ask-tool.js', 'rendererBoardAskTool'],
    // Jenny's proposals (slice C3): the words, then the bar, the Changes list and the ghosts (registers on the seam).
    ['renderer/features/board/board-proposal-text.js', 'rendererBoardProposalText'],
    ['renderer/features/board/board-proposals-view.js', 'rendererBoardProposalsView'],
    ['renderer/features/board/board-card-editing.js', 'rendererBoardCardEditing'],
    ['renderer/features/board/board-canvas-toolbar.js', 'rendererBoardCanvasToolbar'],
    ['renderer/features/board/board-canvas-interactions.js', 'rendererBoardCanvasInteractions'],
    ['renderer/features/board/board-canvas-view.js', 'rendererBoardCanvasView'],
    ['renderer/features/board/board-views.js', 'rendererBoardViews'],
    ['renderer/features/board/board-list-view.js', 'rendererBoardListView'],
    // Export and Import board… (slice B10): the page reads it softly and disables both controls without it.
    ['renderer/features/board/board-export.js', 'rendererBoardExport'],
    ['renderer/features/board/board-page-workbench.js', 'rendererBoardPageWorkbench'],
    ['renderer/features/board/board-chat-dock.js', 'rendererBoardChatDock'],
    ['renderer/features/board/board-page.js', 'rendererBoardPage'],
  ].map((entry) => Object.freeze(entry));
  // The workbench's own styles (ide-workbench.css) and the list rows' are part of the main sheet already.
  scripts.styles = Object.freeze(['renderer/inventory/inventory-board.css', 'styles/board.css', 'styles/board-outline.css', 'styles/board-proposals.css']);
  return Object.freeze(scripts);
});
