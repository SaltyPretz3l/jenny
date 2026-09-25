(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'), require('../inventory/text-field'));
  } else root.rendererOrchestrationView = factory(root.inventoryActionButton, root.inventoryTextField);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (button, field) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback
    || function (key, fallback, params) { return String(fallback).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match); };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function labels() {
    return {
      prompt: jt('runtime.ui.prompt', 'Instructions'), pause: jt('runtime.ui.pause', 'Pause'),
      developer: jt('settings.sections.developer.title', 'Developer'),
      description: jt('settings.runtimeLimits.description', 'Caps on what the session runtime may admit, and the ledger of work it is tracking. Change these only if you know why.'),
      resume: jt('chat.resumeTurn.resume', 'Resume'), cancel: jt('common.cancel', 'Cancel'),
      refresh: jt('common.refresh', 'Refresh'), save: jt('common.save', 'Save'),
      next: jt('runtime.ui.next', 'Next page'), first: jt('runtime.ui.first', 'First page'),
      open: jt('runtime.ui.open', 'Open conversation'), edit: jt('runtime.ui.edit', 'Update pending instructions'),
      work: jt('runtime.ui.work', 'Work'), limits: jt('runtime.ui.limits', 'Runtime limits'),
      local: jt('settings.usage.localBadge', 'Local'), cloud: jt('settings.advanced.cloud', 'Cloud'),
      resources: jt('runtime.ui.resources', 'Shared resources'),
      runnable_turns: jt('runtime.ui.turns', 'Runnable turns'), inference_requests: jt('runtime.ui.requests', 'Inference requests'),
      input_tokens: jt('runtime.ui.inputTokens', 'Input tokens'), output_tokens: jt('runtime.ui.outputTokens', 'Output tokens'),
      descendants: jt('runtime.ui.descendants', 'Maximum children'), descendant_depth: jt('runtime.ui.depth', 'Maximum child depth'),
      tool_operations: jt('runtime.ui.toolOperations', 'Tool operations'), native_processes: jt('runtime.ui.processes', 'Native processes'),
      tests: jt('runtime.ui.tests', 'Tests'), pending: jt('diagnostics.runtimeHealth.pending', 'Pending'),
      running: jt('setup.hub.running', 'Running'), paused: jt('runtime.ui.paused', 'Paused'),
      completed: jt('chat.footer.completed', 'Completed'), failed: jt('chat.footer.failed', 'Failed'),
      cancelled: jt('chat.terminalState.cancelledLabel', 'Cancelled'), needs_attention: jt('runtime.ui.attention', 'Needs attention'),
      requested: jt('runtime.ui.requested', 'Cancellation requested; waiting for cleanup'),
      pauseRequested: jt('runtime.ui.pauseRequested', 'Pause requested'),
      empty: jt('runtime.ui.empty', 'No work on this page.'), unavailable: jt('runtime.ui.unavailable', 'Runtime information is unavailable.'),
      off: jt('runtime.ui.off', 'Runtime is off. History and settings remain available.'),
      failedAction: jt('runtime.ui.failedAction', 'The change could not be applied. Refresh and try again.'),
      limitsHint: jt('runtime.ui.limitsHint', 'Limits affect new admission. Existing work keeps its resources until cleanup finishes.'),
    };
  }
  function render(host, model) {
    if (!host) return;
    const l = labels();
    const snapshot = model.snapshot;
    const draft = model.draft;
    const busy = model.busy || model.externalBusy;
    const disabled = busy || !snapshot || !snapshot.enabled || snapshot.read_only || snapshot.closing;
    const action = (name, text, extra = {}) => button({ id: name, label: text, title: text, ariaLabel: text, ...extra });
    const input = (key, label, fallback = '', extra = {}) => field({ id: `orchestration_${key}`, label,
      ariaLabel: label, value: draft[key] ?? fallback, dataset: { draft: key }, ...extra });
    const active = host.ownerDocument.activeElement;
    const focus = host.contains(active) ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
    // No "Start work" form here (owner decision 2026-09-20): the chat composer is
    // the only surface that starts work. This page inspects and caps it.
    let html = '<div class="settings-card-header"><h3>' + escape(l.limits) + '</h3>'
      + '<span class="settings-badge">' + escape(l.developer) + '</span></div>'
      + '<p class="settings-copy">' + escape(l.description) + '</p>'
      + (!snapshot?.enabled ? '<p class="settings-note" role="status">' + escape(l.off) + '</p>' : '');
    html += '<div class="settings-group settings-group--wide"><h3>' + escape(l.work) + '</h3>'
      + action('runtime-refresh', l.refresh, { disabled: busy })
      + action('runtime-first', l.first, { disabled: busy || !model.cursor })
      + action('runtime-next', l.next, { disabled: busy || !snapshot?.next_cursor })
      + '<p role="status" aria-live="polite">' + escape(model.message || '') + '</p>';
    if (snapshot) html += '<p>' + escape(jt('runtime.ui.counts', 'Active: {active} · Waiting: {waiting} · Quarantined: {quarantined}', {
      active: snapshot.lanes.counts.active_leases, waiting: snapshot.resources.counts.waiter_count,
      quarantined: snapshot.lanes.counts.quarantined + snapshot.resources.counts.quarantined_count })) + '</p>';
    const rows = snapshot?.work || [];
    html += rows.length ? '<ul class="settings-list">' + rows.map(work => '<li>'
      + action('runtime-inspect', work.purpose, { domId: `runtime_work_${work.work_id}`,
        dataset: { 'work-id': work.work_id }, ariaLabel: `${work.purpose}: ${l[work.status] || l.unavailable}` })
      + '<span>' + escape(l[work.status] || l.unavailable) + '</span></li>').join('') + '</ul>' : '<p>' + escape(l.empty) + '</p>';
    const detail = model.detail;
    if (detail?.work) {
      const work = detail.work;
      const c = detail.coordination;
      // A persisted pause intent is not a pause: a running turn keeps its actor
      // until the runtime settles the request at its own boundary.
      const pauseRequested = work.control?.kind === 'pause' && work.status === 'running';
      const label = work.control?.kind === 'cancel' && !c?.cleanup_confirmed ? l.requested
        : pauseRequested ? l.pauseRequested
          : l[work.status] || l.unavailable;
      html += '<div class="settings-group"><h4>' + escape(work.purpose) + '</h4><p>'
        + escape(label) + '</p>';
      // A pause already asked for is not asked for twice.
      html += action('runtime-pause', l.pause, { disabled: busy || model.workControlAllowed === false || pauseRequested || !['pending', 'running'].includes(work.status) })
        + action('runtime-resume', l.resume, { disabled: disabled || model.workControlAllowed === false || work.status !== 'paused' })
        + action('runtime-cancel', l.cancel, { disabled: busy || model.workControlAllowed === false || work.status === 'cancelled', variant: 'danger' })
        + action('runtime-open', l.open, { disabled: busy });
      if (c?.editable) html += input('edit', l.prompt, '', { multiline: true, disabled: busy || model.workControlAllowed === false })
        + action('runtime-edit', l.edit, { disabled: busy || model.workControlAllowed === false });
      if (c?.parent_work_id) html += action('runtime-inspect', jt('runtime.ui.parent', 'Parent work'), { dataset: { 'work-id': c.parent_work_id } });
      if (c?.progress) html += '<p>' + escape(jt('runtime.ui.progress', 'Progress: {iterations} iterations, {tools} tool calls', {
        iterations: c.progress.completed_iterations, tools: c.progress.tool_calls_consumed })) + '</p>';
      if (c?.wait) html += '<p>' + escape(jt('runtime.ui.waiting', 'Waiting: {reason}', {
        reason: c.wait.kind === 'dependency' ? jt('runtime.ui.childWait', 'Child work') : l[c.wait.resource_class] || l.paused })) + '</p>';
      if (c?.budget) html += '<dl>' + ['inference_requests', 'input_tokens', 'output_tokens'].map(key => '<dt>' + escape(l[key])
        + '</dt><dd>' + escape(`${c.budget.charged[key]} / ${c.budget.limits[key]}`) + '</dd>').join('') + '</dl>';
      if (c?.child_count) html += '<p>' + escape(jt('runtime.ui.children', 'Children: {count}', { count: c.child_count })) + '</p><ul>'
        + c.children.map(child => '<li>' + action('runtime-inspect', child.purpose || l.pending, { dataset: { 'work-id': child.work_id } })
          + ' ' + escape(l[child.status] || l.pending) + '</li>').join('') + '</ul>'
        + action('runtime-children', l.next, { disabled: c.next_child_offset === null || busy });
      if (c?.available === false) html += '<p role="status">' + escape(l.unavailable) + '</p>';
      html += '</div>';
    }
    html += '</div><div class="settings-group settings-group--wide"><h3>' + escape(l.limits) + '</h3><p>' + escape(l.limitsHint) + '</p>';
    if (snapshot) {
      const groups = { ...snapshot.lanes.configured_limits, resources: snapshot.resources.configured_limits };
      for (const [group, limits] of Object.entries(groups)) {
        html += '<h4>' + escape(l[group]) + '</h4>';
        for (const [key, value] of Object.entries(limits)) {
          const effective = group === 'resources' ? snapshot.resources.effective_limits[key] : snapshot.lanes.effective_limits[group][key];
          html += input(`limit_${group}_${key}`, l[key], value, { disabled: busy || snapshot.read_only || snapshot.closing,
            hint: jt('runtime.ui.effective', 'Configured: {configured} · Effective: {effective}', { configured: value, effective }) });
        }
      }
      html += action('runtime-limits', l.save, { disabled: busy || snapshot.read_only || snapshot.closing });
    }
    host.innerHTML = html + '</div>';
    if (focus?.id) {
      const target = host.ownerDocument.getElementById(focus.id);
      target?.focus({ preventScroll: true });
      if (Number.isInteger(focus.start)) target?.setSelectionRange?.(focus.start, focus.end);
    }
  }
  return { render, labels };
});
