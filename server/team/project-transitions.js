'use strict';

// The project transitions of the team member store (TEAM_PROJECTS_SPEC slice
// 3-1): who is in which shared project. Pure functions over a draft copy of the
// document, with the same return shape as member-transitions.js:
//   { ok: false, failure }                                   refused, nothing changes
//   { ok: true, noop: true, result }                         nothing to commit
//   { ok: true, audit: [...], projectEvent, result }         commit, audit first
// Each transition decides everything before it mutates the draft.
//
// The store repeats the authority rules that must never depend on wiring
// (E17, E22, E23, P4). The actor always comes from the input; a missing or
// unknown actor is a refusal, never the owner:
// - any active full member (owner or member) creates a project and is its admin;
// - a project admin adds, re-roles and removes members; the team owner does so
//   only as a project admin, with two audited ways in: adding themself to a
//   project they are not in, and making themself admin of an active project
//   that has no admin left (a cascade can leave one so);
// - a project admin, or the team owner, marks a project deleting and removes it;
// - an active project keeps at least one admin through every project transition;
// - a read-only team member is only ever a reader; only an active member is added.
// A project the actor cannot see answers `team_not_found`, like one that does not
// exist. The owner sees every project (E23); a deleting project is seen only by
// the owner and its admins.
//
// The cascades (`leaveAllProjects`, `capToReader`) run inside the team change
// that causes them, in the same commit, and add no audit entry of their own: the
// team change's entry carries a bounded count (`cascadeDetail`).

const { LIMITS, PROJECT_ROLES, isProjectId } = require('./member-schema');
const { refuse, findMember, activeActor } = require('./transition-common');

function findProject(doc, projectId) {
  if (typeof projectId !== 'string') return null;
  return doc.projects.find((project) => project.project_id === projectId) || null;
}

function memberEntry(project, memberId) {
  return project.members.find((entry) => entry.member_id === memberId) || null;
}

function adminCount(project) {
  return project.members.filter((entry) => entry.role === 'admin').length;
}

function isAdminless(project) {
  return project.state === 'active' && adminCount(project) === 0;
}

// Resolves the actor, the project and the actor's row in it, and refuses a
// project the actor cannot see. Decides no authority beyond seeing.
function projectAccess(doc, input) {
  const checked = activeActor(doc, input.actorMemberId);
  if (!checked.ok) return checked;
  const { actor } = checked;
  const project = findProject(doc, input.projectId);
  if (!project) return refuse('forbidden', 'team_not_found');
  const entry = memberEntry(project, actor.member_id);
  const role = entry ? entry.role : null;
  const isOwner = actor.role === 'owner';
  const visible = isOwner || role === 'admin' || (role !== null && project.state === 'active');
  if (!visible) return refuse('forbidden', 'team_not_found');
  return {
    ok: true, actor, project, entry, role, isOwner,
  };
}

function changeEvent(reason, project, memberIds, now) {
  return {
    reason, project_id: project.project_id, member_ids: memberIds, at: now,
  };
}

function projectAudit(kind, actor, project, fields = {}) {
  return {
    kind, actor_member_id: actor.member_id, project_id: project.project_id, ...fields,
  };
}

// The target of an add or re-role: a valid role, and the P4 cap.
function checkRole(target, role) {
  if (typeof role !== 'string' || !PROJECT_ROLES.includes(role)) return refuse('invalid', 'team_project_role_invalid');
  if (target.role === 'read_only' && role !== 'reader') return refuse('forbidden', 'team_project_role_capped');
  return null;
}

// ------------------------------------------------------------------ create

// `projectId` is host-generated: slice 3-4 passes the application store's id or
// leaves it out. A caller must never pass a client-chosen id, because a taken id
// answers `team_project_exists`, which would tell a client that a project it
// cannot see exists.
function newProjectId(doc, input, ctx) {
  if (input.projectId === undefined) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = ctx.newProjectId();
      if (!findProject(doc, id)) return { ok: true, id };
    }
    return refuse('conflict', 'team_project_exists');
  }
  if (!isProjectId(input.projectId)) return refuse('invalid', 'team_project_id_invalid');
  if (findProject(doc, input.projectId)) return refuse('conflict', 'team_project_exists');
  return { ok: true, id: input.projectId };
}

function createProject(doc, input, ctx) {
  const checked = activeActor(doc, input.actorMemberId);
  if (!checked.ok) return checked;
  const { actor } = checked;
  if (actor.role === 'read_only') return refuse('forbidden', 'team_project_read_only');
  if (doc.projects.length >= LIMITS.MAX_PROJECTS) return refuse('limit', 'team_project_limit');
  const id = newProjectId(doc, input, ctx);
  if (!id.ok) return id;
  const project = {
    project_id: id.id,
    created_by: actor.member_id,
    created_at: ctx.now,
    state: 'active',
    members: [{
      member_id: actor.member_id, role: 'admin', added_by: actor.member_id, added_at: ctx.now,
    }],
  };
  doc.projects.push(project);
  return {
    ok: true,
    audit: [projectAudit('project_created', actor, project, { subject_member_id: actor.member_id, detail: 'role=admin' })],
    projectEvent: changeEvent('created', project, [actor.member_id], ctx.now),
    result: { project_id: project.project_id },
  };
}

// ----------------------------------------------------------------- members

// `projectAccess` for a member change, which a deleting project refuses. The
// admin decision is made by each transition, not here.
function memberChangeAccess(doc, input) {
  const access = projectAccess(doc, input);
  if (!access.ok) return access;
  if (access.project.state !== 'active') return refuse('forbidden', 'team_project_deleting');
  return access;
}

function addProjectMember(doc, input, ctx) {
  const access = memberChangeAccess(doc, input);
  if (!access.ok) return access;
  const { actor, project } = access;
  const selfAdd = access.isOwner && input.memberId === actor.member_id && access.role === null;
  if (access.role !== 'admin' && !selfAdd) return refuse('forbidden', 'role_forbidden');
  const target = findMember(doc, input.memberId);
  if (!target) return refuse('forbidden', 'team_not_found');
  if (target.state !== 'active') return refuse('conflict', 'team_member_state_invalid');
  const badRole = checkRole(target, input.role);
  if (badRole) return badRole;
  if (memberEntry(project, target.member_id)) return refuse('conflict', 'team_project_member_exists');
  project.members.push({
    member_id: target.member_id, role: input.role, added_by: actor.member_id, added_at: ctx.now,
  });
  return {
    ok: true,
    audit: [projectAudit(selfAdd ? 'project_owner_self_added' : 'project_member_added', actor, project, {
      subject_member_id: target.member_id, detail: `role=${input.role}`,
    })],
    projectEvent: changeEvent('members', project, [target.member_id], ctx.now),
    result: { project_id: project.project_id, member_id: target.member_id, role: input.role },
  };
}

// The admin decision for a re-role or removal: the actor is a project admin and
// the target already has a row. Returns the target and its row.
function authorizeAdminChange(doc, access, input) {
  if (access.role !== 'admin') return refuse('forbidden', 'role_forbidden');
  const target = findMember(doc, input.memberId);
  const entry = target ? memberEntry(access.project, target.member_id) : null;
  if (!entry) return refuse('forbidden', 'team_not_found');
  return { ok: true, target, entry };
}

// The way back into an adminless project: the team owner, holding a row in an
// active project with no admin, makes themself admin. Nothing else widens.
function isOwnerRecovery(access, input) {
  return access.isOwner && access.entry !== null && input.memberId === access.actor.member_id
    && input.role === 'admin' && isAdminless(access.project);
}

function ownerRecovery(access, ctx) {
  const { actor, project, entry } = access;
  const previous = entry.role;
  entry.role = 'admin';
  return {
    ok: true,
    audit: [projectAudit('project_owner_self_added', actor, project, {
      subject_member_id: actor.member_id, detail: `from=${previous},to=admin`,
    })],
    projectEvent: changeEvent('members', project, [actor.member_id], ctx.now),
    result: {
      project_id: project.project_id, member_id: actor.member_id, role: 'admin', changed: true,
    },
  };
}

function setProjectRole(doc, input, ctx) {
  const access = memberChangeAccess(doc, input);
  if (!access.ok) return access;
  if (isOwnerRecovery(access, input)) return ownerRecovery(access, ctx);
  const found = authorizeAdminChange(doc, access, input);
  if (!found.ok) return found;
  const { target, entry } = found;
  const { actor, project } = access;
  const badRole = checkRole(target, input.role);
  if (badRole) return badRole;
  const previous = entry.role;
  const result = { project_id: project.project_id, member_id: target.member_id, role: input.role };
  if (previous === input.role) return { ok: true, noop: true, result: { ...result, changed: false } };
  if (previous === 'admin' && adminCount(project) === 1) return refuse('conflict', 'team_project_last_admin');
  entry.role = input.role;
  return {
    ok: true,
    audit: [projectAudit('project_role_changed', actor, project, {
      subject_member_id: target.member_id, detail: `from=${previous},to=${input.role}`,
    })],
    projectEvent: changeEvent('members', project, [target.member_id], ctx.now),
    result: { ...result, changed: true },
  };
}

function removeProjectMember(doc, input, ctx) {
  const access = memberChangeAccess(doc, input);
  if (!access.ok) return access;
  const found = authorizeAdminChange(doc, access, input);
  if (!found.ok) return found;
  const { target, entry } = found;
  const { actor, project } = access;
  if (entry.role === 'admin' && adminCount(project) === 1) return refuse('conflict', 'team_project_last_admin');
  project.members = project.members.filter((item) => item !== entry);
  return {
    ok: true,
    audit: [projectAudit('project_member_removed', actor, project, {
      subject_member_id: target.member_id, detail: `role=${entry.role}`,
    })],
    projectEvent: changeEvent('members', project, [target.member_id], ctx.now),
    result: { project_id: project.project_id, member_id: target.member_id },
  };
}

// ------------------------------------------------------------------ delete

// A project admin or the team owner (E22).
function deleteAccess(doc, input) {
  const access = projectAccess(doc, input);
  if (!access.ok) return access;
  if (access.role !== 'admin' && !access.isOwner) return refuse('forbidden', 'role_forbidden');
  return access;
}

// The audit detail of a delete: `{ ok: true, detail }` with the conversation and
// file counts when given, or `{ ok: false }` for counts that are not two
// non-negative integers.
function countDetail(counts) {
  if (counts === undefined) return { ok: true, detail: null };
  const valid = (value) => Number.isSafeInteger(value) && value >= 0;
  if (!counts || !valid(counts.conversations) || !valid(counts.files)) return { ok: false };
  return { ok: true, detail: `conversations=${counts.conversations},files=${counts.files}` };
}

// Step 1 of a delete (spec "Delete"): the row turns `deleting`, every member
// mutation in it is refused, and only the owner and its admins still see it.
function markProjectDeleting(doc, input, ctx) {
  const access = deleteAccess(doc, input);
  if (!access.ok) return access;
  const { actor, project } = access;
  if (project.state !== 'active') return refuse('forbidden', 'team_project_deleting');
  const counted = countDetail(input.counts);
  if (!counted.ok) return refuse('invalid', 'team_project_counts_invalid');
  project.state = 'deleting';
  return {
    ok: true,
    audit: [projectAudit('project_deleting', actor, project, { detail: counted.detail })],
    projectEvent: changeEvent('deleting', project, project.members.map((entry) => entry.member_id), ctx.now),
    result: { project_id: project.project_id },
  };
}

// The last step of a delete: the row goes. Only a `deleting` row is removed.
function deleteProject(doc, input, ctx) {
  const access = deleteAccess(doc, input);
  if (!access.ok) return access;
  const { actor, project } = access;
  if (project.state !== 'deleting') return refuse('conflict', 'team_project_state_invalid');
  doc.projects = doc.projects.filter((entry) => entry !== project);
  return {
    ok: true,
    audit: [projectAudit('project_deleted', actor, project, { detail: `members=${project.members.length}` })],
    projectEvent: changeEvent('deleted', project, project.members.map((entry) => entry.member_id), ctx.now),
    result: { project_id: project.project_id },
  };
}

// ---------------------------------------------------------------- cascades

// A revoked or departed member leaves every project. Returns how many projects
// they left and how many active projects that left with no admin.
function leaveAllProjects(doc, memberId) {
  let left = 0;
  let adminless = 0;
  for (const project of doc.projects) {
    const entry = memberEntry(project, memberId);
    if (!entry) continue;
    project.members = project.members.filter((item) => item !== entry);
    left += 1;
    if (isAdminless(project)) adminless += 1;
  }
  return { projects: left, adminless };
}

// A member set to read-only becomes a reader everywhere (P4).
function capToReader(doc, memberId) {
  let capped = 0;
  let adminless = 0;
  for (const project of doc.projects) {
    const entry = memberEntry(project, memberId);
    if (!entry || entry.role === 'reader') continue;
    entry.role = 'reader';
    capped += 1;
    if (isAdminless(project)) adminless += 1;
  }
  return { projects: capped, adminless };
}

// The bounded note a cascade adds to its team change's audit detail.
function cascadeDetail(base, cascade) {
  if (cascade.projects === 0) return base;
  const note = `projects=${cascade.projects}${cascade.adminless > 0 ? `,adminless=${cascade.adminless}` : ''}`;
  return base ? `${base},${note}` : note;
}

module.exports = {
  createProject,
  addProjectMember,
  setProjectRole,
  removeProjectMember,
  markProjectDeleting,
  deleteProject,
  leaveAllProjects,
  capToReader,
  cascadeDetail,
};
