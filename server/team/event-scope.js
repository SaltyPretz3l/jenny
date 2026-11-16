'use strict';

// The team host's event scope (TEAM_PROJECTS_SPEC "Events", slice 3-3). Every
// publish on a team host passes here once, inside BackendEvents. The table of
// event types is closed: a session-scoped event gets the bucket
// `session:<session_id>` and the audience of the members who may read that
// conversation now (or a capture this scope issued: the project the conversation
// was in, taken before it was deleted); an event its publisher already scoped
// passes through untouched; anything else is dropped. Nothing is ever broadcast.
// A new event type on a team host must be added here or it is dropped. The
// single-owner host builds no scope and is unchanged.

const EVENT_TYPE = /^[a-z][a-z_]{0,63}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_BUCKET = 'session:';
const PROJECT_BUCKET = 'project:';
// The event stream's bucket for an event published without one, the stream's own constant.
// The stream predicate admits an audience event under it only for presence, which its
// publisher sends live only; any other bucket outside the known prefixes is denied.
const { DEFAULT_BUCKET } = require('../event-stream');
const PRESENCE_EVENT = 'team_presence';
// Slice 3-4a: "read the project list again" (server/team/team-project-commands.js).
const PROJECT_CHANGED_EVENT = 'team_project_changed';
// Slice 4e: the team's GPU list (server/team/node-commands.js), to every active member, ephemeral.
const POOL_NODES_EVENT = 'team_pool_nodes';
// Slice 5-6: the owner deleted the team (server/team/team-deleted-notice.js), to every active member, under the
// #team channel's chat bucket so the stream predicate admits it as it does #team's messages.
const TEAM_DELETED_EVENT = 'team_deleted';
// Slice 3-12 (team-project-rules.js): a project's rules changed (everyone with a row in it, under its bucket), its
// open-request count (its admins only, the same bucket), and a request answered (the asker's conversation).
const RULES_CHANGED_EVENT = 'team_project_rules_changed';
const RULE_REQUESTS_EVENT = 'team_project_rule_requests';
const RULE_ANSWERED_EVENT = 'team_rule_request_answered';
// Row 151 T3 (boards/board-events.js): a board took a batch, and a project's board list changed; the members
// who have the project, under its bucket.
const BOARD_CHANGED_EVENT = 'team_board_changed';
const BOARD_LIST_EVENT = 'team_board_list_changed';
// Row 151 T4 (boards/board-presence-ops.js): who is viewing a board, a pointer and a note's lock, live only.
// T5 (boards/board-events.js): a board's proposals changed; a client reads them again. It names no proposal.
const BOARD_VIEWERS_EVENT = 'team_board_viewers';
const BOARD_CURSOR_EVENT = 'team_board_cursor';
const BOARD_LOCK_EVENT = 'team_board_lock';
const BOARD_PROPOSALS_EVENT = 'team_board_proposals_changed';
// A drop is logged once per (event type, reason) and counted after that; an
// unlisted type is caller-chosen text, so the table holds at most this many keys.
const MAX_DROP_KEYS = 64;

// Each carries `session_id`; their publishers pass no options (or a capture). `approval_unattended`:
// slice 3-6b (server/team/team-approvals.js).
const SESSION_SCOPED = new Set(['session_changed', 'control_changed', 'decision_changed', 'chat_stream',
  'approval_unattended', RULE_ANSWERED_EVENT]);
// Team chat (services/host/team-chat-commands.js), presence (team-presence.js) and the project
// change (team-project-commands.js) set their own audience. Slice 3-8b: `team_upload_progress`
// (project-files.js), the uploading member only, live only, under the project's bucket.
// Slice 6-3: `team_model_offer` and `team_model_transfer` (model-sharing.js), the relay's audience only, live only.
const PUBLISHER_SCOPED = new Set(['team_chat_channel', 'team_chat_message', 'team_chat_read', 'team_chat_typing',
  PRESENCE_EVENT, PROJECT_CHANGED_EVENT, POOL_NODES_EVENT, TEAM_DELETED_EVENT, 'team_upload_progress',
  'team_model_offer', 'team_model_transfer', RULES_CHANGED_EVENT, RULE_REQUESTS_EVENT, BOARD_CHANGED_EVENT,
  BOARD_LIST_EVENT, BOARD_VIEWERS_EVENT, BOARD_CURSOR_EVENT, BOARD_LOCK_EVENT, BOARD_PROPOSALS_EVENT]);

// sessionScope: authorize.js's { audience(sessionId), redeem(options, sessionId) }.
// logger: (level, event, fields). Returns scopeEvent(type, payload, options): the
// publish options, or null to drop; scopeEvent.dropCounts() reads the drop table.
function createEventScope({ sessionScope, logger } = {}) {
  if (!sessionScope || typeof sessionScope.audience !== 'function') {
    throw new TypeError('createEventScope requires a session scope.');
  }
  const drops = new Map();
  const drop = (type, reason) => {
    const eventType = typeof type === 'string' && EVENT_TYPE.test(type) ? type : 'invalid';
    let key = `${eventType}:${reason}`;
    let fields = { event_type: eventType, reason };
    if (!drops.has(key) && drops.size >= MAX_DROP_KEYS) {
      key = 'other';
      fields = { event_type: 'other', reason: 'drop_table_full' };
    }
    const seen = drops.get(key) || 0;
    drops.set(key, seen + 1);
    if (seen === 0) {
      try { logger?.('WARN', 'team.event.dropped', fields); } catch { /* best effort */ }
    }
    return null;
  };
  function scopeEvent(type, payload, options) {
    if (SESSION_SCOPED.has(type)) {
      const sessionId = payload?.session_id;
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return drop(type, 'session_id_missing');
      // Only a capture this scope issued for this conversation; any other options are a programming error.
      if (options !== undefined) {
        const captured = typeof sessionScope.redeem === 'function' ? sessionScope.redeem(options, sessionId) : null;
        return captured || drop(type, 'session_event_options');
      }
      const audience = sessionScope.audience(sessionId);
      if (!(audience instanceof Set)) return drop(type, 'audience_unavailable');
      return { audience, bucket: `${SESSION_BUCKET}${sessionId}` };
    }
    if (PUBLISHER_SCOPED.has(type)) return options?.audience instanceof Set ? options : drop(type, 'audience_missing');
    return drop(type, 'event_type_unlisted');
  }
  scopeEvent.dropCounts = () => Object.fromEntries(drops);
  return scopeEvent;
}

module.exports = {
  BOARD_CHANGED_EVENT, BOARD_CURSOR_EVENT, BOARD_LIST_EVENT, BOARD_LOCK_EVENT, BOARD_PROPOSALS_EVENT, BOARD_VIEWERS_EVENT,
  DEFAULT_BUCKET, POOL_NODES_EVENT, PRESENCE_EVENT, PROJECT_BUCKET, PROJECT_CHANGED_EVENT, SESSION_BUCKET, TEAM_DELETED_EVENT,
  RULE_ANSWERED_EVENT, RULE_REQUESTS_EVENT, RULES_CHANGED_EVENT, createEventScope,
};
