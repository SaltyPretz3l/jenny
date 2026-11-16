/* Settings › Models › model sharing, the Library's side (row 123, slice 6-7; TEAM_MODEL_SHARING_SPEC "6-7 as built").
 * Loaded with the team assets (the gate's list, after the model store); while it is not loaded the Library's ⋯ menu
 * shows only the greyed "Send to someone in your team…" (model-library-section-menu.js). The send and accept drawers
 * load on first use (the manifest's `teamShareDrawers`, through the gate's loader).
 *
 * It answers the Library's hooks: `menuItems` (the ⋯ items, greyed with their reason, worked out from what is already
 * held so the menu is built at once), `shareOf(card)` (a row's state block and flag), `before(view)` (the incoming rows
 * between "From your team" and "On this PC"), `rowHtml(key)` (one incoming row again) and `handleClick`. It follows
 * the model store: a progress push patches one bar in place (no row or list is rebuilt, so an open menu or drawer
 * stays), a state change repaints the rows by key, a tag found received repaints only that tag's rows, a received
 * model reloads the Library, and a review id set by the Team tab opens the accept drawer. Per Library load it reads
 * `modelSendable` once, `modelReceivers` once per online team (the host's name) and asks the store which GGUF tags
 * were received.
 *
 * A Library row is matched to its discovery tag (the tag model sharing knows) by the GGUF path its saved entry names,
 * against the scan's entries (`localGgufs`), once per row and Library load. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('./model-library-share-rows'), function () {
      return Promise.resolve({ send: require('./model-library-share-send'), accept: require('./model-library-share-accept') });
    });
    return;
  }
  root.modelLibraryShareSection = factory(root, root.modelLibraryShareRows, null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, rows, loadDrawers) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var W = rows.words;
  var ARRIVED_MAX = 64;
  var arrived = new Map(); // tag -> true: a model placed in this window whose arrived line has not been dismissed

  var samePath = function (a, b) {
    var left = String(a || '').replace(/\\/g, '/');
    var right = String(b || '').replace(/\\/g, '/');
    return Boolean(left && right) && (/^[a-z]:/i.test(left) ? left.toLowerCase() === right.toLowerCase() : left === right);
  };
  var joinPath = function (dir, name) { return String(dir || '').replace(/[\\/]+$/, '') + '/' + String(name || ''); };

  // The drawers, loaded once on first use; null when they could not load.
  var drawerMods = null;
  function drawers() {
    var ready = function () { return root.modelLibraryShareSend && root.modelLibraryShareAccept ? { send: root.modelLibraryShareSend, accept: root.modelLibraryShareAccept } : null; };
    if (drawerMods) return Promise.resolve(drawerMods);
    var load = loadDrawers || function () {
      var gate = root.rendererTeamTabGate;
      var list = root.rendererSettingsScriptManifest && root.rendererSettingsScriptManifest.teamShareDrawers;
      if (ready() || !gate || !list) return Promise.resolve(ready());
      return gate.ensureTeamAssets({ windowRef: root, scripts: list }).then(ready, function () { return null; });
    };
    return load().then(function (mods) { drawerMods = mods || null; return drawerMods; });
  }

  /**
   * deps: { documentRef, state, getSourceData(), card(), host(), renderRows(), queueRow(key), refresh(), setStatusMessage(text) }
   */
  function createModelLibraryShare(deps) {
    var d = deps;
    var release = null;
    var unsubscribe = null;
    var sendable = new Map(); // tag -> { sendable, reason }
    var owners = new Map(); // team id -> { member_id, display_name }
    var tagOf = new Map(); // Library row key -> discovery tag ('' for none), this Library load
    var keysOf = new Map(); // discovery tag -> the Library row keys that show it, this Library load
    var disposed = false;

    var storeModule = function () { return root.rendererTeamModelStore || null; };
    var modelStore = function () { var mod = storeModule(); return mod && typeof mod.peekModelStore === 'function' ? mod.peekModelStore() : null; };
    var teamRows = function () {
      var mod = root.rendererTeamStore;
      var teams = mod && typeof mod.getTeamStore === 'function' ? mod.getTeamStore().snapshot().teams : [];
      return storeModule() ? storeModule().eligibleTeams(teams) : [];
    };
    var call = function (method, payload) { var store = modelStore(); return store ? store.call(method, payload) : Promise.resolve({ ok: false, error: { code: 'CMP-TEAM-0011', reason: '' } }); };
    var unavailable = function () { d.setStatusMessage(W.reasonText('')); return false; };

    function attach() {
      var store = modelStore();
      if (release || !store || disposed) return store;
      release = store.use();
      unsubscribe = store.subscribe(onChange);
      return store;
    }

    // ------------------------------------------------------------------ the store's changes

    function onChange(change) {
      if (disposed || !change) return;
      if (change.type === 'progress') { patch(change); return; }
      if (change.type === 'received') {
        if (typeof change.tag === 'string') { arrived.delete(change.tag); arrived.set(change.tag, true); while (arrived.size > ARRIVED_MAX) arrived.delete(arrived.keys().next().value); }
        void d.refresh();
        return;
      }
      if (change.type === 'review') { void openReview(); return; }
      // A tag found received: its own rows (the flag and the ⋯ item), once per frame, an open menu kept.
      if (change.type === 'provenance') { (keysOf.get(change.tag) || []).forEach(function (key) { d.queueRow(key); }); return; }
      d.renderRows();
    }
    // One bar: the transfer's new bytes on the bar already drawn.
    function patch(change) {
      var store = modelStore();
      var state = store && store.team(change.team_id);
      var target = d.host();
      if (!state || !target) return;
      if (change.direction === 'send') {
        var t = state.outgoing.flatMap(function (row) { return row.transfers; }).find(function (x) { return x.transfer_id === change.transfer_id; });
        if (t) rows.patchProgress(target, 'out:' + t.transfer_id, t);
        return;
      }
      var row = state.incoming.find(function (r) { return r.transfer && (r.transfer.transfer_id === change.transfer_id || r.offer_id === change.offer_id); });
      if (row) rows.patchProgress(target, 'in:' + row.offer_id, row.transfer);
    }

    // ------------------------------------------------------------------ per Library load

    function libraryLoaded() {
      var store = attach();
      if (!store) return;
      tagOf.clear();
      keysOf.clear();
      var online = teamRows().filter(function (t) { return t.state === 'online'; });
      var tags = (d.getSourceData() && d.getSourceData().localGgufs || []).map(function (entry) { return entry && entry.tag; });
      store.askProvenance(tags);
      // `modelSendable` is answered from this PC's model files alone (main's local methods; the team only routes the
      // call), so one answer holds for every team: asked once, through the first online team.
      if (online[0]) {
        void call('modelSendable', { team_id: online[0].team_id }).then(function (answer) {
          if (!answer.ok || !Array.isArray(answer.models)) return;
          sendable.clear();
          answer.models.slice(0, 512).forEach(function (m) { if (m && typeof m.tag === 'string') sendable.set(m.tag, { sendable: m.sendable === true, reason: m.reason || null }); });
        });
      }
      online.forEach(function (team) {
        void call('modelReceivers', { team_id: team.team_id }).then(function (answer) {
          var owner = answer.ok && Array.isArray(answer.members) ? answer.members.find(function (m) { return m && m.role === 'owner'; }) : null;
          if (!owner || disposed) return;
          var known = owners.get(team.team_id);
          owners.set(team.team_id, { member_id: owner.member_id, display_name: owner.display_name });
          if (!known || known.display_name !== owner.display_name) d.renderRows(); // the host's name in the rows
        });
      });
      void openReview();
    }

    // The discovery tag of a Library row: its saved GGUF path, found among the scan's entries. Kept per row key for
    // this Library load, with the tag's rows, so a provenance answer repaints only them.
    function discoveryTag(model) {
      var key = model && model.key;
      if (key && tagOf.has(key)) return tagOf.get(key);
      var entry = model && model.libraryGguf === true ? (((d.state.localEngines || {}).openaiCompatible || {}).managed || {}).perModel : null;
      var saved = entry ? entry[model.managedKey] : null;
      var path = saved && typeof saved.modelPath === 'string' ? saved.modelPath : '';
      var scan = (d.getSourceData() && d.getSourceData().localGgufs) || [];
      var found = path ? scan.find(function (e) { return e && e.mainGguf && samePath(joinPath(e.dir, e.mainGguf), path); }) : null;
      var tag = found && typeof found.tag === 'string' ? found.tag : '';
      if (key) {
        tagOf.set(key, tag);
        if (tag) { if (!keysOf.has(tag)) keysOf.set(tag, new Set()); keysOf.get(tag).add(key); }
      }
      return tag;
    }
    function teamName(teamId) { var t = teamRows().find(function (row) { return row.team_id === teamId; }); return t ? t.team_name || '' : ''; }
    function ownerOf(teamId) { return owners.get(teamId) || null; }

    // ------------------------------------------------------------------ the ⋯ items

    // Why this member cannot send in a team, or '' when they can.
    function teamReason(team, store) {
      var state = store.team(team.team_id);
      if (state && state.killed) return W.killed();
      if (team.state !== 'online') return W.notConnected(W.name(team.team_name));
      if (state && state.sharing === 'off') {
        if (team.role === 'owner') return jt('settings.models.share.offYou', 'You have turned model sharing off for this team. Turn it on in Settings, Team.');
        var owner = ownerOf(team.team_id);
        return W.hostOff(owner ? W.name(owner.display_name) : '');
      }
      if (team.role === 'read_only') return W.readOnly();
      return '';
    }
    function menuItems(model, anchor) {
      var store = attach();
      var label = jt('settings.models.share.send', 'Send to someone in your team…');
      var teams = teamRows();
      var tag = discoveryTag(model);
      var name = model.displayName || model.tag || tag;
      var why = '';
      var open = [];
      if (store && teams.some(function (t) { var s = store.team(t.team_id); return s && s.killed; })) why = W.killed();
      else if (!store || !teams.length) why = jt('settings.models.share.noTeam', 'Join or host a team to send models.');
      else if (String(model.engineType || '').toLowerCase() === 'ollama' || model.ollamaOnly === true) why = jt('settings.models.share.ollama', 'Only GGUF files in your model folders can be sent. This one is Ollama’s copy.');
      else if (!tag) why = jt('settings.models.share.notGguf', 'Only GGUF files in your model folders can be sent.');
      else if (sendable.has(tag) && !sendable.get(tag).sendable) why = W.reasonText(sendable.get(tag).reason);
      else {
        open = teams.filter(function (t) { return !teamReason(t, store); });
        if (!open.length) why = teamReason(teams[0], store);
      }
      var items = [{ label: label, disabled: Boolean(why), description: why, action: function () {
        return drawers().then(function (mods) {
          if (!mods || disposed) return disposed ? false : unavailable();
          return mods.send.openSend({ documentRef: d.documentRef, call: call, teams: open, ownerOf: ownerOf, tag: tag, modelName: name, anchor: anchor, onRefused: d.setStatusMessage });
        });
      } }];
      var received = tag && store ? store.receivedOf(tag) : null;
      if (received) {
        items.push({ label: jt('settings.models.share.cameFrom', 'Where it came from…'), action: function () {
          return drawers().then(function (mods) {
            if (!mods || disposed) return disposed ? false : unavailable();
            return mods.accept.openAbout({ documentRef: d.documentRef, provenance: received.provenance, teamName: teamName(received.team_id), modelName: name, anchor: anchor });
          });
        } });
      }
      return items;
    }

    // ------------------------------------------------------------------ the rows

    function shareOf(model) {
      var store = attach();
      var tag = store ? discoveryTag(model) : '';
      if (!tag) return null;
      var received = store.receivedOf(tag);
      var blocks = store.teams().map(function (state) {
        return state.outgoing.filter(function (row) { return row.tag === tag && !store.isDismissed(row.request_id); })
          .map(function (row) { return rows.outgoingBlock(row, { teamId: state.teamId, teamName: teamName(state.teamId) }); }).join('');
      }).join('');
      var share = (received && arrived.has(tag) ? rows.arrivedBlock(received.provenance, tag) : '') + blocks;
      return { share: share, flag: received ? rows.receivedFlag(received.provenance, teamName(received.team_id)) : '' };
    }
    function incomingCtx(state, row) {
      return { teamId: state.teamId, teamName: teamName(state.teamId), hostName: (ownerOf(state.teamId) || {}).display_name, online: state.online !== false, path: modelStore().pathOf(row.offer_id) };
    }
    function before(view) {
      var store = attach();
      if (!store || (view && view.scope === 'get')) return [];
      var query = String(view && view.query || '').trim().toLowerCase();
      var items = [];
      store.teams().forEach(function (state) {
        state.incoming.forEach(function (row) {
          if (!rows.showsIncoming(row) || store.isDismissed(row.offer_id)) return;
          if (query && String(row.display_name || '').toLowerCase().indexOf(query) < 0) return;
          items.push(rows.incomingRow(row, incomingCtx(state, row)));
        });
      });
      return items.length ? [rows.fromTeamSeparator()].concat(items, [rows.onThisPcSeparator()]) : [];
    }
    function rowHtml(key) {
      var store = modelStore();
      var id = String(key).slice(':offer:'.length);
      var found = null;
      (store ? store.teams() : []).some(function (state) {
        var row = state.incoming.find(function (r) { return r.offer_id === id; });
        if (row) found = rows.incomingRow(row, incomingCtx(state, row)).html;
        return Boolean(row);
      });
      return found || '';
    }

    // ------------------------------------------------------------------ clicks

    // The accept drawer for an offer (or the one the Team tab asked for); answers whether it opened.
    function openReview(offerId, teamId, anchor) {
      var store = modelStore();
      if (!store) return Promise.resolve(false);
      if (!offerId) {
        var asked = store.peekReview();
        if (!asked || !d.card()) return Promise.resolve(false);
        store.takeReview();
        offerId = asked.offer_id;
        teamId = asked.team_id;
      }
      var team = teamRows().find(function (t) { return t.team_id === teamId; });
      return drawers().then(function (mods) {
        if (!mods || disposed) return disposed ? false : unavailable();
        return mods.accept.openAccept({ documentRef: d.documentRef, call: call, store: store, teamId: teamId, offerId: offerId, teamRole: team ? team.role : '', ownerOf: ownerOf,
          anchor: anchor || null, onRefused: d.setStatusMessage });
      });
    }
    var CALLS = { withdraw: 'modelWithdraw', 'send-pause': 'modelSendPause', 'send-resume': 'modelSendResume', 'send-stop': 'modelSendStop', decline: 'modelDecline',
      'receive-pause': 'modelReceivePause', 'receive-resume': 'modelReceiveResume', 'receive-cancel': 'modelReceiveCancel', 'receive-retry': 'modelReceiveRetry', 'in-dismiss': 'modelReceiveCancel' };
    function handleClick(event) {
      var button = event && event.target && event.target.closest ? event.target.closest('[data-mshare-action]') : null;
      if (!button || !d.card() || !d.card().contains(button) || button.disabled) return false;
      var action = button.getAttribute('data-mshare-action');
      var teamId = button.getAttribute('data-mshare-team') || '';
      var store = modelStore();
      if (!store) return true;
      var settle = function () { if (button.isConnected) button.disabled = false; };
      if (action === 'arrived-ok') { arrived.delete(button.getAttribute('data-mshare-tag')); d.renderRows(); return true; }
      if (action === 'out-dismiss') { store.dismiss(button.getAttribute('data-mshare-request')); return true; }
      if (action === 'review') { button.disabled = true; void openReview(button.getAttribute('data-mshare-offer'), teamId, button).then(settle, settle); return true; }
      var method = CALLS[action];
      if (!method) return true;
      var payload = { team_id: teamId };
      if (method === 'modelWithdraw') payload.request_id = button.getAttribute('data-mshare-request');
      else if (/^modelSend/.test(method)) payload.transfer_id = button.getAttribute('data-mshare-transfer');
      else payload.offer_id = button.getAttribute('data-mshare-offer');
      button.disabled = true;
      void call(method, payload).then(function (answer) {
        if (disposed) return;
        // Dismiss removes the row only once what had arrived is gone; a refusal keeps it and says why.
        if (answer.ok && action === 'in-dismiss') store.dismiss(payload.offer_id);
        else if (!answer.ok) d.setStatusMessage(W.reasonText(answer.error && answer.error.reason));
        settle();
      });
      return true;
    }

    return {
      menuItems: menuItems, shareOf: shareOf, before: before, rowHtml: rowHtml, handleClick: handleClick, libraryLoaded: libraryLoaded, discoveryTag: discoveryTag,
      dispose: function () {
        if (disposed) return;
        disposed = true;
        if (unsubscribe) unsubscribe();
        if (release) release();
        unsubscribe = null;
        release = null;
        tagOf.clear();
        keysOf.clear();
        if (drawerMods) { drawerMods.send.close(); drawerMods.accept.close(); }
      },
    };
  }

  return { createModelLibraryShare: createModelLibraryShare };
});
