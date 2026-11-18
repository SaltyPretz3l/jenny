/* A team project's files as a tree (row 175 round 2, items 1-2, owner decision D13; mockup team-files-view).
 *
 * The explorer reads `projectFiles` (team.project.files.list) a page at a time (500 rows, in path order) and folds every
 * page read so far into a tree: folders first, then files, each sorted by name; a folder says how many files it holds
 * ("so far" while a later page could still add to it), a file its size. "Show 500 more" reads the next page until the
 * list is complete; a capped host list says so once it is. States in the tree's place: loading, empty, unavailable (the
 * project page's own sentence) and failed (Try again).
 * - Keys: Up/Down/Home/End move between the drawn rows (one row holds tabindex 0), Right opens a folder or moves into
 *   it, Left folds it or moves to its folder; Enter and Space are the row's own click: a folder folds, a file opens.
 *   A file row's menu (right-click, Shift+F10, Menu) is the inventory context menu: Open preview, Copy path, Copy name.
 * - Every name and path is host text: escaped where drawn, `dir="auto"`, never markup. Nothing is logged.
 * - The renderer-team-project-file-pane.js pane draws one explorer in the Team preview column and one in the workspace
 *   panel; `snapshot()` hands the read pages to the second so it reads nothing again.
 * - `open({ teamId, projectId, path?, projectName?, from })` dispatches the bubbling `team:file-preview` event with
 *   `{ kind: 'project-files', teamId, projectId, path, projectName }` from `from` (an element in the Team view); the Team
 *   tab opens the preview column on it. The project page's Browse files uses it; a path chip can use it next round. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('./renderer-team-files'));
    return;
  }
  root.rendererTeamProjectFiles = factory(root.rendererSettingsTeamStrings, root.rendererTeamFiles);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, attachments) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const EVENT = 'team:file-preview';
  const KIND = 'project-files';
  const PAGE = 500;
  const PROJECT_ID = /^project_[A-Za-z0-9_-]{1,128}$/;
  const PATH_MAX = 1024;
  // eslint-disable-next-line no-control-regex -- a control character never names a project file.
  const CONTROL = /[\u0000-\u001f\u007f]/;
  const COPIED_MS = 1800;
  const CHEV = '<svg class="team-ftree__chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';

  function inv() { return globalThis.inventory || {}; }
  function menuApi() { return (globalThis.inventory && globalThis.inventory.contextMenu) || globalThis.inventoryContextMenu || null; }
  const tag = () => (globalThis.jennyI18n && typeof globalThis.jennyI18n.tag === 'function' ? globalThis.jennyI18n.tag() : undefined) || undefined;
  const number = (n) => Number(n || 0).toLocaleString(tag());
  const nameOf = (path) => String(path).split('/').pop();
  const parentOf = (path) => { const i = String(path).lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); };
  const byName = (a, b) => (a.name === b.name ? 0 : (a.name < b.name ? -1 : 1));
  const withAttrs = (html, attrs) => html.replace(/^(<[a-z]+)/, '$1' + Object.entries(attrs).map(([k, v]) => ' ' + k + '="' + escapeHtml(String(v)) + '"').join(''));
  const isMenuKey = (event) => event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);

  /** A relative project path as the host could list it: 1 to 1,024 characters, no control character, no `..` segment. */
  function isPath(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= PATH_MAX && !CONTROL.test(value)
      && !value.startsWith('/') && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
  }

  /** The rows read so far as a tree: `{ top, nodes }`, each folder `{ path, name, dirs: Map, files, count }` (files below). */
  function foldTree(entries) {
    const top = { path: '', name: '', dirs: new Map(), files: [], count: 0 };
    const nodes = new Map([['', top]]);
    function node(path) {
      if (nodes.has(path)) return nodes.get(path);
      const parent = node(parentOf(path));
      const made = { path, name: nameOf(path), dirs: new Map(), files: [], count: 0 };
      parent.dirs.set(made.name, made);
      nodes.set(path, made);
      return made;
    }
    for (const entry of entries) {
      if (entry.kind === 'dir') { node(entry.path); continue; }
      const home = node(parentOf(entry.path));
      home.files.push({ path: entry.path, name: nameOf(entry.path), size: entry.size });
      for (let at = home; at; at = at.path === '' ? null : nodes.get(parentOf(at.path))) at.count += 1;
    }
    return { top, nodes };
  }

  /** True while a later page (every row after `last` in path order) could still add a file under `folder`. */
  function soFar(folder, last, complete) {
    if (complete || !last) return false;
    return last.startsWith(folder + '/') || folder + '/' > last;
  }

  /** The drawn rows: folders first, then files, open folders' children after them. */
  function visibleRows(tree, expanded) {
    const out = [];
    const walk = (node, depth) => {
      for (const dir of [...node.dirs.values()].sort(byName)) {
        out.push({ kind: 'dir', path: dir.path, name: dir.name, depth, count: dir.count, open: expanded.has(dir.path) });
        if (expanded.has(dir.path)) walk(dir, depth + 1);
      }
      for (const file of [...node.files].sort(byName)) out.push({ kind: 'file', path: file.path, name: file.name, depth, size: file.size });
    };
    walk(tree.top, 0);
    return out;
  }

  // ------------------------------------------------------------ copy and the toast

  const toasts = new WeakMap(); // host element -> { el, timer }

  /** One quiet toast in `host` (the Team view's own `.team-copied` toast), replacing the one there. */
  function say(host, text) {
    if (!host || !host.ownerDocument) return;
    const held = toasts.get(host);
    if (held) { clearTimeout(held.timer); held.el.remove(); }
    const el = host.ownerDocument.createElement('div');
    el.className = 'team-copied';
    el.innerHTML = '<div class="inv-toast" role="status" aria-live="polite"><div class="inv-toast__body"><div class="inv-toast__message">' + escapeHtml(text) + '</div></div></div>';
    host.appendChild(el);
    const mine = { el, timer: setTimeout(() => { el.remove(); if (toasts.get(host) === mine) toasts.delete(host); }, COPIED_MS) };
    toasts.set(host, mine);
  }

  /** Puts `text` on the clipboard through main, then says `done` (or that it could not) in `host`. */
  async function copyText(host, text, done) {
    const view = host && host.ownerDocument && host.ownerDocument.defaultView;
    const clipboard = view && view.jennyShell && view.jennyShell.clipboard;
    let ok;
    try { ok = Boolean(clipboard && typeof clipboard.writeText === 'function') && (await clipboard.writeText(String(text)), true); } catch (_error) { ok = false; }
    say(host, ok ? done : jt('team.projectFiles.copyFailed', 'Could not copy'));
    return ok;
  }

  // ------------------------------------------------------------ the explorer

  // `call(method, payload)`: the team store's call. `onOpen(path)`: a file was activated. `onChange()`: what is drawn
  // changed (the pane redraws its head). `toastHost()`: where Copy path / Copy name say so. `seed`: another explorer's
  // `snapshot()`.
  function createExplorer({ teamId, projectId, projectName = '', call, onOpen = () => {}, onChange = () => {}, toastHost = () => null, seed = null }) {
    const s = { status: 'loading', entries: [], next: 0, total: 0, capped: false, error: null, moreError: '', busy: false,
      expanded: new Set(), selected: '', focus: '', token: 0, disposed: false };
    let tree = null;
    let host = null;
    if (seed && Array.isArray(seed.entries)) {
      Object.assign(s, { status: seed.status, entries: seed.entries.slice(), next: seed.next, total: seed.total, capped: seed.capped === true,
        error: seed.error || null, expanded: new Set(seed.expanded || []), selected: seed.selected || '', focus: seed.selected || '' });
    }
    const ids = { team_id: teamId, project_id: projectId };
    const folded = () => { if (!tree) tree = foldTree(s.entries); return tree; };

    // ------------------------------------------------------------ reading

    // A refused page: under the list for a later page, in the list's place for the first.
    function refused(answer, append) {
      const error = (answer && answer.error) || { reason: '' };
      if (append) { s.moreError = words.errorText(error); return; }
      s.status = error.reason === 'team_project_files_unavailable' ? 'unavailable' : 'failed';
      s.error = error;
    }

    function take(answer, append) {
      if (!answer || answer.ok !== true || !Array.isArray(answer.entries)) { refused(answer, append); return; }
      // A later page may come from a new walk (the host keeps one for 30 s): a path already loaded is not added twice.
      const loaded = append ? new Set(s.entries.map((entry) => entry && entry.path)) : null;
      s.entries = append ? s.entries.concat(answer.entries.filter((entry) => !loaded.has(entry && entry.path))) : answer.entries.slice();
      s.next = Number.isSafeInteger(answer.next_cursor) ? answer.next_cursor : null;
      s.total = Number(answer.total) || 0;
      s.capped = answer.capped === true;
      s.status = s.entries.length ? 'ready' : 'empty';
      s.moreError = '';
      tree = null;
    }

    async function read(append) {
      if (s.disposed || s.busy) return;
      const mine = ++s.token;
      s.busy = true;
      if (!append) { s.status = 'loading'; s.entries = []; tree = null; }
      paint();
      let answer;
      try { answer = await call('projectFiles', append ? { ...ids, cursor: s.next } : ids); } catch (_error) { answer = null; }
      if (s.disposed || mine !== s.token) return;
      s.busy = false;
      take(answer, append);
      paint();
      if (append && answer && answer.ok) focusMore();
    }
    const load = () => read(false);
    const more = () => (s.next === null ? Promise.resolve() : read(true));

    // ------------------------------------------------------------ drawing

    function stateHtml(heading, copy, extra = '', status = false) {
      return '<div class="team-ftree__state"' + (status ? ' role="status"' : '') + '>' + (heading ? '<b>' + escapeHtml(heading) + '</b>' : '')
        + escapeHtml(copy) + extra + '</div>';
    }
    function actionBtn(action, label, { disabled = false, title = label } = {}) {
      return inv().actionButton({ variant: 'secondary', size: 'sm', label, title, disabled, dataset: { 'ftree-action': action } });
    }

    function rowHtml(row, last, complete) {
      const dir = row.kind === 'dir';
      const meta = dir ? (soFar(row.path, last, complete)
        ? jt('team.projectFiles.countSoFar', '{count} files so far', { count: number(row.count) })
        : (row.count === 1 ? jt('team.projectFiles.countOne', '1 file') : jt('team.projectFiles.count', '{count} files', { count: number(row.count) })))
        : attachments.sizeText(row.size);
      const html = inv().actionButton({ plain: true, className: 'team-row team-row--link team-ftree__row', role: 'treeitem', tabIndex: row.path === s.focus ? 0 : -1,
        ariaExpanded: dir ? row.open : undefined, title: row.path, style: '--depth:' + row.depth, dataset: { 'ftree-path': row.path, 'ftree-kind': row.kind },
        trustedHtml: (dir ? CHEV : '<span class="team-ftree__gap" aria-hidden="true"></span>') + '<span class="team-row__name" dir="auto">' + escapeHtml(row.name)
          + '</span><span class="team-row__meta">' + escapeHtml(meta) + '</span>' });
      return withAttrs(html, dir ? { 'aria-level': row.depth + 1 } : { 'aria-level': row.depth + 1, 'aria-current': String(row.path === s.selected) });
    }

    function footHtml() {
      const loaded = s.entries.length;
      if (s.next !== null) {
        const count = Math.min(PAGE, Math.max(0, s.total - loaded)) || PAGE;
        return '<div class="team-ftree__foot"><p>' + escapeHtml(jt('team.projectFiles.partial', 'Showing the first {loaded} of {total} entries, in path order.',
          { loaded: number(loaded), total: number(s.total) })) + '</p>' + actionBtn('more', jt('team.projectFiles.more', 'Show {count} more', { count: number(count) }), { disabled: s.busy })
          + (s.moreError ? '<p role="status">' + escapeHtml(s.moreError) + '</p>' : '') + '</div>';
      }
      if (!s.capped) return '';
      return '<div class="team-ftree__foot"><p>' + escapeHtml(jt('team.projectFiles.capped', 'The team’s host lists the first 10,000 files. Download a copy of the project to see them all.')) + '</p></div>';
    }

    function treeHtml() {
      const rows = visibleRows(folded(), s.expanded);
      if (!rows.some((row) => row.path === s.focus)) s.focus = rows.length ? rows[0].path : '';
      const last = s.entries.length ? s.entries[s.entries.length - 1].path : '';
      const complete = s.next === null;
      const label = jt('team.projectFiles.treeLabel', 'Files in {project}', { project: projectName || jt('team.projects.unnamed', 'A project') });
      return '<div class="team-ftree" role="tree" aria-label="' + escapeHtml(label) + '">' + rows.map((row) => rowHtml(row, last, complete)).join('') + '</div>' + footHtml();
    }

    function html() {
      switch (s.status) {
        case 'loading': return stateHtml(jt('team.projectFiles.loading', 'Reading the list of files…'), '', '', true);
        case 'empty': return stateHtml(jt('team.projectFiles.empty', 'No files yet.'), jt('team.projectFiles.emptyMore', 'Files appear here when someone uploads a folder or Jenny writes one.'));
        case 'unavailable': return stateHtml('', jt('team.projects.filesUnsupported',
          'This team’s host cannot give Jenny confined access to files yet, so Jenny can talk in this project but cannot read, change, upload or download its files. Conversations and the channel work.'));
        case 'failed': return stateHtml(words.errorText(s.error), '', '<br>' + actionBtn('retry', jt('team.chat.tryAgain', 'Try again')));
        default: return treeHtml();
      }
    }

    const rowEls = () => (host ? [...host.querySelectorAll('.team-ftree__row')] : []);
    const rowByPath = (path) => rowEls().find((el) => el.dataset.ftreePath === path) || null;

    function focusRow(path) {
      const el = rowByPath(path);
      if (!el) return false;
      for (const other of rowEls()) other.tabIndex = other === el ? 0 : -1;
      s.focus = path;
      el.focus({ preventScroll: false });
      return true;
    }
    function focusMore() {
      if (!host || !host.contains(host.ownerDocument.activeElement)) return;
      const button = host.querySelector('[data-ftree-action="more"]');
      if (button) button.focus();
    }

    function paint() {
      if (!host || s.disposed) return;
      const doc = host.ownerDocument;
      const had = host.contains(doc.activeElement) && doc.activeElement !== host;
      host.innerHTML = html();
      if (had && !focusRow(s.focus)) { const first = host.querySelector('button:not([disabled])'); if (first) first.focus(); }
      onChange();
    }

    // ------------------------------------------------------------ actions

    function toggle(path, force) {
      const open = force === undefined ? !s.expanded.has(path) : force;
      if (open) s.expanded.add(path); else s.expanded.delete(path);
      s.focus = path;
      paint();
      focusRow(path);
      return true;
    }

    /** Marks `path` as the shown file and opens every folder on its way. */
    function select(path) {
      s.selected = path;
      for (let dir = parentOf(path); dir; dir = parentOf(dir)) s.expanded.add(dir);
      if (rowByPath(path) || !host) s.focus = path;
      paint();
    }

    function activate(el) {
      const path = el.dataset.ftreePath;
      if (el.dataset.ftreeKind === 'dir') { toggle(path); return; }
      s.focus = path;
      onOpen(path);
    }

    function move(el) {
      if (el) focusRow(el.dataset.ftreePath);
      return true;
    }

    // Right on a folder: open it, or step to its first child (the row after it, when that row is inside it).
    function stepIn(row, next) {
      const path = row.dataset.ftreePath;
      if (!s.expanded.has(path)) return toggle(path, true);
      return move(next && parentOf(next.dataset.ftreePath) === path ? next : null);
    }

    // Left on an open folder folds it; anywhere else it steps to the folder the row is in.
    function navigate(key, row) {
      const rows = rowEls();
      const i = rows.indexOf(row);
      const path = row.dataset.ftreePath;
      const open = row.dataset.ftreeKind === 'dir' && s.expanded.has(path);
      switch (key) {
        case 'ArrowDown': return move(rows[i + 1]);
        case 'ArrowUp': return move(rows[i - 1]);
        case 'Home': return move(rows[0]);
        case 'End': return move(rows[rows.length - 1]);
        case 'ArrowRight': return row.dataset.ftreeKind === 'dir' ? stepIn(row, rows[i + 1]) : false;
        case 'ArrowLeft': return open ? toggle(path, false) : move(rowByPath(parentOf(path)));
        default: return false;
      }
    }

    function menu(row, point) {
      const api = menuApi();
      if (!api || typeof api.show !== 'function') return;
      const path = row.dataset.ftreePath;
      const where = toastHost() || host;
      api.show({ anchorEl: point ? null : row, anchorX: point ? point.x : 0, anchorY: point ? point.y : 0, rootEl: host, restoreFocusTo: row,
        ariaLabel: jt('team.projectFiles.menuLabel', 'Actions for {name}', { name: nameOf(path) }),
        items: [
          { label: jt('team.projectFiles.openPreview', 'Open preview'), action: () => { onOpen(path); } },
          { label: jt('team.projectFiles.copyPath', 'Copy path'), action: () => { void copyText(where, path, jt('team.projectFiles.pathCopied', 'Path copied')); } },
          { label: jt('team.projectFiles.copyName', 'Copy name'), action: () => { void copyText(where, nameOf(path), jt('team.projectFiles.nameCopied', 'Name copied')); } },
        ] });
    }

    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-ftree-path], [data-ftree-action]') : null;
      if (!target || !host || !host.contains(target) || target.disabled) return;
      if (target.dataset.ftreeAction === 'more') { void more(); return; }
      if (target.dataset.ftreeAction === 'retry') { void load(); return; }
      if (target.dataset.ftreePath) activate(target);
    }
    function onKeydown(event) {
      const row = event.target && event.target.closest ? event.target.closest('.team-ftree__row') : null;
      if (!row || !host.contains(row)) return;
      if (isMenuKey(event)) {
        if (row.dataset.ftreeKind === 'file') { event.preventDefault(); menu(row, null); }
        return;
      }
      if (navigate(event.key, row)) event.preventDefault();
    }
    function onContextMenu(event) {
      const row = event.target && event.target.closest ? event.target.closest('.team-ftree__row[data-ftree-kind="file"]') : null;
      if (!row || !host.contains(row)) return;
      event.preventDefault();
      menu(row, { x: event.clientX, y: event.clientY });
    }
    const listeners = [['click', onClick], ['keydown', onKeydown], ['contextmenu', onContextMenu]];

    function unmount() {
      if (!host) return;
      for (const [type, fn] of listeners) host.removeEventListener(type, fn);
      host = null;
    }

    return {
      /** Draws into `container` (its listeners move with it); reads the first page when nothing was read yet. */
      mount(container) {
        unmount();
        if (s.disposed || !container) return;
        host = container;
        for (const [type, fn] of listeners) host.addEventListener(type, fn);
        if (s.status === 'loading' && !s.busy) void load(); else paint();
      },
      unmount,
      load,
      more,
      select,
      focusRow,
      focusSelected: () => focusRow(s.selected) || focusRow(s.focus),
      counts: () => ({ status: s.status, loaded: s.entries.length, total: s.total, complete: s.next === null }),
      snapshot: () => ({ status: s.status, entries: s.entries.slice(), next: s.next, total: s.total, capped: s.capped, error: s.error,
        expanded: [...s.expanded], selected: s.selected }),
      dispose() { if (s.disposed) return; s.disposed = true; s.token += 1; unmount(); },
    };
  }

  // ------------------------------------------------------------ the open entry

  /** The `team:file-preview` detail for a project's files (null when the ids or the path are not well formed). */
  function detailFor({ teamId, projectId, path = '', projectName = '' } = {}) {
    if (typeof teamId !== 'string' || !teamId || !PROJECT_ID.test(String(projectId)) || (path !== '' && !isPath(path))) return null;
    return { kind: KIND, teamId, projectId, path, projectName: String(projectName || '').slice(0, 200) };
  }

  /** Asks the Team view to show a project's files (and `path` in them) in its preview column; false when nothing was sent. */
  function open({ from, ...where } = {}) {
    const detail = detailFor(where);
    const view = from && from.ownerDocument && from.ownerDocument.defaultView;
    if (!detail || !view || typeof from.dispatchEvent !== 'function') return false;
    from.dispatchEvent(new view.CustomEvent(EVENT, { bubbles: true, detail }));
    return true;
  }

  return { KIND, PAGE, createExplorer, detailFor, open, foldTree, soFar, visibleRows, isPath, nameOf, parentOf, copyText, say };
});
