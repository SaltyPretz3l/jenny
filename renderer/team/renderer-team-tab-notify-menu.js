/* Team tab: the shown channel's notification level menu (All messages, Mentions only, Nothing), moved out of
 * renderer-team-tab.js unchanged (row 175, so the tab file has room for the conversation intent's wiring). Loaded with
 * the tab's scripts, before the tab.
 *
 * `createNotifyMenu({ container, frame, live, alive, selectedTeam, viewModel, chat, render, menuApi, words, teamStore, tabView })`
 * answers { open() }. The menu's level is the shown channel's (`viewModel().notify`); a refused change says why in the
 * head's error line. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamTabNotifyMenu = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const LEVELS = ['all', 'mentions', 'none'];

  function createNotifyMenu({ container, frame, live, alive, selectedTeam, viewModel, chat, render, menuApi, words, teamStore, tabView }) {
    async function setNotify(level) {
      const s = live();
      const team = selectedTeam();
      if (!team) return;
      s.errors.head = '';
      const answer = await chat().setNotify(team.team_id, viewModel().channelId, level);
      if (!alive(s)) return;
      if (!answer.ok) s.errors.head = words.errorText(answer.error || teamStore.NO_ANSWER);
      render();
    }

    // The notification level of the shown channel: All messages, Mentions only, Nothing.
    function open() {
      const menu = menuApi();
      if (!menu || typeof menu.show !== 'function' || !frame()) return;
      const level = viewModel().notify;
      live().notifyOpen = true;
      render({ keepMenu: true });
      const anchor = container().querySelector('#teamNotifyButton');
      const s = live();
      menu.show({
        anchorEl: anchor, rootEl: anchor, restoreFocusTo: anchor, focusChecked: true, className: 'team-notify-menu',
        ariaLabel: jt('team.chat.notify.menu', 'Notify me about'),
        items: LEVELS.map((value) => ({ label: tabView.notifyText(value), checked: value === level, value, action: () => { void setNotify(value); } })),
        onHide: () => { if (alive(s) && s.notifyOpen) { s.notifyOpen = false; render(); } },
      });
    }

    return { open };
  }

  return { createNotifyMenu, LEVELS };
});
