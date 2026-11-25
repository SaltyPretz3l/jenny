/* renderer/features/board/board-canvas-toolbar.js - the toolbar and the selection bar over the canvas (UMD).
 *
 * The toolbar (mockup: over the canvas, top centre) has Note, Link, one button per tool a card kind module offers
 * (deps.tools, from board-card-kinds.js), Undo and Redo, and a slot at its end for the
 * Canvas | Outline switch. "Link" opens a small inline form for the address and refuses anything that is not http or
 * https before it sends. Tools that do not fit hide from the end (Redo, then Undo, last; the switch stays) into a "More"
 * menu; the canvas view calls layout() when its room changes. The selection bar sits under it and shows only while something is selected: "N selected",
 * Group or Ungroup, Colour, Duplicate, Bring forward, Send back, Delete; with a connector selected it offers its
 * label, solid or dashed, and Delete. A control that does not apply is disabled with its reason as the tooltip, never
 * hidden; on a read-only board every control says the board cannot be changed.
 *
 * The bar never changes a document: each button calls one editor command, and refresh() (run on every editor change)
 * reads the editor back. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardCanvasToolbar = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const WEB_ADDRESS = /^https?:\/\/[^\s/?#]+\S*$/i;
  const LABEL_CHARS = 200;
  const URL_CHARS = 2048;

  function toneName(tone) {
    switch (tone) {
      case 'amber': return jt('board.bar.tone.amber', 'Amber');
      case 'blue': return jt('board.bar.tone.blue', 'Blue');
      case 'green': return jt('board.bar.tone.green', 'Green');
      case 'red': return jt('board.bar.tone.red', 'Red');
      default: return jt('board.bar.tone.none', 'No colour');
    }
  }

  function isWebAddress(text) {
    if (!WEB_ADDRESS.test(text)) return false;
    try { const parsed = new URL(text); return parsed.protocol === 'http:' || parsed.protocol === 'https:'; } catch (_error) { return false; }
  }

  function createBoardCanvasToolbar(deps) {
    const doc = deps.document;
    const { editor, host } = deps;
    const actionButton = deps.actionButton;
    const removers = [];
    const tools = Array.isArray(deps.tools) ? deps.tools : [];
    let labelField = null;

    const element = doc.createElement('div');
    element.className = 'board-chrome';
    element.setAttribute('data-board-chrome', '');

    function button(extra) {
      return actionButton(Object.assign({ variant: 'ghost', size: 'sm', className: 'board-tool' }, extra));
    }
    function html(parent, markup) { parent.insertAdjacentHTML('beforeend', markup); }
    function made(tag, className, attribute) {
      const el = doc.createElement(tag);
      el.className = className;
      if (attribute) el.setAttribute(attribute, '');
      return el;
    }
    function listen(target, type, handler) {
      target.addEventListener(type, handler);
      removers.push(() => target.removeEventListener(type, handler));
    }
    function find(selector) { return element.querySelector(selector); }

    /* ---------------------------------------------------------------- the toolbar */

    const toolbar = made('div', 'board-toolbar', 'data-board-toolbar');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', jt('board.toolbar.label', 'Board tools'));
    html(toolbar, button({ label: jt('board.toolbar.note', 'Note'), title: jt('board.toolbar.noteTitle', 'Add a note'), dataset: { 'board-tool': 'note' } })
      + button({ label: jt('board.toolbar.link', 'Link'), title: jt('board.toolbar.linkTitle', 'Add a link to a web page'), dataset: { 'board-tool': 'link' } })
      + tools.map((tool) => button({ label: tool.label, title: tool.title, dataset: { 'board-tool': `kind-${tool.id}` } })).join(''));
    toolbar.appendChild(made('span', 'board-sep'));
    toolbar.lastChild.setAttribute('role', 'separator');
    html(toolbar, button({ label: jt('board.toolbar.undo', 'Undo'), title: jt('board.toolbar.undoTitle', 'Undo the last change'), dataset: { 'board-tool': 'undo' } })
      + button({ label: jt('board.toolbar.redo', 'Redo'), title: jt('board.toolbar.redoTitle', 'Redo the change you undid'), dataset: { 'board-tool': 'redo' } }));
    const slot = made('span', 'board-toolbar__slot', 'data-board-toolbar-slot');
    toolbar.appendChild(slot);
    const moreTitle = jt('board.bar.moreTitle', 'Tools that do not fit on the bar');
    html(toolbar, button({ label: jt('board.bar.more', 'More'), title: moreTitle, ariaHaspopup: 'menu', dataset: { 'board-more': '' } }));
    const more = toolbar.querySelector('[data-board-more]');
    more.hidden = true;
    element.appendChild(toolbar);

    /* ---------------------------------------------------------------- the link form */

    const form = made('div', 'board-link-form', 'data-board-link-form');
    form.hidden = true;
    const input = doc.createElement('textarea');
    input.className = 'board-card-editor__field board-link-form__field';
    input.rows = 1;
    input.maxLength = URL_CHARS;
    input.setAttribute('aria-label', jt('board.link.addressLabel', 'Link address'));
    input.setAttribute('placeholder', jt('board.link.placeholder', 'https://example.com'));
    input.setAttribute('spellcheck', 'false');
    form.appendChild(input);
    html(form, button({ variant: 'primary', label: jt('board.link.add', 'Add link'), title: jt('board.link.addTitle', 'Add this link to the board'), dataset: { 'board-link-add': '' } })
      + button({ label: jt('board.link.cancel', 'Cancel'), title: jt('board.link.cancelTitle', 'Close without adding'), dataset: { 'board-link-cancel': '' } }));
    const linkError = made('p', 'board-link-form__error', 'data-board-link-error');
    linkError.setAttribute('role', 'alert');
    linkError.hidden = true;
    form.appendChild(linkError);
    element.appendChild(form);

    function linkProblem(text) { linkError.textContent = text || ''; linkError.hidden = !text; }
    function closeForm(refocus) {
      form.hidden = true;
      input.value = '';
      linkProblem('');
      if (refocus) { const opener = find('[data-board-tool="link"]'); (opener && !opener.hidden ? opener : more).focus({ preventScroll: true }); }
    }
    async function submitLink() {
      const url = input.value.trim();
      if (!isWebAddress(url)) { linkProblem(jt('board.link.invalid', 'Enter an address that starts with http:// or https://.')); return; }
      const result = await editor.addLink({ url });
      if (!result.ok) { linkProblem(result.message); return; }
      closeForm(false);
      host.reveal(result.id);
    }
    listen(input, 'keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitLink(); }
      else if (event.key === 'Escape') { event.preventDefault(); closeForm(true); }
    });
    listen(input, 'input', () => {
      linkProblem('');
      if (/[\r\n]/.test(input.value)) input.value = input.value.replace(/[\r\n]+/g, ' ');
    });

    /* ---------------------------------------------------------------- the selection bar */

    const bar = made('div', 'board-selbar', 'data-board-selbar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', jt('board.bar.label', 'Selection'));
    bar.hidden = true;
    const cardsPart = made('div', 'board-selbar__part', 'data-board-bar-cards');
    const count = made('span', 'board-selbar__count', 'data-board-count');
    count.setAttribute('aria-live', 'polite');
    cardsPart.appendChild(count);
    html(cardsPart, button({ label: jt('board.bar.group', 'Group'), dataset: { 'board-sel': 'group' } }));
    const swatches = made('span', 'board-swatches');
    swatches.setAttribute('role', 'group');
    swatches.setAttribute('aria-label', jt('board.bar.colour', 'Colour'));
    ['none', 'amber', 'blue', 'green', 'red'].forEach((tone) => {
      html(swatches, button({
        className: 'board-tool board-swatch-button', ariaLabel: toneName(tone), title: toneName(tone), dataset: { 'board-tone': tone },
        trustedHtml: `<span class="board-swatch" data-tone="${tone}" aria-hidden="true"></span>`,
      }));
    });
    cardsPart.appendChild(swatches);
    html(cardsPart, button({ label: jt('board.bar.duplicate', 'Duplicate'), dataset: { 'board-sel': 'duplicate' } })
      + button({ label: jt('board.bar.forward', 'Bring forward'), dataset: { 'board-sel': 'forward' } })
      + button({ label: jt('board.bar.back', 'Send back'), dataset: { 'board-sel': 'back' } }));
    const connectorPart = made('div', 'board-selbar__part', 'data-board-bar-connector');
    connectorPart.hidden = true;
    const connectorName = made('span', 'board-selbar__count');
    connectorName.textContent = jt('board.bar.connector', 'Connector');
    connectorPart.appendChild(connectorName);
    html(connectorPart, button({ label: jt('board.bar.addLabel', 'Add label'), dataset: { 'board-sel': 'label' } })
      + button({ label: jt('board.bar.dashed', 'Dashed line'), dataset: { 'board-sel': 'style' } }));
    bar.appendChild(cardsPart);
    bar.appendChild(connectorPart);
    html(bar, button({ variant: 'danger', label: jt('board.bar.delete', 'Delete'), dataset: { 'board-sel': 'delete' } }));
    element.appendChild(bar);

    /* ---------------------------------------------------------------- connector label */

    function closeLabel() {
      if (!labelField) return;
      const field = labelField;
      labelField = null;
      field.remove();
      const opener = bar.querySelector('[data-board-sel="label"]');
      if (opener) opener.hidden = false;
    }
    async function commitLabel() {
      const field = labelField;
      const id = editor.getSelectedConnector();
      if (!field || !id) { closeLabel(); return; }
      const result = await editor.editConnector(id, { label: field.value.trim() });
      if (labelField === field && result.ok) closeLabel();
      refresh();
    }
    function editConnectorLabel() {
      const id = editor.getSelectedConnector();
      const board = editor.getBoard();
      if (!id || !board || !board.connectors[id] || !editor.canEdit() || labelField) return false;
      const opener = bar.querySelector('[data-board-sel="label"]');
      labelField = doc.createElement('textarea');
      labelField.className = 'board-card-editor__field board-selbar__field';
      labelField.rows = 1;
      labelField.maxLength = LABEL_CHARS;
      labelField.value = board.connectors[id].label;
      labelField.setAttribute('data-board-label-field', '');
      labelField.setAttribute('aria-label', jt('board.bar.labelField', 'Connector label'));
      labelField.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); void commitLabel(); }
        else if (event.key === 'Escape') { event.preventDefault(); closeLabel(); }
      });
      labelField.addEventListener('focusout', (event) => { if (!event.relatedTarget || !connectorPart.contains(event.relatedTarget)) void commitLabel(); });
      opener.hidden = true;
      opener.insertAdjacentElement('afterend', labelField);
      labelField.focus({ preventScroll: true });
      labelField.select();
      return true;
    }

    /* ---------------------------------------------------------------- tools that do not fit */

    const separator = find('.board-sep');
    const toolEls = Array.from(toolbar.querySelectorAll('[data-board-tool]'));
    const undoEl = find('[data-board-tool="undo"]');
    const redoEl = find('[data-board-tool="redo"]');
    const ordinary = toolEls.filter((el) => el !== undoEl && el !== redoEl);
    // Hide order: the last ordinary tool first, Undo and Redo last (Redo before Undo); the switch in the slot never hides.
    const hideOrder = ordinary.slice().reverse().concat([redoEl, undoEl]);
    const px = (value) => parseFloat(value) || 0;
    const style = (el) => doc.defaultView.getComputedStyle(el);
    // deps.measure replaces any of these (jsdom has no layout, so a test supplies the widths).
    const measure = Object.assign({
      available: () => toolbar.clientWidth,
      width: (el) => { const css = style(el); return el.getBoundingClientRect().width + px(css.marginLeft) + px(css.marginRight); },
      spacing: () => {
        const css = style(toolbar);
        return { gap: px(css.columnGap), pad: px(css.paddingLeft) + px(css.paddingRight) }; // clientWidth has no border
      },
    }, deps.measure);
    let menuOpen = false;
    let labelKey = '';

    // One pass: show everything, read the widths once, then hide from the end until the rest and the More button fit.
    // A bar with no width (detached or hidden) is unknown, so it shows every tool and no More button.
    function layout() {
      const hadMore = doc.activeElement === more;
      place();
      // More had focus and everything fits again: focus goes to a tool, not to the page.
      const next = hadMore && more.hidden && toolEls.find((el) => !el.hidden && !el.disabled);
      if (next) next.focus({ preventScroll: true });
    }
    function place() {
      toolEls.forEach((el) => { el.hidden = false; });
      separator.hidden = false;
      more.hidden = false;
      const room = measure.available();
      if (!(room > 0)) { more.hidden = true; return; }
      const { gap, pad } = measure.spacing();
      const slotShown = slot.childNodes.length > 0;
      const row = ordinary.concat([separator, undoEl, redoEl, more]).concat(slotShown ? [slot] : []);
      const widths = new Map(row.map((el) => [el, measure.width(el)]));
      let used = pad + gap * (row.length - 1);
      widths.forEach((w) => { used += w; });
      const drop = (el) => { used -= widths.get(el) + gap; el.hidden = true; };
      if (used - widths.get(more) - gap <= room + 1) { more.hidden = true; return; }
      for (const el of hideOrder) {
        if (used <= room + 1) break;
        drop(el);
        if (el === ordinary[0]) drop(separator);
      }
      const active = doc.activeElement;
      if (active && active.hidden && toolbar.contains(active)) more.focus({ preventScroll: true });
    }

    const resolveMenu = () => deps.contextMenu || globalThis.inventoryContextMenu || (typeof require === 'function' ? require('../../inventory/context-menu') : null);

    // Each entry is the real, hidden button: its label, its disabled state and its reason, and choosing it clicks it.
    function openMore() {
      const menu = resolveMenu();
      if (!menu) return;
      if (menuOpen) { menu.hide(); return; }
      refresh();
      const items = toolEls.filter((el) => el.hidden).map((el) => ({
        label: el.textContent.trim(), disabled: el.disabled, description: el.disabled ? el.title : '', action: () => el.click(),
      }));
      if (!items.length) return;
      menuOpen = true;
      menu.show({ items, anchorEl: more, rootEl: element, ariaLabel: jt('board.bar.moreMenu', 'More board tools'), placement: 'below', restoreFocusTo: more, onHide: () => { menuOpen = false; } });
    }
    listen(more, 'click', openMore);

    /* ---------------------------------------------------------------- state */

    function set(selector, { disabled, title, text }) {
      const el = find(selector);
      if (!el) return;
      el.disabled = disabled === true;
      if (title !== undefined) el.title = title;
      if (text !== undefined && el.textContent !== text) el.textContent = text;
    }

    function refresh() {
      const board = editor.getBoard();
      const edit = editor.canEdit();
      const readOnly = jt('board.tool.readOnly', 'This board cannot be changed.');
      const ids = editor.getSelection();
      const connectorId = editor.getSelectedConnector();
      const cards = board ? ids.map((id) => board.cards[id]).filter(Boolean) : [];
      const groups = board ? ids.map((id) => board.groups[id]).filter(Boolean) : [];
      const reason = (ok, text) => (!edit ? readOnly : (ok ? '' : text));

      set('[data-board-tool="note"]', { disabled: !edit, title: edit ? jt('board.toolbar.noteTitle', 'Add a note') : readOnly });
      set('[data-board-tool="link"]', { disabled: !edit, title: edit ? jt('board.toolbar.linkTitle', 'Add a link to a web page') : readOnly });
      tools.forEach((tool) => set(`[data-board-tool="kind-${tool.id}"]`, { disabled: !edit, title: edit ? tool.title : readOnly }));
      const canUndo = edit && editor.canUndo();
      const canRedo = edit && editor.canRedo();
      // A team board has no undo or redo: the source says so (row 151 T7).
      const team = deps.context && typeof deps.context.getTeamSource === 'function' ? deps.context.getTeamSource() : null;
      const teamWhy = team ? team.whyNot('undo') : '';
      set('[data-board-tool="undo"]', { disabled: !canUndo, title: teamWhy || reason(canUndo, jt('board.undo.nothing', 'Nothing to undo.')) || jt('board.toolbar.undoTitle', 'Undo the last change') });
      set('[data-board-tool="redo"]', { disabled: !canRedo, title: teamWhy || reason(canRedo, jt('board.redo.nothing', 'Nothing to redo.')) || jt('board.toolbar.redoTitle', 'Redo the change you undid') });
      // Every tool in the menu would be disabled for the same reason, so the menu button says it once.
      set('[data-board-more]', { disabled: !edit, title: edit ? moreTitle : readOnly });
      if (!edit && !form.hidden) closeForm(false);

      const showing = ids.length > 0 || connectorId !== '';
      bar.hidden = !showing;
      cardsPart.hidden = connectorId !== '';
      connectorPart.hidden = connectorId === '';
      count.textContent = jt('board.bar.count', '{count} selected', { count: ids.length });
      const ungroup = groups.length > 0;
      const groupOk = ungroup || cards.length > 0;
      set('[data-board-sel="group"]', {
        disabled: !edit || !groupOk,
        text: ungroup ? jt('board.bar.ungroup', 'Ungroup') : jt('board.bar.group', 'Group'),
        title: reason(groupOk, jt('board.bar.groupNeedsCard', 'Select a card to group.')) || (ungroup ? jt('board.bar.ungroupTitle', 'Release the cards of the selected groups') : jt('board.bar.groupTitle', 'Put the selected cards in a group')),
      });
      const tonable = cards.some((card) => card.kind === 'note') || groups.length > 0;
      swatches.querySelectorAll('[data-board-tone]').forEach((swatch) => {
        swatch.disabled = !edit || !tonable;
        swatch.title = reason(tonable, jt('board.bar.toneNeedsNote', 'Colours apply to notes and groups.')) || toneName(swatch.getAttribute('data-board-tone'));
      });
      ['duplicate', 'forward', 'back'].forEach((name) => {
        set(`[data-board-sel="${name}"]`, { disabled: !edit || cards.length === 0, title: reason(cards.length > 0, jt('board.bar.needsCard', 'Select a card first.')) });
      });
      set('[data-board-sel="delete"]', { disabled: !edit, title: edit ? jt('board.bar.deleteTitle', 'Delete the selection') : readOnly });
      const connector = board && connectorId ? board.connectors[connectorId] : null;
      set('[data-board-sel="label"]', { disabled: !edit, title: edit ? '' : readOnly, text: connector && connector.label ? jt('board.bar.editLabel', 'Edit label') : jt('board.bar.addLabel', 'Add label') });
      set('[data-board-sel="style"]', { disabled: !edit, title: edit ? '' : readOnly, text: connector && connector.style === 'dashed' ? jt('board.bar.solid', 'Solid line') : jt('board.bar.dashed', 'Dashed line') });
      if (!connectorId) closeLabel();
      // The bar's labels are fixed today, but a changed one would change what fits.
      const key = toolEls.map((el) => el.textContent).join('|');
      if (key !== labelKey) { labelKey = key; layout(); }
    }

    /* ---------------------------------------------------------------- clicks */

    async function onToolClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-board-tool]') : null;
      if (target && !target.disabled) {
        const tool = target.getAttribute('data-board-tool');
        if (tool === 'note') {
          const result = await editor.addNote({});
          if (result.ok) { host.reveal(result.id); host.startEdit(result.id, { fresh: true }); }
        } else if (tool === 'link') {
          form.hidden = !form.hidden;
          if (!form.hidden) input.focus({ preventScroll: true }); else closeForm(false);
        } else if (tool === 'undo') {
          await editor.undo();
        } else if (tool === 'redo') {
          await editor.redo();
        } else {
          const picked = tools.find((entry) => `kind-${entry.id}` === tool);
          if (picked) await picked.run();
        }
        return;
      }
      const sub = event.target && event.target.closest ? event.target.closest('[data-board-link-add],[data-board-link-cancel]') : null;
      if (!sub) return;
      if (sub.hasAttribute('data-board-link-add')) void submitLink(); else closeForm(true);
    }

    async function onBarClick(event) {
      const tone = event.target && event.target.closest ? event.target.closest('[data-board-tone]') : null;
      if (tone && !tone.disabled) {
        const name = tone.getAttribute('data-board-tone');
        await editor.setTone(name === 'none' ? null : name);
        return;
      }
      const target = event.target && event.target.closest ? event.target.closest('[data-board-sel]') : null;
      if (!target || target.disabled) return;
      switch (target.getAttribute('data-board-sel')) {
        case 'group': await (editor.getSelection().some((id) => editor.getBoard().groups[id]) ? editor.ungroupSelected() : editor.groupSelected()); break;
        case 'duplicate': await editor.duplicateSelected(); break;
        case 'forward': await editor.bringForward(); break;
        case 'back': await editor.sendBack(); break;
        case 'delete': await editor.removeSelected(); break;
        case 'label': editConnectorLabel(); break;
        case 'style': {
          const connector = editor.getBoard().connectors[editor.getSelectedConnector()];
          if (connector) await editor.editConnector(connector.id, { style: connector.style === 'dashed' ? 'solid' : 'dashed' });
          break;
        }
        default:
      }
    }
    listen(element, 'click', (event) => { void onToolClick(event); });
    listen(bar, 'click', (event) => { void onBarClick(event); });
    // The chrome sits over the canvas: a press on it is its own, never a click on the board below.
    ['pointerdown', 'pointerup', 'dblclick'].forEach((type) => listen(element, type, (event) => event.stopPropagation()));

    refresh();
    return {
      element, toolbar, bar, slot, refresh, layout, editConnectorLabel,
      setVisible(on) { element.hidden = !on; },
      dispose() {
        if (menuOpen) { const menu = resolveMenu(); if (menu) menu.hide({ restoreFocus: false }); }
        removers.splice(0).forEach((remove) => remove());
        element.remove();
      },
    };
  }

  return { createBoardCanvasToolbar, isWebAddress };
});
