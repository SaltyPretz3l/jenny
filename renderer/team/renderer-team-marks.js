/* Reactions and pins on a message (row 123, slice 2b-2), for one shown channel's timeline or thread column. Made
 * by the message actions (renderer-team-message-actions.js); the host and main carried these since slices 2b-1 and
 * 2b-1c, this is what the person sees and presses.
 *
 * - Chips (`.team-reacts`): one button per emoji on the message, in the record's order, then an add chip; a message
 *   with no reactions has neither. Yours is pressed (`aria-pressed`). A chip's tooltip and name are "{names}
 *   reacted with {emoji}", "You" first. An emoji from a record is drawn as text, also one the team list lacks.
 * - A press changes the chip at once as an overlay on the record (never written into the store): dropped when the
 *   record shows it, when the host's answer is in and the record is at its revision, or when the call fails, which
 *   says so in the row foot ("Your reaction was not added. {reason}"). A second press while the first is out is
 *   allowed; main keeps the final state, so only the last press undoes itself.
 * - The picker (`renderer-team-pop.js`) lists the team's `reaction_emoji`, eight to a row, arrows in two
 *   dimensions, Home, End; a message with 20 different reactions greys every emoji not already on it.
 * - Pin and Unpin (More, and the P key): no overlay, the foot says "Pinned by {name}" once the push arrives. A
 *   control that cannot work now (read-only, offline, 20 reactions, 50 pins) is greyed with its reason and sends
 *   nothing; P says the reason in the foot ("Not pinned. {reason}").
 * Host text is untrusted: names and words through `escapeHtml`, an emoji only as text. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('./renderer-team-message-row'));
    return;
  }
  root.rendererTeamMarks = factory(root.rendererSettingsTeamStrings, root.rendererTeamMessageRow);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, rows) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const REACTIONS_MAX = 20;
  const PINS_MAX = 50;
  const NO_ANSWER = rows.NO_ANSWER;
  const PICKER_COLUMNS = 8;
  const SMILEY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM5.8 9.6a2.6 2.6 0 0 0 4.4 0M6 6.6h.01M10 6.6h.01"/></svg>';
  const SMILEY_ADD = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="8" r="5"/><path d="M5 9.4a2.4 2.4 0 0 0 4 0M5.2 6.6h.01M8.8 6.6h.01M13 2.5v4M11 4.5h4"/></svg>';

  function inv() { return globalThis.inventory || {}; }
  const disabledAttr = (html) => html.replace(/^(\S+)/, '$1 aria-disabled="true"');

  // The reason a reaction (`react`) or a pin (`pin`) cannot be sent in the context `c`, else ''. One rule for the row,
  // the menu and the pinned list.
  function blockWords(c, kind) {
    if (!c.canWrite) return kind === 'pin' ? jt('team.pin.readOnly', 'Read-only members cannot pin.') : jt('team.react.readOnly', 'Read-only members cannot react.');
    return c.online ? '' : jt('team.export.needsOnline', 'Needs the team online');
  }
  const waitingWords = () => jt('team.react.listWaiting', 'The emoji list has not arrived yet.');

  const capSentence = () => jt('team.react.capNote', 'This message has 20 different reactions, the most it can have. You can still add to one of those.');

  // `ctx()`: the tab's context. `messageOf(id)`: a message this column shows. `pop`: the popover. `rowOf(id)`: its row.
  function createMarks({ chat, teamId, channelId, ctx, writes, redraw, messageOf, rowOf, pop }) {
    const overlay = new Map(); // message id -> Map(emoji -> { on, rev, token, done, doneRev })
    const notes = new Map(); // message id -> the words of the last refusal
    const pinning = new Set();
    let token = 0;
    let disposed = false;

    const failWords = (answer, kind) => words.markErrorText((answer && answer.error) || NO_ANSWER, kind);

    // ------------------------------------------------------------ what can be done now

    const blockOf = (kind) => blockWords(ctx(), kind);
    // What the rows of one pass share (the pass's context object `c` is the key): the reaction block words and whether
    // the team's emoji list is in. Read once per pass, not once per row.
    let passFor = null;
    let pass = null;
    function passOf(c) {
      if (c !== passFor) { passFor = c; pass = { react: blockWords(c, 'react'), hasList: (chat.emoji(teamId) || []).length > 0 }; }
      return pass;
    }
    function pinBlock(message) {
      const why = blockOf('pin');
      if (why) return why;
      const record = chat.channel(teamId, channelId);
      if (!message.pinned && record && record.pin_count >= PINS_MAX) return jt('team.pin.limit', 'This channel has 50 pinned messages, the most it can have. Unpin one first.');
      return '';
    }

    // ------------------------------------------------------------ reactions

    // [emoji, member ids] for a message as shown: the record with this person's pending presses laid over it.
    function reactionsOf(message) {
      const base = message.reactions && typeof message.reactions === 'object' ? message.reactions : {};
      const lists = new Map(Object.entries(base).filter(([, ids]) => Array.isArray(ids)).map(([e, ids]) => [e, ids.slice()]));
      const mine = overlay.get(message.id);
      if (!mine) return [...lists];
      const me = ctx().me;
      for (const [emoji, mark] of [...mine]) {
        const shown = (lists.get(emoji) || []).includes(me);
        if ((mark.on === shown && message.rev > mark.rev) || (mark.done && message.rev >= mark.doneRev)) { mine.delete(emoji); continue; }
        const ids = (lists.get(emoji) || []).filter((id) => id !== me);
        if (mark.on) ids.push(me);
        if (ids.length) lists.set(emoji, ids); else lists.delete(emoji);
      }
      if (!mine.size) overlay.delete(message.id);
      return [...lists];
    }

    function namesOf(ids, c) {
      const you = jt('team.react.you', 'You');
      const ordered = ids.includes(c.me) ? [c.me].concat(ids.filter((id) => id !== c.me)) : ids;
      return rows.listText(ordered.map((id) => (id === c.me ? you : c.nameOf(id))));
    }

    function chipsHtml(list, c) {
      if (!list.length) return '';
      const block = passOf(c).react;
      const chips = list.map(([emoji, ids]) => {
        const sentence = jt('team.react.chip', '{names} reacted with {emoji}', { names: namesOf(ids, c), emoji });
        const label = block ? sentence + ' ' + block : sentence;
        const button = inv().actionButton({ plain: true, className: 'team-react', ariaLabel: label, title: label, ariaPressed: ids.includes(c.me),
          dataset: { 'team-msg-action': 'react', emoji },
          trustedHtml: '<span class="team-react__e" aria-hidden="true">' + escapeHtml(emoji) + '</span><span class="team-react__n">' + ids.length + '</span>' });
        return block ? disabledAttr(button) : button;
      }).join('');
      const add = list.length >= REACTIONS_MAX ? capSentence() : jt('team.react.add', 'Add reaction');
      const addLabel = block ? add + ' ' + block : add;
      const addButton = inv().actionButton({ plain: true, className: 'team-react team-react--add', ariaLabel: addLabel, title: addLabel, ariaHaspopup: 'dialog',
        dataset: { 'team-msg-action': 'react-add' }, trustedHtml: SMILEY_ADD });
      return '<div class="team-reacts">' + chips + (block ? disabledAttr(addButton) : addButton) + '</div>';
    }

    async function react(message, emoji) {
      if (!message || message.deleted || typeof emoji !== 'string' || blockOf('react')) return;
      const lists = new Map(reactionsOf(message));
      const on = !(lists.get(emoji) || []).includes(ctx().me);
      if (on && !lists.has(emoji) && lists.size >= REACTIONS_MAX) return;
      const id = message.id;
      const mark = { on, rev: message.rev, token: ++token, done: false, doneRev: 0 };
      if (!overlay.has(id)) overlay.set(id, new Map());
      overlay.get(id).set(emoji, mark);
      notes.delete(id);
      redraw();
      const answer = await writes.call('chatReact', { channel_id: channelId, message_id: id, emoji, on });
      if (disposed) return;
      const held = overlay.has(id) ? overlay.get(id).get(emoji) : null;
      if (!held || held.token !== mark.token) return; // a later press decides; main keeps the final state
      if (answer && answer.ok) {
        held.done = true;
        held.doneRev = Number(answer.rev) || 0;
      } else {
        overlay.get(id).delete(emoji);
        notes.set(id, on ? jt('team.react.notAdded', 'Your reaction was not added. {reason}', { reason: failWords(answer, 'react') })
          : jt('team.react.notRemoved', 'Your reaction was not removed. {reason}', { reason: failWords(answer, 'react') }));
      }
      redraw();
    }

    // ------------------------------------------------------------ the picker

    function pickerHtml(message) {
      const list = chat.emoji(teamId) || [];
      const have = new Map(reactionsOf(message));
      const full = have.size >= REACTIONS_MAX;
      const me = ctx().me;
      const cells = list.map((emoji) => inv().actionButton({ plain: true, className: 'team-emoji__btn', title: emoji, ariaPressed: (have.get(emoji) || []).includes(me),
        disabled: full && !have.has(emoji), dataset: { emoji }, trustedHtml: escapeHtml(emoji) })).join('');
      return '<h3 class="team-pop__head">' + escapeHtml(jt('team.react.add', 'Add reaction')) + '</h3>'
        + (full ? '<p class="team-pop__note">' + escapeHtml(capSentence()) + '</p>' : '') + '<div class="team-emoji" role="group">' + cells + '</div>';
    }

    // Moves the focus over the grid: arrows by one and by a row, Home and End; a greyed cell is passed over.
    function pickerKeys(event, el) {
      const cells = [...el.querySelectorAll('.team-emoji__btn')];
      const at = cells.indexOf(cells.includes(event.target) ? event.target : el.ownerDocument.activeElement);
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: PICKER_COLUMNS, ArrowUp: -PICKER_COLUMNS }[event.key];
      if (!step && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      let next = -1;
      if (event.key === 'Home') next = cells.findIndex((b) => !b.disabled);
      else if (event.key === 'End') next = cells.map((b) => b.disabled).lastIndexOf(false);
      else if (at >= 0) {
        next = at + step;
        while (next >= 0 && next < cells.length && cells[next].disabled) next += step; // a greyed cell is passed over
      }
      if (next >= 0 && next < cells.length) cells[next].focus();
    }

    // Opens the picker for a message at `anchor` (the smiley, the add chip, or More's row).
    function openPicker(message, anchor) {
      if (!message || message.deleted || blockOf('react') || !(chat.emoji(teamId) || []).length) return false;
      const id = message.id;
      if (pop.isOpen('picker:' + id)) { pop.close(); return true; }
      const el = pop.open({ key: 'picker:' + id, className: 'team-pop--emoji', label: jt('team.react.add', 'Add reaction'), html: pickerHtml(message), anchor,
        keep: rows.openerOf(rowOf, id, '[data-team-msg-action="react-pick"], [data-team-msg-action="react-add"]'),
        restore: () => { const row = rowOf(id); if (row) row.focus(); }, onKeydown: pickerKeys });
      if (!el) return false;
      el.addEventListener('click', (event) => {
        const cell = event.target.closest && event.target.closest('.team-emoji__btn');
        if (!cell || cell.disabled) return;
        const emoji = cell.dataset.emoji;
        pop.close();
        const now = messageOf(id);
        if (now) void react(now, emoji);
      });
      const first = el.querySelector('.team-emoji__btn:not([disabled])');
      if (first) first.focus();
      return true;
    }

    // ------------------------------------------------------------ pins

    async function pin(message) {
      if (!message || message.deleted || pinning.has(message.id)) return;
      const on = !message.pinned;
      const failed = (why) => (on ? jt('team.pin.notPinned', 'Not pinned. {reason}', { reason: why }) : jt('team.pin.notUnpinned', 'Not unpinned. {reason}', { reason: why }));
      const id = message.id;
      const block = pinBlock(message);
      if (block) { notes.set(id, failed(block)); redraw(); return; }
      pinning.add(id);
      notes.delete(id);
      const answer = await writes.call('chatPin', { channel_id: channelId, message_id: id, on });
      pinning.delete(id);
      if (disposed) return;
      if (!answer || !answer.ok) { notes.set(id, failed(failWords(answer, 'pin'))); redraw(); }
    }

    function pinMark(message, c) {
      if (!message.pinned || typeof message.pinned !== 'object') return '';
      const text = message.pinned.by === c.me ? jt('team.pin.byYou', 'Pinned by you')
        : jt('team.pin.by', 'Pinned by {name}', { name: c.nameOf(message.pinned.by) });
      return '<span class="team-pinmark">' + rows.PIN_ICON + escapeHtml(text) + '</span>';
    }

    // ------------------------------------------------------------ what the row draws

    // { chips, facts, note, sig } for a message row: the chips line, the pin mark, and the last refusal's words.
    function parts(message, c) {
      if (message.deleted) return { chips: '', facts: '', note: '', sig: '' };
      const chips = chipsHtml(reactionsOf(message), c);
      const facts = pinMark(message, c);
      const said = notes.get(message.id) || '';
      const note = said ? '<span class="team-failed">' + escapeHtml(said) + '</span>' : '';
      return { chips, facts, note, sig: chips + '|' + facts + '|' + note + '|' + passOf(c).hasList };
    }

    // The action row's smiley: greyed, with its reason, while a reaction cannot be sent or the list is not in yet.
    function smileyHtml(c) {
      const label = jt('team.react.add', 'Add reaction');
      const { react: block, hasList } = passOf(c);
      const why = block || (hasList ? '' : waitingWords());
      const text = why ? label + ' ' + why : label;
      return inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: text, title: text, ariaHaspopup: 'dialog', tabIndex: -1,
        disabled: Boolean(why), dataset: { 'team-msg-action': 'react-pick' }, trustedHtml: SMILEY });
    }
    // What smileyHtml depends on, for a cache key.
    const actsKey = (c) => { const p = passOf(c); return p.react + '|' + p.hasList; };

    // More's first entries for a message (none for a deleted one): Add reaction, Pin or Unpin, a separator.
    function menuItems(message) {
      if (!message || message.deleted) return [];
      const reactBlock = blockOf('react');
      const reactWhy = reactBlock || ((chat.emoji(teamId) || []).length ? '' : waitingWords());
      const pinWhy = pinBlock(message);
      return [
        { label: jt('team.react.add', 'Add reaction'), value: 'react', disabled: Boolean(reactWhy), description: reactWhy,
          action: () => { const row = rowOf(message.id); openPicker(message, row && row.querySelector('[data-team-msg-action="more"]') || row); } },
        { label: message.pinned ? jt('team.pin.unpin', 'Unpin') : jt('team.pin.pin', 'Pin'), value: 'pin', shortcutHint: 'P', disabled: Boolean(pinWhy), description: pinWhy,
          action: () => { void pin(message); } },
      ];
    }

    return {
      parts, smileyHtml, actsKey, menuItems, react, pin, openPicker,
      dispose() { disposed = true; overlay.clear(); notes.clear(); },
    };
  }

  return { createMarks, blockWords };
});
