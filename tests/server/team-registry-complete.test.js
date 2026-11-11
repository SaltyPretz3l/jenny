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
  assert.equal(Object.keys(PARAM_SCHEMAS).length, 64);
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

test('every PARAM_SCHEMAS operation maps to exactly one declared action', () => {
  for (const operation of Object.keys(PARAM_SCHEMAS)) {
    assert.equal(Object.hasOwn(OPERATION_ACTIONS, operation), true, `${operation} has no registry entry`);
    for (const action of operationActions(operation)) {
      assert.equal(typeof action, 'string', `${operation} resolves to an action name`);
      assert.equal(Object.hasOwn(ACTIONS, action), true, `${operation} -> ${action} is not a declared action`);
    }
  }
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
  ]) assert.equal(Object.hasOwn(ROUTE_ACTIONS, required), true, `${required} missing from the route table`);
  assert.equal(registry.actionForRoute('GET /api/v1/unknown'), null);
});

test('every action has a full matrix row and is reached by an operation or route', () => {
  const reached = new Set([
    ...Object.keys(OPERATION_ACTIONS).flatMap(operationActions), ...Object.values(ROUTE_ACTIONS),
  ]);
  for (const [action, row] of Object.entries(ACTIONS)) {
    for (const column of COLUMNS) assert.equal(typeof row[column], 'boolean', `${action}.${column}`);
    assert.equal(reached.has(action), true, `${action} is declared but unreachable`);
  }
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
