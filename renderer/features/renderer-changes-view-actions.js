/* renderer/features/renderer-changes-view-actions.js
 * Text actions of the chat side panel's Changes page (row 99, S3): the shared
 * panel code actions (clean copy, Ask Jenny, body menu) and find in file attached
 * to the page element that holds both the Working tree and the "This chat"
 * ledger, `[` / `]` to move between files, and the file-row menu extras.
 * The page serves many files, so each hook resolves the file of the row it is
 * given: a Working tree row by its `.file-diff[data-diff-id="wt:<path>"]`, a
 * ledger row by the detail page's current change. Also holds the small pure
 * helpers the Changes view shares (isTyping, nextItemKey).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChangesViewActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const defaultJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const TYPING_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
  const WORKING_TREE_FILE = '.file-diff[data-diff-id^="wt:"]';
  // The focusable header of a file on either page.
  const FILE_HEADERS = '[data-file-diff-toggle], .changes-history-file[data-changes-item]';
  const OPEN_FILE_EVENT = 'ide:open-file-at-line';

  function isTyping(target) {
    return Boolean(target && typeof target.closest === 'function' && target.closest(TYPING_SELECTOR));
  }

  // The key an arrow, Home or End press moves the list focus to ('' for any other key).
  function nextItemKey(keys, index, key) {
    if (key === 'ArrowDown') return keys[Math.min(keys.length - 1, index + 1)];
    if (key === 'ArrowUp') return keys[Math.max(0, index - 1)];
    if (key === 'Home') return keys[0];
    if (key === 'End') return keys[keys.length - 1];
    return '';
  }

  // The turn's current Undo / Redo button, if it has one.
  function findTurnAction(mountEl, turnId) {
    return Array.from(mountEl.querySelectorAll('[data-changes-undo], [data-changes-redo]')).find((el) => (
      el.getAttribute('data-changes-undo') === turnId || el.getAttribute('data-changes-redo') === turnId)) || null;
  }

  function scrollTurnIntoView(mountEl, turnId) {
    const block = Array.from(mountEl.querySelectorAll('[data-changes-turn-block]'))
      .find((el) => el.getAttribute('data-changes-turn-block') === turnId);
    if (block && typeof block.scrollIntoView === 'function') block.scrollIntoView({ block: 'nearest' });
  }

  // One file's hunks as unified patch text; '' when there is nothing to show.
  function buildUnifiedPatch(path, hunks) {
    const list = Array.isArray(hunks) ? hunks : [];
    if (!path || !list.length) return '';
    const parts = [`--- a/${path}`, `+++ b/${path}`];
    for (const hunk of list) {
      parts.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) parts.push(String(line));
    }
    return parts.join('\n') + '\n';
  }

  // The window-bound services the actions need; deps override them (tests).
  function resolveServices(win, deps) {
    return {
      writeClipboard: deps.writeClipboard || ((text) => win.jennyShell.clipboard.writeText(text)),
      insertIntoComposer: deps.insertIntoComposer || ((payload) => win.rendererComposerInsert.insertIntoComposer(payload)),
      showToast: deps.showToast || ((message) => win.rendererSuggestedChangesHost?.showToastMessage?.(message)),
    };
  }

  // "Copy diff" and "Ask Jenny about this file" for a file row's path menu.
  function buildFileMenuItems({ path, hunks, windowRef, panelCodeActions, ...deps }) {
    const services = resolveServices(windowRef, deps);
    const jt = deps.jt || defaultJt;
    const patch = buildUnifiedPatch(path, hunks);
    return [
      { separator: true },
      {
        label: jt('panelCode.copyDiff', 'Copy diff'),
        disabled: !patch,
        action: () => Promise.resolve().then(() => services.writeClipboard(patch))
          .catch(() => services.showToast(jt('panelCode.copyFailed', 'Couldn’t copy'))),
      },
      {
        label: jt('panelCode.askAboutFile', 'Ask Jenny about this file'),
        action: () => {
          const text = (panelCodeActions || windowRef.rendererPanelCodeActions).formatAskReference({ path });
          if (services.insertIntoComposer({ text }) === false) services.showToast(jt('panelCode.noComposer', 'Open a chat to ask Jenny'));
        },
      },
    ];
  }

  /**
   * @param {object} deps
   * @param {() => (object|null)} deps.getLedgerDetail the ledger detail page's { path, changeId, change } or null
   * @param {(path: string) => (Array|null)} deps.getWorkingTreeHunks parsed hunks of a Working tree file
   * @param {(path: string) => void} deps.openWorkingTreeFile
   * @param {(changeId: string) => void} [deps.openLedgerChange]
   * @param {object} [deps.panelCodeActions] defaults to the window's rendererPanelCodeActions
   * @param {object} [deps.panelCodeFind] defaults to the window's rendererPanelCodeFind
   * @param {object} [deps.contextMenu] @param {Function} [deps.log] @param {Function} [deps.jt]
   */
  function createChangesPageActions(deps = {}) {
    const jt = typeof deps.jt === 'function' ? deps.jt : defaultJt;
    let current = null;

    function dispose() {
      if (!current) return;
      const { pageEl, listeners, codeActions, find } = current;
      current = null;
      for (const [name, handler] of listeners) pageEl.removeEventListener(name, handler);
      codeActions.dispose();
      find.dispose();
    }

    // Each page element is attached once; a new element replaces the old attachment.
    function attach(pageEl) {
      if (current && current.pageEl === pageEl) return;
      dispose();
      const doc = pageEl.ownerDocument;
      const win = doc.defaultView;
      const services = resolveServices(win, deps);
      const codeActions = (deps.panelCodeActions || win.rendererPanelCodeActions).createPanelCodeActions({
        documentRef: doc, jt, log: deps.log, contextMenu: deps.contextMenu, ...services,
      });
      const find = (deps.panelCodeFind || win.rendererPanelCodeFind).createPanelCodeFind({
        documentRef: doc, windowRef: win, jt, textField: win.inventoryTextField, actionButton: win.inventoryActionButton,
      });

      function resolveFile(rowEl) {
        const active = doc.activeElement;
        const anchor = rowEl || (active && pageEl.contains(active) ? active : null);
        // Working tree and Whole branch rows are both `wt:` rows; only This chat reads the ledger.
        const working = pageEl.dataset.changesScope === 'working_tree' || pageEl.dataset.changesScope === 'branch';
        let fileEl = anchor ? anchor.closest(WORKING_TREE_FILE) : null;
        if (!fileEl && !rowEl && working) fileEl = pageEl.querySelector(WORKING_TREE_FILE);
        if (fileEl) return { source: 'working_tree', path: fileEl.getAttribute('data-diff-id').slice(3) };
        // A hidden ledger keeps its last detail in memory while the Working tree shows.
        const detail = working ? null : deps.getLedgerDetail();
        return detail && detail.path ? { source: 'ledger', path: detail.path, detail } : { source: '', path: '' };
      }

      const adapter = {
        kind: 'diff',
        getPath: (rowEl) => resolveFile(rowEl).path,
        getLanguageId: (rowEl) => rowEl?.querySelector('.diff-content[data-language-id]')?.getAttribute('data-language-id') || '',
        copyDiff: (rowEl) => {
          const file = resolveFile(rowEl);
          return buildUnifiedPatch(file.path, file.source === 'working_tree' ? deps.getWorkingTreeHunks(file.path) : file.detail?.change?.hunks);
        },
        // Neither open path takes a line, so the file opens at its top.
        openInIde: (_line, rowEl) => {
          const file = resolveFile(rowEl);
          if (file.source === 'working_tree') deps.openWorkingTreeFile(file.path);
          else if (file.detail?.changeId) deps.openLedgerChange?.(file.detail.changeId);
        },
        openFileAtLine: (line, rowEl) => {
          win.dispatchEvent(new win.CustomEvent(OPEN_FILE_EVENT, {
            detail: { path: resolveFile(rowEl).path, line }, bubbles: true, cancelable: true,
          }));
        },
      };

      // Runs before the shared handlers (registered after it on the same element) and
      // withholds the events that are not theirs: a text field's own Ctrl+A / Ctrl+F,
      // a menu a row or the view already opened, and the menu where there is no file.
      const onGuard = (event) => {
        if (event.type === 'contextmenu') {
          if (event.defaultPrevented || !event.target.closest('.diff-hunk')) event.stopImmediatePropagation();
          return;
        }
        const key = String(event.key || '');
        const menuKey = key === 'ContextMenu' || (key === 'F10' && event.shiftKey);
        const textKey = (event.ctrlKey || event.metaKey) && (key.toLowerCase() === 'a' || key.toLowerCase() === 'f');
        if (!menuKey && !textKey) return;
        if (isTyping(event.target) || (menuKey && (event.defaultPrevented || !resolveFile(null).path))) event.stopImmediatePropagation();
      };

      function stepFile(direction) {
        const headers = Array.from(pageEl.querySelectorAll(FILE_HEADERS));
        if (!headers.length) {
          // The ledger's detail page has no list: its Previous / Next buttons step.
          pageEl.querySelector(`[data-changes-step="${direction}"]`)?.click();
          return;
        }
        const active = doc.activeElement;
        const own = active && pageEl.contains(active)
          ? (active.closest(FILE_HEADERS) || active.closest('.file-diff')?.querySelector('[data-file-diff-toggle]'))
          : null;
        const index = headers.indexOf(own);
        const next = index < 0
          ? headers[direction > 0 ? 0 : headers.length - 1]
          : headers[Math.min(headers.length - 1, Math.max(0, index + direction))];
        next.focus();
        next.scrollIntoView({ block: 'nearest' });
      }

      const onBracket = (event) => {
        const key = event.key;
        if ((key !== '[' && key !== ']') || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || isTyping(event.target)) return;
        event.preventDefault();
        stepFile(key === ']' ? 1 : -1);
      };

      const listeners = [['contextmenu', onGuard], ['keydown', onGuard], ['keydown', onBracket]];
      for (const [name, handler] of listeners) pageEl.addEventListener(name, handler);
      codeActions.attach(pageEl, adapter);
      // Collapsed Working tree files have no rows until they are expanded, so find skips them.
      find.attach(pageEl, { rowSelector: '.diff-line', textSelector: '.diff-content' });
      current = { pageEl, listeners, codeActions, find };
    }

    return { attach, dispose };
  }

  return { buildFileMenuItems, buildUnifiedPatch, createChangesPageActions, findTurnAction, isTyping, nextItemKey, scrollTurnIntoView };
});
