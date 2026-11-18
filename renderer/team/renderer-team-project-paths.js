/* Team tab: a project's paths in a conversation (row 175 round 2b: item 1, D13, item 13); one controller per conversation.
 * - Chips: a relative path the host's file list could hold (`isProjectPath`) is the local chat's chip, `.tool-path-chip` on a
 *   tool row of Jenny's work (the popover's sweep asks `adopt`) and `.chat-inline-path` on an answer's `code` span (`mark`),
 *   only while the host serves files; any other path stays text. Click, Enter or Space opens it in the explorer; right-click,
 *   Shift+F10, Menu or the hover "⋯" give Open preview, Copy path, Copy name. No IDE or Reveal: the file is on the host.
 * - The head's Files button, the box's "@" button, and "@" in the box: a picker of the project's files (read once, kept 30 s,
 *   50 shown at most, filtered as you type) that inserts the path as text.
 * `createPaths({ root, teamId, projectId, projectName(), files(), call(method, payload), field(), shell(), off })`; `off` is the
 * Board's column (no preview column to open into). Paths are host or model text: escaped where drawn, `dir="auto"`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamProjectPaths = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function load(globalName, path) {
    if (globalThis[globalName]) return globalThis[globalName];
    try { return typeof require === 'function' ? require(path) || null : null; } catch (_error) { return null; }
  }
  const escapeHtml = (load('stringUtils', '../shared/string-utils') || {}).escapeHtml;
  const explorer = () => load('rendererTeamProjectFiles', './renderer-team-project-files');
  const menuApi = () => (globalThis.inventory && globalThis.inventory.contextMenu) || globalThis.inventoryContextMenu || null;
  const actionButton = (o) => ((globalThis.inventory || 0).actionButton || require('../inventory/action-button').actionButton)(o);

  const SENSITIVE = new Set(['.git', '.github', '.vscode', '.env', '.jenny']); // the host's list
  const RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\..*)?$/iu;
  // eslint-disable-next-line no-control-regex -- the control range is the rule.
  const INVALID = /[<>"|?*:\u0000-\u001f\u007f]/u;
  const INLINE = /^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)+(?::\d+(?::\d+)?)?$/;
  const MAX = { bytes: 512, segment: 255, depth: 16, shown: 50, pages: 20, keptMs: 30_000 };
  const FOLDER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5a1 1 0 0 1 1-1h2.6l1.4 1.5h5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/></svg>';
  const bytes = (text) => new TextEncoder().encode(text).length;

  function segmentOk(name) {
    if (!name || name === '.' || name === '..' || bytes(name) > MAX.segment || INVALID.test(name) || /[. ]$/.test(name) || RESERVED.test(name)) return false;
    return !(name.length <= 32 && SENSITIVE.has(name.normalize('NFKC').toLowerCase()));
  }

  /** `value` as the relative path the host's file list would accept (`\` as `/`, no leading `./`), or ''. */
  function isProjectPath(value) {
    if (typeof value !== 'string' || (typeof value.isWellFormed === 'function' && !value.isWellFormed())) return '';
    const path = value.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!path || bytes(path) > MAX.bytes || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return '';
    const parts = path.split('/');
    return parts.length <= MAX.depth && parts.every(segmentOk) ? path : '';
  }
  const codePath = (text) => (INLINE.test(String(text)) ? isProjectPath(String(text).replace(/:\d+(?::\d+)?$/, '')) : '');

  const nameOf = (path) => path.split('/').pop();
  const dirOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
  const stop = (event) => { event.preventDefault(); event.stopPropagation(); };
  const near = (event, selector) => (event.target && event.target.closest ? event.target.closest(selector) : null);

  function createPaths(o) {
    const ids = { team_id: o.teamId, project_id: o.projectId };
    const marked = new Set();
    const pick = { open: false, index: 0, shown: [], token: null };
    const data = { list: null, status: 'loading', at: 0, reading: false, epoch: 0 };
    let menuEl = null;
    let disposed = false;
    const enabled = () => !disposed && !o.off && o.files() === true;
    const field = () => o.field();

    function stamp(el, path) {
      for (const name of el.getAttributeNames()) if (name.startsWith('data-chat-path')) el.removeAttribute(name);
      if (el.localName === 'code') el.classList.add('chat-inline-path');
      Object.entries({ 'data-team-path': path, role: 'link', tabindex: '0', title: jt('team.paths.open', 'Open {path}', { path }) }).forEach(([k, v]) => el.setAttribute(k, v));
    }

    /** True when `el` of the popover's markup is now a chip. */
    function adopt(el) {
      if (!enabled()) return false;
      let path = '';
      if (el.classList.contains('tool-path-chip') || el.classList.contains('chat-inline-path')) path = el.getAttribute('data-chat-path-kind') === 'dir' ? '' : isProjectPath(el.getAttribute('data-chat-path-open'));
      else if (el.localName === 'code' && el.closest('.chat-bubble-markdown, .team-msg__text') && !el.closest('pre, a, button')) path = codePath(el.textContent);
      if (!path) return false;
      stamp(el, path);
      return true;
    }

    /** The path-shaped `code` spans of the answers in `box` become chips. */
    function mark(box) {
      if (!box || disposed || typeof box.querySelectorAll !== 'function') return;
      marked.add(box);
      if (enabled()) box.querySelectorAll('.team-msg__text code:not([data-team-path])').forEach(adopt);
    }

    function openFile(chip) {
      const files = explorer();
      if (enabled() && files) files.open({ teamId: o.teamId, projectId: o.projectId, projectName: o.projectName(), path: chip.dataset.teamPath, from: chip });
    }

    function ensureMore(chip) {
      const shared = load('jennyWorkspacePathResolve', '../shared/workspace-path-resolve');
      if (shared && shared.ensureMoreButton) shared.ensureMoreButton(chip, jt('team.paths.more', 'More for this path'));
    }

    function menu(chip, where) {
      const api = menuApi();
      const path = chip.dataset.teamPath;
      if (!api || !api.show || !path || !enabled()) return;
      const next = chip.nextElementSibling;
      const more = next && next.classList.contains('chat-path-more') ? next : null;
      const host = o.root.querySelector('.team-conv__stage') || o.root;
      const copy = (text, done) => { if (explorer()) void explorer().copyText(host, text, done); };
      if (more) more.setAttribute('aria-expanded', 'true');
      api.show({ ...where, rootEl: o.root, restoreFocusTo: chip, onHide: () => { if (more) more.setAttribute('aria-expanded', 'false'); },
        ariaLabel: jt('team.paths.menuLabel', 'Actions for {name}', { name: nameOf(path) }),
        items: [
          { label: jt('team.paths.openPreview', 'Open preview'), action: () => { openFile(chip); } },
          { label: jt('team.paths.copyPath', 'Copy path'), action: () => { copy(path, jt('team.paths.pathCopied', 'Path copied')); } },
          { label: jt('team.paths.copyName', 'Copy name'), action: () => { copy(nameOf(path), jt('team.paths.nameCopied', 'Name copied')); } },
        ] });
    }

    function menuNode() {
      const shell = o.shell();
      if (!shell) return null;
      if (menuEl && menuEl.isConnected) return menuEl;
      menuEl = shell.ownerDocument.createElement('div');
      Object.assign(menuEl, { className: 'team-menu team-menu--mention team-menu--files', id: 'teamFilePick-' + o.projectId, hidden: true });
      menuEl.setAttribute('role', 'listbox');
      menuEl.setAttribute('aria-label', jt('team.paths.pickLabel', 'Project files'));
      shell.appendChild(menuEl);
      return menuEl;
    }

    // Names that start with `query` first, then names that hold it, then paths that do.
    function matches(query) {
      const q = query.toLowerCase();
      const ranked = [];
      for (const { path } of data.list || []) {
        const low = path.toLowerCase();
        const rank = !q || nameOf(low).startsWith(q) ? 0 : nameOf(low).includes(q) ? 1 : low.includes(q) ? 2 : -1;
        if (rank >= 0) ranked.push({ path, rank });
      }
      return ranked.sort((a, b) => a.rank - b.rank).slice(0, MAX.shown).map((entry) => entry.path);
    }
    const noteText = () => (data.status === 'failed' ? jt('team.paths.pickFailed', 'Could not read the list of files.')
      : data.list === null ? jt('team.paths.pickLoading', 'Reading the list of files…') : jt('team.paths.pickNone', 'No file matches.'));
    function render() {
      const el = menuNode();
      const input = field();
      if (!el || !input) return;
      el.hidden = !pick.open;
      if (!pick.open) {
        el.textContent = '';
        ['aria-controls', 'aria-activedescendant'].forEach((name) => input.removeAttribute(name));
        return;
      }
      pick.shown = matches(pick.token.query);
      pick.index = Math.min(pick.index, Math.max(0, pick.shown.length - 1));
      const text = (cls, value) => '<span class="' + cls + '" dir="auto">' + escapeHtml(value) + '</span>';
      el.innerHTML = pick.shown.map((path, i) => '<div class="team-row team-row--link" role="option" id="' + el.id + '-' + i + '" aria-selected="' + (i === pick.index) + '" data-team-pick="' + i + '">'
        + text('team-row__name', nameOf(path)) + (dirOf(path) ? text('team-row__note', dirOf(path)) : '') + '</div>').join('')
        + (pick.shown.length ? '' : '<div class="team-menu__note" role="status" dir="auto">' + escapeHtml(noteText()) + '</div>');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-controls', el.id);
      if (pick.shown.length) input.setAttribute('aria-activedescendant', el.id + '-' + pick.index); else input.removeAttribute('aria-activedescendant');
      const current = el.querySelector('[aria-selected="true"]');
      if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest' });
    }
    function close() {
      if (!pick.open) return;
      pick.open = false;
      render();
    }

    // The list a page at a time (500; the host stops at 10,000), shown as it grows; kept 30 s.
    async function read() {
      const now = Date.now();
      if (data.reading || (data.list !== null && now - data.at < MAX.keptMs) || (data.status === 'failed' && now - (data.failedAt || 0) < 5_000)) return;
      data.reading = true;
      const mine = (data.epoch += 1);
      // The first read shows each page as it comes; a re-read keeps the old list until the new one is whole.
      const first = data.list === null;
      let cursor;
      let entries = [];
      try {
        for (let n = 0; n < MAX.pages; n += 1) {
          const answer = await o.call('projectFiles', cursor === undefined ? ids : { ...ids, cursor });
          if (disposed || mine !== data.epoch) return;
          if (!answer || answer.ok !== true || !Array.isArray(answer.entries)) throw new Error('refused');
          entries = entries.concat(answer.entries.filter((e) => e && e.kind === 'file' && typeof e.path === 'string'));
          if (first) { Object.assign(data, { list: entries, status: 'ready', at: Date.now() }); if (pick.open) render(); }
          if (!Number.isSafeInteger(answer.next_cursor)) break;
          cursor = answer.next_cursor;
        }
        if (!first) Object.assign(data, { list: entries, status: 'ready', at: Date.now() });
      } catch (_error) { if (!entries.length) Object.assign(data, { status: 'failed', failedAt: Date.now() }); } finally { data.reading = false; }
      if (!disposed && pick.open) render();
    }

    // The "@word" at the caret (the "@" starts the text or follows a space), or null.
    function tokenAt(input) {
      const caret = input.selectionStart ?? input.value.length;
      const found = /(^|\s)@([^\s@]*)$/.exec(input.value.slice(0, caret));
      return found ? { start: caret - found[2].length - 1, end: caret, query: found[2] } : null;
    }
    function onInput() {
      const input = field();
      const token = input && enabled() && !input.closest('[hidden]') ? tokenAt(input) : null;
      if (!token) { close(); return; }
      if (!pick.open || pick.token.query !== token.query) pick.index = 0;
      Object.assign(pick, { open: true, token });
      render();
      void read();
    }
    function choose(path) {
      const input = field();
      if (!input || !pick.token || !path) return;
      const token = tokenAt(input) || pick.token;
      input.setRangeText(path + ' ', token.start, token.end, 'end');
      pick.open = false;
      render();
      typed(input);
    }
    // The field took text from here: its own input event follows (the draft is kept, the picker looks again).
    function typed(input) {
      input.focus();
      input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
    }
    function openFromButton() {
      const input = field();
      if (!input || !enabled() || input.closest('[hidden]')) return;
      const from = input.selectionStart ?? input.value.length;
      const lead = from > 0 && !/\s/.test(input.value[from - 1]) ? ' ' : '';
      input.setRangeText(lead + '@', from, input.selectionEnd ?? from, 'end');
      typed(input);
    }
    // Up/Down move, Enter/Tab choose, Esc closes; true when the key was the picker's.
    function pickerKey(event) {
      if (!pick.open || event.target !== field() || event.isComposing) return false;
      const count = pick.shown.length;
      if (event.key === 'Escape' || event.key === 'Esc') { stop(event); close(); return true; }
      if (!count) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        stop(event);
        pick.index = (pick.index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
        render();
        return true;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { stop(event); choose(pick.shown[pick.index]); return true; }
      return false;
    }

    // ---- events, on the conversation's root and before its own handlers

    const within = (el) => Boolean(el) && o.root.contains(el);
    function onClick(event) {
      const action = near(event, '[data-project-action="files-open"], [data-project-action="at-file"]');
      if (within(action)) {
        stop(event);
        if (action.disabled) return;
        if (action.dataset.projectAction === 'at-file') openFromButton();
        else if (explorer()) explorer().open({ teamId: o.teamId, projectId: o.projectId, projectName: o.projectName(), from: action });
        return;
      }
      const option = near(event, '[data-team-pick]');
      if (within(option)) { stop(event); choose(pick.shown[Number(option.dataset.teamPick)]); return; }
      const more = near(event, '.chat-path-more');
      const chip = more ? more.previousElementSibling : near(event, '[data-team-path]');
      if (!within(chip) || !chip.dataset || !chip.dataset.teamPath) return;
      stop(event);
      if (more) menu(chip, { anchorEl: more }); else openFile(chip);
    }
    function onKeydown(event) {
      if (pickerKey(event)) return;
      const chip = near(event, '[data-team-path]');
      if (!within(chip) || event.repeat) return;
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { stop(event); menu(chip, { anchorEl: chip }); return; }
      if ((event.key === 'Enter' || event.key === ' ') && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) { stop(event); openFile(chip); }
    }
    function onContextMenu(event) {
      const chip = near(event, '[data-team-path]');
      if (!within(chip)) return;
      stop(event);
      menu(chip, { anchorX: event.clientX, anchorY: event.clientY });
    }
    function onHover(event) {
      const chip = near(event, '[data-team-path]');
      if (within(chip)) ensureMore(chip);
    }
    function onInputEvent(event) { if (event.target === field()) onInput(); }
    function onFocusOut(event) {
      if (pick.open && event.target === field() && !o.shell().contains(event.relatedTarget)) close();
    }
    function onMouseDown(event) { if (near(event, '.team-menu--files')) event.preventDefault(); }

    const listeners = [['click', onClick, true], ['keydown', onKeydown, true], ['contextmenu', onContextMenu, true], ['mouseover', onHover, false], ['focusin', onHover, false],
      ['input', onInputEvent, false], ['focusout', onFocusOut, false], ['mousedown', onMouseDown, false]];
    for (const [type, handler, capture] of listeners) o.root.addEventListener(type, handler, capture);

    return {
      adopt,
      mark,
      enabled,
      /** Files switched on or off. */
      refresh() { for (const box of marked) mark(box); if (!enabled()) close(); },
      /** The head's Files button ('' on the Board); greyed with its reason while the host serves no files. */
      headButton() {
        if (o.off) return '';
        const on = enabled();
        const title = on ? jt('team.paths.filesTitle', 'Files in this project') : jt('team.paths.filesOff', 'This team’s host cannot give Jenny access to files yet');
        return '<div class="team-head__actions">' + actionButton({ plain: true, className: 'team-icon-btn', disabled: !on, title, dataset: { 'project-action': 'files-open' },
          trustedHtml: FOLDER + '<span>' + escapeHtml(jt('team.paths.files', 'Files')) + '</span>' }) + '</div>';
      },
      dispose() {
        if (disposed) return;
        for (const [type, handler, capture] of listeners) o.root.removeEventListener(type, handler, capture);
        disposed = true;
        data.epoch += 1;
        pick.open = false;
        if (menuEl) menuEl.remove();
        marked.clear();
      },
    };
  }

  return { createPaths, isProjectPath };
});
