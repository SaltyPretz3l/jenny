'use strict';

const { EventEmitter } = require('events');
const { requestWithTimeout } = require('./http-fetch-util');
const { normalizeHomeWeather } = require('./home-config-schema');

// Open-meteo current-conditions poller for the Home dashboard info strip.
// Keyless API; coordinates come from the shell-config `home.weather` key, so
// an unconfigured location means zero network traffic. Mirrors the
// system-stats poller conventions (EventEmitter + unref'd interval).
const DEFAULT_WEATHER_POLL_INTERVAL_MS = 15 * 60 * 1000;
const OPEN_METEO_BASE_URL = 'https://api.open-meteo.com/v1/forecast';

// WMO weather interpretation codes (open-meteo `weather_code`).
function describeWeatherCode(code) {
  const value = Number(code);
  if (!Number.isFinite(value)) return '';
  if (value === 0) return 'clear';
  if (value === 1) return 'mostly clear';
  if (value === 2) return 'partly cloudy';
  if (value === 3) return 'overcast';
  if (value === 45 || value === 48) return 'fog';
  if (value >= 51 && value <= 57) return 'drizzle';
  if (value >= 61 && value <= 67) return 'rain';
  if (value >= 71 && value <= 77) return 'snow';
  if (value >= 80 && value <= 82) return 'showers';
  if (value === 85 || value === 86) return 'snow showers';
  if (value === 95) return 'thunderstorm';
  if (value === 96 || value === 99) return 'thunderstorm with hail';
  return '';
}

function createUnconfiguredWeatherState() {
  return {
    available: false,
    configured: false,
    tempC: null,
    tempF: null,
    code: null,
    description: '',
    isDay: null,
    lat: null,
    lon: null,
    units: 'metric',
    fetchedAt: '',
    error: '',
  };
}

function cloneWeatherState(state) {
  return { ...state };
}

class WeatherService extends EventEmitter {
  constructor({
    configService,
    fetchImpl = globalThis.fetch,
    logger = () => {},
    nowProvider = () => new Date(),
    pollIntervalMs = DEFAULT_WEATHER_POLL_INTERVAL_MS,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    super();
    if (!configService) {
      throw new Error('configService is required for WeatherService.');
    }
    this.configService = configService;
    this.fetchImpl = fetchImpl;
    this.logger = typeof logger === 'function' ? logger : () => {};
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
    this.pollIntervalMs = Math.max(Number(pollIntervalMs) || DEFAULT_WEATHER_POLL_INTERVAL_MS, 60_000);
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.state = createUnconfiguredWeatherState();
    this._timer = null;
    this._refreshPromise = null;
    this._refreshQueued = false;
    this._lastEmitKey = '';
    this._handleConfigChanged = this._handleConfigChanged.bind(this);
  }

  start({ deferInitialRefresh = false } = {}) {
    if (this._timer) {
      return;
    }
    this.configService.on('changed', this._handleConfigChanged);
    this._timer = this.setIntervalImpl(() => {
      void this.refresh();
    }, this.pollIntervalMs);
    if (typeof this._timer?.unref === 'function') {
      this._timer.unref();
    }
    if (!deferInitialRefresh) {
      void this.refresh();
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
    return cloneWeatherState(this.state);
  }

  _handleConfigChanged(_state, context = {}) {
    if (String(context?.reason || '') === 'home_config_updated') {
      void this.refresh();
    }
  }

  _readConfiguredWeather() {
    if (typeof this.configService.getHomeConfig === 'function') {
      return normalizeHomeWeather(this.configService.getHomeConfig()?.weather);
    }
    return normalizeHomeWeather(this.configService.getState?.()?.home?.weather);
  }

  async refresh() {
    if (this._refreshPromise) {
      this._refreshQueued = true;
      return this._refreshPromise;
    }
    this._refreshPromise = (async () => {
      do {
        this._refreshQueued = false;
        try {
          await this._refresh();
        } catch (error) {
          this.logger('WARN', 'weather.refresh_failed', {
            message: String(error?.message || error),
          });
        }
      } while (this._refreshQueued);
    })().finally(() => {
      this._refreshPromise = null;
    });
    return this._refreshPromise;
  }

  async _refresh() {
    const weather = this._readConfiguredWeather();
    if (weather.lat === null || weather.lon === null) {
      this._setState(createUnconfiguredWeatherState());
      return;
    }
    let nextState;
    try {
      const url = `${OPEN_METEO_BASE_URL}?latitude=${weather.lat}&longitude=${weather.lon}`
        + '&current=temperature_2m,weather_code,is_day';
      const response = await requestWithTimeout(url, { fetchImpl: this.fetchImpl });
      if (!response?.ok) {
        throw new Error(`open-meteo responded ${Number(response?.status) || 0}`);
      }
      const payload = await response.json();
      const current = payload?.current && typeof payload.current === 'object' ? payload.current : {};
      const tempC = Number(current.temperature_2m);
      if (!Number.isFinite(tempC)) {
        throw new Error('open-meteo payload missing temperature_2m');
      }
      nextState = {
        available: true,
        configured: true,
        tempC: Number(tempC.toFixed(1)),
        tempF: Number((tempC * 9 / 5 + 32).toFixed(1)),
        code: Number.isFinite(Number(current.weather_code)) ? Number(current.weather_code) : null,
        description: describeWeatherCode(current.weather_code),
        isDay: current.is_day === 1 || current.is_day === true,
        lat: weather.lat,
        lon: weather.lon,
        units: weather.units,
        fetchedAt: this.nowProvider().toISOString(),
        error: '',
      };
    } catch (error) {
      const errorMessage = String(error?.message || error).slice(0, 240);
      this.logger('WARN', 'weather.fetch_failed', {
        message: errorMessage,
      });
      const sameLocation = this.state.available === true
        && this.state.lat === weather.lat
        && this.state.lon === weather.lon;
      nextState = sameLocation ? {
        ...this.state,
        configured: true,
        lat: weather.lat,
        lon: weather.lon,
        units: weather.units,
        error: errorMessage,
      } : {
        ...createUnconfiguredWeatherState(),
        configured: true,
        lat: weather.lat,
        lon: weather.lon,
        units: weather.units,
        error: errorMessage,
      };
    }
    this._setState(nextState);
  }

  _setState(nextState) {
    this.state = nextState;
    const emitKey = JSON.stringify(nextState);
    if (emitKey === this._lastEmitKey) {
      return;
    }
    this._lastEmitKey = emitKey;
    this.emit('changed', this.getState());
  }
}

module.exports = {
  WeatherService,
  describeWeatherCode,
};
