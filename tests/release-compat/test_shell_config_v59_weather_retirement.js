'use strict';

/* Release-compat gate for the shell-config v58 -> v59 bump (DPR-010: Home
 * weather retired on the owner's decision, 2026-10-02). Drives a v58-shaped
 * config carrying a saved weather location through the real migrate/normalize
 * path and pins: version becomes 59, `home.weather` does not survive load or
 * serialization, and every other Home field the fixture carries an opinion on
 * is preserved. The shipped v51 fixture (which carries an unset weather slot)
 * is also driven through to prove older profiles lose the key too. Registered
 * in scripts/tests/run-dist-tests.js (check_release_compat_registered enforces
 * the registration).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { normalizeState, serializeState } = require('../../services/shell-config-state');

const V51_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'shell-config-v51', 'shell-config.json');

function v58ConfigWithSavedLocation() {
  return {
    version: 58,
    uiLanguage: 'en',
    home: {
      links: [{ id: 'group-lab', name: 'Lab', tiles: [{ id: 'tile-pi', name: 'Pi', href: 'https://pi.example' }] }],
      weather: { lat: 40.7128, lon: -74.006, units: 'imperial' },
      widgets: { order: ['calendar'], hidden: [] },
      scratchpad: {
        notes: [{ id: 'note-1', title: 'Note 1', text: 'keep me', updatedAt: '', appendLog: false }],
        activeNoteId: 'note-1',
        settings: { rows: 6, font: 'prose', captureMode: 'overwrite', markdown: false, globalCapture: false },
        pins: [],
      },
      calendar: { feeds: [], viewMode: 'week' },
      layout: { railWidth: 480 },
      focusMode: true,
      showContextualTips: false,
    },
  };
}

test('v58 -> v59 forgets a saved Home weather location', () => {
  const state = normalizeState(v58ConfigWithSavedLocation());
  const serialized = serializeState(state);

  assert.equal(state.version, 59);
  assert.equal(Object.hasOwn(state.home, 'weather'), false);
  assert.equal(Object.hasOwn(serialized.home, 'weather'), false);
  assert.doesNotMatch(JSON.stringify(serialized), /40\.7128|-74\.006/);
});

test('v58 -> v59 preserves every other Home field', () => {
  const home = normalizeState(v58ConfigWithSavedLocation()).home;

  assert.equal(home.links[0].name, 'Lab');
  assert.equal(home.links[0].tiles[0].href, 'https://pi.example');
  assert.deepEqual(home.widgets.order, ['calendar']);
  assert.equal(home.scratchpad.notes[0].text, 'keep me');
  assert.equal(home.scratchpad.settings.captureMode, 'overwrite');
  assert.equal(home.scratchpad.settings.globalCapture, false);
  assert.equal(home.calendar.viewMode, 'week');
  assert.equal(home.layout.railWidth, 480);
  assert.equal(home.focusMode, true);
  assert.equal(home.showContextualTips, false);
});

test('the shipped v51 fixture also loses its weather slot', () => {
  const fixture = JSON.parse(fs.readFileSync(V51_FIXTURE_PATH, 'utf8'));
  assert.ok(Object.hasOwn(fixture.home, 'weather'), 'fixture still carries the retired key');

  const state = normalizeState(fixture);
  assert.equal(state.version, 59);
  assert.equal(Object.hasOwn(serializeState(state).home, 'weather'), false);
});
