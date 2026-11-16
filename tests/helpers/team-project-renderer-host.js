'use strict';

// The shared projects' renderer tests (row 123, slice 3-10): the Team tab harness (team-settings-harness.js, every
// bridge call checked against main's real `validatePayload` at teardown) with `team.onProject` as a real subscription,
// a fresh copy of the project modules, and fixtures for one team (OTHER, joined as Dot) with projects, conversations,
// members, rules and a conversation snapshot. `openProjects(options)` opens the Team tab on it and answers
// { h, push(payload), subscribers(), view }.

const { harness, layout, flush, memberTeam, overview, chatChannel, OTHER, ME, DOT, MAYA } = require('./team-settings-harness');

const P1 = 'project_aaaaaaaaaaaa';
const P2 = 'project_bbbbbbbbbbbb';
const P3 = 'project_cccccccccccc';
const S1 = 'sess_' + 'a'.repeat(32);
const S2 = 'sess_' + 'b'.repeat(32);
const S3 = 'sess_' + 'c'.repeat(32);
const LENA = 'member_lena';
const PROJECT_MODULES = ['project-store', 'project-column', 'project-rules', 'project-activity', 'project-page', 'project-box', 'project-conversation', 'project-tab', 'tab-focus']
  .map((name) => require.resolve(`../../renderer/team/renderer-team-${name}`));

const project = (id, name, role, over = {}) => ({ id, name, root_revision: 1, role, ...over });
const conversation = (session_id, project_id, title, over = {}) => ({ session_id, title, project_id, ...over });
const listAnswer = (over = {}) => ({ ok: true, projects: [project(P1, 'jenny-site', 'writer'), project(P2, 'palette-tools', 'admin')], files_supported: true, truncated: false,
  conversations: [conversation(S1, P1, 'Palette loader cleanup'), conversation(S2, P1, 'Blog post draft'), conversation(S3, P2, 'Contrast checker')], ...over });
const rule = (over = {}) => ({ rule_seq: 1, tool_name: 'edit_file', folder: 'docs', set_by: MAYA, set_at: 10, from_request_seq: null, use_count: 0, last_used_at: null, last_used_by: null, ...over });
const request = (over = {}) => ({ request_seq: 4, tool_name: 'edit_file', asker_member_id: LENA, session_id: S2, asked_at: Date.UTC(2026, 10, 12, 10, 44), state: 'open',
  answered_by: null, answered_at: null, outcome_tool: null, outcome_folder: null, reason: null, rule_seq: null, ...over });
const rulesAnswer = (over = {}) => ({ ok: true, project_id: P1, revision: 3, rules: [rule()], open_request_count: 0, requests: [], ...over });
const members = (list) => ({ ok: true, members: list.map(([member_id, role]) => ({ member_id, role })) });
const message = (id, role, content, over = {}) => ({ id, role, kind: 'message', content, status: 'complete', timestamp: '2026-11-12T10:31:00.000Z', ...over });
const approval = (over = {}) => ({ approval_id: 'appr_1', decision_revision: 'rev_1', stream_id: 'stream_1', tool_name: 'edit_file', prompter_member_id: LENA,
  call_id: 'call_1', summary: 'Write the draft into posts/team-launch.md.', policy_scope: 'Workspace files', policy_consequence: 'May change data in this scope.', reason: '', ...over });
const snapshot = (over = {}) => ({ cursor: 1, session: { session_id: S1, title: 'Palette loader cleanup', revision: 'r1', plan_mode: false },
  messages: [message('m1', 'user', 'Why twice?', { author: { kind: 'member', member_id: MAYA } }), message('m2', 'assistant', 'It reads it once in **load**.')],
  message_count: 2, has_more: false, active_turn: null, pending_approvals: [], pending_questions: [], live_projection: null, control: null, ...over });

const CHAT_PEOPLE = [{ member_id: ME, display_name: 'Olive Owner', role: 'owner', state: 'online', last_seen_at: null },
  { member_id: DOT, display_name: 'Dot', role: 'member', state: 'online', last_seen_at: null },
  { member_id: MAYA, display_name: 'Maya', role: 'member', state: 'online', last_seen_at: null },
  { member_id: LENA, display_name: 'Lena', role: 'read_only', state: 'offline', last_seen_at: null }];

async function openProjects({ team = memberTeam(), answers = {}, list = listAnswer(), show = true, chatPeople = CHAT_PEOPLE } = {}) {
  for (const path of PROJECT_MODULES) delete require.cache[path];
  const h = harness({ show: false, teams: [team], answers: {
    chatOverview: overview({ channels: [chatChannel(), chatChannel({ channel_id: 'chan_' + P1, kind: 'project' })], members: chatPeople }),
    members: () => ({ ok: true, team: { team_id: OTHER, name: 'Dot lab' }, members: chatPeople.map((m) => ({ ...m, state: 'active', devices: [] })) }),
    projectList: list, projectUnjoined: { ok: true, projects: [], truncated: false }, projectRules: rulesAnswer(),
    projectMembers: members([[DOT, 'writer'], [MAYA, 'admin'], [LENA, 'reader']]), projectAudit: { ok: true, entries: [], floor_seq: null, next_cursor: null },
    conversationOpen: { ok: true, snapshot: snapshot() },
    ...answers,
  } });
  const real = h.window.jennyShell.team;
  const subscribers = new Set();
  h.window.jennyShell.team = new Proxy({}, { get: (_target, name) => (name === 'onProject' ? (fn) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; } : real[name]) });
  layout(h, { focused: true });
  h.cleanups.push(h.chat.use());
  if (show) { h.showTab(); await flush(); }
  const push = (payload) => { for (const fn of [...subscribers]) fn({ team_id: team.team_id, ...payload }); };
  return { h, push, subscribers: () => subscribers.size, view: h.view };
}

// The column's project rows, by name; a section of the project page; the project region.
const projectRow = (h, id) => h.view.q(`[data-team-tab-action="project-open"][data-project-id="${id}"]`);
const pageSection = (h, name) => h.view.q(`[data-team-project-section="${name}"]`);
const region = (h) => h.view.q('[data-team-region="project"]');

module.exports = { P1, P2, P3, S1, S2, S3, LENA, OTHER, ME, DOT, MAYA, project, conversation, listAnswer, rule, request, rulesAnswer, members, message, approval,
  snapshot, openProjects, projectRow, pageSection, region, flush, memberTeam, CHAT_PEOPLE };
