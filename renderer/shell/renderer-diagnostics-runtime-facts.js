(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-diagnostics-page'),
      require('./renderer-diagnostics-format'),
      require('../inventory/action-button'),
      require('../inventory/state-icon'),
      require('../inventory/empty-note'),
      require('../features/setup-scenes/ollama-daemon-view'),
      require('../shared/diagnostics-report-utils'),
      require('./renderer-phase-percentiles-utils'),
      require('../shared/model-load-failure')
    );
    return;
  }
  root.rendererDiagnosticsRuntimeFacts = factory(
    root.rendererDiagnosticsPage,
    root.rendererDiagnosticsFormat,
    root.inventoryActionButton,
    root.inventoryStateIcon,
    root.inventoryEmptyNote,
    root.rendererOllamaDaemonView || {},
    root.diagnosticsReportUtils || {},
    root.rendererPhasePercentilesUtils || {},
    root.jennyModelLoadFailure
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  page,
  format,
  actionButton,
  stateIcon,
  emptyNote,
  daemonView,
  reportUtils,
  phaseUtils,
  loadFailureUtils
) {
  'use strict';
  // Overview > Runtime: three groups of label/value facts. Engine and memory comes from the live status,
  // Setup from the harness inventory, Records from the selected launch's evidence.
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  var MAX_FACT_CHARS = 160;
  var SOURCE_NAMES = ['electron', 'renderer', 'sidecar'];
  var formatNumber = format.formatNumber;
  var formatBytes = format.formatBytes;
  var statusLabel = format.statusLabel;
  var paintMarkup = page.paintMarkup;
  var liveBackend = page.liveBackend;

  // A facet the harness could not build carries a top-level `error`; Electron-side payloads (the scheduler
  // lifecycle) carry `error` as data, so those get the plain-record check.
  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function isAvailableFacet(value) {
    return isRecord(value) && !String(value.error || '').trim();
  }

  function first() {
    for (var index = 0; index < arguments.length; index += 1) {
      var value = String(arguments[index] == null ? '' : arguments[index]).trim();
      if (value) return value;
    }
    return '';
  }

  // The engine and model Jenny is running: the harness runtime facet first, then the status the page fetched.
  function activeRuntime(state) {
    var harness = isAvailableFacet(state.harness?.snapshot?.runtime) ? state.harness.snapshot.runtime : {};
    var status = isRecord(state.diagnosticsStatus?.runtime) ? state.diagnosticsStatus.runtime : {};
    var backend = liveBackend(state);
    return {
      engine: first(harness.active_engine, status.active_engine, status.engine, state.diagnosticsStatus?.backend?.engine,
        backend.engine, backend.model_lifecycle?.engine, state.status?.engine),
      model: first(harness.active_model, status.active_model, status.model, state.diagnosticsStatus?.backend?.model, state.status?.model),
    };
  }

  // The model a starting or unavailable backend is working on.
  function requestedModel(state) {
    var backend = liveBackend(state);
    return first(backend.model_lifecycle?.requested_model, backend.model_acquisition?.requested_model, activeRuntime(state).model);
  }

  function engineName(engine, state, managed) {
    var key = String(engine || '').trim().toLowerCase();
    if (key === 'chatgpt') return 'ChatGPT';
    if (key === 'codex-cli') return jt('settings.subagents.codexCli', 'Codex CLI');
    return loadFailureUtils.engineLabel(key, { runtime: state.diagnosticsStatus?.runtime }, managed);
  }

  function clampText(value) {
    var text = String(value == null ? '' : value).trim();
    return text.length > MAX_FACT_CHARS ? text.slice(0, MAX_FACT_CHARS - 1) + '…' : text;
  }

  function icon(tone) {
    if (!stateIcon || !tone) return '';
    return tone === 'ok' ? stateIcon('dot', { tone: 'ok' }) : stateIcon(tone === 'error' ? 'error' : 'warn', { tone: tone, size: 'sm' });
  }

  // A fact is {label, value, small, tone, mono, muted, title, html}. `value` and `small` are plain text
  // (escaped, clamped); `html` is trusted markup placed after them (the Choose folder action).
  function factMarkup(item) {
    var value = item.value == null ? '' : String(item.value).trim();
    var small = item.small == null ? '' : String(item.small).trim();
    var shown = (item.muted ? '<span class="diagnostics-muted">' + escapeHtml(value) + '</span>'
      : item.mono ? '<code>' + escapeHtml(clampText(value)) + '</code>' : escapeHtml(clampText(value)))
      + (small ? ' <small>' + escapeHtml(clampText(small)) + '</small>' : '') + (item.html || '');
    var full = item.title || (clampText(value) !== value || clampText(small) !== small ? [value, small].filter(Boolean).join(' ') : '');
    return '<dt>' + escapeHtml(item.label) + '</dt><dd' + (full ? ' title="' + escapeHtml(full) + '"' : '') + '>' + icon(item.tone) + '<span>' + shown + '</span></dd>';
  }

  function notMeasured(label) {
    return { label: label, value: jt('diagnostics.facts.notMeasured', 'Not measured'), muted: true };
  }

  function unavailable(label) {
    return { label: label, value: jt('diagnostics.common.unavailable', 'Unavailable'), tone: 'warn' };
  }

  function group(title, body) {
    return '<section class="diagnostics-group"><h4>' + escapeHtml(title) + '</h4>' + body + '</section>';
  }

  function factList(items) {
    return '<dl class="diagnostics-facts">' + items.filter(Boolean).map(factMarkup).join('') + '</dl>';
  }

  /* ---------------- Engine and memory ---------------- */

  var PHASE_WORDS = {
    ready: function () { return jt('diagnostics.facts.state.ready', 'ready'); },
    starting: function () { return jt('diagnostics.facts.state.starting', 'starting'); },
    acquiring: function () { return jt('diagnostics.facts.state.starting', 'starting'); },
    loading: function () { return jt('diagnostics.facts.state.loading', 'loading'); },
    unavailable: function () { return jt('diagnostics.facts.state.unavailable', 'not running'); },
    model_unavailable: function () { return jt('diagnostics.facts.state.notLoaded', 'not loaded'); },
  };

  function engineFact(state, failure, phase) {
    var label = jt('diagnostics.inventory.engine', 'Engine');
    if (failure) {
      return { label: label, value: engineName(failure.engine, state, failure.managed) + ' · ' + failure.model,
        small: PHASE_WORDS.model_unavailable(), tone: 'error', title: failure.engine + ' · ' + failure.model };
    }
    var runtime = activeRuntime(state);
    if (!runtime.engine) return unavailable(label);
    var word = PHASE_WORDS[phase] ? PHASE_WORDS[phase]() : '';
    return { label: label, value: engineName(runtime.engine, state) + (runtime.model ? ' · ' + runtime.model : ''),
      small: word, tone: phase === 'ready' ? 'ok' : '', title: runtime.engine + (runtime.model ? ' · ' + runtime.model : '') };
  }

  function measuredNumber(value) {
    return value === null || value === undefined || value === '' ? NaN : Number(value);
  }

  function modelMemoryFact(resources) {
    var label = jt('diagnostics.resources.modelMemory', 'Model memory');
    var memory = resources && resources.model_memory;
    if (!isRecord(memory)) return notMeasured(label);
    var models = Array.isArray(memory.models) ? memory.models : null;
    if (models && models.length === 0) return { label: label, value: jt('diagnostics.facts.noModelInMemory', 'No model in memory'), muted: true };
    // Unknown is not zero: null or empty stays unmeasured instead of becoming 0 bytes.
    var vram = measuredNumber(memory.vram_bytes);
    var ram = measuredNumber(memory.ram_bytes);
    var total = formatBytes(memory.vram_total_bytes);
    if (Number.isFinite(vram) && vram > 0) {
      return { label: label, value: jt('diagnostics.resources.vram', '{value} VRAM', { value: formatBytes(vram) }),
        small: [total === null ? '' : jt('diagnostics.resources.ofTotal', 'of {total}', { total: total }),
          Number.isFinite(ram) && ram > 0 ? jt('diagnostics.resources.ram', '{value} RAM', { value: formatBytes(ram) }) : ''].filter(Boolean).join(' · ') };
    }
    if (Number.isFinite(ram)) return { label: label, value: jt('diagnostics.resources.ram', '{value} RAM', { value: formatBytes(ram) }) };
    return notMeasured(label);
  }

  function systemMemoryFact(resources) {
    var label = jt('diagnostics.facts.systemMemory', 'System memory');
    var system = resources && resources.system_memory;
    var percent = system && system.percent;
    var words = {
      normal: jt('diagnostics.facts.pressure.normal', 'normal'),
      high: jt('diagnostics.facts.pressure.high', 'high'),
      critical: jt('diagnostics.facts.pressure.critical', 'critical'),
    };
    var word = system && words[system.pressure] || '';
    var tone = system && system.pressure === 'critical' ? 'error' : system && system.pressure === 'high' ? 'warn' : '';
    if (percent == null || !Number.isFinite(Number(percent))) {
      // The pressure level is a measurement even when the percentage is not.
      return word ? { label: label, value: jt('diagnostics.facts.pressureLevel', '{level} pressure', { level: word }), tone: tone } : notMeasured(label);
    }
    return { label: label, value: jt('diagnostics.facts.percentInUse', '{percent}% in use', { percent: formatNumber(percent) }), small: word, tone: tone };
  }

  function tokensFact(budgets) {
    if (!budgets || !budgets.inputs || budgets.inputs.usage !== true) return null;
    var label = jt('diagnostics.facts.tokens', 'Tokens');
    var usage = isRecord(budgets.usage) ? budgets.usage : {};
    var session = usage.session_total_tokens;
    var all = usage.cumulative_total_tokens;
    if (session == null && all == null) return notMeasured(label);
    return { label: label, value: formatNumber(session), small: jt('diagnostics.facts.tokensSession', 'this session · {all} all time', { all: formatNumber(all) }) };
  }

  function outdatedDaemonMarkup(state) {
    var detection = state.ollamaDaemonDetection;
    if (!detection?.running || !detection.upgradeRequired || !detection.daemon) return '';
    return '<div class="diagnostics-inventory-actions" data-issue="ollama_outdated_external"><p>'
      + escapeHtml(jt('diagnostics.runtime.ollamaOutdated', 'Ollama {version} is too old. Jenny needs {minimumVersion} or newer.',
        { version: detection.version, minimumVersion: detection.minimumVersion })) + '</p>'
      + (daemonView.facts?.(detection.daemon) || '')
      + actionButton({ id: 'diagnostics-open-local-engine', label: jt('diagnostics.runtime.fixLocalEngine', 'Fix in Local engine'), size: 'sm' }) + '</div>';
  }

  function engineGroup(state, failure) {
    var budgets = isRecord(state.diagnosticsStatus?.budgets) ? state.diagnosticsStatus.budgets : null;
    var resources = budgets && isRecord(budgets.resources) ? budgets.resources : null;
    var phase = phaseUtils.classifyBackendPhase ? phaseUtils.classifyBackendPhase(liveBackend(state).phase) : 'unknown';
    var appMemory = formatBytes(resources && resources.app_memory_bytes);
    return group(jt('diagnostics.facts.engineAndMemory', 'Engine and memory'), factList([
      engineFact(state, failure, phase),
      modelMemoryFact(resources),
      appMemory === null ? notMeasured(jt('diagnostics.resources.appMemory', 'App memory')) : { label: jt('diagnostics.resources.appMemory', 'App memory'), value: appMemory },
      systemMemoryFact(resources),
      tokensFact(budgets),
    ]) + outdatedDaemonMarkup(state));
  }

  /* ---------------- Setup ---------------- */

  function toolsFact(facet) {
    var label = jt('diagnostics.inventory.tools', 'Tools');
    if (!facet) return unavailable(label);
    var counts = isAvailableFacet(facet.counts) ? facet.counts : null;
    var items = Array.isArray(facet.items) ? facet.items : null;
    var enabled = counts && Number.isFinite(Number(counts.enabled))
      ? Number(counts.enabled)
      : items ? items.filter(function (tool) { return tool && tool.enabled !== false; }).length : null;
    if (enabled == null) return unavailable(label);
    var disabled = counts && Number.isFinite(Number(counts.disabled)) ? Number(counts.disabled) : items ? Math.max(items.length - enabled, 0) : 0;
    return { label: label, value: jt('diagnostics.facts.toolsOn', '{count} on', { count: formatNumber(enabled) }),
      small: disabled > 0 ? jt('diagnostics.facts.toolsOff', '{count} off', { count: formatNumber(disabled) }) : '', tone: enabled > 0 ? '' : 'warn' };
  }

  function memoriesFact(facet) {
    var label = jt('diagnostics.facts.memories', 'Memories');
    if (!facet) return unavailable(label);
    var counts = isAvailableFacet(facet.counts) ? facet.counts : null;
    var approved = counts && Number.isFinite(Number(counts.approved)) ? Number(counts.approved) : Array.isArray(facet.approved) ? facet.approved.length : null;
    var pending = counts && Number.isFinite(Number(counts.pending)) ? Number(counts.pending) : Array.isArray(facet.pending) ? facet.pending.length : null;
    if (approved == null || pending == null || facet.status?.available === false) return unavailable(label);
    return { label: label, value: jt('diagnostics.facts.memoriesSaved', '{count} saved', { count: formatNumber(approved) }),
      small: pending > 0 ? jt('diagnostics.facts.memoriesPending', '{count} waiting for review', { count: formatNumber(pending) }) : '' };
  }

  function skillsFact(facet) {
    var label = jt('diagnostics.inventory.skills', 'Skills');
    if (!facet || !Array.isArray(facet.scopes)) return unavailable(label);
    var scopes = facet.scopes.slice(0, 6);
    var counts = isAvailableFacet(facet.counts) ? facet.counts : null;
    var total = counts && Number.isFinite(Number(counts.total)) ? Number(counts.total) : Array.isArray(facet.items) ? facet.items.length : 0;
    var blocked = scopes.filter(function (scope) { return scope && scope.status === 'blocked'; }).length;
    var small = jtn('diagnostics.facts.skillsScopes', scopes.length, { count: formatNumber(scopes.length) }, 'in {count} scope', 'in {count} scopes')
      + (blocked ? ' · ' + jt('diagnostics.inventory.blockedCount', '{count} blocked', { count: formatNumber(blocked) }) : '');
    return { label: label, value: jt('diagnostics.inventory.loadedCount', '{count} loaded', { count: formatNumber(total) }), small: small, tone: blocked ? 'warn' : '' };
  }

  function workspaceFact(facet) {
    var label = jt('diagnostics.inventory.workspace', 'Workspace');
    if (!facet) return unavailable(label);
    var root = String(facet.root || '').trim();
    if (!root) {
      var served = globalThis.rendererDiagnosticsActions && globalThis.rendererDiagnosticsActions['choose-workspace-folder'] === true;
      return { label: label, value: jt('diagnostics.facts.notSet', 'Not set'), muted: true, tone: 'warn',
        html: served ? ' ' + actionButton({ id: 'choose-workspace-folder', label: jt('diagnostics.issues.action.chooseFolder', 'Choose folder…'), plain: true, className: 'diagnostics-text-button' }) : '' };
    }
    var blockers = Array.isArray(facet.blockers) ? facet.blockers.length : 0;
    var small = facet.exists !== true ? jt('diagnostics.facts.folderNotFound', 'folder not found')
      : blockers ? jtn('diagnostics.inventory.blockerCount', blockers, { count: blockers }, '{count} blocker', '{count} blockers') : '';
    return { label: label, value: root, mono: true, small: small, tone: small ? 'warn' : '' };
  }

  function schedulerFact(scheduler) {
    var label = jt('diagnostics.inventory.scheduler', 'Scheduler');
    if (!isRecord(scheduler)) return unavailable(label);
    var lifecycle = isRecord(scheduler.lifecycle) ? scheduler.lifecycle : {};
    var phase = String(lifecycle.phase || 'unknown');
    var count = Number(lifecycle.qualifyingTaskCount || 0);
    var small = [jtn('diagnostics.facts.schedulerTasks', count, { count: formatNumber(count) }, '{count} task on', '{count} tasks on'),
      lifecycle.reason ? String(lifecycle.reason) : '', lifecycle.error ? String(lifecycle.error) : ''].filter(Boolean).join(' · ');
    return { label: label, value: statusLabel(phase), small: small, tone: phase === 'failed' ? 'warn' : '', title: phase + ' · ' + small };
  }

  // Background note taking (memory reflection, row 58 W2): the scheduler's state and this launch's
  // counts from jenny_status. No scheduler, no fact.
  var NOTE_TAKING_STATES = {
    idle: function () { return jt('diagnostics.facts.noteTakingIdle', 'Idle'); },
    waiting_idle: function () { return jt('diagnostics.facts.noteTakingWaiting', 'Waiting for a quiet moment'); },
    running: function () { return jt('diagnostics.facts.noteTakingRunning', 'Taking notes'); },
    backing_off: function () { return jt('diagnostics.facts.noteTakingBackingOff', 'Paused after errors'); },
  };

  function noteTakingFact(status) {
    var facet = status && status.memory_reflection;
    if (!isRecord(facet) || facet.available !== true) return null;
    var label = jt('diagnostics.facts.noteTaking', 'Note taking');
    var count = function (value) { return Number.isSafeInteger(value) && value > 0 ? value : 0; };
    var failed = count(facet.failed);
    var runs = count(facet.runs);
    var saved = count(facet.saved);
    var preempted = count(facet.preempted);
    var small = [
      jtn('diagnostics.facts.noteTakingRuns', runs, { count: formatNumber(runs) }, '{count} run', '{count} runs'),
      jtn('diagnostics.facts.noteTakingSaved', saved, { count: formatNumber(saved) }, '{count} saved', '{count} saved'),
      jtn('diagnostics.facts.noteTakingInterrupted', preempted, { count: formatNumber(preempted) }, '{count} interrupted by a chat', '{count} interrupted by a chat'),
    ].join(' · ') + (failed ? ' · ' + jt('diagnostics.facts.noteTakingFailed', '{count} failed', { count: formatNumber(failed) }) : '');
    if (facet.enabled !== true) return { label: label, value: jt('diagnostics.facts.noteTakingOff', 'Off'), small: small, muted: true };
    var word = NOTE_TAKING_STATES[facet.state] ? NOTE_TAKING_STATES[facet.state]() : NOTE_TAKING_STATES.idle();
    return { label: label, value: word, small: small, tone: facet.state === 'backing_off' || failed ? 'warn' : '',
      title: facet.last_outcome ? word + ' · ' + small + ' · ' + String(facet.last_outcome) : '' };
  }

  // Electron's own runtime facet says whether the Chromium OS sandbox is on. No facet, no fact.
  function sandboxFact(status) {
    var facet = status && status.runtime ? status.runtime.chromium_sandbox : null;
    if (!isRecord(facet)) return null;
    var label = jt('diagnostics.facts.sandbox', 'Sandbox');
    if (facet.sandboxed === true) return { label: label, value: jt('diagnostics.runtime.sandboxOn', 'On') };
    if (facet.sandboxed !== false) {
      return { label: label, value: jt('diagnostics.facts.sandboxUnknown', 'Unknown'), tone: 'warn',
        small: jt('diagnostics.facts.sandboxUnknownNote', 'Electron did not report its command line') };
    }
    return { label: label, value: jt('diagnostics.facts.sandboxOff', 'Off'), tone: 'warn',
      small: facet.package_kind === 'appimage'
        ? jt('diagnostics.facts.sandboxOffAppImageNote', 'this system restricts unprivileged user namespaces; install the .deb for full sandboxing')
        : jt('diagnostics.facts.sandboxOffFlagNote', 'launched with --no-sandbox') };
  }

  function setupGroup(state) {
    var title = jt('diagnostics.facts.setup', 'Setup');
    var error = String(state.harness?.error || '').trim();
    var snapshot = state.harness?.snapshot;
    if (error || !isRecord(snapshot)) {
      return group(title, error
        ? emptyNote({ text: jt('diagnostics.inventory.runtimeUnavailable', 'Runtime inventory unavailable'), hint: error })
        : emptyNote({ text: jt('diagnostics.facts.checking', 'Checking…'), role: 'status' }));
    }
    return group(title, factList([
      toolsFact(isAvailableFacet(snapshot.tools) ? snapshot.tools : null),
      memoriesFact(isAvailableFacet(snapshot.memories) ? snapshot.memories : null),
      noteTakingFact(state.diagnosticsStatus),
      skillsFact(isAvailableFacet(snapshot.skills) ? snapshot.skills : null),
      workspaceFact(isAvailableFacet(snapshot.workspace) ? snapshot.workspace : null),
      schedulerFact(state.schedulerDiagnostics),
      sandboxFact(state.diagnosticsStatus),
    ]));
  }

  /* ---------------- Records ---------------- */

  // A source's last record reads "last 09:30:15": with seconds, because a burst is read to the second.
  function sourceFact(name, source) {
    var label = format.sourceLabel(name);
    var dropped = Number(source && source.dropped) || 0;
    var observed = Boolean(source) && source.state === 'observed';
    var last = observed && format.parsedDate(source.last_seen) ? format.formatClock(source.last_seen, { seconds: true }) : '';
    var small = [last ? jt('diagnostics.facts.lastRecord', 'last {time}', { time: last }) : '',
      dropped ? jt('diagnostics.source.droppedCount', '{count} dropped', { count: formatNumber(dropped) }) : ''].filter(Boolean).join(' · ');
    return observed
      ? { label: label, value: formatNumber(source.count), small: small, tone: dropped ? 'warn' : '', title: name }
      : { label: label, value: jt('diagnostics.facts.noneYet', 'None yet'), muted: true, small: small, tone: dropped ? 'warn' : '', title: name };
  }

  // A launch other than the live one is selected: its records are shown, the live engine state is not.
  function isPriorLaunch(state) {
    return page.selectedRunId(state) !== page.activeRunId(state);
  }

  function recordsGroup(state, prior) {
    var title = prior ? jt('diagnostics.facts.recordsPrevious', 'Records in the previous launch') : jt('diagnostics.facts.recordsThisLaunch', 'Records this launch');
    var evidence = reportUtils.selectRunEvidence ? reportUtils.selectRunEvidence(state.diagnosticsSnapshot, page.selectedRunId(state)) : { available: false };
    if (evidence.available === false) {
      return group(title, emptyNote({ text: jt('diagnostics.facts.recordsUnavailable', 'Records for this launch aren’t available.') }));
    }
    var sources = evidence.sources || {};
    return group(title, factList(SOURCE_NAMES.map(function (name) { return sourceFact(name, sources[name]); })));
  }

  function renderRuntimeInventory(state) {
    var host = document.getElementById('diagnosticsRuntimeInventory');
    if (!host) return;
    // Before the first snapshot there is nothing to report, so the section claims nothing.
    if (!state.diagnosticsSnapshot) {
      paintMarkup(host, outdatedDaemonMarkup(state) + emptyNote({ text: jt('diagnostics.facts.checking', 'Checking…'), role: 'status' }));
      return;
    }
    var failure = loadFailureUtils ? loadFailureUtils.readModelLoadFailure(liveBackend(state)) : null;
    var prior = isPriorLaunch(state);
    // The outdated-daemon notice is live engine state, so a previous launch never shows it.
    paintMarkup(host, prior
      ? recordsGroup(state, true)
      : engineGroup(state, failure) + setupGroup(state) + recordsGroup(state, false));
  }

  return Object.freeze({
    activeRuntime: activeRuntime,
    engineName: engineName,
    isPriorLaunch: isPriorLaunch,
    renderRuntimeInventory: renderRuntimeInventory,
    requestedModel: requestedModel,
  });
});
