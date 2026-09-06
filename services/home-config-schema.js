const { normalizeString } = require('./backend/path-utils');

// Home dashboard config schema (shell-config `home` key, introduced at
// CONFIG_VERSION 23). Pure normalize functions only — no I/O — so both
// shell-config-state and tests can use them directly.
const MAX_HOME_LINK_GROUPS = 12;
const MAX_HOME_LINK_TILES_PER_GROUP = 24;
const MAX_HOME_LINK_NAME_CHARS = 80;
const MAX_HOME_LINK_ICON_CHARS = 300;
const HOME_WEATHER_UNITS = Object.freeze(['metric', 'imperial']);
const MAX_HOME_WIDGET_ORDER_IDS = 64;
const MAX_HOME_WIDGET_HIDDEN_IDS = 32;
const MAX_HOME_WIDGET_ID_CHARS = 48;
// Mirrors the dashboard registry's widget-id rule so config can never hold an
// id the registry would have rejected at registration time.
const HOME_WIDGET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const MAX_HOME_SCRATCHPAD_CHARS = 4000;
// Scratchpad v2: the single { text } blob became a small set of named notes
// (tabs). The cap is deliberately low — this is a quick-capture surface, not a
// note manager; more than a handful of tabs would make the Home card unwieldy.
const MAX_HOME_SCRATCHPAD_NOTES = 8;
const MAX_HOME_SCRATCHPAD_TITLE_CHARS = 60;
// Pinned-note ids (the sticky-note overlay). A small cap keeps the corner stack
// tidy; the ids are cross-validated against surviving notes on every read, so a
// deleted note's id can never linger as a dangling pin.
const MAX_HOME_SCRATCHPAD_PINS = 4;
const HOME_SCRATCHPAD_FONTS = Object.freeze(['prose', 'mono']);
const HOME_SCRATCHPAD_CAPTURE_MODES = Object.freeze(['overwrite', 'append']);
const HOME_SCRATCHPAD_ROWS_MIN = 3;
const HOME_SCRATCHPAD_ROWS_MAX = 30;
const HOME_SCRATCHPAD_ROWS_DEFAULT = 6;
const MAX_HOME_CALENDAR_FEEDS = 8;
// Feed colors are palette-safe category-hue ids, never raw hex: each id maps
// to themed --cal-cat-* CSS token pairs, so user-configured feeds can't pick
// a color that breaks contrast under a light palette. Shared with the local
// event category set (services/home-calendar-schema.js builds on this list).
const HOME_CALENDAR_COLOR_IDS = Object.freeze([
  'default',
  'work',
  'personal',
  'focus',
  'meeting',
  'errand',
]);
// Default view of the calendar widget. 'agenda' is the glanceable default;
// 'week' is the time-grid drill-down; 'month' is the Outlook-style continuous
// vertical scroll of week rows. Persisted so the choice survives reloads.
const HOME_CALENDAR_VIEW_MODES = Object.freeze(['agenda', 'week', 'month']);
const DEFAULT_HOME_CALENDAR_VIEW_MODE = 'agenda';
// Home shell layout. The rail is the persistent left column; its width is a
// user-draggable pixel value, clamped so the rail can never be dragged to a
// width that hides its content or starves the main column.
const HOME_LAYOUT_RAIL_WIDTH_MIN = 280;
const HOME_LAYOUT_RAIL_WIDTH_MAX = 720;
const HOME_LAYOUT_RAIL_WIDTH_DEFAULT = 360;

const DEFAULT_HOME_WEATHER = Object.freeze({
  lat: null,
  lon: null,
  units: 'metric',
});

const DEFAULT_HOME_WIDGETS = Object.freeze({
  order: Object.freeze([]),
  hidden: Object.freeze([]),
});

const DEFAULT_HOME_SCRATCHPAD_SETTINGS = Object.freeze({
  rows: HOME_SCRATCHPAD_ROWS_DEFAULT,
  font: 'prose',
  // Quick-capture (/note + Ctrl+Shift+Space) appends a timestamped line by
  // default so a capture never silently wipes the active note; 'overwrite' is
  // the opt-in for a single-line "current thought" pad.
  captureMode: 'append',
  // Opt-in markdown/checklist preview. Default-off keeps the plain-text pad and
  // the plain autosave path completely unchanged.
  markdown: false,
  // Global quick-capture chord (Ctrl+Shift+Space). On by default; a user who
  // finds a global hotkey intrusive can turn it off without losing /note.
  globalCapture: true,
});

// The widget always has exactly one active note to render into, so the default
// (and the normalizer) always emit at least one seed note — the renderer never
// has to special-case an empty pad.
const DEFAULT_HOME_SCRATCHPAD = Object.freeze({
  notes: Object.freeze([
    Object.freeze({ id: 'note-1', title: 'Note 1', text: '', updatedAt: '', appendLog: false }),
  ]),
  activeNoteId: 'note-1',
  settings: DEFAULT_HOME_SCRATCHPAD_SETTINGS,
  // Mirrors the normalizer output (no pins on a fresh pad) so DEFAULT == fresh-normalized.
  pins: Object.freeze([]),
});

const DEFAULT_HOME_CALENDAR = Object.freeze({
  feeds: Object.freeze([]),
  viewMode: DEFAULT_HOME_CALENDAR_VIEW_MODE,
});

const DEFAULT_HOME_LAYOUT = Object.freeze({
  railWidth: HOME_LAYOUT_RAIL_WIDTH_DEFAULT,
});

const DEFAULT_HOME = Object.freeze({
  links: Object.freeze([]),
  weather: DEFAULT_HOME_WEATHER,
  widgets: DEFAULT_HOME_WIDGETS,
  scratchpad: DEFAULT_HOME_SCRATCHPAD,
  calendar: DEFAULT_HOME_CALENDAR,
  layout: DEFAULT_HOME_LAYOUT,
  focusMode: false,
  // One durable owner for contextual Home guidance. The retired
  // featureOverrides.tips_surface + tips.enabled pair is migrated here by the
  // shell-config v45 migration.
  showContextualTips: true,
});

// Same acceptance rule as openaiCompatible.apiUrl: only http(s) URLs survive,
// anything else (file paths, protocol-less strings, javascript:) collapses to
// empty so the renderer never opens or polls an unvetted target.
function normalizeHomeHttpUrl(value) {
  const normalized = normalizeString(value);
  return /^https?:\/\/[^\s]+$/i.test(normalized) ? normalized : '';
}

function normalizeHomeLinkName(value) {
  return normalizeString(value).slice(0, MAX_HOME_LINK_NAME_CHARS);
}

// Icon is a free-form reference string classified later by the renderer
// resolver (mdi-<name>, si-<name>, https URL, or text used as an abbr
// fallback). Validation here only bounds length and strips control chars.
function normalizeHomeLinkIcon(value) {
  const normalized = normalizeString(value).slice(0, MAX_HOME_LINK_ICON_CHARS);
  return /[\r\n\0]/.test(normalized) ? '' : normalized;
}

// Deterministic id derivation (no randomness: ids must be stable across
// normalize passes so link-status maps keyed by tile id stay valid).
function slugifyHomeId(value, fallback) {
  const slug = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function claimHomeId(candidate, seenIds, fallback) {
  let id = candidate || fallback;
  if (seenIds.has(id)) {
    id = `${id}-${fallback}`;
  }
  while (seenIds.has(id)) {
    id = `${id}x`;
  }
  seenIds.add(id);
  return id;
}

function normalizeHomeLinkTile(value, index, seenIds) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const href = normalizeHomeHttpUrl(source.href);
  if (!href) {
    return null;
  }
  const name = normalizeHomeLinkName(source.name);
  const fallbackId = `tile-${index + 1}`;
  const requestedId = slugifyHomeId(source.id || name, fallbackId);
  return {
    id: claimHomeId(requestedId, seenIds, fallbackId),
    name,
    href,
    icon: normalizeHomeLinkIcon(source.icon),
    siteMonitor: normalizeHomeHttpUrl(source.siteMonitor ?? source.site_monitor),
  };
}

function normalizeHomeLinkGroup(value, index, seenGroupIds, seenTileIds) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const name = normalizeHomeLinkName(source.name);
  const rawTiles = Array.isArray(source.tiles) ? source.tiles : [];
  const tiles = [];
  for (const tile of rawTiles) {
    if (tiles.length >= MAX_HOME_LINK_TILES_PER_GROUP) {
      break;
    }
    const normalized = normalizeHomeLinkTile(tile, seenTileIds.size, seenTileIds);
    if (normalized) {
      tiles.push(normalized);
    }
  }
  if (!name && tiles.length === 0) {
    return null;
  }
  const fallbackId = `group-${index + 1}`;
  const requestedId = slugifyHomeId(source.id || name, fallbackId);
  return {
    id: claimHomeId(requestedId, seenGroupIds, fallbackId),
    name,
    tiles,
  };
}

function normalizeHomeLinks(value) {
  const rawGroups = Array.isArray(value) ? value : [];
  const seenGroupIds = new Set();
  const seenTileIds = new Set();
  const groups = [];
  for (const group of rawGroups) {
    if (groups.length >= MAX_HOME_LINK_GROUPS) {
      break;
    }
    const normalized = normalizeHomeLinkGroup(group, groups.length, seenGroupIds, seenTileIds);
    if (normalized) {
      groups.push(normalized);
    }
  }
  return groups;
}

function normalizeHomeWeatherCoordinate(value, limit) {
  // Number(null) and Number('') are 0 — only real numeric input may yield a
  // coordinate, otherwise an unset location round-trips back to unset.
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) {
    return null;
  }
  return parsed;
}

function normalizeHomeWeather(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const units = normalizeString(source.units).toLowerCase();
  const lat = normalizeHomeWeatherCoordinate(source.lat, 90);
  const lon = normalizeHomeWeatherCoordinate(source.lon, 180);
  return {
    // A location is only usable as a pair; a lone coordinate collapses to
    // unset so the weather service never polls a half-configured location.
    lat: lat !== null && lon !== null ? lat : null,
    lon: lat !== null && lon !== null ? lon : null,
    units: HOME_WEATHER_UNITS.includes(units) ? units : DEFAULT_HOME_WEATHER.units,
  };
}

function normalizeHomeWidgetIdList(value, limit) {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set();
  const ids = [];
  for (const entry of raw) {
    if (ids.length >= limit) {
      break;
    }
    if (typeof entry !== 'string') {
      continue;
    }
    const id = normalizeString(entry).slice(0, MAX_HOME_WIDGET_ID_CHARS);
    if (!HOME_WIDGET_ID_PATTERN.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// Ids that match no registered widget survive normalization deliberately:
// they are inert at render time, and shedding them here would make config
// written by a newer build lossy when read by an older one.
function normalizeHomeWidgets(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    order: normalizeHomeWidgetIdList(source.order, MAX_HOME_WIDGET_ORDER_IDS),
    hidden: normalizeHomeWidgetIdList(source.hidden, MAX_HOME_WIDGET_HIDDEN_IDS),
  };
}

// A single scratchpad note. Note text is the one home-config string that keeps
// user formatting: no trim and no whitespace collapse, or autosave round-trips
// would eat the newlines the user just typed. Only NUL (JSON-hostile) is
// stripped. Ids are deterministic (slug of id|title) so per-note UI state and
// the active-note pointer stay valid across normalize passes — the same rule
// link tiles and calendar feeds rely on.
function normalizeHomeScratchpadNote(value, index, seenIds) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = typeof source.text === 'string'
    ? source.text.replace(/\0/g, '').slice(0, MAX_HOME_SCRATCHPAD_CHARS)
    : '';
  const title = normalizeString(source.title).slice(0, MAX_HOME_SCRATCHPAD_TITLE_CHARS);
  const updatedAt = normalizeString(source.updatedAt);
  const fallbackId = `note-${index + 1}`;
  const requestedId = slugifyHomeId(source.id || title, fallbackId);
  return {
    id: claimHomeId(requestedId, seenIds, fallbackId),
    title,
    text,
    updatedAt: /^\d{4}-\d{2}-\d{2}T/.test(updatedAt) ? updatedAt : '',
    appendLog: source.appendLog === true,
  };
}

function normalizeHomeScratchpadSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rowsRaw = Number(source.rows);
  const rows = Number.isFinite(rowsRaw)
    ? Math.min(HOME_SCRATCHPAD_ROWS_MAX, Math.max(HOME_SCRATCHPAD_ROWS_MIN, Math.trunc(rowsRaw)))
    : HOME_SCRATCHPAD_ROWS_DEFAULT;
  const font = normalizeString(source.font).toLowerCase();
  const captureMode = normalizeString(source.captureMode).toLowerCase();
  return {
    rows,
    font: HOME_SCRATCHPAD_FONTS.includes(font) ? font : 'prose',
    captureMode: HOME_SCRATCHPAD_CAPTURE_MODES.includes(captureMode) ? captureMode : 'append',
    // Additive opt-in fields (no CONFIG_VERSION bump needed: this normalizer
    // is always-on and runs on every read, so a pre-existing v30 config simply
    // gains the defaults on its next load — lossless and idempotent).
    markdown: source.markdown === true,
    globalCapture: source.globalCapture !== false,
  };
}

// Pinned-note ids for the sticky-note overlay: an ordered, deduped list whose
// entries MUST reference a surviving note (a deleted note's id is dropped here,
// so the overlay never renders a dangling chip). Additive + capped, like the
// settings opt-in fields — a pre-existing config without `pins` simply reads back
// as an empty list. Cross-validated against the already-normalized notes.
function normalizeHomeScratchpadPins(value, notes) {
  const raw = Array.isArray(value) ? value : [];
  const validIds = new Set(notes.map((note) => note.id));
  const seen = new Set();
  const pins = [];
  for (const entry of raw) {
    if (pins.length >= MAX_HOME_SCRATCHPAD_PINS) {
      break;
    }
    if (typeof entry !== 'string') {
      continue;
    }
    const id = normalizeString(entry);
    if (!validIds.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    pins.push(id);
  }
  return pins;
}

// Accepts BOTH the new { notes, activeNoteId, settings } shape and the legacy
// pre-v30 { text, updatedAt } single-blob, promoting the latter into one seed
// note with no data loss. Migrations re-run this on read, so it must be total
// over both shapes and idempotent on its own output. Always emits >= 1 note so
// the widget never has to handle an empty pad; activeNoteId is cross-validated
// against the surviving notes and falls back to the first.
function normalizeHomeScratchpad(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  let rawNotes;
  if (Array.isArray(source.notes)) {
    rawNotes = source.notes;
  } else if (typeof source.text === 'string') {
    rawNotes = [{ id: 'note-1', title: 'Note 1', text: source.text, updatedAt: source.updatedAt }];
  } else {
    rawNotes = [];
  }
  const seenIds = new Set();
  const notes = [];
  for (const note of rawNotes) {
    if (notes.length >= MAX_HOME_SCRATCHPAD_NOTES) {
      break;
    }
    notes.push(normalizeHomeScratchpadNote(note, notes.length, seenIds));
  }
  if (notes.length === 0) {
    notes.push(normalizeHomeScratchpadNote({ id: 'note-1', title: 'Note 1' }, 0, seenIds));
  }
  const requestedActive = normalizeString(source.activeNoteId);
  const activeNoteId = notes.some((note) => note.id === requestedActive)
    ? requestedActive
    : notes[0].id;
  return {
    notes,
    activeNoteId,
    settings: normalizeHomeScratchpadSettings(source.settings),
    pins: normalizeHomeScratchpadPins(source.pins, notes),
  };
}

// ICS feed subscriptions: read-only calendar URLs the calendar service polls.
// Same http(s)-only acceptance rule as link tiles — a feed without a valid
// URL is dropped entirely (there is nothing useful to keep).
function normalizeHomeCalendarFeed(value, index, seenIds) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const url = normalizeHomeHttpUrl(source.url);
  if (!url) {
    return null;
  }
  const name = normalizeHomeLinkName(source.name);
  const colorId = normalizeString(source.colorId).toLowerCase();
  const fallbackId = `feed-${index + 1}`;
  const requestedId = slugifyHomeId(source.id || name, fallbackId);
  return {
    id: claimHomeId(requestedId, seenIds, fallbackId),
    name,
    url,
    colorId: HOME_CALENDAR_COLOR_IDS.includes(colorId) ? colorId : 'default',
  };
}

function normalizeHomeCalendar(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawFeeds = Array.isArray(source.feeds) ? source.feeds : [];
  const seenIds = new Set();
  const feeds = [];
  for (const feed of rawFeeds) {
    if (feeds.length >= MAX_HOME_CALENDAR_FEEDS) {
      break;
    }
    const normalized = normalizeHomeCalendarFeed(feed, feeds.length, seenIds);
    if (normalized) {
      feeds.push(normalized);
    }
  }
  const viewMode = normalizeString(source.viewMode).toLowerCase();
  return {
    feeds,
    viewMode: HOME_CALENDAR_VIEW_MODES.includes(viewMode) ? viewMode : DEFAULT_HOME_CALENDAR_VIEW_MODE,
  };
}

// Shell layout geometry. Additive + always-on like the scratchpad opt-ins, so
// no CONFIG_VERSION bump is needed: the normalizer is total over any prior
// payload (a config without `layout` simply reads back the default) and
// idempotent on its own output. Non-numeric input collapses to the default
// rather than to a clamp endpoint, so a corrupt value never pins the rail wide.
function normalizeHomeLayout(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawValue = source.railWidth ?? source.rail_width;
  if (rawValue == null || (typeof rawValue === 'string' && !rawValue.trim())) {
    return { railWidth: HOME_LAYOUT_RAIL_WIDTH_DEFAULT };
  }
  const raw = Number(rawValue);
  if (!Number.isFinite(raw)) {
    return { railWidth: HOME_LAYOUT_RAIL_WIDTH_DEFAULT };
  }
  return {
    railWidth: Math.min(
      HOME_LAYOUT_RAIL_WIDTH_MAX,
      Math.max(HOME_LAYOUT_RAIL_WIDTH_MIN, Math.trunc(raw))
    ),
  };
}

function normalizeHomeConfig(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    links: normalizeHomeLinks(source.links),
    weather: normalizeHomeWeather(source.weather),
    widgets: normalizeHomeWidgets(source.widgets),
    scratchpad: normalizeHomeScratchpad(source.scratchpad),
    calendar: normalizeHomeCalendar(source.calendar),
    layout: normalizeHomeLayout(source.layout),
    focusMode: source.focusMode === true,
    showContextualTips: source.showContextualTips !== false,
  };
}

// The only URLs the calendar feed poller is ever allowed to fetch.
function listHomeCalendarFeeds(homeConfig) {
  return normalizeHomeConfig(homeConfig).calendar.feeds;
}

// Flattens every tile that has a siteMonitor target — the only URLs the
// link-status poller is ever allowed to touch (never the tile href).
function listHomeSiteMonitorTargets(homeConfig) {
  const normalized = normalizeHomeConfig(homeConfig);
  const targets = [];
  for (const group of normalized.links) {
    for (const tile of group.tiles) {
      if (tile.siteMonitor) {
        targets.push({ tileId: tile.id, url: tile.siteMonitor });
      }
    }
  }
  return targets;
}

module.exports = {
  DEFAULT_HOME,
  DEFAULT_HOME_WEATHER,
  DEFAULT_HOME_WIDGETS,
  DEFAULT_HOME_SCRATCHPAD,
  DEFAULT_HOME_SCRATCHPAD_SETTINGS,
  DEFAULT_HOME_CALENDAR,
  DEFAULT_HOME_CALENDAR_VIEW_MODE,
  DEFAULT_HOME_LAYOUT,
  HOME_LAYOUT_RAIL_WIDTH_MIN,
  HOME_LAYOUT_RAIL_WIDTH_MAX,
  HOME_LAYOUT_RAIL_WIDTH_DEFAULT,
  HOME_CALENDAR_COLOR_IDS,
  HOME_CALENDAR_VIEW_MODES,
  HOME_SCRATCHPAD_FONTS,
  HOME_SCRATCHPAD_CAPTURE_MODES,
  HOME_SCRATCHPAD_ROWS_MIN,
  HOME_SCRATCHPAD_ROWS_MAX,
  HOME_SCRATCHPAD_ROWS_DEFAULT,
  HOME_WEATHER_UNITS,
  MAX_HOME_LINK_GROUPS,
  MAX_HOME_LINK_TILES_PER_GROUP,
  MAX_HOME_LINK_NAME_CHARS,
  MAX_HOME_LINK_ICON_CHARS,
  MAX_HOME_WIDGET_ORDER_IDS,
  MAX_HOME_WIDGET_HIDDEN_IDS,
  MAX_HOME_SCRATCHPAD_CHARS,
  MAX_HOME_SCRATCHPAD_NOTES,
  MAX_HOME_SCRATCHPAD_TITLE_CHARS,
  MAX_HOME_SCRATCHPAD_PINS,
  MAX_HOME_CALENDAR_FEEDS,
  listHomeCalendarFeeds,
  listHomeSiteMonitorTargets,
  normalizeHomeConfig,
  normalizeHomeLinkGroup,
  normalizeHomeLinkTile,
  normalizeHomeLinks,
  normalizeHomeWeather,
  normalizeHomeWidgets,
  normalizeHomeScratchpad,
  normalizeHomeScratchpadNote,
  normalizeHomeScratchpadSettings,
  normalizeHomeCalendar,
  normalizeHomeLayout,
  normalizeHomeHttpUrl,
};
