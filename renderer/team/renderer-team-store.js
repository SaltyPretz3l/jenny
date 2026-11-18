/* The shared team store (row 123, slice 1g-2): one instance per window behind
 * Settings > Team, the Team tab and the tab's gate. It owns the host state, the
 * joined teams, each team's lists, the one bridge call (with its timeout), the
 * single-flight list refresh and the `team.onState` / `team.onHostState`
 * pushes. It holds no page state: busy keys, confirms, shown codes and drafts
 * stay with their page.
 *
 * A consumer holds the store with `use(wants)` and gives it back with the
 * function that returns. While anyone holds it the pushes are subscribed; with
 * nobody left it keeps what it read and goes quiet. What a consumer wants
 * decides what is read: `rosters: 'hosted'` or `'all'`, `devices`, and
 * `ownerLists` (invites and the activity log), so the tab never fetches the
 * last two.
 *
 * Rules the readers rely on:
 * - A push is newer than any answer that was asked for before it; such an
 *   answer is dropped.
 * - An answer of the wrong shape is a failed read.
 * - A team's lists go when the team leaves or the right to see them does
 *   (`revoked`, `pending`).
 * - The host sends no roster event yet, so rosters are re-read on one timer:
 *   every 20 s the team the Team view shows, every 60 s the team hosted here
 *   that this person owns (the tab's count), never while the document is
 *   hidden; three failures in a row double the interval, up to 5 minutes.
 * - Slice 4e: the state push and the status answer also carry `sharing` (this
 *   PC's GPU, or null) and `pools` (each team's GPU list). A push that changes
 *   only those notifies without re-reading any list. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The two limits of a team; the views read them from here (through their view model).
  const MAX_TEAMS = 4;
  const MAX_MEMBERS = 8;
  const AUDIT_PAGE = 100;
  const AUDIT_PAGES_PER_REFRESH = 3;
  const AUDIT_KEPT = 100;
  const POLL_ACTIVE_MS = 20_000;
  const POLL_IDLE_MS = 60_000;
  const POLL_MAX_MS = 300_000;
  const POLL_FAILS_BEFORE_BACKOFF = 3;
  const PUSH_SETTLE_MS = 250;
  // After a push-driven list read, the next one waits this long: main pushes on every bridge, node and GPU step.
  const PUSH_GAP_MS = 5000;
  const CALL_TIMEOUT_MS = 10_000;
  // Starting or stopping a server, joining and leaving wait on a child process or the network for
  // longer than a read does (a stop alone may take 10 s), so they get a longer bound.
  const SLOW_CALL_TIMEOUT_MS = 60_000;
  const SLOW_CALLS = new Set(['hostDeploy', 'hostStop', 'hostRecover', 'join', 'leave']);
  // Slice 5-6 (finding 3): a save that restarts the server (up to its 120 s start limit), a delete or a new team waits
  // longer still; an export, a restore and their pickers wait on the owner's dialog and on copying a whole team.
  // A delete removes a whole team's files, so it takes the long bound too (review item 14).
  const LONG_CALLS = Object.freeze({ hostInternet: 180_000, hostDelete: 1_800_000, hostStartNew: 180_000, hostOldDelete: 1_800_000,
    hostExport: 1_800_000, hostRestorePick: 1_800_000, hostRestore: 1_800_000,
    // Slice 2c renderer: a file of up to 4 MiB each way (the client's part timeout is 60 s), and the file and save dialogs.
    chatUpload: 90_000, chatAttachmentImage: 90_000, chatAttachmentText: 90_000, chatAttachmentCopy: 90_000, chatAttachPick: 1_800_000, chatAttachmentSave: 1_800_000,
    // Slice 3-10: an upload or a download first waits on the native folder dialog in main.
    uploadFolder: 1_800_000, downloadProject: 1_800_000,
    // Row 175 (D13): a project file read (up to a 4 MiB picture) and a list page; main's own limits are 45 s and 60 s.
    projectFileRead: 60_000, projectFiles: 75_000 });
  const NO_ANSWER = Object.freeze({ code: 'CMP-TEAM-0001', reason: '' });
  // Pinned to hostStatus on an empty profile by tests/team-off.test.js.
  const EMPTY_HOST = Object.freeze({ state: 'stopped', team_id: null, team_name: null, deployed: false, reason: null, since: 0, reach: null, direct_port: null,
    internet: null, internet_draft: null, autostart: false, key: null, old_teams: Object.freeze([]), operation: null, owner: null });
  // needs_repair: a saved team whose file does not load (nothing is read for it). force_local (E64): Force local holds it.
  const LOCKED_OUT = new Set(['revoked', 'pending', 'needs_repair', 'force_local']);

  // `createTeamStore` is exported for tests; the app uses `getTeamStore()`.
  function createTeamStore({ windowRef = null } = {}) {
    const win = () => windowRef || (typeof window !== 'undefined' ? window : null);
    const data = { host: null, teams: [], lists: {}, hostRead: { seq: 0, error: null }, sharing: null, pools: {}, forceLocal: false };
    const listeners = new Set();
    const consumers = new Set();
    // Bumped by every push and seed; an answer asked for before the bump is older than what is held.
    const pushes = { host: 0, teams: 0, gpu: 0 };
    let unsubscribers = [];
    let listsRun = null;
    let listsAgain = false;
    let allRun = null;
    let allAgain = false;
    let shownTeamId = '';
    let timer = null;
    let timerMs = 0;
    let pollFails = 0;
    let ownedWaitMs = 0;
    let pushTimer = null;
    let pushGap = null;
    let pushOwed = false;
    let visibilityDoc = null;
    let epoch = 0;
    // Quiet (E50): main says there is no team data, so nothing is subscribed until wake().
    let quiet = false;

    function bridge() { const w = win(); return (w && w.jennyShell && w.jennyShell.team) || null; }
    function notify() { for (const fn of [...listeners]) { try { fn(); } catch (_error) { /* a consumer's render must not stop the others */ } } }
    function wants(key, value) { for (const c of consumers) { if (value === undefined ? c[key] : c[key] === value) return true; } return false; }

    // The one bridge call. A rejected call, a missing method, an answer without `ok` and no answer
    // within the timeout all read as the same failed answer.
    function call(method, payload) {
      const api = bridge();
      const failed = { ok: false, error: NO_ANSWER };
      if (!api || typeof api[method] !== 'function') return Promise.resolve(failed);
      let sent;
      try { sent = payload === undefined ? api[method]() : api[method](payload); } catch (_error) { return Promise.resolve(failed); }
      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(failed), LONG_CALLS[method] || (SLOW_CALLS.has(method) ? SLOW_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS));
        Promise.resolve(sent)
          .then((answer) => (answer && typeof answer === 'object' && typeof answer.ok === 'boolean' ? answer : failed), () => failed)
          .then((answer) => { clearTimeout(timeout); resolve(answer); });
      });
    }

    // ------------------------------------------------------------ derivation

    function teamById(id) { return id ? data.teams.find((team) => team.team_id === id) || null : null; }
    // A needs_repair row (a saved file that does not load) is never the hosted team: Settings lists it under joined teams.
    function hostedTeam() {
      const team = teamById(data.host && data.host.team_id);
      return team && team.state !== 'needs_repair' ? team : null;
    }
    // The server for this team runs on this PC right now.
    function isHostedHere(team) {
      return Boolean(team && data.host && data.host.state === 'running' && data.host.team_id === team.team_id);
    }
    // The one team whose joiners this person lets in from here: hosted here, owned, connected.
    function ownedHostedTeam() {
      const team = hostedTeam();
      return team && isHostedHere(team) && team.role === 'owner' && team.state === 'online' ? team : null;
    }
    function waitingOf(teamId) {
      const team = ownedHostedTeam();
      if (!team || team.team_id !== teamId) return [];
      return ((data.lists[teamId] && data.lists[teamId].roster) || []).filter((member) => member.state === 'pending');
    }
    function waitingCount() { const team = ownedHostedTeam(); return team ? waitingOf(team.team_id).length : 0; }
    // The team the Team view shows, while it is connected.
    function shownTeam() { const team = teamById(shownTeamId); return team && team.state === 'online' ? team : null; }

    // ----------------------------------------------------------------- state

    // Read before setHost: whether this host state differs from the held one where a list depends on it.
    function hostMoved(host) {
      const was = data.host;
      return !was || !host || was.state !== host.state || was.team_id !== host.team_id;
    }
    function setHost(host) {
      if (!host || typeof host !== 'object') return false;
      data.host = host;
      return true;
    }

    // Keeps well-formed teams only, and drops the lists of every team that is gone or locked out.
    function setTeams(teams) {
      if (!Array.isArray(teams)) return false;
      data.teams = teams.filter((team) => team && typeof team === 'object' && typeof team.team_id === 'string' && team.team_id).slice(0, MAX_TEAMS);
      const readable = new Set(data.teams.filter((team) => !LOCKED_OUT.has(team.state)).map((team) => team.team_id));
      for (const id of Object.keys(data.lists)) { if (!readable.has(id)) delete data.lists[id]; }
      return true;
    }

    // This PC's sharing state and each team's GPU list (main rebuilt both from checked answers). True when changed.
    function setGpu(payload) {
      if (!payload || typeof payload !== 'object') return false;
      const sharing = payload.sharing && typeof payload.sharing === 'object' && typeof payload.sharing.team_id === 'string' ? payload.sharing : null;
      const pools = payload.pools && typeof payload.pools === 'object' && !Array.isArray(payload.pools) ? payload.pools : {};
      if (JSON.stringify([sharing, pools]) === JSON.stringify([data.sharing, data.pools])) return false;
      data.sharing = sharing;
      data.pools = pools;
      return true;
    }
    // E64: Force local is on in main (the teams snapshot or the host state says so): Team is off on this PC.
    function forceLocal() { return data.forceLocal === true || Boolean(data.host && data.host.force_local === true); }
    function onStatePush(payload) {
      if (payload && typeof payload === 'object') data.forceLocal = payload.force_local === true;
      const gpu = setGpu(payload);
      if (gpu) pushes.gpu += 1;
      const teams = payload && payload.teams;
      // A push that changed only the GPUs notifies; any other push keeps the teams path (and its list re-read).
      const same = Array.isArray(teams) && JSON.stringify(teams) === JSON.stringify(data.teams);
      if (gpu && same) { notify(); return; }
      onPush('teams', setTeams(teams), !same);
    }

    // ----------------------------------------------------------------- reads

    // Reads forward from the cursor; an entry at or below the cursor found after an await is already listed.
    async function readAudit(teamId, lists) {
      for (let page = 0; page < AUDIT_PAGES_PER_REFRESH; page += 1) {
        const answer = await call('auditRead', { team_id: teamId, cursor: lists.auditCursor || 0, limit: AUDIT_PAGE });
        if (!answer.ok || !Array.isArray(answer.entries)) return;
        const floor = lists.auditCursor || 0;
        const fresh = answer.entries.filter((entry) => Number(entry.seq) > floor);
        if (fresh.length) {
          lists.audit = (lists.audit || []).concat(fresh).slice(-AUDIT_KEPT);
          lists.auditCursor = Number(fresh[fresh.length - 1].seq);
        }
        if (answer.next_cursor === null || answer.next_cursor === undefined || !fresh.length) return;
      }
    }

    function readRoster(team, lists) {
      return call('members', { team_id: team.team_id }).then((answer) => {
        const good = answer.ok && Array.isArray(answer.members);
        if (good) lists.roster = answer.members;
        lists.rosterRead = { seq: ((lists.rosterRead && lists.rosterRead.seq) || 0) + 1, error: good ? null : (answer.ok ? NO_ANSWER : answer.error) };
      });
    }

    function readTeam(team, rosterOnly) {
      const id = team.team_id;
      const lists = data.lists[id] || (data.lists[id] = {});
      const hosted = isHostedHere(team);
      const owned = hosted && team.role === 'owner';
      const reads = [];
      if (owned || id === shownTeamId || wants('rosters', 'all') || (hosted && wants('rosters', 'hosted'))) reads.push(readRoster(team, lists));
      if (rosterOnly) return Promise.all(reads);
      if (wants('devices')) reads.push(call('deviceList', { team_id: id }).then((a) => { if (a.ok && Array.isArray(a.devices)) lists.devices = a.devices; }));
      if (owned && wants('ownerLists')) {
        reads.push(call('inviteList', { team_id: id }).then((a) => { if (a.ok && Array.isArray(a.invites)) lists.invites = a.invites; }));
        reads.push(readAudit(id, lists));
      }
      return Promise.all(reads);
    }

    // Lists are read for online teams only; `only` narrows one run to those teams' rosters (the timer).
    function readLists(only) {
      const teams = data.teams.filter((team) => team.state === 'online' && (!only || only.includes(team.team_id)));
      return Promise.all(teams.map((team) => readTeam(team, Boolean(only))));
    }

    // One list refresh at a time: a request during a run asks for exactly one more full run after it.
    function refreshLists({ only = null } = {}) {
      if (listsRun) { if (!only) listsAgain = true; return listsRun; }
      const started = epoch;
      listsRun = (async () => {
        let scope = only;
        do {
          listsAgain = false;
          await readLists(scope);
          scope = null;
          if (started !== epoch) return;
          syncTimer();
          notify();
        } while (listsAgain);
      })().finally(() => { listsRun = null; });
      return listsRun;
    }

    // Host status and joined teams, then the lists. Coalesced like the lists: one run, at most one more.
    function refreshAll() {
      if (allRun) { allAgain = true; return allRun; }
      const started = epoch;
      allRun = (async () => {
        do {
          allAgain = false;
          const asked = { host: pushes.host, teams: pushes.teams, gpu: pushes.gpu };
          const [hostAnswer, statusAnswer] = await Promise.all([call('hostStatus'), call('status')]);
          if (started !== epoch) return;
          const hostGood = hostAnswer.ok && hostAnswer.host && typeof hostAnswer.host === 'object';
          // A push or seed that landed while the read was out is newer than its answer.
          if (hostGood && asked.host === pushes.host) setHost(hostAnswer.host);
          data.hostRead = { seq: data.hostRead.seq + 1, error: hostGood ? null : (hostAnswer.ok ? NO_ANSWER : hostAnswer.error) };
          if (statusAnswer.ok && asked.teams === pushes.teams) { setTeams(statusAnswer.teams); data.forceLocal = statusAnswer.force_local === true; }
          if (statusAnswer.ok && asked.gpu === pushes.gpu) setGpu(statusAnswer);
          syncTimer();
          notify();
          await refreshLists();
        } while (allAgain && started === epoch);
      })().finally(() => { allRun = null; });
      return allRun;
    }

    // ------------------------------------------------------------- the timer

    function documentRef() { const w = win(); return (w && w.document) || null; }
    function wantedTimerMs() {
      const doc = documentRef();
      if (!consumers.size || (doc && doc.hidden === true)) return 0;
      const base = shownTeam() ? POLL_ACTIVE_MS : (ownedHostedTeam() ? POLL_IDLE_MS : 0);
      const doubled = pollFails >= POLL_FAILS_BEFORE_BACKOFF ? 2 ** (pollFails - POLL_FAILS_BEFORE_BACKOFF + 1) : 1;
      return Math.min(base * doubled, POLL_MAX_MS);
    }
    // The shown team every tick; the owned hosted team too, once 60 s have gone by when it is not the one shown.
    function pollTargets(elapsedMs) {
      const shown = shownTeam();
      const owned = ownedHostedTeam();
      const ids = shown ? [shown.team_id] : [];
      if (owned && !(shown && shown.team_id === owned.team_id)) {
        ownedWaitMs += elapsedMs;
        if (!shown || ownedWaitMs >= POLL_IDLE_MS) { ids.push(owned.team_id); ownedWaitMs = 0; }
      }
      return ids;
    }
    async function poll(elapsedMs) {
      const ids = pollTargets(elapsedMs);
      if (!ids.length) return;
      const started = epoch;
      await refreshLists({ only: ids });
      if (started !== epoch) return;
      const failed = ids.some((id) => { const read = data.lists[id] && data.lists[id].rosterRead; return !read || Boolean(read.error); });
      pollFails = failed ? pollFails + 1 : 0;
      syncTimer();
    }
    function syncTimer() {
      const next = wantedTimerMs();
      if (next === timerMs) return;
      if (timer !== null) clearInterval(timer);
      timer = null;
      timerMs = next;
      if (!next) { pollFails = 0; ownedWaitMs = 0; return; }
      timer = setInterval(() => { void poll(next); }, next);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    function onVisibility() {
      const before = timerMs;
      syncTimer();
      if (!before && timerMs) void poll(POLL_IDLE_MS);
    }

    // ------------------------------------------------------------- consumers

    // Several pushes in a row (a reconnect sends a burst) start one list read, after the last of them. A push that
    // moved nothing here (`moved` false: the same teams, the same host state) inside the gap that follows a read is
    // owed one read with the others, when the gap ends: a list read for each such push used up the host's limit and
    // refused the next change. A push that moved a team or the host is read for after the settle time, gap or not.
    function listsAfterPush(moved) {
      if (pushGap !== null && !moved) { pushOwed = true; return; }
      if (pushTimer !== null) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        pushTimer = null;
        if (pushGap !== null) clearTimeout(pushGap);
        pushOwed = false;
        pushGap = setTimeout(() => { pushGap = null; if (pushOwed) listsAfterPush(false); }, PUSH_GAP_MS);
        void refreshLists();
      }, PUSH_SETTLE_MS);
    }
    function dropPushTimer() {
      if (pushTimer !== null) clearTimeout(pushTimer);
      if (pushGap !== null) clearTimeout(pushGap);
      pushTimer = null;
      pushGap = null;
      pushOwed = false;
    }
    function onPush(kind, changed, moved) {
      if (!changed) return;
      pushes[kind] += 1;
      syncTimer();
      notify();
      listsAfterPush(moved);
    }

    function subscribePushes() {
      const api = bridge();
      const keep = (off) => { if (typeof off === 'function') unsubscribers.push(off); };
      if (api && typeof api.onState === 'function') keep(api.onState(onStatePush));
      if (api && typeof api.onHostState === 'function') keep(api.onHostState((host) => { const moved = hostMoved(host); onPush('host', setHost(host), moved); }));
      visibilityDoc = documentRef();
      if (visibilityDoc && typeof visibilityDoc.addEventListener === 'function') visibilityDoc.addEventListener('visibilitychange', onVisibility);
    }

    function unsubscribePushes() {
      unsubscribers.splice(0).forEach((off) => { try { off(); } catch (_error) { /* best effort */ } });
      if (visibilityDoc && typeof visibilityDoc.removeEventListener === 'function') visibilityDoc.removeEventListener('visibilitychange', onVisibility);
      visibilityDoc = null;
      dropPushTimer();
    }

    // Invites and the activity log are kept only while a consumer asks for them.
    function dropOwnerLists() {
      for (const lists of Object.values(data.lists)) {
        delete lists.invites;
        delete lists.audit;
        delete lists.auditCursor;
      }
    }

    function use(wanted = {}) {
      const consumer = { rosters: wanted.rosters || '', devices: wanted.devices === true, ownerLists: wanted.ownerLists === true };
      consumers.add(consumer);
      if (consumers.size === 1 && !quiet) subscribePushes();
      syncTimer();
      let held = true;
      return function release() {
        if (!held) return;
        held = false;
        consumers.delete(consumer);
        if (consumer.ownerLists && !wants('ownerLists')) dropOwnerLists();
        if (!consumers.size && !quiet) unsubscribePushes();
        syncTimer();
      };
    }

    function subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    }

    // What a caller already knows (an action's answer), without a round trip. It counts as a push.
    function seed({ host, teams } = {}) {
      if (setHost(host)) pushes.host += 1;
      if (setTeams(teams)) pushes.teams += 1;
      syncTimer();
      notify();
    }

    // No team data on disk (E50): hold the empty answers and subscribe nothing. Only before anything is held.
    function startQuiet() {
      if (quiet) return true;
      if (data.host || consumers.size || unsubscribers.length) return false;
      quiet = true;
      seed({ host: { ...EMPTY_HOST }, teams: [] });
      return true;
    }
    // A Join, Deploy or Recover was answered: follow the pushes from here on. True when it was quiet.
    function wake() {
      if (!quiet) return false;
      quiet = false;
      if (consumers.size) subscribePushes();
      syncTimer();
      return true;
    }

    // The Team view says which team it shows ('' while it is hidden); that team's roster is kept fresh.
    function setShownTeam(teamId) {
      const next = typeof teamId === 'string' ? teamId : '';
      if (next === shownTeamId) return;
      shownTeamId = next;
      pollFails = 0;
      syncTimer();
    }

    // For tests: the app's one store lives as long as its window.
    function dispose() {
      epoch += 1;
      quiet = false;
      consumers.clear();
      listeners.clear();
      unsubscribePushes();
      shownTeamId = '';
      syncTimer();
      data.host = null;
      data.teams = [];
      data.lists = {};
      data.hostRead = { seq: 0, error: null };
      data.sharing = null;
      data.pools = {};
      data.forceLocal = false;
    }

    return {
      // The live state object, for reading only: the store is the one writer, and it changes in place.
      snapshot: () => data,
      subscribe, use, call, refreshAll, refreshLists, seed, setShownTeam, dispose, startQuiet, wake,
      hostedTeam, isHostedHere, ownedHostedTeam, waitingOf, waitingCount, forceLocal,
      _timerMs: () => timerMs, // for tests
    };
  }

  let shared = null;
  function getTeamStore() {
    if (!shared) shared = createTeamStore();
    return shared;
  }

  // With no team data on disk (E50) the first answered Join, Deploy or Recover ends the quiet state, ok or not and
  // whether the page that asked still shows: main loaded its team service for it and may have written a team or a
  // host config before answering (or after a timeout). The store follows the pushes and reads once; the shell loads
  // the gate when the answer was ok or that read finds a team, a deployed host or one that is not stopped. Settings >
  // Team and the Team tab's start page both end a quiet start through here.
  function afterFirstAct(store, answer) {
    if (!store.wake()) return;
    const note = () => globalThis.rendererTopNavShellController?.noteTeamData?.();
    if (answer && answer.ok === true) note();
    void store.refreshAll().then(() => {
      const { teams, host } = store.snapshot();
      if (teams.length || (host && (host.deployed === true || host.state !== 'stopped'))) note();
    });
  }

  return { createTeamStore, getTeamStore, afterFirstAct, MAX_TEAMS, MAX_MEMBERS, NO_ANSWER, EMPTY_HOST };
});
