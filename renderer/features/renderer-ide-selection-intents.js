/* renderer/features/renderer-ide-selection-intents.js
 *
 * Editor selection actions that prefill the chat composer (Monaco-only; the
 * fallback textarea keeps the native menu). Owns the two plain "Send to Jenny"
 * actions (moved out of the controller for the 1015-line ceiling), four intent
 * actions - Explain / Fix / Refactor / Generate tests - that prepend a canned
 * instruction above the fenced selection via renderer-ide-send-utils, plus two
 * AI-native actions:
 *   - "Who changed this & why" (blame-lite): runs workspaceGit.blameRange over
 *     the selection and prepends a plain-English summary ask over the blamed
 *     commit subjects/authors/dates.
 *   - "Fix the problem under the cursor" (squiggle-fix): picks the diagnostic
 *     marker under the cursor (Problems panel shape) and sends its message plus
 *     the surrounding code range with a fix intent.
 * Both reuse the existing onSendToJenny code_selection send path; the git
 * client self-bootstraps off window.jennyShell.workspaceGit so no controller
 * wiring is required.
 *
 * Still prefill-only: every action drops text into the composer and the user
 * reviews before sending. Nothing auto-sends. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeSelectionIntents = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  // Lines of context kept on each side of a diagnostic when squiggle-fix
  // slices the surrounding code range out of the active document.
  const SQUIGGLE_CONTEXT_RADIUS = 8;

  // Resolves the pure send-utils helpers (prompt builders + the marker picker)
  // the same way the editor host resolves its siblings: injected dep first,
  // then the runtime global, then a require() fallback for the test env.
  function resolveSendUtils(deps) {
    return deps?.sendUtils
      || globalRef.rendererIdeSendUtils
      || (typeof require === 'function'
        ? (() => { try { return require('./renderer-ide-send-utils'); } catch (_error) { return null; } })()
        : null)
      || {};
  }

  // Resolves the workspace-git client factory. The client self-bootstraps off
  // window.jennyShell.workspaceGit (its own globalRef.window fallback), so no
  // controller wiring is needed - we just need the factory.
  function resolveGitClientFactory(deps) {
    return deps?.createGitClient
      || globalRef.rendererWorkspaceGitClient?.createWorkspaceGitClient
      || (typeof require === 'function'
        ? (() => {
          try { return require('./renderer-workspace-git-client').createWorkspaceGitClient; } catch (_error) { return null; }
        })()
        : null);
  }

  // Canned instructions prepended above the fenced selection in the composer.
  const INTENT_TEMPLATES = Object.freeze({
    explain: 'Explain what the following code does, step by step:',
    fix: 'Find and fix any bugs in the following code, and explain what was wrong:',
    refactor: 'Refactor the following code to be cleaner and easier to maintain, explaining each change:',
    tests: 'Write thorough unit tests for the following code:',
  });

  // contextMenuOrder 1/2 are the plain sends, 3 is the controller's word-wrap
  // toggle; the intents follow at 4-7, then blame-lite (8) and squiggle-fix (9),
  // so the "jenny" group reads top to bottom.
  const INTENT_ACTIONS = Object.freeze([
    { id: 'jenny.selection.explain', label: 'Jenny: Explain selection', intent: 'explain', order: 4 },
    { id: 'jenny.selection.fix', label: 'Jenny: Fix selection', intent: 'fix', order: 5 },
    { id: 'jenny.selection.refactor', label: 'Jenny: Refactor selection', intent: 'refactor', order: 6 },
    { id: 'jenny.selection.tests', label: 'Jenny: Generate tests for selection', intent: 'tests', order: 7 },
  ]);

  function createIdeSelectionIntents(deps) {
    const options = deps || {};
    const editorHost = options.editorHost || null;
    const isDiffTabId = typeof options.isDiffTabId === 'function' ? options.isDiffTabId : () => false;
    const onSendToJenny = typeof options.onSendToJenny === 'function' ? options.onSendToJenny : () => {};
    // Optional one-line user notice for the user-facing degrade paths (clicking
    // "Fix" with no diagnostic at the cursor; a blame that finds no history).
    // Defaults to a no-op; a controller-owning session can wire it to the IDE
    // toast so the silent degrades become discoverable.
    const onNotice = typeof options.onNotice === 'function' ? options.onNotice : () => {};

    // Pure prompt builders + the marker picker live in send-utils so this
    // module stays small. resolveSendUtils always returns an object (|| {}), so
    // default-param destructure supplies the safe fallbacks for any helper a
    // degraded build is missing.
    const {
      summarizeBlameCommits = () => [],
      buildBlameSummaryIntent = () => '',
      pickMarkerUnderCursor = () => null,
      sliceSurroundingLines = () => ({ code: '', startLine: 0, endLine: 0 }),
      buildFixSquiggleIntent = () => '',
    } = resolveSendUtils(options);

    // Lazily constructed git client (self-bootstraps off the bridge). Built on
    // first blame so the module stays inert until the action actually runs.
    const gitClientFactory = resolveGitClientFactory(options);
    let gitClientInstance = options.gitClient || null;
    function ensureGitClient() {
      if (gitClientInstance) {
        return gitClientInstance;
      }
      if (typeof gitClientFactory === 'function') {
        try { gitClientInstance = gitClientFactory(); } catch (_error) { gitClientInstance = null; }
      }
      return gitClientInstance;
    }
    // Supersession state: a rapid re-click aborts the in-flight blame so only
    // the latest action prefills. The sequence counter is the actual token
    // (correct even where AbortController is unavailable); the controller, when
    // present, additionally aborts the superseded IPC call.
    let blameAbort = null;
    let blameSeq = 0;

    // Builds + dispatches the shared "send code to Jenny" payload used by all
    // three senders. `intent` is optional - the canned (Explain/Fix/...) or
    // composed (blame/squiggle) instruction renderer-ide-send-utils prepends
    // above the fenced block. Omitting it keeps a plain send intent-free.
    function emitCodeSelection({ target, code, path, startLine, endLine, intent }) {
      const payload = {
        kind: 'code_selection',
        target: target || 'current',
        code,
        path,
        language: editorHost?.getActiveLanguageId?.() || '',
        startLine,
        endLine,
      };
      if (intent) {
        payload.intent = intent;
      }
      onSendToJenny(payload);
    }

    // Builds the send payload for the active selection (target: 'current' | 'new').
    function sendSelection(target, intent) {
      const path = editorHost?.getActivePath?.() || '';
      if (!path || isDiffTabId(path)) {
        return;
      }
      const code = editorHost.getSelectedText();
      if (!code) {
        return;
      }
      const range = editorHost.getSelectionRange() || {};
      emitCodeSelection({
        target,
        code,
        path,
        startLine: range.startLine,
        endLine: range.endLine,
        intent: intent && INTENT_TEMPLATES[intent] ? INTENT_TEMPLATES[intent] : '',
      });
    }

    // Blame-lite: summarize who last changed the selected range and why. Runs
    // workspaceGit.blameRange over the selection, dedupes to the unique commits
    // that touched it, and prefills a plain-English summary ask above the fenced
    // selection. Degrades to a no-op (returns false) when there is no path, no
    // selection, no git bridge, or the range is not tracked in HEAD.
    async function sendBlameSummary(target) {
      const path = editorHost?.getActivePath?.() || '';
      if (!path || isDiffTabId(path)) {
        return false;
      }
      const range = editorHost?.getSelectionRange?.();
      if (!range || !(Number(range.startLine) > 0)) {
        return false;
      }
      const code = editorHost?.getSelectedText?.() || '';
      if (!code.trim()) {
        return false;
      }
      const client = ensureGitClient();
      if (!client || typeof client.blameRange !== 'function') {
        // Symmetric with the no-history notice below - a silently-missing git
        // bridge is the more degraded case, so it should not be the quieter one.
        onNotice('Git is not available in this workspace.');
        return false;
      }
      // Supersede any blame still in flight; the latest click wins.
      if (blameAbort) {
        try { blameAbort.abort(); } catch (_error) { /* best-effort */ }
      }
      // Surface the in-flight state: blameRange is an async git call and the
      // composer only fills on success, so without this the action looks dead
      // while the lookup runs.
      onNotice('Looking up who changed these lines…');
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      blameAbort = controller;
      const token = ++blameSeq;
      let result;
      try {
        result = await client.blameRange({
          path,
          startLine: range.startLine,
          endLine: range.endLine,
          signal: controller ? controller.signal : null,
        });
      } catch (_error) {
        // The thin client is documented to never throw; guard anyway so an
        // injected or older client that rejects degrades cleanly instead of
        // surfacing an unhandled rejection from the editor action.
        result = null;
      }
      if (token !== blameSeq) {
        return false; // a newer blame superseded this one
      }
      blameAbort = null;
      // Covers every "no usable history" shape (bridge-unavailable ok:false,
      // call-failed ok:false, service found:false, and empty/sha-less lines).
      const commits = (result && result.ok !== false && result.found === true)
        ? summarizeBlameCommits(result.lines)
        : [];
      if (!commits.length) {
        onNotice('No git history found for these lines.');
        return false;
      }
      emitCodeSelection({
        target,
        code,
        path,
        startLine: range.startLine,
        endLine: range.endLine,
        intent: buildBlameSummaryIntent(commits, {
          path,
          startLine: range.startLine,
          endLine: range.endLine,
        }),
      });
      return true;
    }

    // Squiggle-fix: send the diagnostic under the cursor (Problems-panel marker
    // shape) plus the surrounding code with a fix intent. Degrades to a no-op
    // when there is no path, no cursor, or no marker on the cursor line.
    function sendSquiggleFix(target) {
      const path = editorHost?.getActivePath?.() || '';
      if (!path || isDiffTabId(path)) {
        return false;
      }
      const cursor = editorHost?.getCursorInfo?.();
      if (!cursor) {
        return false;
      }
      const marker = pickMarkerUnderCursor(editorHost?.getMarkers?.() || [], {
        path,
        lineNumber: cursor.lineNumber,
        column: cursor.column,
      });
      if (!marker) {
        // The action has no precondition, so it is always clickable - tell the
        // user when the cursor is not sitting on a diagnostic.
        onNotice('No problem at the cursor to fix.');
        return false;
      }
      const slice = sliceSurroundingLines(
        editorHost?.getValue?.(path) || '',
        marker.line,
        SQUIGGLE_CONTEXT_RADIUS
      );
      if (!slice.code.trim()) {
        return false;
      }
      emitCodeSelection({
        target,
        code: slice.code,
        path,
        startLine: slice.startLine,
        endLine: slice.endLine,
        intent: buildFixSquiggleIntent(marker),
      });
      return true;
    }

    function registerActions() {
      if (typeof editorHost?.addEditorAction !== 'function') {
        return;
      }
      editorHost.addEditorAction({
        id: 'jenny.send-selection.current',
        label: 'Send to Jenny — current chat',
        contextMenuGroupId: 'jenny',
        contextMenuOrder: 1,
        precondition: 'editorHasSelection',
        run: () => sendSelection('current'),
      });
      editorHost.addEditorAction({
        id: 'jenny.send-selection.new',
        label: 'Send to Jenny — new chat',
        contextMenuGroupId: 'jenny',
        contextMenuOrder: 2,
        precondition: 'editorHasSelection',
        run: () => sendSelection('new'),
      });
      for (const action of INTENT_ACTIONS) {
        editorHost.addEditorAction({
          id: action.id,
          label: action.label,
          contextMenuGroupId: 'jenny',
          contextMenuOrder: action.order,
          precondition: 'editorHasSelection',
          run: () => sendSelection('current', action.intent),
        });
      }
      // Blame-lite needs a selection (the range to blame); squiggle-fix has no
      // selection precondition - it acts on whatever marker sits at the cursor,
      // degrading silently when none does.
      editorHost.addEditorAction({
        id: 'jenny.selection.blame',
        label: 'Jenny: Who changed this & why',
        contextMenuGroupId: 'jenny',
        contextMenuOrder: 8,
        precondition: 'editorHasSelection',
        run: () => sendBlameSummary('current'),
      });
      editorHost.addEditorAction({
        id: 'jenny.selection.fix-squiggle',
        label: 'Jenny: Fix the problem under the cursor',
        contextMenuGroupId: 'jenny',
        contextMenuOrder: 9,
        run: () => sendSquiggleFix('current'),
      });
    }

    // File-path context-menu items (tree rows + tabs) that prefill the composer
    // with a path. Separate from the selection actions above (which send code);
    // lives here so the controller stays under the 1015-line ceiling.
    function buildSendToJennyMenuItems(path) {
      return [
        { separator: true },
        {
          label: 'Send to Jenny — current chat',
          action: () => onSendToJenny({ kind: 'file_path', target: 'current', path }),
        },
        {
          label: 'Send to Jenny — new chat',
          action: () => onSendToJenny({ kind: 'file_path', target: 'new', path }),
        },
      ];
    }

    return {
      buildSendToJennyMenuItems,
      registerActions,
      sendBlameSummary,
      sendSelection,
      sendSquiggleFix,
    };
  }

  return { createIdeSelectionIntents, INTENT_TEMPLATES, INTENT_ACTIONS };
});
