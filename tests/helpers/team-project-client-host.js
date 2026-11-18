'use strict';

// Slice 3-9: the shared project half of the real team host for the member client tests
// (tests/helpers/team-client-host.js `createTeamClientHost(t, { projects: true })`). Built as
// server/team/team-main.js builds it and as tests/server/helpers/team-project-fixture.js does: the real authorizer
// with the conversation resolver, the approvals wiring (viewers, project audit), the project commands with the
// folder module under a real projects root, project files with their transfer core and part routes, the project
// change subscriber with the lease revocation, and a scoped event stream. Only the application project service and
// the chat store are the project fixture's fakes. Also the method list the IPC contract test pins.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const controlLeases = require('../../server/control-leases');
const { createAuthorizer } = require('../../server/team/authorize');
const { createTeamBoardHost } = require('../../server/team/boards/team-board-host');
const { createProjectFolders } = require('../../server/team/project-folders');
const { createProjectDeleter } = require('../../server/team/team-project-delete');
const { createTeamApprovals } = require('../../server/team/team-approvals');
const { createTeamProjectFiles } = require('../../server/team/team-project-files');
const { startTeamProjectRules } = require('../../server/team/team-project-rules');
const {
  createProjectAnnouncer, createTeamProjectCommands, subscribeProjectChanges,
} = require('../../server/team/team-project-commands');
const { fakeApplicationProjects, fakeChatStore, fakeRecordRemover } = require('../server/helpers/team-project-fixture');
// Loaded when first used: team-client-host.js requires this file for createProjectParts.
const clientHost = () => require('./team-client-host');

// The 32 shared project methods (slice 3-9's 28, slice 3-10's four rule methods), in the descriptor order.
const PROJECT_METHODS = Object.freeze(['projectList', 'projectCreate', 'projectRename', 'projectDelete', 'projectMembers',
  'projectAddMember', 'projectSetMember', 'projectRemoveMember', 'projectLeave', 'projectUnjoined', 'projectJoin',
  'projectAudit', 'projectConversations', 'conversationCreate', 'conversationOpen', 'conversationClose', 'conversationCloseAll', 'conversationSend',
  'conversationCancel', 'conversationRename', 'conversationDelete', 'conversationControl', 'conversationDecide',
  'conversationAnswer', 'conversationDecline', 'uploadFolder', 'uploadCancel', 'downloadProject', 'downloadCancel',
  'projectRules', 'projectRuleAdd', 'projectRuleRemove', 'projectRuleAnswer', 'conversationPreferences']);

/**
 * `core()` answers the live host core (a restart replaces it), `leases()` its control leases. Answers what
 * team-client-host.js composes: the authorizer, the team command options, the backend factory, the route chain, an
 * `attach(core)` that wires a new core (returns its detach functions) and the parts a test reaches into.
 */
async function createProjectParts(t, { fx, store, config, logger, core, leases, dmParticipants, files: fileOptions = {} }) {
  const projectsRoot = path.join(fs.realpathSync.native(fx.root), 'team-host', 'projects');
  const trashRoot = path.join(path.dirname(projectsRoot), 'trash');
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(trashRoot, { recursive: true });
  const folders = createProjectFolders({ projectsRoot, trashRoot, logger });
  const sessionProject = (id) => core()?.composition?.backend?.sessionStore?.peekSessionSummary?.(id)?.project_id ?? null;
  const authorizer = createAuthorizer({ directory: store.directory, sessionProject, dmParticipants });
  const { authorize } = authorizer;
  const approvals = createTeamApprovals({ userDataPath: config.userDataPath, authorize, sessionProject, logger });
  approvals.open();
  const app = fakeApplicationProjects();
  const chat = fakeChatStore();
  const remover = fakeRecordRemover(app);
  // A test that attaches the real team chat (team-chat-hook.js) sets `parts.chatStore` to that host's store, so a
  // project's channel is made where the chat commands read it; unset, the fixture's fake.
  const chatOf = () => parts.chatStore ?? chat;
  const publish = (type, payload, options) => core()?.events.publish(type, payload, options);
  const announce = createProjectAnnouncer({ directory: store.directory, logger, publish });
  // Row 151: the board host as team-main.js builds it (the store, its commands, routes and events).
  const boards = createTeamBoardHost({ userDataPath: fs.realpathSync.native(config.userDataPath), directory: store.directory,
    sessionProject, publish, logger, audit: approvals.append });
  const deleter = createProjectDeleter({ store, folders, router: () => core()?.router ?? null,
    sessionStore: () => core()?.composition?.backend?.sessionStore ?? null, records: () => remover, chat: chatOf, logger,
    boards: () => boards.store });
  const projects = createTeamProjectCommands({ store, directory: store.directory, projects: () => app, chat: chatOf,
    announce, logger, folders, deleter });
  const files = createTeamProjectFiles({ userDataPath: fs.realpathSync.native(config.userDataPath), folders, store, authorize,
    logger, serialized: projects.serialized, audit: approvals.audit, backend: () => core()?.composition?.backend ?? null,
    projectsRoot, publish, ...fileOptions });
  await files.open();
  t.after(() => files.close());
  // Slice 3-10: the "Always allowed" rules, built as team-main.js builds them (3-12).
  const rules = startTeamProjectRules({ userDataPath: config.userDataPath, memberStore: store, approvals, logger,
    serialized: projects.serialized, publish, backend: () => core()?.composition?.backend ?? null });
  const unsubscribe = subscribeProjectChanges({ store, announce, logger,
    revokeLeases: (projectId, memberIds) => {
      const live = leases();
      if (live) controlLeases.projectLeaseRevoker({ leases: live, sessionProject })(projectId, memberIds);
    },
    dropViewers: (event) => { try { approvals.dropForProject(event); } finally { boards.dropForProject(event); } },
    dropFiles: files.dropForProject });
  const offs = [unsubscribe, ...files.attach()];
  t.after(() => { for (const off of offs) off(); });
  const createBackend = (options) => {
    const composition = fx.createBackend(options);
    composition.backend.knownProject = (projectId) => app.records.has(projectId);
    composition.backend.projectApplicationService = app;
    return composition;
  };
  const parts = {
    authorizer, approvals, app, chat, chatStore: null, folders, files, projectsRoot, createBackend, rules, boards,
    commandOptions: { projects, projectAudit: approvals.audit, files: files.commands, rules: rules.commands,
      boards: boards.commands, admitChatBoard: boards.admitChat },
    coreOptions: { sessionScope: authorizer.sessionScope, teamApprovals: rules.withApprovals(approvals) },
    // `partHook(ctx)` (a test's): runs before each part route; answering true means it handled the request (a drop).
    // `partsInFlight`: part requests the host is still answering, so a test can let them finish before teardown.
    partHook: null,
    partsInFlight: 0,
    routes: (live) => async (ctx) => {
      if (await live.assetRoutes(ctx)) return true;
      if (!/\/(uploads|downloads)\//u.test(ctx.pathname)) return (await files.routes(ctx)) || boards.routes(ctx);
      parts.partsInFlight += 1;
      try {
        return (parts.partHook && await parts.partHook(ctx)) || await files.routes(ctx);
      } finally {
        parts.partsInFlight -= 1;
      }
    },
    onMemberStream: (memberId, deviceId, change) => {
      approvals.onMemberStream(memberId, deviceId, change);
      boards.onMemberStream(memberId, deviceId, change);
    },
    attach: (live) => [...approvals.attach({ core: live, store }), ...rules.attach({ core: live, store }),
      ...boards.attach({ core: live, store })],
  };
  return parts;
}


// ---- The member side of the shared-project tests (tests/team-project-*.test.js) ----

// Reads the host may send on its own between calls (the list's re-reads, a viewing tick).
const BACKGROUND = new Set(['projects.list', 'sessions.list', 'session.view']);

function fakeTimers() {
  const live = new Map();
  let next = 0;
  return {
    setInterval(fn) { const id = ++next; live.set(id, fn); return { id, unref() {} }; },
    clearInterval(handle) { if (handle) live.delete(handle.id); },
    tick() { for (const fn of [...live.values()]) fn(); },
    size: () => live.size,
  };
}

// One Jenny: its own profile, secure store, state and project pushes, and an injected timer facility.
function seat(host, t, name, projectOptions = {}) {
  const states = [];
  const pushes = [];
  const boardPushes = [];
  const timers = fakeTimers();
  const service = host.createService({ userDataPath: clientHost().tempProfile(t, `jenny-team-${name}-`),
    getSecureStore: (() => { const store = clientHost().createMemorySecureStore(); return () => store; })(),
    sendState: (snapshot) => states.push(JSON.parse(JSON.stringify(snapshot))),
    sendProject: (payload) => pushes.push(JSON.parse(JSON.stringify(payload))), projectOptions: { timers, ...projectOptions },
    sendBoard: (payload) => boardPushes.push(JSON.parse(JSON.stringify(payload))) });
  return { name, service, states, pushes, boardPushes, timers, call: (method, value) => service.handle(method, value) };
}

async function online(one, teamId) {
  const row = () => one.states.at(-1)?.teams.find((team) => team.team_id === teamId);
  const ok = await clientHost().waitUntil(() => row()?.state === 'online' && row()?.member_state === 'active',
    { attempts: 300, interval: 20 });
  assert.ok(ok, `${one.name} never online: ${JSON.stringify(row())}`);
}

// The owner, a writer and a reader on one project, and a member who is on no project.
async function projectTeam(t, { hostOptions = {}, projectOptions = {} } = {}) {
  const { createTeamClientHost, joinAs } = clientHost();
  const host = await createTeamClientHost(t, { projects: true, ...hostOptions });
  const owner = seat(host, t, 'owner', projectOptions);
  const me = await joinAs(host, owner.service, { name: 'Olive Owner' });
  const teamId = me.teamId;
  await online(owner, teamId);
  const seats = { owner };
  for (const name of ['writer', 'reader', 'outsider']) {
    seats[name] = seat(host, t, name, projectOptions);
    seats[name].member = await joinAs(host, seats[name].service, { owner: me, name: `${name} member` });
    await online(seats[name], teamId);
  }
  const created = await owner.call('projectCreate', { team_id: teamId, name: 'Atlas' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const projectId = created.project_id;
  for (const [name, role] of [['writer', 'writer'], ['reader', 'reader']]) {
    const added = await owner.call('projectAddMember', { team_id: teamId, project_id: projectId,
      member_id: seats[name].member.member_id, role });
    assert.equal(added.ok, true, JSON.stringify(added));
  }
  const seen = [];
  host.env.commandHook = (command) => { seen.push(JSON.parse(JSON.stringify(command))); return null; };
  return { host, teamId, projectId, me, seen, ...seats };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

// The request log has stopped moving: no list read is out and three loop turns passed with no new command (fix 24).
async function drained(one, seen) {
  for (let round = 0; round < 200; round += 1) {
    const before = seen.length;
    await clientHost().waitUntil(() => one.service.projectResources().reads === 0, { attempts: 300, interval: 5 });
    for (let i = 0; i < 3; i += 1) await turn();
    if (seen.length === before && one.service.projectResources().reads === 0) return;
  }
  assert.fail(`${one.name}: the request log never settled`);
}

// The commands one call sent, without the background reads unless one of them is what the call maps to.
async function sentBy(seen, run, keep = [], one = null) {
  const before = seen.length;
  const answer = await run();
  if (one) await drained(one, seen); else for (let i = 0; i < 3; i += 1) await turn();
  const sent = seen.slice(before).filter((command) => !BACKGROUND.has(command.operation) || keep.includes(command.operation));
  return { answer, sent };
}

function lastPush(one, kind, test = () => true) {
  for (let i = one.pushes.length - 1; i >= 0; i -= 1) if (one.pushes[i].kind === kind && test(one.pushes[i])) return one.pushes[i];
  return null;
}

module.exports = {
  BACKGROUND, PROJECT_METHODS, createProjectParts, drained, fakeTimers, lastPush, online, projectTeam, seat, sentBy,
};
