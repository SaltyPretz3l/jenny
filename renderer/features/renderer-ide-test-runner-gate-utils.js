/* renderer/features/renderer-ide-test-runner-gate-utils.js — pure helpers for
 * the verification-gate surface inside the Workspace IDE Test Runner panel:
 * the gate header (which config is the gate, its latest verdict, the
 * on-failure mode), per-row attribution ("by Jenny · 2m ago"), and the copy
 * for a rejected configuration save. No DOM, no IPC, no state of its own:
 * every function derives from the panel's injected getState() snapshot, so the
 * panel stays render-only. Loaded before renderer-ide-test-runner-panel.js,
 * which consumes it at factory time. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTestRunnerGateUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  // Mirrors sidecar/ai/routing/verification_gate.py GATE_MAX_RETRIES (1): the
  // first check plus one post-fix re-check. Only copy derives from it here.
  const GATE_MAX_ATTEMPTS = 2;
  const GATE_MODE_OPTIONS = Object.freeze([
    { value: 'retry', label: jt('ide.testRunner.retryOnce', 'Retry once') },
    { value: 'report', label: jt('ide.testRunner.reportOnly', 'Report only') },
  ]);
  const GATE_OFF_VALUE = '';
  const INITIATOR_JENNY = 'jenny';

  const VERDICT_LABELS = {
    passed: 'Passed',
    failed: 'Failed',
    skipped: 'Skipped',
    error: 'Error',
    aborted: 'Aborted',
    timeout: jt('ide.testRunner.timedOut', 'Timed out'),
    interrupted: 'Interrupted',
    running: 'Running',
  };

  const REJECTION_COPY = {
    invalid_id: jt('ide.testRunner.invalidIdReason', 'ids may only use letters, digits, "-" and "_", and must start with a letter or digit'),
    duplicate_id: jt('ide.testRunner.duplicateIdReason', 'a configuration with that id already exists'),
    invalid_command: jt('ide.testRunner.invalidCommandReason', 'the command is missing or too long'),
    invalid_cwd: jt('ide.testRunner.invalidCwdReason', 'the working directory is too long'),
    over_cap: jt('ide.testRunner.overCapReason', 'this workspace already holds the maximum number of configurations'),
    malformed: jt('ide.testRunner.malformedReason', 'the entry could not be read'),
  };

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function count(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }

  function formatDuration(value) {
    const ms = count(value);
    if (ms == null) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  }

  /** Coarse "2m ago" for attribution lines; '' when the stamp is unusable. */
  function formatRelativeTime(value, nowMs) {
    if (value == null || value === '') return '';
    const then = new Date(value).getTime();
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    if (!Number.isFinite(then)) return '';
    const seconds = Math.max(0, Math.round((now - then) / 1000));
    if (seconds < 60) return jt('ide.testRunner.justNow', 'just now');
    if (seconds < 3600) return jt('ide.testRunner.minutesAgo', '{count}m ago', { count: Math.floor(seconds / 60) });
    if (seconds < 86400) return jt('ide.testRunner.hoursAgo', '{count}h ago', { count: Math.floor(seconds / 3600) });
    return jt('ide.testRunner.daysAgo', '{count}d ago', { count: Math.floor(seconds / 86400) });
  }

  function recordsFor(state, configId) {
    const byConfig = state && state.history && state.history.byConfig;
    return byConfig && Array.isArray(byConfig[configId]) ? byConfig[configId] : [];
  }

  function lastRecord(state, configId) {
    const records = recordsFor(state, configId);
    return records.length ? records[records.length - 1] : null;
  }

  function isJennyRun(record) {
    return Boolean(record) && String(record.initiator || '') === INITIATOR_JENNY;
  }

  /** "by Jenny · 2m ago" / "by you · 1h ago" for a config's latest run. */
  function attributionFor(record, nowMs) {
    if (!record) return { text: '', initiator: '' };
    const initiator = isJennyRun(record) ? INITIATOR_JENNY : 'user';
    const who = initiator === INITIATOR_JENNY ? jt('ide.testRunner.byJenny', 'by Jenny') : jt('ide.testRunner.byYou', 'by you');
    const when = formatRelativeTime(record.startedAt || record.finishedAt, nowMs);
    return { text: when ? `${who} · ${when}` : who, initiator };
  }

  function findGate(configs) {
    return (Array.isArray(configs) ? configs : []).find((config) => config && config.gate === true) || null;
  }

  /**
   * The gate header's verdict for the latest Jenny-initiated run of the gate
   * configuration. Copy per the reviewed state table; `status` keys the
   * existing data-status colour tokens.
   */
  function deriveGateVerdict(state, configs) {
    const gate = findGate(configs);
    if (!gate) {
      return {
        status: 'none',
        text: jt('ide.testRunner.noGateSet', 'No gate set'),
        detail: jt('ide.testRunner.noGateDetail', 'pick a test configuration and Jenny will run it before claiming a change works'),
      };
    }
    const label = gate.label || gate.id;
    const running = Boolean(state && state.activeRun) && String(state && state.activeConfigId || '') === gate.id;
    if (running) {
      const live = lastRecord(state, gate.id);
      return {
        status: 'running',
        text: VERDICT_LABELS.running,
        detail: isJennyRun(live) && live.status === 'running'
          ? jt('ide.testRunner.verifyingBeforeFinish', 'verifying {label} before finishing this turn…', { label })
          : jt('ide.testRunner.configIsRunning', '{label} is running', { label }),
      };
    }
    const records = recordsFor(state, gate.id);
    let record = null;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (isJennyRun(records[index])) {
        record = records[index];
        break;
      }
    }
    if (!record) {
      return { status: '', text: '', detail: '' };
    }
    const status = String(record.status || '');
    const passed = count(record.passedCount);
    const failed = count(record.failedCount);
    const duration = formatDuration(record.durationMs);
    if (status === 'passed') {
      return {
        status,
        text: VERDICT_LABELS.passed,
        detail: [passed != null ? String(passed) : '', duration].filter(Boolean).join(' · '),
      };
    }
    if (status === 'skipped') {
      return {
        status,
        text: VERDICT_LABELS.skipped,
        detail: jt('ide.testRunner.turnCompletedUnverified', 'your {label} run was in progress · turn completed unverified', { label }),
      };
    }
    if (status === 'failed') {
      const attempt = count(record.gateAttempt) || 0;
      const counts = failed != null && passed != null ? ` · ${failed} of ${failed + passed}` : '';
      if (attempt >= GATE_MAX_ATTEMPTS) {
        return {
          status,
          text: jtn('ide.testRunner.failedAfterAttempts', attempt, { count: attempt }, 'Failed after {count} attempt', 'Failed after {count} attempts'),
          detail: jt('ide.testRunner.stoppedTrying', 'Jenny stopped trying and reported it'),
        };
      }
      const mode = String(gate.gateOnFailure || 'retry');
      return {
        status,
        text: `${VERDICT_LABELS.failed}${counts}`,
        detail: mode === 'report'
          ? jt('ide.testRunner.reportOnlyNoFix', 'report-only, no fix attempted')
          : jt('ide.testRunner.attemptOf', 'attempt {attempt} of {total}', { attempt: attempt || 1, total: GATE_MAX_ATTEMPTS }),
      };
    }
    return { status, text: VERDICT_LABELS[status] || status, detail: '' };
  }

  /** One sentence for the authoring form when a save dropped the new entry. */
  function describeRejection(rejection) {
    if (!rejection) return '';
    const id = String(rejection.id || '').trim();
    const reason = REJECTION_COPY[String(rejection.reason || '')] || jt('ide.testRunner.notAcceptedReason', 'it was not accepted');
    return id ? jt('ide.testRunner.namedRejection', '"{id}" was not saved: {reason}.', { id, reason }) : jt('ide.testRunner.rejection', 'The configuration was not saved: {reason}.', { reason });
  }

  /**
   * The persistent gate header: GATE label, the gate select (configs + Off),
   * the latest verdict, and the right-aligned on-failure select. A bordered
   * strip, not a card; the verdict colour comes from data-status tokens.
   */
  function buildGateHeaderMarkup({ configs, state, selectField, escapeHtml }) {
    if (typeof selectField !== 'function') {
      return '';
    }
    const list = (Array.isArray(configs) ? configs : []).filter((config) => config && config.id);
    const gate = findGate(list);
    const verdict = deriveGateVerdict(state, list);
    const esc = typeof escapeHtml === 'function' ? escapeHtml : defaultEscapeHtml;
    const gateSelect = selectField({
      id: 'ideTestRunnerGateConfig',
      ariaLabel: jt('ide.testRunner.gateConfiguration', 'Gate configuration'),
      className: 'ide-test-runner-gate__select',
      value: gate ? gate.id : GATE_OFF_VALUE,
      options: list
        .map((config) => ({ value: config.id, label: config.label || config.id }))
        .concat([{ value: GATE_OFF_VALUE, label: jt('common.off', 'Off') }]),
      dataset: { 'test-runner-gate-config': '1' },
    });
    const modeSelect = selectField({
      id: 'ideTestRunnerGateMode',
      ariaLabel: jt('ide.testRunner.onFailure', 'On failure'),
      className: 'ide-test-runner-gate__select ide-test-runner-gate__mode',
      value: gate ? String(gate.gateOnFailure || 'retry') : 'retry',
      options: GATE_MODE_OPTIONS.slice(),
      disabled: !gate,
      dataset: { 'test-runner-gate-mode': '1' },
    });
    return `<div class="ide-test-runner-gate" data-gate-status="${esc(verdict.status)}">`
      + '<span class="ide-test-runner-gate__label">Gate</span>'
      + gateSelect
      + (verdict.text
        ? `<span class="ide-test-runner-gate__verdict" data-status="${esc(verdict.status)}" role="status">${esc(verdict.text)}</span>`
        : '')
      + (verdict.detail ? `<span class="ide-test-runner-gate__detail">${esc(verdict.detail)}</span>` : '')
      + '<span class="ide-test-runner-gate__spacer"></span>'
      + modeSelect
      + '</div>';
  }

  return {
    GATE_MAX_ATTEMPTS,
    GATE_MODE_OPTIONS,
    GATE_OFF_VALUE,
    INITIATOR_JENNY,
    formatRelativeTime,
    attributionFor,
    findGate,
    deriveGateVerdict,
    describeRejection,
    buildGateHeaderMarkup,
  };
});
