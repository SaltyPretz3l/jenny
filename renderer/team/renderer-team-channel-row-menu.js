/* The Team column's channel and direct conversation rows: their context menu (TEAM_CHAT_PARITY_GAPS item 14). A right-click,
 * Shift+F10 or the Menu key on a row (`[data-team-channel]`) opens the inventory context menu with Mark read, Rename, Archive
 * (Unarchive on an archived channel) and Copy link. The rules are the header menu's (`channelActions`): an action this member
 * may not take is disabled with its reason, never hidden. A direct conversation has no link and cannot be renamed or archived.
 * Rename shows that channel and opens the header's name field; Archive acts on the row it was asked of without showing it.
 * A project channel (`kind: 'project'`, OD-8) has the same menu, named by its project; its rename and archive are the project's, so they are greyed with the reason.
 * Created by the channel menu's controller (renderer-team-channel-menu.js), which owns the edit and the archive call.
 * Names are other members' text: they reach the menu as text, never markup. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamChannelRowMenu = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const ROW = '[data-team-channel]';
  const isMenuKey = (event) => event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
  const rowOf = (target) => (target && typeof target.closest === 'function' ? target.closest(ROW) : null);

  // `deps`: container(), team() (the shown team row or null), chat() (the chat store), channels (renderer-team-channels.js),
  // channelActions(row, team, nameOf), nameOf(teamId) -> (memberId) => name, show(teamId, channelId), rename(team, row),
  // archive(team, row, on), note(text) (a sentence in the header's note line).
  function createRowMenu(deps) {
    let openFor = ''; // the channel id whose menu is open
    let listening = null; // the container the contextmenu listener is on
    const menuApi = () => (globalThis.inventory && globalThis.inventory.contextMenu) || globalThis.inventoryContextMenu || null;

    function titleOf(team, row) {
      if (!deps.channels.isDirect(row)) return '#' + deps.channels.channelName(row.channel_id, team.team_id);
      const name = deps.nameOf(team.team_id);
      const former = jt('team.chat.formerMember', 'Former member');
      return deps.channels.namesText(deps.channels.others(row, team.member_id).map((id) => name(id) || former));
    }

    async function copyLink(team, row) {
      const link = globalThis.rendererTeamLink || (typeof require === 'function' ? require('./renderer-team-link') : null);
      const token = link ? link.build({ teamId: team.team_id, channelId: row.channel_id }) : '';
      const clipboard = globalThis.window && globalThis.window.jennyShell && globalThis.window.jennyShell.clipboard;
      let ok;
      try { ok = Boolean(token && clipboard && typeof clipboard.writeText === 'function') && (await clipboard.writeText(token), true); } catch (_error) { ok = false; }
      if (!ok) deps.note(jt('team.link.copyFailed', 'The link could not be copied.'));
    }

    // The menu's items for one row; each action this member may not take is disabled with its reason.
    function itemsFor(team, row) {
      const direct = deps.channels.isDirect(row);
      const can = deps.channelActions(row, team, deps.nameOf(team.team_id));
      const unread = row.unread > 0 || row.unread_capped === true;
      const seq = Number.isSafeInteger(row.last_seq) && row.last_seq > 0 ? row.last_seq : 0;
      const off = (reason) => (reason ? { disabled: true, description: reason } : {});
      const archive = row.archived
        ? { value: 'unarchive', label: jt('team.channels.menu.unarchive', 'Unarchive'), ...off(can.unarchive), action: () => deps.archive(team, row, false) }
        : { value: 'archive', label: jt('team.channels.menu.archive', 'Archive channel'), ...off(can.archive), action: () => deps.archive(team, row, true) };
      return [
        { value: 'mark-read', label: jt('team.channels.rowMenu.markRead', 'Mark read'), ...off(unread && seq ? '' : jt('team.channels.rowMenu.nothingUnread', 'Nothing unread.')),
          action: () => { deps.chat().markRead(team.team_id, row.channel_id, seq); } },
        { value: 'rename', label: jt('team.channels.menu.rename', 'Rename channel'), ...off(can.rename), action: () => deps.rename(team, row) },
        archive,
        { value: 'copy-link', label: jt('team.link.copyLabel', 'Copy link'), ...off(direct ? jt('team.channels.rowMenu.noLink', 'A direct conversation has no link.') : ''),
          action: () => copyLink(team, row) },
      ];
    }

    function open(el, where) {
      const team = deps.team();
      const api = menuApi();
      const row = team && el ? deps.chat().channel(team.team_id, el.dataset.teamChannel) : null;
      if (!row || !api || typeof api.show !== 'function' || !(deps.channels.isDirect(row) || deps.channels.isCustom(row) || deps.channels.isProject(row) || row.kind === 'team')) return false;
      const id = row.channel_id;
      openFor = id;
      api.show({ ...where, rootEl: el, restoreFocusTo: el, className: 'team-channel-menu', heading: titleOf(team, row), items: itemsFor(team, row),
        ariaLabel: deps.channels.isDirect(row) ? jt('team.channels.rowMenu.dmLabel', 'Conversation options') : jt('team.channels.menu.label', 'Channel options'),
        onHide: () => {
          openFor = '';
          // A redraw while the menu was open replaced the row: the focus goes to the new one, only if nothing took it.
          const doc = el.ownerDocument;
          const root = deps.container();
          const again = !el.isConnected && root ? [...root.querySelectorAll(ROW)].find((r) => r.dataset.teamChannel === id) : null;
          if (again && doc.activeElement === doc.body) again.focus({ preventScroll: true });
        } });
      return true;
    }

    // Right-click. The contextmenu event the Menu key raises after its keydown opened the menu is the same ask.
    function onContextMenu(event) {
      const el = rowOf(event.target);
      if (!el || !deps.container() || !deps.container().contains(el)) return;
      if (event.button !== 2 && openFor === el.dataset.teamChannel) { event.preventDefault(); return; }
      if (open(el, { anchorX: event.clientX, anchorY: event.clientY })) event.preventDefault();
    }

    // Shift+F10 and the Menu key on a focused row; true when the key was one and a menu opened.
    function onKey(event) {
      if (!isMenuKey(event)) return false;
      const el = rowOf(event.target);
      if (!el || el !== event.target || !deps.container() || !deps.container().contains(el)) return false;
      if (!open(el, { anchorEl: el })) return false;
      event.preventDefault();
      return true;
    }

    // The tab registers its listeners once; this one rides on the container the first time the controller reads.
    function attach() {
      const container = deps.container();
      if (container === listening) return;
      dispose();
      if (!container) return;
      container.addEventListener('contextmenu', onContextMenu);
      listening = container;
    }

    function dispose() {
      if (listening) listening.removeEventListener('contextmenu', onContextMenu);
      listening = null;
      if (openFor) {
        openFor = '';
        const api = menuApi();
        if (api && typeof api.hide === 'function') api.hide({ restoreFocus: false });
      }
    }

    return { attach, onKey, dispose };
  }

  return { createRowMenu };
});
