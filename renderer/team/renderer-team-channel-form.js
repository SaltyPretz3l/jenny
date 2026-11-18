/* The New channel view (row 173, renderer slice; owner pick: create in the main area, as New message does). It takes the place
 * of the timeline and composer; the tab draws its header ("New channel" and Close) and owns what Create does. One instance
 * per frame, with the interface the tab's pseudo-screens share (`update`, `focus`, `focusTarget`, `dispose`).
 *
 * - Name (the # before it is drawn by the stylesheet) and an optional Topic, one sentence on who reads the channel, Create channel and Cancel.
 * - The name is checked as it is typed against what the host checks (renderer-team-channel-menu.js `nameProblem`: length, a
 *   leading #, a name already listed with archived ones included, case ignored). Create is off until the name is valid and
 *   while a request is out; Enter in either field creates.
 * - The host's refusal shows under the field it concerns, keeps what was typed and puts the focus back in the name. Create is
 *   never retried by itself. Esc anywhere in the view, and Cancel, close it.
 * Names and topics are the person's own text: set as values, never as markup. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-team-channel-menu'));
    return;
  }
  root.rendererTeamChannelForm = factory(root.rendererTeamChannelMenu);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (menu) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function inv() { return globalThis.inventory || {}; }
  const nameHint = () => jt('team.channels.form.nameHint', 'Up to {count} characters. Spaces are fine. Names are unique in the team.', { count: menu.NAME_MAX });
  const topicHint = () => jt('team.channels.form.topicHint', 'Optional. One line, up to {count} characters.', { count: menu.TOPIC_MAX });

  // `rows()`: the team's channel rows (names already taken); `create(name, topic)`: the host's answer; `onClose()`.
  function createForm({ root, rows, create, onClose }) {
    let busy = false;
    let error = null; // { field: 'name' | 'topic', text }
    let disposed = false;
    const field = (name, extra) => globalThis.inventoryTextField({ dataset: { 'chan-field': name }, spellcheck: false, ...extra });

    root.innerHTML = '<div class="team-newchan"><div class="team-newchan__form">'
      + field('name', { label: jt('team.channels.form.name', 'Name'), placeholder: jt('team.channels.form.namePlaceholder', 'e.g. design'), maxLength: menu.NAME_MAX * 2, hint: nameHint(), className: 'team-newchan__field team-newchan__field--name' })
      + field('topic', { label: jt('team.channels.form.topic', 'Topic (optional)'), placeholder: jt('team.channels.form.topicPlaceholder', 'What this channel is for'), multiline: true, rows: 2, maxLength: menu.TOPIC_MAX, hint: topicHint(), className: 'team-newchan__field' })
      + '<p class="team-newchan__who">' + escapeHtml(jt('team.channels.form.who', 'Everyone on this team can read and post in it, people who join later included. Read-only members can read it. You can rename or archive it later; the owner can too.')) + '</p>'
      + '<div class="team-newchan__bar">' + inv().actionButton({ label: jt('team.channels.form.create', 'Create channel'), variant: 'primary', size: 'sm', dataset: { 'chan-form': 'create' }, disabled: true })
      + inv().actionButton({ label: jt('team.channels.form.cancel', 'Cancel'), size: 'sm', dataset: { 'chan-form': 'cancel' } }) + '</div></div></div>';
    const q = (selector) => root.querySelector(selector);
    const nameEl = q('[data-chan-field="name"]');
    const topicEl = q('[data-chan-field="topic"]');
    const button = q('[data-chan-form="create"]');
    const hintOf = (el) => el.closest('label').querySelector('.inv-text-field-hint');

    function setHint(el, text, bad) {
      const hint = hintOf(el);
      if (hint.textContent !== text) hint.textContent = text;
      if (bad) hint.dataset.error = 'true'; else delete hint.dataset.error;
    }
    const problem = () => menu.nameProblem(nameEl.value, rows());
    const valid = () => Boolean(menu.normalizeName(nameEl.value)) && !problem();

    function draw() {
      if (disposed) return;
      const bad = problem();
      setHint(nameEl, (error && error.field === 'name' && error.text) || bad || nameHint(), Boolean((error && error.field === 'name') || bad));
      setHint(topicEl, (error && error.field === 'topic' && error.text) || topicHint(), Boolean(error && error.field === 'topic'));
      button.disabled = busy || !valid();
    }

    async function submit() {
      if (busy || !valid()) return;
      busy = true;
      error = null;
      draw();
      const answer = await create(menu.normalizeName(nameEl.value), menu.normalizeTopic(topicEl.value));
      if (disposed) return;
      busy = false;
      if (!answer || !answer.ok) {
        const reason = answer && answer.error && answer.error.reason;
        error = { field: reason === 'team_chat_channel_topic_invalid' ? 'topic' : 'name', text: menu.failText(answer || { reason: 'team_unavailable' }) };
        draw();
        nameEl.focus();
      }
    }

    // Closing puts the keyboard back on the plus that opened the view (the tab's frame is drawn again by then).
    function close() {
      const doc = root.ownerDocument;
      onClose();
      const plus = doc.querySelector('[data-team-tab-action="channel-new"]');
      if (plus && !plus.disabled) plus.focus();
    }
    function onClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-chan-form]') : null;
      if (!target || target.disabled) return;
      if (target.dataset.chanForm === 'cancel') close(); else if (target.dataset.chanForm === 'create') void submit();
    }
    function onKeydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key === 'Enter' && !event.isComposing && !event.shiftKey && (event.target === nameEl || event.target === topicEl)) { event.preventDefault(); void submit(); }
    }
    // Typing clears a refusal: it was about what was there before.
    function onInput(event) { if (event.target === nameEl || event.target === topicEl) { error = null; draw(); } }
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('input', onInput);
    draw();

    return {
      update: draw,
      focus() { nameEl.focus(); return true; },
      focusTarget: () => nameEl,
      dispose() {
        disposed = true;
        root.removeEventListener('click', onClick);
        root.removeEventListener('keydown', onKeydown);
        root.removeEventListener('input', onInput);
      },
    };
  }

  return { createForm };
});
