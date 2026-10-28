/* renderer/chat/renderer-session-rail-model.js - the session rail's pure model (UMD).

   Row 59 checkpoint 2 (chat workspace parity spec, "Session rail" and the PO decision
   table). No DOM, no I/O: given the C2 summary (`chatWorkspace.getSummary`) and the persisted
   workspace view it returns the five section view models the renderer paints, with the PO's
   words, disclosure defaults and data-state rules:

   - Sections in order Environment, Context, Outputs, Changes, Background tasks.
   - Checking, unavailable and stale are muted words, never zero. Unknown is never 0.
   - A summary that belongs to another session is never shown (it reads as checking).
   - Disclosure defaults apply only where the persisted disclosure is null: Environment open;
     Outputs when it has items; Background tasks when anything is active; Context and Changes
     closed.
   - Docking: docked at >= 920px of pane, or >= 640px while a side panel is open or moving and
     the rail was already docked (a rail that was not docked does not dock when a panel opens).

   Copy goes through jt('chat.sessionRail.*', 'English default'). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-context-preview'));
    return;
  }
  root.rendererSessionRailModel = factory(root.rendererContextPreview);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (contextPreview) {
  'use strict';

  const SECTION_KEYS = Object.freeze(['environment', 'context', 'outputs', 'changes', 'background_tasks']);
  const RAIL_WIDTH_PX = 280;
  const DOCK_MIN_WIDTH_PX = 920;
  const DOCK_MIN_WIDTH_WITH_PANEL_PX = 640;
  const CONTEXT_WARN_RATIO = 0.8;
  const MAX_BACKGROUND_ROWS = 5;

  function fallbackJt(key, fallback, params) {
    return params
      ? String(fallback).replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match))
      : String(fallback);
  }

  function defaultJt() {
    const i18n = typeof globalThis !== 'undefined' ? globalThis.jennyI18n : null;
    return (i18n && typeof i18n.t === 'function') ? i18n.t.bind(i18n) : fallbackJt;
  }

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  /* ── Docking ─────────────────────────────────────────────────────────── */

  /* The responsive rule, with hysteresis: a pane of at least 920px docks; while a side panel is
     open or moving a rail that is already docked keeps docking down to 640px (the pane then keeps
     at least 360px of reading); a rail that was not docked never docks because a panel opened.
     A pane with no measurable width keeps the previous answer. */
  function resolveDocked({ paneWidth, panelActive = false, wasDocked = false } = {}) {
    const width = Number(paneWidth);
    if (!Number.isFinite(width) || width <= 0) return wasDocked === true;
    if (width >= DOCK_MIN_WIDTH_PX) return true;
    return panelActive === true && wasDocked === true && width >= DOCK_MIN_WIDTH_WITH_PANEL_PX;
  }

  /* docked: the rail shows. hidden: docked-capable but the person hid it (rail_visible false).
     undocked: the Session toggle opens a sheet instead. `rail_visible: null` means shown. */
  function resolveRailMode({ docked, railVisible } = {}) {
    if (docked !== true) return 'undocked';
    return railVisible === false ? 'hidden' : 'docked';
  }

  /* ── Words ───────────────────────────────────────────────────────────── */

  function formatTokens(value) {
    const n = count(value);
    if (n === null) return '';
    if (n < 1000) return String(n);
    const unit = n >= 1000000 ? 1000000 : 1000;
    const suffix = unit === 1000000 ? 'M' : 'k';
    const scaled = n / unit;
    const digits = scaled >= 100 ? 0 : 1;
    return `${scaled.toFixed(digits).replace(/\.0$/, '')}${suffix}`;
  }

  /* Percent of the auto-compact point when the next-send estimate carries one, else of the
     window: the composer ring uses the same projection and the same rounding (row 63). */
  function contextPercent(data) {
    const { used, target } = contextPreview.project(data);
    if (used === null || !target) return null;
    return contextPreview.formatPercent(used, target);
  }

  function runModeLabel(mode, jt) {
    const token = text(mode).toLowerCase();
    if (!token) return '';
    if (token === 'ask') return jt('composer.runMode.ask', 'Ask');
    if (token === 'auto') return jt('composer.runMode.auto', 'Auto');
    if (token === 'plan') return jt('composer.runMode.plan', 'Plan');
    return token.charAt(0).toUpperCase() + token.slice(1);
  }

  function executionLabel(value, jt) {
    const token = text(value).toLowerCase();
    if (token === 'local') return jt('chat.sessionRail.environment.local', 'Local');
    if (token === 'sandbox') return jt('chat.sessionRail.environment.sandbox', 'Sandbox');
    if (token === 'hosted') return jt('chat.sessionRail.environment.hosted', 'Hosted');
    return '';
  }

  const TASK_STATES = Object.freeze({
    running: ['running', 'active', 'in_progress', 'started'],
    waiting: ['waiting', 'queued', 'pending', 'paused'],
    failed: ['failed', 'error', 'errored', 'timed_out'],
    attention: ['needs_attention', 'attention'],
    finished: ['completed', 'complete', 'finished', 'succeeded', 'success', 'done', 'cancelled', 'canceled', 'stopped'],
  });

  function taskPhase(state) {
    const token = text(state).toLowerCase();
    for (const phase of Object.keys(TASK_STATES)) {
      if (TASK_STATES[phase].includes(token)) return phase;
    }
    return 'unknown';
  }

  function taskPhaseLabel(phase, jt) {
    if (phase === 'running') return jt('chat.sessionRail.tasks.stateRunning', 'Running');
    if (phase === 'waiting') return jt('chat.sessionRail.tasks.stateWaiting', 'Waiting');
    if (phase === 'failed') return jt('chat.sessionRail.tasks.stateFailed', 'Failed');
    if (phase === 'attention') return jt('chat.sessionRail.tasks.stateAttention', 'Needs attention');
    if (phase === 'finished') return jt('chat.sessionRail.tasks.stateFinished', 'Finished');
    return jt('chat.sessionRail.state.unknown', 'Unknown');
  }

  function taskSourceLabel(kind, jt) {
    const token = text(kind);
    if (token === 'workspace_test') return jt('chat.sessionRail.tasks.sourceWorkspaceTest', 'Workspace tests');
    if (token === 'session_runtime') return jt('chat.sessionRail.tasks.sourceSessionRuntime', 'Session run');
    if (token === 'linked_chat_turn') return jt('chat.sessionRail.tasks.sourceLinkedChat', 'Linked chat');
    return jt('chat.sessionRail.tasks.sourceOther', 'Task');
  }

  function sectionTitle(key, jt) {
    switch (key) {
      case 'environment': return jt('chat.sessionRail.section.environment', 'Environment');
      case 'context': return jt('chat.sessionRail.section.context', 'Context');
      case 'outputs': return jt('chat.sessionRail.section.outputs', 'Outputs');
      case 'changes': return jt('chat.sessionRail.section.changes', 'Changes');
      default: return jt('chat.sessionRail.section.backgroundTasks', 'Background tasks');
    }
  }

  /* ── Section builders ────────────────────────────────────────────────── */

  /* Every builder returns { valueText, parts?, dot?, rows, defaultOpen }.
     `parts` is an alternative to valueText: [{ text, tone: 'add'|'del' }] for the +a -d counts. */
  function empty(valueText) {
    return { valueText, parts: null, dot: null, rows: [], defaultOpen: false };
  }

  function buildEnvironment(data, jt) {
    const rows = [];
    const projectName = text(data.project_name) || jt('chat.sessionRail.environment.noProject', 'No project');
    rows.push({
      kind: 'action', key: 'project', icon: 'project', surface: 'environment', resourceRef: '',
      text: projectName, meta: runModeLabel(data.run_mode, jt), title: projectName,
    });
    const displayPath = text(data.display_path);
    if (displayPath) rows.push({ kind: 'fact', key: 'path', icon: 'folder', text: displayPath, meta: '', title: displayPath, pathLike: true });
    const branch = text(data.branch);
    if (branch) {
      const worktree = text(data.worktree_id) ? jt('chat.sessionRail.environment.worktree', 'worktree') : '';
      rows.push({ kind: 'fact', key: 'branch', icon: 'branch', text: branch, meta: worktree, title: branch });
    }
    return { valueText: executionLabel(data.execution_environment, jt), parts: null, dot: null, rows, defaultOpen: true };
  }

  /* The shared breakdown (window bar, compaction marker, category rows): the composer ring's
     details popover renders the same markup from the same projection. */
  function contextBreakdown(data) {
    return [{ kind: 'breakdown', key: 'breakdown', projection: contextPreview.project(data) }];
  }

  function buildContext(data, jt) {
    const used = count(data.used_tokens);
    const capacity = count(data.capacity_tokens);
    const available = count(data.available_tokens);
    const percent = contextPercent(data);
    const nextSend = data.scope === 'next_send';
    const projection = contextPreview.project(data);
    const rows = nextSend ? contextBreakdown(data) : [];
    let valueText;
    let dot = null;
    if (percent !== null) {
      valueText = percent;
      if (used / projection.target >= CONTEXT_WARN_RATIO) dot = { tone: 'warn', pulse: false };
    } else if (used !== null) {
      valueText = jt('chat.sessionRail.context.tokens', '{count} tokens', { count: formatTokens(used) });
    } else {
      valueText = data.status === 'unavailable' ? jt('chat.sessionRail.state.unavailable', 'Unavailable')
        : data.scope === 'next_send' ? jt('chat.sessionRail.state.checking', 'Checking…') : jt('chat.sessionRail.state.unknown', 'Unknown');
    }
    if (used !== null && nextSend) {
      const line = contextPreview.describeLine(projection);
      if (line) rows.unshift({ kind: 'note', key: 'used', text: line });
    } else if (used !== null) {
      const meta = capacity !== null
        ? jt('chat.sessionRail.context.usedOf', '{used} of {capacity}', { used: formatTokens(used), capacity: formatTokens(capacity) })
        : formatTokens(used);
      rows.unshift({ kind: 'fact', key: 'used', icon: '', text: jt('chat.sessionRail.context.used', 'Used'), meta, title: meta });
    }
    if (available !== null && data.scope !== 'next_send') {
      rows.push({ kind: 'fact', key: 'available', icon: '', text: jt('chat.sessionRail.context.available', 'Available'), meta: formatTokens(available), title: formatTokens(available) });
    }
    if (data.measurement === 'estimated' && data.scope !== 'next_send') {
      rows.push({ kind: 'note', key: 'estimated', text: jt('chat.sessionRail.context.estimated', 'Estimated, not reported by the engine.') });
    }
    rows.push({
      kind: 'note', key: 'scope',
      text: data.scope === 'next_send'
        ? jt('chat.sessionRail.context.nextSend', 'Estimated for the next send; retrieval may add context.')
        : data.scope === 'session'
        ? jt('chat.sessionRail.context.scopeSession', 'Measured across the session.')
        : jt('chat.sessionRail.context.scopeRequest', 'Measured on the latest request.'),
    });
    rows.push({ kind: 'action', key: 'details', icon: '', surface: 'context', resourceRef: '', text: jt('chat.sessionRail.context.details', 'Context details'), meta: '', title: '' });
    return { valueText, parts: null, dot, rows, defaultOpen: false };
  }

  function buildOutputs(data, jt) {
    const items = Array.isArray(data.items) ? data.items.filter((item) => isObject(item) && text(item.artifact_id)) : [];
    const total = count(data.total_count);
    const rows = items.map((item) => {
      const name = text(item.display_name) || text(item.artifact_id);
      const unavailable = text(item.availability) && text(item.availability) !== 'available';
      const kind = text(item.kind);
      return {
        kind: 'action', key: `artifact:${text(item.artifact_id)}`, icon: kind === 'code' || kind === 'text' ? 'code' : 'file',
        surface: 'outputs', resourceRef: text(item.artifact_id), text: name,
        meta: unavailable ? jt('chat.sessionRail.outputs.unavailable', 'Unavailable') : '',
        title: kind ? `${name} (${kind})` : name,
      };
    });
    const shown = rows.length;
    if (total !== null && total > shown) {
      rows.push({
        kind: 'action', key: 'more', icon: '', surface: 'outputs', resourceRef: '',
        text: jt('chat.sessionRail.outputs.more', '{count} more', { count: total - shown }), meta: '', title: '',
      });
    }
    if (!rows.length) rows.push({ kind: 'note', key: 'none', text: jt('chat.sessionRail.outputs.empty', 'Nothing produced in this chat yet.') });
    const valueText = total === null ? String(shown) : (total === 0 ? jt('chat.sessionRail.outputs.none', 'None yet') : String(total));
    return { valueText, parts: null, dot: null, rows, defaultOpen: (total === null ? shown : total) > 0 };
  }

  function buildChanges(data, jt) {
    const files = count(data.file_count);
    const additions = count(data.additions);
    const deletions = count(data.deletions);
    const rows = [];
    let valueText;
    let parts = null;
    if (files === 0) {
      valueText = jt('chat.sessionRail.changes.none', 'No changes');
    } else if (additions !== null && deletions !== null) {
      parts = [{ text: `+${additions}`, tone: 'add' }, { text: `−${deletions}`, tone: 'del' }];
      valueText = `+${additions} −${deletions}`;
    } else if (files !== null) {
      valueText = jt('chat.sessionRail.changes.files', '{count} files', { count: files });
    } else {
      valueText = jt('chat.sessionRail.state.unknown', 'Unknown');
    }
    const scope = jt('chat.sessionRail.changes.scope', 'Working tree');
    rows.push({
      kind: 'fact', key: 'scope', icon: '', text: scope,
      meta: files === null ? '' : jt('chat.sessionRail.changes.files', '{count} files', { count: files }), title: scope,
    });
    const ref = text(data.ref);
    if (ref) rows.push({ kind: 'fact', key: 'ref', icon: 'branch', text: ref, meta: '', title: ref });
    rows.push({ kind: 'action', key: 'review', icon: '', surface: 'changes', resourceRef: '', text: jt('chat.sessionRail.changes.review', 'Review changes'), meta: '', title: '' });
    return { valueText, parts, dot: null, rows, defaultOpen: false };
  }

  function taskDot(phase) {
    if (phase === 'running') return { tone: 'active', pulse: true };
    if (phase === 'waiting') return { tone: 'pending', pulse: false };
    if (phase === 'failed') return { tone: 'error', pulse: false };
    if (phase === 'attention') return { tone: 'warn', pulse: false };
    return null;
  }

  function buildBackgroundTasks(data, jt) {
    const counts = isObject(data.counts) ? data.counts : {};
    const active = count(counts.active);
    const waiting = count(counts.waiting);
    const failed = count(counts.failed);
    const completed = count(counts.completed);
    const items = Array.isArray(data.items) ? data.items.filter(isObject) : [];
    const itemPhases = items.map((item) => taskPhase(item.state));
    const anyActive = (active !== null && active > 0) || itemPhases.includes('running');
    let valueText;
    let dot = null;
    if (active !== null && active > 0) {
      valueText = jt('chat.sessionRail.tasks.running', '{count} running', { count: active });
      dot = taskDot('running');
    } else if (waiting !== null && waiting > 0) {
      valueText = jt('chat.sessionRail.tasks.waiting', '{count} waiting', { count: waiting });
      dot = taskDot('waiting');
    } else if (failed !== null && failed > 0) {
      valueText = jt('chat.sessionRail.tasks.failed', '{count} failed', { count: failed });
      dot = taskDot('failed');
    } else if (data.failed_sources?.length) {
      valueText = jt('chat.sessionRail.state.unavailable', 'Unavailable');
    } else if (active === null || waiting === null) {
      valueText = !items.length && data.coverage === 'partial'
        && Array.isArray(data.unsupported_sources) && data.unsupported_sources.length < 3
        ? jt('chat.sessionRail.outputs.none', 'None yet')
        : jt('chat.sessionRail.state.unknown', 'Unknown');
    } else {
      valueText = completed !== null && completed > 0
        ? jt('chat.sessionRail.tasks.noneRunning', 'None running')
        : jt('chat.sessionRail.outputs.none', 'None yet');
    }
    const rows = [];
    const seen = new Set();
    items.forEach((item, index) => {
      if (rows.length >= MAX_BACKGROUND_ROWS) return;
      const id = text(item.operation_id) || `row-${index}`;
      if (seen.has(id)) return;
      seen.add(id);
      const phase = itemPhases[index];
      const label = taskSourceLabel(item.source_kind, jt);
      const stateWord = taskPhaseLabel(phase, jt);
      /* A linked chat's turn shows the child's title and opens that chat (sessionRef); the surface
         stays background_tasks so a rail without an openSession dependency opens the task detail. */
      const linked = text(item.source_kind) === 'linked_chat_turn' && text(item.session_id);
      const name = linked ? text(item.title) : '';
      rows.push({
        kind: 'action', key: `task:${id}`, icon: '', dot: taskDot(phase), surface: 'background_tasks', resourceRef: '',
        text: name || label, meta: stateWord, title: name ? `${label}: ${name} (${stateWord})` : `${label} (${stateWord})`,
        ...(linked ? { sessionRef: text(item.session_id) } : {}),
      });
    });
    if (completed !== null && completed > 0) {
      rows.push({
        kind: 'action', key: 'finished', icon: 'list', surface: 'background_tasks', resourceRef: '',
        text: jt('chat.sessionRail.tasks.finished', '{count} finished', { count: completed }), meta: '', title: '',
      });
    }
    if (!rows.length) {
      rows.push({ kind: 'action', key: 'activity', icon: 'list', surface: 'background_tasks', resourceRef: '', text: jt('chat.sessionRail.tasks.open', 'View activity'), meta: '', title: '' });
    }
    const unsupported = Array.isArray(data.unsupported_sources) ? data.unsupported_sources : [];
    for (const source of data.failed_sources || []) {
      rows.push({ kind: 'note', key: `failed:${source}`, text: `${taskSourceLabel(source, jt)}: ${jt('chat.sessionRail.state.unavailable', 'Unavailable')}` });
    }
    if (data.coverage === 'partial' || unsupported.length > 0) {
      rows.push({ kind: 'note', key: 'coverage', text: jt('chat.sessionRail.tasks.partial', "Some sources aren't connected yet.") });
    }
    return { valueText, parts: null, dot, rows, defaultOpen: anyActive };
  }

  const BUILDERS = {
    environment: buildEnvironment,
    context: buildContext,
    outputs: buildOutputs,
    changes: buildChanges,
    background_tasks: buildBackgroundTasks,
  };

  function checkingSection(key, jt) {
    return { key, title: sectionTitle(key, jt), state: 'checking', stateWord: jt('chat.sessionRail.state.checking', 'Checking…'), valueText: jt('chat.sessionRail.state.checking', 'Checking…'), parts: null, dot: null, rows: key === 'context' ? contextBreakdown({}) : [], defaultOpen: false, stale: false };
  }

  function unavailableSection(key, jt, state, reason) {
    let word = jt('chat.sessionRail.state.unavailable', 'Unavailable');
    const rows = key === 'context' ? contextBreakdown({}) : [];
    if (state === 'not_applicable') {
      word = reason === 'not_a_git_repository'
        ? jt('chat.sessionRail.changes.notGit', 'Not a Git repository')
        : jt('chat.sessionRail.state.notApplicable', 'Not applicable');
    } else if (state === 'unavailable' && key === 'changes' && reason === 'not_a_git_repository') {
      word = jt('chat.sessionRail.changes.notGit', 'Not a Git repository');
    }
    return { key, title: sectionTitle(key, jt), state, stateWord: word, valueText: word, parts: null, dot: null, rows, defaultOpen: false, stale: false };
  }

  /* One section's view model from its summary wrapper. */
  function buildSection(key, wrapper, jt) {
    if (!isObject(wrapper)) return checkingSection(key, jt);
    const state = text(wrapper.state);
    if (state === 'checking' && !(key === 'context' && wrapper.data?.scope === 'next_send')) return checkingSection(key, jt);
    if (state === 'available' || state === 'stale' || (key === 'context' && wrapper.data?.scope === 'next_send')
      || (key === 'background_tasks' && wrapper.data?.failed_sources?.length)) {
      if (!isObject(wrapper.data)) return unavailableSection(key, jt, 'unavailable', text(wrapper.reason));
      const built = BUILDERS[key](wrapper.data, jt);
      const stale = state === 'stale';
      const staleWord = jt('chat.sessionRail.state.stale', 'stale');
      return {
        key, title: sectionTitle(key, jt), state, stateWord: '',
        valueText: stale && built.valueText ? `${built.valueText} · ${staleWord}` : (stale ? staleWord : built.valueText),
        parts: built.parts, dot: stale ? null : built.dot, rows: built.rows, defaultOpen: built.defaultOpen, stale,
      };
    }
    return unavailableSection(key, jt, state === 'not_applicable' ? 'not_applicable' : 'unavailable', text(wrapper.reason));
  }

  /* Persisted disclosure where set, the section's default otherwise. */
  function resolveOpen(section, persisted, override) {
    if (override === true || override === false) return override;
    const value = isObject(persisted) ? persisted[section.key] : undefined;
    if (value === true || value === false) return value;
    return section.defaultOpen === true;
  }

  /* The rail's whole view model.
       summary        the C2 summary, or null while checking / after a failed fetch
       status         'checking' | 'ready' | 'unavailable' (a failed fetch is unavailable)
       sessionId      the pane's session now; a summary for any other session reads as checking
       workspaceView  the persisted { rail_visible, disclosures, children_expanded }
       overrides      optimistic disclosure toggles not yet confirmed (key -> boolean) */
  function buildRailViewModel({ summary, status = 'ready', sessionId = '', workspaceView = null, overrides = null, jt = defaultJt() } = {}) {
    const belongs = isObject(summary) && text(summary.session_id) === text(sessionId) && text(sessionId) !== '';
    const view = isObject(workspaceView) ? workspaceView : {};
    const disclosures = isObject(view.disclosures) ? view.disclosures : {};
    const pending = isObject(overrides) ? overrides : {};
    const sections = SECTION_KEYS.map((key) => {
      let section;
      if (belongs) section = buildSection(key, summary[key], jt);
      else if (status === 'unavailable') section = unavailableSection(key, jt, 'unavailable', '');
      else section = checkingSection(key, jt);
      return { ...section, open: resolveOpen(section, disclosures, pending[key]) };
    });
    return { sessionId: text(sessionId), status: belongs ? 'ready' : status, sections };
  }

  return {
    SECTION_KEYS,
    defaultJt,
    RAIL_WIDTH_PX,
    DOCK_MIN_WIDTH_PX,
    DOCK_MIN_WIDTH_WITH_PANEL_PX,
    MAX_BACKGROUND_ROWS,
    resolveDocked,
    resolveRailMode,
    formatTokens,
    contextPercent,
    taskPhase,
    buildSection,
    buildRailViewModel,
  };
});
