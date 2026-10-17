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
    module.exports = factory(require('../shared/string-utils'), require('../inventory/action-button'));
    return;
  }
  root.rendererHealthPillGpu = factory(root.stringUtils, root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, defaultActionButton) {
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
      return { ...signal, tone: current.tone, label: current.title, summary: current.stateLine, statusLabel: `${current.title} · ${current.stateLine}` };
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

  return {
    HOST_SESSION_ID, ACTION_HIDE, TONES, safeBasename, stateLine, describeGpu, buildGpuSection, gpuSignature, createGpuFeed,
  };
});
