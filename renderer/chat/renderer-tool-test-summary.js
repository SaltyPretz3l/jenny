(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererToolTestSummary = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, p, one, other) { return jt.call(null, k, count === 1 ? one : other, p); };
  /* Test-run progress markup (row 96), shared by the live block a running test
     command shows (renderer-stream-test-progress.js) and the finished row's
     record, built from the run_command result's metadata.test_summary. Option B
     of the 2026-11-01 review: a bar with failure ticks, one counts line, the
     per-file grid and the failures by name. Pure markup plus one delegated
     click handler for its links; no state of its own. */

  const escapeHtml = (value) => stringUtils.escapeHtml(String(value == null ? '' : value));
  const MAX_SHOWN_FAILURES = 5;
  const CELL_STATES = { '-': '', r: 'run', p: 'ok', s: 'skip', f: 'bad' };

  const count = (value) => Number(value || 0).toLocaleString(globalThis.jennyI18n?.tag?.());
  const clock = (ms) => {
    const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes >= 60
      ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
      : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const percentText = (percent) => `${Math.floor(Number(percent) || 0)}%`;

  /* The finished record arrives snake_case in tool metadata; the live event is camelCase. */
  function fromSummary(metadata) {
    const raw = metadata && typeof metadata === 'object' ? metadata.test_summary : null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const grid = raw.grid && typeof raw.grid === 'object' && typeof raw.grid.states === 'string' ? raw.grid : null;
    return {
      runner: String(raw.runner || ''),
      unit: String(raw.unit || 'none'),
      total: Number.isFinite(raw.total) ? raw.total : null,
      totalUnit: raw.total_unit === 'files' ? 'files' : 'tests',
      tests: Number(raw.tests) || 0,
      passed: Number(raw.passed) || 0,
      failed: Number(raw.failed) || 0,
      skipped: Number(raw.skipped) || 0,
      failures: Array.isArray(raw.failures) ? raw.failures.filter((item) => item && typeof item === 'object') : [],
      grid: grid ? { count: grid.states.length, group: Number(grid.group) || 1, px: grid.px === 4 ? 4 : 6, states: grid.states } : null,
    };
  }

  /* Header meta of a finished test command: "3 failed · 15,944 passed" (skipped lives in the record). */
  function headerMeta(toolName, metadata) {
    if (String(toolName || '') !== 'run_command') return '';
    const summary = fromSummary(metadata);
    if (!summary) return '';
    const passed = jtn('chat.testProgress.passed', summary.passed, { count: count(summary.passed) }, '{count} passed', '{count} passed');
    return summary.failed
      ? jt('chat.testProgress.failedPassed', '{failed} failed · {passed}', {
        failed: count(summary.failed), passed,
      })
      : passed;
  }

  function barHtml(percent, failures) {
    const value = Math.min(100, Math.max(0, Number(percent) || 0));
    const ticks = (failures || []).map((item) => `<span class="tool-test-progress-tick" style="inset-inline-start:${(Math.min(1, Math.max(0, Number(item.at) || 0)) * 100).toFixed(2)}%"></span>`).join('');
    return `<div class="inv-progress tool-test-progress-bar" role="progressbar" aria-label="${escapeHtml(jt('chat.testProgress.progressLabel', 'Test progress'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor(value)}">`
      + `<div class="inv-progress-track"><div class="inv-progress-fill" style="--progress:${value.toFixed(2)}%"></div>${ticks}</div></div>`;
  }

  /* The live counts line: done of total, failed, skipped, then time left. */
  function countsText(data) {
    const parts = [];
    if (data.total != null && data.totalUnit === 'files') {
      parts.push(jt('chat.testProgress.ofFiles', '{done} of {total} files', { done: count(data.done), total: count(data.total) }));
      if (data.tests) parts.push(jtn('chat.testProgress.tests', data.tests, { count: count(data.tests) }, '{count} test', '{count} tests'));
    } else if (data.total != null) {
      parts.push(jt('chat.testProgress.ofTests', '{done} of {total} tests', { done: count(data.done), total: count(data.total) }));
    } else {
      parts.push(jtn('chat.testProgress.tests', data.tests, { count: count(data.tests) }, '{count} test', '{count} tests'));
    }
    const badIndex = data.failed ? parts.push(jtn('chat.testProgress.failed', data.failed, { count: count(data.failed) }, '{count} failed', '{count} failed')) - 1 : -1;
    if (data.skipped) parts.push(jtn('chat.testProgress.skipped', data.skipped, { count: count(data.skipped) }, '{count} skipped', '{count} skipped'));
    if (data.percent == null) parts.push(clock(data.elapsedMs));
    else if (data.etaMs != null) parts.push(jt('chat.testProgress.timeLeft', 'about {time} left', { time: clock(data.etaMs) }));
    else if (!data.final) parts.push(jt('chat.testProgress.estimating', 'estimating time left'));
    // The failed count reads in the error colour.
    return parts.map((part, index) => (index === badIndex
      ? `<span class="tool-test-progress-bad">${escapeHtml(part)}</span>`
      : escapeHtml(part))).join(' · ');
  }

  function linkHtml(action, label) {
    return `<span class="tool-call-row-link" role="link" tabindex="0" data-test-progress-action="${action}">${escapeHtml(label)}</span>`;
  }

  function gridToggleLabel(open) {
    return open ? jt('chat.testProgress.hideFiles', 'Hide files') : jt('chat.testProgress.showFiles', 'Files');
  }

  function outputToggleLabel(open) {
    return open ? jt('chat.testProgress.hideOutput', 'Hide output') : jt('chat.testProgress.showOutput', 'Show output');
  }

  function unitNote(unit, grid, total) {
    if (unit === 'order') {
      const size = Math.max(1, Math.round((Number(total) || grid.count) / grid.count));
      return jtn('chat.testProgress.unitOrder', size, { count: count(size) }, 'each cell is {count} test, in the order they finished', 'each cell is {count} tests, in the order they finished');
    }
    if (grid.group > 1) {
      return jt('chat.testProgress.unitGrouped', '{cells} cells · each is {group} files', { cells: count(grid.count), group: count(grid.group) });
    }
    return jtn('chat.testProgress.unitFiles', grid.count, { count: count(grid.count) }, '{count} file', '{count} files');
  }

  function cellsHtml(states, labels) {
    let html = '';
    for (let index = 0; index < states.length; index += 1) {
      const label = labels && labels[index] ? ` title="${escapeHtml(labels[index])}"` : '';
      html += `<span class="tool-test-progress-cell" data-s="${CELL_STATES[states[index]] || ''}"${label}></span>`;
    }
    return html;
  }

  function gridHtml(unit, grid, total, labels) {
    const legend = [
      ['', jt('chat.testProgress.legendWaiting', 'Waiting')],
      ['run', jt('chat.testProgress.legendRunning', 'Running')],
      ['ok', jt('chat.testProgress.legendPassing', 'Passing')],
      ['bad', jt('chat.testProgress.legendFailed', 'Failed')],
    ].map(([state, label]) => `<span><i class="tool-test-progress-cell" data-s="${state}" aria-hidden="true"></i>${escapeHtml(label)}</span>`).join('');
    return `<div class="tool-test-progress-grid" data-px="${grid.px}" aria-label="${escapeHtml(jt('chat.testProgress.gridLabel', 'Test files'))}">${cellsHtml(grid.states, labels)}</div>`
      + `<div class="tool-test-progress-legend">${legend}<span class="tool-test-progress-unit">${escapeHtml(unitNote(unit, grid, total))}</span></div>`;
  }

  function failuresHtml(failures) {
    const list = Array.isArray(failures) ? failures : [];
    if (!list.length) return '';
    const shown = list.slice(0, MAX_SHOWN_FAILURES).map((item, index) => {
      const file = String(item.file || '');
      const name = String(item.name || file);
      const base = file.split(/[\\/]/).pop();
      return `<li class="tool-test-progress-fail" role="link" tabindex="0" data-test-progress-fail="${index}" data-test-name="${escapeHtml(name)}" title="${escapeHtml(file ? `${file} · ${name}` : name)}">`
        + '<span class="status-dot status-dot--error" aria-hidden="true"></span>'
        + `<span class="tool-test-progress-fail-name">${escapeHtml(name)}</span>`
        + (base && base !== name ? `<span class="tool-test-progress-fail-file">${escapeHtml(base)}</span>` : '')
        + '</li>';
    }).join('');
    const more = list.length > MAX_SHOWN_FAILURES
      ? `<li class="tool-test-progress-more">${escapeHtml(jt('chat.testProgress.more', '+{count} more', { count: count(list.length - MAX_SHOWN_FAILURES) }))}</li>`
      : '';
    return `<ul class="tool-test-progress-fails">${shown}${more}</ul>`;
  }

  /* The finished record beside a settled test command's header: skipped, the
     folded grid and the failures. Empty for anything that is not a test run. */
  function renderFinished(toolName, metadata) {
    if (String(toolName || '') !== 'run_command') return '';
    const summary = fromSummary(metadata);
    if (!summary) return '';
    const skipped = summary.skipped
      ? `<span>${escapeHtml(jtn('chat.testProgress.skipped', summary.skipped, { count: count(summary.skipped) }, '{count} skipped', '{count} skipped'))}</span>` : '';
    const gridLink = summary.grid ? linkHtml('grid', gridToggleLabel(false)) : '';
    if (!skipped && !gridLink && !summary.failures.length) return '';
    const line = skipped || gridLink ? `<div class="tool-test-progress-line">${skipped}<span class="tool-test-progress-links">${gridLink}</span></div>` : '';
    // The grid stays folded until Files is clicked, so its cells are built then, not with every render.
    const grid = summary.grid
      ? `<div class="tool-test-progress-grid-wrap" data-unit="${escapeHtml(summary.unit)}" data-total="${Number(summary.total) || 0}" data-group="${summary.grid.group}" data-px="${summary.grid.px}" data-states="${escapeHtml(summary.grid.states)}"></div>`
      : '';
    return `<div class="tool-test-progress" data-test-progress-state="finished" data-grid-open="false">${line}${grid}${failuresHtml(summary.failures)}</div>`;
  }

  /* Open the row's output (its live tail while running, its Output panel once
     settled) and select the failure's line when the output still holds it. */
  function revealFailure(block, name) {
    const row = block.closest('.tool-call-row');
    if (!row) return;
    if (row.getAttribute('data-expanded') !== 'true') row.querySelector('.tool-call-row-toggle')?.click();
    const doc = row.ownerDocument;
    const win = doc.defaultView;
    win.requestAnimationFrame(() => {
      for (const pre of row.querySelectorAll('.tool-live-output-text, .tool-call-output, pre')) {
        const node = [...pre.childNodes].find((child) => child.nodeType === 3 && child.textContent.includes(name));
        if (!node) continue;
        const start = node.textContent.lastIndexOf(name);
        const range = doc.createRange();
        const lineStart = node.textContent.lastIndexOf('\n', start) + 1;
        const lineEnd = node.textContent.indexOf('\n', start);
        range.setStart(node, lineStart);
        range.setEnd(node, lineEnd < 0 ? node.textContent.length : lineEnd);
        const selection = win.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const rect = range.getBoundingClientRect();
        const box = pre.closest('.tool-live-output') || pre;
        box.scrollTop += rect.top - box.getBoundingClientRect().top - box.clientHeight / 3;
        return;
      }
    });
  }

  function activate(target) {
    const block = target.closest('.tool-test-progress');
    if (!block) return false;
    const fail = target.closest('[data-test-progress-fail]');
    if (fail) {
      revealFailure(block, fail.getAttribute('data-test-name') || '');
      return true;
    }
    const action = target.closest('[data-test-progress-action]');
    if (!action) return false;
    if (action.getAttribute('data-test-progress-action') === 'grid') {
      const open = block.getAttribute('data-grid-open') !== 'true';
      const lazy = block.querySelector(':scope > .tool-test-progress-grid-wrap[data-states]');
      if (open && lazy && !lazy.firstChild) {
        const states = lazy.getAttribute('data-states');
        const grid = { count: states.length, group: Number(lazy.getAttribute('data-group')) || 1, px: lazy.getAttribute('data-px') === '4' ? 4 : 6, states };
        lazy.innerHTML = gridHtml(lazy.getAttribute('data-unit'), grid, Number(lazy.getAttribute('data-total')) || null, null);
      }
      block.setAttribute('data-grid-open', String(open));
      action.textContent = gridToggleLabel(open);
      return true;
    }
    const row = block.closest('.tool-call-row');
    row?.querySelector('.tool-call-row-toggle')?.click();
    action.textContent = outputToggleLabel(row?.getAttribute('data-expanded') === 'true');
    return true;
  }

  /* One delegated handler per document covers live and finished blocks alike. */
  function installActions(doc) {
    if (!doc || doc.__toolTestProgressActions) return;
    doc.__toolTestProgressActions = true;
    doc.addEventListener('click', (event) => {
      if (event.target?.closest) activate(event.target);
    });
    doc.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target?.closest?.('.tool-test-progress [role="link"]')) {
        event.preventDefault();
        activate(event.target);
      }
    });
  }

  if (typeof document !== 'undefined') installActions(document);

  return {
    CELL_STATES, percentText, headerMeta, barHtml, countsText, linkHtml, gridToggleLabel, outputToggleLabel,
    gridHtml, failuresHtml, renderFinished, installActions,
  };
});
