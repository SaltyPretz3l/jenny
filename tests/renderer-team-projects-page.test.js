'use strict';

// new-test-file: a shared project's page in the Team tab (row 123 slice 3-10, picks_3-10.md "Project page" and "Always
// allowed" with the brief's source corrections): every section by role, rename, members with the last-admin refusal,
// upload and download from the transfer push, delete with its confirm and the busy refusal, files_supported false,
// the stuck delete, the rules section with its forms at their bounds, and the activity sentences; typed fields kept
// and the scroll kept across pushes, every upload refusal's sentence. A new surface.

const test = require('node:test');
const assert = require('node:assert/strict');

const { P1, P2, P3, S1, S2, OTHER, DOT, MAYA, LENA, project, listAnswer, rule, request, rulesAnswer, members, openProjects, projectRow, pageSection, region, flush, memberTeam } = require('./helpers/team-project-renderer-host');
const words = require('../renderer/shell/renderer-settings-team-strings');

const sections = (h) => [...region(h).querySelectorAll('[data-team-project-section]')].map((el) => el.dataset.teamProjectSection);
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const act = (h, action, extra = '') => region(h).querySelector(`[data-project-action="${action}"]${extra}`);
async function openPage(id, options = {}) {
  const opened = await openProjects(options);
  projectRow(opened.h, id).click();
  await flush();
  return opened;
}
function type(h, el, value) { el.value = value; el.dispatchEvent(new h.window.Event('input', { bubbles: true })); }
function choose(h, el, value) { el.value = value; el.dispatchEvent(new h.window.Event('change', { bubbles: true })); }
const MB = 1024 * 1024;

test('a writer\'s page: the header, the lede, Files, Members read-only, Always allowed with the ask sentence; no activity, no delete', async (t) => {
  const { h } = await openPage(P1);
  t.after(h.restore);
  assert.equal(h.view.q('.team-head__name').textContent, 'jenny-site');
  assert.equal(h.view.q('.team-head__sub').textContent, 'Shared project · 3 members · you are a writer');
  assert.equal(region(h).querySelector('[data-project-action="rename"]'), null, 'only an admin renames');
  assert.match(text(region(h)), /Everyone in this project sees its conversations, its channel and its files/);
  assert.deepEqual(sections(h), ['files', 'members', 'rules']);
  assert.match(text(pageSection(h, 'files')), /Files are kept on the team’s host, up to 2 GB a project\./);
  assert.ok(act(h, 'upload') && act(h, 'download'));
  assert.doesNotMatch(text(pageSection(h, 'files')), /files ·/, 'no file count or size without a download');
  assert.equal(region(h).querySelector('select[data-project-input="member-role"]'), null, 'roles are text for a writer');
  assert.equal(act(h, 'member-add'), null);
  assert.ok(act(h, 'leave'));
  assert.match(text(pageSection(h, 'rules')), /Project admins set these; you can ask for one from an approval\./);
  assert.match(text(pageSection(h, 'rules')), /edit_file\s*in docs only · set by Maya/);
  assert.equal(act(h, 'rule-remove'), null);
  for (const button of region(h).querySelectorAll('button')) assert.ok(button.getAttribute('title'), button.outerHTML.slice(0, 90));
});

test('an admin\'s page: rename, role selects (a read-only member capped), Add someone, Remove, Activity and Delete', async (t) => {
  const { h } = await openPage(P2);
  t.after(h.restore);
  assert.deepEqual(sections(h), ['files', 'members', 'rules', 'activity', 'delete']);
  const lena = region(h).querySelector(`select[data-member-id="${LENA}"]`);
  assert.equal(lena.disabled, true, 'a read-only member stays a reader');
  assert.match(text(pageSection(h, 'members')), /read-only in the team, so Reader here/);
  assert.equal(region(h).querySelector(`select[data-member-id="${DOT}"]`), null, 'no select on your own row');
  choose(h, region(h).querySelector(`select[data-member-id="${MAYA}"]`), 'reader');
  await flush();
  assert.deepEqual(h.sent('projectSetMember').map((c) => c.payload), [{ team_id: OTHER, project_id: P2, member_id: MAYA, role: 'reader' }]);
  act(h, 'member-remove', `[data-member-id="${MAYA}"]`).click();
  await flush();
  assert.equal(h.sent('projectRemoveMember').length, 0, 'Remove asks first');
  act(h, 'member-remove-go').click();
  await flush();
  assert.deepEqual(h.sent('projectRemoveMember').map((c) => c.payload), [{ team_id: OTHER, project_id: P2, member_id: MAYA }]);
  act(h, 'rename').click();
  const field = region(h).querySelector('#teamProjectRename');
  assert.equal(h.window.document.activeElement, field);
  type(h, field, 'palette-tools 2');
  act(h, 'rename-save').click();
  await flush();
  assert.deepEqual(h.sent('projectRename').map((c) => c.payload), [{ team_id: OTHER, project_id: P2, name: 'palette-tools 2' }]);
});

test('H21.1: Remove and Leave this project ask first with an inline confirm; Cancel and Escape put the focus back on the control and send nothing', async (t) => {
  const { h } = await openPage(P2, { answers: { projectLeave: { ok: true } } });
  t.after(h.restore);
  const doc = h.window.document;
  const confirmIn = () => pageSection(h, 'members').querySelector('.team-set-confirm');
  assert.equal(confirmIn(), null, 'no confirm at rest');
  const remove = act(h, 'member-remove', `[data-member-id="${MAYA}"]`);
  remove.click();
  assert.equal(h.sent('projectRemoveMember').length, 0, 'asking sends nothing');
  assert.match(text(confirmIn()), /Remove Maya from palette-tools\? .*no longer see/, 'the confirm names the person and the project');
  assert.equal(doc.activeElement, act(h, 'member-cancel'), 'the focus goes to the confirm’s Cancel');
  act(h, 'member-cancel').click();
  assert.equal(confirmIn(), null, 'Cancel closes it');
  assert.equal(doc.activeElement, act(h, 'member-remove', `[data-member-id="${MAYA}"]`), 'and the focus returns to Remove');
  act(h, 'member-remove', `[data-member-id="${MAYA}"]`).click();
  act(h, 'member-cancel').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(confirmIn(), null, 'Escape closes it');
  act(h, 'leave').click();
  assert.equal(h.sent('projectLeave').length, 0, 'Leave asks first');
  assert.match(text(confirmIn()), /Leave palette-tools\?/);
  act(h, 'leave-cancel').click();
  assert.equal(confirmIn(), null);
  assert.equal(doc.activeElement, act(h, 'leave'), 'the focus returns to Leave this project');
  assert.equal(h.sent('projectRemoveMember').length + h.sent('projectLeave').length, 0, 'nothing was sent');
  act(h, 'leave').click();
  act(h, 'leave-go').click();
  await flush();
  assert.equal(h.sent('projectLeave').length, 1, 'Leave goes once confirmed');
});

test('Add someone offers the team members not in the project; Leave as the last admin shows the refusal', async (t) => {
  // Two admins are listed here, so Leave is offered (C20 greys it for the only admin); the host still refuses a race.
  const { h } = await openPage(P2, { answers: { projectMembers: members([[DOT, 'admin'], [MAYA, 'admin']]), projectLeave: { ok: false, error: { reason: 'team_project_last_admin' } } } });
  t.after(h.restore);
  const who = region(h).querySelector('#teamProjectAddWho');
  assert.deepEqual([...who.options].map((o) => o.textContent).sort(), ['Lena', 'Olive Owner']);
  choose(h, who, LENA);
  const roleSelect = region(h).querySelector('#teamProjectAddRole');
  assert.deepEqual([roleSelect.value, roleSelect.disabled], ['reader', true], 'a read-only member joins as a reader, never a writer');
  act(h, 'member-add').click();
  await flush();
  assert.deepEqual(h.sent('projectAddMember').map((c) => c.payload), [{ team_id: OTHER, project_id: P2, member_id: LENA, role: 'reader' }]);
  act(h, 'leave').click();
  act(h, 'leave-go').click();
  await flush();
  assert.match(text(pageSection(h, 'members')), /A project always has an admin\. Make someone else an admin first\./);
  assert.ok(region(h), 'the page stays');
});

test('upload: progress from the push, Cancel names the team only, a refusal\'s sentence, a failure, done', async (t) => {
  const { h, push } = await openPage(P1, { answers: { uploadFolder: { ok: false, error: { reason: 'team_upload_size_limit' } } } });
  t.after(h.restore);
  act(h, 'upload').click();
  await flush();
  assert.deepEqual(h.sent('uploadFolder').map((c) => c.payload), [{ team_id: OTHER, project_id: P1 }]);
  assert.match(text(pageSection(h, 'files')), /One upload can be at most 512 MB/);
  push({ kind: 'transfer', direction: 'upload', project_id: P1, state: 'running', folder: 'brand-assets', files_total: 1032, files_done: 1031, bytes_total: 120 * MB, bytes_done: 119 * MB });
  assert.equal(pageSection(h, 'files').querySelector('.inv-progress--warning, .inv-progress--danger'), null, 'neutral near the end');
  assert.ok(pageSection(h, 'files').querySelector('[role="progressbar"]'));
  push({ kind: 'transfer', direction: 'upload', project_id: P1, state: 'running', folder: 'brand-assets', files_total: 1032, files_done: 214, bytes_total: 120 * MB, bytes_done: 38 * MB });
  assert.match(text(pageSection(h, 'files')), /Uploading brand-assets · 214 of 1,032 files · 38 of 120 MB/);
  assert.match(text(pageSection(h, 'files')), /It arrives as a new folder, brand-assets, once every file has been checked\./);
  assert.equal(act(h, 'upload').disabled, true, 'one transfer at a time');
  act(h, 'upload-cancel').click();
  await flush();
  assert.deepEqual(h.sent('uploadCancel').map((c) => c.payload), [{ team_id: OTHER }]);
  push({ kind: 'transfer', direction: 'upload', project_id: P1, state: 'failed', reason: 'team_upload_hash_mismatch', folder: 'brand-assets' });
  assert.match(text(pageSection(h, 'files')), /A file arrived different from what was sent/);
  push({ kind: 'transfer', direction: 'upload', project_id: P1, state: 'running', folder: 'brand-assets', files_total: 1032, files_done: 1032, bytes_total: 118 * MB, bytes_done: 118 * MB });
  // The real `done` push names no folder (services/team/transfer-upload.js): the running pushes did.
  push({ kind: 'transfer', direction: 'upload', project_id: P1, state: 'done', files: 1032, bytes: 118 * MB });
  assert.match(text(pageSection(h, 'files')), /Uploaded brand-assets \(1,032 files, 118 MB\)\./);
  assert.equal(act(h, 'upload').disabled, false);
});

test('download done with skipped links; a transfer of another project greys the buttons and says why', async (t) => {
  const { h, push } = await openPage(P1);
  t.after(h.restore);
  push({ kind: 'transfer', direction: 'download', project_id: P2, state: 'running', files_total: 3, files_done: 1, bytes_total: 10, bytes_done: 2 });
  assert.equal(act(h, 'download').disabled, true);
  assert.equal(act(h, 'download').getAttribute('title'), 'Another upload or download for this team is still running.');
  push({ kind: 'transfer', direction: 'download', project_id: P1, state: 'done', files: 1032, bytes: 118 * MB, skipped: 3, path: 'D:\\Copies\\jenny-site' });
  assert.match(text(pageSection(h, 'files')), /Saved a copy of jenny-site to D:\\Copies\\jenny-site \(1,032 files, 118 MB\)\. 3 links were skipped\./);
});

test('delete: the confirm with the count, the call, and the busy refusal naming the running conversation', async (t) => {
  const { h, push } = await openPage(P2, { answers: { projectDelete: { ok: false, error: { reason: 'team_project_busy' } } },
    list: listAnswer({ projects: [project(P2, 'palette-tools', 'admin')], conversations: [{ session_id: S1, project_id: P2, title: 'Contrast checker' }, { session_id: S2, project_id: P2, title: 'Other' }] }) });
  t.after(h.restore);
  act(h, 'delete').click();
  assert.match(text(pageSection(h, 'delete')), /Delete palette-tools\? Its 2 conversations are deleted and its channel is archived for everyone\./);
  push({ kind: 'activity', session_id: S1, running: true, approvals: 0 });
  act(h, 'delete-go').click();
  await flush();
  assert.deepEqual(h.sent('projectDelete').map((c) => c.payload), [{ team_id: OTHER, project_id: P2 }]);
  assert.match(text(pageSection(h, 'delete')), /palette-tools cannot be deleted while a turn is running or an approval is waiting in it \(“Contrast checker” is running\)\. Try again when they have finished\./);
});

test('files_supported false: the sentence, no upload or download; a refusal that says deleting marks the page and the row', async (t) => {
  const { h } = await openPage(P2, { list: listAnswer({ files_supported: false }), answers: { projectRename: { ok: false, error: { reason: 'team_project_deleting' } } } });
  t.after(h.restore);
  assert.match(text(pageSection(h, 'files')), /This team’s host cannot give Jenny confined access to files yet, so Jenny can talk in this project but cannot read, change, upload or download its files\. Conversations and the channel work\./);
  assert.equal(act(h, 'upload'), null);
  assert.equal(act(h, 'download'), null);
  // Row 175 round 2 (D13): Browse files stays, greyed, with the same sentence as its reason.
  assert.equal(act(h, 'browse-files').disabled, true);
  assert.match(act(h, 'browse-files').getAttribute('title'), /^This team’s host cannot give Jenny confined access to files yet/);
  act(h, 'rename').click();
  act(h, 'rename-save').click();
  await flush();
  assert.match(text(region(h)), /This project is being deleted\. Nothing in it can change; the delete finishes when the team’s host next starts\./);
  assert.match(projectRow(h, P2).getAttribute('aria-label'), /being deleted/);
  assert.equal(act(h, 'rename'), null, 'nothing to rename while it is being deleted');
});

test('always allowed, admin: a waiting request with Allow, Change and Decline (bounds at the edge and one past), Add a rule, Remove', async (t) => {
  const { h, push } = await openPage(P2, { answers: { projectRules: (p) => rulesAnswer({ project_id: p.project_id, open_request_count: 1, requests: [request()] }) } });
  t.after(h.restore);
  const rules = () => pageSection(h, 'rules');
  assert.match(text(rules()), /Lena asks\s*always allow edit_file · from “Blog post draft” ·/);
  assert.doesNotMatch(text(rules()), /Project admins set these/);
  act(h, 'rule-allow').click();
  await flush();
  act(h, 'rule-change').click();
  choose(h, region(h).querySelector('#teamRuleWhere'), 'folder');
  type(h, region(h).querySelector('#teamRuleFolder'), 'p'.repeat(256));
  act(h, 'rule-change-go').click();
  await flush();
  assert.match(text(rules()), /Use a folder inside the project, like posts\/drafts, with no hidden folder or “\.\.”\./);
  for (const bad of ['../up', '.git/hooks', '/abs', 'a\\b', 'posts/', 'a/b/c/d/e/f/g/h/i', 'po\u202ests']) {
    type(h, region(h).querySelector('#teamRuleFolder'), bad);
    act(h, 'rule-change-go').click();
    await flush();
    assert.match(text(rules()), /Use a folder inside the project/, bad);
  }
  type(h, region(h).querySelector('#teamRuleFolder'), 'p'.repeat(255));
  choose(h, region(h).querySelector('#teamRuleTool'), 'write_file');
  act(h, 'rule-change-go').click();
  await flush();
  act(h, 'rule-decline').click();
  assert.match(text(rules()), /Tell Lena why\. They see this in the conversation where they asked\./);
  type(h, region(h).querySelector('#teamRuleReason'), 'r'.repeat(201));
  act(h, 'rule-decline-go').click();
  await flush();
  assert.match(text(rules()), /Write a reason of 1 to 200 characters\./);
  type(h, region(h).querySelector('#teamRuleReason'), 'zero\u200bwidth');
  act(h, 'rule-decline-go').click();
  await flush();
  assert.match(text(rules()), /Write a reason of 1 to 200 characters\./, 'a hidden character');
  type(h, region(h).querySelector('#teamRuleReason'), 'r'.repeat(200));
  act(h, 'rule-decline-go').click();
  await flush();
  assert.deepEqual(h.sent('projectRuleAnswer').map((c) => c.payload), [
    { team_id: OTHER, project_id: P2, request_seq: 4, outcome: 'allow' },
    { team_id: OTHER, project_id: P2, request_seq: 4, outcome: 'change', tool_name: 'write_file', folder: 'p'.repeat(255) },
    { team_id: OTHER, project_id: P2, request_seq: 4, outcome: 'decline', reason: 'r'.repeat(200) },
  ]);
  act(h, 'rule-add').click();
  act(h, 'rule-add-go').click();
  await flush();
  act(h, 'rule-remove', '[data-rule-seq="1"]').click();
  await flush();
  assert.deepEqual(h.sent('projectRuleAdd').map((c) => c.payload), [{ team_id: OTHER, project_id: P2, tool_name: 'edit_file', folder: null }]);
  assert.deepEqual(h.sent('projectRuleRemove').map((c) => c.payload), [{ team_id: OTHER, project_id: P2, rule_seq: 1 }]);
  const reads = h.sent('projectRules').length;
  push({ kind: 'rules_changed', project_id: P2, revision: 9 });
  await flush();
  assert.equal(h.sent('projectRules').length, reads + 1, 'the push reads the list again');
  push({ kind: 'rules_changed', project_id: P1, revision: 9 });
  await flush();
  assert.equal(h.sent('projectRules').length, reads + 1, 'another project\'s push reads nothing here');
});

test('a losing answer to a request shows its sentence and leaves the request answerable', async (t) => {
  const { h } = await openPage(P2, { answers: { projectRules: rulesAnswer({ project_id: P2, requests: [request()] }), projectRuleAnswer: { ok: false, error: { reason: 'team_rule_request_not_found' } } } });
  t.after(h.restore);
  act(h, 'rule-allow').click();
  await flush();
  assert.equal(act(h, 'rule-allow').disabled, false);
  assert.match(text(pageSection(h, 'rules')), /That request is no longer waiting\./);
});

test('activity: one sentence per kind, newest first, 20 then Show all; the newest page is one call, older pages follow it', async (t) => {
  const entry = (seq, kind, over = {}) => ({ seq, at: Date.UTC(2026, 10, 12, 9, 0) + seq * 60_000, kind, project_id: P2, session_id: null, actor_member_id: MAYA, prompter_member_id: null,
    tool_name: null, decision: null, detail: null, ...over });
  const KINDS = [
    [entry(1, 'approval_decided', { session_id: S1, prompter_member_id: LENA, tool_name: 'edit_file', decision: 'approved' }), 'Maya allowed Lena’s turn to use edit_file in “Palette loader cleanup”'],
    [entry(2, 'approval_expired', { session_id: S2, actor_member_id: null, prompter_member_id: LENA, tool_name: 'edit_file' }), 'An approval in “Blog post draft” expired with nobody to answer'],
    [entry(3, 'files_uploaded', { detail: { files: 1032, bytes: 118 * MB, skipped: 0 } }), 'Maya uploaded 1,032 files (118 MB)'],
    [entry(4, 'files_copied_in', { actor_member_id: null, detail: { files: 2, bytes: 2048 } }), 'The host’s owner copied in 2 files (2 KB) on the host'],
    [entry(5, 'rule_requested', { session_id: S2, tool_name: 'edit_file', detail: { request_seq: 4 } }), 'Maya asked the admins to always allow edit_file, from “Blog post draft”'],
    [entry(6, 'rule_request_declined', { tool_name: 'edit_file', detail: { request_seq: 4 } }), 'Maya said no to always allowing edit_file'],
  ];
  const all = Array.from({ length: 250 }, (_v, i) => entry(i + 1, 'rule_added', { tool_name: 'write_file', detail: { rule_seq: i + 1 } }));
  for (const [e] of KINDS) all[e.seq - 1] = e;
  // The host reads backwards: the newest page below before_seq, oldest first; next_cursor is the page's oldest seq (null: none older).
  const audit = (p) => { const below = all.filter((e) => e.seq < p.before_seq); const found = below.slice(-(p.limit || 100)); return { ok: true, entries: found, floor_seq: 1, next_cursor: below.length > found.length ? found[0].seq : null }; };
  const { h } = await openPage(P2, { answers: { projectAudit: audit } });
  t.after(h.restore);
  await flush();
  const lines = () => [...pageSection(h, 'activity').querySelectorAll('li span')].map((el) => el.textContent);
  assert.equal(lines().length, 20);
  assert.equal(lines()[0], 'Maya always allowed write_file in this project', 'the newest (250) first');
  assert.equal(h.sent('projectAudit').length, 1, 'the newest page is one call');
  assert.deepEqual(h.sent('projectAudit')[0].payload.before_seq, Number.MAX_SAFE_INTEGER);
  assert.equal(h.sent('projectAudit')[0].payload.after_seq, undefined);
  act(h, 'activity-more').click();
  for (let i = 0; i < 12; i += 1) await flush();
  assert.equal(lines().length, 100, 'everything read');
  assert.equal(h.sent('projectAudit').length, 1, 'Show all activity shows what is held: no call');
  act(h, 'activity-more').click();
  await flush();
  assert.deepEqual(h.sent('projectAudit').slice(1).map((c) => c.payload.before_seq), [151], 'the page before the oldest held');
  act(h, 'activity-more').click();
  await flush();
  const shown = lines();
  for (const [, sentence] of KINDS) assert.ok(shown.includes(sentence), sentence);
  for (const call of h.sent('projectAudit')) assert.ok(call.payload.limit >= 1 && call.payload.limit <= 100);
});

test('Show earlier activity lists each entry once, whatever overlap a host sends', async () => {
  const { createActivity } = require('../renderer/team/renderer-team-project-activity');
  const saved = globalThis.inventory;
  globalThis.inventory = { actionButton: require('../renderer/inventory/action-button') };
  try {
    const entry = (seq) => ({ seq, at: seq, kind: 'rule_added', project_id: P2, session_id: null, actor_member_id: MAYA, prompter_member_id: null, tool_name: 'write_file', decision: null, detail: { rule_seq: seq } });
    const all = Array.from({ length: 250 }, (_v, i) => entry(i + 1));
    // From the second click on, the host repeats the first and the last entry of every page it answers, and the
    // entry at before_seq itself.
    let overlap = false;
    const call = async (_method, p) => {
      const below = all.filter((e) => e.seq < p.before_seq);
      const found = below.slice(-(p.limit || 100));
      const repeated = found.concat(found.slice(0, 1), found.slice(-1), all.filter((e) => e.seq === p.before_seq));
      return { ok: true, entries: overlap ? repeated : found, floor_seq: 1, next_cursor: below.length > found.length ? found[0].seq : null };
    };
    const view = createActivity({ teamId: OTHER, projectId: P2, call, nameOf: () => 'Maya', conversationTitle: () => '', timeText: () => '', errorText: () => '', onChange() {} });
    const lines = () => [...view.html().matchAll(/<li>/g)].length;
    const settle = async () => { for (let i = 0; i < 4; i += 1) await flush(); };
    await settle();
    view.onClick({ dataset: { projectAction: 'activity-more' } });
    await settle();
    overlap = true;
    view.onClick({ dataset: { projectAction: 'activity-more' } });
    await settle();
    view.onClick({ dataset: { projectAction: 'activity-more' } });
    await settle();
    assert.equal(lines(), 250, 'one line for each of the 250 entries, none twice');
  } finally {
    if (saved === undefined) delete globalThis.inventory; else globalThis.inventory = saved;
  }
});

test('fix list M3: ten transfer pushes and a rules refresh keep the scroll and write the Files section only', async (t) => {
  const { h, push } = await openPage(P2);
  t.after(h.restore);
  await flush();
  const scroller = region(h).querySelector('.team-page');
  // The harness layout scrolls only .team-scroll; give the page scroller its own offset so a rebuilt
  // node, or one written back to the top, reads 0.
  let top = 0;
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (value) => { top = Number(value) || 0; } });
  scroller.scrollTop = 420;
  const written = new Set();
  const observer = new h.window.MutationObserver((list) => { for (const m of list) written.add((m.target.closest ? m.target : m.target.parentElement).closest('[data-page-part]')?.dataset.pagePart || 'frame'); });
  observer.observe(region(h), { childList: true, subtree: true, characterData: true });
  for (let i = 1; i <= 10; i += 1) push({ kind: 'transfer', direction: 'upload', project_id: P2, state: 'running', folder: 'art', files_total: 10, files_done: i, bytes_total: 10 * MB, bytes_done: i * MB });
  push({ kind: 'rules_changed', project_id: P2, revision: 4 });
  for (let i = 0; i < 4; i += 1) await flush();
  observer.disconnect();
  assert.equal(region(h).querySelector('.team-page'), scroller, 'the scroller is the same node');
  assert.equal(scroller.scrollTop, 420);
  assert.deepEqual([...written], ['files']);
});

test('fix list M2: the rename field and the rule form keep their node and value through same-team pushes', async (t) => {
  const { h, push } = await openPage(P2);
  t.after(h.restore);
  act(h, 'rename').click();
  const rename = region(h).querySelector('#teamProjectRename');
  type(h, rename, 'palette-tools v2');
  rename.setSelectionRange(3, 7);
  push({ kind: 'projects', ...listAnswer({ projects: [project(P1, 'jenny-site', 'writer'), project(P2, 'palette-tools', 'admin', { root_revision: 2 })] }) });
  push({ kind: 'transfer', direction: 'download', project_id: P1, state: 'running', files_total: 3, files_done: 1, bytes_total: 10, bytes_done: 2 });
  await flush();
  assert.equal(region(h).querySelector('#teamProjectRename'), rename, 'the same node');
  assert.equal(rename.value, 'palette-tools v2');
  assert.deepEqual([rename.selectionStart, rename.selectionEnd], [3, 7]);
  act(h, 'rename-cancel').click();
  act(h, 'rule-add').focus();
  act(h, 'rule-add').click();
  assert.equal(h.window.document.activeElement, region(h).querySelector('#teamRuleTool'), 'the form\'s first field has the focus');
  choose(h, region(h).querySelector('#teamRuleWhere'), 'folder');
  const folder = region(h).querySelector('#teamRuleFolder');
  type(h, folder, 'posts/dra');
  push({ kind: 'rules_changed', project_id: P2, revision: 5 });
  push({ kind: 'projects', ...listAnswer() });
  for (let i = 0; i < 3; i += 1) await flush();
  assert.equal(region(h).querySelector('#teamRuleFolder'), folder);
  assert.equal(folder.value, 'posts/dra');
});

test('a projects push that leaves this project\'s row alone reads no members; one that changes it reads them again', async (t) => {
  const { h, push } = await openPage(P2);
  t.after(h.restore);
  const reads = h.sent('projectMembers').length;
  push({ kind: 'projects', ...listAnswer() });
  await flush();
  assert.equal(h.sent('projectMembers').length, reads);
  push({ kind: 'projects', ...listAnswer({ projects: [project(P1, 'jenny-site', 'writer'), project(P2, 'palette tools', 'admin')] }) });
  await flush();
  assert.equal(h.sent('projectMembers').length, reads + 1);
});

test('every upload refusal shows its own sentence', async (t) => {
  const REASONS = ['team_upload_empty', 'team_upload_changed', 'team_upload_file_limit', 'team_upload_size_limit', 'team_upload_manifest_invalid', 'team_upload_unreadable',
    'team_upload_stale', 'team_upload_limit', 'team_upload_hash_mismatch', 'team_upload_staging_failed', 'team_upload_target_exists', 'team_transfer_busy', 'team_transfer_failed'];
  let reason = '';
  const { h } = await openPage(P1, { answers: { uploadFolder: () => ({ ok: false, error: { reason } }) } });
  t.after(h.restore);
  for (reason of REASONS) {
    act(h, 'upload').click();
    await flush();
    const sentence = words.errorText({ reason });
    assert.ok(text(pageSection(h, 'files')).includes(sentence), reason + ': ' + sentence);
  }
  assert.equal(new Set(REASONS.map((r) => words.errorText({ reason: r }))).size, REASONS.length, 'each reason its own sentence');
});

test('leave and removal close the page', async (t) => {
  const { h, push } = await openPage(P1, { answers: { projectLeave: { ok: true } } });
  t.after(h.restore);
  act(h, 'leave').click();
  act(h, 'leave-go').click();
  await flush();
  await flush();
  assert.equal(region(h), null, 'a successful leave closes the page');
  projectRow(h, P2).click();
  await flush();
  push({ kind: 'projects', ...listAnswer({ projects: [project(P1, 'jenny-site', 'writer')] }) });
  await flush();
  await flush();
  assert.equal(region(h), null, 'removed from the project: the page closes');
});

test('the owner\'s delete of a project they are not in has no count, and the header is the name only', async (t) => {
  const owner = await openProjects({ team: memberTeam({ role: 'owner' }), answers: { projectUnjoined: { ok: true, projects: [{ project_id: P3, name: 'release-notes' }], truncated: false } } });
  t.after(owner.h.restore);
  projectRow(owner.h, P3).click();
  await flush();
  assert.equal(owner.h.view.q('.team-head__sub'), null, 'the header is the name only');
  region(owner.h).querySelector('[data-project-action="delete"]').focus();
  region(owner.h).querySelector('[data-project-action="delete"]').click();
  const confirm = text(pageSection(owner.h, 'delete'));
  assert.match(confirm, /Delete release-notes\? Its conversations are deleted and its channel is archived for everyone\./);
  assert.doesNotMatch(confirm, /\d+ conversation/);
  assert.equal(owner.h.window.document.activeElement, region(owner.h).querySelector('[data-project-action="delete-cancel"]'), 'the confirm\'s Cancel has the focus');
});

// Row 175 F11 (Team side): a project's boards, listed on its page, open in the Board tab.
const BOARD_ROWS = (n) => Array.from({ length: n }, (_x, i) => ({ id: `board_${i}`, name: i === 0 ? 'Plan <b>' : `Board ${i}`, rev: 1 }));
function boardsOn(t, { flag = true, asked = true } = {}) {
  const calls = { requests: [], views: [] };
  globalThis.rendererTopNavShellController = { openBoardView: (options) => { calls.views.push(options || null); return flag; } };
  globalThis.rendererBoardTeam = { requestOpen: (request) => { calls.requests.push(request); return asked; } };
  t.after(() => { delete globalThis.rendererTopNavShellController; delete globalThis.rendererBoardTeam; });
  return calls;
}

test('the Boards line: the project\'s boards by name, each with Open, which asks the Board page and switches to it', async (t) => {
  const calls = boardsOn(t);
  const { h } = await openPage(P1, { answers: { boardList: { ok: true, boards: BOARD_ROWS(3) } } });
  t.after(h.restore);
  assert.deepEqual(h.sent('boardList').map((c) => c.payload), [{ team_id: OTHER, project_id: P1 }]);
  assert.deepEqual(sections(h).slice(0, 3), ['files', 'boards', 'members']);
  const rows = [...pageSection(h, 'boards').querySelectorAll('li')];
  assert.deepEqual(rows.map((li) => li.querySelector('.team-set-person__name').textContent), ['Plan <b>', 'Board 1', 'Board 2'], 'names are text');
  assert.equal(pageSection(h, 'boards').querySelector('.team-set-count').textContent, '3');
  const open = act(h, 'board-open', '[data-board-id="board_1"]');
  assert.deepEqual([open.textContent.trim(), open.disabled, open.title], ['Open', false, 'Open Board 1 in the Board tab']);
  open.click();
  await flush();
  assert.deepEqual(calls.requests, [{ teamId: OTHER, projectId: P1, boardId: 'board_1' }]);
  assert.deepEqual(calls.views.slice(-1), [null], 'the real switch, not the dry ask');
  assert.equal(pageSection(h, 'boards').querySelector('.team-set-note'), null);
});

test('the Boards line: nothing without boards, with the Board tab off or past 20, and a refused open says so', async (t) => {
  boardsOn(t);
  const none = await openPage(P1, { answers: { boardList: { ok: true, boards: [] } } });
  assert.equal(pageSection(none.h, 'boards'), null);
  none.h.restore();
  const failed = await openPage(P1, { answers: { boardList: { ok: false, error: { reason: 'team_unavailable' } } } });
  assert.equal(pageSection(failed.h, 'boards'), null, 'an unread list shows nothing');
  failed.h.restore();
  const many = await openPage(P1, { answers: { boardList: { ok: true, boards: BOARD_ROWS(30) } } });
  assert.equal(pageSection(many.h, 'boards').querySelectorAll('li').length, 20);
  many.h.restore();
  const off = boardsOn(t, { flag: false });
  const closed = await openPage(P1, { answers: { boardList: { ok: true, boards: BOARD_ROWS(2) } } });
  t.after(closed.h.restore);
  assert.equal(pageSection(closed.h, 'boards'), null, 'the Board flag is off');
  assert.ok(off.views.every((v) => v && v.dry === true));
  const refused = boardsOn(t, { asked: false });
  const page = await openPage(P1, { answers: { boardList: { ok: true, boards: BOARD_ROWS(2) } } });
  t.after(page.h.restore);
  act(page.h, 'board-open', '[data-board-id="board_0"]').click();
  await flush();
  assert.equal(refused.views.every((v) => v && v.dry === true), true, 'no switch after a refused request');
  assert.match(text(pageSection(page.h, 'boards')), /The Board tab could not be opened\. Try again\./);
});

test('the Boards line: while the team is offline its boards are greyed with the reason', async (t) => {
  boardsOn(t);
  const { h, push } = await openPage(P1, { answers: { boardList: { ok: true, boards: BOARD_ROWS(2) } } });
  t.after(h.restore);
  assert.equal(act(h, 'board-open', '[data-board-id="board_0"]').disabled, false, 'online: usable');
  h.store.seed({ teams: [memberTeam({ state: 'offline' })] });
  push({ kind: 'projects', ...listAnswer() });
  await flush();
  const open = act(h, 'board-open', '[data-board-id="board_0"]');
  assert.deepEqual([open.disabled, open.title], [true, 'Boards open when the team is online.']);
  assert.match(text(pageSection(h, 'boards')), /Boards open when the team is online\./);
});

test('C20: a reader\'s Upload is greyed with its reason, never hidden; Leave is greyed with its reason for the only admin and not for anyone else', async (t) => {
  const reader = await openPage(P1, { list: listAnswer({ projects: [project(P1, 'jenny-site', 'reader'), project(P2, 'palette-tools', 'admin')] }) });
  t.after(reader.h.restore);
  const upload = act(reader.h, 'upload');
  assert.deepEqual([upload.disabled, upload.title], [true, 'Only writers can upload.']);
  upload.dispatchEvent(new reader.h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(reader.h.sent('uploadFolder').length, 0);
  const only = await openPage(P2, { answers: { projectMembers: members([[DOT, 'admin'], [MAYA, 'writer']]) } });
  t.after(only.h.restore);
  const leave = act(only.h, 'leave');
  assert.deepEqual([leave.disabled, leave.title], [true, 'A project always has an admin.']);
  leave.dispatchEvent(new only.h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(pageSection(only.h, 'members').querySelector('.team-set-confirm'), null, 'no confirm opens');
  const shared = await openPage(P2, { answers: { projectMembers: members([[DOT, 'admin'], [MAYA, 'admin']]) } });
  t.after(shared.h.restore);
  assert.equal(act(shared.h, 'leave').disabled, false, 'a second admin: Leave as before');
});

test('C19: Remove takes effect at once and leaves "Rule removed." with Undo in the row\'s place; Undo sets the same rule again; the next change to the list drops it', async (t) => {
  let rules = [{ ...rule({ rule_seq: 1, tool_name: 'edit_file', folder: 'docs' }) }, { ...rule({ rule_seq: 2, tool_name: 'write_file', folder: null }) }];
  const { h, push } = await openPage(P2, { answers: { projectRules: () => rulesAnswer({ project_id: P2, rules }),
    projectRuleRemove: (p) => { rules = rules.filter((r) => r.rule_seq !== p.rule_seq); return { ok: true }; },
    projectRuleAdd: (p) => { rules = [...rules, rule({ rule_seq: 9, tool_name: p.tool_name, folder: p.folder })]; return { ok: true }; } } });
  t.after(h.restore);
  const list = () => [...pageSection(h, 'rules').querySelectorAll('.team-set-person')].map((el) => text(el));
  assert.equal(list().length, 2);
  act(h, 'rule-remove', '[data-rule-seq="1"]').click();
  await flush();
  assert.equal(h.sent('projectRuleRemove').length, 1, 'removed at once, nothing asked first');
  assert.match(list()[0], /^Rule removed\.\s?Undo$/, 'the row is replaced where it stood');
  assert.match(list()[1], /^write_file/);
  act(h, 'rule-undo').click();
  await flush();
  assert.deepEqual(h.sent('projectRuleAdd').map((c) => c.payload), [{ team_id: OTHER, project_id: P2, tool_name: 'edit_file', folder: 'docs' }], 'the same tool and folder');
  assert.equal(act(h, 'rule-undo'), null, 'Undo is spent');
  assert.equal(list().length, 2, 'the rule is back');
  act(h, 'rule-remove', '[data-rule-seq="2"]').click();
  await flush();
  assert.match(list()[0], /^Rule removed\.\s?Undo$/);
  rules = [...rules, rule({ rule_seq: 12, tool_name: 'edit_file', folder: 'posts' })];
  push({ kind: 'rules_changed', project_id: P2, revision: 12 });
  await flush();
  assert.equal(act(h, 'rule-undo'), null, 'another change to the list drops it');
});

const fold = (h, id) => region(h).querySelector(`details[data-team-fold="${id}"]`);
const summary = (h) => [...region(h).querySelectorAll('.team-set-summary a')].map((a) => `${a.querySelector('span').textContent}: ${a.querySelector('b').textContent}`).join(' | ');

test('D2: an admin\'s page opens with a summary of three facts; Always allowed, Activity and Delete are folds, closed; Files and Members stay open', async (t) => {
  const { h } = await openPage(P2);
  t.after(h.restore);
  assert.equal(summary(h), 'Members: 3 · you are an admin | Always allowed: 1 rule | Activity: Nothing yet');
  assert.deepEqual(['rules', 'activity', 'delete'].map((id) => [id, Boolean(fold(h, id)), fold(h, id) && fold(h, id).open]), [['rules', true, false], ['activity', true, false], ['delete', true, false]]);
  assert.deepEqual([...fold(h, 'rules').querySelector('summary').childNodes].map((n) => n.textContent), ['Always allowed', '1 rule'], 'the rule count sits beside the heading');
  assert.equal(pageSection(h, 'files').closest('details'), null);
  assert.equal(pageSection(h, 'members').closest('details'), null);
  const reads = ['projectRules', 'projectAudit'].map((m) => h.sent(m).length);
  region(h).querySelector('[data-project-action="summary-jump"][data-jump="rules"]').click();
  await flush();
  assert.equal(fold(h, 'rules').open, true, 'the fact opens its section');
  assert.equal(h.window.document.activeElement, fold(h, 'rules').querySelector('summary'), 'and moves the focus to its visible heading');
  assert.deepEqual(['projectRules', 'projectAudit'].map((m) => h.sent(m).length), reads, 'opening asks the host for nothing');
  assert.match(fold(h, 'rules').outerHTML, /rule-add/);
});

test('D2: a fold stays as the person left it through redraws; a confirm, an error note or an undo row opens its fold by itself', async (t) => {
  const answers = { projectDelete: { ok: false, error: { reason: 'team_project_busy' } } };
  const { h, push } = await openPage(P2, { answers });
  t.after(h.restore);
  fold(h, 'activity').open = true;
  fold(h, 'activity').dispatchEvent(new h.window.Event('toggle'));
  push({ type: 'projects' });
  await flush();
  assert.equal(fold(h, 'activity').open, true, 'opened by the person, kept across a redraw');
  assert.equal(fold(h, 'delete').open, false);
  act(h, 'delete').click();
  assert.equal(fold(h, 'delete').open, true, 'the confirm opens Delete by itself');
  act(h, 'delete-cancel').click();
  fold(h, 'delete').open = false;
  fold(h, 'delete').dispatchEvent(new h.window.Event('toggle'));
  act(h, 'delete').click();
  act(h, 'delete-go').click();
  await flush();
  assert.match(text(fold(h, 'delete')), /cannot be deleted while a turn is running/, 'the refusal note shows');
  assert.equal(fold(h, 'delete').open, true, 'the error note opens it');
  fold(h, 'rules').open = true;
  fold(h, 'rules').dispatchEvent(new h.window.Event('toggle'));
  act(h, 'rule-remove', '[data-rule-seq="1"]').click();
  await flush();
  assert.ok(act(h, 'rule-undo') && fold(h, 'rules').open, 'the undo row is in an open fold');
});

test('D2: a writer\'s page has no summary line and no fold; a waiting request opens Always allowed for the admin', async (t) => {
  const asked = await openPage(P2, { answers: { projectRules: rulesAnswer({ project_id: P2, requests: [request()] }) } });
  assert.equal(fold(asked.h, 'rules').open, true, 'a request an admin must answer is not left in a closed fold');
  asked.h.restore();
  const { h } = await openPage(P1);
  t.after(h.restore);
  assert.equal(region(h).querySelector('.team-set-summary'), null);
  assert.equal(region(h).querySelector('details'), null);
});
