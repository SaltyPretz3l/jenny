/* renderer/features/board/board-list-view.js - the Board's left column: the project's boards (UMD).
 *
 * The current project's name, "New board" at the top, then one row per board with the open one marked
 * and four actions: rename in place, duplicate, export (a menu the page opens, slice B10), delete. "Import board…" sits
 * beside "New board". At the cap, or with no store to keep boards in, both are disabled with the reason as their tooltip,
 * never hidden; so are Export and Import when the page says they are not available (`exportReason`, `importReason`). A
 * name from a document goes in through textContent. The view draws and asks: every change goes through the handlers,
 * which belong to the page.
 *
 * Row 151 slice T7 (team projects in the Board tab): with `teamUi.menu` the heading is a button that opens the project menu
 * (`handlers.onProjectMenu`), a team project's second line says its team, `whyNot(name)` (team scope only) disables New board, rename,
 * Duplicate and Delete with its sentence as the tooltip, and `teamUi.foot` is one more line under the count. With none of these
 * the view is what it was.
 *
 * While a name is being edited a redraw waits, so an external change cannot cancel the edit; a refused
 * name comes back as a message under the field and the field opens again with what was typed. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardListView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const NAME_MAX = 200;
  const CHEVRON = '<svg class="board-list__chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg>';
  const SVG_OPEN = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">';
  const ICONS = Object.freeze({
    rename: `${SVG_OPEN}<path d="M3 13l.6-2.8 7.2-7.2a1.4 1.4 0 0 1 2 2l-7.2 7.2z"/></svg>`,
    duplicate: `${SVG_OPEN}<rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 3.5v-.3a.7.7 0 0 0-.7-.7H3.7a.7.7 0 0 0-.7.7v6.1a.7.7 0 0 0 .7.7h.3"/></svg>`,
    delete: `${SVG_OPEN}<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>`,
    export: `${SVG_OPEN}<path d="M8 2.5v7M5 6.8 8 9.8l3-3M3 12.5h10"/></svg>`,
    plus: `${SVG_OPEN}<path d="M8 3.5v9M3.5 8h9"/></svg>`,
  });

  function createBoardListView(deps) {
    const doc = deps.document;
    const actionButton = deps.actionButton;
    const handlers = deps.handlers || {};
    const element = doc.createElement('nav');
    element.className = 'board-list';
    element.setAttribute('aria-label', jt('board.list.label', 'Boards'));
    element.setAttribute('data-board-list', '');

    const heading = doc.createElement('h2');
    heading.className = 'board-list__project';
    heading.setAttribute('data-board-project', '');
    const newHost = doc.createElement('div');
    newHost.className = 'board-list__new';
    const rows = doc.createElement('ul');
    rows.className = 'group-items board-list__rows';
    rows.setAttribute('data-board-rows', '');
    const empty = doc.createElement('p');
    empty.className = 'inv-empty-note board-list__empty';
    empty.setAttribute('data-board-list-empty', '');
    empty.hidden = true;
    const foot = doc.createElement('p');
    foot.className = 'board-list__foot';
    foot.setAttribute('data-board-count', '');
    [heading, newHost, rows, empty, foot].forEach((child) => element.appendChild(child));
    let projectButton = null; // the heading's button while the project menu is offered (kept across redraws, so its open state and focus stay)
    let projectName = null;
    let projectTeam = null;
    let teamFoot = null;

    let latest = { project: null, boards: [], openId: '', limit: 20 };
    let editing = '';
    let stale = false;
    let disposed = false;

    function iconButton(action, label, title, extra) {
      return actionButton(Object.assign({
        plain: true, className: 'board-row-action', ariaLabel: label, title, trustedHtml: ICONS[action], dataset: { 'board-action': action },
      }, extra));
    }
    // A team project's reason a control is off (board-source-team.js whyNot), or ''.
    const why = (name) => (typeof latest.whyNot === 'function' ? String(latest.whyNot(name) || '') : '');
    // An icon button that is off with its reason as the tooltip, or the plain one.
    function gated(action, name, label, title) {
      const reason = why(name);
      return iconButton(action, label, reason || title, reason ? { disabled: true } : undefined);
    }

    function buildRow(board, open) {
      const row = doc.createElement('li');
      row.className = open ? 'session-row board-row active' : 'session-row board-row';
      row.setAttribute('data-board-id', board.id);
      row.setAttribute('data-board-name', board.name);
      row.insertAdjacentHTML('beforeend', actionButton({ plain: true, className: 'session-row__open', ariaLabel: jt('board.list.open', 'Open {name}', { name: board.name }), title: board.name, dataset: { 'board-action': 'open' }, trustedHtml: '' }));
      const openButton = row.firstElementChild;
      if (open) openButton.setAttribute('aria-current', 'page');
      const title = doc.createElement('span');
      title.className = 'session-row__title';
      const text = doc.createElement('span');
      text.className = 'session-row__title-text';
      text.textContent = board.name;
      title.appendChild(text);
      openButton.appendChild(title);
      const actions = doc.createElement('span');
      actions.className = 'board-row-actions';
      actions.insertAdjacentHTML('beforeend',
        gated('rename', 'rename', jt('board.list.rename', 'Rename {name}', { name: board.name }), jt('board.list.renameTitle', 'Rename {name}', { name: board.name }))
        + gated('duplicate', 'duplicate', jt('board.list.duplicate', 'Duplicate {name}', { name: board.name }), jt('board.list.duplicateTitle', 'Duplicate {name}', { name: board.name }))
        + iconButton('export', jt('board.list.export', 'Export {name}', { name: board.name }),
          latest.exportReason || jt('board.list.exportTitle', 'Export {name}', { name: board.name }),
          { disabled: Boolean(latest.exportReason), ariaHaspopup: 'menu', ariaExpanded: false })
        + gated('delete', 'delete', jt('board.list.delete', 'Delete {name}', { name: board.name }), jt('board.list.deleteTitle', 'Delete {name}', { name: board.name })));
      row.appendChild(actions);
      return row;
    }

    // The plain heading, or (with `teamUi.menu`) the project button: its name, a team project's team, and a chevron.
    function drawHeading(project) {
      const name = project ? String(project.name || '') : '';
      if (!latest.teamUi || latest.teamUi.menu !== true) {
        projectButton = null;
        heading.textContent = name;
        return;
      }
      if (!projectButton) {
        heading.textContent = '';
        heading.insertAdjacentHTML('beforeend', actionButton({ plain: true, className: 'board-list__project-button', ariaHaspopup: 'menu', ariaExpanded: false, dataset: { 'board-action': 'project' },
          title: jt('board.list.projectTitle', 'Choose a project'),
          trustedHtml: '<span class="board-list__project-name"></span><span class="board-list__project-team" hidden></span>' + CHEVRON }));
        projectButton = heading.firstElementChild;
        projectName = projectButton.querySelector('.board-list__project-name');
        projectTeam = projectButton.querySelector('.board-list__project-team');
      }
      projectName.textContent = name;
      const team = project && project.team ? String(project.team.name || '') : '';
      projectTeam.textContent = team ? jt('board.team.teamLine', '{team} team', { team }) : '';
      projectTeam.hidden = !team;
    }

    function drawTeamFoot() {
      const text = latest.teamUi && typeof latest.teamUi.foot === 'string' ? latest.teamUi.foot : '';
      if (!text) { if (teamFoot) { teamFoot.remove(); teamFoot = null; } return; }
      if (!teamFoot) {
        teamFoot = doc.createElement('p');
        teamFoot.className = 'board-list__foot board-list__foot--team';
        teamFoot.setAttribute('data-board-team-foot', '');
        element.appendChild(teamFoot);
      }
      if (teamFoot.textContent !== text) teamFoot.textContent = text;
    }

    function draw() {
      const { project, boards, openId, limit, unavailable } = latest;
      drawHeading(project);
      const atLimit = unavailable === true || boards.length >= limit;
      const whyCreate = atLimit ? '' : why('create');
      const reason = unavailable === true
        ? jt('board.list.unavailable', 'Boards are not available right now.')
        : jt('board.list.limitReason', 'This project already has {limit} boards, the most it can hold. Delete one to add another.', { limit });
      newHost.textContent = '';
      newHost.insertAdjacentHTML('beforeend', actionButton({
        variant: 'ghost', size: 'sm', className: 'board-new-button', disabled: atLimit || Boolean(whyCreate), label: jt('board.list.new', 'New board'),
        title: atLimit ? reason : whyCreate || jt('board.list.newTitle', 'Add a board to this project'), dataset: { 'board-action': 'new' },
      }));
      const importOff = atLimit || Boolean(latest.importReason);
      newHost.insertAdjacentHTML('beforeend', actionButton({
        variant: 'ghost', size: 'sm', className: 'board-import-button', disabled: importOff, label: jt('board.list.import', 'Import board…'),
        title: atLimit ? reason : latest.importReason || jt('board.list.importTitle', 'Add a board from a .jennyboard file'), dataset: { 'board-action': 'import' },
      }));
      rows.textContent = '';
      boards.forEach((board) => rows.appendChild(buildRow(board, board.id === openId)));
      empty.textContent = jt('board.list.empty', 'No boards in this project yet.');
      empty.hidden = boards.length > 0 || unavailable === true;
      foot.textContent = atLimit ? reason : jt('board.list.count', '{count} of {limit} boards', { count: boards.length, limit });
      drawTeamFoot();
    }

    function render(next) {
      if (disposed) return;
      latest = Object.assign({}, latest, next);
      if (editing) { stale = true; return; }
      stale = false;
      // A redraw keeps keyboard focus on the same control of the same board.
      const focused = doc.activeElement && element.contains(doc.activeElement) ? doc.activeElement : null;
      const focusedRow = focused ? focused.closest('[data-board-id]') : null;
      const kept = focused ? { id: focusedRow ? focusedRow.getAttribute('data-board-id') : '', action: focused.getAttribute('data-board-action') || '' } : null;
      draw();
      if (kept && kept.action) {
        const scope = kept.id ? rowOf(kept.id) : kept.action === 'project' ? heading : newHost;
        const again = scope ? Array.from(scope.querySelectorAll('[data-board-action]')).find((node) => node.getAttribute('data-board-action') === kept.action) : null;
        if (again) again.focus({ preventScroll: true });
      }
    }

    function rowOf(id) {
      return Array.from(rows.children).find((row) => row.getAttribute('data-board-id') === id) || null;
    }

    function clearError(row) {
      const old = row && row.querySelector('[data-board-rename-error]');
      if (old) old.remove();
    }

    function endEdit() {
      editing = '';
      if (stale) render({});
    }

    // Opens the name field on a row. `error` is the model's refusal of `value`, shown under the field.
    function beginRename(id, options) {
      const row = rowOf(id);
      if (!row || (editing && editing !== id) || why('rename')) return false;
      const opts = options || {};
      const text = row.querySelector('.session-row__title-text');
      clearError(row);
      editing = id;
      const editor = deps.startInlineTitleEdit({
        titleEl: text,
        initialValue: row.getAttribute('data-board-name'),
        ariaLabel: jt('board.list.nameField', 'Board name'),
        maxLength: NAME_MAX,
        onCommit: (name) => { settleRename(id, name); },
        onCancel: () => { endEdit(); },
      });
      if (!editor) { editing = ''; return false; }
      if (opts.value !== undefined) { editor.input.value = opts.value; editor.input.select(); }
      if (opts.error) {
        const message = doc.createElement('p');
        message.className = 'board-row-error';
        message.id = `boardRenameError-${id}`;
        message.setAttribute('role', 'alert');
        message.setAttribute('data-board-rename-error', '');
        message.textContent = opts.error;
        row.appendChild(message);
        editor.input.setAttribute('aria-invalid', 'true');
        editor.input.setAttribute('aria-describedby', message.id);
      }
      return true;
    }

    async function settleRename(id, name) {
      editing = id;
      const result = typeof handlers.onRename === 'function' ? await handlers.onRename(id, name) : { ok: true };
      if (disposed) return;
      if (result && result.ok === false) {
        editing = '';
        if (!beginRename(id, { value: name, error: result.message })) endEdit();
        return;
      }
      endEdit();
    }

    function onClick(event) {
      const button = event.target && event.target.closest ? event.target.closest('[data-board-action]') : null;
      if (!button || !element.contains(button) || button.disabled) return;
      const row = button.closest('[data-board-id]');
      const id = row ? row.getAttribute('data-board-id') : '';
      switch (button.getAttribute('data-board-action')) {
        case 'project': if (typeof handlers.onProjectMenu === 'function') handlers.onProjectMenu(button); break;
        case 'new': if (typeof handlers.onCreate === 'function') handlers.onCreate(); break;
        case 'open': if (typeof handlers.onOpen === 'function') handlers.onOpen(id); break;
        case 'rename': beginRename(id); break;
        case 'duplicate': if (typeof handlers.onDuplicate === 'function') handlers.onDuplicate(id); break;
        case 'export': if (typeof handlers.onExport === 'function') handlers.onExport(id, button); break;
        case 'import': if (typeof handlers.onImport === 'function') handlers.onImport(); break;
        case 'delete': if (typeof handlers.onDelete === 'function') handlers.onDelete(id); break;
        default:
      }
    }
    function onKeyDown(event) {
      if (event.key !== 'F2' || event.defaultPrevented) return;
      const row = event.target && event.target.closest ? event.target.closest('[data-board-id]') : null;
      if (!row) return;
      event.preventDefault();
      beginRename(row.getAttribute('data-board-id'));
    }
    element.addEventListener('click', onClick);
    element.addEventListener('keydown', onKeyDown);

    return {
      element,
      render,
      beginRename,
      isEditing: () => editing !== '',
      dispose() {
        if (disposed) return;
        disposed = true;
        element.removeEventListener('click', onClick);
        element.removeEventListener('keydown', onKeyDown);
        element.remove();
      },
    };
  }

  return { createBoardListView, NAME_MAX };
});
