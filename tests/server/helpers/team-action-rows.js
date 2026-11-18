'use strict';

// Shared by tests/server/team-authorize-matrix.test.js (moved here to keep it under 600 lines).

// ---- The one table (slice 3-2) ----------------------------------------------
// The spec's action rows ("Action rows" in TEAM_PROJECTS_SPEC), copied here so a
// registry change that drifts from them fails: team columns (O owner, M member,
// R read-only, P pending, I invite), the minimum effective project role (null:
// none) and the resource kind authorize() is handed.
const EXPECTED = Object.freeze({
  'runtime.read': ['OMR', 'reader', 'session'],
  'runtime.control': ['OM', 'writer', 'session'],
  'runtime.limits': ['O', null, 'session'],
  'session.list': ['OMR', 'reader', 'session'],
  'request.status': ['OMR', null, 'session'],
  'session.read': ['OMR', 'reader', 'session'],
  'session.create': ['OM', 'writer', 'project'],
  'session.write': ['OM', 'writer', 'session'],
  'session.delete': ['OM', 'admin', 'session'],
  'session.control': ['OM', 'writer', 'session'],
  'session.takeover': ['OM', 'writer', 'session'],
  // Slice 3-7: a takeover that meets a running turn (the router asks for it).
  'session.takeover_running': ['OM', 'admin', 'session'],
  'suggested.read': ['OMR', 'reader', 'session'],
  'suggested.decide': ['OM', 'writer', 'session'],
  'decision.resolve': ['OM', 'writer', 'session'],
  'project.read': ['OMR', 'reader', 'project'],
  'project.create': ['OM', null, 'project'],
  'project.write': ['OM', 'admin', 'project'],
  'project.assign': ['OM', 'writer', 'session'],
  'project.members': ['OM', 'admin', 'project'],
  'project.delete': ['OM', 'admin', 'project'],
  'project.audit.read': ['OM', 'admin', 'project'],
  'project.files.upload': ['OM', 'writer', 'project'],
  'project.files.download': ['OMR', 'reader', 'project'],
  // Row 175 wave 5: the reader view of a team project's files.
  'project.files.read': ['OMR', 'reader', 'project'],
  // Row 175 item 6, F13, F18: a project conversation's latest turn redone (its prompter, or a project admin by
  // `project.write`, asked by the router), and a branch, an ask and a handed driver seat.
  'project.redo': ['OM', 'writer', 'project'],
  'project.conversation': ['OM', 'writer', 'project'],
  'project.root': ['O', null, 'project'],
  'permission.review': ['O', null, 'project'],
  'events.subscribe': ['OMR', null, 'session'],
  'asset.upload': ['OM', null, 'session'],
  'client.register': ['OMR', null, 'team'],
  'team.hello': ['OMRPI', null, 'team'],
  'team.status': ['OMRP', null, 'team'],
  'team.join.redeem': ['I', null, 'invite'],
  'team.leave': ['MRP', null, 'team'],
  'team.members.list': ['OMR', null, 'team'],
  'team.invite.manage': ['O', null, 'team'],
  'team.device.invite': ['OMR', null, 'team'],
  'team.device.list': ['OMR', null, 'team'],
  'team.device.revoke': ['OMR', null, 'device'],
  'team.member.admin': ['O', null, 'member'],
  'team.owner.transfer': ['O', null, 'member'],
  'team.audit.read': ['O', null, 'team'],
  'team.rename': ['O', null, 'team'],
  'team.member.profile': ['OMR', null, 'team'],
  'chat.overview': ['OMR', null, 'team'],
  'chat.read': ['OMR', null, 'channel'],
  'chat.mark': ['OMR', null, 'channel'],
  'chat.write': ['OM', null, 'channel'],
  'chat.search': ['OMR', null, 'team'],
  'chat.typing': ['OM', null, 'channel'],
  // Slice 2d: opening a direct conversation.
  'chat.dm_open': ['OM', null, 'team'],
  'chat.channel.create': ['OM', null, 'team'],
  'chat.channel.manage': ['OM', null, 'channel'],
  'presence.set': ['OMR', null, 'team'],
  // Slice 4b: the team engine routes (node protocol spec N10).
  'engine.use': ['OM', null, 'team'],
  // Slice 3-4a: a shared project's member list and leave (E29), and the owner's
  // names-only list and self-add (E23, E30).
  'project.members.read': ['OMR', 'reader', 'project'],
  'project.leave': ['OMR', 'reader', 'project'],
  'project.discover': ['O', null, 'team'],
  'project.join': ['O', null, 'team'],
  // Slice 4c host: sharing a GPU as a node, and the node list (node protocol spec N6, N12).
  'node.share': ['OM', null, 'team'],
  'node.list': ['OMR', null, 'team'],
  // Slice 4e: the owner's GPU use read and the team model setting.
  'pool.usage.read': ['O', null, 'team'],
  'pool.model.set': ['O', null, 'team'],
  // Slice 3-12: a project's "Always allowed" rules: read by anyone with a row, changed by its admins.
  'project.rules.read': ['OMR', 'reader', 'project'],
  'project.rules': ['OM', 'admin', 'project'],
  // Row 151 slice T2: a team project's boards. Read by anyone with a row, changed by writers; the trash, a delete
  // and a restore by the project's admins. No owner-any.
  'board.read': ['OMR', 'reader', 'project'],
  // Slices T4 and T5: who is viewing and where their cursor is, sent by a reader too; it changes no board.
  'board.presence': ['OMR', 'reader', 'project'],
  'board.write': ['OM', 'writer', 'project'],
  'board.admin': ['OM', 'admin', 'project'],
  // Slice 6-3: model sharing (TEAM_MODEL_SHARING_SPEC "Host operations", E55): owner and full members only.
  'model.offer': ['OM', null, 'team'],
  'model.read': ['OM', null, 'team'],
  'model.receive': ['OM', null, 'team'],
  'model.transfer': ['OM', null, 'team'],
});

// Rows the active owner may use on an active project they hold no row in (spec row "owner any
// (Q1)", slice 3-4b): exactly these.
const OWNER_ANY = Object.freeze(['project.delete']);
// Rows the active owner passes on a conversation they can see, in an active project (slice 3-7).
const OWNER_SEEN = Object.freeze(['session.takeover_running']);
// Rows that exist only in an active project of the team (row 151 review): General, a project with no team row and a
// project being deleted are not found for everyone, the owner included.
const TEAM_PROJECT_ONLY = Object.freeze(['board.read', 'board.presence', 'board.write', 'board.admin',
  'project.files.read', 'project.redo', 'project.conversation']);

module.exports = { EXPECTED, OWNER_ANY, OWNER_SEEN, TEAM_PROJECT_ONLY };
