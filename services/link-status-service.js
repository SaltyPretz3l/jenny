'use strict';

const { EventEmitter } = require('events');
const { requestWithTimeout } = require('./http-fetch-util');
const { listHomeSiteMonitorTargets } = require('./home-config-schema');

// Link-tile status poller for the Home dashboard. Checks ONLY the explicit
// `siteMonitor` URLs surfaced by listHomeSiteMonitorTargets — never a tile's
// href — so an unconfigured dashboard means zero network traffic. Mirrors the
// weather-service conventions (EventEmitter + unref'd interval + injected
// fetch). Probes use HEAD first, falling back to GET for servers that reject
// or mishandle HEAD (405/501 or a thrown request).
const DEFAULT_LINK_STATUS_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_LINK_STATUS_REQUEST_TIMEOUT_MS = 5000;

function createEmptyLinkStatusState() {
  return { byTileId: {} };
}

function cloneLinkStatusState(state) {
  const byTileId = {};
  for (const tileId of Object.keys(state.byTileId)) {
    byTileId[tileId] = { ...state.byTileId[tileId] };
  }
  return { byTileId };
}

class LinkStatusService extends EventEmitter {
  constructor({
    configService,
    fetchImpl = globalThis.fetch,
    logger = () => {},
    nowProvider = () => new Date(),
    pollIntervalMs = DEFAULT_LINK_STATUS_POLL_INTERVAL_MS,
    requestTimeoutMs = DEFAULT_LINK_STATUS_REQUEST_TIMEOUT_MS,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    super();
    if (!configService) {
      throw new Error('configService is required for LinkStatusService.');
    }
    this.configService = configService;
    this.fetchImpl = fetchImpl;
    this.logger = typeof logger === 'function' ? logger : () => {};
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
    this.pollIntervalMs = Math.max(Number(pollIntervalMs) || DEFAULT_LINK_STATUS_POLL_INTERVAL_MS, 30_000);
    this.requestTimeoutMs = Math.max(Number(requestTimeoutMs) || DEFAULT_LINK_STATUS_REQUEST_TIMEOUT_MS, 100);
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.state = createEmptyLinkStatusState();
    this._timer = null;
    this._refreshPromise = null;
    this._refreshPending = false;
    this._stopped = false;
    this._generation = 0;
    this._lastEmitKey = '';
    this._handleConfigChanged = this._handleConfigChanged.bind(this);
  }

  start({ deferInitialRefresh = false } = {}) {
    if (this._timer) {
      return;
    }
    this._stopped = false;
    this._generation += 1;
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
    this._stopped = true;
    this._generation += 1;
    this._refreshPending = false;
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
    return cloneLinkStatusState(this.state);
  }

  _handleConfigChanged(_state, context = {}) {
    if (String(context?.reason || '') === 'home_config_updated') {
      void this.refresh();
    }
  }

  _readTargets() {
    if (typeof this.configService.getHomeConfig === 'function') {
      return listHomeSiteMonitorTargets(this.configService.getHomeConfig());
    }
    return listHomeSiteMonitorTargets(this.configService.getState?.()?.home);
  }

  async refresh() {
    if (this._stopped) {
      return;
    }
    if (this._refreshPromise) {
      this._refreshPending = true;
      return this._refreshPromise;
    }
    const generation = this._generation;
    this._refreshPromise = (async () => {
      do {
        this._refreshPending = false;
        try {
          await this._refresh(generation);
        } catch (error) {
          this.logger('WARN', 'link_status.refresh_failed', {
            message: String(error?.message || error),
          });
        }
      } while (
        this._refreshPending
        && !this._stopped
        && generation === this._generation
      );
    })()
      .finally(() => {
        this._refreshPromise = null;
      });
    return this._refreshPromise;
  }

  async _refresh(generation) {
    const targets = this._readTargets();
    if (targets.length === 0) {
      if (!this._stopped && generation === this._generation) {
        this._setState(createEmptyLinkStatusState());
      }
      return;
    }
    const checks = await Promise.all(
      targets.map(async (target) => [target.tileId, await this._checkTarget(target)])
    );
    if (this._stopped || generation !== this._generation) {
      return;
    }
    // Rebuilt from the current target list each pass, so tiles removed from
    // the config drop out of the map instead of lingering as stale entries.
    const byTileId = {};
    for (const [tileId, result] of checks) {
      byTileId[tileId] = result;
    }
    this._setState({ byTileId });
  }

  // A down target is an expected state, not an anomaly — it is recorded in the
  // per-tile entry rather than logged, so an intentionally-offline host does
  // not spam the shell log every poll.
  async _checkTarget(target) {
    const startedMs = this.nowProvider().getTime();
    let response = null;
    let error = '';
    try {
      response = await this._request(target.url, 'HEAD');
      if (response && (response.status === 405 || response.status === 501)) {
        response = await this._request(target.url, 'GET');
      }
    } catch (_headError) {
      try {
        response = await this._request(target.url, 'GET');
      } catch (getError) {
        error = String(getError?.message || getError);
      }
    }
    const statusCode = Number(response?.status) || 0;
    return {
      up: statusCode > 0 && statusCode < 400,
      statusCode,
      responseMs: Math.max(this.nowProvider().getTime() - startedMs, 0),
      checkedAt: this.nowProvider().toISOString(),
      error,
    };
  }

  async _request(url, method) {
    const response = await requestWithTimeout(url, {
      method,
      timeoutMs: this.requestTimeoutMs,
      fetchImpl: this.fetchImpl,
    });
    // Only the status matters; release the body so the socket is not held
    // open until GC (undici keeps the connection alive for unread bodies).
    try {
      await response?.body?.cancel?.();
    } catch (_error) {
      // Body release is best-effort.
    }
    return response;
  }

  _setState(nextState) {
    this.state = nextState;
    // Dedupe on the meaningful fields only: responseMs/checkedAt change on
    // every poll, so keying the emit on them would wake the renderer each
    // pass even when no dot actually changed. getState() still serves the
    // freshest timing data on demand.
    const emitKey = JSON.stringify(
      Object.keys(nextState.byTileId)
        .sort()
        .map((tileId) => {
          const entry = nextState.byTileId[tileId];
          return [tileId, entry.up, entry.statusCode, entry.error];
        })
    );
    if (emitKey === this._lastEmitKey) {
      return;
    }
    this._lastEmitKey = emitKey;
    this.emit('changed', this.getState());
  }
}

module.exports = {
  DEFAULT_LINK_STATUS_POLL_INTERVAL_MS,
  DEFAULT_LINK_STATUS_REQUEST_TIMEOUT_MS,
  LinkStatusService,
};
