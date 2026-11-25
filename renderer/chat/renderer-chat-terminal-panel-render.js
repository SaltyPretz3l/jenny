/* renderer/chat/renderer-chat-terminal-panel-render.js - the chat Terminal panel's markup and helpers (row 178, UMD).

   Pure: the header row (the tab strip and the panel's actions), the body of each state (loading, unavailable, the chat's
   project not open, empty, ended, running), the Add to message pill and the text it inserts. Every control is an
   inventory action button and every name, folder and shell goes through escapeHtml. The owner
   (renderer-chat-terminal-panel.js) paints these; the running body holds only the mount the live xterm is moved into, so
   a head re-render never touches it. Loaded lazily with the owner on the first open of the panel. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'), require('../inventory/action-button'));
    return;
  }
  root.rendererChatTerminalPanelRender = factory(root.stringUtils, root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, actionButton) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = stringUtils.escapeHtml;
  const button = (options) => (actionButton || globalThis.inventoryActionButton)(options);
  const MAX_SELECTION_CHARS = 8000;
  const svg = (paths) => `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${paths}</svg>`;
  const GLYPH = Object.freeze({
    close: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
    add: svg('<path d="M8 3v10M3 8h10"/>'),
    more: svg('<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>'),
    workspace: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 10.5h12M9 13V10.5"/>'),
  });

  /* A folder as a comparison key: slashes unified, no trailing slash, case-insensitive (Windows paths). */
  function folderKey(path) {
    return String(path || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }
  function sameFolder(a, b) {
    const left = folderKey(a);
    return left !== '' && left === folderKey(b);
  }
  function baseName(path) {
    const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  /* `{label} · {shell} · {cwd}`, leaving out what the terminal does not have yet. */
  function tabTooltip(entry) {
    return [entry.label, entry.shell, entry.cwd].filter((part) => String(part || '').trim()).join(' · ');
  }

  function tabHtml(tab, index, firstTabbable) {
    const name = String(tab.label || '');
    const close = button({ plain: true, className: 'chat-terminal-tab-close', ariaLabel: jt('chatTerminal.closeTab', 'Close {name}', { name }),
      tabIndex: -1, dataset: { 'ct-close': tab.slot }, trustedHtml: GLYPH.close });
    const dot = tab.starting ? '<span class="status-dot status-dot--active session-rail-dot-pulse" aria-hidden="true"></span>' : '';
    const tabbable = tab.selected || (firstTabbable && index === 0);
    return `<div class="chat-terminal-tab" role="tab" aria-selected="${tab.selected ? 'true' : 'false'}" tabindex="${tabbable ? 0 : -1}"`
      + ` data-ct-tab="${escapeHtml(tab.slot)}" data-value="${escapeHtml(tab.slot)}" title="${escapeHtml(tab.tooltip || name)}">`
      + `${dot}<span class="chat-terminal-tab-label" data-ct-label>${escapeHtml(name)}</span>${close}</div>`;
  }

  /* The panel's header row, shown in the side-panel chrome's title slot. model: { tabs: [{ slot, label, tooltip, starting,
     selected }] | null, canAdd, limit (the terminal limit, named in the + tooltip once reached), actions }. The chrome's own Close follows. */
  function headHtml(model) {
    const m = model || {};
    const tabs = Array.isArray(m.tabs) ? m.tabs : null;
    const anySelected = Boolean(tabs && tabs.some((tab) => tab.selected));
    let strip = '';
    if (tabs) {
      const limit = Number(m.limit);
      const addLabel = m.canAdd === true || !(limit > 0) ? jt('chatTerminal.new', 'New terminal')
        : limit === 4 ? jt('chatTerminal.limitReached', 'Four terminals is the limit. Close one to open another.')
          : jt('chatTerminal.limitReachedCount', '{count} terminals is the limit. Close one to open another.', { count: limit });
      strip = tabs.map((tab, index) => tabHtml(tab, index, !anySelected)).join('')
        + button({ plain: true, className: 'chat-terminal-add', ariaLabel: addLabel, title: addLabel,
          disabled: m.canAdd !== true, dataset: { 'ct-add': '' }, trustedHtml: GLYPH.add });
    }
    const icon = (data, label, glyph, extra) => button({ plain: true, className: 'chat-terminal-icon', ariaLabel: label, title: label, dataset: { [data]: '' }, trustedHtml: glyph, ...extra });
    const actions = m.actions ? icon('ct-more', jt('chatTerminal.more', 'Terminal menu'), GLYPH.more, { ariaHaspopup: 'menu' })
      + icon('ct-workspace', jt('chatTerminal.showInWorkspace', 'Show in Workspace'), GLYPH.workspace) : '';
    return `<div class="chat-terminal-head"><div class="chat-terminal-tabs" role="tablist" aria-label="${escapeHtml(jt('chatTerminal.tabs', 'Terminals'))}">${strip}</div>`
      + `<div class="chat-terminal-actions">${actions}</div></div>`;
  }

  const state = (kind, inner) => `<div class="chat-terminal-panel chat-terminal-state" data-ct-kind="${kind}">${inner}</div>`;

  /* One sentence and one action, no box. */
  function emptyHtml({ name, error }) {
    const title = name ? jt('chatTerminal.empty.title', 'Start a terminal in {name}', { name }) : jt('chatTerminal.empty.titleNoProject', 'Start a terminal');
    const folder = name ? '' : `<p>${escapeHtml(jt('chatTerminal.empty.startFolder', 'It opens in your terminal start folder.'))}</p>`;
    const problem = error ? `<p role="status">${escapeHtml(error)}</p>` : '';
    return state('empty', `<div class="chat-terminal-empty"><p>${escapeHtml(title)}</p>${folder}${problem}`
      + `${button({ className: 'chat-terminal-action', label: jt('chatTerminal.empty.start', 'Start terminal'), dataset: { 'ct-start': '' } })}</div>`);
  }

  function otherProjectHtml({ name }) {
    return state('other', `<div class="chat-terminal-empty"><p>${escapeHtml(jt('chatTerminal.otherProject', "This chat's project, {name}, isn't open in the Workspace.", { name }))}</p>`
      + `${button({ className: 'chat-terminal-action', label: jt('chatTerminal.openProject', 'Open {name} in the Workspace', { name }), dataset: { 'ct-open-project': '' } })}</div>`);
  }

  function endedHtml() {
    return state('ended', `<p class="chat-terminal-ended">${escapeHtml(jt('chatTerminal.ended', 'Ended: the project changed.'))} `
      + `${button({ plain: true, className: 'chat-terminal-link', label: jt('chatTerminal.startAgain', 'Start again'), dataset: { 'ct-start-again': '' } })}</p>`);
  }

  const noteHtml = (text) => `<div class="chat-terminal-empty"><p>${escapeHtml(text)}</p></div>`;

  /* The body of every state but running. kind: 'loading' | 'unavailable' | 'other' | 'empty' | 'ended'. */
  function stateHtml(kind, params) {
    if (kind === 'other') return otherProjectHtml(params || {});
    if (kind === 'empty') return emptyHtml(params || {});
    if (kind === 'ended') return endedHtml();
    return state(kind, noteHtml(kind === 'unavailable' ? jt('chatTerminal.unavailable', 'Terminals are not available here.') : jt('chatTerminal.loading', 'Loading terminals…')));
  }

  /* The running body: the mount the live terminal is moved into, the notice line and the slot of the Add to message pill. */
  function runningHtml() {
    return '<div class="chat-terminal-panel" data-ct-kind="running"><div class="chat-terminal-notice" data-ct-notice role="status"></div>'
      + '<div class="chat-terminal-mount" data-chat-terminal-mount></div><div class="chat-terminal-attach-slot" data-ct-attach-slot></div></div>';
  }

  function attachHtml() {
    return button({ plain: true, className: 'chat-terminal-attach', label: jt('chatTerminal.addToMessage', 'Add to message'), dataset: { 'ct-attach': '' } });
  }

  function noticeHtml(text) {
    return text ? escapeHtml(text) : '';
  }

  /* `{label}:` and the selection in a fenced block (a fence longer than any run of backticks inside it); trailing
     newlines trimmed, at most MAX_SELECTION_CHARS characters, cut with a final `…` line. */
  function messageText(label, selection) {
    let body = String(selection == null ? '' : selection).replace(/\r\n/g, '\n').replace(/\n+$/, '');
    if (body.length > MAX_SELECTION_CHARS) body = `${body.slice(0, MAX_SELECTION_CHARS).replace(/\n+$/, '')}\n…`;
    const longest = (body.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return [String(label || '').trim() + ':', fence + 'text', body, fence, ''].join('\n'); // a fenced block, not prose
  }

  return { MAX_SELECTION_CHARS, folderKey, sameFolder, baseName, tabTooltip, headHtml, stateHtml, runningHtml, attachHtml, noticeHtml, messageText };
});
