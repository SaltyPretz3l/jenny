/* renderer/features/renderer-ide-run-task-footer.js - the exit footer under the
 * Workspace Run output (row 40 W4, owner decision F5). It owns the LAST finished
 * run's record ({ script, exitCode, stopped, durationMs }) and paints a status line
 * ("Exited with code 1 after 1.2s" / "Stopped after 4s") plus Run again and, for a
 * non-zero exit only, Ask Jenny to fix. Completion truth stays the real process
 * exit: the run view calls finish() from its exit handler (or its Stop), this
 * module never looks at output to decide anything. The shared helpers
 * (formatDuration, buildFooterMarkup, buildAskJennyPayload) are also used by the
 * test-output view so both task views read the same.
 *
 * The Ask Jenny payload is the Workspace's existing send-to-Jenny `code_selection`
 * shape (renderer-ide-send-utils.js buildSendToJennyText), with `title`/`output`
 * duplicated on it, so a host can hand it straight to onSendToJenny. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeRunTaskFooter = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const MAX_ASK_OUTPUT_CHARS = 8 * 1024;
  const ACTION_ATTR = 'ide-task-footer-action';

  // Compact human duration: 850ms, 1.2s, 42s, 3m 4s, 1h 5m.
  function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) {
      return '0ms';
    }
    if (value < 1000) {
      return jt('ide.taskFooter.durationMs', '{n}ms', { n: Math.round(value) });
    }
    if (value < 10000) {
      return jt('ide.taskFooter.durationS', '{n}s', { n: Math.round(value / 100) / 10 });
    }
    const seconds = Math.round(value / 1000);
    if (seconds < 60) {
      return jt('ide.taskFooter.durationS', '{n}s', { n: seconds });
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return jt('ide.taskFooter.durationMinSec', '{m}m {s}s', { m: minutes, s: seconds % 60 });
    }
    return jt('ide.taskFooter.durationHourMin', '{h}h {m}m', { h: Math.floor(minutes / 60), m: minutes % 60 });
  }

  // The bounded tail of an output string, capped at 8 KB (characters), tail kept.
  function boundOutputTail(output) {
    const text = String(output || '');
    return text.length > MAX_ASK_OUTPUT_CHARS ? text.slice(text.length - MAX_ASK_OUTPUT_CHARS) : text;
  }

  function buildAskJennyPayload(title, output) {
    const name = String(title || '').trim() || jt('ide.taskFooter.defaultTitle', 'Task output');
    const tail = boundOutputTail(output);
    return {
      kind: 'code_selection',
      target: 'current',
      path: name,
      code: tail.trim() ? tail : jt('ide.taskFooter.noOutput', '(no output captured)'),
      language: 'plaintext',
      startLine: 0,
      endLine: 0,
      intent: jt('ide.taskFooter.askIntent', 'This task failed. Work out the cause from its output below and fix it.'),
      title: name,
      output: tail,
    };
  }

  function statusText(run) {
    const duration = formatDuration(run.durationMs);
    if (run.stopped) {
      return jt('ide.taskFooter.stopped', 'Stopped after {duration}', { duration });
    }
    if (run.startFailed) {
      return jt('ide.taskFooter.startFailed', 'Could not start');
    }
    if (run.exitCode == null) {
      return jt('ide.taskFooter.finished', 'Finished after {duration}', { duration });
    }
    return jt('ide.taskFooter.exited', 'Exited with code {code} after {duration}', { code: run.exitCode, duration });
  }

  // `text` is plain text (escaped here); `showAsk` adds the Ask Jenny action.
  function buildFooterMarkup(options) {
    const { actionButton, escapeHtml, text, showAsk } = options;
    if (typeof actionButton !== 'function') {
      return '';
    }
    const button = (action, label, variant) => actionButton({
      variant, size: 'sm', label, ariaLabel: label, title: label, dataset: { [ACTION_ATTR]: action },
    });
    return '<div class="ide-task-footer">'
      + `<span class="ide-task-footer-status">${escapeHtml(text)}</span>`
      + '<span class="ide-task-footer-actions">'
      + button('rerun', jt('ide.taskFooter.runAgain', 'Run again'), 'ghost')
      + (showAsk ? button('ask', jt('ide.taskFooter.askJenny', 'Ask Jenny to fix'), 'primary') : '')
      + '</span></div>';
  }

  function actionOf(event) {
    const node = event && event.target && typeof event.target.closest === 'function'
      ? event.target.closest(`[data-${ACTION_ATTR}]`)
      : null;
    return node && !node.disabled ? String(node.getAttribute(`data-${ACTION_ATTR}`) || '') : '';
  }

  function createRunTaskFooter(deps) {
    const options = deps || {};
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const isRunning = typeof options.isRunning === 'function' ? options.isRunning : () => false;
    const getOutput = typeof options.getOutput === 'function' ? options.getOutput : () => '';
    const onRunAgain = typeof options.onRunAgain === 'function' ? options.onRunAgain : () => {};
    const onAskJenny = typeof options.onAskJenny === 'function' ? options.onAskJenny : () => {};
    const escapeHtml = typeof options.escapeHtml === 'function' ? options.escapeHtml : String;
    const actionButton = options.actionButton;

    let current = null; // { script, command, path, startedAt } of the latest begun run (path: a file run's file)
    let lastRun = null; // { script, exitCode, stopped, durationMs } once it has really finished

    // A new run is in flight: any previous footer record is stale.
    function begin(run) {
      current = { script: String((run && run.script) || ''), command: String((run && run.command) || ''), path: String((run && run.path) || ''), startedAt: now() };
      lastRun = null;
    }

    // The workspace root changed: the old run's command is not this folder's to run again.
    function resetForRoot() {
      current = null;
      lastRun = null;
    }

    // The run really ended (process exit, or the user's Stop).
    function finish(outcome) {
      if (!current) {
        return;
      }
      const code = outcome && outcome.exitCode != null && Number.isFinite(Number(outcome.exitCode)) ? Number(outcome.exitCode) : null;
      lastRun = {
        script: current.script,
        exitCode: code,
        stopped: Boolean(outcome && outcome.stopped),
        startFailed: Boolean(outcome && outcome.startFailed),
        durationMs: Math.max(0, now() - current.startedAt),
      };
    }

    function getLastRun() {
      return lastRun ? { ...lastRun } : null;
    }

    function getRunLabel() {
      return current && current.script ? jt('ide.taskFooter.runLabel', 'Run: {script}', { script: current.script }) : jt('ide.taskFooter.runLabelBare', 'Run');
    }

    function failed() {
      return Boolean(lastRun) && !lastRun.stopped && (lastRun.startFailed || (lastRun.exitCode != null && lastRun.exitCode !== 0));
    }

    // Paints into the run view's footer host; nothing while a run is in progress.
    function render(host) {
      if (!host) {
        return;
      }
      const markup = lastRun && !isRunning()
        ? buildFooterMarkup({ actionButton, escapeHtml, text: statusText(lastRun), showAsk: failed() })
        : '';
      if (host.__ideTaskFooterMarkup !== markup) {
        host.innerHTML = markup;
        host.__ideTaskFooterMarkup = markup;
      }
    }

    // True when the click was one of the footer's own actions (and handled).
    function handleClick(event) {
      const action = actionOf(event);
      if (!action) {
        return false;
      }
      if (isRunning() || !current) {
        return true;
      }
      if (action === 'rerun') {
        onRunAgain({ script: current.script, command: current.command, path: current.path });
      } else if (action === 'ask' && failed()) {
        onAskJenny(buildAskJennyPayload(getRunLabel(), getOutput()));
      }
      return true;
    }

    return { begin, finish, resetForRoot, getLastRun, getRunLabel, render, handleClick };
  }

  return {
    ACTION_ATTR,
    MAX_ASK_OUTPUT_CHARS,
    actionOf,
    boundOutputTail,
    buildAskJennyPayload,
    buildFooterMarkup,
    createRunTaskFooter,
    formatDuration,
  };
});
