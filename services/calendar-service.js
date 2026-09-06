'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { FileJsonStore } = require('./backend/file-json-store');
const { requestWithTimeout } = require('./http-fetch-util');
const { listHomeCalendarFeeds } = require('./home-config-schema');
const {
  HOME_CALENDAR_CATEGORIES,
  MAX_CALENDAR_EVENTS,
  computeCalendarWindow,
  compareInstances,
  expandCalendarEvents,
  formatLocalDateTime,
  normalizeCalendarEvent,
  normalizeCalendarEventList,
} = require('./home-calendar-schema');
const { extractIcsInstances } = require('./ics-parse-util');

// Home dashboard calendar service: owns local events (dedicated store —
// events grow and write on user action, so they stay out of the hot
// shell-config blob) and polls read-only ICS feed subscriptions from
// shell-config `home.calendar.feeds`, mirroring the weather/link-status
// poller conventions (EventEmitter + unref'd interval + JSON-deduped emits).
//
// Local events are re-expanded on every getState (cheap, capped store), so
// the renderer always sees the current -7d..+60d window. Feed instances are
// expanded at fetch time and refreshed every poll, so their window lags at
// most one poll interval.
const DEFAULT_CALENDAR_POLL_INTERVAL_MS = 15 * 60 * 1000;
const CALENDAR_STORE_FILE = 'home-calendar.json';
const CALENDAR_STORE_VERSION = 1;

function createEmptyCalendarSnapshot() {
  return {
    generatedAt: '',
    windowStart: '',
    windowEnd: '',
    categories: HOME_CALENDAR_CATEGORIES.map((category) => ({ ...category })),
    instances: [],
    events: [],
    feeds: [],
  };
}

function buildFeedWarning(entry) {
  const parts = [];
  if (entry.error) {
    parts.push(entry.error);
  }
  if (entry.skippedCount > 0) {
    parts.push(`${entry.skippedCount} event${entry.skippedCount === 1 ? '' : 's'} skipped`);
  }
  if (entry.unsupportedRruleCount > 0) {
    parts.push(
      `${entry.unsupportedRruleCount} recurring event${entry.unsupportedRruleCount === 1 ? '' : 's'} partially shown`
    );
  }
  return parts.join('; ');
}

class CalendarService extends EventEmitter {
  constructor({
    userDataPath,
    configService,
    store,
    fetchImpl = globalThis.fetch,
    logger = () => {},
    nowProvider = () => new Date(),
    pollIntervalMs = DEFAULT_CALENDAR_POLL_INTERVAL_MS,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    super();
    if (!configService) {
      throw new Error('configService is required for CalendarService.');
    }
    if (!store && !userDataPath) {
      throw new Error('userDataPath (or an injected store) is required for CalendarService.');
    }
    this.configService = configService;
    this.store = store || new FileJsonStore(path.join(userDataPath, CALENDAR_STORE_FILE), {
      logger,
    });
    this.fetchImpl = fetchImpl;
    this.logger = typeof logger === 'function' ? logger : () => {};
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
    this.pollIntervalMs = Math.max(Number(pollIntervalMs) || DEFAULT_CALENDAR_POLL_INTERVAL_MS, 60_000);
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.events = normalizeCalendarEventList(this.store.read({})?.events);
    /** @type {Map<string, Object>} feedId -> last fetch outcome (instances kept on failure) */
    this._feedCache = new Map();
    this._timer = null;
    this._refreshPromise = null;
    this._refreshQueued = false;
    this._lastEmitKey = '';
    this._idCounter = 0;
    this._handleConfigChanged = this._handleConfigChanged.bind(this);
  }

  start({ deferInitialRefresh = false } = {}) {
    if (this._timer) {
      return;
    }
    this.configService.on('changed', this._handleConfigChanged);
    this._timer = this.setIntervalImpl(() => {
      void this.refreshFeeds();
    }, this.pollIntervalMs);
    if (typeof this._timer?.unref === 'function') {
      this._timer.unref();
    }
    if (!deferInitialRefresh) {
      void this.refreshFeeds();
    }
  }

  stop() {
    if (typeof this.configService.off === 'function') {
      this.configService.off('changed', this._handleConfigChanged);
    } else if (typeof this.configService.removeListener === 'function') {
      this.configService.removeListener('changed', this._handleConfigChanged);
    }
    if (this._timer) {
      this.clearIntervalImpl(this._timer);
      this._timer = null;
    }
  }

  getState() {
    const now = this.nowProvider();
    const window = computeCalendarWindow(now);
    const feeds = this._readConfiguredFeeds();
    const instances = expandCalendarEvents(this.events, window);
    const feedsMeta = [];
    for (const feed of feeds) {
      const entry = this._feedCache.get(feed.id);
      feedsMeta.push({
        id: feed.id,
        name: feed.name,
        colorId: feed.colorId,
        lastFetchedAt: entry?.fetchedAt || '',
        ok: entry ? entry.ok : false,
        warning: entry ? buildFeedWarning(entry) : '',
        skippedCount: entry?.skippedCount || 0,
      });
      if (!entry) {
        continue;
      }
      for (const instance of entry.instances) {
        instances.push({
          instanceId: `feed:${feed.id}:${instance.uid || 'event'}:${instance.start}`,
          eventId: '',
          source: 'feed',
          feedId: feed.id,
          readonly: true,
          title: instance.title,
          start: instance.start,
          end: instance.end,
          allDay: instance.allDay,
          categoryId: feed.colorId,
          notes: instance.notes,
          recurring: instance.recurring,
          recurrenceUnsupported: instance.recurrenceUnsupported === true,
          tzApprox: instance.tzApprox === true,
        });
      }
    }
    instances.sort(compareInstances);
    return {
      generatedAt: now.toISOString(),
      windowStart: formatLocalDateTime(window.windowStart),
      windowEnd: formatLocalDateTime(window.windowEnd),
      categories: HOME_CALENDAR_CATEGORIES.map((category) => ({ ...category })),
      instances,
      // Local source events ride along so the renderer's edit form can seed
      // from the SERIES anchor (recurrence/notes), not the clicked occurrence.
      events: this.events.map((event) => ({ ...event })),
      feeds: feedsMeta,
    };
  }

  createEvent(payload = {}) {
    if (this.events.length >= MAX_CALENDAR_EVENTS) {
      throw new Error(`calendar store is full (${MAX_CALENDAR_EVENTS} events)`);
    }
    const nowIso = this.nowProvider().toISOString();
    const event = normalizeCalendarEvent({
      ...payload,
      id: this._generateEventId(),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    if (!event) {
      throw new Error('calendar event requires a valid start time');
    }
    this.events = [...this.events, event];
    this._persistEvents();
    this._emitChangedIfNeeded();
    return this.getState();
  }

  updateEvent(id, patch = {}) {
    const eventId = String(id || '').trim();
    const existing = this.events.find((event) => event.id === eventId);
    if (!existing) {
      throw new Error(`calendar event not found: ${eventId || '(empty id)'}`);
    }
    const safePatch = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    // "This event only": a control field on the existing update channel (the
    // IPC contract is at its line ceiling, so no new channel) — detach the one
    // occurrence and re-create it standalone, atomically.
    const occurrenceStart = String(safePatch.occurrenceStart || '').trim();
    if (occurrenceStart && existing.recurrence !== 'none') {
      return this._splitOccurrence(existing, occurrenceStart, safePatch);
    }
    const { occurrenceStart: _ignoredScope, ...seriesPatch } = safePatch;
    const updated = normalizeCalendarEvent({
      ...existing,
      ...seriesPatch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.nowProvider().toISOString(),
    });
    if (!updated) {
      throw new Error('calendar event update requires a valid start time');
    }
    this.events = this.events.map((event) => (event.id === eventId ? updated : event));
    this._persistEvents();
    this._emitChangedIfNeeded();
    return this.getState();
  }

  // Splits a single occurrence out of a recurring series: the anchor gains an
  // EXDATE-style exception for that occurrence start, and the edited values
  // become a fresh non-recurring event. One persist + one snapshot.
  _splitOccurrence(anchor, occurrenceStart, patch) {
    if (this.events.length >= MAX_CALENDAR_EVENTS) {
      throw new Error(`calendar store is full (${MAX_CALENDAR_EVENTS} events)`);
    }
    const nowIso = this.nowProvider().toISOString();
    const anchorUpdated = normalizeCalendarEvent({
      ...anchor,
      exceptions: [...(Array.isArray(anchor.exceptions) ? anchor.exceptions : []), occurrenceStart],
      id: anchor.id,
      createdAt: anchor.createdAt,
      updatedAt: nowIso,
    });
    const { occurrenceStart: _ignoredScope, ...fields } = patch;
    const standalone = normalizeCalendarEvent({
      ...fields,
      recurrence: 'none',
      exceptions: [],
      id: this._generateEventId(),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    if (!anchorUpdated || !standalone) {
      throw new Error('calendar occurrence edit requires a valid start time');
    }
    this.events = [
      ...this.events.map((event) => (event.id === anchor.id ? anchorUpdated : event)),
      standalone,
    ];
    this._persistEvents();
    this._emitChangedIfNeeded();
    return this.getState();
  }

  deleteEvent(id) {
    const eventId = String(id || '').trim();
    const next = this.events.filter((event) => event.id !== eventId);
    if (next.length !== this.events.length) {
      this.events = next;
      this._persistEvents();
      this._emitChangedIfNeeded();
    }
    return this.getState();
  }

  async refreshFeeds() {
    if (this._refreshPromise) {
      // A refresh requested mid-flight (e.g. a feed was just added while the
      // poll runs) must not coalesce into the in-flight pass, which already
      // captured the old feed list — queue one trailing re-run instead.
      this._refreshQueued = true;
      return this._refreshPromise;
    }
    this._refreshPromise = this._refreshFeeds()
      .catch((error) => {
        this.logger('WARN', 'calendar.refresh_failed', {
          message: String(error?.message || error),
        });
      })
      .finally(() => {
        this._refreshPromise = null;
        if (this._refreshQueued) {
          this._refreshQueued = false;
          void this.refreshFeeds();
        }
      });
    return this._refreshPromise;
  }

  async _refreshFeeds() {
    const feeds = this._readConfiguredFeeds();
    const window = computeCalendarWindow(this.nowProvider());
    const liveIds = new Set(feeds.map((feed) => feed.id));
    for (const cachedId of [...this._feedCache.keys()]) {
      if (!liveIds.has(cachedId)) {
        this._feedCache.delete(cachedId);
      }
    }
    await Promise.all(feeds.map(async (feed) => {
      const previous = this._feedCache.get(feed.id);
      try {
        const response = await requestWithTimeout(feed.url, { fetchImpl: this.fetchImpl });
        if (!response?.ok) {
          throw new Error(`feed responded ${Number(response?.status) || 0}`);
        }
        const body = await response.text();
        const { instances, skippedCount, unsupportedRruleCount } = extractIcsInstances(body, window);
        this._feedCache.set(feed.id, {
          instances,
          skippedCount,
          unsupportedRruleCount,
          ok: true,
          error: '',
          fetchedAt: this.nowProvider().toISOString(),
        });
      } catch (error) {
        this.logger('WARN', 'calendar.feed_fetch_failed', {
          feedId: feed.id,
          message: String(error?.message || error),
        });
        // Keep the last good instances visible; surface the failure.
        this._feedCache.set(feed.id, {
          instances: previous?.instances || [],
          skippedCount: previous?.skippedCount || 0,
          unsupportedRruleCount: previous?.unsupportedRruleCount || 0,
          ok: false,
          error: String(error?.message || error),
          fetchedAt: previous?.fetchedAt || '',
        });
      }
    }));
    this._emitChangedIfNeeded();
  }

  _handleConfigChanged(_state, context = {}) {
    if (String(context?.reason || '') === 'home_config_updated') {
      void this.refreshFeeds();
    }
  }

  _readConfiguredFeeds() {
    if (typeof this.configService.getHomeConfig === 'function') {
      return listHomeCalendarFeeds(this.configService.getHomeConfig());
    }
    return listHomeCalendarFeeds(this.configService.getState?.()?.home);
  }

  _generateEventId() {
    this._idCounter += 1;
    return `evt_${this.nowProvider().getTime().toString(36)}_${this._idCounter.toString(36)}`;
  }

  _persistEvents() {
    this.store.writeImmediate({ version: CALENDAR_STORE_VERSION, events: this.events });
  }

  // Emit key covers everything that changes what the renderer would paint:
  // local events, feed fetch outcomes (minus fetchedAt churn), and the window
  // start so the first activity after a day roll pushes a fresh snapshot.
  _emitChangedIfNeeded() {
    const window = computeCalendarWindow(this.nowProvider());
    const feedKey = [...this._feedCache.entries()].map(([id, entry]) => [
      id,
      entry.ok,
      entry.error,
      entry.skippedCount,
      entry.unsupportedRruleCount,
      entry.instances,
    ]);
    const emitKey = JSON.stringify([
      formatLocalDateTime(window.windowStart),
      this.events,
      feedKey,
    ]);
    if (emitKey === this._lastEmitKey) {
      return;
    }
    this._lastEmitKey = emitKey;
    this.emit('changed', this.getState());
  }
}

module.exports = {
  CalendarService,
  createEmptyCalendarSnapshot,
};
