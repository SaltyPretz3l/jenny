(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererProposalCardStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Renderer-side cache of the session proposal projections (row 59 checkpoints 3 and 5a).
  // The chat cards render from these records, never from the tool result: the result
  // only names the proposal. Nothing here persists (no localStorage): the records live
  // in the main process; this holds the last read, the in-flight gesture ids, the
  // Run preconditions the user ticked, the transient notices, and for session proposals
  // the Options popover state, its capabilities read and the suggestion groups
  // (members paged from sessionProposals.list, cached per session + group_id).

  const SCHEMA_VERSION = 1;
  const RETRY_UNAVAILABLE_MS = 8000;
  const REFETCH_COALESCE_MS = 120;
  const GROUP_PAGE_LIMIT = 100;
  const GROUP_MAX_PAGES = 5;

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function entryKey(sessionId, proposalId) {
    return `${sessionId}\u0000${proposalId}`;
  }

  function defaultBridge() {
    const shell = globalThis.window ? globalThis.window.jennyShell : globalThis.jennyShell;
    return (shell && shell.sessionProposals) || null;
  }

  function fallbackUuid() {
    const hex = () => Math.floor(Math.random() * 16).toString(16);
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => (c === 'x' ? hex() : ((Math.random() * 4 | 8)).toString(16)));
  }

  function newUuid() {
    const cryptoRef = globalThis.crypto;
    return cryptoRef && typeof cryptoRef.randomUUID === 'function' ? cryptoRef.randomUUID() : fallbackUuid();
  }

  const EMPTY_READ = Object.freeze({
    status: 'unavailable', proposal: null, notice: null, busy: false, acks: [], group: null, optionsOpen: false,
    capabilities: Object.freeze({ status: 'idle', value: null }),
  });

  function groupKey(sessionId, groupId) {
    return `${sessionId}\u0000group\u0000${groupId}`;
  }

  function validProjection(proposal, proposalId) {
    return isObject(proposal)
      && proposal.proposal_id === proposalId
      && Number.isSafeInteger(proposal.revision) && proposal.revision >= 1
      && (proposal.kind === 'git' || proposal.kind === 'command' || proposal.kind === 'session')
      && isObject(proposal.display) && isObject(proposal.actions)
      && (proposal.kind !== 'session' || (typeof proposal.group_id === 'string' || proposal.group_id == null));
  }

  // Oldest first by (created_at, proposal_id): the order sessionProposals.list pages in.
  function compareMembers(a, b) {
    if (a.created_at === b.created_at) return a.proposal_id < b.proposal_id ? -1 : (a.proposal_id > b.proposal_id ? 1 : 0);
    return a.created_at < b.created_at ? -1 : 1;
  }

  function createProposalCardStore(options) {
    const o = options || {};
    const getBridge = typeof o.getBridge === 'function' ? o.getBridge : defaultBridge;
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    const setTimer = typeof o.setTimeout === 'function' ? o.setTimeout : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof o.clearTimeout === 'function' ? o.clearTimeout : (handle) => clearTimeout(handle);
    const makeUuid = typeof o.randomUUID === 'function' ? o.randomUUID : newUuid;
    const log = typeof o.appendClientLog === 'function' ? o.appendClientLog : () => {};
    const entries = new Map(); // key -> {sessionId, proposalId, status, proposal, fetchedAt, fetching, refetch, notice}
    const versions = new Map(); // sessionId -> change counter (the render comparand)
    const acks = new Map(); // key -> Set<int>
    const busy = new Set();
    const gestures = new Map(); // key -> {id, signature}
    const listeners = new Set();
    const refetchTimers = new Map(); // sessionId -> timer
    const groups = new Map(); // groupKey -> {sessionId, groupId, status, members: Map, fetching, refetch, notice}
    const groupGestures = new Map(); // groupKey -> {id, signature}
    const groupBusy = new Set();
    const optionsOpen = new Set(); // entry keys whose Options popover is open
    let unsubscribe = null;
    let subscribedBridge = null;
    let disposed = false;

    function touch(sessionId, proposalId) {
      versions.set(sessionId, (versions.get(sessionId) || 0) + 1);
      for (const listener of [...listeners]) {
        try { listener({ sessionId, proposalId }); } catch (_error) { /* a view bug never breaks the store */ }
      }
    }

    function ensureEntry(sessionId, proposalId) {
      const key = entryKey(sessionId, proposalId);
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          sessionId, proposalId, status: 'checking', proposal: null, fetchedAt: 0, fetching: false, refetch: false, notice: null, fallback: null,
          capabilities: { status: 'idle', value: null },
        };
        entries.set(key, entry);
      }
      return entry;
    }

    async function fetchEntry(entry) {
      const bridge = getBridge();
      if (disposed || !bridge || typeof bridge.get !== 'function') return;
      if (entry.fetching) { entry.refetch = true; return; }
      entry.fetching = true;
      let response = null;
      try {
        response = await bridge.get({ schema_version: SCHEMA_VERSION, session_id: entry.sessionId, proposal_id: entry.proposalId });
      } catch (error) {
        log('WARN', 'proposal_card.get_failed', { message: String(error && error.message || error || '').slice(0, 120) });
      }
      entry.fetching = false;
      if (disposed) return;
      entry.fetchedAt = now();
      let changed = false;
      if (isObject(response) && response.ok === true && validProjection(response.proposal, entry.proposalId)) {
        changed = applyProjection(entry, response.proposal);
      } else if (isObject(response) && response.ok === false && response.reason === 'not_found') {
        changed = entry.status !== 'not_found';
        entry.status = 'not_found';
        entry.proposal = null;
      } else if (!entry.proposal) {
        changed = entry.status !== 'unavailable';
        entry.status = 'unavailable';
      }
      if (changed) touch(entry.sessionId, entry.proposalId);
      if (entry.refetch) {
        entry.refetch = false;
        void fetchEntry(entry);
      }
    }

    // Revision guard: an older read never overwrites a newer one.
    function applyProjection(entry, proposal) {
      const current = entry.proposal;
      if (current && proposal.revision < current.revision) return false;
      const same = current && current.revision === proposal.revision && entry.status === 'ready';
      entry.proposal = proposal;
      entry.status = 'ready';
      mergeGroupMember(entry.sessionId, proposal);
      return !same;
    }

    // A member that arrives by get/decide joins an already-cached group (rows stream in one tool call at a time).
    function mergeGroupMember(sessionId, proposal) {
      if (proposal.kind !== 'session' || typeof proposal.group_id !== 'string') return;
      const group = groups.get(groupKey(sessionId, proposal.group_id));
      if (!group) return;
      const held = group.members.get(proposal.proposal_id);
      if (!held || held.revision <= proposal.revision) group.members.set(proposal.proposal_id, proposal);
    }

    // ---- suggestion groups (kind session, group_id) ----------------------------------
    function ensureGroup(sessionId, groupId) {
      const key = groupKey(sessionId, groupId);
      let group = groups.get(key);
      if (!group) {
        group = { sessionId, groupId, status: 'checking', members: new Map(), fetching: false, refetch: false, notice: null };
        groups.set(key, group);
      }
      return group;
    }

    async function listGroupItems(bridge, group) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const items = [];
        let cursor = null;
        let restart = false;
        for (let page = 0; page < GROUP_MAX_PAGES; page += 1) {
          const request = { schema_version: SCHEMA_VERSION, session_id: group.sessionId, limit: GROUP_PAGE_LIMIT };
          if (cursor) request.cursor = cursor;
          const response = await bridge.list(request);
          if (!isObject(response) || response.ok !== true || !Array.isArray(response.items)) {
            restart = isObject(response) && response.reason === 'stale_cursor';
            if (!restart) return null;
            break;
          }
          for (const item of response.items) {
            if (isObject(item) && item.kind === 'session' && item.group_id === group.groupId
              && validProjection(item, item.proposal_id)) items.push(item);
          }
          cursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : null;
          if (!cursor) return items;
        }
        if (!restart) return items;
      }
      return null;
    }

    function memberSignature(group) {
      return group.status === 'ready'
        ? [...group.members.values()].map((member) => `${member.proposal_id}:${member.revision}`).sort().join('|') : null;
    }

    async function fetchGroup(group) {
      const bridge = getBridge();
      if (disposed || !bridge || typeof bridge.list !== 'function') return;
      if (group.fetching) { group.refetch = true; return; }
      group.fetching = true;
      let items = null;
      try {
        items = await listGroupItems(bridge, group);
      } catch (error) {
        log('WARN', 'proposal_card.group_list_failed', { message: String(error && error.message || error || '').slice(0, 120) });
      }
      group.fetching = false;
      if (disposed) return;
      const before = memberSignature(group);
      if (items) {
        const next = new Map();
        for (const item of items) {
          const held = group.members.get(item.proposal_id);
          next.set(item.proposal_id, held && held.revision > item.revision ? held : item);
        }
        group.members = next;
        group.status = 'ready';
        for (const item of items) {
          const entry = entries.get(entryKey(group.sessionId, item.proposal_id));
          if (entry && applyProjection(entry, item)) touch(entry.sessionId, entry.proposalId);
        }
      } else if (group.status !== 'ready') {
        group.status = 'unavailable';
      }
      if (before !== memberSignature(group)) {
        const first = [...group.members.values()].sort(compareMembers)[0];
        touch(group.sessionId, first ? first.proposal_id : null);
      }
      if (group.refetch) {
        group.refetch = false;
        void fetchGroup(group);
      }
    }

    /** The header's read model: members oldest first. Starts a read on first sight. */
    function lookupGroup(sessionId, groupId) {
      const sid = String(sessionId || '');
      const gid = String(groupId || '');
      if (!sid || !gid) return null;
      const key = groupKey(sid, gid);
      const bridge = getBridge();
      let group = groups.get(key);
      if (!group && bridge && typeof bridge.list === 'function') {
        ensureSubscribed(bridge);
        group = ensureGroup(sid, gid);
        group.fetching = true; // claim the slot so a second render does not double-fetch
        Promise.resolve().then(() => { group.fetching = false; return fetchGroup(group); });
      }
      if (!group) return null;
      return {
        groupId: gid,
        status: group.status,
        members: [...group.members.values()].sort(compareMembers),
        busy: groupBusy.has(key),
        notice: group.notice,
      };
    }

    function refreshGroup(sessionId, groupId) {
      return fetchGroup(ensureGroup(String(sessionId || ''), String(groupId || '')));
    }

    function setGroupNotice(sessionId, groupId, notice) {
      const group = ensureGroup(sessionId, groupId);
      const next = notice || null;
      if (JSON.stringify(group.notice) === JSON.stringify(next)) return;
      group.notice = next;
      touch(sessionId, null);
    }

    function setGroupBusy(sessionId, groupId, value) {
      const key = groupKey(sessionId, groupId);
      if (value === groupBusy.has(key)) return;
      if (value) groupBusy.add(key); else groupBusy.delete(key);
      touch(sessionId, null);
    }

    function isGroupBusy(sessionId, groupId) {
      return groupBusy.has(groupKey(sessionId, groupId));
    }

    /** One decision_id per Start all intent: the same snapshot of (proposal_id, revision) reuses it until settled. */
    function groupGestureId(sessionId, groupId, signature) {
      const key = groupKey(sessionId, groupId);
      const sig = String(signature || '');
      const current = groupGestures.get(key);
      if (current && current.signature === sig) return current.id;
      const next = { id: makeUuid(), signature: sig };
      groupGestures.set(key, next);
      return next.id;
    }

    function settleGroupGesture(sessionId, groupId) {
      groupGestures.delete(groupKey(sessionId, groupId));
    }

    // ---- Options popover: open state and the capabilities read ----------------------
    async function loadCapabilities(sessionId, proposalId) {
      const entry = ensureEntry(String(sessionId || ''), String(proposalId || ''));
      const bridge = getBridge();
      if (disposed || !bridge || typeof bridge.getCapabilities !== 'function') return;
      if (entry.capabilities.status === 'loading') return;
      // A refresh of a read we already hold stays 'ready': the open popover keeps its controls (and focus).
      const held = entry.capabilities.status === 'ready' ? entry.capabilities.value : null;
      if (!held) {
        entry.capabilities = { status: 'loading', value: entry.capabilities.value };
        touch(entry.sessionId, entry.proposalId);
      }
      let response = null;
      try {
        response = await bridge.getCapabilities({ schema_version: SCHEMA_VERSION, session_id: entry.sessionId, proposal_id: entry.proposalId });
      } catch (error) {
        log('WARN', 'proposal_card.capabilities_failed', { message: String(error && error.message || error || '').slice(0, 120) });
      }
      if (disposed) return;
      const ok = isObject(response) && response.ok === true && Array.isArray(response.destinations) && Array.isArray(response.models)
        && Array.isArray(response.reasoning_efforts) && Array.isArray(response.run_modes);
      if (held && (!ok || JSON.stringify(held) === JSON.stringify(response))) return;
      entry.capabilities = ok ? { status: 'ready', value: response } : { status: 'error', value: entry.capabilities.value };
      touch(entry.sessionId, entry.proposalId);
    }

    function setOptionsOpen(sessionId, proposalId, open) {
      const key = entryKey(sessionId, proposalId);
      if (Boolean(open) === optionsOpen.has(key)) return;
      if (open) optionsOpen.add(key); else optionsOpen.delete(key);
      touch(sessionId, proposalId);
      if (open) void loadCapabilities(sessionId, proposalId);
    }

    function isOptionsOpen(sessionId, proposalId) {
      return optionsOpen.has(entryKey(sessionId, proposalId));
    }

    function handleChangedEvent(event) {
      if (disposed || !isObject(event) || typeof event.session_id !== 'string') return;
      const sessionId = event.session_id;
      if (refetchTimers.has(sessionId)) return;
      refetchTimers.set(sessionId, setTimer(() => {
        refetchTimers.delete(sessionId);
        for (const entry of entries.values()) {
          if (entry.sessionId === sessionId && entry.status !== 'not_found') void fetchEntry(entry);
        }
        for (const group of groups.values()) {
          if (group.sessionId === sessionId) void fetchGroup(group);
        }
      }, REFETCH_COALESCE_MS));
    }

    function ensureSubscribed(bridge) {
      if (subscribedBridge === bridge || !bridge || typeof bridge.onChanged !== 'function') return;
      if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (_error) { /* best effort */ } }
      subscribedBridge = bridge;
      unsubscribe = bridge.onChanged(handleChangedEvent) || null;
    }

    /** The card's read model. Starts a read on first sight; the answer arrives through subscribe. */
    function lookup(sessionId, proposalId, fallback) {
      const sid = String(sessionId || '');
      const pid = String(proposalId || '');
      const bridge = getBridge();
      const bridgeOk = Boolean(bridge && typeof bridge.get === 'function');
      if (!sid || !pid) return { ...EMPTY_READ, fallback: null };
      const key = entryKey(sid, pid);
      let entry = entries.get(key);
      if (!entry && !bridgeOk) {
        return {
          ...EMPTY_READ, busy: busy.has(key), acks: [...(acks.get(key) || [])].sort((a, b) => a - b), fallback: fallback || null,
        };
      }
      if (bridgeOk) {
        ensureSubscribed(bridge);
        if (!entry) entry = ensureEntry(sid, pid);
        if (!entry.fallback && fallback) entry.fallback = fallback;
        const stale = entry.status === 'unavailable' && now() - entry.fetchedAt >= RETRY_UNAVAILABLE_MS;
        if (!entry.fetching && ((entry.fetchedAt === 0 && entry.status === 'checking') || stale)) {
          entry.fetching = true; // claim the slot so a second render does not double-fetch
          Promise.resolve().then(() => { entry.fetching = false; return fetchEntry(entry); });
        }
      }
      const proposal = entry ? entry.proposal : null;
      const session = Boolean(proposal) && proposal.kind === 'session';
      if (session && bridgeOk && proposal.decision_state === 'pending' && proposal.options_editable === true
        && !proposal.group_id && entry.capabilities.status === 'idle' && !entry.capabilitiesRequested) {
        // A single offer shows its option summary from the start; group rows load capabilities when Options opens.
        entry.capabilitiesRequested = true;
        Promise.resolve().then(() => loadCapabilities(sid, pid));
      }
      return {
        status: entry ? entry.status : 'unavailable',
        proposal,
        notice: entry ? entry.notice : null,
        busy: busy.has(key),
        acks: [...(acks.get(key) || [])].sort((a, b) => a - b),
        fallback: entry ? entry.fallback : null,
        group: session && proposal.group_id ? lookupGroup(sid, proposal.group_id) : null,
        optionsOpen: optionsOpen.has(key),
        capabilities: entry ? entry.capabilities : EMPTY_READ.capabilities,
      };
    }

    /** Applies a projection returned by a decide/cancel/retry call (same revision guard). */
    function apply(sessionId, proposal) {
      const sid = String(sessionId || '');
      if (!isObject(proposal) || !validProjection(proposal, proposal.proposal_id)) return false;
      const entry = ensureEntry(sid, proposal.proposal_id);
      entry.notice = null;
      entry.fetchedAt = now();
      const changed = applyProjection(entry, proposal);
      if (changed) touch(sid, proposal.proposal_id);
      return changed;
    }

    /** Re-reads one record (after a stale_revision answer). */
    function refresh(sessionId, proposalId) {
      const entry = ensureEntry(String(sessionId || ''), String(proposalId || ''));
      return fetchEntry(entry);
    }

    function setNotice(sessionId, proposalId, notice) {
      const entry = ensureEntry(sessionId, proposalId);
      const next = notice || null;
      if (JSON.stringify(entry.notice) === JSON.stringify(next)) return;
      entry.notice = next;
      touch(sessionId, proposalId);
    }

    function setBusy(sessionId, proposalId, value) {
      const key = entryKey(sessionId, proposalId);
      if (value === busy.has(key)) return;
      if (value) busy.add(key); else busy.delete(key);
      touch(sessionId, proposalId);
    }

    function isBusy(sessionId, proposalId) {
      return busy.has(entryKey(sessionId, proposalId));
    }

    /** One decision_id per gesture: the same id comes back for the same intent until settle(). */
    function gestureId(sessionId, proposalId, signature) {
      const key = entryKey(sessionId, proposalId);
      const sig = String(signature || '');
      const current = gestures.get(key);
      if (current && current.signature === sig) return current.id;
      const next = { id: makeUuid(), signature: sig };
      gestures.set(key, next);
      return next.id;
    }

    function settleGesture(sessionId, proposalId) {
      gestures.delete(entryKey(sessionId, proposalId));
    }

    function setAck(sessionId, proposalId, index, checked) {
      if (!Number.isInteger(index) || index < 0) return;
      const key = entryKey(sessionId, proposalId);
      const set = acks.get(key) || new Set();
      const had = set.has(index);
      if (checked) set.add(index); else set.delete(index);
      acks.set(key, set);
      if (had !== Boolean(checked)) touch(sessionId, proposalId);
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }

    /** '' when this session has no cards, else a token that moves whenever any card's read model does. */
    function revisionKey(sessionId) {
      const version = versions.get(String(sessionId || ''));
      return version ? `proposal-cards:${version}` : '';
    }

    function dispose() {
      disposed = true;
      for (const timer of refetchTimers.values()) clearTimer(timer);
      refetchTimers.clear();
      if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (_error) { /* best effort */ } }
      unsubscribe = null;
      listeners.clear();
      entries.clear();
      groups.clear();
      groupGestures.clear();
      groupBusy.clear();
      optionsOpen.clear();
    }

    return {
      lookup, apply, refresh, setNotice, setBusy, isBusy, gestureId, settleGesture, setAck,
      lookupGroup, refreshGroup, setGroupNotice, setGroupBusy, isGroupBusy, groupGestureId, settleGroupGesture,
      setOptionsOpen, isOptionsOpen, loadCapabilities,
      subscribe, revisionKey, dispose,
    };
  }

  let defaultStore = null;
  function getDefaultStore() {
    if (!defaultStore) defaultStore = createProposalCardStore();
    return defaultStore;
  }

  return {
    createProposalCardStore,
    getDefaultStore,
    // The render comparand (renderer-render-pipeline-message-renderer.js): the card state outside the messages.
    proposalCardStateKey: (sessionId) => (defaultStore ? defaultStore.revisionKey(sessionId) : ''),
  };
});
