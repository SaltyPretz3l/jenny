/* Team tab frame (row 201, OD-10 and C10.2), kept out of renderer-team-tab.js. A connected team gets one frame: the
 * column (switcher, search, lists), the header, banner, export and notice slots, made once per shown team. A channel
 * switch swaps the main pane only (the page roots after the notice slot: a channel's timeline and composer, a project
 * page or conversation, the Overview, the New message or New channel view) with its timeline, composer, writes, jumper,
 * thread and preview, so the search keeps its query and results, and the column its scroll and focus. The markup is
 * the tab view's own `frameHtml`, so a swapped pane is exactly what a fresh frame draws.
 *
 * `frame.key` is `teamId|channelId` (the pane shown), `frame.teamId` the team. A pane's callbacks act only while that
 * pane is still shown. `destroy({ clear })` ends the frame; `clear` (hiding the tab) also empties a project page or
 * conversation's region, so no hidden copy of its element ids stays in the document for the Board's conversation (C9.3).
 *
 * `createTabFrames(deps)`: the tab's modules and its controls (container(), live(), store(), chat(), render(),
 * viewModel(), timelineContext(), openSettings(), openThread(), openPreview, showElsewhere(), startDirect(), closeNew(),
 * channelUi). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamTabFrame = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PANE_PARTS = ['jumper', 'picker', 'project', 'overview', 'preview', 'thread', 'composer', 'timeline', 'writes'];

  // The page roots after the notice slot: what a channel switch replaces.
  function paneNodes(main) {
    const kids = main ? [...main.children] : [];
    const at = kids.findIndex((el) => el.dataset && el.dataset.teamRegion === 'notice');
    return at < 0 ? [] : kids.slice(at + 1);
  }

  function createTabFrames(deps) {
    const { tabView, chatWrites, link, searches, timelines, composers, pickers, channelForm, overviewPage, exporting, glue, channels, rows, words } = deps;
    let frame = null;

    // A thread or preview screen goes with its pane (its thread's composer saves its draft first).
    function disposePane(own) {
      const live = deps.live();
      if (live.screen === 'thread' || live.screen === 'preview') live.screen = 'channel';
      for (const part of PANE_PARTS) {
        if (own[part]) own[part].dispose();
        own[part] = null;
      }
    }

    // The pane for `vm.channelId`: its markup (`swap`: in place of the shown pane's) and its parts.
    function mountPane(own, vm, key, swap) {
      if (swap) {
        const template = own.main.ownerDocument.createElement('template');
        template.innerHTML = tabView.frameHtml(vm);
        paneNodes(own.main).forEach((el) => el.remove());
        own.main.append(...paneNodes(template.content.querySelector('.team-main')));
      }
      const teamId = own.teamId;
      const q = (selector) => own.main.querySelector(selector);
      const shown = { teamId, channelId: vm.channelId, chat: deps.chat(), ctx: () => deps.timelineContext(teamId, vm.channelId) };
      const writes = chatWrites.createWrites({ teamId, onBusy: () => { if (here() && own.timeline) own.timeline.update({ type: 'busy' }); } });
      const here = () => frame === own && own.writes === writes; // this pane is still the one shown
      Object.assign(own, { key, shown, writes, openerId: '' });
      own.jumper = link.createJumper({ chat: shown.chat, teamId, channelId: vm.channelId, call: writes.call, timeline: () => (here() ? own.timeline : null),
        openThread: (message) => { if (!here()) return null; deps.openThread(message, message.id); return here() ? own.thread : null; },
        showScreen: (name) => { if (here() && deps.live().screen !== name) { deps.live().screen = name; deps.render(); } },
        holdEdit: () => Boolean(here() && own.timeline && own.timeline.backToEdit()), rowOf: rows.rowOf, elsewhere: (target) => deps.showElsewhere(teamId, target) });
      if (glue.isPage(vm.channelId)) { own.project = glue.mount(q('[data-team-region="project"]'), teamId, vm.channelId); return; }
      if (vm.channelId === channels.OVERVIEW) {
        own.overview = overviewPage.createOverview({ root: q('[data-team-region="overview"]'), teamId, store: deps.store(), viewNow: () => deps.viewModel(), openSettings: deps.openSettings, peopleRows: tabView.peopleRows });
        return;
      }
      if (channels.NEW === vm.channelId || channels.NEW_CHANNEL === vm.channelId) {
        own.picker = (vm.channelId === channels.NEW ? pickers.createPicker : channelForm.createForm)({ root: q('[data-team-region="picker"]'), ctx: shown.ctx,
          rows: () => (deps.chat().team(teamId) || {}).channels || [], lastSeen: rows.lastSeenText, onStart: (ids) => deps.startDirect(teamId, ids),
          create: (name, topic) => deps.channelUi.create(teamId, name, topic), onClose: () => deps.closeNew(teamId) });
        return;
      }
      own.timeline = timelines.createTimeline({ ...shown, root: q('[data-team-region="timeline"]'), writes, focusComposer: () => Boolean(here() && own.composer && own.composer.focus()),
        onReply: (message) => deps.openThread(message, message.id) });
      own.composer = composers.createComposer({ ...shown, root: q('[data-team-region="composer"]'), writes, onEditLast: () => own.timeline.editLast() });
    }

    // The whole frame for a team just shown (or shown again).
    function build(vm, key) {
      destroy();
      const container = deps.container();
      container.innerHTML = tabView.frameHtml(vm);
      const q = (selector) => container.querySelector(selector);
      const teamId = vm.team.team_id;
      const own = { teamId, key: '', shown: null, shell: q('.team-shell'), panel: q('nav.team-panel'), main: q('.team-main'), last: {}, search: null, openerId: '',
        regions: { panelHead: q('[data-team-region="panel-head"]'), lists: q('[data-team-region="lists"]'), head: q('[data-team-region="head"]'),
          banner: q('[data-team-region="banner"]'), notice: q('[data-team-region="notice"]') } };
      for (const part of PANE_PARTS) own[part] = null;
      frame = own;
      exporting.tabLine().mount(q('[data-team-region="export"]'), teamId, () => (frame === own && own.timeline ? own.timeline.logRoot : null));
      own.shell.addEventListener('team:file-preview', deps.openPreview);
      mountPane(own, vm, key, false);
      own.search = searches.createSearch({ root: q('[data-team-region="search"]'), lists: own.regions.lists, panel: own.panel, ctx: () => own.shown.ctx(),
        call: (method, payload) => deps.store().call(method, { team_id: teamId, ...payload }),
        hostWords: () => { const team = deps.data().teams.find((t) => t.team_id === teamId); return team ? tabView.hostWords(team) || words.errorText({ reason: 'team_not_connected' }) : ''; },
        onJump: (match) => { if (frame === own && own.jumper) own.jumper.jump(match); },
        onState: () => { void Promise.resolve().then(() => { if (frame === own) deps.render(); }); } });
      return own;
    }

    // The frame for this team and pane: kept when both are shown, the pane swapped for another page of the same team.
    function ensure(vm, key) {
      if (frame && frame.teamId === vm.team.team_id) {
        if (frame.key !== key) { disposePane(frame); mountPane(frame, vm, key, true); }
        return frame;
      }
      return build(vm, key);
    }

    function destroy({ clear = false } = {}) {
      const own = frame;
      if (!own) return null;
      frame = null;
      own.search.dispose();
      disposePane(own);
      own.shell.removeEventListener('team:file-preview', deps.openPreview);
      const project = clear ? own.main.querySelector('[data-team-region="project"]') : null;
      if (project) project.textContent = '';
      return null;
    }

    return { ensure, destroy };
  }

  return { createTabFrames, paneNodes };
});
