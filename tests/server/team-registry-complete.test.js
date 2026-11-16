'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { PARAM_SCHEMAS } = require('../../server/api-contract');
const registry = require('../../server/team/operation-registry');
const { createAuthorizer } = require('../../server/team/authorize');
const { createIdentityCheck } = require('../../server/command-router-identity');
const { createTeamDirectoryFixture, PRINCIPALS } = require('./helpers/team-directory-fixture');

const { ACTIONS, OPERATION_ACTIONS, ROUTE_ACTIONS } = registry;
const COLUMNS = ['owner', 'member', 'read_only', 'pending', 'invite'];

function operationActions(operation) {
  const entry = OPERATION_ACTIONS[operation];
  if (typeof entry === 'function') {
    return [entry({ takeover: true }), entry({ takeover: false }), entry({})];
  }
  return [entry];
}

test('PARAM_SCHEMAS is exported and enumerates the closed operation vocabulary', () => {
  assert.ok(PARAM_SCHEMAS && typeof PARAM_SCHEMAS === 'object');
  assert.equal(Object.isFrozen(PARAM_SCHEMAS), true);
  assert.equal(Object.keys(PARAM_SCHEMAS).length, 126); // row 151 T9: team.board.history; 3-4b: team.project.delete; 4e: team.pool.usage, team.pool.model.set; 3-6b: session.view, team.project.audit.read; 3-8b: five file operations; 3-12: four rules operations; 6-3: ten model operations; row 151 T2: seven board operations; T3: team.board.sync; T4: five presence operations; T5: three proposal operations, team.board.revert
});

test('slice 3-12 rows: the rules list on project.rules.read, the three changes on project.rules, no owner-any', () => {
  assert.equal(registry.actionForOperation('team.project.rules.list', {}), 'project.rules.read');
  for (const operation of ['team.project.rules.add', 'team.project.rules.answer', 'team.project.rules.remove']) {
    assert.equal(registry.actionForOperation(operation, {}), 'project.rules', operation);
  }
  assert.deepEqual(COLUMNS.filter((column) => ACTIONS['project.rules'][column]), ['owner', 'member']);
  assert.deepEqual(COLUMNS.filter((column) => ACTIONS['project.rules.read'][column]), ['owner', 'member', 'read_only']);
  assert.deepEqual([ACTIONS['project.rules'].project, ACTIONS['project.rules.read'].project], ['admin', 'reader']);
  assert.equal(ACTIONS['project.rules'].ownerAny, false);
  const add = registry.resolveCommand({ operation: 'team.project.rules.add', params: { project_id: 'project_a' } });
  assert.deepEqual(add.resources, [{ kind: 'project', id: 'project_a' }]);
});

test('row 151 T2 rows: every board operation and the snapshot route on a board row of the project, no owner-any', () => {
  const expected = {
    'team.board.list': 'board.read', 'team.board.sync': 'board.read', 'team.board.proposal.list': 'board.read',
    'team.board.history': 'board.read',
    'team.board.view': 'board.presence', 'team.board.leave': 'board.presence', 'team.board.cursor': 'board.presence',
    'team.board.create': 'board.write', 'team.board.rename': 'board.write', 'team.board.apply': 'board.write',
    'team.board.lock': 'board.write', 'team.board.unlock': 'board.write',
    'team.board.proposal.accept': 'board.write', 'team.board.proposal.reject': 'board.write',
    'team.board.trash': 'board.admin', 'team.board.delete': 'board.admin', 'team.board.restore': 'board.admin',
    'team.board.revert': 'board.admin',
  };
  for (const [operation, action] of Object.entries(expected)) {
    assert.equal(registry.actionForOperation(operation, {}), action, operation);
    assert.deepEqual(registry.resolveCommand({ operation, params: { project_id: 'project_a', board_id: 'board_b' } }).resources,
      [{ kind: 'project', id: 'project_a' }], operation);
  }
  // No board operation exists that is not listed here (an unmapped one would be refused).
  assert.deepEqual(Object.keys(PARAM_SCHEMAS).filter((operation) => operation.startsWith('team.board.')).sort(),
    Object.keys(expected).sort());
  assert.equal(registry.actionForRoute('GET /api/v1/projects/:project_id/boards/:board_id'), 'board.read');
  assert.equal(registry.actionForRoute('GET /api/v1/projects/:project_id/boards/:board_id/assets/:hash'), 'board.read');
  assert.equal(registry.actionForRoute('PUT /api/v1/projects/:project_id/boards/:board_id/assets/:hash'), 'board.write');
  assert.equal(registry.actionForRoute('POST /api/v1/projects/:project_id/boards/import'), 'board.write');
  const rows = { 'board.read': [['owner', 'member', 'read_only'], 'reader'],
    'board.presence': [['owner', 'member', 'read_only'], 'reader'], 'board.write': [['owner', 'member'], 'writer'],
    'board.admin': [['owner', 'member'], 'admin'] };
  for (const [action, [who, role]] of Object.entries(rows)) {
    assert.deepEqual(COLUMNS.filter((column) => ACTIONS[action][column]), who, action);
    assert.deepEqual([ACTIONS[action].resource, ACTIONS[action].project, ACTIONS[action].ownerAny], ['project', role, false], action);
  }
  // The board rows, and only they, exist in an active project of the team alone (the row 151 review).
  assert.deepEqual(Object.keys(ACTIONS).filter((action) => ACTIONS[action].teamProject === true).sort(), Object.keys(rows).sort());
  assert.equal(registry.actionForOperation('team.board.planted', {}), null);
});

test('slice 6-3 rows: every model operation and both part routes on a model row, owner and member only, on the team', () => {
  const expected = {
    'team.model.offer': 'model.offer', 'team.model.withdraw': 'model.offer',
    'team.model.offers': 'model.read', 'team.model.offer.read': 'model.read',
    'team.model.accept': 'model.receive', 'team.model.decline': 'model.receive',
    'team.model.pause': 'model.transfer', 'team.model.resume': 'model.transfer', 'team.model.cancel': 'model.transfer',
    'team.model.complete': 'model.transfer',
  };
  for (const [operation, action] of Object.entries(expected)) {
    assert.equal(registry.actionForOperation(operation, {}), action, operation);
    assert.ok(Object.hasOwn(PARAM_SCHEMAS, operation), `${operation} has a schema`);
  }
  // No model operation exists that is not listed here (an unmapped one would be refused).
  assert.deepEqual(Object.keys(PARAM_SCHEMAS).filter((operation) => operation.startsWith('team.model.')).sort(),
    Object.keys(expected).sort());
  assert.equal(registry.actionForRoute('PUT /api/v1/team/models/transfers/:transfer_id/files/:index/parts/:n'), 'model.offer');
  assert.equal(registry.actionForRoute('GET /api/v1/team/models/transfers/:transfer_id/files/:index/parts/:n'),
    'model.receive');
  for (const action of ['model.offer', 'model.read', 'model.receive', 'model.transfer']) {
    assert.deepEqual(COLUMNS.filter((column) => ACTIONS[action][column]), ['owner', 'member'], action);
    assert.deepEqual([ACTIONS[action].resource, ACTIONS[action].project], ['team', 'none'], action);
  }
  assert.equal(registry.actionForOperation('team.model.planted', {}), null);
});

test('slice 2a-3b rows: search and presence for every active role, typing only for roles that post', () => {
  const row = (action) => COLUMNS.map((column) => (ACTIONS[action][column] ? column : null)).filter(Boolean);
  assert.equal(registry.actionForOperation('team.chat.search', {}), 'chat.search');
  assert.equal(registry.actionForOperation('team.chat.typing', {}), 'chat.typing');
  assert.equal(registry.actionForOperation('team.presence.set', {}), 'presence.set');
  assert.deepEqual(row('chat.search'), ['owner', 'member', 'read_only']);
  assert.deepEqual(row('presence.set'), ['owner', 'member', 'read_only']);
  assert.deepEqual(row('chat.typing'), ['owner', 'member']);
  assert.deepEqual([ACTIONS['chat.search'].resource, ACTIONS['chat.typing'].resource, ACTIONS['presence.set'].resource],
    ['team', 'channel', 'team']);
});

test('slice 2b-1 rows: react and pin ride the writer row, the edit history rides the reader row', () => {
  const row = (action) => COLUMNS.map((column) => (ACTIONS[action][column] ? column : null)).filter(Boolean);
  assert.equal(registry.actionForOperation('team.chat.react', {}), 'chat.write');
  assert.equal(registry.actionForOperation('team.chat.pin', {}), 'chat.write');
  assert.equal(registry.actionForOperation('team.chat.edits', {}), 'chat.read');
  assert.equal(registry.actionForOperation('team.chat.pins', {}), 'chat.read');
  assert.deepEqual(row('chat.write'), ['owner', 'member']);
  assert.deepEqual(row('chat.read'), ['owner', 'member', 'read_only']);
  assert.equal(ACTIONS['chat.write'].resource, 'channel');
  assert.equal(ACTIONS['chat.read'].resource, 'channel');
});

test('every PARAM_SCHEMAS operation maps to exactly one declared action', () => {
  for (const operation of Object.keys(PARAM_SCHEMAS)) {
    assert.equal(Object.hasOwn(OPERATION_ACTIONS, operation), true, `${operation} has no registry entry`);
    for (const action of operationActions(operation)) {
      assert.equal(typeof action, 'string', `${operation} resolves to an action name`);
      assert.equal(Object.hasOwn(ACTIONS, action), true, `${operation} -> ${action} is not a declared action`);
    }
  }
});

test('slice 4b row: engine.use for owner and member, read-only, on the team, for the two engine routes', () => {
  const row = ACTIONS['engine.use'];
  assert.ok(row, 'engine.use is declared');
  assert.deepEqual(COLUMNS.filter((column) => row[column]), ['owner', 'member']);
  assert.equal(row.resource, 'team');
  assert.equal(row.project, 'none');
  assert.equal(registry.actionForRoute('POST /api/v1/team/engine/v1/chat/completions'), 'engine.use');
  assert.equal(registry.actionForRoute('GET /api/v1/team/engine/v1/models'), 'engine.use');
  assert.equal(registry.RESERVED_ACTIONS.includes('engine.use'), false);
});

test('slice 3-8b rows: the upload operations and part route on project.files.upload, the manifest and read on download', () => {
  for (const operation of ['team.project.upload.begin', 'team.project.upload.status', 'team.project.upload.commit',
    'team.project.upload.discard']) assert.equal(registry.actionForOperation(operation, {}), 'project.files.upload', operation);
  assert.equal(registry.actionForOperation('team.project.download.manifest', {}), 'project.files.download');
  assert.equal(registry.actionForRoute('PUT /api/v1/projects/:project_id/uploads/:upload_id/files/:index/parts/:n'),
    'project.files.upload');
  assert.equal(registry.actionForRoute('GET /api/v1/projects/:project_id/downloads/:manifest_id/files/:index/parts/:n'),
    'project.files.download');
  const begin = registry.resolveCommand({ operation: 'team.project.upload.begin', params: { project_id: 'project_a' } });
  assert.deepEqual(begin.resources, [{ kind: 'project', id: 'project_a' }]);
});

test('slice 4c host rows: node.share for owner and member, node.list for every active role, both on the team', () => {
  const columns = (action) => COLUMNS.filter((column) => ACTIONS[action][column]);
  for (const operation of ['team.node.register', 'team.node.claim', 'team.node.fail', 'team.node.pause',
    'team.node.unregister']) assert.equal(registry.actionForOperation(operation, {}), 'node.share', operation);
  assert.equal(registry.actionForOperation('team.node.list', {}), 'node.list');
  assert.deepEqual(columns('node.share'), ['owner', 'member']);
  assert.deepEqual(columns('node.list'), ['owner', 'member', 'read_only']);
  assert.deepEqual([ACTIONS['node.share'].resource, ACTIONS['node.list'].resource], ['team', 'team']);
  assert.equal(registry.actionForRoute('GET /api/v1/team/node/jobs/:job_id/request'), 'node.share');
  assert.equal(registry.actionForRoute('POST /api/v1/team/node/jobs/:job_id/chunks'), 'node.share');
});

test('slice 2c host routes: an upload is chat.write and a download chat.read, both on the channel', () => {
  assert.equal(registry.actionForRoute('POST /api/v1/team/chat/uploads/:channel_id'), 'chat.write');
  assert.equal(registry.actionForRoute('GET /api/v1/team/chat/attachments/:channel_id/:id'), 'chat.read');
  assert.deepEqual([ACTIONS['chat.write'].resource, ACTIONS['chat.read'].resource], ['channel', 'channel']);
});

test('only control.acquire maps by params; every other entry is a plain action name', () => {
  const functions = Object.entries(OPERATION_ACTIONS).filter(([, entry]) => typeof entry === 'function');
  assert.deepEqual(functions.map(([operation]) => operation), ['control.acquire']);
  assert.equal(registry.actionForOperation('control.acquire', { takeover: true }), 'session.takeover');
  assert.equal(registry.actionForOperation('control.acquire', { takeover: false }), 'session.control');
  assert.equal(registry.actionForOperation('control.acquire', {}), 'session.control');
  assert.equal(registry.actionForOperation('control.acquire', { takeover: 'true' }), 'session.control');
});

test('every registry operation has a schema (team.owner.transfer was the last without one)', () => {
  const extra = Object.keys(OPERATION_ACTIONS).filter((operation) => !Object.hasOwn(PARAM_SCHEMAS, operation));
  assert.deepEqual(extra, []);
  assert.equal(Object.hasOwn(PARAM_SCHEMAS, 'team.owner.transfer'), true);
});

test('every raw route has exactly one declared action and the required routes exist', () => {
  const routes = Object.keys(ROUTE_ACTIONS);
  for (const route of routes) {
    assert.equal(Object.hasOwn(ACTIONS, ROUTE_ACTIONS[route]), true, `${route} -> undeclared action`);
  }
  for (const required of [
    'GET /api/v1/events', 'POST /api/v1/attachments', 'GET /api/v1/sessions/:session_id/attachments/:id',
    'GET /api/v1/sessions/:session_id/messages/:id', 'GET /api/v1/sessions/:session_id/artifacts/:id',
    'POST /api/v1/clients', 'GET /api/v1/team/bootstrap', 'POST /api/v1/team/hello',
    'POST /api/v1/team/status', 'POST /api/v1/team/join', 'POST /api/v1/team/leave',
    'POST /api/v1/team/engine/v1/chat/completions', 'GET /api/v1/team/engine/v1/models',
  ]) assert.equal(Object.hasOwn(ROUTE_ACTIONS, required), true, `${required} missing from the route table`);
  assert.equal(registry.actionForRoute('GET /api/v1/unknown'), null);
});

test('every action has a full matrix row and is reached by an operation or route', () => {
  const reached = new Set([
    ...Object.keys(OPERATION_ACTIONS).flatMap(operationActions), ...Object.values(ROUTE_ACTIONS),
    ...registry.ROUTER_ACTIONS, // slice 3-7: asked for by the router itself
  ]);
  for (const [action, row] of Object.entries(ACTIONS)) {
    for (const column of COLUMNS) assert.equal(typeof row[column], 'boolean', `${action}.${column}`);
    assert.equal(reached.has(action) || registry.RESERVED_ACTIONS.includes(action), true,
      `${action} is declared but unreachable`);
  }
  // A reserved action has no operation or route yet (later slices add operations, not mechanisms).
  for (const action of registry.RESERVED_ACTIONS) assert.equal(reached.has(action), false, `${action} is reached`);
  for (const action of reached) assert.equal(Object.hasOwn(ACTIONS, action), true, action);
  assert.deepEqual(PRINCIPALS, ['owner', 'member', 'read_only', 'pending', 'invite', 'revoked']);
});

test('an unmapped operation, route or action denies', () => {
  assert.equal(registry.actionForOperation('planted.operation', {}), null);
  assert.equal(registry.actionForRoute('GET /api/v1/planted'), null);
  assert.equal(registry.resolveCommand({ operation: 'planted.operation', params: {} }), null);
  const fixture = createTeamDirectoryFixture();
  const { authorize } = createAuthorizer({ directory: fixture.directory });
  const resource = { kind: 'session', id: 'session_1' };
  const denied = authorize(fixture.actors.owner, 'planted.action', resource, 'req_1');
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'CMP-HOST-0003');
  assert.equal(authorize(fixture.actors.owner, null, resource).ok, false);
  assert.equal(authorize(fixture.actors.owner, '__proto__', resource).ok, false);
  assert.equal(authorize(fixture.actors.owner, 'toString', resource).ok, false);
});

test('the command identity check denies a planted operation even for the owner', () => {
  const fixture = createTeamDirectoryFixture();
  const { authorize } = createAuthorizer({ directory: fixture.directory });
  const identity = createIdentityCheck({
    clients: { authorize: () => true }, bootEpoch: 'boot_1', disposed: { value: false }, authorize,
  });
  const context = { deviceId: fixture.actors.owner.device_id, clientToken: 't', isAuthenticated: () => true,
    actor: fixture.actors.owner };
  const base = { request_id: 'req_1', client_id: 'client_1', boot_epoch: 'boot_1', params: {} };
  assert.equal(identity({ ...base, operation: 'sessions.list' }, context), null);
  const denied = identity({ ...base, operation: 'planted.operation' }, context);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'CMP-HOST-0003');
});

// ---- Slice 3-2: the project column ------------------------------------------

const PROJECT_COLUMN = ['none', 'reader', 'writer', 'admin'];
const NEW_ACTIONS = ['project.create', 'project.assign', 'project.members', 'project.delete', 'project.audit.read',
  'project.files.upload', 'project.files.download'];

test('T2: every row has both columns, and a project role only on a session or project resource', () => {
  for (const [action, row] of Object.entries(ACTIONS)) {
    for (const column of COLUMNS) assert.equal(typeof row[column], 'boolean', `${action}.${column}`);
    assert.ok(PROJECT_COLUMN.includes(row.project), `${action} project column is ${row.project}`);
    if (row.project !== 'none') assert.ok(['session', 'project'].includes(row.resource), `${action} resource`);
    assert.ok(['deny', 'filter', 'required'].includes(row.emptyId), `${action} empty id rule`);
  }
  // E70 (owner, 2026-11-14): exactly these two rows refuse General as their project on a team host.
  assert.deepEqual(Object.keys(ACTIONS).filter((action) => ACTIONS[action].noGeneral === true).sort(),
    ['project.assign', 'session.create']);
  assert.deepEqual(Object.keys(ACTIONS).filter((action) => ACTIONS[action].emptyId === 'required'), ['session.create']);
  // Every operation and raw route lands on a row that has both columns.
  for (const operation of Object.keys(OPERATION_ACTIONS)) {
    for (const action of operationActions(operation)) assert.ok(PROJECT_COLUMN.includes(ACTIONS[action].project), operation);
  }
  for (const [route, action] of Object.entries(ROUTE_ACTIONS)) assert.ok(PROJECT_COLUMN.includes(ACTIONS[action].project), route);
});

test('T2: the new project actions exist, and two operations moved to them', () => {
  for (const action of NEW_ACTIONS) assert.equal(Object.hasOwn(ACTIONS, action), true, action);
  assert.equal(registry.actionForOperation('projects.create', {}), 'project.create');
  assert.equal(registry.actionForOperation('projects.assignSession', {}), 'project.assign');
  assert.equal(registry.actionForOperation('projects.rename', {}), 'project.write');
  // Slice 3-6b: project.audit.read left the reserved list (team.project.audit.read); slice 3-8b: the file rows.
  assert.deepEqual([...registry.RESERVED_ACTIONS].sort(), []);
  assert.equal(registry.actionForOperation('team.project.audit.read', {}), 'project.audit.read');
  assert.equal(registry.actionForOperation('session.view', {}), 'session.read');
  assert.equal(ACTIONS['project.assign'].target, 'project');
  const assign = registry.resolveCommand({ operation: 'projects.assignSession', session_id: 'session_1',
    params: { project_id: 'project_b' } });
  assert.deepEqual(assign.resources, [{ kind: 'session', id: 'session_1' }, { kind: 'project', id: 'project_b' }]);
  assert.deepEqual(assign.resource, { kind: 'session', id: 'session_1' });
  const create = registry.resolveCommand({ operation: 'sessions.create', params: { title: 'x' } });
  assert.deepEqual(create.resources, [{ kind: 'project', id: '' }]);
});

test('slice 3-4a: the team.project operations, their rows, and the generic operations a team host refuses', () => {
  const expected = {
    'team.project.create': 'project.create', 'team.project.rename': 'project.write',
    'team.project.members.list': 'project.members.read', 'team.project.members.add': 'project.members',
    'team.project.members.setRole': 'project.members', 'team.project.members.remove': 'project.members',
    'team.project.leave': 'project.leave', 'team.project.unjoined': 'project.discover', 'team.project.join': 'project.join',
    'team.project.delete': 'project.delete', // slice 3-4b
  };
  for (const [operation, action] of Object.entries(expected)) {
    assert.equal(registry.actionForOperation(operation, {}), action, operation);
    assert.ok(Object.hasOwn(PARAM_SCHEMAS, operation), operation);
  }
  assert.deepEqual(registry.TEAM_HOST_REFUSED_OPERATIONS, ['projects.create', 'projects.rename', 'projects.bindRoot']);
  assert.equal(Object.isFrozen(registry.TEAM_HOST_REFUSED_OPERATIONS), true);
});

test('T2: a row without the project column, or an operation claimed twice, fails at load', () => {
  const ok = [['a.one', 'OM', 'session', 'writer', ['op.one'], []]];
  assert.doesNotThrow(() => registry.buildActionTables(ok));
  assert.throws(() => registry.buildActionTables([['a.one', 'OM', 'session', ['op.one'], []]]), /registry_row_invalid/);
  assert.throws(() => registry.buildActionTables([['a.one', 'OM', 'session', 'owner', ['op.one'], []]]),
    /registry_row_invalid/);
  assert.throws(() => registry.buildActionTables([['a.one', 'OM', 'team', 'reader', ['op.one'], []]]),
    /registry_row_invalid/);
  assert.throws(() => registry.buildActionTables([...ok, ['a.two', 'OM', 'session', 'reader', ['op.one'], []]]),
    /registry_duplicate_operation/);
  assert.throws(() => registry.buildActionTables([...ok, ['a.one', 'OM', 'session', 'reader', [], []]]),
    /registry_duplicate_action/);
});

test('3-4b: exactly one row carries the owner-any flag, project.delete', () => {
  assert.deepEqual(Object.entries(ACTIONS).filter(([, row]) => row.ownerAny === true).map(([action]) => action),
    ['project.delete']);
  assert.ok(Object.values(ACTIONS).every((row) => typeof row.ownerAny === 'boolean'));
});
