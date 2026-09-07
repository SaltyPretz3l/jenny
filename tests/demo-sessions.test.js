'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { ToolPermissionStore } = require('../services/tools/tool-permission-store');
const {
  DEMO_MODEL,
  SEEDED_SESSIONS,
  buildSeededSessions,
  buildSeededCalendarEvents,
} = require('../scripts/demo/demo-sessions');
const { seedDemoSessions, seedDemoCalendar, seedDemoToolPolicy } = require('../scripts/demo/demo-profile');

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
  const ids = seedDemoSessions(profile, NOW);
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
    assert.strictEqual(summary.message_count, session.messages.length);
    assert.strictEqual(summary.last_model_used, DEMO_MODEL);
    assert.ok(summary.last_message_preview.startsWith(session.messages.at(-1).content.slice(0, 40)));
    const messages = store.getSessionMessages(summary.id);
    assert.strictEqual(messages.length, session.messages.length);
    assert.strictEqual(messages[0].timestamp, session.messages[0].timestamp);
  }
  assert.deepStrictEqual(store.sweepEmptySessions({ dryRun: true }).candidateIds, [], 'nothing seeded is empty');
});

test('seedDemoCalendar covers the recording week and seedDemoToolPolicy auto-allows Home', (t) => {
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

  seedDemoToolPolicy(profile);
  const policies = new ToolPermissionStore(path.join(profile, 'tool-permissions.json'));
  assert.strictEqual(policies.getAllPolicies().home, 'auto');
  assert.notStrictEqual(policies.getAllPolicies().edit_file, 'auto', 'file edits still stop for approval');
});
