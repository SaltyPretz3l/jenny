'use strict';

// Slice 3-4a: a team host composed as server/team/team-main.js composes it, with the
// real member store, directory, authorizer, router and event stream, and fakes for
// only the application project service and the chat store. Seats: the owner, Alice,
// Bob and Carl (full members), Rae (read-only) and Pia (pending). Slice 3-4b: with
// `{ projectsRoot: true }` the real folder module under `<root>/team-host/{projects,trash}`.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const { loadHostConfig } = require('../../../server/config');
const { ClientRegistry } = require('../../../server/client-registry');
const controlLeases = require('../../../server/control-leases');
const { createHostCore } = require('../../../server/host-core');
const { createAuthorizer } = require('../../../server/team/authorize');
const { createInviteService } = require('../../../server/team/invites');
const { LOCAL_COMMAND } = require('../../../server/team/member-schema');
const { MemberStore } = require('../../../server/team/member-store');
const { createProjectFolders } = require('../../../server/team/project-folders');
const { createTeamBoardHost } = require('../../../server/team/boards/team-board-host');
const { createProjectDeleter } = require('../../../server/team/team-project-delete');
const { reconcileProjects } = require('../../../server/team/team-project-reconcile');
const { createTeamApprovals } = require('../../../server/team/team-approvals');
const { createTeamProjectFiles } = require('../../../server/team/team-project-files');
const { startTeamProjectRules } = require('../../../server/team/team-project-rules');
const { createTeamCommands } = require('../../../server/team/team-commands');
const { createRouteGuard } = require('../../../server/team/route-guard');
const { ProjectApplicationService } = require('../../../services/projects/project-application-service');
const { ProjectService } = require('../../../services/projects/project-service');
const { ProjectStore } = require('../../../services/projects/project-store');
const { ProjectWorkspacePool } = require('../../../services/projects/project-workspace-pool');
const { ToolPermissionStore } = require('../../../services/tools/tool-permission-store');
const {
  createProjectAnnouncer, createTeamProjectCommands, subscribeProjectChanges,
} = require('../../../server/team/team-project-commands');
const { Response, dataFrames } = require('./session-scope-fixture');
const { TEAM_NAME, createTeamHostFixture, randomKey } = require('./team-host-fixture');

// The application project service's contract, in memory: its own ids, its name rule. Like the real
// ProjectApplicationService it has no record remover: that is `fakeRecordRemover` (the backend's projectService).
function fakeApplicationProjects() {
  const records = new Map();
  const fake = {
    records, calls: [], onCreate: null,
    createProject({ name }) {
      fake.calls.push('create');
      if (typeof name !== 'string' || !name.trim() || name === 'bad name') {
        return { ok: false, error: { code: 'CMP-PROJECT-0001', reason: 'invalid_name', message: 'Project name is invalid.' } };
      }
      const id = `project_${crypto.randomBytes(16).toString('hex')}`;
      records.set(id, { id, name: name.trim(), root_path: null, root_revision: 0 });
      if (fake.onCreate) fake.onCreate(id);
      return { ok: true, project: { id, name: name.trim(), root_path: null, root_revision: 0 } };
    },
    // The real service's compare-and-set on the root revision; `bindFail` refuses as a store failure.
    bindProjectRoot({ project_id: projectId, root_path: rootPath, expected_root_revision: expected }) {
      fake.calls.push('bind');
      const record = records.get(projectId);
      if (!record) return { ok: false, error: { code: 'CMP-PROJECT-0002', reason: 'project_not_found' } };
      if (fake.bindFail) return { ok: false, error: { code: 'CMP-PROJECT-0006', reason: 'project_store_failed' } };
      if (expected !== record.root_revision) {
        return { ok: false, error: { code: 'CMP-PROJECT-0004', reason: 'stale_root_revision' } };
      }
      Object.assign(record, { root_path: rootPath, root_revision: record.root_revision + 1 });
      return { ok: true, project: { ...record } };
    },
    renameProject({ name, project_id: projectId }) {
      fake.calls.push('rename');
      const record = records.get(projectId);
      if (!record) return { ok: false, error: { code: 'CMP-PROJECT-0002', reason: 'project_not_found' } };
      record.name = name;
      return { ok: true, project: { id: projectId, name, root_path: null, root_revision: 0 } };
    },
    listProjects() {
      return { ok: true, storage: { read_only: fake.readOnly === true, reason: null }, projects: [...records.values()].map((record) => ({
        id: record.id, name: record.name, root_path: record.root_path, root_revision: record.root_revision,
        authority_key: `authority_${'c'.repeat(64)}` })) };
    },
  };
  return fake;
}

// The backend's ProjectService `remove`, over the fake application service's records.
function fakeRecordRemover(app) {
  const remover = {
    removeFail: false,
    remove(projectId) {
      app.calls.push('remove');
      if (remover.removeFail) return { ok: false, reason: 'project_store_failed' };
      return app.records.delete(projectId) ? { ok: true } : { ok: false, reason: 'project_not_found' };
    },
  };
  return remover;
}

function fakeChatStore() {
  const chat = {
    channels: new Set(), fail: false, hold: null, entered: 0,
    async createChannel({ channelId }) {
      chat.entered += 1;
      if (chat.hold) await chat.hold;
      if (chat.fail) return { ok: false, error: { code: 'CMP-HOST-0007', reason: 'team_chat_limit' } };
      if (chat.channels.has(channelId)) return { ok: true, channel_id: channelId, created: false };
      chat.channels.add(channelId);
      return { ok: true, channel_id: channelId, created: true };
    },
    archived: new Set(),
    async archiveChannel({ channelId }) {
      if (!chat.channels.has(channelId)) return { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_chat_not_found' } };
      chat.archived.add(channelId);
      return { ok: true, rev: 1 };
    },
    // E67: the project delete removes the channel; one never made answers ok, removed: false. `removeFail` refuses.
    removed: new Set(), removeFail: false,
    async removeChannel({ channelId }) {
      if (chat.removeFail) return { ok: false, error: { code: 'CMP-HOST-0006', reason: 'team_chat_store_failed' } };
      const had = chat.channels.delete(channelId);
      if (had) chat.removed.add(channelId);
      return { ok: true, removed: had };
    },
  };
  return chat;
}

async function seedTeam(store) {
  const must = (value, what) => { if (!value.ok) throw new Error(`${what} failed: ${value.error.reason}`); return value; };
  const join = async (kind, name, { actor = LOCAL_COMMAND, role = 'member', admit = true } = {}) => {
    const created = must(await store.createInvite({ kind, actorMemberId: actor,
      ...(kind === 'new_member' ? { role } : {}), invitePublicKey: randomKey() }), 'invite');
    const seat = must(await store.redeem({ inviteId: created.invite_id, devicePublicKey: randomKey(),
      displayName: name, label: 'Laptop' }), 'redeem');
    if (kind === 'new_member' && admit) must(await store.admit({ actorMemberId: actor, memberId: seat.member_id }), 'admit');
    return seat;
  };
  const owner = await join('owner_first', 'Olive Owner');
  const by = { actor: owner.member_id };
  return {
    owner, alice: await join('new_member', 'Alice', by), bob: await join('new_member', 'Bob', by),
    carl: await join('new_member', 'Carl', by), rae: await join('new_member', 'Rae', { ...by, role: 'read_only' }),
    pia: await join('new_member', 'Pia', { ...by, admit: false }),
  };
}

// The real application project service and record remover on the fixture's profile (`realProjects`), as
// application-project-scope.js puts them on the backend: `projectApplicationService` and `projectService`.
function realApplicationProjects(dir, sessionStore) {
  const projectStore = new ProjectStore(path.join(dir, 'projects.json'));
  const projectService = new ProjectService({ store: projectStore });
  const pool = new ProjectWorkspacePool({ projectService });
  const projectAuthority = {
    captureProject(projectId) {
      const captured = pool.capture(projectId);
      if (!captured.ok) throw Object.assign(new Error('Project authority unavailable.'), { reason: captured.reason });
      return captured.authority;
    },
    requireCurrent: (authority) => authority,
  };
  const app = new ProjectApplicationService({ projectService, projectStore, projectAuthority, sessionStore,
    permissionStore: new ToolPermissionStore(path.join(dir, 'tool-permissions.json')), isSessionBusy: () => false });
  return { app, projectService, projectStore };
}

function folderRoots(fx) {
  const projectsRoot = path.join(fs.realpathSync.native(fx.root), 'team-host', 'projects');
  const trashRoot = path.join(path.dirname(projectsRoot), 'trash');
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(trashRoot);
  return { projectsRoot, trashRoot };
}

// Slice 3-6b: `viewerNow` is the viewer store's clock, `createAudit` replaces the project audit log;
// `approvalOptions` (slice 3-9) go to createTeamApprovals as they are (a limiter with a test clock).
// Slice 3-8b: `files` (an object of createTeamProjectFiles options, `{}` for the defaults) wires project files;
// in it `wrapFolders(folders)` and `wrapAuthorize(authorize)` replace what the files module alone is given (a spy
// or a fault), and `hardLinks: false` makes the folder module copy instead of linking.
// Slice 3-12: `rules` (an object of createTeamProjectRules options, `{}` for the defaults) wires the rules as team-main.js does;
// `commandLimiter` is the team command limiter (team-main.js builds one; the fixture has none by default).
// Row 151: `boards: true` builds the board host on the profile as team-main.js does (boards/team-board-host.js):
// the store (`state.boards`, which the deleter is handed; without the switch the deleter has no `boards`
// dependency at all), the team.board.* commands, the routes (`boardRoute`), the events (`state.boardEvents`), the
// turn ports and presence (`state.boardHost`). `boardLimits` ({ commands, route }) replaces rate limits,
// `boardEventLimits` lowers the inline rule, `wrapBoards(store)` replaces what the commands, the routes and the
// proposals are given (a spy or a hold), and `boardPresenceNow` is the presence store's clock.
async function createTeamProjectFixture(t, { projectsRoot = false, clock = Date.now, countCaps = {}, realProjects = false,
  leaseNow = Date.now, viewerNow, createAudit, files: fileOptions = null, approvalOptions = {}, rules: ruleOptions = null, commandLimiter = null, boards: boardsOption = false, boardLimits = {}, wrapBoards = (value) => value, boardEventLimits = {}, boardPresenceNow } = {}) {
  const { wrapFolders = (value) => value, wrapAuthorize = (value) => value, hardLinks = true, ...fileRest } = fileOptions ?? {};
  const fx = createTeamHostFixture(t);
  const roots = projectsRoot ? folderRoots(fx) : { projectsRoot: null, trashRoot: null };
  const folders = createProjectFolders({ ...roots, clock, logger: fx.logger, countCaps, hardLinks });
  const config = loadHostConfig(fx.configPath);
  const store = new MemberStore({ userDataPath: fx.profile, hostPublicKey: fx.hostPublicKey, teamName: TEAM_NAME,
    logger: fx.logger });
  assert.equal(store.open().ok, true);
  const seats = await seedTeam(store);
  const clients = new ClientRegistry({ capacity: 64, perDeviceCapacity: 4 });
  let core = null;
  const sessionProject = (id) => core?.composition?.backend?.sessionStore?.peekSessionSummary?.(id)?.project_id ?? null;
  const { authorize, sessionScope } = createAuthorizer({ directory: store.directory, sessionProject });
  // Slice 3-6b: the approvals wiring, as team-main.js builds it.
  const approvals = createTeamApprovals({ userDataPath: config.userDataPath, authorize, sessionProject, logger: fx.logger,
    clock, ...(viewerNow ? { viewerClock: viewerNow } : {}), ...(createAudit ? { createAudit } : {}), ...approvalOptions });
  approvals.open();
  const leases = new controlLeases.ControlLeases({ now: () => leaseNow() });
  const fake = fakeApplicationProjects();
  const chat = fakeChatStore();
  const state = { app: fake, chat, remover: fakeRecordRemover(fake), recheckCalls: 0,
    boards: null };
  // The board host announces into the fixture's real event stream and audits through the approvals' log.
  const boardHost = boardsOption ? createTeamBoardHost({ userDataPath: fs.realpathSync.native(config.userDataPath),
    directory: store.directory, sessionProject, clock, logger: fx.logger, audit: approvals.append, wrap: wrapBoards,
    limits: { commands: boardLimits.commands, route: boardLimits.route, events: boardEventLimits },
    ...(boardPresenceNow ? { presenceClock: boardPresenceNow } : {}),
    publish: (type, payload, options) => core?.events.publish(type, payload, options) }) : null;
  Object.assign(state, { boardHost, boards: boardHost?.store ?? null, boardEvents: boardHost?.events ?? null });
  const announce = createProjectAnnouncer({ directory: store.directory, logger: fx.logger,
    publish: (type, payload, options) => core?.events.publish(type, payload, options) });
  // One deleter for the command and the reconcile, as team-main.js builds it.
  const deleter = createProjectDeleter({ store, folders, router: () => core?.router ?? null,
    sessionStore: () => core?.composition?.backend?.sessionStore ?? null,
    records: () => (realProjects ? core?.composition?.backend?.projectService : state.remover),
    chat: () => state.chat, rules: () => rules, logger: fx.logger, ...(boardsOption ? { boards: () => state.boards } : {}) });
  const projects = createTeamProjectCommands({ store, directory: store.directory, projects: () => state.app,
    chat: () => state.chat, announce, logger: fx.logger, folders, deleter });
  const rules = ruleOptions ? startTeamProjectRules({ userDataPath: config.userDataPath, memberStore: store, approvals, clock,
    logger: fx.logger, serialized: projects.serialized, backend: () => core?.composition?.backend ?? null,
    publish: (type, payload, options) => core?.events.publish(type, payload, options), ...ruleOptions }) : null;
  // Slice 3-8b: project files as team-main.js wires them (the shared audit, the project chain).
  // The profile by its native real path: a Windows runner's temp folder is an 8.3 alias, which the staging root refuses.
  const files = fileOptions ? createTeamProjectFiles({ userDataPath: fs.realpathSync.native(config.userDataPath), folders: wrapFolders(folders), store,
    authorize: wrapAuthorize(authorize), logger: fx.logger, clock, serialized: projects.serialized, audit: approvals.audit,
    backend: () => core?.composition?.backend ?? null, projectsRoot: roots.projectsRoot,
    publish: (type, payload, options) => core?.events.publish(type, payload, options), ...fileRest }) : null;
  if (files) {
    await files.open();
    t.after(() => files.close());
  }
  const teamCommands = createTeamCommands({ store, invites: createInviteService({ store, logger: fx.logger }),
    directory: store.directory, logger: fx.logger, projects, projectAudit: approvals.audit, files: files?.commands ?? null,
    rules: rules?.commands ?? null, limiter: commandLimiter,
    boards: boardHost?.commands ?? null, admitChatBoard: boardHost?.admitChat ?? null });
  const boardRoutes = boardHost?.routes ?? null;
  // The router's project dispatcher keeps the service it was built with: the fake goes in first.
  const createBackend = (options) => {
    const composition = fx.createBackend(options);
    const { backend } = composition;
    if (realProjects) {
      const real = realApplicationProjects(path.dirname(backend.sessionStore.filePath ?? fx.profile), backend.sessionStore);
      Object.assign(state, { app: real.app, projectStore: real.projectStore });
      backend.projectService = real.projectService;
      backend.knownProject = (projectId) => real.projectService.get(projectId) !== null;
    } else backend.knownProject = (projectId) => fake.records.has(projectId);
    backend.projectApplicationService = state.app;
    return composition;
  };
  core = createHostCore({ config, clients, leases, authorize, guardRequired: true,
    maxEventClients: 64, logger: fx.logger, createBackend, teamCommands, sessionScope,
    teamApprovals: rules ? rules.withApprovals(approvals) : approvals });
  const backend = core.composition.backend;
  const detach = [...approvals.attach({ core, store }), ...(boardHost ? boardHost.attach({ core, store }) : [])];
  t.after(() => { for (const off of detach) off(); });
  const unsubscribe = subscribeProjectChanges({ store, announce,
    pool: () => ({ recheckLeases: () => { state.recheckCalls += 1; } }), logger: fx.logger,
    // Slice 3-7: the control-lease revocation, as team-main.js wires it.
    revokeLeases: controlLeases.projectLeaseRevoker({ leases, sessionProject }),
    dropViewers: (event) => { try { approvals.dropForProject(event); } finally { boardHost?.dropForProject(event); } },
    dropFiles: files ? files.dropForProject : undefined });
  t.after(() => unsubscribe());
  if (files) for (const off of files.attach()) t.after(off);
  if (rules) for (const off of rules.attach({ core, store })) t.after(off);

  const actor = (who) => ({ member_id: seats[who].member_id, device_id: seats[who].device_id });
  const registered = {};
  const send = (who, operation, params = {}, extra = {}) => {
    registered[who] ??= clients.register(seats[who].device_id);
    const command = { api_version: 1, operation, request_id: `request_${crypto.randomUUID()}`,
      client_id: registered[who].client_id, boot_epoch: core.bootEpoch, params, ...extra };
    // The context team-http-server.js hands the router: the guard is this request's, read live.
    return core.router.dispatch(command, { deviceId: seats[who].device_id, clientToken: registered[who].client_token,
      isAuthenticated: () => true, actor: actor(who),
      guard: createRouteGuard({ authorize, actor: actor(who), requestId: command.request_id }) });
  };
  const ok = async (promise, what = 'command') => {
    const answer = await promise;
    assert.equal(answer.ok, true, `${what}: ${JSON.stringify(answer)}`);
    return answer;
  };
  const reason = async (promise) => {
    const answer = await promise;
    assert.equal(answer.ok, false, JSON.stringify(answer));
    return answer.error.reason;
  };
  // A member stream; the default cursor is the stream's current one.
  const attach = (who, { cursor = core.events.cursor } = {}) => {
    const response = new Response();
    core.events.subscribe({ response, deviceId: seats[who].device_id, authorized: () => true,
      bootEpoch: core.bootEpoch, cursor, identity: sessionScope.identity(actor(who)) });
    return response;
  };
  const projectFrames = (response) => dataFrames(response.frames)
    .filter((frame) => frame.event_type === 'team_project_changed')
    .map((frame) => ({ project_id: frame.project_id, reason: frame.reason }));
  const listed = async (who) => (await ok(send(who, 'projects.list'), `${who} projects.list`)).projects
    .map((project) => project.id ?? project.project_id);
  // A project Alice created through the router, with Carl a writer and Rae a reader.
  const sharedProject = async (name = 'Apollo') => {
    const created = await ok(send('alice', 'team.project.create', { name }), 'create');
    for (const [who, role] of [['carl', 'writer'], ['rae', 'reader']]) {
      await ok(send('alice', 'team.project.members.add', { project_id: created.project_id,
        member_id: seats[who].member_id, role }), `add ${who}`);
    }
    return created.project_id;
  };
  // Slice 3-8b: one raw part request through the files routes, as the team HTTP layer hands it over.
  // `body` is the bytes sent; `length` the Content-Length (default: the body's); `during` runs while the body is
  // half sent. Answers { status, json, bytes, handled, flowing } (flowing: the request body was being read or drained).
  // `routes` is the route chain asked (default: the files routes).
  const fileRoute = async (who, method, pathname, { body = Buffer.alloc(0), length, during, authorizedNow = () => true,
    deviceId, guard, routes = files.routes } = {}) => {
    const request = new Readable({ read() {} });
    request.method = method;
    request.headers = length === null ? {} : { 'content-length': String(length ?? body.length) };
    const answer = { status: null, headers: {}, chunks: [] };
    const response = { headersSent: false, destroyed: false, writableEnded: false, setHeader(k, v) { answer.headers[k] = v; },
      writeHead(status, headers = {}) { answer.status = status; Object.assign(answer.headers, headers); response.headersSent = true; },
      end(chunk) { if (chunk) answer.chunks.push(Buffer.from(chunk)); response.writableEnded = true; },
      destroy() { response.destroyed = true; } };
    const seat = who ? actor(who) : undefined;
    const ctx = { request, response, pathname, deviceId: deviceId ?? seat?.device_id ?? 'device_none', requestId: 'request_files',
      actor: seat, authorized: authorizedNow,
      guard: guard ?? (seat ? createRouteGuard({ authorize, actor: seat, requestId: 'request_files' }) : undefined) };
    const handling = routes(ctx);
    if (method === 'PUT' || (method === 'POST' && body.length > 0)) {
      const half = Math.floor(body.length / 2);
      request.push(body.subarray(0, half));
      if (during) { await new Promise((resolve) => setImmediate(resolve)); await during(); }
      request.push(body.subarray(half));
      answer.beforeEnd = answer.status !== null;
      request.push(null);
    } else request.push(null);
    const handled = await handling;
    const flowing = request.readableFlowing === true;
    // A refusal that drains the body answers at the body's end, after the route returned.
    for (let tries = 0; tries < 1000 && handled && !response.writableEnded && !response.destroyed; tries += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const bytes = Buffer.concat(answer.chunks);
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { parsed = null; }
    return { handled, status: answer.status, headers: answer.headers, json: parsed, bytes, flowing,
      answeredBeforeEnd: answer.beforeEnd === true };
  };
  const putPart = (who, projectId, uploadId, index, n, body, options = {}) => fileRoute(who, 'PUT',
    `/api/v1/projects/${projectId}/uploads/${uploadId}/files/${index}/parts/${n}`, { body, ...options });
  const getPart = (who, projectId, manifestId, index, n, options = {}) => fileRoute(who, 'GET',
    `/api/v1/projects/${projectId}/downloads/${manifestId}/files/${index}/parts/${n}`, options);
  // Row 151 T2: one board snapshot request, as the team HTTP layer hands it to the board routes.
  const boardRoute = (who, projectId, boardId, options = {}) => fileRoute(who, 'GET',
    `/api/v1/projects/${projectId}/boards/${boardId}`, { routes: boardRoutes, ...options });
  // The start-up reconcile as team-main.js runs it.
  const reconcile = (options = {}) => reconcileProjects({ store, projects: state.app,
    records: () => (realProjects ? core.composition.backend.projectService : state.remover), folders,
    chat: state.chat, logger: fx.logger, deleter, ...options });
  return {
    fx, store, seats, core, backend, state, send, ok, reason, attach, projectFrames, listed, sharedProject, leases, clients,
    folders, roots, deleter, reconcile, approvals, files, rules, authorize, projects, fileRoute, putPart, getPart, boardRoute, sessionScope, config, logText: () => JSON.stringify(fx.logs),
  };
}

// The fakes are shared with the member client's project host (tests/helpers/team-project-client-host.js, slice 3-9).
module.exports = { createTeamProjectFixture, fakeApplicationProjects, fakeChatStore, fakeRecordRemover };
