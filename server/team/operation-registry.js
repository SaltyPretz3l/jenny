'use strict';

// The one closed table behind authorization (TEAM_MEMBERSHIP_SPEC "One
// authorization function"). Every command operation and every raw route maps to
// exactly one action, and the same row holds that action's role columns. An
// operation, route or action that is not in this file does not exist for
// authorize(): it denies. Phases 2 to 4 add rows, not mechanisms. Each row also
// names the minimum project role (slice 3-2).

const { PROJECT_ROLES } = require('./member-schema');

// Column letters: O owner, M member, R read-only, P pending member, I invite
// principal. Revoked principals have no column: they are denied everything.
const PRINCIPALS = Object.freeze(['owner', 'member', 'read_only', 'pending', 'invite', 'revoked']);
const COLUMN_LETTERS = Object.freeze({ O: 'owner', M: 'member', R: 'read_only', P: 'pending', I: 'invite' });

// Project column (TEAM_PROJECTS_SPEC "Action rows"): the minimum effective
// project role on the resource's project (member-schema's roles), or none. Read
// only on a team directory; the single-owner host ignores it.
const PROJECT_COLUMN = Object.freeze(['none', ...PROJECT_ROLES]);
const PROJECT_KINDS = new Set(['session', 'project']);

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
  // action, who, resource kind, project role, operations, raw routes
  ['runtime.read', 'OMR', 'session', 'reader', ['sessionRuntime.getSnapshot', 'sessionRuntime.getWork',
    'sessionRuntime.getResult'], []],
  // E5 revisited (slice 3-2): members run and stop turns on projects they write.
  ['runtime.control', 'OM', 'session', 'writer', ['sessionRuntime.start', 'sessionRuntime.pause',
    'sessionRuntime.resume', 'sessionRuntime.cancel', 'sessionRuntime.updatePending'], []],
  ['runtime.limits', 'O', 'session', 'none', ['sessionRuntime.updateLimits'], []],
  ['session.list', 'OMR', 'session', 'reader', ['sessions.list'], []],
  ['request.status', 'OMR', 'session', 'none', ['requests.status'], []],
  // session.view (slice 3-6b): the viewing heartbeat, authorized like a snapshot read.
  ['session.read', 'OMR', 'session', 'reader', ['sessions.snapshot', 'session.view'], [
    'GET /api/v1/sessions/:session_id/attachments/:id',
    'GET /api/v1/sessions/:session_id/messages/:id',
    'GET /api/v1/sessions/:session_id/artifacts/:id',
  ]],
  // The resource is the project the conversation is created in (params.project_id).
  ['session.create', 'OM', 'project', 'writer', ['sessions.create'], []],
  ['session.write', 'OM', 'session', 'writer', ['sessions.rename', 'sessions.preferences', 'chat.send',
    'chat.cancel'], []],
  // E5 revisited (slice 3-2): a project admin deletes a conversation.
  ['session.delete', 'OM', 'session', 'admin', ['sessions.delete'], []],
  // control.acquire is mapped by its validated params below (takeover flag).
  ['session.control', 'OM', 'session', 'writer', ['control.heartbeat', 'control.release'], []],
  ['session.takeover', 'OM', 'session', 'writer', [], []],
  // Slice 3-7 (Q6): a takeover that meets a running turn. The router asks for it then, on top of session.takeover.
  ['session.takeover_running', 'OM', 'session', 'admin', [], []],
  ['suggested.read', 'OMR', 'session', 'reader', ['suggestedChanges.list'], []],
  ['suggested.decide', 'OM', 'session', 'writer', ['suggestedChanges.decide', 'suggestedChanges.comment',
    'suggestedChanges.sendComments', 'suggestedChanges.discardPending', 'suggestedChanges.accept'], []],
  ['decision.resolve', 'OM', 'session', 'writer', ['approval.resolve', 'questions.answer', 'questions.decline'], []],
  ['project.read', 'OMR', 'project', 'reader', ['projects.list'], []],
  ['project.create', 'OM', 'project', 'none', ['projects.create', 'team.project.create'], []],
  ['project.write', 'OM', 'project', 'admin', ['projects.rename', 'team.project.rename'], []],
  // Two resources: writer on the conversation's project and on the target (params.project_id).
  ['project.assign', 'OM', 'session', 'writer', ['projects.assignSession'], []],
  // Slice 3-4a (team-project-commands.js): the members of a shared project, a leave (E29),
  // and the owner's names-only list and self-add (E23, E30), which name the team.
  ['project.members', 'OM', 'project', 'admin', ['team.project.members.add', 'team.project.members.setRole',
    'team.project.members.remove'], []],
  ['project.members.read', 'OMR', 'project', 'reader', ['team.project.members.list'], []],
  ['project.leave', 'OMR', 'project', 'reader', ['team.project.leave'], []],
  ['project.discover', 'O', 'team', 'none', ['team.project.unjoined'], []],
  ['project.join', 'O', 'team', 'none', ['team.project.join'], []],
  // Slice 3-4b (team-project-delete.js): a project admin, or the active owner on any project (OWNER_ANY).
  ['project.delete', 'OM', 'project', 'admin', ['team.project.delete'], []],
  // Slice 3-6b (E31): the project audit log, for the project's admins; the owner only as a member row.
  ['project.audit.read', 'OM', 'project', 'admin', ['team.project.audit.read'], []],
  // Slice 3-8b (project-files.js, project-file-routes.js): a project's files in and out.
  ['project.files.upload', 'OM', 'project', 'writer', ['team.project.upload.begin', 'team.project.upload.status',
    'team.project.upload.commit', 'team.project.upload.discard'],
  ['PUT /api/v1/projects/:project_id/uploads/:upload_id/files/:index/parts/:n']],
  ['project.files.download', 'OMR', 'project', 'reader', ['team.project.download.manifest'],
    ['GET /api/v1/projects/:project_id/downloads/:manifest_id/files/:index/parts/:n']],
  // Slice 3-12 (team-project-rules.js): a project's "Always allowed" rules. Anyone with a row reads them; its admins
  // change them (the owner only with an admin row: no owner-any). Asking for one rides on approval.resolve.
  ['project.rules.read', 'OMR', 'project', 'reader', ['team.project.rules.list'], []],
  ['project.rules', 'OM', 'project', 'admin', ['team.project.rules.add', 'team.project.rules.answer',
    'team.project.rules.remove'], []],
  // Row 151 slice T2 (boards/board-commands.js, boards/board-routes.js): a team project's boards. The resource is
  // the project and a board is looked up under it, so another project's board id reads as not found. Deleting,
  // restoring, reverting a batch and reading the trash need the project admin role; the owner only with a row (no
  // owner-any). T4: viewing and pointers are a reader's (D9), a note's lock a writer's. T5: reading a board's
  // proposals is a reader's, deciding one a writer's (and their device must be viewing the board).
  ['board.read', 'OMR', 'project', 'reader', ['team.board.list', 'team.board.sync', 'team.board.proposal.list',
    'team.board.history'],
    ['GET /api/v1/projects/:project_id/boards/:board_id', 'GET /api/v1/projects/:project_id/boards/:board_id/assets/:hash']],
  ['board.presence', 'OMR', 'project', 'reader', ['team.board.view', 'team.board.leave', 'team.board.cursor'], []],
  ['board.write', 'OM', 'project', 'writer', ['team.board.create', 'team.board.rename', 'team.board.apply', 'team.board.lock',
    'team.board.unlock', 'team.board.proposal.accept', 'team.board.proposal.reject'],
  ['PUT /api/v1/projects/:project_id/boards/:board_id/assets/:hash', 'POST /api/v1/projects/:project_id/boards/import']],
  ['board.admin', 'OM', 'project', 'admin', ['team.board.trash', 'team.board.delete', 'team.board.restore',
    'team.board.revert'], []],
  ['project.root', 'O', 'project', 'none', ['projects.bindRoot'], []],
  ['permission.review', 'O', 'project', 'none', ['permissionReview.getState', 'permissionReview.resolve'], []],
  ['events.subscribe', 'OMR', 'session', 'none', [], ['GET /api/v1/events']],
  // An upload names no conversation; chat.send binds it and needs writer.
  ['asset.upload', 'OM', 'session', 'none', [], ['POST /api/v1/attachments']],
  ['client.register', 'OMR', 'team', 'none', [], ['POST /api/v1/clients', 'GET /api/v1/team/bootstrap']],
  // Team actions: the routes live in team-routes.js, the commands in team-commands.js.
  ['team.hello', 'OMRPI', 'team', 'none', [], ['POST /api/v1/team/hello']],
  ['team.status', 'OMRP', 'team', 'none', [], ['POST /api/v1/team/status']],
  ['team.join.redeem', 'I', 'invite', 'none', [], ['POST /api/v1/team/join']],
  ['team.leave', 'MRP', 'team', 'none', [], ['POST /api/v1/team/leave']],
  ['team.members.list', 'OMR', 'team', 'none', ['team.members.list'], []],
  ['team.invite.manage', 'O', 'team', 'none', ['team.invite.create', 'team.invite.reveal', 'team.invite.revoke',
    'team.invite.list'], []],
  ['team.device.invite', 'OMR', 'team', 'none', ['team.device.invite'], []],
  ['team.device.list', 'OMR', 'team', 'none', ['team.device.list'], []],
  ['team.device.revoke', 'OMR', 'device', 'none', ['team.device.revoke'], []],
  ['team.member.admin', 'O', 'member', 'none', ['team.member.admit', 'team.member.setRole', 'team.member.revoke'], []],
  ['team.owner.transfer', 'O', 'member', 'none', ['team.owner.transfer'], []],
  ['team.audit.read', 'O', 'team', 'none', ['team.audit.read'], []],
  ['team.rename', 'O', 'team', 'none', ['team.rename'], []],
  // Team chat (TEAM_CHAT_SPEC "Roles"); the dispatcher is services/host/team-chat-commands.js.
  // A project channel's audience is that project's members (the channel rule in authorize.js).
  ['chat.overview', 'OMR', 'team', 'none', ['team.chat.overview'], []],
  ['chat.read', 'OMR', 'channel', 'none', ['team.chat.history', 'team.chat.sync', 'team.chat.thread',
    'team.chat.edits', 'team.chat.pins'], ['GET /api/v1/team/chat/attachments/:channel_id/:id']],
  ['chat.mark', 'OMR', 'channel', 'none', ['team.chat.mark_read', 'team.chat.set_notify', 'team.chat.follow'], []],
  // Slice 2c host: the attachment routes (server/team/chat-attachment-routes.js).
  ['chat.write', 'OM', 'channel', 'none', ['team.chat.post', 'team.chat.edit', 'team.chat.delete', 'team.chat.react',
    'team.chat.pin'], ['POST /api/v1/team/chat/uploads/:channel_id']],
  // Slice 2a-3b. Search spans channels (the dispatcher re-checks each channel it
  // reads by the same rule); typing is for roles that may post.
  ['chat.search', 'OMR', 'team', 'none', ['team.chat.search'], []],
  ['chat.typing', 'OM', 'channel', 'none', ['team.chat.typing'], []],
  // Slice 2d: opening a direct conversation. It names members, not a channel.
  ['chat.dm_open', 'OM', 'team', 'none', ['team.chat.dm_open'], []],
  ['presence.set', 'OMR', 'team', 'none', ['team.presence.set'], []],
  // Slice 4b: the team engine (node protocol spec N10). A member's own Jenny uses the
  // pool for its private conversations; the routes live in server/team/engine-routes.js.
  ['engine.use', 'OM', 'team', 'none', [], ['POST /api/v1/team/engine/v1/chat/completions',
    'GET /api/v1/team/engine/v1/models']],
  // Slice 4c host: sharing a GPU as a node (node protocol spec N6) and the node list
  // (N12). The resource is the team: no operation names a node, which is always the
  // caller's device (node-commands.js, node-routes.js). Read-only cannot share, as
  // with engine.use (an owner question in the spec).
  ['node.share', 'OM', 'team', 'none', ['team.node.register', 'team.node.claim', 'team.node.fail', 'team.node.pause',
    'team.node.unregister'], ['GET /api/v1/team/node/jobs/:job_id/request', 'POST /api/v1/team/node/jobs/:job_id/chunks']],
  ['node.list', 'OMR', 'team', 'none', ['team.node.list'], []],
  // Slice 4e: the owner's read of the GPU use log and the team model (team-commands.js).
  ['pool.usage.read', 'O', 'team', 'none', ['team.pool.usage'], []],
  ['pool.model.set', 'O', 'team', 'none', ['team.pool.model.set'], []],
  // Slice 6-3: model sharing (TEAM_MODEL_SHARING_SPEC "Host operations", E55): owner and full members send and
  // receive; the relay checks the parties (model-relay.js) and the commands and part routes live in
  // model-commands.js and model-routes.js. The resource is the team: offers and transfers are never named here.
  ['model.offer', 'OM', 'team', 'none', ['team.model.offer', 'team.model.withdraw'],
    ['PUT /api/v1/team/models/transfers/:transfer_id/files/:index/parts/:n']],
  ['model.read', 'OM', 'team', 'none', ['team.model.offers', 'team.model.offer.read'], []],
  ['model.receive', 'OM', 'team', 'none', ['team.model.accept', 'team.model.decline'],
    ['GET /api/v1/team/models/transfers/:transfer_id/files/:index/parts/:n']],
  ['model.transfer', 'OM', 'team', 'none', ['team.model.pause', 'team.model.resume', 'team.model.cancel',
    'team.model.complete'], []],
];

// What an empty resource id means on a team host for a row with a project role:
// 'filter' (a list; the handler filters each row through authorize), 'required'
// (no project named: refused with team_project_required for everyone, the owner
// included; E70), or, for every other row, 'deny' (it names nothing, so it reads
// as not existing).
const EMPTY_ID_RULES = Object.freeze({
  'session.list': 'filter', 'project.read': 'filter', 'runtime.read': 'filter', 'session.create': 'required',
});

// Rows whose project resource may not be General on a team host (owner decision E70, 2026-11-14): no conversation
// is made in General or moved into it, by anyone, the owner included (team_project_required).
const NO_GENERAL = Object.freeze(new Set(['session.create', 'project.assign']));

// The second resource an action names, by kind; checked by the same function.
const TARGETS = Object.freeze({ 'project.assign': 'project' });

// Rows the active team owner may use on an active project they hold no row in (spec row "owner any
// (Q1)", slice 3-4b). Read from the row only, never from a request.
const OWNER_ANY = Object.freeze(new Set(['project.delete']));
// Rows the active owner passes on any conversation they can already see, whatever their project role there
// (slice 3-7): General, a project with no team row, a project they joined. Visibility still decides first (E23).
const OWNER_SEEN = Object.freeze(new Set(['session.takeover_running']));
// Rows that exist only on an active project of the team (row 151 review): General, a project id with no team row and
// a project being deleted read as not found for everyone, the owner included.
const TEAM_PROJECT_ONLY = Object.freeze(new Set(['board.read', 'board.presence', 'board.write', 'board.admin']));

function buildActionTables(definitions) {
  const actions = Object.create(null);
  const operations = Object.create(null);
  const routes = Object.create(null);
  const claim = (table, key, value, what) => {
    if (Object.hasOwn(table, key)) throw new Error(`registry_duplicate_${what}`);
    table[key] = value;
  };
  for (const definition of definitions) {
    const [action, who, resource, project, ops, rawRoutes] = definition;
    // A row without the project column, or with a role on a resource that has no project, fails at load.
    if (definition.length !== 6 || !PROJECT_COLUMN.includes(project) || !Array.isArray(ops)
      || !Array.isArray(rawRoutes) || (project !== 'none' && !PROJECT_KINDS.has(resource))) {
      throw new Error('registry_row_invalid');
    }
    const row = { owner: false, member: false, read_only: false, pending: false, invite: false, resource, project,
      emptyId: EMPTY_ID_RULES[action] || 'deny', target: TARGETS[action] || null, ownerAny: OWNER_ANY.has(action),
      ownerSeen: OWNER_SEEN.has(action), noGeneral: NO_GENERAL.has(action), teamProject: TEAM_PROJECT_ONLY.has(action) };
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

const [ACTIONS, OPERATION_ACTIONS, ROUTE_ACTIONS] = buildActionTables(DEFINITIONS);

// The generic project operations a team host refuses for every caller (slice 3-4a): a
// shared project is made, renamed and given a folder through team.project.* instead.
const TEAM_HOST_REFUSED_OPERATIONS = Object.freeze(['projects.create', 'projects.rename', 'projects.bindRoot']);

// Actions no operation or route names that the router asks for itself (slice 3-7).
const ROUTER_ACTIONS = Object.freeze(['session.takeover_running']);

// Actions with no operation or route yet (session.takeover is reached through
// control.acquire): later slices add operations to them, not mechanisms.
const RESERVED_ACTIONS = Object.freeze(DEFINITIONS
  .filter(([action, , , , ops, rawRoutes]) => !ops.length && !rawRoutes.length && action !== 'session.takeover'
    && !ROUTER_ACTIONS.includes(action))
  .map(([action]) => action));

function actionForOperation(operation, params) {
  if (typeof operation !== 'string' || !Object.hasOwn(OPERATION_ACTIONS, operation)) return null;
  const entry = OPERATION_ACTIONS[operation];
  const action = typeof entry === 'function' ? entry(params) : entry;
  return Object.hasOwn(ACTIONS, action) ? action : null;
}

function actionForRoute(route) {
  return typeof route === 'string' && Object.hasOwn(ROUTE_ACTIONS, route) ? ROUTE_ACTIONS[route] : null;
}

function commandResource(kind, command) {
  const id = RESOURCE_IDS[kind](command);
  return { kind, id: typeof id === 'string' ? id : '' };
}

// The action and resources a validated command asks for, or null when unmapped:
// `resource` is the row's own; `resources` adds the action's target, if any.
function resolveCommand(command) {
  const action = actionForOperation(command?.operation, command?.params);
  if (!action) return null;
  const row = ACTIONS[action];
  const resource = commandResource(row.resource, command);
  return { action, resource, resources: row.target ? [resource, commandResource(row.target, command)] : [resource] };
}

module.exports = {
  ACTIONS, OPERATION_ACTIONS, PRINCIPALS, RESERVED_ACTIONS, ROUTE_ACTIONS, ROUTER_ACTIONS, TEAM_HOST_REFUSED_OPERATIONS,
  actionForOperation, actionForRoute, buildActionTables, resolveCommand,
};
