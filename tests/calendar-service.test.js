const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { CalendarService, createEmptyCalendarSnapshot } = require('../services/calendar-service');

const FIXED_NOW = new Date(2026, 5, 11, 10, 0); // 2026-06-11T10:00 local

const FEED_ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:feed-standup',
  'SUMMARY:Feed Standup',
  'DTSTART:20260615T091500',
  'DTEND:20260615T093000',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function createMemoryStore(seed) {
  return {
    value: seed,
    writes: [],
    read(defaultValue) {
      return this.value === undefined ? defaultValue : this.value;
    },
    writeImmediate(value) {
      this.value = value;
      this.writes.push(JSON.parse(JSON.stringify(value)));
    },
  };
}

function createConfigStub(home = {}) {
  const emitter = new EventEmitter();
  emitter.home = home;
  emitter.getHomeConfig = () => emitter.home;
  return emitter;
}

function createService({ home = {}, seed, fetchImpl } = {}) {
  const store = createMemoryStore(seed);
  const configService = createConfigStub(home);
  const service = new CalendarService({
    store,
    configService,
    fetchImpl: fetchImpl || (async () => ({ ok: true, text: async () => FEED_ICS })),
    logger: () => {},
    nowProvider: () => FIXED_NOW,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  return { service, store, configService };
}

test('calendar start can defer only the initial refresh while keeping the poll timer', () => {
  const configService = createConfigStub();
  const intervals = [];
  const createStartedService = (deferInitialRefresh) => {
    const service = new CalendarService({
      store: createMemoryStore(),
      configService,
      setIntervalImpl: (callback, intervalMs) => {
        intervals.push({ callback, intervalMs });
        return { unref() {} };
      },
      clearIntervalImpl: () => {},
    });
    let refreshCalls = 0;
    service.refreshFeeds = () => { refreshCalls += 1; };
    service.start(deferInitialRefresh ? { deferInitialRefresh: true } : undefined);
    return { service, refreshCalls: () => refreshCalls };
  };

  const deferred = createStartedService(true);
  const immediate = createStartedService(false);

  assert.equal(intervals.length, 2);
  assert.equal(deferred.refreshCalls(), 0);
  assert.equal(immediate.refreshCalls(), 1);
  deferred.service.stop();
  immediate.service.stop();
});

test('createEvent persists, returns the instance in the snapshot, and emits changed', () => {
  const { service, store } = createService();
  const events = [];
  service.on('changed', (state) => events.push(state));

  const snapshot = service.createEvent({
    title: 'Dentist',
    start: '2026-06-12T14:00',
    end: '2026-06-12T15:00',
    categoryId: 'personal',
  });

  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].events.length, 1);
  const instance = snapshot.instances.find((i) => i.title === 'Dentist');
  assert.ok(instance);
  assert.equal(instance.source, 'local');
  assert.equal(instance.readonly, false);
  assert.equal(instance.categoryId, 'personal');
  assert.equal(events.length, 1);
});

test('updateEvent and deleteEvent round-trip through the store', () => {
  const { service, store } = createService();
  const created = service.createEvent({ title: 'Old', start: '2026-06-12T09:00' });
  const eventId = created.instances[0].eventId;

  const updated = service.updateEvent(eventId, { title: 'New title', categoryId: 'focus' });
  const instance = updated.instances.find((i) => i.eventId === eventId);
  assert.equal(instance.title, 'New title');
  assert.equal(instance.categoryId, 'focus');

  const afterDelete = service.deleteEvent(eventId);
  assert.equal(afterDelete.instances.length, 0);
  assert.equal(store.value.events.length, 0);
});

test('invalid createEvent throws and persists nothing', () => {
  const { service, store } = createService();
  assert.throws(() => service.createEvent({ title: 'broken', start: 'not-a-date' }), /valid start/);
  assert.equal(store.writes.length, 0);
});

test('updateEvent on an unknown id throws', () => {
  const { service } = createService();
  assert.throws(() => service.updateEvent('missing', { title: 'x' }), /not found/);
});

test('recurring local events appear as multiple instances', () => {
  const { service } = createService();
  const snapshot = service.createEvent({
    title: 'Gym',
    start: '2026-06-08T07:00',
    end: '2026-06-08T08:00',
    recurrence: 'weekly',
  });
  const gym = snapshot.instances.filter((i) => i.title === 'Gym');
  assert.ok(gym.length >= 8); // weekly across a ~67-day window
  assert.equal(gym.every((i) => i.recurring), true);
});

test('updateEvent with occurrenceStart splits one occurrence into a standalone event', () => {
  const { service, store } = createService();
  const created = service.createEvent({
    title: 'Gym',
    start: '2026-06-08T07:00',
    end: '2026-06-08T08:00',
    recurrence: 'weekly',
  });
  const anchorId = created.instances[0].eventId;
  const occurrence = created.instances.find((i) => i.start === '2026-06-15T07:00');
  assert.ok(occurrence, 'the Jun 15 occurrence exists before the split');

  const after = service.updateEvent(anchorId, {
    title: 'Gym (moved)',
    start: '2026-06-15T18:00',
    end: '2026-06-15T19:00',
    recurrence: 'weekly',
    occurrenceStart: '2026-06-15T07:00',
  });

  // The original Jun 15 07:00 occurrence is gone from the series...
  assert.equal(after.instances.some((i) => i.start === '2026-06-15T07:00'), false);
  // ...replaced by a standalone one-off at the new time.
  const moved = after.instances.find((i) => i.title === 'Gym (moved)');
  assert.ok(moved);
  assert.equal(moved.start, '2026-06-15T18:00');
  assert.equal(moved.recurring, false);
  // Other series occurrences are untouched (e.g. Jun 22 07:00 survives).
  assert.equal(after.instances.some((i) => i.start === '2026-06-22T07:00'), true);
  // Store now holds the anchor (with one exception) plus the standalone.
  assert.equal(store.value.events.length, 2);
  const anchor = store.value.events.find((e) => e.id === anchorId);
  assert.deepEqual(anchor.exceptions, ['2026-06-15T07:00']);
});

test('seeded store events survive construction and malformed entries drop', () => {
  const { service } = createService({
    seed: {
      version: 1,
      events: [
        { id: 'keep', title: 'Kept', start: '2026-06-12T08:00', end: '2026-06-12T09:00' },
        { id: 'bad', title: 'Bad', start: 'garbage' },
      ],
    },
  });
  const snapshot = service.getState();
  assert.deepEqual(snapshot.instances.map((i) => i.title), ['Kept']);
});

test('feed fetch merges readonly instances colored by the feed', async () => {
  const home = { calendar: { feeds: [{ name: 'Team', url: 'https://cal.example/team.ics', colorId: 'meeting' }] } };
  const { service } = createService({ home });

  await service.refreshFeeds();
  const snapshot = service.getState();

  const feedInstance = snapshot.instances.find((i) => i.source === 'feed');
  assert.ok(feedInstance);
  assert.equal(feedInstance.readonly, true);
  assert.equal(feedInstance.feedId, 'team');
  assert.equal(feedInstance.categoryId, 'meeting');
  assert.equal(feedInstance.title, 'Feed Standup');
  assert.equal(snapshot.feeds.length, 1);
  assert.equal(snapshot.feeds[0].ok, true);
  assert.equal(snapshot.feeds[0].warning, '');
});

test('feed failure keeps last-good instances and surfaces a warning', async () => {
  const home = { calendar: { feeds: [{ name: 'Team', url: 'https://cal.example/team.ics' }] } };
  let fail = false;
  const fetchImpl = async () => {
    if (fail) {
      throw new Error('socket hangup');
    }
    return { ok: true, text: async () => FEED_ICS };
  };
  const { service } = createService({ home, fetchImpl });

  await service.refreshFeeds();
  fail = true;
  await service.refreshFeeds();

  const snapshot = service.getState();
  assert.equal(snapshot.feeds[0].ok, false);
  assert.match(snapshot.feeds[0].warning, /socket hangup/);
  // Last good reading stays visible.
  assert.ok(snapshot.instances.some((i) => i.title === 'Feed Standup'));
});

test('home_config_updated triggers a feed refresh and dropped feeds leave the cache', async () => {
  const home = { calendar: { feeds: [] } };
  const { service, configService } = createService({ home });
  await service.refreshFeeds();
  assert.equal(service.getState().instances.length, 0);

  // Drains in-flight AND queued refreshes (a config change mid-poll queues a
  // trailing re-run rather than coalescing into the stale in-flight pass).
  const drainRefreshes = async () => {
    while (service._refreshPromise) {
      await service._refreshPromise;
    }
  };

  service.start();
  configService.home = {
    calendar: { feeds: [{ name: 'Team', url: 'https://cal.example/team.ics' }] },
  };
  configService.emit('changed', {}, { reason: 'home_config_updated' });
  await drainRefreshes();
  assert.ok(service.getState().instances.some((i) => i.source === 'feed'));

  configService.home = { calendar: { feeds: [] } };
  configService.emit('changed', {}, { reason: 'home_config_updated' });
  await drainRefreshes();
  assert.equal(service.getState().instances.some((i) => i.source === 'feed'), false);
  service.stop();
});

test('changed emission dedupes identical content across refreshes', async () => {
  const home = { calendar: { feeds: [{ name: 'Team', url: 'https://cal.example/team.ics' }] } };
  const { service } = createService({ home });
  const emitted = [];
  service.on('changed', () => emitted.push(1));

  await service.refreshFeeds();
  await service.refreshFeeds();
  await service.refreshFeeds();

  assert.equal(emitted.length, 1);
});

test('createEmptyCalendarSnapshot matches the snapshot shape', () => {
  const empty = createEmptyCalendarSnapshot();
  assert.deepEqual(Object.keys(empty).sort(), [
    'categories', 'events', 'feeds', 'generatedAt', 'instances', 'windowEnd', 'windowStart',
  ]);
  assert.equal(empty.categories.length, 6);
});
