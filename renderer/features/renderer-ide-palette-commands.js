/* renderer/features/renderer-ide-palette-commands.js - Workspace IDE palette rows
 * (row 82, VS Code parity; plan docs/plans/IDE_VSCODE_PARITY_2026-10-26.md
 * sections 6.1, 6.2 and 7.2 "Slice C").
 *
 * Registers the file, view, focus, problem, run and terminal rows on the command
 * registry (renderer-ide-command-registry.js). Every dependency is optional: a row
 * whose seam is missing stays registered but its `when` is false, so it never lists
 * or runs. Every run is guarded (a throw is logged, never escapes the palette or the
 * keydown dispatcher) and async results are caught. No DOM of its own: file creation
 * clicks the explorer header's existing action. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePaletteCommands = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const ACTION_WORD_WRAP = 'jenny.toggle-word-wrap';
  const REVIEW_PREFIXES = ['diff://', 'preview://', 'map://'];
  // 13 reads as "Match text size" (renderer-ide-state normalizeEditorFontSize), so zoom steps around it.
  const FONT_SIZE_BASE = 13;
  const FONT_SIZE_FALLBACK_MIN = 8;
  const FONT_SIZE_FALLBACK_MAX = 40;

  function isReviewId(id) {
    const value = String(id || '');
    return REVIEW_PREFIXES.some((prefix) => value.startsWith(prefix));
  }

  // The shared command registry (loaded before this module on the IDE manifest).
  const registryUtils = (typeof globalThis !== 'undefined' && globalThis.rendererIdeCommandRegistry) || require('./renderer-ide-command-registry');
  const { inIde } = registryUtils;

  // Root path + root-relative path, in the root's own separator style.
  function joinRootPath(rootPath, relativePath) {
    const rootText = String(rootPath || '');
    const relative = String(relativePath || '');
    if (!rootText) return '';
    const backslash = rootText.includes('\\');
    const head = rootText.replace(/[\\/]+$/, '');
    return head + (backslash ? '\\' : '/') + (backslash ? relative.replace(/\//g, '\\') : relative);
  }

  function registerIdePaletteCommands(registry, deps) {
    const d = deps || {};
    const editorHost = d.editorHost || null;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : () => {};
    const getIde = typeof d.getIde === 'function' ? d.getIde : () => ({});
    const disposers = [];
    // Session-only sticky-scroll state, used while the persisted pref does not exist yet.
    let stickySession = true;

    const logIgnored = (site, error) => registryUtils.logIgnoredCommandError(appendClientLog, site, error);
    const guarded = (site, fn) => registryUtils.guardCommand(appendClientLog, site, fn);

    function add(spec) {
      const when = typeof spec.when === 'function' ? spec.when : () => true;
      disposers.push(registry.register({
        id: spec.id,
        label: spec.label,
        group: spec.group || 'Workspace',
        description: spec.description,
        keys: spec.keys,
        when: (ctx) => inIde(ctx) && when(ctx || {}) === true,
        run: guarded(spec.id, spec.run),
      }));
    }

    const has = (value, method) => Boolean(value) && typeof value[method] === 'function';

    function activeTabId() {
      const fromHost = String(editorHost?.getActivePath?.() || '');
      return fromHost || String(getIde().activeTabPath || '');
    }

    function activeFilePath() {
      const path = activeTabId();
      return path && !isReviewId(path) ? path : '';
    }

    function openTabs() {
      return Array.isArray(getIde().openTabs) ? getIde().openTabs : [];
    }

    function groupIds() {
      const ids = new Set(['']);
      for (const tab of openTabs()) ids.add(String(tab.group || ''));
      return [...ids];
    }

    function isDirtyPath(path) {
      return getIde().dirtyByPath?.[path] === true || editorHost?.isDirty?.(path) === true;
    }

    /* ---- File ----------------------------------------------------------- */

    add({
      id: 'ide:save-all',
      label: jt('ide.paletteCommands.saveAll', 'File: Save All'),
      description: jt('ide.paletteCommands.saveAllDescription', 'Save every file with unsaved changes'),
      keys: ['ctrl+k s'],
      when: () => typeof d.saveFile === 'function',
      run: async () => {
        const paths = openTabs().map((tab) => String(tab.path || ''))
          .filter((path) => path && !isReviewId(path) && isDirtyPath(path));
        for (const path of new Set(paths)) {
          try { await d.saveFile(path); } catch (error) { logIgnored('ide:save-all', error); }
        }
      },
    });

    add({
      id: 'ide:revert-file',
      label: jt('ide.paletteCommands.revertFile', 'File: Revert File'),
      description: jt('ide.paletteCommands.revertFileDescription', 'Reload the active file from disk and discard your edits'),
      // The reload seam the Source Control discard uses: capture, reload (allowing a dirty buffer), release.
      when: (ctx) => ctx.hasActiveFile && has(d.getFileLifecycle?.(), 'reloadAfterGitDiscard'),
      run: async () => {
        const lifecycle = d.getFileLifecycle();
        const path = activeFilePath();
        const snapshot = path ? lifecycle.captureGitDiscard?.(path) : null;
        if (!snapshot) return;
        try { await lifecycle.reloadAfterGitDiscard(snapshot); } finally { lifecycle.releaseGitDiscard?.(snapshot); }
      },
    });

    function clickTreeAction(action) {
      d.showPanel?.('explorer');
      const button = d.document?.querySelector?.(`[data-ide-tree-action="${action}"]`);
      if (button && typeof button.click === 'function') button.click();
    }

    add({
      id: 'ide:new-file',
      label: jt('ide.paletteCommands.newFile', 'File: New File...'),
      description: jt('ide.paletteCommands.newFileDescription', 'Create a file in the selected folder, or at the workspace root'),
      keys: ['ctrl+n'],
      when: () => Boolean(d.document) && typeof d.showPanel === 'function',
      run: () => clickTreeAction('new-file'),
    });
    add({
      id: 'ide:new-folder',
      label: jt('ide.paletteCommands.newFolder', 'File: New Folder...'),
      description: jt('ide.paletteCommands.newFolderDescription', 'Create a folder in the selected folder, or at the workspace root'),
      when: () => Boolean(d.document) && typeof d.showPanel === 'function',
      run: () => clickTreeAction('new-folder'),
    });
    add({
      id: 'ide:open-folder',
      label: jt('ide.paletteCommands.openFolder', 'File: Open Folder...'),
      description: jt('ide.paletteCommands.openFolderDescription', 'Choose a different workspace folder'),
      keys: ['ctrl+k ctrl+o'],
      when: () => typeof d.chooseWorkspaceRoot === 'function',
      run: () => d.chooseWorkspaceRoot(),
    });
    add({
      id: 'ide:reveal-active-file',
      label: jt('ide.paletteCommands.revealActiveFile', 'File: Reveal Active File in Explorer View'),
      description: jt('ide.paletteCommands.revealActiveFileDescription', 'Show the active file in the Files tree'),
      when: (ctx) => ctx.hasActiveFile && typeof d.revealInExplorer === 'function',
      run: () => {
        const path = activeFilePath();
        if (!path) return;
        d.showPanel?.('explorer');
        d.revealInExplorer(path, { expandSelf: true });
      },
    });

    async function copyText(text, site) {
      try {
        await d.getClipboardApi().writeText(text);
        d.showToastMessage?.(jt('ide.pathMenu.copiedValue', 'Copied {value}', { value: text }), { dedupeKey: 'ide:palette:copy-path' });
      } catch (error) {
        logIgnored(site, error);
      }
    }

    const canCopy = (ctx) => ctx.hasActiveFile && has(d.getClipboardApi?.(), 'writeText');
    add({
      id: 'ide:copy-path',
      label: jt('ide.paletteCommands.copyPath', 'File: Copy Path of Active File'),
      description: jt('ide.paletteCommands.copyPathDescription', 'Copy the full path of the active file'),
      when: (ctx) => canCopy(ctx) && typeof d.getWorkspaceRoot === 'function',
      run: () => {
        const path = activeFilePath();
        const absolute = path ? joinRootPath(d.getWorkspaceRoot()?.rootPath, path) : '';
        return absolute ? copyText(absolute, 'ide:copy-path') : undefined;
      },
    });
    add({
      id: 'ide:copy-relative-path',
      label: jt('ide.paletteCommands.copyRelativePath', 'File: Copy Relative Path of Active File'),
      description: jt('ide.paletteCommands.copyRelativePathDescription', 'Copy the path of the active file relative to the workspace folder'),
      when: canCopy,
      run: () => {
        const path = activeFilePath();
        return path ? copyText(path, 'ide:copy-relative-path') : undefined;
      },
    });

    /* ---- View: close editors (the close orchestrator owns the prompts) --- */

    const closer = () => d.getCloseOrchestrator?.() || null;
    // Bulk closes act per editor group; stop when one group's close is refused or canceled.
    async function closeEveryGroup(method) {
      for (const groupId of groupIds()) {
        const result = await closer()[method](groupId);
        if (result && result.committed === false) return;
      }
    }

    add({
      id: 'ide:close-all-editors',
      label: jt('ide.paletteCommands.closeAllEditors', 'View: Close All Editors'),
      description: jt('ide.paletteCommands.closeAllEditorsDescription', 'Close every open editor tab, asking about unsaved changes'),
      keys: ['ctrl+k ctrl+w'],
      when: () => has(closer(), 'requestCloseAll'),
      run: () => closeEveryGroup('requestCloseAll'),
    });
    add({
      id: 'ide:close-other-editors',
      label: jt('ide.paletteCommands.closeOtherEditors', 'View: Close Other Editors'),
      description: jt('ide.paletteCommands.closeOtherEditorsDescription', 'Close every tab in this group except the active one'),
      when: (ctx) => (ctx.hasActiveFile || Boolean(ctx.activeKind)) && has(closer(), 'requestCloseOthers'),
      run: () => {
        const path = activeTabId();
        return path ? closer().requestCloseOthers(path) : undefined;
      },
    });
    add({
      id: 'ide:close-saved-editors',
      label: jt('ide.paletteCommands.closeSavedEditors', 'View: Close Saved Editors'),
      description: jt('ide.paletteCommands.closeSavedEditorsDescription', 'Close every tab that has no unsaved changes'),
      when: () => has(closer(), 'requestCloseSaved'),
      run: () => closeEveryGroup('requestCloseSaved'),
    });

    /* ---- View: editor display ------------------------------------------- */

    add({
      id: 'ide:toggle-word-wrap',
      label: jt('ide.paletteCommands.toggleWordWrap', 'View: Toggle Word Wrap'),
      description: jt('ide.paletteCommands.toggleWordWrapDescription', 'Wrap long lines in the editor, or stop wrapping them'),
      when: () => has(editorHost, 'runAction'),
      run: () => editorHost.runAction(ACTION_WORD_WRAP),
    });

    async function commitAndApply(key, value) {
      const result = await d.commitEditorPreference(key, value);
      if (result?.updated === false) return result;
      d.applyEditorPrefs?.();
      return result;
    }
    const canCommit = () => typeof d.commitEditorPreference === 'function';

    add({
      id: 'ide:toggle-render-whitespace',
      label: jt('ide.paletteCommands.toggleRenderWhitespace', 'View: Toggle Render Whitespace'),
      description: jt('ide.paletteCommands.toggleRenderWhitespaceDescription', 'Show or hide space and tab marks in the editor'),
      when: canCommit,
      run: () => commitAndApply('renderWhitespace', getIde().renderWhitespace === 'none' ? 'all' : 'none'),
    });

    // The persisted pref arrives with the editor-preferences slice; until then the toggle is session-only.
    add({
      id: 'ide:toggle-sticky-scroll',
      label: jt('ide.paletteCommands.toggleStickyScroll', 'View: Toggle Sticky Scroll'),
      description: jt('ide.paletteCommands.toggleStickyScrollDescription', 'Keep the current class or function header pinned at the top of the editor'),
      when: () => canCommit() || has(editorHost, 'setEditorOptions'),
      run: () => {
        const ide = getIde();
        if (canCommit() && typeof ide.stickyScroll === 'boolean') return commitAndApply('stickyScroll', !ide.stickyScroll);
        stickySession = !stickySession;
        return editorHost?.setEditorOptions?.({ stickyScroll: { enabled: stickySession } });
      },
    });

    function fontLimits() {
      const state = (typeof globalThis !== 'undefined' && globalThis.rendererIdeState) || null;
      return {
        min: Number(state?.FONT_SIZE_MIN) || FONT_SIZE_FALLBACK_MIN,
        max: Number(state?.FONT_SIZE_MAX) || FONT_SIZE_FALLBACK_MAX,
      };
    }

    // One font-size step (0 = "Match text size", read as the base size). 13 is skipped
    // because the pref normalizer reads it as "Match text size" too.
    function steppedFontSize(current, step) {
      const { min, max } = fontLimits();
      const from = Number(current) > 0 ? Number(current) : FONT_SIZE_BASE;
      let next = Math.min(max, Math.max(min, from + step));
      if (next === FONT_SIZE_BASE) next = Math.min(max, Math.max(min, next + step));
      return next;
    }

    // Labels arrive translated: the i18n scanner only reads literal keys.
    function addZoom(id, label, description, compute) {
      add({
        id,
        label,
        description,
        when: canCommit,
        run: () => commitAndApply('fontSize', compute(getIde().fontSize)),
      });
    }
    addZoom('ide:editor-zoom-in', jt('ide.paletteCommands.editorZoomIn', 'View: Zoom In (Editor Font)'),
      jt('ide.paletteCommands.editorZoomInDescription', 'Make the editor text one step larger'), (size) => steppedFontSize(size, 1));
    addZoom('ide:editor-zoom-out', jt('ide.paletteCommands.editorZoomOut', 'View: Zoom Out (Editor Font)'),
      jt('ide.paletteCommands.editorZoomOutDescription', 'Make the editor text one step smaller'), (size) => steppedFontSize(size, -1));
    addZoom('ide:editor-zoom-reset', jt('ide.paletteCommands.editorZoomReset', 'View: Reset Zoom (Editor Font)'),
      jt('ide.paletteCommands.editorZoomResetDescription', 'Put the editor text back to the default size'), () => 0);

    /* ---- Navigate: focus a view ----------------------------------------- */

    function addFocus(id, label, description, panelId) {
      add({
        id,
        group: 'Navigate',
        label,
        description,
        when: () => typeof d.showPanel === 'function',
        run: () => d.showPanel(panelId, { focus: true }),
      });
    }
    addFocus('ide:focus-terminal', jt('ide.paletteCommands.focusTerminal', 'Focus Terminal'),
      jt('ide.paletteCommands.focusTerminalDescription', 'Show the terminal and put the cursor in it'), 'terminal');
    addFocus('ide:focus-test-runner', jt('ide.paletteCommands.focusTestRunner', 'Focus Test Runner'),
      jt('ide.paletteCommands.focusTestRunnerDescription', 'Show the test runner'), 'test-runner');
    addFocus('ide:focus-chat', jt('ide.paletteCommands.focusChat', 'Focus Chat'),
      jt('ide.paletteCommands.focusChatDescription', 'Show the Workspace chat and focus it'), 'chat');

    /* ---- P7 (row 82 O1): Outline view ----------------------------------- */

    // The Outline is an optional view: the first focus adds it to the stack holding Files.
    const outlineView = () => d.getOutlineView?.() || null;
    const workbench = () => d.workbenchWiring || null;
    function showOutline(focus) {
      const wb = workbench();
      if (!(wb.listViews?.() || []).includes('outline')) wb.addView?.('outline', 'explorer');
      d.showPanel('outline', { focus });
    }
    const canShowOutline = () => Boolean(outlineView()) && typeof d.showPanel === 'function' && has(workbench(), 'addView');
    add({
      id: 'ide:focus-outline',
      group: 'Navigate',
      label: jt('ide.paletteCommands.focusOutline', 'Explorer: Focus on Outline View'),
      description: jt('ide.paletteCommands.focusOutlineDescription', 'Show the symbols of the active file and put focus in the list'),
      when: canShowOutline,
      run: () => {
        showOutline(true);
        outlineView().focus();
      },
    });
    add({
      id: 'ide:outline-collapse-all',
      label: jt('ide.paletteCommands.outlineCollapseAll', 'Outline: Collapse All'),
      description: jt('ide.paletteCommands.outlineCollapseAllDescription', 'Collapse every symbol in the Outline view'),
      when: canShowOutline,
      run: () => {
        showOutline(false);
        outlineView().collapseAll();
      },
    });

    /* ---- Problems, tasks and run ---------------------------------------- */

    add({
      id: 'ide:next-problem',
      label: jt('ide.paletteCommands.nextProblem', 'Go to Next Problem'),
      description: jt('ide.paletteCommands.nextProblemDescription', 'Jump to the next error or warning across open files'),
      keys: ['f8'],
      when: () => has(d.problemsPanel, 'nextProblem'),
      run: () => d.problemsPanel.nextProblem(),
    });
    add({
      id: 'ide:previous-problem',
      label: jt('ide.paletteCommands.previousProblem', 'Go to Previous Problem'),
      description: jt('ide.paletteCommands.previousProblemDescription', 'Jump to the previous error or warning across open files'),
      keys: ['shift+f8'],
      when: () => has(d.problemsPanel, 'previousProblem'),
      run: () => d.problemsPanel.previousProblem(),
    });
    add({
      id: 'ide:run-build-task',
      label: jt('ide.paletteCommands.runBuildTask', 'Tasks: Run Build Task'),
      description: jt('ide.paletteCommands.runBuildTaskDescription', 'Run the build script from package.json, or pick a script'),
      keys: ['ctrl+shift+b'],
      when: () => has(d.runScripts, 'runBuildTask'),
      run: () => d.runScripts.runBuildTask(),
    });
    add({
      id: 'ide:run-active-file',
      label: jt('ide.paletteCommands.runActiveFile', 'Run Active File'),
      description: jt('ide.paletteCommands.runActiveFileDescription', 'Run the active file with its language runner'),
      keys: ['ctrl+f5'],
      when: (ctx) => ctx.hasActiveFile && has(d.runScripts, 'runActiveFile'),
      run: () => d.runScripts.runActiveFile(),
    });
    add({
      id: 'ide:run-npm-script',
      label: jt('ide.paletteCommands.runNpmScript', 'Run npm Script...'),
      description: jt('ide.paletteCommands.runNpmScriptDescription', 'Pick a script from package.json and run it'),
      when: () => has(d.runScripts, 'pickAndRunScript'),
      run: () => d.runScripts.pickAndRunScript(),
    });

    /* ---- Terminal -------------------------------------------------------- */

    // The set has no "active terminal" getter: use the wired one, else the main terminal (slot 1).
    add({
      id: 'ide:kill-terminal',
      label: jt('ide.paletteCommands.killTerminal', 'Terminal: Kill the Active Terminal'),
      description: jt('ide.paletteCommands.killTerminalDescription', 'Stop the shell running in the active terminal'),
      when: () => has(d.terminals, 'closeTerminal'),
      run: () => d.terminals.closeTerminal(String(d.getActiveTerminalViewId?.() || 'terminal')),
    });

    // Terminal: Find / Clear act on the active panel (the set's panelFor; the panel
    // exposes openFind and clear, row 82 T1).
    const activeTerminalPanel = () => (has(d.terminals, 'panelFor')
      ? d.terminals.panelFor(String(d.getActiveTerminalViewId?.() || 'terminal'))
      : null);
    add({
      id: 'ide:terminal-find',
      label: jt('ide.paletteCommands.terminalFind', 'Terminal: Find'),
      description: jt('ide.paletteCommands.terminalFindDescription', "Search the active terminal's output"),
      when: () => has(activeTerminalPanel(), 'openFind'),
      run: () => activeTerminalPanel().openFind(),
    });
    add({
      id: 'ide:terminal-clear',
      label: jt('ide.paletteCommands.terminalClear', 'Terminal: Clear'),
      description: jt('ide.paletteCommands.terminalClearDescription', "Clear the active terminal's screen"),
      when: () => has(activeTerminalPanel(), 'clear'),
      run: () => activeTerminalPanel().clear(),
    });

    /* ---- P6: terminal profiles and rename (row 82 T2) -------------------- */

    // The menus anchor on the active terminal's New Terminal chevron; without the
    // listProfiles bridge (hosted) the profile rows never list.
    const profilesReady = () => has(d.terminals, 'profilesAvailable') && d.terminals.profilesAvailable() === true;
    add({
      id: 'ide:terminal-new-with-profile',
      label: jt('ide.paletteCommands.terminalNewWithProfile', 'Terminal: Create New Terminal (With Profile)'),
      description: jt('ide.paletteCommands.terminalNewWithProfileDescription', 'Pick a shell and open a new terminal with it'),
      when: () => profilesReady() && d.terminals.canAdd?.() === true,
      run: () => d.terminals.openProfileMenu({}),
    });
    add({
      id: 'ide:terminal-select-default-profile',
      label: jt('ide.paletteCommands.terminalSelectDefaultProfile', 'Terminal: Select Default Profile'),
      description: jt('ide.paletteCommands.terminalSelectDefaultProfileDescription', 'Choose the shell new terminals start with'),
      when: profilesReady,
      run: () => d.terminals.openDefaultProfileMenu({}),
    });
    add({
      id: 'ide:terminal-rename',
      label: jt('ide.paletteCommands.terminalRename', 'Terminal: Rename'),
      description: jt('ide.paletteCommands.terminalRenameDescription', 'Give the active terminal a name for this session'),
      when: () => has(d.terminals, 'renameTerminal'),
      run: () => d.terminals.renameTerminal(String(d.getActiveTerminalViewId?.() || '')),
    });
    /* ---- P4: Git (row 82 G1/G2, section 6.2) ------------------------------ */

    // The git feature's row 82 actions (renderer-ide-git-actions.js); every row needs a repo.
    const gitActions = () => d.gitFeature?.getActions?.() || null;
    // One repository row (C4): listed inside a repo while `ready()` holds.
    const repoRow = (id, label, description, ready, run, keys) => add({
      id, label, description, keys,
      when: (ctx) => ctx.isRepo === true && ready() === true,
      run,
    });
    const gitRow = (id, label, description, method, run, needsFile) => repoRow(id, label, description,
      () => (method === null || has(gitActions(), method)) && (!needsFile || Boolean(activeFilePath())), run);
    gitRow('ide:git-stage-all', jt('ide.paletteCommands.gitStageAll', 'Git: Stage All Changes'), jt('ide.paletteCommands.gitStageAllDescription', 'Stage every changed file for the next commit'), 'stageAll', () => gitActions().stageAll());
    gitRow('ide:git-unstage-all', jt('ide.paletteCommands.gitUnstageAll', 'Git: Unstage All Changes'), jt('ide.paletteCommands.gitUnstageAllDescription', 'Take every file out of the next commit'), 'unstageAll', () => gitActions().unstageAll());
    gitRow('ide:git-discard-all', jt('ide.paletteCommands.gitDiscardAll', 'Git: Discard All Changes'), jt('ide.paletteCommands.gitDiscardAllDescription', 'Return every changed file to the last commit (asks first)'), 'discardAll', () => gitActions().discardAll());
    const commitFrom = (amend) => () => {
      d.showPanel?.('source-control');
      return d.gitFeature?.commitFromPalette?.({ amend });
    };
    gitRow('ide:git-commit', jt('ide.paletteCommands.gitCommit', 'Git: Commit'), jt('ide.paletteCommands.gitCommitDescription', 'Commit the staged changes with the message in Source Control'), null, commitFrom(false));
    gitRow('ide:git-commit-amend', jt('ide.paletteCommands.gitCommitAmend', 'Git: Commit (Amend)'), jt('ide.paletteCommands.gitCommitAmendDescription', 'Rewrite the last commit, starting from its message'), 'getLastCommitMessage', commitFrom(true));
    gitRow('ide:git-open-changes', jt('ide.paletteCommands.gitOpenChanges', 'Git: Open Changes'), jt('ide.paletteCommands.gitOpenChangesDescription', 'Compare the active file with its staged version'), 'openChanges', () => gitActions().openChanges(activeFilePath()), true);
    gitRow('ide:git-open-staged-changes', jt('ide.paletteCommands.gitOpenStagedChanges', 'Git: Open Staged Changes'), jt('ide.paletteCommands.gitOpenStagedChangesDescription', 'Compare the staged version of the active file with the last commit'), 'openStagedChanges', () => gitActions().openStagedChanges(activeFilePath()), true);
    const picks = () => gitActions()?.quickpicks || null;
    const pickRow = (id, label, description, open) => repoRow(id, label, description, () => Boolean(picks()), () => open(picks()));
    pickRow('ide:git-delete-branch', jt('ide.paletteCommands.gitDeleteBranch', 'Git: Delete Branch...'), jt('ide.paletteCommands.gitDeleteBranchDescription', 'Delete a merged local branch'), (p) => p.openDeleteBranchPicker());
    pickRow('ide:git-apply-stash', jt('ide.paletteCommands.gitApplyStash', 'Git: Apply Stash...'), jt('ide.paletteCommands.gitApplyStashDescription', 'Bring back a stash and keep it in the list'), (p) => p.openStashPicker('apply'));
    pickRow('ide:git-pop-stash', jt('ide.paletteCommands.gitPopStash', 'Git: Pop Stash...'), jt('ide.paletteCommands.gitPopStashDescription', 'Bring back a stash and remove it from the list'), (p) => p.openStashPicker('pop'));
    pickRow('ide:git-drop-stash', jt('ide.paletteCommands.gitDropStash', 'Git: Drop Stash...'), jt('ide.paletteCommands.gitDropStashDescription', 'Remove a stash without applying it (asks first)'), (p) => p.openStashPicker('drop'));
    // G2: the gutter module owns the change blocks and inline blame.
    const gutter = () => d.gutterDecorations || null;
    add({
      id: 'ide:git-toggle-inline-blame',
      label: jt('ide.paletteCommands.gitToggleInlineBlame', 'Git: Toggle Inline Blame'),
      description: jt('ide.paletteCommands.gitToggleInlineBlameDescription', 'Show or hide who last changed the cursor line'),
      when: () => canCommit() && Boolean(gutter()?.inlineBlame),
      run: async () => {
        const result = await commitAndApply('inlineBlame', getIde().inlineBlame === false);
        gutter()?.inlineBlame?.refresh();
        return result;
      },
    });
    // Alt+F5 / Shift+Alt+F5 as in VS Code (cleanup G7).
    const changeRow = (id, label, description, direction, chord) => repoRow(id, label, description,
      () => Boolean(activeFilePath()) && typeof gutter()?.goToChange === 'function', () => gutter().goToChange(direction), [chord]);
    changeRow('ide:git-next-change', jt('ide.paletteCommands.gitNextChange', 'Go to Next Change'), jt('ide.paletteCommands.gitNextChangeDescription', 'Move to the next change since the last commit in this file'), 1, 'alt+f5');
    changeRow('ide:git-previous-change', jt('ide.paletteCommands.gitPreviousChange', 'Go to Previous Change'), jt('ide.paletteCommands.gitPreviousChangeDescription', 'Move to the previous change since the last commit in this file'), -1, 'shift+alt+f5');

    /* ---- Preferences ----------------------------------------------------- */

    if (typeof d.openEditorSettings === 'function') {
      add({
        id: 'ide:open-editor-settings',
        label: jt('ide.paletteCommands.openEditorSettings', 'Preferences: Open Editor Settings'),
        description: jt('ide.paletteCommands.openEditorSettingsDescription', 'Open Settings at the Editor section'),
        run: () => d.openEditorSettings(),
      });
    }

    return function dispose() {
      while (disposers.length) {
        try { disposers.pop()(); } catch (_error) { /* already unregistered */ }
      }
    };
  }

  return { registerIdePaletteCommands, joinRootPath };
});
