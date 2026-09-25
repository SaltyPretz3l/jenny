'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { ToolPermissionStore } = require('../services/tools/tool-permission-store');
const { evaluatePolicy } = require('../services/tools/tool-policy-evaluator');
const {
  DEMO_MODEL,
  SEEDED_SESSIONS,
  buildSeededSessions,
  buildSeededCalendarEvents,
} = require('../scripts/demo/demo-sessions');
const { seedDemoSessions, seedDemoCalendar, seedDemoToolPolicy, demoWorkspaceDir, cleanupDemoProfile } = require('../scripts/demo/demo-profile');

// A fixed local clock so the assertions can name the dates they expect.
const NOW = new Date(2026, 8, 7, 15, 0, 0).getTime(); // Monday 2026-09-07 15:00 local
const INTERNAL_COPY = /\b(?:replay|smoke|deterministic|fixture)\b/i;

function tempProfile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-demo-sessions-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_error) { /* harmless */ }
  });
  return dir;
}

test('demo workspaces never reuse existing projects or another recording', (t) => {
  const parentDir = tempProfile(t);
  const existing = path.join(parentDir, 'ledger-cli');
  fs.mkdirSync(existing);
  const sentinel = path.join(existing, 'user-work.txt');
  fs.writeFileSync(sentinel, 'keep this work');
  const first = demoWorkspaceDir({ parentDir });
  const second = demoWorkspaceDir({ parentDir });
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first, existing);
  assert.strictEqual(path.dirname(first), parentDir);
  fs.writeFileSync(path.join(second, 'recording.txt'), 'still recording');
  cleanupDemoProfile({ base: existing, workspace: first });
  assert.strictEqual(fs.existsSync(first), false);
  assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep this work');
  assert.strictEqual(fs.readFileSync(path.join(second, 'recording.txt'), 'utf8'), 'still recording');
  cleanupDemoProfile({ workspace: first }); // repeated cleanup is harmless
  cleanupDemoProfile({ workspace: existing }); // unowned paths are never deleted
  assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep this work');
  cleanupDemoProfile({ workspace: second });
  assert.strictEqual(fs.existsSync(second), false);
});

test('demo cleanup refuses a workspace replaced by a junction or symlink', (t) => {
  const parentDir = tempProfile(t);
  const target = path.join(parentDir, 'user-project');
  fs.mkdirSync(target);
  const sentinel = path.join(target, 'keep.txt');
  fs.writeFileSync(sentinel, 'keep');
  const workspace = demoWorkspaceDir({ parentDir });
  fs.rmdirSync(workspace); // known empty directory allocated by this test
  fs.symlinkSync(target, workspace, process.platform === 'win32' ? 'junction' : 'dir');
  cleanupDemoProfile({ workspace });
  assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep');
  assert.strictEqual(fs.lstatSync(workspace).isSymbolicLink(), true);
});

test('demo cleanup does not remove a different directory at an owned path', (t) => {
  const parentDir = tempProfile(t);
  const workspace = demoWorkspaceDir({ parentDir });
  // Retain the original inode so the replacement cannot coincidentally reuse it.
  fs.renameSync(workspace, path.join(parentDir, 'original-recording'));
  fs.mkdirSync(workspace);
  const sentinel = path.join(workspace, 'new-owner.txt');
  fs.writeFileSync(sentinel, 'keep');
  cleanupDemoProfile({ workspace });
  assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep');
});

test('seeded sessions are promo-facing, newest first, and one is pinned', () => {
  const sessions = buildSeededSessions(NOW);
  assert.ok(sessions.length >= 6, 'enough history to fill the sidebar');
  assert.strictEqual(sessions.filter((session) => session.pinned).length, 1);
  let previous = Infinity;
  for (const session of sessions) {
    const updated = Date.parse(session.updatedAt);
    assert.ok(updated < previous, `${session.title} is older than the one above it`);
    assert.ok(updated < NOW && Date.parse(session.createdAt) < updated);
    previous = updated;
    assert.strictEqual(session.messages.length % 2, 0, 'user/assistant pairs');
    assert.strictEqual(session.messages[0].role, 'user');
    assert.strictEqual(session.messages[1].role, 'assistant');
    assert.strictEqual(session.messages[1].model_used, DEMO_MODEL);
    for (const message of session.messages) {
      assert.ok(!INTERNAL_COPY.test(message.content), `${session.title} copy stays promo-facing`);
    }
  }
  assert.strictEqual(new Set(SEEDED_SESSIONS.map((entry) => entry.title)).size, SEEDED_SESSIONS.length);
});

test('seedDemoSessions writes through the real session store and the sidebar sees the seeded ages', (t) => {
  const profile = tempProfile(t);
  const projectId = 'project_ledger';
  const ids = seedDemoSessions(profile, NOW, projectId);
  assert.strictEqual(ids.length, SEEDED_SESSIONS.length);

  const store = new ElectronSessionStore(path.join(profile, 'sessions.json'));
  t.after(() => store.dispose());
  const listed = store.listSessions();
  assert.strictEqual(listed.length, SEEDED_SESSIONS.length);
  const expected = buildSeededSessions(NOW);
  for (const session of expected) {
    const summary = listed.find((entry) => entry.title === session.title);
    assert.ok(summary, `${session.title} is listed`);
    assert.strictEqual(summary.updated_at, session.updatedAt);
    assert.strictEqual(summary.created_at, session.createdAt);
    assert.strictEqual(summary.pinned, session.pinned);
    assert.strictEqual(summary.project_id, projectId);
    assert.strictEqual(summary.message_count, session.messages.length);
    assert.strictEqual(summary.last_model_used, DEMO_MODEL);
    assert.ok(summary.last_message_preview.startsWith(session.messages.at(-1).content.slice(0, 40)));
    const messages = store.getSessionMessages(summary.id);
    assert.strictEqual(messages.length, session.messages.length);
    assert.strictEqual(messages[0].timestamp, session.messages[0].timestamp);
  }
  assert.deepStrictEqual(store.sweepEmptySessions({ dryRun: true }).candidateIds, [], 'nothing seeded is empty');
});

test('seedDemoSessions refuses to place demo history in General implicitly', (t) => {
  const profile = tempProfile(t);
  assert.throws(() => seedDemoSessions(profile, NOW), /require a project id/);
});

test('demo calendar and tool policy stay scoped to the Ledger CLI project authority', (t) => {
  const profile = tempProfile(t);
  seedDemoCalendar(profile, NOW);
  const stored = JSON.parse(fs.readFileSync(path.join(profile, 'home-calendar.json'), 'utf8'));
  assert.strictEqual(stored.version, 1);
  assert.deepStrictEqual(
    stored.events.map((event) => event.start),
    ['2026-09-07T10:00', '2026-09-08T13:30', '2026-09-09T09:00', '2026-09-11T00:00']
  );
  assert.deepStrictEqual(stored.events, buildSeededCalendarEvents(NOW));
  const allDay = stored.events.find((event) => event.allDay);
  assert.strictEqual(allDay.end, '2026-09-12T00:00');
  for (const event of stored.events) {
    assert.ok(/^evt_demo_\d+$/.test(event.id));
    assert.strictEqual(event.recurrence, 'none');
  }

  const workspace = path.join(profile, 'demo-workspace');
  fs.mkdirSync(workspace);
  const authority = seedDemoToolPolicy(profile, workspace);
  seedDemoSessions(profile, NOW, authority.project_id);
  const policies = new ToolPermissionStore(path.join(profile, 'tool-permissions.json'));
  const decision = (toolName, scope) => evaluatePolicy({
    descriptor: { name: toolName, read_only: false, side_effecting: true, source_kind: 'builtin' },
    args: { action: 'create_event' },
    snapshot: policies.getSnapshot(scope),
  }).decision;
  const homeDecision = (scope) => decision('home', scope);
  assert.strictEqual(homeDecision(authority), 'auto');
  assert.strictEqual(homeDecision({ ...authority, project_id: 'project_other' }), 'ask');
  assert.strictEqual(homeDecision({ ...authority, root_revision: authority.root_revision + 1 }), 'ask');
  assert.strictEqual(decision('edit_file', authority), 'ask', 'file edits still stop for approval');
  const projects = JSON.parse(fs.readFileSync(path.join(profile, 'projects.json'), 'utf8'));
  assert.strictEqual(projects.projects.project_general.root_path, null);
  assert.strictEqual(projects.projects[authority.project_id].name, 'Ledger CLI');
  assert.strictEqual(projects.projects[authority.project_id].root_path, authority.root_path);
  const generalAuthority = {
    project_id: 'project_general',
    root_path: null,
    root_id: null,
    root_revision: 0,
    device_id: null,
    inode: null,
  };
  assert.strictEqual(homeDecision(generalAuthority), 'ask');
  const sessions = new ElectronSessionStore(path.join(profile, 'sessions.json'));
  t.after(() => sessions.dispose());
  assert.ok(sessions.listSessions().every((session) => session.project_id === authority.project_id));
});
