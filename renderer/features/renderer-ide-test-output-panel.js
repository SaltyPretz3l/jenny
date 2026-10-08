/* renderer/features/renderer-ide-test-output-panel.js - the read-only "Tests: <name>"
 * task view (row 40 W4, owner decision F6). The Test Runner's "Show output" action
 * selects a config; this view paints that config's latest run output (the bounded
 * tails the Test Runner wiring keeps per config, in memory) with the same footer
 * actions as the Run task: Run again, and Ask Jenny to fix when the run failed.
 * Render-only off injected getters; every action routes through injected callbacks.
 * Paints into getMountEl() behind a markup-equality render guard (an idle re-render
 * never rewrites the DOM or loses the output's scroll position) and binds one
 * delegated click listener on its host. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-ide-run-task-footer.js'));
    return;
  }
  root.rendererIdeTestOutputPanel = factory(root.rendererIdeRunTaskFooter);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (footerModule) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const defaultEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  // Run record -> 'passed' | 'stopped' | 'failed' (anything that neither passed nor was stopped).
  function outcomeOf(record) {
    const status = String((record && record.status) || '');
    if (status === 'passed') {
      return 'passed';
    }
    return status === 'aborted' ? 'stopped' : 'failed';
  }

  function resultLabel(record) {
    const outcome = outcomeOf(record);
    if (outcome === 'passed') {
      return jt('ide.testOutput.passed', 'Passed');
    }
    if (outcome === 'stopped') {
      return jt('ide.testOutput.stopped', 'Stopped');
    }
    return record.exitCode != null
      ? jt('ide.testOutput.failedExit', 'Failed (exit {code})', { code: record.exitCode })
      : jt('ide.testOutput.failed', 'Failed');
  }

  function outputText(record) {
    return [record.stdoutTail, record.stderrTail].filter((part) => part && String(part).length).join('\n');
  }

  function createIdeTestOutputPanel(deps) {
    const options = deps || {};
    const getMountEl = typeof options.getMountEl === 'function' ? options.getMountEl : () => null;
    const isActivePanel = typeof options.isActivePanel === 'function' ? options.isActivePanel : () => false;
    const getSelection = typeof options.getSelection === 'function' ? options.getSelection : () => null;
    const getRunOutput = typeof options.getRunOutput === 'function' ? options.getRunOutput : () => null;
    const getConfigLabel = typeof options.getConfigLabel === 'function' ? options.getConfigLabel : (id) => id;
    const onRunAgain = typeof options.onRunAgain === 'function' ? options.onRunAgain : () => {};
    const onAskJenny = typeof options.onAskJenny === 'function' ? options.onAskJenny : () => {};
    const escapeHtml = typeof options.escapeHtml === 'function' ? options.escapeHtml : defaultEscapeHtml;
    const actionButton = typeof options.actionButton === 'function' ? options.actionButton : null;
    const footer = footerModule || {};

    let boundHost = null;

    function selectedConfigId() {
      const selection = getSelection();
      return selection && selection.configId ? String(selection.configId) : '';
    }

    function currentRecord() {
      const configId = selectedConfigId();
      return configId ? (getRunOutput(configId) || null) : null;
    }

    // The controller shows the view only while the selected config has output.
    function hasOutput() {
      return currentRecord() !== null;
    }

    function titleFor(configId) {
      return jt('ide.testOutput.title', 'Tests: {name}', { name: String(getConfigLabel(configId) || configId) });
    }

    function buildMarkup() {
      const configId = selectedConfigId();
      const record = currentRecord();
      if (!record) {
        return '<div class="ide-rail-placeholder">' + escapeHtml(jt('ide.testOutput.empty', 'No test output yet. Run a test, then choose Show output.')) + '</div>';
      }
      // The header carries the result, so the footer's status line stays empty here.
      const footerMarkup = typeof footer.buildFooterMarkup === 'function'
        ? footer.buildFooterMarkup({ actionButton, escapeHtml, text: '', showAsk: outcomeOf(record) === 'failed' })
        : '';
      return '<div class="ide-task-view" data-ide-test-output>'
        + '<div class="ide-task-output-header">'
        + `<span class="ide-task-output-title">${escapeHtml(titleFor(configId))}</span>`
        + `<span class="ide-task-output-result" data-outcome="${outcomeOf(record)}">${escapeHtml(resultLabel(record))}</span>`
        + '</div>'
        + `<pre class="ide-task-output" tabindex="0">${escapeHtml(outputText(record))}</pre>`
        + footerMarkup
        + '</div>';
    }

    function onClick(event) {
      if (!isActivePanel()) {
        return;
      }
      const action = typeof footer.actionOf === 'function' ? footer.actionOf(event) : '';
      const configId = selectedConfigId();
      if (!action || !configId) {
        return;
      }
      if (action === 'rerun') {
        onRunAgain(configId);
        return;
      }
      const record = currentRecord();
      if (action === 'ask' && record && outcomeOf(record) === 'failed') {
        onAskJenny(footer.buildAskJennyPayload(titleFor(configId), outputText(record)));
      }
    }

    function bindEvents() {
      const host = getMountEl();
      if (host && host !== boundHost) {
        boundHost?.removeEventListener('click', onClick);
        boundHost = host;
        host.addEventListener('click', onClick);
      }
    }

    function render() {
      const host = getMountEl();
      if (!host || !isActivePanel()) {
        return;
      }
      bindEvents();
      const markup = buildMarkup();
      // Skip an identical repaint, but only while our markup is still mounted (a
      // sibling view may have replaced the host's children since).
      if (host.__ideTestOutputMarkup === markup && host.firstElementChild) {
        return;
      }
      host.innerHTML = markup;
      host.__ideTestOutputMarkup = markup;
    }

    function dispose() {
      boundHost?.removeEventListener('click', onClick);
      boundHost = null;
    }

    return { render, bindEvents, dispose, hasOutput };
  }

  return { createIdeTestOutputPanel, outcomeOf, resultLabel };
});
