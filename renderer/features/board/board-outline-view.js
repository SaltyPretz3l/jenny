/* renderer/features/board/board-outline-view.js - the board as an outline (UMD): the accessible, keyboard-first form.
 *
 * The same board as a nested list in `<nav aria-label="Board outline">`: each group (alias and title), then its
 * cards, then the cards in no group, each level in reading order. Under a card, one row per connection that
 * leaves it. It is a tree for assistive technology (tree, treeitem, group, aria-level, aria-expanded on groups,
 * aria-selected from the editor) with one tab stop; the row buttons are reached by the context-menu key.
 * Keys: arrows, Home, End, a letter (type-ahead) and `*` move or open groups; Space toggles a row in the selection,
 * Shift+arrows extend it; Enter or F2 edits in place; Delete removes the selection; Ctrl+Z, Ctrl+Y, Ctrl+A (rows that
 * show), Ctrl+G; the context-menu key or Shift+F10 opens the row's menu. Every action also has a visible control,
 * disabled with its reason (never hidden) on a board that cannot be changed. Row names, row counts, the movement keys'
 * decisions and the live region that says what an action did come from board-outline-a11y.js.
 *
 * It draws once and keeps no listener on a row: the tree has one delegated listener per event kind. It follows
 * `editor.onChange`: a `board` change redraws from `editor.getBoard()` keeping focus and the open groups by id
 * (an edit in progress finishes first), a `selection` change only moves `aria-selected`. Text from a board goes
 * in through textContent and the inventory primitives, never as markup. dispose() stops everything it started. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardOutlineView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const defaultJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const DOTS = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>';
  const ARROWS = Object.freeze({ none: '—', end: '→', both: '↔' });
  const MENU_LABEL_MAX = 60;
  let instances = 0;

  function primitive(name, path) {
    if (globalThis[name]) return globalThis[name];
    if (typeof require === 'function') {
      try { return require(path); } catch (_error) { /* not loadable here */ }
    }
    return null;
  }

  function el(doc, tag, className, attrs) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    Object.keys(attrs || {}).forEach((name) => node.setAttribute(name, attrs[name]));
    return node;
  }

  function createBoardOutlineView(deps) {
    const jt = deps.jt || defaultJt;
    const doc = deps.document;
    const editor = deps.editor;
    const actionButton = deps.actionButton;
    const model = deps.model || null;
    const find = deps.find || primitive('rendererBoardFind', './board-find');
    const textField = deps.textField || primitive('inventoryTextField', '../../inventory/text-field');
    const contextMenu = deps.contextMenu || primitive('inventoryContextMenu', '../../inventory/context-menu');
    const boardCard = deps.boardCard || primitive('inventoryBoardCard', '../../inventory/board-card');
    const a11y = (deps.a11y || primitive('rendererBoardOutlineA11y', './board-outline-a11y')).createBoardOutlineA11y({ document: doc, jt });
    const prefix = `bo${++instances}`;
    const noteMax = model && model.LIMITS ? model.LIMITS.note_chars : 4000;

    const element = el(doc, 'nav', 'board-outline', { 'aria-label': jt('board.outline.label', 'Board outline'), 'data-board-outline': '' });
    const bar = el(doc, 'div', 'board-outline__bar', { role: 'group', 'aria-label': jt('board.outline.barLabel', 'Board controls') });
    const linkForm = el(doc, 'div', 'board-outline__link', { 'data-outline-link-form': '' });
    const hint = el(doc, 'p', 'board-outline__hint', { id: `${prefix}-empty`, 'data-outline-empty': '' });
    const tree = el(doc, 'ul', 'board-outline__tree', { role: 'tree', tabindex: '-1', 'aria-multiselectable': 'true', 'aria-label': jt('board.outline.tree', 'Cards and groups') });
    linkForm.hidden = true;
    hint.hidden = true;
    [bar, linkForm, hint, tree, a11y.live].forEach((node) => element.appendChild(node));

    const items = new Map(); // id -> li, groups, cards and connections alike
    const collapsed = new Set(); // ids of closed groups
    const kinds = new Map();
    let shown = null;
    let matches = null;
    let focusedId = '';
    let editing = null; // { id, finish }
    let stale = false;
    let disposed = false;

    // ------------------------------------------------------------------ small helpers

    function holder(html) { const box = el(doc, 'div'); box.insertAdjacentHTML('beforeend', html); return box.firstElementChild; }
    const readOnlyReason = () => jt('board.outline.readOnly', 'This board cannot be changed.');
    const canEdit = () => editor.canEdit() === true;

    function kindInfo(kind) {
      if (!kinds.has(kind)) {
        const sample = boardCard ? boardCard({ id: 'sample', kind }, { document: doc }) : null;
        kinds.set(kind, { label: sample ? sample.getAttribute('aria-label') || kind : kind, glyph: sample ? sample.querySelector('.inv-board-card-kind svg') : null });
      }
      return kinds.get(kind);
    }

    function describe(card) { return find.cardText(card) || kindInfo(card.kind).label; }
    const idOf = (node) => { const li = node && node.closest ? node.closest('li[role="treeitem"]') : null; return li ? li.getAttribute('data-outline-id') : ''; };
    const kindOf = (id) => (items.has(id) ? items.get(id).getAttribute('data-outline-kind') : '');
    const nameOf = (id) => { const item = shown && (shown.cards[id] || shown.groups[id]); return item ? item.alias || kindInfo(item.kind || 'group').label : ''; };
    // The editor commands that say what they did once the editor says they went through (a refusal is the editor's to tell).
    const cmd = a11y.actions(editor, { nameOf, titleOf: (groupId) => shown.groups[groupId].title, alive: () => !disposed });

    const visibleItems = () => Array.from(tree.querySelectorAll('li[role="treeitem"]')).filter((li) => !li.closest('[hidden]'));

    // ------------------------------------------------------------------ drawing

    function actionTemplates() {
      const more = holder(actionButton({ plain: true, className: 'board-outline__act board-outline__act--more', trustedHtml: DOTS, tabIndex: -1, ariaLabel: jt('board.outline.more', 'More actions'), title: jt('board.outline.more', 'More actions'), dataset: { 'outline-act': 'more' } }));
      const text = (act, label) => holder(actionButton({ variant: 'ghost', size: 'sm', className: 'board-outline__act', label, tabIndex: -1, dataset: { 'outline-act': act } }));
      return { more, rename: text('rename', jt('board.outline.rename', 'Rename')), ungroup: text('ungroup', jt('board.outline.ungroup', 'Ungroup')), remove: text('remove', jt('board.outline.remove', 'Remove')) };
    }

    function rowShell(spec) {
      const li = el(doc, 'li', `board-outline__item board-outline__item--${spec.kind}`, {
        role: 'treeitem', tabindex: '-1', 'aria-level': String(spec.level), 'aria-selected': 'false', 'aria-label': spec.name, 'data-outline-id': spec.id, 'data-outline-kind': spec.kind,
      });
      const row = el(doc, 'div', 'board-outline__row');
      const label = el(doc, 'span', 'board-outline__label');
      // Plain spaces between the parts keep the row's name readable as words (flex items ignore them on screen).
      if (spec.lead) { label.appendChild(el(doc, 'span', 'sr-only')).textContent = spec.lead; label.appendChild(doc.createTextNode(' ')); }
      const text = el(doc, 'span', 'board-outline__text');
      text.textContent = spec.text;
      label.appendChild(text);
      if (spec.alias) { const alias = el(doc, 'span', 'board-outline__alias'); alias.textContent = spec.alias; label.appendChild(doc.createTextNode(' ')); label.appendChild(alias); }
      if (spec.glyph) row.appendChild(el(doc, 'span', 'board-outline__glyph', { 'aria-hidden': 'true' })).appendChild(spec.glyph.cloneNode(true));
      row.appendChild(label);
      const acts = el(doc, 'span', 'board-outline__acts');
      (spec.buttons || []).forEach(([template, name, hintText]) => {
        const button = template.cloneNode(true);
        if (name) button.setAttribute('aria-label', name);
        button.setAttribute('data-outline-hint', hintText || name || button.getAttribute('title') || '');
        button.title = button.getAttribute('data-outline-hint');
        acts.appendChild(button);
      });
      row.appendChild(acts);
      if (spec.about) a11y.describe(li, row, spec.about, `${prefix}-${items.size}`); // the connections that leave a card, read after its name
      li.appendChild(row);
      items.set(spec.id, li);
      return li;
    }

    function connectionItem(connector, other, level, tpl) {
      const name = other.alias || kindInfo(other.kind).label;
      const li = rowShell({
        id: connector.id, kind: 'connector', level, text: `${connector.label ? `${connector.label} · ` : ''}${describe(other)}`, alias: other.alias || '',
        lead: a11y.connectsTo, name: a11y.connectionName(other.alias, describe(other), connector.label),
        buttons: [[tpl.remove, jt('board.outline.removeConnection', 'Remove connection to {name}', { name }), jt('board.outline.removeConnectionTitle', 'Remove this connection')]],
      });
      li.querySelector('.board-outline__row').insertBefore(el(doc, 'span', 'board-outline__arrow', { 'aria-hidden': 'true' }), li.querySelector('.board-outline__label')).textContent = ARROWS[connector.ends] || ARROWS.end;
      return li;
    }

    function cardItem(card, level, outgoing, board, tpl) {
      const info = kindInfo(card.kind);
      const name = card.alias || info.label;
      const links = outgoing.get(card.id) || [];
      const li = rowShell({
        id: card.id, kind: 'card', level, text: describe(card), alias: card.alias || '', lead: info.label, glyph: info.glyph,
        name: a11y.cardName(card, info.label, find.cardText(card), card.alias, ''),
        about: a11y.connections(links, board.cards, describe),
        buttons: [[tpl.more, jt('board.outline.moreFor', 'More actions for {name}', { name }), jt('board.outline.more', 'More actions')]],
      });
      li.setAttribute('data-outline-card-kind', card.kind);
      if (links.length) {
        const list = el(doc, 'ul', 'board-outline__children', { role: 'group' });
        links.forEach((connector) => list.appendChild(connectionItem(connector, board.cards[connector.to], level + 1, tpl)));
        li.appendChild(list);
      }
      return li;
    }

    function groupItem(group, members, outgoing, board, tpl) {
      const closed = collapsed.has(group.id);
      const li = rowShell({
        id: group.id, kind: 'group', level: 1, text: group.title, alias: group.alias || '', lead: kindInfo('group').label, glyph: kindInfo('group').glyph,
        name: a11y.cardName(null, kindInfo('group').label, group.title, group.alias, a11y.groupTail(members.length)),
        buttons: [[tpl.rename, jt('board.outline.renameGroup', 'Rename {name}', { name: group.title }), jt('board.outline.renameTitle', 'Rename this group')],
          [tpl.ungroup, jt('board.outline.ungroupGroup', 'Ungroup {name}', { name: group.title }), jt('board.outline.ungroupTitle', 'Take the cards out of this group')]],
      });
      li.setAttribute('aria-expanded', closed ? 'false' : 'true');
      li.querySelector('.board-outline__row').insertBefore(el(doc, 'span', 'board-outline__caret', { 'aria-hidden': 'true', 'data-outline-toggle': '' }), li.querySelector('.board-outline__row').firstChild);
      const list = el(doc, 'ul', 'board-outline__children', { role: 'group' });
      list.hidden = closed;
      members.forEach((card) => list.appendChild(cardItem(card, 2, outgoing, board, tpl)));
      li.appendChild(list);
      return li;
    }

    function build(board) {
      const cards = Object.values(board.cards || {}).sort(find.readingCompare);
      const groups = Object.values(board.groups || {}).sort(find.readingCompare);
      const outgoing = new Map();
      Object.values(board.connectors || {}).forEach((connector) => {
        if (!board.cards[connector.from] || !board.cards[connector.to]) return;
        if (!outgoing.has(connector.from)) outgoing.set(connector.from, []);
        outgoing.get(connector.from).push(connector);
      });
      outgoing.forEach((list) => list.sort((a, b) => find.readingCompare(board.cards[a.to], board.cards[b.to]) || (a.id < b.id ? -1 : 1)));
      const members = new Map(groups.map((group) => [group.id, []]));
      const loose = [];
      cards.forEach((card) => (members.has(card.group_id) ? members.get(card.group_id) : loose).push(card));
      const tpl = actionTemplates();
      const frag = doc.createDocumentFragment();
      groups.forEach((group) => frag.appendChild(groupItem(group, members.get(group.id), outgoing, board, tpl)));
      loose.forEach((card) => frag.appendChild(cardItem(card, 1, outgoing, board, tpl)));
      return frag;
    }

    function draw(board) {
      if (disposed) return;
      shown = board || null;
      const active = doc.activeElement;
      const hadFocus = Boolean(active) && tree.contains(active);
      const keep = hadFocus ? idOf(active) : '';
      const next = hadFocus ? a11y.fallbackOrder(visibleItems().map((li) => li.getAttribute('data-outline-id')), keep) : []; // if the row is gone: the rows after it, then before
      items.clear();
      tree.textContent = '';
      if (shown) {
        Array.from(collapsed).forEach((id) => { if (!shown.groups || !shown.groups[id]) collapsed.delete(id); });
        tree.appendChild(build(shown));
      }
      refreshSelection();
      applyMatches();
      updateControls();
      const stop = settleStop(keep || focusedId);
      if (hadFocus) {
        const target = [keep].concat(next).map((id) => items.get(id)).find((li) => li && !li.closest('[hidden]')) || stop;
        if (target) { setStop(target); target.focus({ preventScroll: true }); } else tree.focus({ preventScroll: true });
      }
    }

    function applyMatches() {
      const groups = [];
      items.forEach((li, id) => {
        const kind = li.getAttribute('data-outline-kind');
        if (kind === 'card') li.hidden = !(matches === null || matches.has(id));
        else if (kind === 'group') groups.push(li); // after the cards: a group stays while one of its cards does
      });
      groups.forEach((li) => {
        li.hidden = !(matches === null || matches.has(li.getAttribute('data-outline-id')) || Array.from(li.querySelectorAll('li[data-outline-kind="card"]')).some((child) => !child.hidden));
      });
      const any = visibleItems().length > 0;
      hint.textContent = matches !== null && shown && Object.keys(shown.cards || {}).length + Object.keys(shown.groups || {}).length > 0
        ? jt('board.outline.noMatches', 'No cards match.')
        : jt('board.outline.empty', 'This board is empty. Choose Add note or Add link, or ask Jenny to lay something out.');
      hint.hidden = !shown || any;
      if (hint.hidden) tree.removeAttribute('aria-describedby'); else tree.setAttribute('aria-describedby', hint.id);
      a11y.setSizes(tree);
      if (focusedId) settleStop(focusedId);
    }

    function refreshSelection() {
      const connector = cmd.selectedConnector();
      items.forEach((li, id) => {
        const on = li.getAttribute('data-outline-kind') === 'connector' ? connector === id : editor.isSelected(id);
        const value = on ? 'true' : 'false';
        if (li.getAttribute('aria-selected') !== value) li.setAttribute('aria-selected', value);
      });
    }

    // ------------------------------------------------------------------ the one tab stop

    function setStop(li) {
      const old = tree.querySelector('li[tabindex="0"]');
      if (old && old !== li) old.tabIndex = -1;
      if (li) { li.tabIndex = 0; focusedId = li.getAttribute('data-outline-id'); }
    }

    function settleStop(preferred) {
      const wanted = items.get(preferred);
      const li = wanted && !wanted.closest('[hidden]') ? wanted : visibleItems()[0] || null;
      setStop(li);
      return li;
    }

    function focusRow(id) {
      let li = items.get(id);
      if (!li) return false;
      for (let node = li.parentElement && li.parentElement.closest('li[role="treeitem"]'); node; node = node.parentElement && node.parentElement.closest('li[role="treeitem"]')) {
        if (node.getAttribute('aria-expanded') === 'false') toggleGroup(node.getAttribute('data-outline-id'), true);
      }
      li = items.get(id);
      if (li.closest('[hidden]')) return false;
      setStop(li);
      li.focus();
      return true;
    }

    function toggleGroup(id, open) {
      const li = items.get(id);
      if (!li || li.getAttribute('data-outline-kind') !== 'group') return;
      const next = open === undefined ? li.getAttribute('aria-expanded') !== 'true' : open;
      li.setAttribute('aria-expanded', next ? 'true' : 'false');
      if (li.lastElementChild && li.lastElementChild.tagName === 'UL') li.lastElementChild.hidden = !next;
      if (next) collapsed.delete(id); else collapsed.add(id);
      if (!next && focusedId !== id && li.contains(items.get(focusedId))) {
        const hadFocus = li.contains(doc.activeElement);
        setStop(li);
        if (hadFocus) li.focus({ preventScroll: true });
      }
    }

    // ------------------------------------------------------------------ edit in place

    function editSpec(id) {
      const kind = kindOf(id);
      if (kind === 'group' && shown.groups[id]) {
        return { value: shown.groups[id].title, multiline: false, required: true, max: 200, label: jt('board.outline.groupField', 'Group title'), save: (value) => editor.editGroup(id, { title: value }) };
      }
      const card = kind === 'card' ? shown.cards[id] : null;
      if (card && card.kind === 'note') {
        return { value: (card.data || {}).text || '', multiline: true, required: false, max: noteMax, label: jt('board.outline.noteField', 'Note text'), hint: jt('board.outline.noteHint', 'Ctrl+Enter saves, Escape cancels'), save: (value) => editor.editCard(id, { text: value }) };
      }
      if (card && card.kind === 'link') {
        return { value: (card.data || {}).title || '', multiline: false, required: false, max: 200, label: jt('board.outline.linkField', 'Link title'), save: (value) => editor.editCard(id, { title: value }) };
      }
      return null;
    }

    function startEdit(id, fresh) { // fresh: a note added a moment ago, taken off again by Escape or by leaving it empty
      const li = items.get(id);
      const spec = li && shown && !editing && canEdit() ? editSpec(id) : null;
      if (!spec) return Boolean(li && shown && !editing && kindOf(id) === 'card' && !editSpec(id) && deps.activate && deps.activate(id));
      const row = li.querySelector('.board-outline__row');
      const label = li.querySelector('.board-outline__label');
      const wrap = el(doc, 'div', 'board-outline__edit', { 'data-outline-edit': '' });
      wrap.insertAdjacentHTML('beforeend', textField({ multiline: spec.multiline, rows: spec.multiline ? 4 : 1, value: spec.value, ariaLabel: spec.label, maxLength: spec.max, hint: spec.hint, className: 'board-outline__field' }));
      label.hidden = true;
      row.insertBefore(wrap, label.nextSibling);
      const field = wrap.querySelector('textarea, input');
      let done = false;
      function finish(save, keep) { // keep: Ctrl+Enter, or the window lost focus: neither removes a new note
        if (done) return;
        done = true;
        const value = spec.multiline ? field.value : field.value.trim();
        const hadFocus = wrap.contains(doc.activeElement);
        wrap.remove();
        label.hidden = false;
        editing = null;
        if (hadFocus && li.isConnected) { setStop(li); li.focus({ preventScroll: true }); }
        if (fresh === true && (!save || (!value.trim() && keep !== true))) removeFrom(id); else if (save && value !== spec.value && (value.trim() || !spec.required)) cmd.tell(spec.save(value), a11y.said(kindOf(id) === 'group' ? 'renamed' : 'edited', { name: nameOf(id), title: value }));
        if (stale) { stale = false; draw(editor.getBoard()); }
      }
      wrap.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); finish(false); return; }
        if (event.key === 'Enter' && (!spec.multiline || event.ctrlKey || event.metaKey)) { event.preventDefault(); finish(true, true); }
      });
      wrap.addEventListener('focusout', (event) => { if (!wrap.contains(event.relatedTarget)) finish(true, typeof doc.hasFocus === 'function' && !doc.hasFocus()); });
      editing = { id, finish };
      field.focus({ preventScroll: true });
      if (typeof field.select === 'function' && !spec.multiline) field.select();
      return true;
    }

    // ------------------------------------------------------------------ actions and menus

    function removeFrom(id) {
      if (!editor.getSelection().includes(id)) editor.select([id]);
      cmd.removeSelection();
    }

    function rowMenu(id) {
      const board = shown;
      const kind = kindOf(id);
      if (!contextMenu || !board || !canEdit() || (kind !== 'card' && kind !== 'group')) return [];
      if (kind === 'group') {
        return [
          { label: jt('board.outline.rename', 'Rename'), action: () => { startEdit(id); } },
          { label: jt('board.outline.ungroup', 'Ungroup'), action: () => cmd.ungroup(id) },
          { label: jt('board.outline.delete', 'Delete'), danger: true, action: () => removeFrom(id) },
        ];
      }
      const card = board.cards[id];
      const others = Object.values(board.cards).filter((other) => other.id !== id).sort(find.readingCompare);
      const groups = Object.values(board.groups || {}).sort(find.readingCompare);
      const named = (alias, text) => [alias, text].filter(Boolean).join(' ').slice(0, MENU_LABEL_MAX);
      return [
        { label: jt('board.outline.edit', 'Edit'), disabled: !editSpec(id), description: editSpec(id) ? '' : jt('board.outline.noEdit', 'This card is edited on the canvas'), action: () => { startEdit(id); } },
        { label: jt('board.outline.connectTo', 'Connect to'), disabled: !others.length, description: others.length ? '' : jt('board.outline.noOthers', 'There is no other card'),
          items: others.map((other) => ({ label: named(other.alias, describe(other)), action: () => cmd.connect(id, other.id) })) },
        { label: jt('board.outline.moveToGroup', 'Move to group'), disabled: !groups.length, description: groups.length ? '' : jt('board.outline.noGroups', 'There are no groups yet'),
          items: [{ label: jt('board.outline.noGroup', 'No group'), checked: !card.group_id, action: () => cmd.moveTo(id, null) }]
            .concat(groups.map((group) => ({ label: named(group.alias, group.title), checked: card.group_id === group.id, action: () => cmd.moveTo(id, group.id) }))) },
        { label: jt('board.outline.delete', 'Delete'), danger: true, action: () => removeFrom(id) },
      ];
    }

    function openMenu(id, anchor) {
      const menu = rowMenu(id);
      if (!menu.length) return false;
      const li = items.get(id);
      contextMenu.show({ items: menu, anchorEl: anchor || li, rootEl: element, ariaLabel: jt('board.outline.menu', 'Row actions'), restoreFocusTo: li });
      return true;
    }

    function act(name, id, button) {
      if (name === 'more') openMenu(id, button);
      else if (name === 'rename') startEdit(id);
      else if (name === 'ungroup') cmd.ungroup(id);
      else if (name === 'remove') cmd.removeConnector(id);
    }

    function pick(id, add) {
      if (kindOf(id) === 'connector') { editor.selectConnector(id); return; }
      if (add) editor.toggle(id); else editor.select([id]);
    }

    function toggleRow(id) {
      if (kindOf(id) === 'connector') editor.selectConnector(cmd.selectedConnector() === id ? '' : id);
      else editor.toggle(id);
    }

    function onClick(event) {
      const target = event.target;
      if (!target || !target.closest || target.closest('[data-outline-edit]')) return;
      const li = target.closest('li[role="treeitem"]');
      if (!li) return;
      const id = li.getAttribute('data-outline-id');
      const button = target.closest('[data-outline-act]');
      if (button) { if (!button.disabled) act(button.getAttribute('data-outline-act'), id, button); return; }
      setStop(li);
      li.focus({ preventScroll: true });
      if (target.closest('[data-outline-toggle]')) { toggleGroup(id); return; }
      pick(id, event.ctrlKey || event.metaKey || event.shiftKey);
    }

    function onFocusIn(event) {
      if (!event.target || !event.target.closest || event.target.closest('[data-outline-edit]')) return;
      const li = event.target.closest('li[role="treeitem"]');
      if (li && li.getAttribute('data-outline-id') !== focusedId) setStop(li);
    }

    function onContextMenu(event) {
      const id = idOf(event.target);
      if (!id || (event.target.closest && event.target.closest('[data-outline-edit]'))) return;
      if (openMenu(id)) event.preventDefault();
    }

    function onKeyDown(event) {
      const target = event.target;
      if (event.defaultPrevented || event.isComposing || !target || !target.closest || target.closest('[data-outline-edit]')) return;
      const li = target.closest('li[role="treeitem"]');
      if (!li) return;
      const id = li.getAttribute('data-outline-id');
      const key = event.key;
      const mod = event.ctrlKey || event.metaKey;
      if (target !== li && (key === 'Enter' || key === ' ')) return; // a focused button keeps its own activation
      const list = visibleItems();
      const at = list.indexOf(li);
      const go = (next, extend) => { // `extend`: Shift, so the rows passed over join the selection
        const ids = extend ? a11y.selectable([li, next]) : [];
        if (ids.length) editor.select(ids, { add: true });
        setStop(next);
        next.focus();
      };
      const lower = typeof key === 'string' ? key.toLowerCase() : '';
      let handled = true;
      if (key === ' ') toggleRow(id);
      else if (mod && !event.altKey) {
        if (lower === 'a') editor.select(a11y.selectable(list));
        else if (lower === 'z') cmd.tell(event.shiftKey ? editor.redo() : editor.undo(), a11y.said(event.shiftKey ? 'redone' : 'undone'));
        else if (lower === 'y') cmd.tell(editor.redo(), a11y.said('redone'));
        else if (lower === 'g' && !event.shiftKey) cmd.tell(editor.groupSelected(), a11y.said('grouped'));
        else handled = false;
      } else if (key === 'Enter') handled = canEdit() ? startEdit(id) : false;
      else if (key === 'F2') handled = canEdit() && Boolean(editSpec(id)) && startEdit(id);
      else if (key === 'Delete') {
        if (kindOf(id) === 'connector') editor.selectConnector(id);
        else if (!editor.getSelection().length) editor.select([id]);
        cmd.removeSelection();
      } else if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) handled = openMenu(id, li);
      else { // arrows, Home, End, `*` and type-ahead: the tree pattern's own keys
        const nav = a11y.navigate(event, li, list, at);
        handled = Boolean(nav && nav.handled);
        if (nav) { (nav.open || []).forEach((groupId) => toggleGroup(groupId, true)); if (nav.close) toggleGroup(nav.close, false); if (nav.go) go(nav.go, nav.extend); }
      }
      if (handled) event.preventDefault();
    }

    tree.addEventListener('click', onClick);
    tree.addEventListener('keydown', onKeyDown);
    tree.addEventListener('focusin', onFocusIn);
    tree.addEventListener('contextmenu', onContextMenu);

    // ------------------------------------------------------------------ the controls above the tree

    const addNoteButton = holder(actionButton({ variant: 'ghost', size: 'sm', label: jt('board.outline.addNote', 'Add note'), title: jt('board.outline.addNoteTitle', 'Add a note'), dataset: { 'outline-add': 'note' } }));
    const addLinkButton = holder(actionButton({ variant: 'ghost', size: 'sm', label: jt('board.outline.addLink', 'Add link'), title: jt('board.outline.addLinkTitle', 'Add a link to a web page'), ariaExpanded: false, dataset: { 'outline-add': 'link' } }));
    bar.appendChild(addNoteButton);
    bar.appendChild(addLinkButton);
    linkForm.insertAdjacentHTML('beforeend', textField({ ariaLabel: jt('board.outline.linkAddress', 'Link address'), placeholder: jt('board.outline.linkPlaceholder', 'https://'), className: 'board-outline__field', dataset: { 'outline-link-input': '' } }));
    linkForm.insertAdjacentHTML('beforeend', actionButton({ variant: 'primary', size: 'sm', label: jt('board.outline.linkAdd', 'Add'), dataset: { 'outline-link-submit': '' } })
      + actionButton({ variant: 'ghost', size: 'sm', label: jt('board.outline.linkCancel', 'Cancel'), dataset: { 'outline-link-cancel': '' } }));
    const linkError = linkForm.appendChild(el(doc, 'p', 'board-outline__error', { role: 'alert', 'data-outline-link-error': '' }));
    linkError.hidden = true;
    const linkInput = linkForm.querySelector('[data-outline-link-input]');

    function updateControls() {
      const can = canEdit();
      [[addNoteButton, jt('board.outline.addNoteTitle', 'Add a note')], [addLinkButton, jt('board.outline.addLinkTitle', 'Add a link to a web page')]].forEach(([button, title]) => {
        button.disabled = !can;
        button.title = can ? title : readOnlyReason();
      });
      tree.querySelectorAll('[data-outline-act]').forEach((button) => {
        button.disabled = !can;
        button.title = can ? button.getAttribute('data-outline-hint') || '' : readOnlyReason();
      });
      if (!can && !linkForm.hidden) closeLinkForm(false);
    }

    function closeLinkForm(restore) {
      linkForm.hidden = true;
      linkError.hidden = true;
      linkInput.value = '';
      addLinkButton.setAttribute('aria-expanded', 'false');
      if (restore) addLinkButton.focus({ preventScroll: true });
    }

    function validAddress(value) {
      try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; } catch (_error) { return false; }
    }

    function afterAdd(answer, edit) {
      if (!answer || answer.ok !== true || !answer.id) return;
      const added = editor.getBoard() && editor.getBoard().cards[answer.id];
      if (added) a11y.say(a11y.said('added', { name: [kindInfo(added.kind).label, added.alias].filter(Boolean).join(' ') }));
      if (focusRow(answer.id) && edit) startEdit(answer.id, true);
    }

    function submitLink() {
      const value = linkInput.value.trim();
      if (!validAddress(value)) {
        linkError.textContent = jt('board.outline.linkInvalid', 'Enter an address that starts with http:// or https://.');
        linkError.hidden = false;
        linkInput.setAttribute('aria-invalid', 'true');
        linkInput.focus();
        return;
      }
      closeLinkForm(false);
      void Promise.resolve(editor.addLink({ url: value })).then((answer) => afterAdd(answer, false));
    }

    function onBarClick(event) {
      const button = event.target && event.target.closest ? event.target.closest('button') : null;
      if (!button || button.disabled) return;
      if (button === addNoteButton) { void Promise.resolve(editor.addNote({})).then((answer) => afterAdd(answer, true)); return; }
      if (button === addLinkButton) {
        linkForm.hidden = !linkForm.hidden;
        addLinkButton.setAttribute('aria-expanded', linkForm.hidden ? 'false' : 'true');
        if (!linkForm.hidden) linkInput.focus();
        return;
      }
      if (button.hasAttribute('data-outline-link-submit')) submitLink();
      else if (button.hasAttribute('data-outline-link-cancel')) closeLinkForm(true);
    }
    function onLinkKeyDown(event) {
      if (event.key === 'Enter' && event.target === linkInput) { event.preventDefault(); submitLink(); }
      else if (event.key === 'Escape') { event.preventDefault(); closeLinkForm(true); }
    }
    bar.addEventListener('click', onBarClick);
    linkForm.addEventListener('click', onBarClick);
    linkForm.addEventListener('keydown', onLinkKeyDown);

    // ------------------------------------------------------------------ the editor's changes

    const unsubscribe = typeof editor.onChange === 'function' ? editor.onChange((change) => {
      if (disposed || !change) return;
      if (change.kind === 'selection') { refreshSelection(); return; }
      if (change.kind !== 'board') return;
      if (editing) { stale = true; updateControls(); return; }
      draw(editor.getBoard());
    }) : null;

    updateControls();

    return {
      element,
      show(board) { stale = false; if (editing) editing.finish(false); draw(board || null); },
      setMatches(ids) { matches = Array.isArray(ids) ? new Set(ids) : null; applyMatches(); },
      focusFirst() { const first = visibleItems()[0]; if (first) { setStop(first); first.focus(); } else addNoteButton.focus(); },
      dispose() {
        if (disposed) return;
        disposed = true;
        if (typeof unsubscribe === 'function') unsubscribe();
        tree.removeEventListener('click', onClick);
        tree.removeEventListener('keydown', onKeyDown);
        tree.removeEventListener('focusin', onFocusIn);
        tree.removeEventListener('contextmenu', onContextMenu);
        bar.removeEventListener('click', onBarClick);
        linkForm.removeEventListener('click', onBarClick);
        linkForm.removeEventListener('keydown', onLinkKeyDown);
        if (editing) editing.finish(false);
        items.clear();
        element.remove();
      },
    };
  }

  return { createBoardOutlineView };
});
