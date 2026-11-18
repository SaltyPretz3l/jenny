/* The Team tab's gate (row 123, slice 1g-2). The top-nav shell loads this file
 * after first paint, and only while the `team` flag is exactly true; with the
 * flag off nothing here exists and `jennyShell.team` is never touched.
 *
 * Row 168: the tab is there whenever the flag is on (the shell's rail entry); with no
 * team it opens on the start page (renderer-team-start.js). `exists()` still
 * says this Jenny has joined a team or deployed one on this PC, for the count
 * and the chat stores. The gate keeps no team state of its own: the shared store
 * (renderer-team-store.js) is the one reader of `status` and `hostStatus`, the
 * one subscriber to the pushes and the one bridge call, and the gate holds it
 * for as long as the flag is on. With the flag on and no team data on disk
 * (main's `teamData: false`, E50) the shell does not load this file at all
 * until the first Join, Deploy or Recover, or until the Team tab is opened:
 * then the store starts quiet (`startQuiet`), nothing is read or subscribed
 * and the tab is shown `quiet`, until the start page's first action wakes it.
 * With team data but no team the cost is this file, the store, two listeners,
 * one `hostStatus` and one `status`.
 * The view's own scripts and stylesheets load when the view is first opened.
 * `onChange` redraws the rail, `onBadge` patches its count.
 *
 * The chat store (slice 2a-5a) loads here too, once this Jenny is a member of
 * a team: the tab's number (plan row E39) is the channels that mention you in
 * every connected team plus the people waiting to join a team this PC hosts,
 * and it moves while the Team view is closed (since slice 2d also the direct
 * conversations with unread messages, not muted). The gate keeps the chat store in
 * step with the teams (`sync`), which asks each connected team once. Presence
 * reports (slice 2a-5b) start with the chat store and stop with it, as do the team desktop notifications and
 * the palette's team rows (slice 2a-6c, renderer-team-notify.js and renderer-team-palette.js).
 *
 * Slice 3-10: once the Team tab's scripts have loaded (its first open in a run), the gate also holds the project
 * store (renderer-team-project-store.js): a project admin's waiting always-allow requests join the number, and its
 * tooltip names them. Before that first open they are not counted (a known limit: the project scripts load with
 * the tab, not with the gate).
 *
 * Slice 6-7: the model store (renderer-team-model-store.js) loads with the chat store and the gate holds it: the offers
 * waiting for this member's answer join the number, and its tooltip names them ("1 model offered to you"); an offer
 * set aside with Later on the tab's card still counts.
 *
 * Row 175 (D2): the approvals in team project conversations that wait for this member (their own turn's, or one with no
 * writer viewing in a project they write in) join the number too, from the notifier's count of main's `project_waiting`
 * pushes ("1 approval waits for you"); it moves while the Team view is closed.
 *
 * `ensureTeamAssets` is the one loader for team scripts and stylesheets; the
 * Settings > Team page uses it too (renderer-settings-utils.js). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamTabGate = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, Object.assign({ count }, params || {})); };
  const VIEW_STYLES = Object.freeze(['styles/team-settings.css', 'styles/team-tab.css', 'styles/team-chat.css', 'styles/team-projects.css']);

  // The tab's label: what the number counts, in words ("Team: 2 channels mention you, 1 person wants to join";
  // "1 unread conversation" since slice 2d).
  // Slice 3-10: `requests`, a project admin's waiting always-allow requests, joins the first part the same way.
  // Slice 6-7: `offers`, the models offered to this member and not yet answered, joins it last.
  // Row 175: `approvals`, the project approvals that wait for this member, joins it after the requests.
  function badgeLabel(mentions, waiting, direct = 0, requests = 0, offers = 0, approvals = 0) {
    const said = mentions ? jtn('team.tab.badge.mentions', mentions, {}, '{count} channel mentions you', '{count} channels mention you') : '';
    const unread = direct ? jtn('team.dm.badge', direct, {}, '{count} unread conversation', '{count} unread conversations') : '';
    const asked = requests ? jtn('team.projects.badge', requests, {}, '{count} always-allow request waits for you', '{count} always-allow requests wait for you') : '';
    const join = (first, second) => (first && second ? jt('team.dm.badgeJoin', '{first}, {second}', { first, second }) : first || second);
    const offered = offers ? jtn('team.models.badge', offers, {}, '{count} model offered to you', '{count} models offered to you') : '';
    const approving = approvals ? jtn('team.projects.badgeApprovals', approvals, {}, '{count} approval waits for you', '{count} approvals wait for you') : '';
    const first = join(join(join(join(said, unread), asked), approving), offered);
    const asking = waiting ? jtn('team.tab.badge.waiting', waiting, {}, '{count} person wants to join', '{count} people want to join') : '';
    if (first && asking) return jt('team.tab.badge.both', 'Team: {mentions}, {waiting}', { mentions: first, waiting: asking });
    return jt('team.tab.badge.one', 'Team: {what}', { what: first || asking });
  }

  // Loads manifest entries (`[src, globalName]`, in order) and adds each stylesheet once. Resolves
  // true when every global is there; a failed script can be asked for again.
  function ensureTeamAssets({ windowRef, scripts = [], styles = [] } = {}) {
    const loader = windowRef && windowRef.scriptLoaderUtils;
    if (!scripts.length || !loader || typeof loader.ensureScript !== 'function') return Promise.resolve(false);
    const doc = windowRef.document;
    if (doc && typeof doc.createElement === 'function') {
      for (const href of styles) {
        if (doc.querySelector('link[data-team-style="' + href + '"]')) continue;
        const sheet = doc.createElement('link');
        sheet.rel = 'stylesheet';
        sheet.href = href;
        sheet.setAttribute('data-team-style', href);
        (doc.head || doc.documentElement).appendChild(sheet);
      }
    }
    const loads = scripts.map(([src], index) => {
      const isReady = () => scripts.slice(0, index + 1).every(([, name]) => Boolean(windowRef[name]));
      return Promise.resolve(loader.ensureScript({ src, isReady })).then((loaded) => loaded === true, () => false);
    });
    return Promise.all(loads).then((results) => results.every(Boolean) && scripts.every(([, name]) => Boolean(windowRef[name])));
  }

  // `teamData()`: whether main reported team data on disk, or a first action since found some (the shell's E50 rule).
  function createTeamTabGate({ state, windowRef, setActiveView, onChange, onBadge, focusTab, teamData = () => true }) {
    let started = false;
    let quiet = false; // the store was started quiet (E50) for this run of the gate
    let exists = false;
    let epoch = 0;
    let store = null;
    let storeLoad = null;
    let offs = [];
    let viewLoad = null;
    let chat = null;
    let chatLoad = null;
    let presence = null;
    let notifier = null;
    let waiting = 0;
    let mentions = 0;
    let directs = 0;
    let requests = 0;
    let projects = null; // the project store, held once the tab's scripts are in
    let models = null; // slice 6-7: the model store, held with the chat store
    let offers = 0;
    let approvals = 0; // row 175: project approvals waiting for this member (the notifier's count)
    let openSettings = null;

    const flagOn = () => state.features?.featureFlags?.team === true;
    const manifest = () => windowRef.rendererSettingsScriptManifest || {};
    const onTeamView = () => state.ui.activeView === 'team';

    function openNow() {
      setActiveView?.('team');
      focusTab?.('team');
      return true;
    }

    function syncView() {
      const tab = windowRef.rendererTeamTab;
      if (!started || !onTeamView()) {
        viewLoad = null;
        tab?.hideTeamTab?.();
        return;
      }
      if (!store) return; // the store first: a quiet start (E50) is decided before the view holds it
      const container = windowRef.document?.getElementById?.('teamView');
      if (!container) return;
      const show = () => windowRef.rendererTeamTab?.showTeamTab?.({ container, openSettings: (section) => openSettings?.(section), quiet: quiet && !teamData() });
      if (tab) { show(); return; }
      if (viewLoad) return;
      const run = epoch;
      const load = ensureTeamAssets({ windowRef, scripts: manifest().teamTab, styles: VIEW_STYLES }).then((ok) => {
        if (run !== epoch || viewLoad !== load) return;
        viewLoad = null;
        if (!onTeamView()) return;
        // A view that cannot load is never left blank: back to Chat, and the next open tries again.
        if (ok) show(); else setActiveView?.('chat');
      });
      viewLoad = load;
    }

    // The chat store, loaded once there is a membership, and told about the teams on every change.
    function syncChat(data) {
      if (chat) { chat.sync(data ? data.teams : []); if (models) models.sync(data ? data.teams : []); return; }
      if (chatLoad || !data || !data.teams.length) return;
      const run = epoch;
      const load = ensureTeamAssets({ windowRef, scripts: manifest().teamChat }).then((ok) => {
        if (run !== epoch || chatLoad !== load) return;
        chatLoad = null;
        if (!ok) return; // asked again on the next change
        chat = windowRef.rendererTeamChatStore.getChatStore();
        offs.push(chat.use(), chat.subscribe(changed), chat.subscribe(forget));
        models = windowRef.rendererTeamModelStore?.getModelStore?.() || null;
        if (models) offs.push(models.use(), models.subscribe((change) => { if (change && (change.type === 'state' || change.type === 'gone')) changed(); }));
        presence = windowRef.rendererTeamPresence?.createPresence?.({ windowRef, store }) || null;
        notifier = windowRef.rendererTeamNotify?.createNotifier?.({ windowRef, state, store, onWaiting: () => changed() }) || null;
        changed();
      });
      chatLoad = load;
    }

    // Slice 2c: a team left, deleted, revoked or held local (the chat store's `cleared`) takes its waiting files
    // (object URLs revoked) and its cached pictures with it.
    function forget(change) {
      if (!change || change.type !== 'cleared') return;
      windowRef.rendererTeamAttach?.forgetTeam?.(change.team_id);
      windowRef.rendererTeamFiles?.forgetTeam?.(change.team_id);
      windowRef.rendererTeamPreview?.forgetTeam?.(change.team_id);
    }

    // Runs after every store change and every read: the tab, its count and the view.
    function changed() {
      const data = store ? store.snapshot() : null;
      const next = Boolean(started && data && (data.teams.length > 0 || (data.host && data.host.deployed === true)));
      if (started) syncChat(data);
      const count = next ? store.waitingCount() : 0;
      const said = next && chat ? chat.mentionCount() : 0;
      const unread = next && chat ? chat.mentionCount({ direct: true }) : 0;
      holdProjects(data);
      const asked = next && projects ? projects.requestCount() : 0;
      const offered = next && models ? models.offerCount() : 0;
      const approving = next && notifier && typeof notifier.waitingCount === 'function' ? notifier.waitingCount() : 0;
      const flipped = next !== exists;
      const recount = count !== waiting || said !== mentions || unread !== directs || asked !== requests || offered !== offers || approving !== approvals;
      requests = asked;
      offers = offered;
      approvals = approving;
      exists = next;
      waiting = count;
      mentions = said;
      directs = unread;
      if (flipped) onChange?.();
      else if (recount) onBadge?.();
      syncView();
    }

    // The project store, once the Team tab's scripts loaded it; kept in step with the teams.
    function holdProjects(data) {
      if (!started) return;
      if (!projects && windowRef.rendererTeamProjectStore) {
        projects = windowRef.rendererTeamProjectStore.getProjectStore();
        offs.push(projects.use(), projects.subscribe((change) => { if (change && (change.type === 'requests' || change.type === 'gone')) changed(); }));
      }
      if (projects && data) projects.sync(data.teams);
    }

    // The store, then one `hostStatus` and one `status` (and the roster of a team owned and hosted
    // here, for the count). With no team data on disk (E50) the store starts quiet instead and
    // nothing is read: the Team view shows the start page from the empty answers it holds.
    function start() {
      started = true;
      const run = epoch;
      storeLoad = ensureTeamAssets({ windowRef, scripts: manifest().teamStore }).then(async (ok) => {
        if (run !== epoch) return;
        if (ok) {
          store = windowRef.rendererTeamStore.getTeamStore();
          // Before anything holds it: `startQuiet` only takes a store nothing has read or held yet (or one already quiet).
          quiet = !teamData() && store.startQuiet?.() === true;
          if (!quiet) store.wake?.(); // there is team data, so the store follows the pushes
          offs.push(store.use({}), store.subscribe(changed));
          changed(); // what the store already holds, if Settings loaded it first
          if (!quiet) await store.refreshAll();
          if (run !== epoch) return;
        } else {
          storeLoad = null; // `open()` asks again
          if (onTeamView()) setActiveView?.('chat'); // a Team view that cannot load is never left blank
        }
        changed();
      });
    }

    function stop() {
      epoch += 1;
      offs.splice(0).forEach((off) => { try { off(); } catch (_error) { /* best effort */ } });
      started = false;
      quiet = false;
      store = null;
      storeLoad = null;
      projects = null;
      requests = 0;
      models = null;
      offers = 0;
      approvals = 0;
      if (chat) chat.dispose(); // nothing a team said stays in the window while the flag is off
      chat = null;
      // Slice 2c: waiting files (object URLs, the expiry timer) and the pictures' cache go with it.
      windowRef.rendererTeamAttach?.disposeAll?.();
      windowRef.rendererTeamFiles?.disposeAll?.();
      windowRef.rendererTeamPreview?.disposeAll?.();
      chatLoad = null;
      if (presence) presence.stop();
      presence = null;
      if (notifier) notifier.stop();
      notifier = null;
      changed();
    }

    return {
      exists: () => exists,
      badge: () => (waiting + mentions + requests + offers + approvals > 0
        ? { count: waiting + mentions + requests + offers + approvals, label: badgeLabel(mentions - directs, waiting, directs, requests, offers, approvals) } : null),
      setActions: (actions) => { openSettings = typeof actions?.openSettings === 'function' ? actions.openSettings : null; },
      // Called on every chrome and layout pass, so a flag that flips later is picked up.
      sync() {
        if (!flagOn()) { if (started) stop(); return; }
        if (!started) { start(); return; }
        syncView();
      },
      // Ctrl+6 and "joining ends in the tab": true when the Team view was opened (always, with the flag on: a
      // Jenny with no team gets the start page). With `wait` (a join just answered) the store reads again.
      open({ wait = false } = {}) {
        if (!flagOn()) return false;
        if (started && !store && !storeLoad) start();
        if (wait && store && !quiet) void store.refreshAll();
        return openNow();
      },
      dispose() { if (started) stop(); windowRef.rendererTeamTab?.hideTeamTab?.(); },
    };
  }

  return { createTeamTabGate, ensureTeamAssets, badgeLabel, VIEW_STYLES };
});
