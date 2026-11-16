/* renderer/features/board/board-outline-a11y.js - what a screen reader hears from the board outline (UMD, global rendererBoardOutlineA11y).
 *
 * The outline view (board-outline-view.js) draws the tree and acts on its keys; this file owns the words and the
 * bookkeeping around them, so the view stays small:
 *  - the name of a row ("Note: Decide token lifetime, n3"; "Group: Decisions, 4 cards, g1"; "Connects to n3 Ship on
 *    Friday: blocks"), cut to 300 characters, and the description that reads a card's connections with it;
 *  - aria-setsize and aria-posinset for every row, counted over the rows that show (a row a filter hides is not
 *    counted; a closed group's rows are counted by their own list);
 *  - the tree's movement keys: what a key does to the focus and to the open groups, type-ahead included;
 *  - the one polite live region the outline owns, and the sentences it says once an editor command went through
 *    (an add, a removal, a move, a rename...). A refusal says nothing here: the editor tells it.
 * Text from a board goes in through textContent and attributes only. Nothing here runs until
 * createBoardOutlineA11y() is called. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardOutlineA11y = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const defaultJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const NAME_MAX = 300; // characters in a row's accessible name
  const LABEL_MAX = 80; // a connection's label inside a name
  const PART_MAX = 180; // one connection inside a description
  const TYPE_RESET_MS = 700;

  /** The text on one line, at most `max` characters, cut with an ellipsis. */
  function clip(text, max) {
    const flat = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return flat;
    const end = Math.max(1, max - 1);
    const high = flat.charCodeAt(end - 1); // a cut never leaves half of a surrogate pair
    return `${flat.slice(0, high >= 0xd800 && high <= 0xdbff ? end - 1 : end).trimEnd()}…`;
  }

  /** `head`, then the body after `bodySep`, then the tail after `tailSep`: the body gives way so the whole fits. */
  function compose(head, body, tail, bodySep, tailSep) {
    const fixed = head + (body ? bodySep : '') + (tail ? tailSep + tail : '');
    return head + (body ? bodySep + clip(body, Math.max(1, NAME_MAX - fixed.length)) : '') + (tail ? tailSep + tail : '');
  }

  const plain = (text) => String(text || '').replace(/ · /g, ', ');
  const idOf = (li) => li.getAttribute('data-outline-id');

  function createBoardOutlineA11y(deps) {
    const jt = deps.jt || defaultJt;
    const doc = deps.document;
    const live = doc.createElement('div');
    live.className = 'sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('data-outline-live', '');
    const connectsTo = jt('board.outline.connectsTo', 'Connects to');
    let typed = '';
    let typedAt = 0;

    function said(kind, p) {
      switch (kind) {
        case 'added': return jt('board.outline.said.added', '{name} added.', p);
        case 'moved': return jt('board.outline.said.moved', '{name} moved to {group}.', p);
        case 'movedOut': return jt('board.outline.said.movedOut', '{name} taken out of its group.', p);
        case 'connected': return jt('board.outline.said.connected', '{from} connected to {to}.', p);
        case 'renamed': return jt('board.outline.said.renamed', '{name} renamed to {title}.', p);
        case 'edited': return jt('board.outline.said.edited', '{name} updated.', p);
        case 'ungrouped': return jt('board.outline.said.ungrouped', '{name} ungrouped.', p);
        case 'grouped': return jt('board.outline.said.grouped', 'Items grouped.');
        case 'undone': return jt('board.outline.said.undone', 'Change undone.');
        case 'redone': return jt('board.outline.said.redone', 'Change redone.');
        case 'connectionRemoved': return jt('board.outline.said.connectionRemoved', 'Connection removed. Undo is available.');
        default: return '';
      }
    }

    const api = {
      live,
      said,
      connectsTo,
      /** One sentence into the live region; clearing first lets the same sentence be heard twice. */
      say(text) { live.textContent = ''; if (text) live.textContent = text; },
      /** "Note: text, n3": the kind, the text (an image with no description says so), then what else is known. */
      cardName(card, label, text, alias, tail) {
        const body = text || (card && card.kind === 'image' ? jt('board.outline.noDescription', 'no description') : '');
        return compose(label, plain(body), [tail, alias].filter(Boolean).join(', '), ': ', ', ');
      },
      groupTail(count) {
        return count === 1 ? jt('board.outline.cardCountOne', '1 card') : jt('board.outline.cardCountMany', '{count} cards', { count });
      },
      /** "Connects to n3 Ship on Friday: blocks". */
      connectionName(alias, text, label) {
        return compose(alias ? `${connectsTo} ${alias}` : connectsTo, plain(text), clip(label, LABEL_MAX), ' ', ': ');
      },
      /** What a card reads after its name: each connection that leaves it (`links` are connectors, `cards` the board's). */
      connections(links, cards, describe) {
        return links.map((link) => clip(api.connectionName(cards[link.to].alias, describe(cards[link.to]), link.label), PART_MAX)).join('; ');
      },
      /** Puts the description `text` on a row as an aria-describedby target inside `row`. */
      describe(li, row, text, id) {
        const about = doc.createElement('span');
        about.className = 'sr-only';
        about.id = id;
        about.textContent = text;
        row.appendChild(about);
        li.setAttribute('aria-describedby', id);
      },
      /** Every list of rows says how many rows show and where each one is. */
      setSizes(tree) {
        [tree].concat(Array.from(tree.querySelectorAll('ul[role="group"]'))).forEach((list) => {
          const shown = Array.from(list.children).filter((node) => node.tagName === 'LI' && !node.hidden);
          shown.forEach((li, at) => { li.setAttribute('aria-posinset', String(at + 1)); li.setAttribute('aria-setsize', String(shown.length)); });
        });
      },
      /** Where focus goes when the focused row is gone: the rows after it, then the ones before, nearest first. */
      fallbackOrder(order, id) {
        const at = order.indexOf(id);
        return order.slice(at + 1).concat(order.slice(0, Math.max(at, 0)).reverse());
      },
      /** The row after `at` whose text starts with what has been typed; null when the key is not a letter or nothing matches. */
      typeAhead(rows, at, event) {
        const key = event.key;
        if (typeof key !== 'string' || key.length !== 1 || key === ' ' || event.ctrlKey || event.metaKey || event.altKey) return null;
        const now = Date.now();
        if (now - typedAt > TYPE_RESET_MS) typed = '';
        typedAt = now;
        typed += key.toLowerCase();
        const needle = /^(.)\1+$/.test(typed) ? typed[0] : typed; // the same letter again walks on
        for (let step = 1; step <= rows.length; step += 1) {
          const row = rows[(at + step) % rows.length];
          const text = row.querySelector('.board-outline__text');
          if (text && text.textContent.trim().toLowerCase().startsWith(needle)) return row;
        }
        return null;
      },
      /** What a movement key does: null when it is none, else { handled, go (a row), extend (Shift), open (group ids), close (a group id) }. */
      navigate(event, li, rows, at) {
        const go = (to) => ({ handled: true, go: to, extend: event.shiftKey });
        switch (event.key) {
          case 'ArrowDown': return go(rows[at + 1]);
          case 'ArrowUp': return go(rows[at - 1]);
          case 'Home': return go(rows[0]);
          case 'End': return go(rows[rows.length - 1]);
          case 'ArrowRight': {
            if (li.getAttribute('aria-expanded') === 'false') return { handled: true, open: [idOf(li)] };
            const sub = li.lastElementChild && li.lastElementChild.tagName === 'UL' && !li.lastElementChild.hidden ? li.lastElementChild : null;
            const child = sub ? Array.from(sub.children).find((node) => !node.hidden) : null;
            return child ? { handled: true, go: child } : { handled: li.hasAttribute('aria-expanded') };
          }
          case 'ArrowLeft': {
            if (li.getAttribute('aria-expanded') === 'true') return { handled: true, close: idOf(li) };
            const parent = li.parentElement && li.parentElement.closest('li[role="treeitem"]');
            return parent ? { handled: true, go: parent } : { handled: li.hasAttribute('aria-expanded') };
          }
          case '*': return { handled: true, open: Array.from(li.parentElement ? li.parentElement.children : []).filter((node) => node.getAttribute('aria-expanded') === 'false').map(idOf) };
          default: { const found = api.typeAhead(rows, at, event); return found ? { handled: true, go: found } : null; }
        }
      },
      /** The ids a selection key may take from these rows: cards and groups, not connections. */
      selectable(rows) {
        return rows.filter((li) => li.getAttribute('data-outline-kind') !== 'connector').map(idOf);
      },
      /** The editor commands the outline runs, each followed by its sentence once the editor says it went through.
       *  ctx: { nameOf(id), titleOf(groupId), alive() }. */
      actions(editor, ctx) {
        const connector = () => (typeof editor.getSelectedConnector === 'function' ? editor.getSelectedConnector() : '');
        function tell(answer, text) { void Promise.resolve(answer).then((result) => { if (ctx.alive() && result && result.ok === true) api.say(text); }, () => {}); }
        return {
          tell,
          selectedConnector: connector,
          removeSelection() {
            const names = connector() ? null : editor.getSelection().map(ctx.nameOf);
            tell(editor.removeSelected(), !names ? said('connectionRemoved') : names.length === 1
              ? jt('board.outline.said.removed', '{name} removed. Undo is available.', { name: names[0] })
              : jt('board.outline.said.removedMany', '{count} items removed. Undo is available.', { count: names.length }));
          },
          removeConnector(id) { tell(editor.removeConnector(id), said('connectionRemoved')); },
          ungroup(id) { editor.select([id]); tell(editor.ungroupSelected(), said('ungrouped', { name: ctx.nameOf(id) })); },
          connect(from, to) { tell(editor.connect(from, to), said('connected', { from: ctx.nameOf(from), to: ctx.nameOf(to) })); },
          moveTo(id, groupId) { tell(editor.assignToGroup([id], groupId), groupId ? said('moved', { name: ctx.nameOf(id), group: ctx.titleOf(groupId) }) : said('movedOut', { name: ctx.nameOf(id) })); },
        };
      },
    };
    return api;
  }

  return { createBoardOutlineA11y, clip, NAME_MAX };
});
