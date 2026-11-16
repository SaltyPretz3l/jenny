'use strict';

// The chat clients of every team this Jenny belongs to (slice 2a-4b), composed
// by team-service.js: one per team (at most MAX_TEAMS, the service's cap too),
// created on the renderer's first chat call or, at start, when that team's
// outbox holds entries. It is the one place a chat payload is checked (the
// closed table in ipc-methods.js) and routed to the team's client, without its
// team id. It owns removal: leaving or removing a team drops its client without
// writing anything more (its files are removed by the service), and learning
// the member was revoked empties that team's drafts and outbox on disk and
// drops its cache at once. A recovery replaces the device: entries the old
// device sent at least once may or may not have committed, so they fail as
// unconfirmed (entries never sent still go); the service writes those marks with
// the new device id in one write (client-file.js `saveDeviceRecord`) after this
// file let go of the team's client. Connection changes arrive from the
// manager's state callback, which can run inside a socket handler, so they are
// deferred before anything is done. Pushes go to `sendChat` as
// { team_id, type, ... }: `channels`, `messages`, `outbox` and `cleared`, plus
// (slice 2a-4c) `members`, `presence` and `typing`.
//
// Slice 2c renderer: each team also gets its attachments (chat-attachments.js), built on the first attachment call;
// the attachment methods and a `chatPost` carrying `attachment_ids` (sent online, never queued) go there. Whatever
// stops or drops the team's client stops them too (a Force local hold detaches the team), ending every upload and
// download in flight.

const { loadChatState, saveChatState } = require('./client-file');
const { ATTACHMENT_METHODS, createChatAttachments } = require('./chat-attachments');
const { createChatClient } = require('./chat-client');
const { createChatLocalStore } = require('./chat-local-store');
const { isChatMethod, validatePayload } = require('./ipc-methods');
const { invalidRequest, teamFailure } = require('./team-errors');

const MAX_TEAMS = 4;

function createTeamChats({
  userDataPath, sendChat = () => {}, log = () => {}, timers = { setTimeout, clearTimeout }, defer = setImmediate,
  now = Date.now, randomId, attachmentOptions = {},
}) {
  // teamId -> { manager, client (or null), revoked }
  const teams = new Map();
  let stopped = false;
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  const cleared = (teamId) => { try { sendChat({ team_id: teamId, type: 'cleared' }); } catch { /* best effort */ } };

  function clientOf(teamId) {
    const entry = teams.get(teamId);
    if (!entry || entry.revoked || stopped) return null;
    if (!entry.client) {
      const store = createChatLocalStore({ userDataPath, teamId, timers, now, log: say });
      entry.client = createChatClient({ teamId, manager: entry.manager, store, timers, defer, now, log: say,
        push: (payload) => { if (!stopped) { try { sendChat(payload); } catch { /* best effort */ } } },
        ...(randomId ? { randomId } : {}) });
    }
    return entry.client;
  }

  function attachmentsOf(teamId) {
    const entry = teams.get(teamId);
    if (!entry.attachments) entry.attachments = createChatAttachments({ ...attachmentOptions, teamId, manager: entry.manager, log: say });
    return entry.attachments;
  }

  function stopAttachments(entry) {
    entry?.attachments?.stop();
    if (entry) entry.attachments = null;
  }

  // Stops a team's client, writing its pending drafts first; the entry stays.
  function release(entry) {
    stopAttachments(entry);
    entry?.client?.dispose({ flush: true });
    if (entry) entry.client = null;
  }

  // Revoked: empty the team's drafts and outbox on disk and drop its cache, at once.
  function purge(teamId) {
    const entry = teams.get(teamId);
    if (!entry || entry.revoked) return;
    entry.revoked = true;
    stopAttachments(entry);
    if (entry.client) {
      entry.client.purge();
      entry.client = null;
    } else {
      const state = loadChatState(userDataPath, teamId);
      if (state.ok && (state.drafts.length > 0 || state.outbox.length > 0)) {
        const saved = saveChatState(userDataPath, teamId, { drafts: [], outbox: [] });
        if (!saved.ok) say('WARN', 'team.chat.purge_failed', { team_id: teamId, reason: saved.reason });
      }
    }
    say('INFO', 'team.chat.purged', { team_id: teamId });
    cleared(teamId);
  }

  return {
    /** Holds a team's manager; a held outbox starts the client, a revoked record purges. Replaces an earlier entry. */
    attach(teamId, manager, { revoked = false } = {}) {
      if (stopped) return;
      const earlier = teams.get(teamId);
      release(earlier);
      if (!earlier && teams.size >= MAX_TEAMS) return;
      teams.set(teamId, { manager, client: null, revoked: false });
      if (revoked) { defer(() => purge(teamId)); return; }
      const state = loadChatState(userDataPath, teamId);
      if (state.ok && state.outbox.some((item) => item.failed === null)) clientOf(teamId)?.activate();
    },

    /** A recovery stopped the team's manager: the client stops (drafts written) and the team is let go until attached again. */
    detach(teamId) {
      release(teams.get(teamId));
      teams.delete(teamId);
    },

    /**
     * The host names this device by a new id: the team's client stops (drafts written), `write` saves the
     * new id with the outbox marks, and an outbox still holding entries starts the client again from disk.
     * Returns what `write` returned.
     */
    rewrite(teamId, write) {
      const entry = teams.get(teamId);
      release(entry);
      const result = write();
      if (entry && teams.get(teamId) === entry && !entry.revoked && !stopped) {
        const state = loadChatState(userDataPath, teamId);
        if (state.ok && state.outbox.some((item) => item.failed === null)) clientOf(teamId)?.activate();
      }
      return result;
    },

    /** The manager's state changed (called from its state callback): acted on after a deferral. */
    connectionChanged(teamId) {
      defer(() => {
        const entry = teams.get(teamId);
        if (!entry || stopped) return;
        const state = entry.manager.snapshot().state;
        if (state === 'revoked') purge(teamId);
        else entry.client?.connectionChanged(state);
      });
    },

    /** Every `chat*` IPC call: checked against the closed table, then routed to the team's client without its team id. */
    async handle(method, payload) {
      if (!isChatMethod(method)) return invalidRequest();
      const checked = validatePayload(method, payload);
      if (!checked.ok) return invalidRequest();
      const { team_id: teamId, ...value } = checked.value;
      const entry = teams.get(teamId);
      if (!entry) return invalidRequest('team_not_found');
      if (entry.revoked) return teamFailure('CONNECTION_FAILED', 'member_revoked');
      if (stopped) return teamFailure('HOST_STOPPED', 'team_connection_stopped');
      if (ATTACHMENT_METHODS.includes(method) || (method === 'chatPost' && value.attachment_ids)) return attachmentsOf(teamId).handle(method, value);
      const client = clientOf(teamId);
      if (!client) return teamFailure('HOST_STOPPED', 'team_connection_stopped');
      return client.handle(method, value);
    },

    /** Leave or Remove team: the client stops with no further write (the service removes the team's files). */
    drop(teamId) {
      const entry = teams.get(teamId);
      if (!entry) return;
      teams.delete(teamId);
      stopAttachments(entry);
      entry.client?.dispose({ flush: false });
      cleared(teamId);
    },

    /** Test only: writes pending drafts now. */
    flush() { for (const entry of teams.values()) entry.client?.flushDrafts(); },

    /** Test only: waits until the team's client has no queued work. */
    async idle(teamId) { await teams.get(teamId)?.client?.idle(); },

    /** Test only: the team's cache, its channel list and each opened channel's messages. */
    cacheOf(teamId) { return teams.get(teamId)?.client?.snapshot() || { channels: [], open: {}, members: [] }; },

    resources() {
      let clients = 0;
      let messages = 0;
      for (const entry of teams.values()) {
        if (!entry.client) continue;
        clients += 1;
        messages += entry.client.messageCount();
      }
      return { chatClients: clients, chatMessages: messages };
    },

    async stopAll() {
      stopped = true;
      const all = [...teams.values()];
      teams.clear();
      all.forEach(stopAttachments);
      await Promise.all(all.map((entry) => entry.client?.stop({ flush: true })));
    },
  };
}

module.exports = { MAX_TEAMS, createTeamChats };
