/* renderer/features/renderer-ide-test-runner-panel.js — content renderer for the
 * Workspace IDE bottom panel's "Test Runner" view AND the S18 config-authoring
 * surface. Render-only off the injected getState() snapshot
 * ({ configs, history:{byConfig}, activeRun, activeConfigId }); every action
 * (run / abort / save) routes through injected callbacks, so the renderer never
 * touches child_process or IPC directly. Models the other bottom-panel content
 * renderers (renderer-ide-run-scripts etc.): paints into getMountEl(), guards a
 * content key so an idle re-render never clobbers in-progress form input.
 *
 * Wired into renderer-ide-controller.js through renderer-ide-test-runner-wiring.js,
 * which owns the cached state snapshot + the bridge and injects render() as the
 * bottom panel's renderTestRunner (mirrors how the 'run' view routes to
 * run-scripts). The panel itself stays render-only off the injected snapshot.
 *
 * Verification gate (variant B, "persistent gate header"): one thin strip above
 * the list names the gate configuration, shows the latest Jenny-run verdict,
 * and carries the on-failure mode; rows gain a gate dot and a "by Jenny · 2m
 * ago" attribution. Designation and mode are ordinary config writes through the
 * same saveConfigs action -- the store (normalizeConfigs) is what enforces
 * "at most one gate", not this panel. All copy/derivation lives in
 * renderer-ide-test-runner-gate-utils.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-ide-test-runner-history-strip.js'),
      require('./renderer-ide-test-runner-gate-utils.js')
    );
    return;
  }
  root.rendererIdeTestRunnerPanel = factory(root.rendererIdeTestRunnerHistoryStrip, root.rendererIdeTestRunnerGateUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (historyStripModule, gateUtilsModule) {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const renderTestRunnerHistoryStrip = historyStripModule
    && typeof historyStripModule.renderTestRunnerHistoryStrip === 'function'
    ? historyStripModule.renderTestRunnerHistoryStrip
    : null;
  const gateUtils = gateUtilsModule && typeof gateUtilsModule.deriveGateVerdict === 'function'
    ? gateUtilsModule
    : null;

  const STATUS_LABELS = {
    passed: 'Passed',
    failed: 'Failed',
    error: 'Error',
    aborted: 'Aborted',
    timeout: 'Timed out',
    interrupted: 'Interrupted',
    running: 'Running',
    // A Jenny run that never started because the user's own run held the lock.
    skipped: 'Skipped',
    none: 'Never run',
  };

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function historyFor(state, configId) {
    const byConfig = state && state.history && state.history.byConfig;
    return byConfig && Array.isArray(byConfig[configId]) ? byConfig[configId] : [];
  }

  function lastRecord(state, configId) {
    const records = historyFor(state, configId);
    return records.length ? records[records.length - 1] : null;
  }

  function lastStatus(state, configId) {
    const last = lastRecord(state, configId);
    return last ? String(last.status || 'none') : 'none';
  }

  function createIdeTestRunnerPanel(deps = {}) {
    const getMountEl = typeof deps.getMountEl === 'function' ? deps.getMountEl : () => null;
    const getState = typeof deps.getState === 'function' ? deps.getState : () => null;
    const actions = deps.actions || {};
    const actionButton = typeof deps.actionButton === 'function'
      ? deps.actionButton
      : (typeof windowRef.inventoryActionButton === 'function' ? windowRef.inventoryActionButton : null);
    const textField = typeof deps.textField === 'function'
      ? deps.textField
      : (typeof windowRef.inventoryTextField === 'function' ? windowRef.inventoryTextField : null);
    const selectField = typeof deps.selectField === 'function'
      ? deps.selectField
      : (typeof windowRef.inventorySelectField === 'function' ? windowRef.inventorySelectField : null);
    const escapeHtml = typeof deps.escapeHtml === 'function' ? deps.escapeHtml : defaultEscapeHtml;
    // Injectable clock so attribution ("2m ago") is deterministic under test.
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

    let boundHost = null;
    // Optimistic baseline for composing rapid mutations: saveConfigs is
    // fire-and-forget and the canonical getState() snapshot only catches up after
    // an IPC round-trip, so two quick add/removes would otherwise both read the
    // same stale snapshot and the second would overwrite the first. Each mutation
    // records its result here; render() drops the overlay once getState() reflects
    // the change (canonical truth wins).
    let pendingConfigs = null;

    function currentConfigs() {
      if (Array.isArray(pendingConfigs)) {
        return pendingConfigs;
      }
      const state = getState() || {};
      return Array.isArray(state.configs) ? state.configs : [];
    }

    // The three row actions share one shape (size 'sm' + variant/class/label/
    // ariaLabel/dataset); centralize the actionButton call + availability guard.
    function buildActionButton(opts) {
      if (typeof actionButton !== 'function') {
        return '';
      }
      return actionButton({
        variant: opts.variant,
        size: 'sm',
        className: opts.className,
        label: opts.label,
        ariaLabel: opts.ariaLabel,
        title: opts.title || opts.ariaLabel,
        disabled: opts.disabled === true,
        dataset: opts.dataset,
      });
    }

    function buildRunButton(config, runDisabled, isRunning) {
      return buildActionButton({
        variant: 'ghost',
        className: 'ide-test-runner-panel__run',
        label: isRunning ? 'Running…' : 'Run',
        ariaLabel: `Run ${config.label || config.id}`,
        disabled: runDisabled,
        dataset: { 'test-runner-run': config.id },
      });
    }

    function buildAbortButton(config) {
      const id = config.id;
      const label = config.label || config.id;
      return buildActionButton({
        variant: 'danger',
        className: 'ide-test-runner-panel__abort',
        label: 'Stop',
        ariaLabel: `Stop ${label}`,
        dataset: { 'test-runner-abort': id },
      });
    }

    // UIUX-033: a live run on this config disables Remove — the backend
    // already refuses this write (CONFIG_ACTIVE_RUN), but a client-side guard
    // avoids even the optimistic-removal round trip: the row (and its Stop
    // control) must never flash out of the list while the process is still
    // running. See also buildActiveRunCard, which keeps Stop reachable
    // independent of this row's presence.
    function buildRemoveButton(config, removeDisabled) {
      return buildActionButton({
        variant: 'ghost',
        className: 'ide-test-runner-panel__remove',
        label: 'Remove',
        ariaLabel: `Remove ${config.label || config.id}`,
        disabled: removeDisabled === true,
        dataset: { 'test-runner-remove': config.id },
      });
    }

    // "by Jenny · 2m ago" beside the status pill. Empty when nothing has run.
    function buildAttribution(state, id) {
      if (!gateUtils) return '';
      const attribution = gateUtils.attributionFor(lastRecord(state, id), now());
      if (!attribution.text) return '';
      return `<span class="ide-test-runner-panel__by" data-initiator="${escapeHtml(attribution.initiator)}">${escapeHtml(attribution.text)}</span>`;
    }

    function buildRow(config, state) {
      const id = config.id;
      const activeRun = state.activeRun || null;
      const isRunning = Boolean(activeRun) && String(state.activeConfigId || '') === id;
      const runDisabled = Boolean(activeRun);
      const status = isRunning ? 'running' : lastStatus(state, id);
      // The gate is marked with a filled dot before the label -- never a
      // left-border bar (design law).
      const gateDot = config.gate === true
        ? '<span class="ide-test-runner-panel__gate-dot" role="img" aria-label="Verification gate" title="Verification gate"></span>'
        : '';
      return `<div class="ide-test-runner-panel__row" data-config-id="${escapeHtml(id)}"${config.gate === true ? ' data-gate="1"' : ''}>`
        + `<span class="ide-test-runner-panel__label">${gateDot}${escapeHtml(config.label || id)}</span>`
        + `<span class="ide-test-runner-panel__status" data-status="${escapeHtml(status)}">${escapeHtml(STATUS_LABELS[status] || status)}</span>`
        + buildAttribution(state, id)
        + `<span class="ide-test-runner-panel__cmd">${escapeHtml(config.command || '')}</span>`
        + '<span class="ide-test-runner-panel__row-actions">'
        + buildRunButton(config, runDisabled, isRunning)
        + (isRunning ? buildAbortButton(config) : '')
        + buildRemoveButton(config, isRunning)
        + '</span>'
        + '</div>';
    }

    function buildField(id, label, placeholder, maxLength) {
      if (typeof textField !== 'function') {
        return '';
      }
      return textField({
        id,
        label,
        placeholder,
        maxLength,
        ariaLabel: label,
        className: 'ide-test-runner-panel__field',
      });
    }

    function buildForm() {
      const add = typeof actionButton === 'function'
        ? actionButton({
          variant: 'primary',
          size: 'sm',
          className: 'ide-test-runner-panel__add',
          label: 'Add test',
          ariaLabel: 'Add test configuration',
          title: 'Add a test configuration',
          dataset: { 'test-runner-add': '1' },
        })
        : '';
      return '<div class="ide-test-runner-panel__form">'
        + '<div class="ide-test-runner-panel__form-title">New configuration</div>'
        + buildField('ideTestRunnerFieldId', 'Id', 'unit', 64)
        + buildField('ideTestRunnerFieldLabel', 'Label', 'Unit tests', 80)
        + buildField('ideTestRunnerFieldCommand', 'Command', 'npm test', 1000)
        + buildField('ideTestRunnerFieldCwd', 'Working dir', '(workspace root)', 300)
        // Why a save dropped the new entry (invalid or duplicate id, ...). Set
        // imperatively after the save resolves; hidden while empty.
        + '<div class="ide-test-runner-panel__form-note" role="status" hidden></div>'
        + add
        + '</div>';
    }

    function buildGateHeader(state, configs) {
      if (!gateUtils) return '';
      return gateUtils.buildGateHeaderMarkup({ configs, state, selectField, escapeHtml });
    }

    // Every field the markup reads must be here or the panel will not repaint
    // when it changes. Gate designation, mode, and run attribution are part of
    // this key -- and deliberately NOT part of configsSig below.
    function computeKey(state, configs) {
      return JSON.stringify([
        configs.map((c) => [
          c && c.id,
          c && c.label,
          c && c.command,
          c && c.cwd,
          c && c.gate === true,
          c && c.gateOnFailure,
          historyFor(state, c && c.id).slice(-30).map((run) => run && [
            run.status, run.durationMs, run.startedAt, run.passedCount, run.failedCount,
            run.initiator, run.gateAttempt, run.skipReason,
          ]),
        ]),
        state.activeRun || null,
        state.activeConfigId || null,
      ]);
    }

    function mountHistory(host, state, configs) {
      if (!renderTestRunnerHistoryStrip) return;
      const rows = host.querySelectorAll('.ide-test-runner-panel__row[data-config-id]');
      configs.filter((config) => config && config.id).forEach((config, index) => {
        const strip = renderTestRunnerHistoryStrip(host.ownerDocument, historyFor(state, config.id));
        if (strip && rows[index]) rows[index].appendChild(strip);
      });
    }

    // UIUX-033: a Stop control bound to the RUN itself (activeRun/
    // activeConfigId), not to a config row's presence in `configs`. Always
    // renders while a run is active, even for a configId that no longer
    // resolves to any entry in the list — the per-row Stop can vanish with the
    // row; this card is the one kill path that can't.
    function buildActiveRunCard(state, configs) {
      const activeRun = state.activeRun || null;
      if (!activeRun) {
        return '';
      }
      const activeConfigId = String(state.activeConfigId || '');
      const config = configs.find((c) => c && c.id === activeConfigId) || null;
      const label = config ? (config.label || config.id) : (activeConfigId || 'a removed configuration');
      const stopBtn = buildActionButton({
        variant: 'danger',
        className: 'ide-test-runner-panel__active-run-stop',
        label: 'Stop',
        ariaLabel: `Stop ${label}`,
        dataset: { 'test-runner-abort': activeConfigId || 'active' },
      });
      return '<div class="ide-test-runner-panel__active-run" role="status">'
        + `<span class="ide-test-runner-panel__active-run-label">Running: ${escapeHtml(label)}</span>`
        + stopBtn
        + '</div>';
    }

    function render() {
      const host = getMountEl();
      if (!host) {
        return;
      }
      ensureBound(host);
      const state = getState() || {};
      const configs = Array.isArray(state.configs) ? state.configs : [];
      const key = computeKey(state, configs);
      // Skip the rebuild when nothing observable changed so an idle re-render
      // never clobbers in-progress authoring-form input — BUT only while our panel
      // is still mounted. The bottom-panel content host is shared across views, so
      // a sibling view (terminal/problems/run) may have replaced our markup since
      // the last render; if so, repaint even when the state key is unchanged.
      if (host.__trPanelKey === key && host.querySelector('.ide-test-runner-panel')) {
        return;
      }
      host.__trPanelKey = key;
      // Drop the optimistic overlay only when the CANONICAL configs actually change
      // (the echo of our write, or an external edit) — NOT on an activeRun/status
      // key change (a run started/finished), which would otherwise strand a second
      // in-flight authoring mutation on a stale pre-save baseline (data loss).
      const configsSig = JSON.stringify(configs.map((c) => [c && c.id, c && c.label, c && c.command, c && c.cwd]));
      if (host.__trPanelConfigsSig !== configsSig) {
        host.__trPanelConfigsSig = configsSig;
        pendingConfigs = null;
      }
      const rows = configs.filter((c) => c && c.id).map((c) => buildRow(c, state)).join('');
      host.innerHTML = '<div class="ide-test-runner-panel">'
        + buildGateHeader(state, configs)
        + buildActiveRunCard(state, configs)
        + '<div class="ide-test-runner-panel__list">'
        + (rows || '<div class="ide-test-runner-panel__empty">No test configurations yet.</div>')
        + '</div>'
        + buildForm()
        + '</div>';
      mountHistory(host, state, configs);
    }

    // WIDE-032: fire the write, and if it comes back refused or rejected, roll
    // the local composition baseline back to what it was before this mutation -
    // otherwise a swallowed failure would strand later add/remove calls on a
    // phantom edit that was never actually persisted. Guarded by reference
    // identity so a rollback can never clobber a NEWER mutation that already
    // superseded this one while the write was in flight.
    function saveAndReconcile(next, baseline) {
      if (typeof actions.saveConfigs !== 'function') {
        return null;
      }
      const outcome = actions.saveConfigs(next);
      if (outcome && typeof outcome.then === 'function') {
        return outcome.then((result) => {
          if (result && result.ok === false && pendingConfigs === next) {
            pendingConfigs = baseline;
          }
          return result;
        });
      }
      return null;
    }

    function setFormNote(text) {
      const host = getMountEl();
      const note = host ? host.querySelector('.ide-test-runner-panel__form-note') : null;
      if (!note) return;
      note.textContent = text || '';
      note.hidden = !text;
    }

    function clearForm(host) {
      ['#ideTestRunnerFieldId', '#ideTestRunnerFieldLabel', '#ideTestRunnerFieldCommand', '#ideTestRunnerFieldCwd']
        .forEach((sel) => {
          const el = host.querySelector(sel);
          if (el) el.value = '';
        });
    }

    function handleAdd() {
      const host = getMountEl();
      if (!host) {
        return;
      }
      const read = (sel) => {
        const el = host.querySelector(sel);
        return el ? String(el.value || '').trim() : '';
      };
      const id = read('#ideTestRunnerFieldId');
      const command = read('#ideTestRunnerFieldCommand');
      // The id + command are the only required fields; an empty add is a no-op.
      if (!id || !command) {
        return;
      }
      // A duplicate never reaches the store: the user's mental model is "I
      // already have a `unit`", so say exactly that instead of a silent drop.
      if (currentConfigs().some((c) => c && c.id === id)) {
        setFormNote(gateUtils ? gateUtils.describeRejection({ id, reason: 'duplicate_id' }) : `"${id}" already exists.`);
        return;
      }
      setFormNote('');
      const baseline = pendingConfigs;
      const next = currentConfigs().concat([{
        id,
        label: read('#ideTestRunnerFieldLabel'),
        command,
        cwd: read('#ideTestRunnerFieldCwd'),
      }]);
      pendingConfigs = next;
      const outcome = saveAndReconcile(next, baseline);
      if (!outcome) {
        return;
      }
      // Clear on CONFIRMED success only: a refused save keeps the user's input
      // for correction, and a normalize-drop (invalid id) says why.
      outcome.then((result) => {
        if (!result || result.ok === false) {
          return;
        }
        const rejection = Array.isArray(result.rejected)
          ? result.rejected.find((entry) => entry && String(entry.id || '') === id)
          : null;
        if (rejection) {
          setFormNote(gateUtils ? gateUtils.describeRejection(rejection) : `"${id}" was not saved.`);
          return;
        }
        const live = getMountEl();
        if (live) {
          clearForm(live);
          setFormNote('');
        }
      });
    }

    // Gate designation: rewrite the `gate` flag across the set (at most one
    // true) and keep the on-failure mode with whichever row holds it. The
    // header's mode select is the workspace's choice, so it follows the gate
    // to a new configuration rather than resetting.
    function handleGateConfigChange(configId, modeHint) {
      const previousGate = gateUtils ? gateUtils.findGate(currentConfigs()) : null;
      const mode = String(modeHint || (previousGate && previousGate.gateOnFailure) || 'retry');
      const baseline = pendingConfigs;
      const next = currentConfigs().map((c) => {
        const isGate = Boolean(configId) && c && c.id === configId;
        return { ...c, gate: isGate, gateOnFailure: isGate ? mode : '' };
      });
      pendingConfigs = next;
      saveAndReconcile(next, baseline);
    }

    function handleGateModeChange(mode) {
      const gate = gateUtils ? gateUtils.findGate(currentConfigs()) : null;
      if (!gate) {
        return;
      }
      const baseline = pendingConfigs;
      const next = currentConfigs().map((c) => (c && c.id === gate.id ? { ...c, gateOnFailure: mode } : c));
      pendingConfigs = next;
      saveAndReconcile(next, baseline);
    }

    function onChange(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      const host = getMountEl();
      if (target.closest('[data-test-runner-gate-config]')) {
        const modeEl = host ? host.querySelector('[data-test-runner-gate-mode]') : null;
        handleGateConfigChange(String(target.value || ''), modeEl ? String(modeEl.value || '') : '');
        return;
      }
      if (target.closest('[data-test-runner-gate-mode]')) {
        handleGateModeChange(String(target.value || 'retry'));
      }
    }

    function handleRemove(configId) {
      if (!configId) {
        return;
      }
      // UIUX-033: refuse client-side (defense-in-depth alongside the backend's
      // CONFIG_ACTIVE_RUN refusal) — never even attempt to compose a save that
      // would drop the configuration with a live run.
      const state = getState() || {};
      if (state.activeRun && String(state.activeConfigId || '') === configId) {
        return;
      }
      const baseline = pendingConfigs;
      const next = currentConfigs().filter((c) => c && c.id !== configId);
      pendingConfigs = next;
      saveAndReconcile(next, baseline);
    }

    function configIdOf(node) {
      const row = node && typeof node.closest === 'function' ? node.closest('[data-config-id]') : null;
      return row ? String(row.dataset.configId || '') : '';
    }

    function onClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      if (target.closest('[data-test-runner-add]')) {
        handleAdd();
        return;
      }
      const removeBtn = target.closest('[data-test-runner-remove]');
      if (removeBtn && !removeBtn.disabled) {
        handleRemove(configIdOf(removeBtn));
        return;
      }
      if (removeBtn) {
        return;
      }
      const abortBtn = target.closest('[data-test-runner-abort]');
      if (abortBtn) {
        if (typeof actions.abort === 'function') {
          actions.abort();
        }
        return;
      }
      const runBtn = target.closest('[data-test-runner-run]');
      if (runBtn && !runBtn.disabled) {
        const id = configIdOf(runBtn);
        if (id && typeof actions.runConfig === 'function') {
          actions.runConfig(id);
        }
      }
    }

    function ensureBound(host) {
      if (!host || host.dataset.trPanelBound === '1') {
        return;
      }
      host.dataset.trPanelBound = '1';
      boundHost = host;
      host.addEventListener('click', onClick);
      host.addEventListener('change', onChange);
    }

    function bindEvents() {
      ensureBound(getMountEl());
    }

    function dispose() {
      if (boundHost) {
        boundHost.removeEventListener('click', onClick);
        boundHost.removeEventListener('change', onChange);
        delete boundHost.dataset.trPanelBound;
        boundHost = null;
      }
    }

    return { render, bindEvents, dispose };
  }

  // STATUS_LABELS is exported for focused panel tests.
  return { createIdeTestRunnerPanel, STATUS_LABELS };
});
