/* renderer/shell/renderer-health-pill-gpu.js - GPU-memory evidence in the health pill (UMD).

   Row 59 checkpoint 6 (chat workspace parity spec, "GPU warnings"). The collector and the
   warning state machine live in Electron; this module only renders what window.jennyShell.performance
   reports and relays one action:
     - describeGpu(gpu, settings, nowMs): the popover section's view model, or null when there is
       nothing to say (warnings off, clear, dismissed, or unknown with no confirmed state to keep).
       low_headroom and possible_contention read as warning, possible_spill as danger, and unknown keeps
       the last confirmed state's wording in a muted tone. Wording says "possible": it observes, it never
       claims a cause, and it offers no remediation, only "Hide for 10 minutes".
     - buildGpuSection(view): the markup (every dynamic string escaped; an external process is named by
       its basename only).
     - createGpuFeed(...): fetches the snapshot, follows performance.onChanged, raises ONE toast per
       warning episode (dedupeKey = warning_id) whose action opens the popover, hides the warning through
       performance.dismissWarning with the CURRENT warning_id (a stale id re-reads the snapshot instead),
       and lets the pill's tone follow the warning. Absent bridge = nothing at all.
   Warnings follow settings.gpu_warnings_enabled and do not depend on the Performance rail section. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'), require('../inventory/action-button'), require('./renderer-health-pill-markup-utils'));
    return;
  }
  root.rendererHealthPillGpu = factory(root.stringUtils, root.inventoryActionButton, root.rendererHealthPillMarkupUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, defaultActionButton, markup) {
  'use strict';

  const escapeHtml = stringUtils.escapeHtml;
  const SCHEMA_VERSION = 1;
  // The bridge scopes every call to a session id; the GPU is host-wide, so a fixed id names no chat.
  const HOST_SESSION_ID = null; // host scope: settings + GPU, no inference
  const GB = 1024 ** 3;
  const CONTENDER_MIN_BYTES = 0.25 * GB; // the contention rule's threshold: only rows at or above it are named
  const TONES = Object.freeze({ low_headroom: 'warning', possible_contention: 'warning', possible_spill: 'danger' });
  const MAX_TOASTED = 16;
  const ACTION_HIDE = 'hide-gpu-warning';

  const fallbackJt = (key, fallback, params) => (params
    ? String(fallback).replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match))
    : String(fallback));
  const resolveJt = () => {
    const i18n = typeof globalThis !== 'undefined' ? globalThis.jennyI18n : null;
    return i18n && typeof i18n.t === 'function' ? i18n.t.bind(i18n) : fallbackJt;
  };
  const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const gigabytes = (bytes, jt) => jt('chat.sessionRail.performance.gigabytes', '{value} GB', { value: (bytes / GB).toFixed(1) });

  /* The popover shows an external process by its basename alone: path separators and control characters
     never reach the markup, and the name is bounded. */
  function safeBasename(value) {
    if (typeof value !== 'string') return '';
    const base = value.split(/[\\/]/).pop() || '';
    return [...base].filter((char) => char.charCodeAt(0) >= 32).join('').trim().slice(0, 64);
  }

  function stateLine(state, jt) {
    switch (state) {
      case 'low_headroom': return jt('healthPill.gpu.state.lowHeadroom', 'GPU memory headroom is low');
      case 'possible_contention': return jt('healthPill.gpu.state.possibleContention', 'Possible GPU memory contention');
      case 'possible_spill': return jt('healthPill.gpu.state.possibleSpill', 'Possible spill into shared GPU memory');
      default: return jt('healthPill.gpu.state.unknown', 'GPU memory can’t be confirmed right now');
    }
  }

  function evidenceLines(gpu, codes, jt) {
    const lines = [];
    const adapter = isObject(gpu.adapter) ? gpu.adapter : {};
    const managed = isObject(gpu.managed_process) ? gpu.managed_process : {};
    if (codes.includes('low_headroom_latched') && known(adapter.dedicated_free_bytes)) {
      lines.push(known(adapter.dedicated_total_bytes)
        ? jt('healthPill.gpu.evidence.free', 'Free GPU memory: {free} of {total}', { free: gigabytes(adapter.dedicated_free_bytes, jt), total: gigabytes(adapter.dedicated_total_bytes, jt) })
        : jt('healthPill.gpu.evidence.freeOnly', 'Free GPU memory: {free}', { free: gigabytes(adapter.dedicated_free_bytes, jt) }));
    }
    if (codes.includes('managed_shared_above_baseline') && known(managed.shared_bytes)) {
      lines.push(jt('healthPill.gpu.evidence.shared', 'The local engine holds {shared} of shared GPU memory, above its usual level.', { shared: gigabytes(managed.shared_bytes, jt) }));
    }
    if (codes.includes('external_dedicated_allocation')) {
      const rows = (Array.isArray(gpu.external_processes) ? gpu.external_processes : [])
        .filter((row) => isObject(row) && known(row.dedicated_bytes) && row.dedicated_bytes >= CONTENDER_MIN_BYTES)
        .sort((a, b) => b.dedicated_bytes - a.dedicated_bytes).slice(0, 2);
      rows.forEach((row) => {
        const name = safeBasename(row.basename);
        const size = gigabytes(row.dedicated_bytes, jt);
        lines.push(name
          ? jt('healthPill.gpu.evidence.external', 'Another process, {name}, holds {size} of GPU memory.', { name, size })
          : jt('healthPill.gpu.evidence.externalUnnamed', 'Another process holds {size} of GPU memory.', { size }));
      });
    }
    if (gpu.state === 'partial' || gpu.truncated === true) lines.push(jt('healthPill.gpu.partial', 'Some processes may not be listed.'));
    return lines;
  }

  /* gpu: the snapshot's `gpu`; settings: its `settings`. Returns null or the section's view model. */
  function describeGpu(gpu, settings, nowMs = Date.now(), jt = fallbackJt) {
    if (!isObject(gpu) || !isObject(settings) || settings.gpu_warnings_enabled !== true) return null;
    const warning = isObject(gpu.warning) ? gpu.warning : null;
    if (!warning) return null;
    const dismissed = known(warning.dismissed_until) && warning.dismissed_until > nowMs;
    const unknown = warning.state === 'unknown';
    const effective = unknown ? warning.last_confirmed_state : warning.state;
    if (!TONES[effective] || dismissed) return null;
    const stale = gpu.state === 'stale' || unknown;
    const codes = Array.isArray(warning.evidence_codes) ? warning.evidence_codes.filter((code) => typeof code === 'string') : [];
    const evidence = unknown ? [] : evidenceLines(gpu, codes, jt);
    if (unknown) evidence.push(jt('healthPill.gpu.lastConfirmed', 'Last confirmed: {state}', { state: stateLine(effective, jt) }));
    else if (gpu.state === 'stale') evidence.push(jt('healthPill.gpu.stale', 'This reading is out of date.'));
    return {
      state: unknown ? 'unknown' : effective,
      tone: unknown ? 'muted' : TONES[effective],
      stateLine: stateLine(unknown ? 'unknown' : effective, jt),
      evidence,
      warningId: typeof warning.warning_id === 'string' ? warning.warning_id : null,
      stale,
      title: jt('healthPill.gpu.title', 'GPU memory'),
      caveat: jt('healthPill.gpu.caveat', 'These are observations, not a proven cause. Nothing is changed for you.'),
      hideLabel: jt('healthPill.gpu.hide', 'Hide for 10 minutes'),
    };
  }

  function buildGpuSection(view, options) {
    if (!view) return '';
    const makeButton = (options && options.actionButton) || defaultActionButton;
    const hide = view.warningId && makeButton
      ? makeButton({ label: view.hideLabel, plain: true, className: 'workbench-health-popover-action', dataset: { 'health-pill-action': ACTION_HIDE } })
      : '';
    return `<div class="workbench-health-popover-gpu" data-health-gpu data-gpu-state="${escapeHtml(view.state)}" data-gpu-tone="${escapeHtml(view.tone)}">`
      + `<div class="workbench-health-popover-gpu-title">${escapeHtml(view.title)}</div>`
      + `<div class="workbench-health-popover-gpu-state">${escapeHtml(view.stateLine)}</div>`
      + view.evidence.map((line) => `<div class="workbench-health-popover-fact workbench-health-popover-gpu-evidence">${escapeHtml(line)}</div>`).join('')
      + `<div class="workbench-health-popover-gpu-caveat">${escapeHtml(view.caveat)}</div>`
      + (hide ? `<div class="workbench-health-popover-gpu-actions">${hide}</div>` : '')
      + '</div>';
  }

  function gpuSignature(view) {
    return view ? JSON.stringify([view.state, view.tone, view.warningId, view.stale, view.evidence]) : '';
  }

  function createGpuFeed(options) {
    const o = options || {};
    const win = o.window || (typeof window !== 'undefined' ? window : null);
    const jt = typeof o.jt === 'function' ? o.jt : resolveJt();
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    const bridge = o.bridge || (win && win.jennyShell && win.jennyShell.performance) || null;
    if (!bridge || typeof bridge.getSnapshot !== 'function') return null;
    const showToast = typeof o.showToastMessage === 'function' ? o.showToastMessage : () => {};
    const onChange = typeof o.onChange === 'function' ? o.onChange : () => {};
    const openPopover = typeof o.openPopover === 'function' ? o.openPopover : () => {};

    let snapshot = null;
    let current = null; // describeGpu() result for the last snapshot
    let fetching = false;
    let queued = false;
    let disposed = false;
    let unsubscribe = null;
    let lastSignature = '';
    const toasted = [];

    function evaluate() {
      current = snapshot ? describeGpu(snapshot.gpu, snapshot.settings, now(), jt) : null;
      if (current && current.warningId && current.state !== 'unknown' && !toasted.includes(current.warningId)) {
        toasted.push(current.warningId);
        if (toasted.length > MAX_TOASTED) toasted.shift();
        try {
          showToast(current.stateLine, {
            title: current.title,
            tone: 'warning', // one calm toast, whatever the popover's tone: a danger toast would stay until dismissed
            source: 'performance.gpu',
            dedupeKey: current.warningId,
            actions: [{ id: 'gpu_warning_details', label: jt('healthPill.gpu.toastAction', 'View details'), onClick: openPopover }],
          });
        } catch (_error) { /* toast presentation never breaks the pill */ }
      }
      const signature = gpuSignature(current);
      if (signature !== lastSignature) {
        lastSignature = signature;
        onChange();
      }
    }

    async function refresh() {
      if (disposed) return;
      if (fetching) { queued = true; return; }
      fetching = true;
      const response = await Promise.resolve()
        .then(() => bridge.getSnapshot({ schema_version: SCHEMA_VERSION, session_id: HOST_SESSION_ID }))
        .catch(() => null);
      fetching = false;
      if (disposed) return;
      if (isObject(response) && response.ok === true) {
        snapshot = { settings: response.settings, gpu: response.gpu };
        evaluate();
      }
      if (queued) { queued = false; void refresh(); }
    }

    function start() {
      if (disposed || unsubscribe) return;
      if (typeof bridge.onChanged === 'function') {
        try {
          const release = bridge.onChanged((event) => {
            if (isObject(event) && (event.scope === 'gpu' || event.scope === 'settings')) void refresh();
          });
          if (typeof release === 'function') unsubscribe = release;
        } catch (_error) { /* an invalidation feed is optional */ }
      }
      void refresh();
    }

    /* Hide for 10 minutes: the warning_id of THIS render. A stale id (the episode ended or was replaced)
       is not an error to show: the snapshot is re-read and the section simply follows it. */
    async function dismiss() {
      const warningId = current && current.warningId;
      if (disposed || !warningId || typeof bridge.dismissWarning !== 'function') return false;
      const response = await Promise.resolve()
        .then(() => bridge.dismissWarning({ schema_version: SCHEMA_VERSION, session_id: HOST_SESSION_ID, warning_id: warningId }))
        .catch(() => null);
      if (disposed) return false;
      if (isObject(response) && response.ok === true && snapshot) {
        snapshot = { ...snapshot, gpu: isObject(response.gpu) ? response.gpu : snapshot.gpu };
        evaluate();
        return true;
      }
      void refresh();
      return false;
    }

    // The pill's own tone follows an active warning only while it would otherwise read healthy.
    function adjustSignal(signal) {
      if (!current || current.state === 'unknown' || !signal || signal.tone !== 'success') return signal;
      return { ...signal, tone: current.tone, label: current.title, summary: current.stateLine, statusLabel: `${current.title} · ${current.stateLine}`, plain: false };
    }

    function dispose() {
      disposed = true;
      try { if (unsubscribe) unsubscribe(); } catch (_error) { /* best-effort teardown */ }
      unsubscribe = null;
    }

    return {
      start, refresh, dismiss, dispose, adjustSignal,
      view: () => current,
      signature: () => lastSignature,
      sectionHtml: () => buildGpuSection(current, { actionButton: o.actionButton }),
    };
  }

  /* ---- Row 194: the model named in the title bar, and the popover's engine and graphics-memory block ---- */
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const canon = (id) => text(id).toLowerCase().replace(/:latest$/, '');
  const gbNumber = (mb) => Math.round((Number(mb) / 1024) * 10) / 10;
  const PROVIDERS = Object.freeze({ chatgpt: () => 'ChatGPT', 'codex-cli': (jt) => jt('composer.modelPicker.codexCliGroup', 'Codex CLI') });
  const runtimeOf = (snapshot) => (isObject(snapshot) && isObject(snapshot.runtime) ? snapshot.runtime : {});
  const providerOf = (runtime) => (PROVIDERS[text(runtime.engine)] ? PROVIDERS[text(runtime.engine)](resolveJt()) : text(runtime.engine));
  const meterBuilder = () => (globalThis.modelLibrarySectionRender || require('./model-library/model-library-section-render')).buildMemoryMeter;
  // Row 201 C1 / OD-1: the composer picker's helpers own the one team-model predicate and the formatted name.
  const pickerUtils = () => globalThis.rendererComposerModelPickerUtils || require('../chat/renderer-composer-model-picker-utils');
  const isTeamModel = (id) => pickerUtils().isTeamModel(id);
  const shownName = (id) => (isTeamModel(id) ? pickerUtils().displayModelId(id) : id);

  function isCloud(runtime) {
    const residency = text(runtime.local_runtime && runtime.local_runtime.model && runtime.local_runtime.model.residency);
    return residency === 'remote' || residency === 'cli' || Boolean(PROVIDERS[text(runtime.engine)]);
  }

  // The state the control and popover name, or '' while a warning, an error or another lifecycle state owns the words.
  function engineKind(signal, runtime) {
    if (!signal || signal.plain !== true) return '';
    if (signal.loading) return 'loading';
    if (signal.lifecycleState === 'model_unavailable' || signal.lifecycleState === 'unavailable') return 'failed';
    if (signal.lifecycleState !== 'ready') return '';
    if (isCloud(runtime)) return text(runtime.model) ? 'cloud' : '';
    if (isTeamModel(text(runtime.model))) return 'team'; // a teammate's GPU: never "On this PC", nothing here to unload
    if (runtime.model_loaded === true && text(runtime.model)) return 'loaded';
    return runtime.model_loaded === false ? 'idle' : '';
  }

  // The model the pill last named: the popover asks for team names only for a team model (row 201: a PC that never
  // joined a team builds no Team service when the popover opens).
  let lastRuntimeModel = '';
  // The signal (from combineHealthSignal, after any warning) gains kind, modelName and the control's words.
  function nameSignal(signal, snapshot) {
    const runtime = runtimeOf(snapshot);
    lastRuntimeModel = text(runtime.model);
    const kind = engineKind(signal, runtime);
    if (!kind) return signal;
    const lifecycle = isObject(runtime.lifecycle) ? runtime.lifecycle : {};
    const acquisition = isObject(lifecycle.model_acquisition) ? lifecycle.model_acquisition : {};
    const model = text(runtime.model);
    const jt = resolveJt();
    const modelName = shownName(kind === 'loading' || kind === 'failed' ? text(acquisition.requested_model || lifecycle.requested_model) || model : model);
    let words = signal.label;
    if (kind === 'loaded' || kind === 'team') words = shownName(model);
    else if (kind === 'cloud') words = providerOf(runtime) + ' · ' + model;
    else if (kind === 'loading') words = signal.label.replace(/ · (\d+:\d\d)$/, ' $1');
    else if (kind === 'idle') words = jt('healthPill.named.none', 'No model loaded');
    return { ...signal, kind, modelName, words, tone: kind === 'idle' ? 'muted' : signal.tone };
  }

  // input: { signal (named), snapshot, reading (system stats), facts { defaultModel, card, fits } }; null when the control is not named.
  function describeEngine(input) {
    const { signal, snapshot, reading, facts } = input;
    if (!signal || !signal.kind) return null;
    const jt = resolveJt();
    const makeButton = input.actionButton || defaultActionButton;
    const runtime = runtimeOf(snapshot);
    const acquisition = (isObject(runtime.lifecycle) && runtime.lifecycle.model_acquisition) || {};
    const { kind, modelName: name } = signal;
    const engine = markup.engineLabelForRuntime(runtime) || text(runtime.engine);
    const def = text(facts && facts.defaultModel);
    const gpu = reading && isObject(reading.gpuMemory) ? reading.gpuMemory : {};
    const vramMb = gpu.available === true && Number(gpu.totalMb) > 0 ? Number(gpu.totalMb) : 0;
    const usedMb = vramMb ? Math.min(Math.max(Number(gpu.usedMb) || 0, 0), vramMb) : 0;
    const freeMb = vramMb - usedMb;
    const fit = ((facts && facts.fits) || []).find((entry) => canon(entry.modelId) === canon(name));
    const needMb = Number(fit && fit.vramRequiredMb) || 0;
    const onPc = jt('healthPill.engine.onPc', 'On this PC, on {engine}.', { engine });
    const teamId = kind === 'team' ? pickerUtils().parseTeamModel(text(runtime.model)).teamId : '';
    const teamName = (teamId && facts && facts.teams && text(facts.teams[teamId])) || jt('settings.team.joined.unnamed', 'Unnamed team');
    const last = Number(acquisition.last_load_ms) > 0 ? markup.formatLoadClock(acquisition.last_load_ms) : '';
    const overFree = needMb > 0 && vramMb > 0 && needMb > freeMb;
    const reason = text(acquisition.status).split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, '');
    let heading = jt('healthPill.engine.loaded', '{model} is loaded', { model: name });
    let summary;
    const actions = [];
    const loadDefault = (label) => { if (def) actions.push([label, 'load-default']); };
    if (kind === 'loaded') {
      const isDefault = canon(name) === canon(def);
      summary = onPc + (def ? ' ' + (isDefault ? jt('healthPill.engine.isDefault', 'This is your default for new chats.') : jt('healthPill.engine.stillUses', 'New chats still use {model}.', { model: def })) : '');
      actions.push([jt('healthPill.engine.unload', 'Unload'), 'unload-model']);
      if (!isDefault) loadDefault(jt('healthPill.engine.loadDefault', 'Load {model}', { model: def }));
    } else if (kind === 'team') {
      summary = jt('healthPill.engine.team', 'On {team} (shared GPU).', { team: teamName }) + ' '
        + jt('team.engine.notice', 'The team’s host and the person whose hardware responds can read your prompts and replies.')
        + (def ? ' ' + jt('healthPill.engine.cloudDefault', 'New chats use {model}.', { model: def }) : '');
      loadDefault(jt('healthPill.engine.loadDefault', 'Load {model}', { model: def }));
    } else if (kind === 'cloud') {
      summary = jt('healthPill.engine.cloud', 'A cloud model on {provider}. Messages in chats that picked it leave this PC.', { provider: providerOf(runtime) })
        + (def ? ' ' + jt('healthPill.engine.cloudDefault', 'New chats use {model}.', { model: def }) : '');
      loadDefault(jt('healthPill.engine.loadDefault', 'Load {model}', { model: def }));
    } else if (kind === 'loading') {
      heading = signal.label;
      summary = onPc + (last ? ' ' + jt('healthPill.engine.lastTime', 'Last time it took {clock}.', { clock: last }) : '');
    } else if (kind === 'idle') {
      heading = jt('healthPill.engine.nothing', 'Nothing is loaded');
      summary = def ? jt('healthPill.engine.willLoad', 'Jenny loads {model}, your default, with your next message.', { model: def })
        : jt('healthPill.engine.willLoadPlain', 'Jenny loads your default model with your next message.');
      loadDefault(jt('healthPill.engine.loadDefault', 'Load {model}', { model: def }));
    } else {
      heading = jt('healthPill.engine.failed', '{model} did not load', { model: name });
      const none = jt('healthPill.engine.nothingNow', 'Nothing is loaded now.');
      summary = overFree
        ? jt('healthPill.engine.needs', 'It needs about {need} GB of graphics memory and {free} GB is free.', { need: gbNumber(needMb), free: gbNumber(freeMb) }) + ' ' + none
        : (reason ? reason + '. ' : '') + none;
      actions.push([jt('healthPill.popover.retry', 'Retry'), 'retry-model']);
      loadDefault(jt('healthPill.engine.loadDefaultInstead', 'Load {model} instead', { model: def }));
    }
    // The bar and legend come from the builder Running now uses; a failed load is drawn past the end.
    const loading = kind === 'loading' && needMb > 0;
    const failedOver = kind === 'failed' && overFree;
    const shown = loading ? { vramRequiredMb: needMb } : usedMb > 0 ? { vramRequiredMb: usedMb, fitSource: 'observed' } : null;
    const meter = vramMb ? meterBuilder()({
      bar: true, loading, idle: !shown, shown, need: loading ? needMb : usedMb, vramMb,
      preview: failedOver ? { vramRequiredMb: usedMb + needMb } : null,
    }) : null;
    const legend = failedOver
      ? '<span class="mm-preview mm-preview--over"><b>' + escapeHtml(name) + '</b> '
        + escapeHtml(jt('healthPill.engine.wouldUse', 'would use about {n} GB · {m} GB more than is free', { n: gbNumber(needMb), m: gbNumber(needMb - freeMb) }))
        + '</span><span class="mm-free">' + escapeHtml(jt('settings.models.running.free', '{n} free', { n: gbNumber(freeMb) + ' GB' })) + '</span>'
      : meter && meter.legend;
    const size = gbNumber(vramMb) + ' GB';
    const title = !vramMb ? jt('healthPill.engine.cardTitleNone', 'Graphics memory')
      : text(facts && facts.card) ? jt('healthPill.engine.cardTitle', 'Graphics memory · {card}, {size}', { card: text(facts.card), size })
        : jt('healthPill.engine.cardTitleSize', 'Graphics memory · {size}', { size });
    const button = (label, action) => (makeButton ? makeButton({ label, plain: true, className: 'workbench-health-popover-action', dataset: { 'health-pill-action': action } }) : '');
    const gpuHtml = '<div class="workbench-health-popover-gpu" data-engine-gpu>'
      + '<div class="workbench-health-popover-gpu-title">' + escapeHtml(title) + '</div>'
      + (meter ? meter.barHtml + '<div class="mm-legend">' + legend + '</div>' : '<div class="workbench-health-popover-gpu-state">' + escapeHtml(stateLine('unknown', jt)) + '</div>')
      + '<div class="workbench-health-popover-gpu-caveat">' + escapeHtml(jt('healthPill.engine.readWhen', 'Read when you opened this.')) + ' ' + button(jt('healthPill.engine.recheck', 'Recheck'), 'recheck-gpu') + '</div></div>';
    return { kind, heading, summary, gpuHtml, actionsHtml: actions.map(([label, action]) => button(label, action)).join('') };
  }

  /* What the popover reads when it opens (the default model, the card's name, each model's fit), the card reading it
     shows (kept until Recheck or close), and the actions it runs. Nothing is read until load(). */
  function createEngineFacts(o) {
    const shell = () => (o.window && o.window.jennyShell) || {};
    const jt = resolveJt();
    let facts = { defaultModel: '', card: '', fits: [], teams: {} };
    let reading = null;
    let signature = '';
    let retrying = false;
    let restarting = false;
    const changed = () => {
      const next = JSON.stringify([facts, reading && reading.gpuMemory]);
      if (next !== signature) { signature = next; o.onChange(); }
    };
    // team id -> team name, for a team model's "On <team> (shared GPU)"; empty when Team is off or cannot answer.
    async function teamNames() {
      const answer = await Promise.resolve().then(() => shell().team.status()).catch(() => null);
      const names = {};
      for (const team of isObject(answer) && Array.isArray(answer.teams) ? answer.teams : []) {
        if (isObject(team) && text(team.team_id) && text(team.team_name)) names[team.team_id] = text(team.team_name);
      }
      return names;
    }
    async function load() {
      void recheck(); // the card is not read while idle, so the first pushed reading can be old: read it now
      const read = await Promise.resolve().then(() => shell().offline.getDiagnostics()).catch(() => null);
      if (!isObject(read)) return;
      const teams = isTeamModel(lastRuntimeModel) ? await teamNames() : {};
      const card = isObject(read.hardwareProfile) && isObject(read.hardwareProfile.gpu) ? read.hardwareProfile.gpu : {};
      facts = { defaultModel: text(read.preferredLocalModel), card: text(card.name), fits: Array.isArray(read.modelFitEstimates) ? read.modelFitEstimates : [], teams };
      changed();
    }
    function noteReading(payload) { if (!reading && isObject(payload)) { reading = payload; changed(); } }
    async function recheck() {
      const fresh = await Promise.resolve().then(() => shell().system.refreshStats()).catch(() => null);
      if (isObject(fresh)) { reading = fresh; changed(); }
    }
    function modelCall(method, args, failure) {
      const models = shell().models;
      if (!models || typeof models[method] !== 'function') return;
      Promise.resolve().then(() => models[method](...args)).catch(() => o.toast(failure)).finally(() => o.refresh());
      o.refresh();
    }
    // null: not an engine action; true: handled, close the popover; false: handled, keep it open.
    function run(action) {
      const bridge = shell();
      if (action === 'recheck-gpu') { void recheck(); return false; }
      if (action === 'unload-model') modelCall('unload', [], jt('healthPill.engine.unloadFailed', 'Could not unload the model.'));
      else if (action === 'load-default') modelCall('load', [facts.defaultModel], jt('healthPill.engine.loadFailed', 'Could not load {model}.', { model: facts.defaultModel }));
      else if (action === 'retry-model') {
        // One retry is latched in the shell status controller; standalone, the bridge is called once at a time.
        if (o.retryBackendStart) o.retryBackendStart();
        else if (!retrying && bridge.backend && typeof bridge.backend.retryStart === 'function') {
          retrying = true;
          Promise.resolve(bridge.backend.retryStart()).catch(() => {}).finally(() => { retrying = false; });
        }
      } else if (/^restart-(llama-server|ninfer|strata)$/.test(action)) {
        // Crash policy: a managed server is never respawned on its own; this row and the next chat are the two recovery paths.
        const target = { 'restart-ninfer': bridge.ninfer, 'restart-strata': bridge.strata }[action] || bridge.llamaServer;
        if (!restarting && target && typeof target.restart === 'function') {
          restarting = true;
          Promise.resolve(target.restart()).catch(() => {}).finally(() => { restarting = false; o.refresh(); });
        }
      } else return null;
      return true;
    }
    return { load, run, noteReading, drop: () => { reading = null; }, reading: () => reading, facts: () => facts, signature: () => signature };
  }

  return {
    HOST_SESSION_ID, ACTION_HIDE, TONES, safeBasename, stateLine, describeGpu, buildGpuSection, gpuSignature, createGpuFeed,
    nameSignal, describeEngine, createEngineFacts,
  };
});
