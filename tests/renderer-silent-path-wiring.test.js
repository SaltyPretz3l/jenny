/**
 * EH-W10 gate: silent-path intake wiring. The route behavior (row 5
 * settings-refresh warning toast, row 6 offline/health-poll error-center
 * only) is table-tested in tests/renderer-error-intake.test.js; these
 * checks pin the catch-site wiring — each silent path reports with the
 * right origin and dedupe key while keeping its appendClientLog WARN.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('settings-refresh failures report with origin settings-refresh and keep their WARN logs', () => {
  const source = readSource('renderer/chat/renderer-chat-event-utils.js');

  const memorySites = source.match(/dedupeKey: 'settings-refresh:memories'/g) || [];
  assert.equal(memorySites.length, 2, 'both memory-refresh catches (backend-ready + auth) report');
  assert.match(source, /dedupeKey: 'settings-refresh:suggestions'/);
  assert.equal((source.match(/\{ origin: 'settings-refresh' \}/g) || []).length, 3);

  for (const warnEvent of ['chat.refresh_memories_failed', 'chat.refresh_suggestions_failed', 'chat.auth_refresh_memories_failed']) {
    assert.ok(source.includes(warnEvent), `observability WARN ${warnEvent} kept`);
  }
});

test('offline/companion refresh failures report with origin offline-refresh', () => {
  // The home-view hydration catches (companion refresh + the home-view
  // activation offline catch) were extracted to renderer-home-view-hydrate.js;
  // the bootstrap offline catch stays in renderer-lifecycle-utils.js. Read both
  // so the silent-path wiring is pinned wherever the catch-site now lives.
  const source = [
    readSource('renderer/shell/renderer-lifecycle-utils.js'),
    readSource('renderer/shell/renderer-home-view-hydrate.js'),
  ].join('\n');

  assert.match(source, /dedupeKey: 'offline-refresh:companion' \}, \{ origin: 'offline-refresh' \}/);
  const offlineSites = source.match(/dedupeKey: 'offline-refresh:offline' \}, \{ origin: 'offline-refresh' \}/g) || [];
  assert.equal(offlineSites.length, 2, 'home-view activation + bootstrap offline catches both report');
  assert.ok(source.includes("'reportError'"), 'reportError forwarded through FWD_KEYS');
  for (const warnEvent of ['home.refresh_companion_failed', 'home.refresh_offline_failed', 'offline.bootstrap_failed']) {
    assert.ok(source.includes(warnEvent), `observability WARN ${warnEvent} kept`);
  }
});

test('health pill controller is wired with the flag-gated intake route', () => {
  const composition = readSource('renderer/app/renderer-app-controller-composition.js');
  const healthPillBlock = composition.slice(
    composition.indexOf('createHealthPillController'),
    composition.indexOf('headerController')
  );
  assert.match(healthPillBlock, /reportError: \(\.\.\.a\) => reportErrorWhenActive\(\.\.\.a\)/);
});
