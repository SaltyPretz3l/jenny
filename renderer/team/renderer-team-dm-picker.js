/* The New message view (row 123, slice 2d renderer; owner pick 1, variant A, mockup team-dm).
 * It takes the place of the timeline and composer in the main area; nothing floats over the page. One instance per
 * frame; the controller (renderer-team-tab.js) draws its header ("New message" and Close) and owns what Start does.
 *
 * - "To:": one removable chip per picked person, then a field ("Type a name") that filters the list by display name.
 * - The list: every other member of the team, never this member: presence dot, display name, the presence fact for
 *   anyone not online, a tick on a picked row. A click picks or unpicks; at most seven people (the host's bound).
 * - The bar: a hint ("Pick one person or several." with nobody picked; "You can pick up to 7 people." at the cap;
 *   "You already have this conversation. Start opens it." when a conversation with exactly those people is listed;
 *   else the standing line of owner pick 2), Cancel, and Start, disabled until someone is picked and while a start
 *   is out. The hint, the error line and both buttons are built once and only changed, so a redraw keeps them.
 * - Keys in the field: Enter picks the first match while there is filter text (never unpicks: a match already picked
 *   only clears the field) and starts when it is empty and someone is picked; Enter inside an IME composition does
 *   nothing; Backspace in an empty field removes the last chip; Esc anywhere in the view closes it.
 * - A redraw (anyone's presence, a member, a conversation) keeps the focused row or chip by its member id.
 * - A refusal shows its sentence here, keeps the picks and puts the focus back on Start; changing the picks clears
 *   it. Start is never retried, so the rate limit and the disk gate get sentences of their own.
 * - Rows are reached with Tab; arrow keys inside the list are not built (TEAM_CHAT_SPEC known limit).
 * Display names are host text: always escaped. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('./renderer-team-channels'));
    return;
  }
  root.rendererTeamDmPicker = factory(root.rendererSettingsTeamStrings, root.rendererTeamChannels);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, channels) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const SVG = (paths) => '<svg viewBox="0 0 16 16" aria-hidden="true">' + paths + '</svg>';
  const X = SVG('<path d="M4 4l8 8M12 4l-8 8"/>');
  const CHECK = SVG('<path d="M3.5 8.5l3 3 6-7"/>');

  function inv() { return globalThis.inventory || {}; }
  function textField(options) { return globalThis.inventoryTextField(options); }
  const standing = () => jt('team.dm.standing', 'The team’s host can read direct messages.');
  // A refused Start in words. The outbox's sentences for these two promise a retry that Start never makes.
  function refusalText(error) {
    const reason = error && error.reason;
    if (reason === 'team_chat_rate_limit') return jt('team.dm.rateLimit', 'Too many new conversations at once. Try again in a moment.');
    if (reason === 'disk_pressure') return jt('team.dm.diskPressure', 'The team’s host is out of room. Try again later.');
    return words.errorText(error || { reason: 'team_unavailable' });
  }

  // `ctx()`: the frame context (people, me, nameOf); `rows()`: the team's channel rows; `lastSeen(value)`: a time in
  // words; `onStart(ids)`: answers chatDmOpen's answer; `onClose()`: back to the channel shown before.
  function createPicker({ root, ctx, rows, lastSeen, onStart, onClose }) {
    let picked = [];
    let busy = false;
    let error = '';
    let disposed = false;
    const collator = new Intl.Collator(globalThis.jennyI18n?.tag?.() || undefined, { sensitivity: 'base', numeric: true });

    root.innerHTML = '<div class="team-to"><span class="team-to__label">' + escapeHtml(jt('team.dm.to', 'To:')) + '</span><span class="team-to__chips"></span>'
      + textField({ className: 'team-to__field', placeholder: jt('team.dm.typeName', 'Type a name'), ariaLabel: jt('team.dm.toLabel', 'To'), spellcheck: false }) + '</div>'
      + '<div class="team-pick" role="listbox" aria-multiselectable="true" aria-label="' + escapeHtml(jt('team.dm.people', 'People on this team')) + '"></div>'
      + '<p class="team-pick__note" hidden></p>'
      + '<p class="team-pick__note team-pick__limit">' + escapeHtml(jt('team.dm.storageLimit', 'When the team’s chat storage is full, the oldest messages are removed, direct messages included.')) + '</p>'
      + '<div class="team-pick__bar"><span class="team-pick__hint" aria-live="polite"></span><p class="team-pick__error team-set-note" role="alert" hidden></p>'
      + inv().actionButton({ label: jt('team.dm.cancel', 'Cancel'), size: 'sm', dataset: { dm: 'cancel' } })
      + inv().actionButton({ label: jt('team.dm.start', 'Start'), variant: 'primary', size: 'sm', dataset: { dm: 'start' }, disabled: true }) + '</div>';
    const field = root.querySelector('.team-to__field .inv-text-field-control');
    const chipsBox = root.querySelector('.team-to__chips');
    const list = root.querySelector('.team-pick');
    const noteEl = root.querySelector('.team-pick__note');
    const hintEl = root.querySelector('.team-pick__hint');
    const errorEl = root.querySelector('.team-pick__error');
    const startButton = root.querySelector('[data-dm="start"]');
    const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };

    const people = () => { const c = ctx(); return c.people.filter((m) => m.member_id !== c.me).sort((a, b) => collator.compare(String(a.display_name || ''), String(b.display_name || ''))); };
    const query = () => field.value.trim().toLocaleLowerCase();
    const matches = () => people().filter((m) => !query() || String(m.display_name || '').toLocaleLowerCase().includes(query()));

    function rowHtml(member) {
      const on = picked.includes(member.member_id);
      const presence = member.state === 'online' || member.state === 'away' ? member.state : 'offline';
      const fact = member.state === 'online' ? '' : channels.presenceText(member, lastSeen);
      const title = on ? jt('team.dm.remove', 'Remove {name}', { name: String(member.display_name || '') }) : jt('team.dm.add', 'Add {name}', { name: String(member.display_name || '') });
      return channels.withAttrs(inv().actionButton({ plain: true, className: 'team-row team-row--link team-pick__row', dataset: { 'dm-pick': member.member_id }, title,
        trustedHtml: '<span class="team-dot" data-p="' + presence + '" aria-hidden="true"></span><span class="team-row__name" dir="auto">' + escapeHtml(member.display_name) + '</span>'
          + '<span class="team-row__meta">' + escapeHtml(fact) + '</span><span class="team-pick__tick" aria-hidden="true">' + (on ? CHECK : '') + '</span>' }),
      { role: 'option', 'aria-selected': on ? 'true' : 'false' });
    }

    function hint() {
      if (!picked.length) return jt('team.dm.hintPick', 'Pick one person or several.');
      if (picked.length >= channels.MAX_OTHERS) return jt('team.dm.hintMax', 'You can pick up to {count} people.', { count: channels.MAX_OTHERS });
      if (channels.existing(rows(), ctx().me, picked)) return jt('team.dm.hintExisting', 'You already have this conversation. Start opens it.');
      return standing();
    }

    // The focused row or chip as a selector, so a redraw can put the focus back on the same person.
    function focusedKey() {
      const active = root.ownerDocument.activeElement;
      if (!active || !root.contains(active)) return '';
      if (active.dataset.dmPick) return '[data-dm-pick="' + active.dataset.dmPick + '"]';
      return active.dataset.dmUnpick ? '[data-dm-unpick="' + active.dataset.dmUnpick + '"]' : '';
    }

    function draw() {
      if (disposed) return;
      const c = ctx();
      const keep = focusedKey();
      chipsBox.innerHTML = picked.map((id) => {
        const name = c.nameOf(id);
        const remove = jt('team.dm.remove', 'Remove {name}', { name });
        return '<span class="team-to__chip"><span dir="auto">' + escapeHtml(name) + '</span>'
          + inv().actionButton({ plain: true, className: 'team-icon-btn', ariaLabel: remove, title: remove, dataset: { 'dm-unpick': id }, trustedHtml: X }) + '</span>';
      }).join('');
      field.placeholder = picked.length ? '' : jt('team.dm.typeName', 'Type a name');
      const shown = matches();
      let note = '';
      if (!people().length) note = jt('team.dm.nobody', 'Nobody else is on this team yet.');
      else if (!shown.length) note = jt('team.dm.noMatch', 'Nobody on this team matches “{query}”.', { query: field.value.trim() });
      list.innerHTML = shown.map(rowHtml).join('');
      setText(noteEl, note);
      noteEl.hidden = !note;
      setText(hintEl, hint());
      setText(errorEl, error);
      errorEl.hidden = !error;
      startButton.disabled = !picked.length || busy;
      if (keep && !root.contains(root.ownerDocument.activeElement)) {
        const again = root.querySelector(keep);
        if (again) again.focus();
      }
    }

    // Every change of the picks clears a refusal's sentence.
    function setPicked(next) { picked = next; error = ''; }

    function toggle(id) {
      if (picked.includes(id)) setPicked(picked.filter((one) => one !== id));
      else if (picked.length < channels.MAX_OTHERS) setPicked(picked.concat(id));
      field.value = '';
      draw();
      field.focus();
    }

    async function start() {
      if (busy || !picked.length) return;
      busy = true;
      error = '';
      draw();
      const answer = await onStart(picked.slice());
      if (disposed) return;
      busy = false;
      const refused = !answer || !answer.ok;
      if (refused) error = refusalText(answer && answer.error);
      draw();
      if (refused) startButton.focus();
    }

    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-dm-pick], [data-dm-unpick], [data-dm]') : null;
      if (!target || target.disabled) return;
      if (target.dataset.dmPick) toggle(target.dataset.dmPick);
      else if (target.dataset.dmUnpick) { setPicked(picked.filter((id) => id !== target.dataset.dmUnpick)); draw(); field.focus(); }
      else if (target.dataset.dm === 'cancel') onClose();
      else if (target.dataset.dm === 'start') void start();
    }

    function onKeydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.target !== field) return;
      if (event.key === 'Enter') {
        if (event.isComposing) return;
        event.preventDefault();
        const first = query() ? matches()[0] : null;
        if (first && picked.includes(first.member_id)) { field.value = ''; draw(); } else if (first) toggle(first.member_id); else if (!query()) void start();
      } else if (event.key === 'Backspace' && !field.value && picked.length) {
        event.preventDefault();
        setPicked(picked.slice(0, -1));
        draw();
      }
    }

    const onInput = (event) => { if (event.target === field) draw(); };
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('input', onInput);
    draw();

    return {
      update: draw,
      focus() { field.focus(); return true; },
      focusTarget: () => field,
      picked: () => picked.slice(),
      dispose() {
        disposed = true;
        root.removeEventListener('click', onClick);
        root.removeEventListener('keydown', onKeydown);
        root.removeEventListener('input', onInput);
      },
    };
  }

  return { createPicker };
});
