'use strict';

// Settings > Team, the whole team's lifecycle (row 123, slice 5-6; picks_5-6.md acceptance 5 and 9 to 14): the
// lost-key page (Cannot start, Start a new team, Restore from a backup), Delete this team with "Counting…" and the
// inventory, the typed name, a delete that stopped part way, the page after a delete, a member's deleted row,
// export and restore, old teams, and who sees Delete and Export. Through the real page, store and inventory
// modules over a stubbed bridge; main's answers are stubs (the host tests cover main).

const test = require('node:test');
const assert = require('node:assert/strict');
const { OTHER, flush, snapshot, memberTeam, hostState, NONE, harness } = require('./helpers/team-settings-harness');

const PASSWORD = 'a long backup password';
const OLD_ID = '20261112093000000';
const host = (over = {}) => hostState({ key: 'ok', direct_port: 51820, internet: null, reach: null, old_teams: [], ...over });
const INVENTORY = Object.freeze({ team_name: 'Studio', members: [{ name: 'Olive Owner', owner: true }, { name: 'Dot', owner: false }], pending: 1, invites: 1,
  chat: { team: true, project_channels: 2, messages: 1284, attachments: 0, dms: 1, dm_messages: 312 },
  projects: [{ project_id: 'project_site', name: 'jenny-site', files: 212, bytes: 48_000_000, conversations: 3 },
    { project_id: 'project_tax', name: 'tax-2026', files: 18, bytes: 6_000_000, conversations: 1 }],
  trash: [{ days_ago: 4, bytes: 9_000_000 }], busy: [{ project: 'jenny-site', conversation: 'Palette loader cleanup' }], uncounted: [] });
// Every text node joined with a space (adjacent elements have none between them), whitespace collapsed.
function text(el) {
  if (!el) return '';
  const walker = el.ownerDocument.createTreeWalker(el, 4);
  const parts = [];
  while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
const del = (h) => h.q('[data-team-group="delete"]');

function owner(t, hostOver = {}, answers = {}) {
  const h = harness({ host: host(hostOver), teams: [snapshot()], answers });
  t.after(h.restore);
  return h;
}

test('delete: the confirmation opens at once with Counting…, then lists what goes; the button waits for the exact name', async (t) => {
  let release;
  const h = owner(t, {}, { hostInventory: () => new Promise((resolve) => { release = resolve; }), hostDelete: { ok: true, host: { ...NONE } } });
  await flush();
  assert.equal(h.headings().at(-1), 'Delete', 'Delete is the last group');
  assert.match(text(del(h)), /Delete this team Deletes Studio for everyone: its members, messages, shared projects and their files on this PC\. It cannot be undone\./);
  h.click('[data-team-action="del-open"]');
  await flush();
  assert.match(text(del(h).querySelector('.team-del__what')), /Counting…/);
  assert.equal(h.q('#teamDeleteName').disabled, true, 'the name field waits for the numbers');
  release({ ok: true, inventory: INVENTORY });
  await flush();
  const what = text(del(h).querySelector('.team-del__what'));
  assert.match(what, /People 2 members lose the team: Olive Owner \(you\) and Dot\. 1 unused invite stops working\. 1 person waiting to join is turned away\./);
  assert.match(what, /Messages #team and 2 project channels, with 1,284 messages\. 1 direct conversation between members, with 312 messages\./);
  assert.match(what, /2 shared projects: their files on this PC’s disk and their conversations with Jenny\./);
  assert.match(what, /jenny-site 212 files 48 MB 3 conversations tax-2026 18 files 6 MB 1 conversation 2 projects 230 files 54 MB 4 conversations/);
  assert.match(what, /Also 1 project deleted 4 days ago and still in the 7-day trash, 9 MB\./);
  assert.match(what, /Records The activity log, the record of who used the team’s GPUs, and this team’s key\./);
  assert.match(text(del(h)), /Jenny is writing a reply in jenny-site right now \(“Palette loader cleanup”\)\. It is cut off\./);
  assert.match(text(del(h)), /Not deleted: Your own chats, projects and models in Jenny on this PC\./);
  const go = () => h.q('[data-team-action="del-go"]');
  assert.equal(go().disabled, true);
  h.type('#teamDeleteName', 'studio');
  await flush();
  assert.equal(go().disabled, true, 'the name must match exactly');
  h.type('#teamDeleteName', 'Stud');
  h.listeners.host(host({ reach: { result: 'not_reachable', reason: 'internet_off' } }));
  await flush();
  assert.equal(h.q('#teamDeleteName').value, 'Stud', 'a push keeps the half-typed name');
  h.type('#teamDeleteName', 'Studio');
  await flush();
  assert.equal(go().disabled, false);
  go().click();
  await flush();
  assert.deepEqual(h.sent('hostDelete').map((c) => c.payload), [{ name: 'Studio' }]);
  assert.match(text(h.q('#teamSettingsBody')), /Studio was deleted from this PC\./);
});

test('a delete that stopped part way says which project, leaves the team, and can be pressed again', async (t) => {
  const answers = [{ ok: false, error: { code: 'CMP-HOST-0002', reason: 'team_delete_file_held', project_id: 'project_tax' } }, { ok: true }];
  const h = owner(t, {}, { hostInventory: { ok: true, inventory: INVENTORY }, hostDelete: () => answers.shift() });
  await flush();
  h.click('[data-team-action="del-open"]');
  await flush();
  h.type('#teamDeleteName', 'Studio');
  await flush();
  h.click('[data-team-action="del-go"]');
  await flush();
  assert.match(text(del(h)), /Not everything could be deleted: a file in tax-2026 is open in another program\. Nothing else was removed and the team is still here\. Close the file, then delete again\./);
  assert.equal(h.q('[data-team-action="del-go"]').disabled, false, 'it can be pressed again');
  h.click('[data-team-action="del-go"]');
  await flush();
  assert.equal(h.sent('hostDelete').length, 2);
});

test('lost key on first open: Cannot start with no Start button; Start a new team asks, then sends the typed name', async (t) => {
  const h = harness({ host: host({ state: 'stopped', key: 'set_aside' }), teams: [snapshot({ state: 'offline' })],
    answers: { hostStartNew: { ok: true, host: host({ team_name: 'Second', old_teams: [] }) } } });
  t.after(h.restore);
  await flush();
  const status = text(h.q('.settings-page-status'));
  assert.match(status, /Cannot start/);
  assert.match(status, /This PC’s key for Studio is missing\./);
  assert.equal(h.q('[data-team-action="start"]'), null, 'no Start button');
  assert.equal(h.calls.some((c) => c.method === 'hostDeploy'), false, 'nothing pressed');
  const lost = h.q('[data-team-group="lostkey"]');
  assert.equal(text(lost.querySelector('.settings-group-heading')), 'This team’s key is missing');
  assert.match(text(lost), /Jenny kept the damaged file in its data folder, with a name starting secure-state\.json\.corrupt\./);
  assert.match(text(lost), /Put the key back.*Start a new team.*Restore from a backup/);
  assert.ok(del(h), 'the Delete group is on the lost-key page too');
  h.click('[data-team-action="new-open"]');
  await flush();
  assert.match(text(lost.ownerDocument.querySelector('[data-team-group="lostkey"] .team-set-confirm')), /Start a new team on this PC\?.*Studio cannot be started again without its key\./);
  h.type('#teamStartNewName', 'Second');
  h.type('#teamPcName', 'Desk'); // offline, this PC's name is not known: the You group asks for it
  h.click('[data-team-action="new-go"]');
  await flush();
  assert.deepEqual(h.sent('hostStartNew').map((c) => c.payload), [{ name: 'Second', display_name: 'Olive Owner', label: 'Desk' }]);
});

test('an old team is a row in Delete with Show files; its confirmation reads the old team’s counts', async (t) => {
  const old = { id: OLD_ID, team_name: 'Studio', set_aside_at: Date.UTC(2026, 10, 12, 12), projects: 2, bytes: 54_000_000 };
  const h = owner(t, { team_name: 'Second', old_teams: [old] }, { hostInventory: (p) => ({ ok: true, inventory: { ...INVENTORY, busy: [] }, asked: p }), hostOldDelete: { ok: true } });
  await flush();
  const row = text(del(h));
  assert.match(row, /Studio \(old team\) Set aside on Nov 12, 2026 when its key went missing\. 2 projects, 54 MB\. It cannot be opened in Jenny; its project files are ordinary files\./);
  h.click(`[data-team-action="old-show"][data-team-id="${OLD_ID}"]`);
  await flush();
  assert.deepEqual(h.sent('hostOldShow').map((c) => c.payload), [{ set_aside_id: OLD_ID }]);
  h.click(`[data-team-action="old-del"][data-team-id="${OLD_ID}"]`);
  await flush();
  assert.deepEqual(h.sent('hostInventory').at(-1).payload, { set_aside_id: OLD_ID });
  const ask = text(del(h).querySelector('.team-del'));
  assert.match(ask, /Delete Studio\? This deletes what the old team left on this PC\. Nothing goes to a trash\. It cannot be undone\./);
  assert.match(ask, /2 members: Olive Owner \(you\) and Dot\. They lost the team when its key went missing; this removes their places in it for good\./);
  assert.match(ask, /Its key is missing, so no export can bring this team back\./);
  h.type('#teamDeleteName', 'Studio');
  await flush();
  h.click('[data-team-action="old-del-go"]');
  await flush();
  assert.deepEqual(h.sent('hostOldDelete').map((c) => c.payload), [{ set_aside_id: OLD_ID, name: 'Studio' }]);
});

test('E73: an export that left the backup out says so and does not point at Restore', async (t) => {
  const h = owner(t, {}, { hostInventory: { ok: true, inventory: INVENTORY },
    hostExport: { ok: true, folder: 'D:\\Backups\\Studio', bytes: 2048, backup_left_out: true } });
  await flush();
  h.click('[data-team-group="ownership"] [data-team-action="export-open"]');
  await flush();
  h.type('#teamExportPass', PASSWORD);
  h.type('#teamExportPass2', PASSWORD);
  h.click('[data-team-action="export-go"]');
  await flush();
  const shown = text(h.q('[data-team-group="ownership"]'));
  assert.match(shown, /The member list is damaged, so only the readable copy was saved\. This export cannot be restored\./);
  assert.doesNotMatch(shown, /To bring the team back later/);
});

test('export: the standing row and the delete form send the password once; the password is in no state', async (t) => {
  const h = owner(t, {}, { hostInventory: { ok: true, inventory: INVENTORY }, hostExport: { ok: true, folder: 'D:\\Backups\\Studio 2026-11-12', bytes: 1_500_000_000 } });
  await flush();
  const own = h.q('[data-team-group="ownership"]');
  assert.match(text(own), /Export this team A readable copy of its files and your messages, and a password-locked backup that can bring the whole team back\. Export…/);
  h.click('[data-team-group="ownership"] [data-team-action="export-open"]');
  await flush();
  h.type('#teamExportPass', PASSWORD);
  h.type('#teamExportPass2', PASSWORD + 'x');
  h.click('[data-team-action="export-go"]');
  await flush();
  assert.equal(h.sent('hostExport').length, 0);
  assert.match(text(h.q('[data-team-group="ownership"]')), /The two passwords are not the same\./);
  h.listeners.host(host({ reach: { result: 'not_reachable', reason: 'internet_off' } }));
  await flush();
  assert.equal(h.q('#teamExportPass').value, PASSWORD, 'a push keeps the password in its field');
  h.type('#teamExportPass2', PASSWORD);
  h.click('[data-team-action="export-go"]');
  await flush();
  assert.deepEqual(h.sent('hostExport').map((c) => c.payload), [{ password: PASSWORD }]);
  assert.match(text(h.q('[data-team-group="ownership"]')), /Exported to D:\\Backups\\Studio 2026-11-12 \(1\.5 GB\)\. To bring the team back later: Settings, Team, Host a team, Restore a team from a backup\./);
  assert.equal(JSON.stringify([h.section._live, h.store.snapshot(), h.logged, h.stored]).includes(PASSWORD), false);
  h.click('[data-team-action="del-open"]');
  await flush();
  assert.ok(h.q('[data-team-group="delete"] [data-team-action="export-open"]'), 'Export a copy first… in the confirmation');
});

test('restore on a PC that hosts no team: pick, a wrong password changes nothing, the right one brings the team back', async (t) => {
  const answers = [{ ok: false, error: { code: 'CMP-HOST-0002', reason: 'team_backup_password_wrong' } },
    { ok: true, team_name: 'Studio', exported_at: Date.UTC(2026, 10, 12, 12), host: host() }];
  const h = harness({ host: { ...NONE, key: null, old_teams: [] }, teams: [],
    answers: { hostRestorePick: { ok: true, file_name: 'Studio.jennyteam', size: 1_500_000_000 }, hostRestore: () => answers.shift() } });
  t.after(h.restore);
  await flush();
  h.type('#teamYourName', 'Olive');
  h.type('#teamPcName', 'Desk');
  assert.match(text(h.q('[data-team-group="host"]')), /Restore a team from a backup Brings back a team you exported from Jenny, with its members, messages and projects\. Restore…/);
  h.click('[data-team-action="restore-open"]');
  await flush();
  assert.equal(h.q('[data-team-action="restore-go"]').disabled, true, 'waits for a file');
  h.click('[data-team-action="restore-pick"]');
  await flush();
  assert.match(text(h.q('[data-team-group="host"]')), /Studio\.jennyteam · 1\.5 GB/);
  h.type('#teamRestorePass', 'wrong password!');
  h.click('[data-team-action="restore-go"]');
  await flush();
  assert.match(text(h.q('[data-team-group="host"]')), /That password does not open this backup\. Nothing was changed\./);
  h.type('#teamRestorePass', PASSWORD);
  h.click('[data-team-action="restore-go"]');
  await flush();
  assert.deepEqual(h.sent('hostRestore').map((c) => c.payload).at(-1), { password: PASSWORD, display_name: 'Olive', label: 'Desk' });
  assert.match(text(h.q('#teamSettingsBody')), /Studio is back, as it was on Nov 12, 2026\. If this PC’s address is different from before, send members a reconnect code \(under Network\)\./);
  assert.equal(JSON.stringify([h.section._live, h.store.snapshot(), h.logged]).includes(PASSWORD), false);
});

test('restore from the lost-key page asks for the team’s name as Delete does', async (t) => {
  const h = harness({ host: host({ state: 'stopped', key: 'missing' }), teams: [snapshot({ state: 'offline' })],
    answers: { hostRestorePick: { ok: true, file_name: 'Studio.jennyteam', size: 10 }, hostRestore: { ok: true, team_name: 'Studio', exported_at: 1, host: host() } } });
  t.after(h.restore);
  await flush();
  assert.doesNotMatch(text(h.q('[data-team-group="lostkey"]')), /secure-state/, 'the missing-key copy leaves out the damaged file');
  h.click('[data-team-group="lostkey"] [data-team-action="restore-open"]');
  await flush();
  h.click('[data-team-action="restore-pick"]');
  await flush();
  h.type('#teamRestorePass', PASSWORD);
  assert.equal(h.q('[data-team-action="restore-go"]').disabled, true);
  h.type('#teamRestoreName', 'Studio');
  h.type('#teamPcName', 'Desk');
  await flush();
  h.click('[data-team-action="restore-go"]');
  await flush();
  assert.equal(h.sent('hostRestore')[0].payload.name, 'Studio');
});

test('only the owner sees Delete this team, Export this team and Network', async (t) => {
  const h = harness({ host: host(), teams: [snapshot({ role: 'member' })] });
  t.after(h.restore);
  await flush();
  assert.equal(h.q('[data-team-action="del-open"]'), null);
  assert.equal(h.q('#teamExportRow'), null);
  assert.equal(h.q('[data-team-group="network"]'), null);
  const member = harness({ teams: [memberTeam()] });
  t.after(member.restore);
  await flush();
  assert.equal(member.q('[data-team-group="delete"]'), null);
});

test('a member whose team was deleted sees the owner, the date and Remove this team', async (t) => {
  const h = harness({ teams: [{ team_id: OTHER, team_name: 'Dot lab', state: 'deleted', reason: null, deleted_by: 'Olive Owner', deleted_at: Date.UTC(2026, 10, 12, 10) }] });
  t.after(h.restore);
  await flush();
  const row = h.q('[data-team-joined] .team-set-person');
  assert.equal(text(row.querySelector('.team-set-person__fact')), 'deleted by its owner');
  assert.equal(text(row.querySelector('.team-set-person__hint')), 'Olive Owner deleted this team on Nov 12, 2026. Its channels and shared projects are gone. Your own chats on this PC were not touched.');
  row.querySelector('[data-team-action="remove-team"]').click();
  await flush();
  assert.deepEqual(h.sent('removeTeam').map((c) => c.payload), [{ team_id: OTHER }]);
});

// ------------------------------------------------------------------ review of 5-6 (fix list items 14, 22-25)

test('the trash line says day or days, and an old team with no readable name asks for the word delete', async (t) => {
  const one = { ...INVENTORY, trash: [{ days_ago: 1, bytes: 9_000_000 }], busy: [] };
  const h = owner(t, { old_teams: [{ id: OLD_ID, team_name: null, set_aside_at: Date.UTC(2026, 10, 1), projects: 1, bytes: 10 }] },
    { hostInventory: { ok: true, inventory: one }, hostOldDelete: { ok: true, host: host() } });
  await flush();
  h.click('[data-team-action="del-open"]');
  await flush();
  assert.match(text(del(h)), /Also 1 project deleted 1 day ago and still in the 7-day trash, 9 MB\./);
  h.click('[data-team-action="confirm-cancel"]');
  h.click(`[data-team-action="old-del"][data-team-id="${OLD_ID}"]`);
  await flush();
  assert.match(text(del(h)), /This old team’s name could not be read\. Type delete to confirm\./);
  const go = () => h.q('[data-team-action="old-del-go"]');
  assert.equal(go().disabled, true);
  h.type('#teamDeleteName', 'delete');
  await flush();
  assert.equal(go().disabled, false);
  go().click();
  await flush();
  assert.deepEqual(h.sent('hostOldDelete').map((c) => c.payload), [{ set_aside_id: OLD_ID, name: 'delete' }]);
});

test('a greyed button says why: Export a copy first with the key lost, Restore team until a file is picked', async (t) => {
  const h = owner(t, { state: 'stopped', key: 'missing' }, { hostInventory: { ok: true, inventory: INVENTORY } });
  await flush();
  h.click('[data-team-action="del-open"]');
  await flush();
  const first = h.q('[data-team-action="export-open"][data-team-id="delete"]');
  assert.equal(first.disabled, true);
  assert.equal(first.title, 'The team’s key is missing, so no export can be made.');
  assert.match(first.getAttribute('aria-label'), /Export a copy first… \(The team’s key is missing, so no export can be made\.\)/);
  const r = harness({ host: { ...NONE }, teams: [] });
  t.after(r.restore);
  await flush();
  r.click('[data-team-action="restore-open"]');
  await flush();
  const go = r.q('[data-team-action="restore-go"]');
  assert.equal(go.disabled, true);
  assert.equal(go.title, 'Choose the backup file first.');
  assert.match(go.getAttribute('aria-label'), /Restore team \(Choose the backup file first\.\)/);
});

test('while main runs a lifecycle call (any window) the page stays greyed, even after it is left and opened again', async (t) => {
  const h = owner(t, { operation: 'hostDelete' });
  await flush();
  assert.equal(h.q('[data-team-action="del-open"]').disabled, true);
  assert.match(text(h.q('[data-team-action="del-open"]')), /Deleting…/);
  assert.equal(h.q('[data-team-action="export-open"]').disabled, true);
  h.listeners.host(host({ operation: null }));
  await flush();
  assert.equal(h.q('[data-team-action="del-open"]').disabled, false);
});

test('a delete that left files behind says so after it is done', async (t) => {
  const h = owner(t, {}, { hostInventory: { ok: true, inventory: INVENTORY }, hostDelete: { ok: true, team_name: 'Studio', left: ['files'], host: { ...NONE } } });
  await flush();
  h.click('[data-team-action="del-open"]');
  await flush();
  h.type('#teamDeleteName', 'Studio');
  await flush();
  h.click('[data-team-action="del-go"]');
  await flush();
  assert.match(text(h.q('#teamSettingsBody')), /Studio was deleted from this PC\. Some of its files could not be removed\. Jenny removes them the next time it starts\./);
});

test('with the server stopped, Delete this team follows fork 8: main\'s saved membership, not the page', async (t) => {
  const handed = harness({ host: host({ state: 'stopped', owner: false }), teams: [snapshot({ role: null, state: 'offline' })] });
  t.after(handed.restore);
  await flush();
  assert.equal(handed.q('[data-team-action="del-open"]'), null, 'ownership was handed away: no Delete row');
  const mine = harness({ host: host({ state: 'stopped', owner: true }), teams: [snapshot({ role: null, state: 'offline' })] });
  t.after(mine.restore);
  await flush();
  assert.ok(mine.q('[data-team-action="del-open"]'));
});

// ---------------------------------------------------- team review fixes (row 201): OD-11 export and delete

test('export says the 10-character password minimum before the first submit', async (t) => {
  const h = owner(t, {}, { hostInventory: { ok: true, inventory: INVENTORY } });
  await flush();
  h.click('[data-team-group="ownership"] [data-team-action="export-open"]');
  await flush();
  const form = h.q('[data-team-export-form]');
  assert.match(text(form), /The password needs at least 10 characters\./, 'said before anything is sent');
  assert.equal(h.sent('hostExport').length, 0);
  const hint = form.querySelector('[id="teamExportPassHint"]');
  assert.ok(hint, 'the hint has an id');
  assert.equal(h.q('#teamExportPass').getAttribute('aria-describedby'), 'teamExportPassHint');
});

test('Escape in the export form closes only it, and focus goes back to Export…; Enter in the password field submits it', async (t) => {
  const h = owner(t, {}, { hostInventory: { ok: true, inventory: INVENTORY }, hostExport: { ok: true, folder: 'D:/Backups/Studio', bytes: 5 } });
  await flush();
  const doc = h.window.document;
  const key = (el, name) => el.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  h.click('[data-team-group="ownership"] [data-team-action="export-open"]');
  await flush();
  key(h.q('#teamExportPass'), 'Escape');
  assert.equal(h.q('#teamExportPass'), null, 'Escape closes Export');
  assert.equal(doc.activeElement, h.q('[data-team-group="ownership"] [data-team-action="export-open"]'), 'focus returns to the button that opened it');
  // Inside the delete confirmation Escape closes the nested export first and leaves the confirmation.
  h.click('[data-team-action="del-open"]');
  await flush();
  h.click('[data-team-group="delete"] [data-team-action="export-open"]');
  await flush();
  key(h.q('#teamExportPass'), 'Escape');
  assert.equal(h.q('#teamExportPass'), null);
  assert.ok(h.q('[data-team-group="delete"] .team-del'), 'the delete confirmation stays');
  h.click('[data-team-action="confirm-cancel"]');
  await flush();
  h.click('[data-team-group="ownership"] [data-team-action="export-open"]');
  await flush();
  h.type('#teamExportPass', PASSWORD);
  h.type('#teamExportPass2', PASSWORD);
  key(h.q('#teamExportPass2'), 'Enter');
  await flush();
  assert.deepEqual(h.sent('hostExport').map((c) => c.payload), [{ password: PASSWORD }], 'Enter submits the form');
});

test('the delete confirmation takes an emoji team name typed in full, and Enter then deletes', async (t) => {
  const name = '🙂'.repeat(30); // 30 characters for the host, 60 UTF-16 units
  const h = harness({ host: host({ team_name: name }), teams: [snapshot({ team_name: name })],
    answers: { hostInventory: { ok: true, inventory: INVENTORY }, hostDelete: { ok: true, host: { ...NONE } } } });
  t.after(h.restore);
  await flush();
  h.click('[data-team-action="del-open"]');
  await flush();
  const field = h.q('#teamDeleteName');
  const cap = field.getAttribute('maxlength');
  assert.ok(cap === null || Number(cap) >= name.length, `the field's cap (${cap}) lets the whole name be typed`);
  h.type('#teamDeleteName', name);
  await flush();
  assert.equal(h.q('[data-team-action="del-go"]').disabled, false, 'the same characters match');
  h.window.document.querySelector('#teamDeleteName').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(h.sent('hostDelete').map((c) => c.payload), [{ name }]);
});

test('the delete inventory lists custom channels beside the project channels', async (t) => {
  const chat = { ...INVENTORY.chat, custom_channels: 3 };
  const h = owner(t, {}, { hostInventory: { ok: true, inventory: { ...INVENTORY, chat } } });
  await flush();
  h.click('[data-team-action="del-open"]');
  await flush();
  assert.match(text(del(h).querySelector('.team-del__what')), /3 custom channels/);
});
