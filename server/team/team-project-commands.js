'use strict';

// The team.project.* commands (TEAM_PROJECTS_SPEC "3-4a as built", "3-4b as built"): create,
// rename, members, leave, delete, the owner's names-only list of projects they have not joined,
// and the owner's self-add. `team-commands.js` runs each through its limiter, its live
// actor and (for a mutation) the router's receipt; the router has already run the one
// authorization function for the command's action row. The member store repeats every
// rule (`project-transitions.js`), with the caller's live member id as the actor;
// a member id or project id from params is only ever a target.
//
// On a host with a projects root, create makes the project's folder and binds it (3-4b); the
// folder is the host's choice, never a client's. The answers carry ids, roles, project names and
// booleans only, never a path. A log line carries a reason, ids and counts: never a project
// name, a display name or a path. Delete is team-project-delete.js, on the same queue.

const { hostFailure } = require('../api-contract');
const { LIMITS } = require('./member-schema');
const { PROJECT_CHANGED_EVENT } = require('./event-scope');
const { projectAudience } = require('./project-visibility');
const { safeLogger } = require('./safe-logger');
const { callSafely, reasonOf, storeFailed } = require('./team-project-common');

const READS = new Set(['team.project.members.list', 'team.project.unjoined']);
const PROJECT_REASONS = new Set(['created', 'renamed', 'members', 'deleting', 'deleted']);
// The store reasons after which a control or pool lease may no longer be allowed.
const RECHECK_REASONS = new Set(['members', 'deleting', 'deleted']);

const unavailable = () => hostFailure('unavailable', 'team_unavailable', '', true);
// The application service answers a refused name as invalid; anything else it
// refuses is a store failure here (its own wording never reaches a member).
function applicationFailure(answer) {
  if (reasonOf(answer) === 'invalid_name') return hostFailure('invalid', 'team_project_name_invalid');
  if (reasonOf(answer) === 'project_not_found') return hostFailure('forbidden', 'team_not_found');
  return storeFailed();
}

// `team_project_changed { project_id, reason }`: "read the project list again". The
// audience, computed now: the project's members as the visibility rule reads them,
// the members the change named (so a removed member is told), and the team owner
// (so the names-only list stays right). No bucket. A publisher that throws is logged.
function createProjectAnnouncer({ directory, publish, logger = null } = {}) {
  if (!directory || typeof directory.activeMemberIds !== 'function') {
    throw new TypeError('createProjectAnnouncer requires a directory.');
  }
  if (typeof publish !== 'function') throw new TypeError('createProjectAnnouncer requires publish.');
  const log = safeLogger(logger);
  return function announce(projectId, reason, memberIds = []) {
    if (typeof projectId !== 'string' || !PROJECT_REASONS.has(reason)) return;
    try {
      const audience = projectAudience(directory, projectId);
      for (const memberId of memberIds) if (typeof memberId === 'string' && memberId) audience.add(memberId);
      for (const memberId of directory.activeMemberIds()) {
        if (directory.memberActor(memberId)?.role === 'owner') audience.add(memberId);
      }
      publish(PROJECT_CHANGED_EVENT, { project_id: projectId, reason }, { audience });
    } catch {
      log('WARN', 'team_project.announce_failed', { reason });
    }
  };
}

// The one subscriber to the store's project changes: it announces each and, for a
// change of who may hold a lease, drops the named members' control leases in that
// project (`revokeLeases(projectId, memberIds)`, slice 3-7) and asks the pool to look at
// its scheduler leases again. Nothing it calls can throw into the store. Returns the unsubscribe.
// `dropViewers(event)` (slice 3-6b, team-approvals.js `dropForProject`) runs beside the lease revocation, and
// `dropFiles(event)` (slice 3-8b, team-project-files.js) beside it: uploads and manifests the member lost.
function subscribeProjectChanges({ store, announce, pool = () => null, revokeLeases = () => {}, dropViewers = () => {},
  dropFiles = () => {}, logger = null } = {}) {
  const log = safeLogger(logger);
  return store.onProjectChange((event) => {
    announce(event.project_id, event.reason, event.member_ids);
    if (!RECHECK_REASONS.has(event.reason)) return;
    try { revokeLeases(event.project_id, event.member_ids); } catch {
      log('WARN', 'team_project.lease_revoke_failed', { reason: event.reason });
    }
    try { dropViewers(event); } catch { log('WARN', 'team_project.viewer_drop_failed', { reason: event.reason }); }
    try { dropFiles(event); } catch { log('WARN', 'team_project.files_drop_failed', { reason: event.reason }); }
    try { pool()?.recheckLeases(); } catch { log('WARN', 'team_project.pool_recheck_failed', { reason: event.reason }); }
  });
}

// projects(): the application project service, null until the host core exists.
// chat(): the chat store, or null. announce: createProjectAnnouncer's function.
// folders: project-folders.js (a null root, or none: no folder step). deleter: team-project-delete.js,
// the one team-main.js also hands the start-up reconcile (none: delete answers unavailable).
function createTeamProjectCommands({
  store, directory, projects, chat = () => null, announce, logger = null, folders = null, deleter = null,
} = {}) {
  if (!store || typeof store.createProject !== 'function' || typeof store.snapshot !== 'function') {
    throw new TypeError('createTeamProjectCommands requires a member store.');
  }
  if (!directory || typeof directory.memberActor !== 'function') {
    throw new TypeError('createTeamProjectCommands requires a directory.');
  }
  if (typeof projects !== 'function' || typeof announce !== 'function') {
    throw new TypeError('createTeamProjectCommands requires projects() and announce.');
  }
  const log = safeLogger(logger);
  // The store call's subject: the actor is always the live member, the target a member id.
  const target = ({ params, actor }, memberId = params.member_id) => ({ actorMemberId: actor.member_id,
    projectId: params.project_id, memberId });
  // One mutation at a time, so two creates never interleave their steps.
  let chain = Promise.resolve();
  const serialized = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  function teamRow(projectId) {
    const doc = store.snapshot();
    if (!doc) { const opened = store.open(); return { failure: opened.ok ? storeFailed() : opened }; }
    return { doc, project: doc.projects.find((entry) => entry.project_id === projectId) || null };
  }

  // The channel step never undoes the project: a failure answers channel: false.
  async function makeChannel(projectId) {
    const chatStore = callSafely(chat);
    if (chatStore && typeof chatStore.createChannel === 'function') {
      try {
        if ((await chatStore.createChannel({ channelId: `chan_${projectId}` }))?.ok === true) return true;
      } catch { /* logged below */ }
    }
    log('WARN', 'team_project.channel_failed', { project_id: projectId });
    return false;
  }

  // The folder step never undoes the project: make the folder, bind exactly the path made, at root
  // revision 0. A failure answers folder: false and the next start's reconcile binds it.
  function makeFolder(projectId, app) {
    if (folders?.hasRoot !== true) return false;
    const made = folders.create(projectId);
    const bound = made.ok ? callSafely(() => app.bindProjectRoot({ project_id: projectId,
      root_path: made.path, expected_root_revision: 0 })) : null;
    if (bound?.ok === true) return true;
    log('WARN', 'team_project.folder_failed', { project_id: projectId,
      reason: made.ok ? reasonOf(bound) || 'bind_failed' : made.reason });
    return false;
  }

  async function create({ params, actor }, app) {
    // Advisory, before the record exists: the transition stays the authority.
    if (directory.memberActor(actor.member_id)?.role === 'read_only') {
      return hostFailure('forbidden', 'team_project_read_only');
    }
    const { doc, failure } = teamRow('');
    if (failure) return failure;
    if (doc.projects.length >= LIMITS.MAX_PROJECTS) return hostFailure('limit', 'team_project_limit');
    const made = callSafely(() => app.createProject({ name: params.name }));
    const projectId = made?.ok === true ? made.project?.id : null;
    if (typeof projectId !== 'string') return made?.ok === false ? applicationFailure(made) : storeFailed();
    const folder = makeFolder(projectId, app);
    const row = await store.createProject({ actorMemberId: actor.member_id, projectId });
    if (!row.ok) {
      // The record (and its empty folder) stay, seen by the owner only; the start-up reconcile removes them.
      log('WARN', 'team_project.create_unbound', { project_id: projectId, reason: reasonOf(row) });
      return row;
    }
    const channel = await makeChannel(projectId);
    return { ok: true, project_id: projectId, name: made.project.name, channel, folder };
  }

  // The router authorized the rename before the queue; a rename that waited behind
  // another mutation looks again, so an admin removed meanwhile renames nothing.
  async function rename({ params, actor }, app) {
    const role = directory.projectRole(actor.member_id, params.project_id);
    if (role == null) return hostFailure('forbidden', 'team_not_found');
    if (role !== 'admin') return hostFailure('forbidden', 'role_forbidden');
    const renamed = callSafely(() => app.renameProject({ name: params.name, project_id: params.project_id }));
    if (renamed?.ok !== true) return applicationFailure(renamed);
    announce(params.project_id, 'renamed');
    return { ok: true, project_id: params.project_id, name: renamed.project?.name ?? params.name };
  }

  // The roster of an active project the caller holds a row in; the owner's reader
  // access to a deleting project does not reach it (E30: names only).
  function membersList({ params, actor }) {
    const { project, failure } = teamRow(params.project_id);
    if (failure) return failure;
    if (project?.state !== 'active' || !project.members.some((entry) => entry.member_id === actor.member_id)) {
      return hostFailure('forbidden', 'team_not_found');
    }
    return { ok: true, members: project.members.map((entry) => ({ member_id: entry.member_id, role: entry.role })) };
  }

  // E30: every active team row the owner holds no row in, with its name; nothing else.
  function unjoined({ actor }, app) {
    if (!actor.owner) return hostFailure('forbidden', 'role_forbidden');
    const { doc, failure } = teamRow('');
    if (failure) return failure;
    const listed = callSafely(() => app.listProjects());
    if (listed?.ok !== true || !Array.isArray(listed.projects)) return storeFailed();
    const names = new Map(listed.projects.map((record) => [record.id, record.name]));
    const projectsList = doc.projects
      .filter((project) => project.state === 'active'
        && !project.members.some((entry) => entry.member_id === actor.member_id))
      .map((project) => ({ project_id: project.project_id, name: names.get(project.project_id) ?? null }));
    return { ok: true, projects: projectsList };
  }

  // E23: the owner with no row adds themself; with a row, asks for admin (the store
  // allows that only in an adminless project).
  async function join(call) {
    const { params, actor } = call;
    if (!actor.owner) return hostFailure('forbidden', 'role_forbidden');
    const { project, failure } = teamRow(params.project_id);
    if (failure) return failure;
    if (!project || project.state !== 'active') return hostFailure('forbidden', 'team_not_found');
    const self = target(call, actor.member_id);
    const held = project.members.some((entry) => entry.member_id === actor.member_id);
    return held ? store.setProjectRole({ ...self, role: 'admin' }) : store.addProjectMember({ ...self, role: params.role });
  }

  const HANDLERS = {
    'team.project.create': create,
    'team.project.rename': rename,
    'team.project.members.list': membersList,
    'team.project.members.add': (call) => store.addProjectMember({ ...target(call), role: call.params.role }),
    'team.project.members.setRole': (call) => store.setProjectRole({ ...target(call), role: call.params.role }),
    'team.project.members.remove': (call) => store.removeProjectMember(target(call)),
    'team.project.leave': (call) => store.removeProjectMember(target(call, call.actor.member_id)),
    'team.project.unjoined': unjoined,
    'team.project.join': join,
    'team.project.delete': (call, app) => (deleter
      ? deleter.run({ projectId: call.params.project_id, actor: call.actor }, app) : unavailable()),
  };

  // `call` is { params, actor: { member_id, owner } } from team-commands.js.
  async function dispatch(command, call) {
    const handler = Object.hasOwn(HANDLERS, command.operation) ? HANDLERS[command.operation] : null;
    if (!handler) return hostFailure('invalid', 'unsupported_operation');
    const app = callSafely(projects);
    if (!app) return unavailable();
    if (READS.has(command.operation)) return handler(call, app);
    return serialized(() => handler(call, app));
  }

  return Object.freeze({
    handles: (operation) => Object.hasOwn(HANDLERS, operation),
    isRead: (operation) => READS.has(operation),
    dispatch,
    // Slice 3-8b: upload begin and commit run on this one chain (the spec's project registry queue).
    serialized,
  });
}

module.exports = { createProjectAnnouncer, createTeamProjectCommands, subscribeProjectChanges };
