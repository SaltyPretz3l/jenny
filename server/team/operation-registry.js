'use strict';

// The one closed table behind authorization (TEAM_MEMBERSHIP_SPEC "One
// authorization function"). Every command operation and every raw route maps to
// exactly one action, and the same row holds that action's role columns. An
// operation, route or action that is not in this file does not exist for
// authorize(): it denies. Phases 2 to 4 add rows, not mechanisms.

// Column letters: O owner, M member, R read-only, P pending member, I invite
// principal. Revoked principals have no column: they are denied everything.
const PRINCIPALS = Object.freeze(['owner', 'member', 'read_only', 'pending', 'invite', 'revoked']);
const COLUMN_LETTERS = Object.freeze({ O: 'owner', M: 'member', R: 'read_only', P: 'pending', I: 'invite' });

// Where a command names its resource: the envelope session, or one params field.
const RESOURCE_IDS = Object.freeze({
  session: (command) => command.session_id,
  project: (command) => command.params?.project_id,
  device: (command) => command.params?.device_id,
  member: (command) => command.params?.member_id,
  invite: (command) => command.params?.invite_id,
  channel: (command) => command.params?.channel_id,
  team: () => '',
});

const DEFINITIONS = [
  // action, who, resource kind, operations, raw routes
  ['runtime.read', 'OMR', 'session', ['sessionRuntime.getSnapshot', 'sessionRuntime.getWork', 'sessionRuntime.getResult'], []],
  ['runtime.control', 'O', 'session', ['sessionRuntime.start', 'sessionRuntime.pause', 'sessionRuntime.resume',
    'sessionRuntime.cancel', 'sessionRuntime.updatePending'], []],
  ['runtime.limits', 'O', 'session', ['sessionRuntime.updateLimits'], []],
  ['session.list', 'OMR', 'session', ['sessions.list'], []],
  ['request.status', 'OMR', 'session', ['requests.status'], []],
  ['session.read', 'OMR', 'session', ['sessions.snapshot'], [
    'GET /api/v1/sessions/:session_id/attachments/:id',
    'GET /api/v1/sessions/:session_id/messages/:id',
    'GET /api/v1/sessions/:session_id/artifacts/:id',
  ]],
  ['session.create', 'OM', 'session', ['sessions.create'], []],
  ['session.write', 'OM', 'session', ['sessions.rename', 'sessions.preferences', 'chat.send', 'chat.cancel'], []],
  ['session.delete', 'O', 'session', ['sessions.delete'], []],
  // control.acquire is mapped by its validated params below (takeover flag).
  ['session.control', 'OM', 'session', ['control.heartbeat', 'control.release'], []],
  ['session.takeover', 'OM', 'session', [], []],
  ['suggested.read', 'OMR', 'session', ['suggestedChanges.list'], []],
  ['suggested.decide', 'OM', 'session', ['suggestedChanges.decide', 'suggestedChanges.comment',
    'suggestedChanges.sendComments', 'suggestedChanges.discardPending', 'suggestedChanges.accept'], []],
  ['decision.resolve', 'OM', 'session', ['approval.resolve', 'questions.answer', 'questions.decline'], []],
  ['project.read', 'OMR', 'project', ['projects.list'], []],
  ['project.write', 'OM', 'project', ['projects.create', 'projects.rename', 'projects.assignSession'], []],
  ['project.root', 'O', 'project', ['projects.bindRoot'], []],
  ['permission.review', 'O', 'project', ['permissionReview.getState', 'permissionReview.resolve'], []],
  ['events.subscribe', 'OMR', 'session', [], ['GET /api/v1/events']],
  ['asset.upload', 'OM', 'session', [], ['POST /api/v1/attachments']],
  ['client.register', 'OMR', 'team', [], ['POST /api/v1/clients', 'GET /api/v1/team/bootstrap']],
  // Team actions: the routes live in team-routes.js, the commands in team-commands.js.
  ['team.hello', 'OMRPI', 'team', [], ['POST /api/v1/team/hello']],
  ['team.status', 'OMRP', 'team', [], ['POST /api/v1/team/status']],
  ['team.join.redeem', 'I', 'invite', [], ['POST /api/v1/team/join']],
  ['team.leave', 'MRP', 'team', [], ['POST /api/v1/team/leave']],
  ['team.members.list', 'OMR', 'team', ['team.members.list'], []],
  ['team.invite.manage', 'O', 'team', ['team.invite.create', 'team.invite.reveal', 'team.invite.revoke',
    'team.invite.list'], []],
  ['team.device.invite', 'OMR', 'team', ['team.device.invite'], []],
  ['team.device.list', 'OMR', 'team', ['team.device.list'], []],
  ['team.device.revoke', 'OMR', 'device', ['team.device.revoke'], []],
  ['team.member.admin', 'O', 'member', ['team.member.admit', 'team.member.setRole', 'team.member.revoke'], []],
  ['team.owner.transfer', 'O', 'member', ['team.owner.transfer'], []],
  ['team.audit.read', 'O', 'team', ['team.audit.read'], []],
  ['team.rename', 'O', 'team', ['team.rename'], []],
  // Team chat (TEAM_CHAT_SPEC "Roles"); the dispatcher is services/host/team-chat-commands.js.
  ['chat.overview', 'OMR', 'team', ['team.chat.overview'], []],
  ['chat.read', 'OMR', 'channel', ['team.chat.history', 'team.chat.sync', 'team.chat.thread'], []],
  ['chat.mark', 'OMR', 'channel', ['team.chat.mark_read', 'team.chat.set_notify', 'team.chat.follow'], []],
  ['chat.write', 'OM', 'channel', ['team.chat.post', 'team.chat.edit', 'team.chat.delete'], []],
  // Slice 2a-3b. Search spans channels (the dispatcher re-checks each channel it
  // reads by the same rule); typing is for roles that may post.
  ['chat.search', 'OMR', 'team', ['team.chat.search'], []],
  ['chat.typing', 'OM', 'channel', ['team.chat.typing'], []],
  ['presence.set', 'OMR', 'team', ['team.presence.set'], []],
];

function buildTables() {
  const actions = Object.create(null);
  const operations = Object.create(null);
  const routes = Object.create(null);
  const claim = (table, key, value, what) => {
    if (Object.hasOwn(table, key)) throw new Error(`registry_duplicate_${what}`);
    table[key] = value;
  };
  for (const [action, who, resource, ops, rawRoutes] of DEFINITIONS) {
    const row = { owner: false, member: false, read_only: false, pending: false, invite: false, resource };
    for (const letter of who) row[COLUMN_LETTERS[letter]] = true;
    claim(actions, action, Object.freeze(row), 'action');
    for (const operation of ops) claim(operations, operation, action, 'operation');
    for (const route of rawRoutes) claim(routes, route, action, 'route');
  }
  // The only entry that is a pure function of validated params.
  claim(operations, 'control.acquire',
    (params) => (params?.takeover === true ? 'session.takeover' : 'session.control'), 'operation');
  return [Object.freeze(actions), Object.freeze(operations), Object.freeze(routes)];
}

const [ACTIONS, OPERATION_ACTIONS, ROUTE_ACTIONS] = buildTables();

function actionForOperation(operation, params) {
  if (typeof operation !== 'string' || !Object.hasOwn(OPERATION_ACTIONS, operation)) return null;
  const entry = OPERATION_ACTIONS[operation];
  const action = typeof entry === 'function' ? entry(params) : entry;
  return Object.hasOwn(ACTIONS, action) ? action : null;
}

function actionForRoute(route) {
  return typeof route === 'string' && Object.hasOwn(ROUTE_ACTIONS, route) ? ROUTE_ACTIONS[route] : null;
}

// The action and resource a validated command asks for, or null when unmapped.
function resolveCommand(command) {
  const action = actionForOperation(command?.operation, command?.params);
  if (!action) return null;
  const kind = ACTIONS[action].resource;
  const id = RESOURCE_IDS[kind](command);
  return { action, resource: { kind, id: typeof id === 'string' ? id : '' } };
}

module.exports = {
  ACTIONS, OPERATION_ACTIONS, ROUTE_ACTIONS, PRINCIPALS,
  actionForOperation, actionForRoute, resolveCommand,
};
