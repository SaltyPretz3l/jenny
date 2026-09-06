const { EventEmitter } = require('events');
const assert = require('node:assert/strict');
const test = require('node:test');

const { requestWithTimeout, isHttpUrl } = require('../services/http-fetch-util');
const { WeatherService, describeWeatherCode } = require('../services/weather-service');

const NOW = new Date('2026-06-10T12:00:00.000Z');

class FakeHomeConfigService extends EventEmitter {
  constructor(weather = {}) {
    super();
    this._weather = weather;
  }

  getHomeConfig() {
    return { links: [], weather: this._weather };
  }

  setWeather(weather) {
    this._weather = weather;
    this.emit('changed', {}, { reason: 'home_config_updated' });
  }
}

function openMeteoResponse({ tempC = 21.4, code = 2, isDay = 1 } = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      current: { temperature_2m: tempC, weather_code: code, is_day: isDay },
    }),
  };
}

function createService({ weather, fetchImpl } = {}) {
  const logs = [];
  const configService = new FakeHomeConfigService(weather || {});
  const service = new WeatherService({
    configService,
    fetchImpl,
    logger: (level, event, details) => logs.push({ level, event, details }),
    nowProvider: () => new Date(NOW),
  });
  return { service, configService, logs };
}

test('weather start can defer only the initial refresh while keeping the poll timer', () => {
  const configService = new FakeHomeConfigService();
  const intervals = [];
  const createStartedService = (deferInitialRefresh) => {
    const service = new WeatherService({
      configService,
      setIntervalImpl: (callback, intervalMs) => {
        intervals.push({ callback, intervalMs });
        return { unref() {} };
      },
      clearIntervalImpl: () => {},
    });
    let refreshCalls = 0;
    service.refresh = () => { refreshCalls += 1; };
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

test('weather service stays idle and unconfigured without coordinates', async () => {
  const calls = [];
  const { service } = createService({
    fetchImpl: async (url) => {
      calls.push(url);
      return openMeteoResponse();
    },
  });

  await service.refresh();

  assert.equal(calls.length, 0);
  const state = service.getState();
  assert.equal(state.configured, false);
  assert.equal(state.available, false);
  assert.equal(state.tempC, null);
});

test('weather service builds state from an open-meteo payload', async () => {
  const calls = [];
  const { service } = createService({
    weather: { lat: 40.7, lon: -74, units: 'imperial' },
    fetchImpl: async (url) => {
      calls.push(url);
      return openMeteoResponse({ tempC: 21.4, code: 2, isDay: 1 });
    },
  });
  const emitted = [];
  service.on('changed', (state) => emitted.push(state));

  await service.refresh();

  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=40\.7&longitude=-74/);
  const state = service.getState();
  assert.equal(state.available, true);
  assert.equal(state.tempC, 21.4);
  assert.equal(state.tempF, 70.5);
  assert.equal(state.description, 'partly cloudy');
  assert.equal(state.isDay, true);
  assert.equal(state.units, 'imperial');
  assert.equal(state.fetchedAt, NOW.toISOString());
  assert.equal(emitted.length, 1);

  // Identical payload → no duplicate emit.
  await service.refresh();
  assert.equal(emitted.length, 1);
});

test('weather service keeps the last good reading on fetch failure and logs a WARN', async () => {
  let failNext = false;
  const { service, logs } = createService({
    weather: { lat: 40.7, lon: -74 },
    fetchImpl: async () => {
      if (failNext) {
        throw new Error('network down');
      }
      return openMeteoResponse({ tempC: 18 });
    },
  });

  await service.refresh();
  failNext = true;
  await service.refresh();

  const state = service.getState();
  assert.equal(state.tempC, 18);
  assert.equal(state.error, 'network down');
  assert.ok(logs.some((entry) => entry.level === 'WARN' && entry.event === 'weather.fetch_failed'));
});

test('weather service reruns immediately when configuration changes during a request', async () => {
  let callCount = 0;
  let resolveFirst;
  const configService = new FakeHomeConfigService({ lat: 1, lon: 2 });
  const service = new WeatherService({
    configService,
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return openMeteoResponse({ tempC: 22 });
    },
    logger: () => {},
    nowProvider: () => new Date(NOW),
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });

  service.start();
  configService.setWeather({ lat: 3, lon: 4 });
  const pending = service._refreshPromise;
  resolveFirst(openMeteoResponse({ tempC: 10 }));
  await pending;

  assert.equal(callCount, 2);
  assert.equal(service.getState().lat, 3);
  assert.equal(service.getState().lon, 4);
  assert.equal(service.getState().tempC, 22);
  service.stop();
});

test('weather service clears an old-location reading when the new location fails', async () => {
  let failNext = false;
  const { service, configService } = createService({
    weather: { lat: 40.7, lon: -74 },
    fetchImpl: async () => {
      if (failNext) throw new Error('x'.repeat(500));
      return openMeteoResponse({ tempC: 18 });
    },
  });

  await service.refresh();
  configService.setWeather({ lat: 34.1, lon: -118.2 });
  failNext = true;
  await service.refresh();

  const state = service.getState();
  assert.equal(state.available, false);
  assert.equal(state.tempC, null);
  assert.equal(state.lat, 34.1);
  assert.equal(state.lon, -118.2);
  assert.equal(state.error.length, 240);
});

test('weather service refreshes when home config changes', async () => {
  const calls = [];
  const configService = new FakeHomeConfigService({});
  const service = new WeatherService({
    configService,
    fetchImpl: async (url) => {
      calls.push(url);
      return openMeteoResponse();
    },
    logger: () => {},
    nowProvider: () => new Date(NOW),
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  service.start();
  await service.refresh();
  assert.equal(calls.length, 0);

  configService.setWeather({ lat: 1, lon: 2 });
  await service._refreshPromise;

  assert.equal(calls.length, 1);
  assert.equal(service.getState().available, true);
  service.stop();
});

test('describeWeatherCode maps WMO buckets', () => {
  assert.equal(describeWeatherCode(0), 'clear');
  assert.equal(describeWeatherCode(3), 'overcast');
  assert.equal(describeWeatherCode(48), 'fog');
  assert.equal(describeWeatherCode(63), 'rain');
  assert.equal(describeWeatherCode(73), 'snow');
  assert.equal(describeWeatherCode(81), 'showers');
  assert.equal(describeWeatherCode(95), 'thunderstorm');
  assert.equal(describeWeatherCode('nope'), '');
});

test('requestWithTimeout rejects non-http URLs and aborts on timeout', async () => {
  await assert.rejects(
    () => requestWithTimeout('file:///C:/secrets.txt', { fetchImpl: async () => ({}) }),
    /requires an http\(s\) URL/
  );
  assert.equal(isHttpUrl('https://example.com'), true);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);

  await assert.rejects(
    () => requestWithTimeout('https://example.com', {
      timeoutMs: 100,
      fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    }),
    /aborted/
  );
});
