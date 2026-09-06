/* Builds the Scratchpad "⋯" actions menu item list for the inventory
 * context-menu primitive. Pure mapping from the injected scratchpad-actions
 * object to { label, action, disabled } descriptors — no DOM, no clipboard, no
 * shell access of its own — so it is unit-testable with a stub actions object.
 * The widget owns the textarea (selection vs whole-note scope), the clipboard
 * impl, and the feedback sink; this module only wires them to labels.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardScratchpadMenu = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function noop() {}

  // Resolve a routing call (sync result object or a Promise of one) to a single
  // feedback message, never throwing out of the menu click handler.
  function settle(result, onResult, successMessage) {
    Promise.resolve(result).then(
      (value) => {
        if (value && value.error) {
          onResult(String(value.error), true);
        } else {
          onResult(successMessage(value || {}), false);
        }
      },
      (error) => {
        onResult(String((error && error.message) || error || 'Action failed.'), true);
      }
    );
  }

  /**
   * @param {Object} opts
   * @param {Object} opts.actions - scratchpad-actions object (routing methods)
   * @param {string} opts.text - the active note's full text
   * @param {string} [opts.selection] - the current textarea selection (if any)
   * @param {string} [opts.title] - the active note's title (file-save slug)
   * @param {boolean} [opts.canSaveFile] - whether a workspace folder is open
   * @param {(text:string)=>(boolean|Promise<boolean>)} [opts.copyText] - clipboard impl
   * @param {(message:string, isError:boolean)=>void} [opts.onResult] - feedback sink
   * @returns {Array<Object>} inventoryContextMenu item descriptors
   */
  function buildScratchpadMenu(opts) {
    const o = opts || {};
    const actions = o.actions || {};
    const wholeText = String(o.text || '');
    const selection = String(o.selection || '');
    const title = String(o.title || '');
    const canSaveFile = o.canSaveFile === true;
    const copyText = typeof o.copyText === 'function' ? o.copyText : null;
    const onResult = typeof o.onResult === 'function' ? o.onResult : noop;
    // Routes the plan scopes to "selection else whole note" use this; the
    // structural routes (open loop / calendar / file) always take the whole note.
    const scoped = selection.trim() ? selection : wholeText;
    const settings = o.settings && typeof o.settings === 'object' ? o.settings : {};

    const items = [];

    if (typeof actions.updateSettings === 'function') {
      const rows = Math.max(3, Math.min(30, Math.trunc(Number(settings.rows) || 6)));
      const nextRows = rows >= 16 ? 4 : rows >= 12 ? 16 : rows >= 10 ? 12 : rows >= 8 ? 10 : rows >= 6 ? 8 : 6;
      items.push({
        label: `Font: ${settings.font === 'mono' ? 'Monospace' : 'Prose'}`,
        action: () => settle(actions.updateSettings({ font: settings.font === 'mono' ? 'prose' : 'mono' }),
          onResult, () => 'Scratchpad font saved.'),
      });
      items.push({
        label: `Height: ${rows} rows`,
        action: () => settle(actions.updateSettings({ rows: nextRows }), onResult, () => 'Scratchpad height saved.'),
      });
      items.push({
        label: settings.markdown === true ? 'Markdown preview & checklists: On' : 'Markdown preview & checklists: Off',
        action: () => settle(actions.updateSettings({ markdown: settings.markdown !== true }),
          onResult, () => 'Scratchpad preview setting saved.'),
      });
      items.push({ separator: true });
    }

    if (typeof actions.sendToChat === 'function') {
      items.push({
        label: 'Send to chat',
        action: () => settle(actions.sendToChat(scoped), onResult, () => 'Sent to chat.'),
      });
    }

    if (copyText) {
      items.push({
        label: 'Copy',
        action: () => settle(
          Promise.resolve(copyText(scoped)).then((ok) => (ok === false ? { error: 'Could not copy.' } : { ok: true })),
          onResult,
          () => 'Copied.'
        ),
      });
    }

    items.push({ separator: true });

    // Pin / unpin the active note onto the sticky-note overlay. Gated on a
    // resolved noteId (the widget passes it only when the scratchpad_pin flag is
    // on), so the item is simply absent when the feature is off.
    if (typeof actions.togglePin === 'function' && o.noteId) {
      const isPinned = o.isPinned === true;
      const disabled = !isPinned && o.pinsAtCap === true;
      items.push({
        label: isPinned ? 'Unpin note' : 'Pin note',
        disabled,
        shortcutHint: disabled ? 'Pin limit reached' : '',
        action: disabled
          ? undefined
          : () => settle(
            actions.togglePin(o.noteId),
            onResult,
            (r) => (r && r.pinned ? 'Pinned.' : 'Unpinned.')
          ),
      });
      items.push({ separator: true });
    }

    if (typeof actions.promoteToLoop === 'function') {
      items.push({
        label: 'Add to Open Loops',
        action: () => settle(actions.promoteToLoop(wholeText), onResult, () => 'Saved to Open Loops.'),
      });
    }

    if (typeof actions.createCalendarEvent === 'function') {
      items.push({
        label: 'New calendar event',
        action: () => settle(actions.createCalendarEvent(wholeText), onResult, () => 'Added to the calendar.'),
      });
    }

    if (typeof actions.saveToFile === 'function') {
      items.push({ separator: true });
      items.push({
        label: 'Save as note file',
        disabled: !canSaveFile,
        shortcutHint: canSaveFile ? '.jenny/notes' : 'Open a folder',
        action: canSaveFile
          ? () => settle(actions.saveToFile(title, wholeText), onResult, (r) => (
            r && r.path ? `Saved ${r.path}` : 'Saved to file.'
          ))
          : undefined,
      });
    }

    return items;
  }

  return { buildScratchpadMenu };
});
