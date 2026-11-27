/* Someone wants to join (row 123, slice 2a-5a, plan row E40): the app's notice
 * look (the `.inv-toast` classes of styles/toast.css, not the toast
 * controller) centred over the top of the timeline. One person at a time, in
 * the order they asked, with "1 of N" and previous and next; Admit <name> and
 * Decline answer only the person shown; Later sets that person aside under
 * "Wants to join" in the column for this run of the app. Only the owner of
 * the team hosted and connected here sees it. It never takes focus and never
 * times out. Pure: people and state in, HTML out; the Team tab controller
 * writes it into the notice region and handles its buttons.
 *
 * Slice 6-7 (TEAM_MODEL_SHARING_SPEC "6-7 as built", decisions 4 and 11): the
 * region's second kind, someone offers this member a model. Every member who
 * can receive sees it; a join request keeps the card first. One offer at a
 * time: the shown team's first, then the oldest. Review… sets the model
 * store's review id and opens Settings › Models, where the Library opens the
 * accept drawer; Decline answers the offer; Later sets it aside for this run
 * (its row in Settings › Models stays and the Team tab's number still counts
 * it). Names come from another member: cleaned and cut before escaping. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-settings-team-strings'), require('./renderer-team-chat-store'));
    return;
  }
  root.rendererTeamNotice = factory(root.rendererSettingsTeamStrings, root.rendererTeamChatStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (words, chatStore) {
  'use strict';

  const share = words.modelWords; // model sharing's words: names cleaned and cut, sizes, refusals

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const MARK = '<svg class="inv-toast__mark" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">'
    + '<circle cx="8" cy="6" r="2.4"/><path d="M3.5 13c.5-2.4 2.3-3.6 4.5-3.6s4 1.2 4.5 3.6"/></svg>';
  const ARROW = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5L5 8l4.5 4.5"/></svg>';
  const CLOSE = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

  function inv() { return globalThis.inventory || {}; }

  // The order they asked in: each person's first device, oldest first (the roster's order breaks ties).
  function askedOrder(people) {
    const asked = (member) => Number(((member.devices || [])[0] || {}).created_at) || 0;
    return people.map((member, index) => ({ member, index }))
      .sort((a, b) => asked(a.member) - asked(b.member) || a.index - b.index).map((entry) => entry.member);
  }

  // The person to show: the one shown before while they still wait, else the one now at that place.
  function pick(queue, shownId, shownIndex) {
    if (!queue.length) return { person: null, index: 0 };
    const found = queue.findIndex((member) => member.member_id === shownId);
    const index = found >= 0 ? found : Math.min(Math.max(0, shownIndex), queue.length - 1);
    return { person: queue[index], index };
  }

  // `state`: { person, index, total, isBusy(key), error }.
  function noticeHtml(state) {
    const person = state.person;
    if (!person) return '';
    const name = chatStore.isolate(person.display_name); // said inside sentences: keeps its own direction
    const device = (person.devices || [])[0] || {};
    const id = person.member_id;
    const button = (action, text, kind) => inv().actionButton({
      plain: true, className: 'inv-toast__action inv-toast__action--' + kind, label: text,
      dataset: { 'team-action': action, 'member-id': id }, disabled: state.isBusy(action + ':' + id),
    });
    const page = (dir, text, extra) => inv().actionButton({
      plain: true, className: 'team-icon-btn' + extra, ariaLabel: text, title: text, dataset: { 'team-notice': dir }, trustedHtml: ARROW,
    });
    const pager = state.total > 1 ? '<span class="team-notice__pager">' + page('prev', jt('team.notice.previous', 'Previous request'), '')
      + '<span class="team-notice__count">' + escapeHtml(jt('team.notice.count', '{index} of {total}', { index: state.index + 1, total: state.total })) + '</span>'
      + page('next', jt('team.notice.next', 'Next request'), ' team-notice__next') + '</span>' : '';
    const later = jt('team.notice.laterTitle', 'Later: {name} moves to Wants to join', { name });
    return '<div class="inv-toast inv-toast--info" role="status" aria-live="polite">' + MARK
      + '<div class="inv-toast__body"><p class="inv-toast__eyebrow">' + escapeHtml(jt('team.tab.wantsToJoin', 'Wants to join')) + '</p>'
      + '<p class="inv-toast__message" dir="auto">' + escapeHtml(jt('team.notice.person', '{name} · {device} · key {key}', {
        name, device: device.label || '', key: words.formatFingerprint(device.fingerprint) })) + '</p>'
      + '<p class="team-notice__hint">' + escapeHtml(state.declining ? jt('settings.team.people.declineConfirm', 'Decline {name}? Their invite is used up; invite them again to let them in.', { name })
        : jt('settings.team.people.hint', 'Check the name and the key with them before you admit them. They see the same key on their screen.')) + '</p>'
      + '<div class="inv-toast__actions">' + (state.declining ? button('confirm-decline', jt('settings.team.people.declineAction', 'Decline {name}', { name }), 'primary') + button('confirm-cancel', jt('settings.team.cancel', 'Cancel'), 'secondary')
        : button('admit', jt('team.notice.admit', 'Admit {name}', { name }), 'primary') + button('decline', jt('settings.team.people.decline', 'Decline'), 'secondary')) + pager + '</div>'
      + (state.error ? '<p class="team-notice__error" role="alert">' + escapeHtml(state.error) + '</p>' : '') + '</div>'
      + inv().actionButton({ plain: true, className: 'inv-toast__dismiss', ariaLabel: jt('team.notice.later', 'Later'), title: later,
        dataset: { 'team-notice': 'later', 'member-id': id }, trustedHtml: CLOSE })
      + '</div>';
  }

  // ------------------------------------------------------------ model offers

  const BOX = '<svg class="inv-toast__mark" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M8 2.5v7M5 6.8l3 3 3-3M3 12.5h10"/></svg>';

  // The offer to show: open, not taken, not set aside or dismissed; the shown team's first, then the oldest.
  function nextOffer(models, teams, shownTeamId) {
    if (!models) return null;
    const names = new Map(teams.map((team) => [team.team_id, team.team_name]));
    const open = [];
    for (const state of models.teams()) {
      if (!names.has(state.teamId)) continue;
      for (const row of state.incoming) {
        if (row.state === 'open' && !row.transfer && !models.isLater(row.offer_id) && !models.isDismissed(row.offer_id)) open.push({ teamId: state.teamId, teamName: names.get(state.teamId), row });
      }
    }
    const when = (entry) => Date.parse(entry.row.offered_at) || 0;
    open.sort((a, b) => Number(a.teamId !== shownTeamId) - Number(b.teamId !== shownTeamId) || when(a) - when(b));
    return open.length ? { ...open[0], other: open[0].teamId !== shownTeamId } : null;
  }

  // `state`: { offer (nextOffer's answer), isBusy(key), error }.
  function offerHtml(state) {
    const offer = state.offer;
    if (!offer || !share) return '';
    const row = offer.row;
    const ids = { 'team-id': offer.teamId, 'offer-id': row.offer_id };
    const said = (value) => chatStore.isolate(share.clean(value));
    const params = { sender: said(row.sender_name), model: said(row.display_name), size: share.size(row.total_bytes), team: said(offer.teamName) };
    const button = (action, text, title, kind) => inv().actionButton({
      plain: true, className: 'inv-toast__action inv-toast__action--' + kind, label: text, title,
      dataset: { 'team-notice': action, ...ids }, disabled: state.isBusy(action + ':' + row.offer_id),
    });
    const message = offer.other ? jt('team.notice.offerTeam', '{sender} · {model} · {size} · {team}', params) : jt('team.notice.offer', '{sender} · {model} · {size}', params);
    return '<div class="inv-toast inv-toast--info" role="status" aria-live="polite">' + BOX
      + '<div class="inv-toast__body"><p class="inv-toast__eyebrow">' + escapeHtml(jt('team.notice.offerEyebrow', 'Offers you a model')) + '</p>'
      + '<p class="inv-toast__message" dir="auto">' + escapeHtml(message) + '</p>'
      + '<p class="team-notice__hint">' + escapeHtml(jt('team.notice.offerHint', 'Only accept models from people you trust. Review shows what is in it before anything downloads.')) + '</p>'
      + '<div class="inv-toast__actions">' + button('offer-review', jt('team.notice.offerReview', 'Review…'),
        jt('team.notice.offerReviewTitle', 'Open the offer in Settings, Models to see what is in it'), 'primary')
      + button('offer-decline', jt('team.notice.offerDecline', 'Decline'), jt('team.notice.offerDeclineTitle', 'Say no to {sender}', params), 'secondary') + '</div>'
      + (state.error ? '<p class="team-notice__error" role="alert">' + escapeHtml(state.error) + '</p>' : '') + '</div>'
      + inv().actionButton({ plain: true, className: 'inv-toast__dismiss', ariaLabel: jt('team.notice.later', 'Later'),
        title: jt('team.notice.offerLater', 'Later: the offer waits in Settings, Models'), dataset: { 'team-notice': 'offer-later', ...ids }, trustedHtml: CLOSE })
      + '</div>';
  }

  // The tab's part for offers. deps: { models() (the model store or null), openSettings() (the tab's opener or
  // null), render() }. `action` answers true for an offer's control (its `data-team-notice` starts with "offer-").
  function createOffers(deps) {
    const busy = new Set();
    let error = null; // { offerId, text }
    function html(teams, shownTeamId) {
      const offer = nextOffer(deps.models(), teams, shownTeamId);
      return offerHtml({ offer, isBusy: (key) => busy.has(key), error: offer && error && error.offerId === offer.row.offer_id ? error.text : '' });
    }
    function action(name, dataset) {
      if (!/^offer-/.test(String(name))) return false;
      const models = deps.models();
      const teamId = dataset.teamId || '';
      const offerId = dataset.offerId || '';
      if (!models || !teamId || !offerId) return true;
      if (name === 'offer-review') {
        models.setReview(teamId, offerId);
        const open = deps.openSettings();
        if (open) open('models');
      } else if (name === 'offer-later') {
        models.setLater(offerId);
      } else if (name === 'offer-decline' && !busy.has(name + ':' + offerId)) {
        busy.add(name + ':' + offerId);
        error = null;
        deps.render();
        void models.call('modelDecline', { team_id: teamId, offer_id: offerId }).then((answer) => {
          busy.delete(name + ':' + offerId);
          if (answer.ok) models.setLater(offerId); // the card goes now; the row ends with main's push
          else error = { offerId, text: share.reasonText(answer.error && answer.error.reason) };
          deps.render();
        });
        return true;
      }
      deps.render();
      return true;
    }
    return { html, action, reset() { busy.clear(); error = null; } };
  }

  return { askedOrder, pick, noticeHtml, nextOffer, offerHtml, createOffers };
});
