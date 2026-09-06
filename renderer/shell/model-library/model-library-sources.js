/* Isolated Model Library bridge reads plus request-scoped Ollama pull state. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../renderer-model-library-format-utils'));
    return;
  }
  root.modelLibrarySources = factory(root.rendererModelLibraryFormatUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (formatUtils) {
  'use strict';

  var canonicalOllamaTag = formatUtils && formatUtils.canonicalOllamaTag;
  var boundedErrorMessage = formatUtils && formatUtils.boundedErrorMessage;
  var formatBytesShort = formatUtils && formatUtils.formatBytesShort;
  if (typeof canonicalOllamaTag !== 'function'
    || typeof boundedErrorMessage !== 'function'
    || typeof formatBytesShort !== 'function') {
    throw new Error('model-library-sources: missing required dependency');
  }

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function unavailableReason(error, fallback) {
    return boundedErrorMessage(error, fallback).slice(0, 240);
  }

  function normalizeInstalled(payload) {
    var source = objectOrEmpty(payload);
    var data = Array.isArray(source.data) ? source.data : [];
    return data.map(function (entry) {
      if (typeof entry === 'string') {
        var stringId = entry.trim();
        return stringId ? {
          id: stringId,
          size: 0,
          engine_type: '',
          available: true,
          reason: '',
        } : null;
      }
      var model = objectOrEmpty(entry);
      var id = String(model.id || '').trim();
      if (!id) return null;
      var size = Number(model.size);
      return {
        id: id,
        size: Number.isFinite(size) && size > 0 ? size : 0,
        engine_type: String(model.engine_type || model.engineType || '').trim().toLowerCase(),
        available: model.available !== false,
        reason: unavailableReason(model.reason, ''),
        parameterSize: String(model.parameterSize || model.parameter_size || '').trim(),
        quantizationLevel: String(model.quantizationLevel || model.quantization_level || '').trim(),
        digest: String(model.digest || '').trim(),
      };
    }).filter(Boolean);
  }

  function normalizeOllamaTags(payload) {
    var source = objectOrEmpty(payload);
    return Array.isArray(source.data) ? source.data.slice() : [];
  }

  function normalizeLocalGgufs(payload) {
    var payloadSource = objectOrEmpty(payload);
    return (Array.isArray(payloadSource.entries) ? payloadSource.entries : []).map(function (entry) {
      var source = objectOrEmpty(entry);
      var tag = String(source.tag || '').trim();
      if (!tag) return null;
      var sizeBytes = Number(source.sizeBytes);
      return {
        tag: tag,
        source: String(source.source || '').trim(),
        dir: String(source.dir || '').trim(),
        mainGguf: String(source.mainGguf || '').trim(),
        drafterGguf: String(source.drafterGguf || '').trim(),
        sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : 0,
      };
    }).filter(Boolean);
  }

  function normalizeLlamaServer(payload) {
    var source = objectOrEmpty(payload);
    var port = Number(source.port);
    return {
      state: String(source.state || '').trim().toLowerCase(),
      alias: String(source.alias || '').trim(),
      port: Number.isInteger(port) && port >= 0 ? port : 0,
      accelerationMode: String(source.accelerationMode || '').trim().toLowerCase(),
      reused: source.reused === true,
    };
  }

  function createModelLibrarySource(options) {
    var opts = options || {};
    var windowRef = opts.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    var appendClientLog = typeof opts.appendClientLog === 'function'
      ? opts.appendClientLog : function noop() {};
    var generation = 0;
    var inFlightLoads = {
      withLlamaServer: null,
      withoutLlamaServer: null,
    };

    function isolate(label, call, fallback) {
      return Promise.resolve().then(call).then(function (value) {
        return { ok: true, value: value };
      }).catch(function (error) {
        var reason = unavailableReason(error, label + ' unavailable.');
        appendClientLog('WARN', 'model_library.source_unavailable', {
          source: label,
          message: reason,
        });
        return { ok: false, value: fallback, reason: reason };
      });
    }

    function requireBridgeMethod(owner, method, label) {
      if (!owner || typeof owner[method] !== 'function') {
        throw new Error(label + ' bridge unavailable.');
      }
      return owner[method]();
    }

    function load(options) {
      var withLlamaServer = Boolean(options && options.llamaServer === true);
      var inFlightKey = withLlamaServer ? 'withLlamaServer' : 'withoutLlamaServer';
      // A refresh that answers a user action or follows a mutation must NOT join a
      // fan-out that started before it: that resolves with a pre-mutation snapshot,
      // and during a backend stall it makes the Refresh button a silent no-op.
      // Coalescing exists for the redundant features.onChanged broadcast, not for
      // reads whose whole point is to observe something that just changed.
      if (!(options && options.force === true) && inFlightLoads[inFlightKey]) {
        return inFlightLoads[inFlightKey];
      }
      var loadGeneration = ++generation;
      var shell = windowRef && windowRef.jennyShell;
      var models = shell && shell.models;
      var offline = shell && shell.offline;
      var llamaServer = shell && shell.llamaServer;
      // Advisory per-model engine reads run only when the caller has the
      // llama_server_acceleration flag on (the Setup scene never asks).
      var loadPromise = Promise.all([
        isolate('installed', function () {
          return requireBridgeMethod(models, 'list', 'Installed models');
        }, null),
        isolate('ollamaTags', function () {
          return requireBridgeMethod(models, 'listOllamaTags', 'Ollama tags');
        }, null),
        isolate('diagnostics', function () {
          return requireBridgeMethod(offline, 'getDiagnostics', 'Hardware diagnostics');
        }, null),
        withLlamaServer ? isolate('localGgufs', function () {
          return requireBridgeMethod(llamaServer, 'listLocalGgufs', 'Local GGUF files');
        }, null) : Promise.resolve(null),
        withLlamaServer ? isolate('llamaServer', function () {
          return requireBridgeMethod(llamaServer, 'getStatus', 'llama-server status');
        }, null) : Promise.resolve(null),
      ]).then(function (results) {
        var installedResult = results[0];
        var tagsResult = results[1];
        var diagnosticsResult = results[2];
        var localGgufsResult = results[3];
        var llamaServerResult = results[4];
        var diagnostics = objectOrEmpty(diagnosticsResult.value);
        var unavailable = {};
        var installed = [];
        var ollamaTags = [];
        var localGgufs = [];
        var llamaServerStatus = null;

        if (!installedResult.ok) {
          unavailable.installed = installedResult.reason;
        } else if (objectOrEmpty(installedResult.value).available === false) {
          unavailable.installed = unavailableReason(
            objectOrEmpty(installedResult.value).reason,
            'Installed models unavailable.'
          );
        } else {
          installed = normalizeInstalled(installedResult.value);
        }
        if (!tagsResult.ok) {
          unavailable.ollamaTags = tagsResult.reason;
        } else if (objectOrEmpty(tagsResult.value).available === false) {
          unavailable.ollamaTags = unavailableReason(
            objectOrEmpty(tagsResult.value).reason,
            'Ollama tags unavailable.'
          );
        } else {
          ollamaTags = normalizeOllamaTags(tagsResult.value);
        }
        if (!diagnosticsResult.ok) unavailable.diagnostics = diagnosticsResult.reason;
        // Advisory reads: their fail-soft payloads carry reason CODES
        // (manager_unavailable, not_gguf), which must not reach the status line.
        if (localGgufsResult && (!localGgufsResult.ok || objectOrEmpty(localGgufsResult.value).ok === false)) {
          unavailable.localGgufs = 'Local GGUF files unavailable.';
        } else if (localGgufsResult) {
          localGgufs = normalizeLocalGgufs(localGgufsResult.value);
        }
        if (llamaServerResult && (!llamaServerResult.ok || objectOrEmpty(llamaServerResult.value).ok === false)) {
          unavailable.llamaServer = 'llama-server status unavailable.';
        } else if (llamaServerResult) {
          llamaServerStatus = normalizeLlamaServer(llamaServerResult.value);
        }

        return {
          generation: loadGeneration,
          installed: installed,
          ollamaTags: ollamaTags,
          recommendations: Array.isArray(diagnostics.modelRecommendations)
            ? diagnostics.modelRecommendations.slice() : [],
          fitEstimates: Array.isArray(diagnostics.modelFitEstimates)
            ? diagnostics.modelFitEstimates.slice() : [],
          hardware: diagnostics.hardwareProfile || null,
          memory: objectOrEmpty(diagnostics.memory),
          catalogMeta: diagnostics.catalogMeta || null,
          localGgufs: localGgufs,
          llamaServer: llamaServerStatus,
          unavailable: unavailable,
        };
      });
      // Clear only our own slot: a forced load replaces the tracked promise, and an
      // older load settling afterwards must not null out its successor.
      var tracked = loadPromise.then(function (result) {
        if (inFlightLoads[inFlightKey] === tracked) inFlightLoads[inFlightKey] = null;
        return result;
      }, function (error) {
        if (inFlightLoads[inFlightKey] === tracked) inFlightLoads[inFlightKey] = null;
        throw error;
      });
      inFlightLoads[inFlightKey] = tracked;
      return tracked;
    }

    return {
      load: load,
      latestGeneration: function latestGeneration() { return generation; },
    };
  }

  function createRequestId() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto
      && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return 'model_library_pull_' + Date.now().toString(16)
      + '_' + Math.random().toString(16).slice(2, 10);
  }

  function pullBytesText(payload) {
    var downloaded = Number(payload.downloadedBytes || payload.downloaded_bytes || payload.bytes) || 0;
    var total = Number(payload.totalBytes || payload.total_bytes) || 0;
    var downloadedText = formatBytesShort(downloaded);
    var totalText = formatBytesShort(total);
    if (downloadedText && totalText) return downloadedText + ' / ' + totalText;
    return downloadedText || totalText || '';
  }

  function createPullController(options) {
    var opts = options || {};
    var setupService = opts.setupService || null;
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : function noop() {};
    var appendClientLog = typeof opts.appendClientLog === 'function'
      ? opts.appendClientLog : function noop() {};
    var pulls = Object.create(null);
    var unsubscribe = null;
    var disposed = false;

    function notify(key) {
      if (!disposed) onChange(key);
    }

    function recordForRequest(requestId) {
      var keys = Object.keys(pulls);
      for (var index = 0; index < keys.length; index += 1) {
        if (pulls[keys[index]].requestId === requestId) return pulls[keys[index]];
      }
      return null;
    }

    function remove(record) {
      if (!record || pulls[record.key] !== record) return;
      delete pulls[record.key];
      notify(record.key);
    }

    function complete(record) {
      record.status = 'done';
      delete record.cancelFailed;
      notify(record.key);
      remove(record);
    }

    function fail(record, error) {
      record.status = 'error';
      record.message = unavailableReason(error, 'Pull failed.');
      notify(record.key);
    }

    function handleProgress(payload) {
      if (disposed || !payload) return;
      var requestId = String(payload.requestId || payload.request_id || '');
      var record = recordForRequest(requestId);
      if (!record) return;
      if (record.status === 'error') return;
      var status = String(payload.status || '').toLowerCase();
      if (status === 'completed' || status === 'done') {
        complete(record);
        return;
      }
      if (status === 'failed' || status === 'error') {
        fail(record, payload.error || payload.message || payload.summary);
        return;
      }
      if (status === 'cancelled') {
        remove(record);
        return;
      }
      record.status = 'running';
      record.percent = Math.min(Math.max(Number(payload.percent) || 0, 0), 100);
      record.bytesText = pullBytesText(payload);
      notify(record.key);
    }

    function subscribe() {
      if (unsubscribe || !setupService || typeof setupService.subscribePullProgress !== 'function') return;
      unsubscribe = setupService.subscribePullProgress(handleProgress);
      if (typeof unsubscribe !== 'function') unsubscribe = function noop() {};
    }

    function start(tag) {
      var model = String(tag || '').trim();
      var key = canonicalOllamaTag(model);
      if (!key || disposed) return Promise.resolve(null);
      if (pulls[key] && pulls[key].status === 'running') return Promise.resolve(pulls[key]);
      subscribe();
      var record = {
        key: key,
        tag: model,
        requestId: createRequestId(),
        status: 'running',
        percent: 0,
        bytesText: '',
      };
      pulls[key] = record;
      notify(key);
      if (!setupService || typeof setupService.startOllamaPull !== 'function') {
        fail(record, 'Pull is unavailable right now.');
        return Promise.resolve(record);
      }
      return Promise.resolve(setupService.startOllamaPull({
        model: model,
        requestId: record.requestId,
      })).then(function (result) {
        if (disposed || pulls[key] !== record) return result;
        var resultRequestId = String(result && (result.requestId || result.request_id) || '');
        if (resultRequestId) record.requestId = resultRequestId;
        var status = String(result && result.status || '').toLowerCase();
        if (status === 'failed' || status === 'error') {
          fail(record, result.error || result.message || result.summary);
        } else if (status === 'completed' || status === 'done') {
          complete(record);
        }
        return result;
      }).catch(function (error) {
        if (disposed || pulls[key] !== record) return null;
        fail(record, error);
        appendClientLog('WARN', 'model_library.pull_start_failed', {
          message: record.message,
        });
        return null;
      });
    }

    function cancel(tag) {
      var key = canonicalOllamaTag(tag);
      var record = pulls[key];
      if (!record || disposed || record.status !== 'running') return Promise.resolve(null);
      if (!setupService || typeof setupService.cancelOllamaPull !== 'function') {
        record.cancelFailed = true;
        record.message = 'Could not cancel the pull.';
        notify(key);
        return Promise.resolve({ cancelled: false });
      }
      return Promise.resolve(setupService.cancelOllamaPull({
        requestId: record.requestId,
        model: record.tag,
      })).then(function (result) {
        if (disposed || pulls[key] !== record) return result;
        if (result && result.cancelled === true) {
          remove(record);
        } else {
          record.cancelFailed = true;
          record.message = unavailableReason(
            result && (result.error || result.message || result.code),
            'Could not cancel the pull.'
          );
          notify(key);
        }
        return result;
      }).catch(function (error) {
        if (disposed || pulls[key] !== record) return null;
        record.cancelFailed = true;
        record.message = unavailableReason(error, 'Could not cancel the pull.');
        notify(key);
        appendClientLog('WARN', 'model_library.pull_cancel_failed', {
          message: record.message,
        });
        return null;
      });
    }

    function getPulls() {
      var snapshot = {};
      Object.keys(pulls).forEach(function (key) {
        snapshot[key] = Object.assign({}, pulls[key]);
      });
      return snapshot;
    }

    function dispose() {
      disposed = true;
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (_error) { /* best-effort teardown */ }
      }
      unsubscribe = null;
      pulls = Object.create(null);
    }

    return { start: start, cancel: cancel, getPulls: getPulls, dispose: dispose };
  }

  return {
    createModelLibrarySource: createModelLibrarySource,
    createPullController: createPullController,
  };
});
