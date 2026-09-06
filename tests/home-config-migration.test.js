const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONFIG_VERSION,
  normalizeState,
  serializeState,
} = require('../services/shell-config-state');
const {
  MAX_HOME_LINK_GROUPS,
  MAX_HOME_LINK_TILES_PER_GROUP,
  listHomeSiteMonitorTargets,
  normalizeHomeConfig,
} = require('../services/home-config-schema');

test('v23 migration seeds the home key with defaults on older payloads', () => {
  const state = normalizeState({ version: 22 });

  assert.equal(CONFIG_VERSION, 51);
  assert.deepEqual(state.home, {
    links: [],
    weather: { lat: null, lon: null, units: 'metric' },
    widgets: { order: [], hidden: [] },
    scratchpad: {
      notes: [{ id: 'note-1', title: 'Note 1', text: '', updatedAt: '', appendLog: false }],
      activeNoteId: 'note-1',
      settings: { rows: 6, font: 'prose', captureMode: 'append', markdown: false, globalCapture: true },
      pins: [],
    },
    calendar: { feeds: [], viewMode: 'agenda' },
    layout: { railWidth: 360 },
    focusMode: false,
    showContextualTips: false,
  });
});

test('v30 migration promotes a legacy scratchpad blob without data loss', () => {
  const state = normalizeState({
    version: 29,
    home: { scratchpad: { text: 'keep me', updatedAt: '2026-06-11T08:00:00.000Z' } },
  });
  assert.equal(state.version, CONFIG_VERSION);
  assert.equal(state.home.scratchpad.notes.length, 1);
  assert.equal(state.home.scratchpad.notes[0].text, 'keep me');
  assert.equal(state.home.scratchpad.notes[0].updatedAt, '2026-06-11T08:00:00.000Z');
  assert.equal(state.home.scratchpad.activeNoteId, 'note-1');

  // Idempotent: re-normalizing the serialized v30 state changes nothing.
  const twice = normalizeState(serializeState(state));
  assert.deepEqual(twice.home.scratchpad, state.home.scratchpad);
});

test('home migration is idempotent across repeated normalize passes', () => {
  const input = {
    version: 22,
    home: {
      links: [
        {
          name: 'Homelab',
          tiles: [
            { name: 'Pi-hole', href: 'http://pi.hole/admin', siteMonitor: 'http://pi.hole/admin' },
          ],
        },
      ],
      weather: { lat: 40.7, lon: -74.0, units: 'imperial' },
    },
  };
  const once = normalizeState(input);
  const twice = normalizeState(serializeState(once));

  assert.deepEqual(twice.home, once.home);
  assert.equal(once.home.links[0].tiles[0].id, twice.home.links[0].tiles[0].id);
});

test('home config rejects non-http hrefs and siteMonitor targets', () => {
  const home = normalizeHomeConfig({
    links: [
      {
        name: 'Mixed',
        tiles: [
          { name: 'ok', href: 'https://example.com' },
          { name: 'file', href: 'file:///C:/secrets.txt' },
          { name: 'js', href: 'javascript:alert(1)' },
          { name: 'bare', href: 'example.com' },
          { name: 'bad-monitor', href: 'https://ok.com', siteMonitor: 'ftp://nope' },
        ],
      },
    ],
  });

  assert.equal(home.links[0].tiles.length, 2);
  assert.equal(home.links[0].tiles[0].href, 'https://example.com');
  assert.equal(home.links[0].tiles[1].href, 'https://ok.com');
  assert.equal(home.links[0].tiles[1].siteMonitor, '');
});

test('home config caps group and tile counts', () => {
  const tiles = Array.from({ length: MAX_HOME_LINK_TILES_PER_GROUP + 5 }, (_, i) => ({
    name: `tile ${i}`,
    href: `https://example.com/${i}`,
  }));
  const groups = Array.from({ length: MAX_HOME_LINK_GROUPS + 3 }, (_, i) => ({
    name: `group ${i}`,
    tiles: [{ name: 'a', href: 'https://example.com' }],
  }));

  const capped = normalizeHomeConfig({ links: groups });
  assert.equal(capped.links.length, MAX_HOME_LINK_GROUPS);

  const cappedTiles = normalizeHomeConfig({ links: [{ name: 'big', tiles }] });
  assert.equal(cappedTiles.links[0].tiles.length, MAX_HOME_LINK_TILES_PER_GROUP);
});

test('home config derives stable unique slugs for ids', () => {
  const home = normalizeHomeConfig({
    links: [
      {
        name: 'Services',
        tiles: [
          { name: 'Pi-hole', href: 'https://a.example' },
          { name: 'Pi-hole', href: 'https://b.example' },
          { href: 'https://c.example' },
        ],
      },
    ],
  });
  const ids = home.links[0].tiles.map((tile) => tile.id);

  assert.equal(ids[0], 'pi-hole');
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids[2]);
});

test('home weather collapses half-configured locations and bad units', () => {
  assert.deepEqual(
    normalizeHomeConfig({ weather: { lat: 40.7, units: 'kelvin' } }).weather,
    { lat: null, lon: null, units: 'metric' }
  );
  assert.deepEqual(
    normalizeHomeConfig({ weather: { lat: 91, lon: 10 } }).weather,
    { lat: null, lon: null, units: 'metric' }
  );
  assert.deepEqual(
    normalizeHomeConfig({ weather: { lat: '40.7', lon: '-74', units: 'imperial' } }).weather,
    { lat: 40.7, lon: -74, units: 'imperial' }
  );
});

test('listHomeSiteMonitorTargets only surfaces explicit siteMonitor URLs', () => {
  const targets = listHomeSiteMonitorTargets({
    links: [
      {
        name: 'g',
        tiles: [
          { name: 'monitored', href: 'https://a.example', siteMonitor: 'https://a.example/health' },
          { name: 'plain', href: 'https://b.example' },
        ],
      },
    ],
  });

  assert.deepEqual(targets.map((t) => t.url), ['https://a.example/health']);
  assert.equal(targets[0].tileId, 'monitored');
});

test('home widgets config dedupes, caps, and rejects malformed ids', () => {
  const widgets = normalizeHomeConfig({
    widgets: {
      order: ['calendar', 'calendar', 'open-loops', '-bad-leading', 'has space', 42, ''],
      hidden: ['links', 'links', 'UPPER_ok-1'],
    },
  }).widgets;

  assert.deepEqual(widgets.order, ['calendar', 'open-loops']);
  assert.deepEqual(widgets.hidden, ['links', 'UPPER_ok-1']);

  const overflow = normalizeHomeConfig({
    widgets: { order: Array.from({ length: 80 }, (_, i) => `w-${i}`) },
  }).widgets;
  assert.equal(overflow.order.length, 64);

  assert.deepEqual(
    normalizeHomeConfig({ widgets: 'garbage' }).widgets,
    { order: [], hidden: [] }
  );
});

test('home scratchpad promotes a legacy single-blob into one named note', () => {
  const promoted = normalizeHomeConfig({
    scratchpad: { text: 'line one\nline two\n', updatedAt: '2026-06-11T10:00:00.000Z' },
  }).scratchpad;
  assert.equal(promoted.notes.length, 1);
  assert.equal(promoted.notes[0].id, 'note-1');
  assert.equal(promoted.notes[0].title, 'Note 1');
  assert.equal(promoted.notes[0].text, 'line one\nline two\n');
  assert.equal(promoted.notes[0].updatedAt, '2026-06-11T10:00:00.000Z');
  assert.equal(promoted.activeNoteId, 'note-1');
  assert.deepEqual(promoted.settings, { rows: 6, font: 'prose', captureMode: 'append', markdown: false, globalCapture: true });

  // A missing/garbage scratchpad still yields a single empty seed note.
  assert.deepEqual(normalizeHomeConfig({ scratchpad: { text: 42 } }).scratchpad.notes, [
    { id: 'note-1', title: 'Note 1', text: '', updatedAt: '', appendLog: false },
  ]);
});

test('home scratchpad notes preserve newlines, cap per-note text, and validate updatedAt', () => {
  const kept = normalizeHomeConfig({
    scratchpad: {
      notes: [{ id: 'a', title: 'A', text: 'line one\nline two\n', updatedAt: '2026-06-11T10:00:00.000Z' }],
      activeNoteId: 'a',
    },
  }).scratchpad;
  assert.equal(kept.notes[0].text, 'line one\nline two\n');
  assert.equal(kept.notes[0].updatedAt, '2026-06-11T10:00:00.000Z');

  const capped = normalizeHomeConfig({
    scratchpad: { notes: [{ id: 'a', text: 'x'.repeat(5000), updatedAt: 'yesterday' }] },
  }).scratchpad;
  assert.equal(capped.notes[0].text.length, 4000);
  assert.equal(capped.notes[0].updatedAt, '');
});

test('home scratchpad caps note count, titles, appendLog, and a dangling active id', () => {
  const overflow = normalizeHomeConfig({
    scratchpad: {
      notes: Array.from({ length: 12 }, (_, i) => ({ title: `Note ${i}`, text: String(i) })),
      activeNoteId: 'does-not-exist',
    },
  }).scratchpad;
  assert.equal(overflow.notes.length, 8);
  assert.equal(new Set(overflow.notes.map((n) => n.id)).size, 8);
  // A dangling activeNoteId falls back to the first surviving note.
  assert.equal(overflow.activeNoteId, overflow.notes[0].id);

  const clamped = normalizeHomeConfig({
    scratchpad: { notes: [{ id: 'a', title: 'x'.repeat(200), appendLog: 'yes' }] },
  }).scratchpad;
  assert.equal(clamped.notes[0].title.length, 60);
  assert.equal(clamped.notes[0].appendLog, false);
  assert.equal(
    normalizeHomeConfig({ scratchpad: { notes: [{ id: 'a', appendLog: true }] } }).scratchpad.notes[0].appendLog,
    true
  );
});

test('home scratchpad settings clamp rows and enum font/captureMode', () => {
  const big = normalizeHomeConfig({ scratchpad: { settings: { rows: 1000, font: 'COMIC', captureMode: 'nuke' } } }).scratchpad;
  assert.deepEqual(big.settings, { rows: 30, font: 'prose', captureMode: 'append', markdown: false, globalCapture: true });
  const small = normalizeHomeConfig({ scratchpad: { settings: { rows: 0, font: 'mono', captureMode: 'append' } } }).scratchpad;
  assert.deepEqual(small.settings, { rows: 3, font: 'mono', captureMode: 'append', markdown: false, globalCapture: true });
  const nan = normalizeHomeConfig({ scratchpad: { settings: { rows: 'x' } } }).scratchpad;
  assert.equal(nan.settings.rows, 6);
});

test('home scratchpad settings carry the markdown + globalCapture opt-ins', () => {
  // Defaults: markdown off, globalCapture on.
  const def = normalizeHomeConfig({ scratchpad: { settings: {} } }).scratchpad.settings;
  assert.equal(def.markdown, false);
  assert.equal(def.globalCapture, true);
  // Only a literal true enables markdown; only a literal false disables the
  // global chord — every other value falls back to the safe default.
  const on = normalizeHomeConfig({ scratchpad: { settings: { markdown: true, globalCapture: false } } }).scratchpad.settings;
  assert.equal(on.markdown, true);
  assert.equal(on.globalCapture, false);
  const fuzzy = normalizeHomeConfig({ scratchpad: { settings: { markdown: 'yes', globalCapture: 'no' } } }).scratchpad.settings;
  assert.equal(fuzzy.markdown, false);
  assert.equal(fuzzy.globalCapture, true);
});

test('home scratchpad keeps note ids stable across a rename (id round-trips)', () => {
  const once = normalizeHomeConfig({
    scratchpad: { notes: [{ id: 'note-1', title: 'Original', text: 'body' }], activeNoteId: 'note-1' },
  }).scratchpad;
  // Same id, new title -> id must NOT re-derive from the new title.
  const renamed = normalizeHomeConfig({
    scratchpad: { notes: [{ id: once.notes[0].id, title: 'Renamed', text: 'body' }], activeNoteId: 'note-1' },
  }).scratchpad;
  assert.equal(renamed.notes[0].id, once.notes[0].id);
  assert.equal(renamed.notes[0].title, 'Renamed');
});

test('home focusMode only accepts a literal true', () => {
  assert.equal(normalizeHomeConfig({ focusMode: true }).focusMode, true);
  assert.equal(normalizeHomeConfig({ focusMode: 'true' }).focusMode, false);
  assert.equal(normalizeHomeConfig({ focusMode: 1 }).focusMode, false);
  assert.equal(normalizeHomeConfig({}).focusMode, false);
});

test('home calendar feeds require http urls and clamp colors to the palette-safe enum', () => {
  const calendar = normalizeHomeConfig({
    calendar: {
      feeds: [
        { name: 'Team', url: 'https://outlook.example/calendar.ics', colorId: 'meeting' },
        { name: 'Bad color', url: 'https://a.example/c.ics', colorId: '#ff0000' },
        { name: 'No url', colorId: 'work' },
        { name: 'File', url: 'file:///C:/cal.ics' },
        { name: 'Case', url: 'https://b.example/c.ics', colorId: 'WORK' },
      ],
    },
  }).calendar;

  assert.equal(calendar.feeds.length, 3);
  assert.equal(calendar.feeds[0].colorId, 'meeting');
  assert.equal(calendar.feeds[0].id, 'team');
  assert.equal(calendar.feeds[1].colorId, 'default');
  assert.equal(calendar.feeds[2].colorId, 'work');
});

test('home calendar feeds cap count and keep ids unique and stable', () => {
  const feeds = Array.from({ length: 12 }, (_, i) => ({
    name: 'Same Name',
    url: `https://example.com/${i}.ics`,
  }));
  const once = normalizeHomeConfig({ calendar: { feeds } }).calendar;
  assert.equal(once.feeds.length, 8);
  assert.equal(new Set(once.feeds.map((f) => f.id)).size, once.feeds.length);

  const twice = normalizeHomeConfig({ calendar: once }).calendar;
  assert.deepEqual(twice, once);

  assert.deepEqual(normalizeHomeConfig({ calendar: 'junk' }).calendar, { feeds: [], viewMode: 'agenda' });
});

test('home calendar viewMode normalizes to the enum and defaults to agenda', () => {
  assert.equal(normalizeHomeConfig({ calendar: { viewMode: 'week' } }).calendar.viewMode, 'week');
  assert.equal(normalizeHomeConfig({ calendar: { viewMode: 'month' } }).calendar.viewMode, 'month');
  assert.equal(normalizeHomeConfig({ calendar: { viewMode: 'AGENDA' } }).calendar.viewMode, 'agenda');
  assert.equal(normalizeHomeConfig({ calendar: { viewMode: 'list' } }).calendar.viewMode, 'agenda');
  assert.equal(normalizeHomeConfig({ calendar: {} }).calendar.viewMode, 'agenda');
});

test('new home fields normalize idempotently', () => {
  const input = {
    widgets: { order: ['a1', 'b2'], hidden: ['c3'] },
    scratchpad: { text: ' keep edges \n', updatedAt: '2026-06-11T09:00' },
    focusMode: true,
  };
  const once = normalizeHomeConfig(input);
  const twice = normalizeHomeConfig(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
});

test('serializeState round-trips the home key', () => {
  const state = normalizeState({
    home: {
      links: [{ name: 'Lab', tiles: [{ name: 'Pi', href: 'https://pi.example' }] }],
      weather: { lat: 1, lon: 2, units: 'metric' },
    },
  });
  const serialized = serializeState(state);

  assert.deepEqual(serialized.home, state.home);
  assert.equal(serialized.version, CONFIG_VERSION);
});

test('home scratchpad pins are validated, deduped, capped, and order-preserved', () => {
  const sp = normalizeHomeConfig({
    scratchpad: {
      notes: [
        { id: 'note-1' }, { id: 'note-2' }, { id: 'note-3' },
        { id: 'note-4' }, { id: 'note-5' },
      ],
      pins: ['note-2', 'ghost', 'note-2', 'note-1', 'note-3', 'note-4', 'note-5'],
    },
  }).scratchpad;
  // 'ghost' (no matching note) dropped, the duplicate 'note-2' collapsed, the
  // surviving ids capped at 4 in first-seen order (note-5 never reached).
  assert.deepEqual(sp.pins, ['note-2', 'note-1', 'note-3', 'note-4']);
});

test('home scratchpad pins default to [] and cross-validate away a missing note', () => {
  // Absent pins backfill to an empty list (additive, lossless on old configs).
  assert.deepEqual(
    normalizeHomeConfig({ scratchpad: { notes: [{ id: 'note-1' }] } }).scratchpad.pins,
    []
  );
  // A pin whose note no longer exists is dropped on the next read.
  assert.deepEqual(
    normalizeHomeConfig({ scratchpad: { notes: [{ id: 'note-1' }], pins: ['note-1', 'note-9'] } }).scratchpad.pins,
    ['note-1']
  );
});

test('home scratchpad pins reject non-array + non-string junk', () => {
  assert.deepEqual(
    normalizeHomeConfig({ scratchpad: { notes: [{ id: 'note-1' }], pins: 'note-1' } }).scratchpad.pins,
    []
  );
  assert.deepEqual(
    normalizeHomeConfig({ scratchpad: { notes: [{ id: 'note-1' }], pins: [1, null, {}, 'note-1'] } }).scratchpad.pins,
    ['note-1']
  );
});
