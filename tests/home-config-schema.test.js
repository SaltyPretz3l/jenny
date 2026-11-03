const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_HOME,
  DEFAULT_HOME_LAYOUT,
  DEFAULT_HOME_USAGE_STATS,
  HOME_LAYOUT_RAIL_WIDTH_DEFAULT,
  HOME_LAYOUT_RAIL_WIDTH_MAX,
  HOME_LAYOUT_RAIL_WIDTH_MIN,
  normalizeHomeConfig,
  normalizeHomeLayout,
  normalizeHomeUsageStats,
} = require('../services/home-config-schema');
const { ShellConfigService } = require('../services/shell-config-service');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('home layout defaults match DEFAULT_HOME_LAYOUT and are wired into DEFAULT_HOME', () => {
  assert.deepEqual(DEFAULT_HOME_LAYOUT, { railWidth: HOME_LAYOUT_RAIL_WIDTH_DEFAULT });
  assert.equal(HOME_LAYOUT_RAIL_WIDTH_DEFAULT, 360);
  assert.equal(HOME_LAYOUT_RAIL_WIDTH_MIN, 280);
  assert.equal(HOME_LAYOUT_RAIL_WIDTH_MAX, 720);
  assert.deepEqual(DEFAULT_HOME.layout, DEFAULT_HOME_LAYOUT);
  // DEFAULT == fresh-normalized, the invariant every other home section holds.
  assert.deepEqual(normalizeHomeConfig({}).layout, { railWidth: 360 });
});

test('normalizeHomeLayout clamps the rail width at both ends', () => {
  assert.deepEqual(normalizeHomeLayout({ railWidth: 279 }), { railWidth: 280 });
  assert.deepEqual(normalizeHomeLayout({ railWidth: 0 }), { railWidth: 280 });
  assert.deepEqual(normalizeHomeLayout({ railWidth: -9000 }), { railWidth: 280 });
  assert.deepEqual(normalizeHomeLayout({ railWidth: 721 }), { railWidth: 720 });
  assert.deepEqual(normalizeHomeLayout({ railWidth: 99999 }), { railWidth: 720 });
  // In-range values survive; fractional input truncates to an integer.
  assert.deepEqual(normalizeHomeLayout({ railWidth: 400 }), { railWidth: 400 });
  assert.deepEqual(normalizeHomeLayout({ railWidth: 400.9 }), { railWidth: 400 });
  assert.deepEqual(normalizeHomeLayout({ railWidth: '520' }), { railWidth: 520 });
});

test('normalizeHomeLayout falls back to the default on junk rather than a clamp end', () => {
  assert.deepEqual(normalizeHomeLayout(), { railWidth: 360 });
  assert.deepEqual(normalizeHomeLayout({}), { railWidth: 360 });
  assert.deepEqual(normalizeHomeLayout(null), { railWidth: 360 });
  assert.deepEqual(normalizeHomeLayout('360'), { railWidth: 360 });
  assert.deepEqual(normalizeHomeLayout([500]), { railWidth: 360 });
  assert.deepEqual(normalizeHomeLayout({ railWidth: 'wide' }), { railWidth: 360 });
  assert.deepEqual(normalizeHomeLayout({ railWidth: NaN }), { railWidth: 360 });
  assert.deepEqual(normalizeHomeLayout({ railWidth: Infinity }), { railWidth: 360 });
  assert.deepEqual(normalizeHomeLayout({ railWidth: null }), { railWidth: 360 });
});

test('normalizeHomeLayout treats blank persisted widths as missing', () => {
  assert.deepEqual(normalizeHomeLayout({ railWidth: '' }), { railWidth: 360 });
  assert.deepEqual(normalizeHomeLayout({ railWidth: '   ' }), { railWidth: 360 });
  assert.deepEqual(normalizeHomeLayout({ rail_width: '\t' }), { railWidth: 360 });
  assert.deepEqual(normalizeHomeLayout({ railWidth: '520' }), { railWidth: 520 });
});

test('home usageStats.range defaults to 7d, accepts the six ranges and collapses anything else', () => {
  assert.deepEqual(DEFAULT_HOME.usageStats, DEFAULT_HOME_USAGE_STATS);
  assert.deepEqual(normalizeHomeConfig({}).usageStats, { range: '7d' });
  for (const range of ['1d', '7d', '30d', '6mo', '1y', 'all']) {
    assert.deepEqual(normalizeHomeConfig({ usageStats: { range } }).usageStats, { range });
  }
  for (const junk of ['forever', '', '1yr', 7, null, undefined, {}]) {
    assert.deepEqual(normalizeHomeUsageStats({ range: junk }), { range: '7d' });
  }
  assert.deepEqual(normalizeHomeUsageStats(null), { range: '7d' });
  assert.deepEqual(normalizeHomeUsageStats('30d'), { range: '7d' });
  const once = normalizeHomeConfig({ usageStats: { range: '6mo' } });
  assert.deepEqual(normalizeHomeConfig(once), once, 'idempotent');
});

test('updateHomeConfig persists a usageStats range without touching sibling sections', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-home-usage-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });
  service.updateHomeConfig({ calendar: { viewMode: 'week' }, focusMode: true });
  const patched = service.updateHomeConfig({ usageStats: { range: '1y' } });
  assert.deepEqual(patched.usageStats, { range: '1y' });
  assert.equal(patched.calendar.viewMode, 'week');
  assert.equal(patched.focusMode, true);
  assert.deepEqual(service.updateHomeConfig({ usageStats: { range: 'bogus' } }).usageStats, { range: '7d' });
});

test('home layout round-trips through normalizeHomeConfig and is idempotent', () => {
  const once = normalizeHomeConfig({ layout: { railWidth: 512 }, focusMode: true });
  assert.deepEqual(once.layout, { railWidth: 512 });
  const twice = normalizeHomeConfig(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
  // A config written before `layout` existed reads back the default, lossless.
  assert.deepEqual(normalizeHomeConfig({ focusMode: true }).layout, { railWidth: 360 });
});

test('updateHomeConfig merges a layout patch without dropping sibling home sections', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-home-layout-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath, env: {} });
  service.updateHomeConfig({
    widgets: { hidden: ['links'] },
    scratchpad: {
      notes: [{ id: 'note-1', title: 'Note 1', text: 'keep me', updatedAt: '2026-08-20T10:00:00.000Z' }],
      settings: { rows: 8, font: 'mono' },
    },
    calendar: { viewMode: 'week' },
    focusMode: true,
  });

  const patched = service.updateHomeConfig({ layout: { railWidth: 400 } });
  assert.deepEqual(patched.layout, { railWidth: 400 });
  assert.deepEqual(patched.widgets.hidden, ['links']);
  assert.equal(patched.scratchpad.notes[0].text, 'keep me');
  assert.equal(patched.scratchpad.settings.rows, 8);
  assert.equal(patched.scratchpad.settings.font, 'mono');
  assert.equal(patched.calendar.viewMode, 'week');
  assert.equal(patched.focusMode, true);

  // An unrelated later patch must not reset the rail width.
  const afterSibling = service.updateHomeConfig({ calendar: { viewMode: 'month' } });
  assert.deepEqual(afterSibling.layout, { railWidth: 400 });

  // THE guard for `layout` being in updateHomeConfig's shallow-merge list. The
  // merge is one level deep, so a patch that names the section but omits a
  // field must keep the stored value; an unlisted section is instead replaced
  // wholesale by `...source` and silently falls back to the 360 default. A
  // patch carrying railWidth cannot tell the two apart -- only this one can.
  assert.deepEqual(service.updateHomeConfig({ layout: {} }).layout, { railWidth: 400 });

  // Out-of-range writes clamp on the way in and persist clamped.
  assert.deepEqual(service.updateHomeConfig({ layout: { railWidth: 9000 } }).layout, { railWidth: 720 });

  const reloaded = new ShellConfigService({ userDataPath, env: {} });
  assert.deepEqual(reloaded.getHomeConfig(), service.getHomeConfig());
  assert.deepEqual(reloaded.getHomeConfig().layout, { railWidth: 720 });
});
