/* Isolated Model Library bridge reads plus request-scoped Ollama pull state. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../renderer-model-library-format-utils'),
      require('./model-library-merge')
    );
    return;
  }
  root.modelLibrarySources = factory(root.rendererModelLibraryFormatUtils, root.modelLibraryMerge);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (formatUtils, mergeUtils) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var canonicalOllamaTag = formatUtils && formatUtils.canonicalOllamaTag;
  var boundedErrorMessage = formatUtils && formatUtils.boundedErrorMessage;
  var formatBytesShort = formatUtils && formatUtils.formatBytesShort;
  var managedModelKey = mergeUtils && mergeUtils.managedModelKey;
  var joinModelPath = mergeUtils && mergeUtils.joinModelPath;
  var entryTag = mergeUtils && mergeUtils.entryTag;
  if (typeof canonicalOllamaTag !== 'function'
    || typeof boundedErrorMessage !== 'function'
    || typeof formatBytesShort !== 'function'
    || typeof managedModelKey !== 'function'
    || typeof joinModelPath !== 'function'
    || typeof entryTag !== 'function') {
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

  // Library GGUFs: a managed.perModel llama-server entry added from a file on
  // disk. The helpers below name it, recognise its file and project it into
  // the installed list the merge builds cards from.
  var SHARD_SUFFIX = /-\d{5}-of-\d{5}$/i;
  var OLLAMA_BLOB = /^sha256-[0-9a-f]{64}$/i;

  function pathSegments(filePath) {
    return String(filePath == null ? '' : filePath).split(/[\\/]+/).filter(Boolean);
  }

  function fileNameOf(filePath) {
    var segments = pathSegments(filePath);
    return segments.length ? segments[segments.length - 1] : '';
  }

  function tagFromName(name) {
    return String(name || '')
      .replace(/\.gguf$/i, '')
      .replace(SHARD_SUFFIX, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '');
  }

  // Ids main's inferEngineTypeFromModel anchors to another engine (the test
  // engines, ChatGPT): that verdict overrides the llama-server pin, so a file
  // named like one could never run on llama-server. A parity test reads main's.
  var ENGINE_ANCHORED_TAG = /^(?:mock|replay|gpt-5(?:[.:-]|$)|gpt-6-astra$)/;

  // "Ternary-Bonsai-2-27B-PQ2_0.gguf" -> "ternary-bonsai-2-27b-pq2_0". A name
  // with nothing usable borrows its folder's name (a drive root names nothing).
  // Main keeps tags of 128 characters at most.
  function libraryTagFromPath(filePath) {
    var segments = pathSegments(filePath);
    var tag = tagFromName(segments[segments.length - 1]);
    var parent = segments.length > 1 ? segments[segments.length - 2] : '';
    if (!tag && !/^[a-z]:$/i.test(parent)) tag = tagFromName(parent);
    return !tag || ENGINE_ANCHORED_TAG.test(tag) || tag.length > 128 ? '' : tag;
  }

  // The shape libraryTagFromPath gives a library GGUF's tag. An Ollama tag
  // carries ":" and a vLLM or Hugging Face id "/", so neither is ever one.
  function isLibraryTag(tag) {
    return typeof tag === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(tag);
  }

  // Mirrors services/llama-server-gguf-files.js::splitGgufFiles (a shared
  // corpus test pins the two): drafters are "mtp-*"; projectors lead with
  // "mmproj" or carry it as a whole token, split by "-", "_", "." or
  // whitespace, in the file name without its extension.
  function isAuxiliaryGguf(name) {
    var fileName = fileNameOf(name);
    if (/^mtp-/i.test(fileName)) return true;
    var dot = fileName.lastIndexOf('.');
    var stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    return /^mmproj/i.test(stem) || /[-_.\s]mmproj(?=[-_.\s]|$)/i.test(stem);
  }

  // Either separator names the same file; drive paths ignore case.
  function sameModelPath(a, b) {
    var left = String(a == null ? '' : a).replace(/\\/g, '/');
    var right = String(b == null ? '' : b).replace(/\\/g, '/');
    if (!left || !right) return false;
    return /^[a-z]:/i.test(left) ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  // Two tags name one model when they share a perModel key ("qwen3:8b" and
  // "qwen3-8b") or a card ("mistral" and "mistral:latest").
  function sharesModelName(a, b) {
    var left = String(a == null ? '' : a).trim();
    var right = String(b == null ? '' : b).trim();
    if (!left || !right) return false;
    var key = managedModelKey(left);
    return Boolean(key && key === managedModelKey(right))
      || canonicalOllamaTag(left) === canonicalOllamaTag(right);
  }

  // Only a twin under both keys is the same card: the served alias of this
  // very entry. Any other related row keeps the card, and its perModel key.
  function isTwinTag(a, b) {
    return managedModelKey(a) === managedModelKey(b) && canonicalOllamaTag(a) === canonicalOllamaTag(b);
  }

  function isOllamaRow(entry) {
    var source = objectOrEmpty(entry);
    return String(source.engine_type || source.engineType || '').trim().toLowerCase() === 'ollama';
  }

  function scannedSize(localGgufs, modelPath) {
    var entries = Array.isArray(localGgufs) ? localGgufs : [];
    for (var i = 0; i < entries.length; i += 1) {
      var entry = objectOrEmpty(entries[i]);
      var size = Number(entry.sizeBytes);
      if (entry.mainGguf && Number.isFinite(size) && size > 0
        && sameModelPath(joinModelPath(entry.dir, entry.mainGguf), modelPath)) {
        return size;
      }
    }
    return 0;
  }

  // Library GGUFs as models.list rows, so a served alias and its projection
  // fold into one card. Only a library-shaped tag projects: an Ollama model's
  // engine setting never does, even while Ollama is not listing, and neither
  // does a file in Ollama's blob store. An entry another model answers to
  // under its perModel key stays that model's engine setting. One that would
  // only share another model's card ("mistral" beside Ollama's
  // "mistral:latest") keeps a card of its own, keyed by its tag (ownCardKey).
  function projectLibraryGgufs(input) {
    var source = objectOrEmpty(input);
    var perModel = objectOrEmpty(objectOrEmpty(source.managed).perModel);
    var ollamaTags = Array.isArray(source.ollamaTags) ? source.ollamaTags : [];
    var installed = Array.isArray(source.installed) ? source.installed : [];
    var catalog = Array.isArray(source.recommendations) ? source.recommendations : [];
    var rows = [];
    Object.keys(perModel).forEach(function (storedKey) {
      var entry = objectOrEmpty(perModel[storedKey]);
      var tag = typeof entry.tag === 'string' ? entry.tag.trim() : '';
      var modelPath = typeof entry.modelPath === 'string' ? entry.modelPath.trim() : '';
      if (entry.engine !== 'llama-server' || !isLibraryTag(tag) || !modelPath) return;
      if (OLLAMA_BLOB.test(fileNameOf(modelPath))) return;
      var key = managedModelKey(tag);
      var owned = ollamaTags.some(function (item) { return managedModelKey(entryTag(item)) === key; })
        || installed.some(function (item) {
          var other = entryTag(item);
          return managedModelKey(other) === key && (isOllamaRow(item) || !isTwinTag(other, tag));
        });
      if (owned) return;
      var row = { id: tag, size: scannedSize(source.localGgufs, modelPath), engine_type: 'openai-compatible', available: true, libraryGguf: true };
      if (ollamaTags.concat(installed, catalog).some(function (item) {
        var other = entryTag(item);
        return canonicalOllamaTag(other) === canonicalOllamaTag(tag) && managedModelKey(other) !== key;
      })) row.ownCardKey = tag;
      rows.push(row);
    });
    return rows;
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
          return requireBridgeMethod(models, 'list', jt('models.library.sources.installedModels', 'Installed models'));
        }, null),
        isolate('ollamaTags', function () {
          return requireBridgeMethod(models, 'listOllamaTags', jt('models.library.sources.ollamaTags', 'Ollama tags'));
        }, null),
        isolate('diagnostics', function () {
          return requireBridgeMethod(offline, 'getDiagnostics', jt('models.library.sources.hardwareDiagnostics', 'Hardware diagnostics'));
        }, null),
        withLlamaServer ? isolate('localGgufs', function () {
          return requireBridgeMethod(llamaServer, 'listLocalGgufs', jt('models.library.sources.localGgufFiles', 'Local GGUF files'));
        }, null) : Promise.resolve(null),
        withLlamaServer ? isolate('llamaServer', function () {
          return requireBridgeMethod(llamaServer, 'getStatus', jt('models.library.sources.llamaServerStatus', 'llama-server status'));
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
            jt('models.library.sources.installedModelsUnavailable', 'Installed models unavailable.')
          );
        } else {
          installed = normalizeInstalled(installedResult.value);
        }
        if (!tagsResult.ok) {
          unavailable.ollamaTags = tagsResult.reason;
        } else if (objectOrEmpty(tagsResult.value).available === false) {
          unavailable.ollamaTags = unavailableReason(
            objectOrEmpty(tagsResult.value).reason,
            jt('models.library.sources.ollamaTagsUnavailable', 'Ollama tags unavailable.')
          );
        } else {
          ollamaTags = normalizeOllamaTags(tagsResult.value);
        }
        if (!diagnosticsResult.ok) unavailable.diagnostics = diagnosticsResult.reason;
        // Advisory reads: their fail-soft payloads carry reason CODES
        // (manager_unavailable, not_gguf), which must not reach the status line.
        if (localGgufsResult && (!localGgufsResult.ok || objectOrEmpty(localGgufsResult.value).ok === false)) {
          unavailable.localGgufs = jt('models.library.sources.localGgufFilesUnavailable', 'Local GGUF files unavailable.');
        } else if (localGgufsResult) {
          localGgufs = normalizeLocalGgufs(localGgufsResult.value);
        }
        if (llamaServerResult && (!llamaServerResult.ok || objectOrEmpty(llamaServerResult.value).ok === false)) {
          unavailable.llamaServer = jt('models.library.sources.llamaServerStatusUnavailable', 'llama-server status unavailable.');
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
      record.message = unavailableReason(error, jt('models.library.sources.pullFailed', 'Pull failed.'));
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
        fail(record, jt('models.library.sources.pullUnavailable', 'Pull is unavailable right now.'));
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
        record.message = jt('models.library.sources.cancelPullFailed', 'Could not cancel the pull.');
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
            jt('models.library.sources.cancelPullFailed', 'Could not cancel the pull.')
          );
          notify(key);
        }
        return result;
      }).catch(function (error) {
        if (disposed || pulls[key] !== record) return null;
        record.cancelFailed = true;
        record.message = unavailableReason(error, jt('models.library.sources.cancelPullFailed', 'Could not cancel the pull.'));
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
    libraryTagFromPath: libraryTagFromPath,
    isLibraryTag: isLibraryTag,
    isAuxiliaryGguf: isAuxiliaryGguf,
    sameModelPath: sameModelPath,
    sharesModelName: sharesModelName,
    projectLibraryGgufs: projectLibraryGgufs,
  };
});
