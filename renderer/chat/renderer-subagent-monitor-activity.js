(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-subagent-monitor-model'),
      require('./tool-call-utils'),
      require('./renderer-tool-detail-body')
    );
    return;
  }
  root.rendererSubagentMonitorActivity = factory(
    root.rendererSubagentMonitorModel || {},
    root.toolCallUtils || {},
    root.rendererToolDetailBody || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (modelUtils, toolCallUtils, toolDetailBody) {
  'use strict';

  // What one child did, for its drill-in: the Overview's Steps list and the
  // Transcript. The view hands in its shared pieces (`h`: stateDot,
  // disclosure, section, renderMarkdown, renderEvidence, renderAnswer).
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  // Step groups shown before "+ N more" (a group is one row however many calls it holds).
  const VISIBLE_STEP_GROUPS = 5;

  function stepCountLabel(count) {
    return jtn('chat.subagentMonitor.stepCount', count, { count }, '{count} step', '{count} steps');
  }

  function stepTone(step) {
    if (step.status === 'running') return ['pending', 'pending'];
    if (step.status === 'interrupted') return ['pending', 'muted'];
    return step.ok === false ? ['error', 'danger'] : ['ok', 'success'];
  }

  // A step's target on one line. A workspace path opens the file (the panel
  // rail and the dock's chat path handler route data-chat-path-open); a
  // pattern or a group's shared target is plain text.
  function stepTarget(target, path) {
    if (!target) return '';
    const link = path
      ? ` subagent-evidence-link" role="link" tabindex="0" data-chat-path-open="${escapeHtml(path)}" data-chat-path="${escapeHtml(path)}`
      : '';
    return `<span class="subagent-step-target${link}" title="${escapeHtml(target)}">${escapeHtml(target)}</span>`;
  }

  function rangeSpan(text) {
    return text ? `<span class="subagent-step-range">${escapeHtml(text)}</span>` : '';
  }

  function stepLine(display, count, target) {
    return '<span class="subagent-step-line">'
      + `<span class="subagent-step-name">${escapeHtml(display)}</span>`
      + (count > 1 ? `<span class="subagent-step-count">${escapeHtml(jt('chat.subagentMonitor.stepRepeat', '×{count}', { count }))}</span>` : '')
      + target + '</span>';
  }

  function stepRow(step, h) {
    const [state, tone] = stepTone(step);
    return `<li class="subagent-step subagent-step--${state}">`
      + h.stateDot(tone)
      + '<span class="subagent-step-copy">'
      + stepLine(step.display, 1, stepTarget(step.target, step.path))
      + rangeSpan(step.range)
      + (step.ok === false && step.detail ? `<span class="subagent-step-detail">${escapeHtml(step.detail)}</span>` : '')
      + '</span></li>';
  }

  // A group of repeated calls is one row (×N, the ranges it read); it opens
  // to the calls themselves. The trigger holds no link: a click toggles.
  function groupRow(group, child, idSuffix, h) {
    if (group.calls.length === 1) return stepRow(group.calls[0], h);
    return '<li class="subagent-step subagent-step--ok subagent-step--group">'
      // Keyed on the first call: a running call merging later keeps open groups put.
      + h.disclosure('step-group', child, `${idSuffix}-${group.start}`, {
        className: 'subagent-step-group-trigger',
        children: h.stateDot('success') + '<span class="subagent-step-copy">'
          + stepLine(group.display, group.calls.length, stepTarget(group.target, ''))
          + rangeSpan(group.ranges.join(' · ')) + '</span>',
      }, {
        className: 'subagent-step-group-calls',
        children: `<ol class="subagent-step-list">${group.calls.map((call) => stepRow(call, h)).join('')}</ol>`,
      })
      + '</li>';
  }

  function renderSteps(child, idSuffix, h) {
    if (!child.terminal && !child.steps?.length) {
      return `<p class="subagent-live-summary">${escapeHtml(child.summary)}</p>`
        + `<p class="subagent-step-note">${escapeHtml(jt('chat.subagentMonitor.liveStepsPending', 'Tool steps appear here as they run.'))}</p>`;
    }
    const steps = child.steps || [];
    if (!steps.length) {
      // Reports written before the step log carry only the tool names and a count.
      const note = [...(child.tools || []), child.stepCount ? stepCountLabel(child.stepCount) : ''].filter(Boolean).join(' · ');
      return note ? `<p class="subagent-step-note">${escapeHtml(note)}</p>` : '';
    }
    const unrecorded = Math.max(0, (child.stepCount || 0) - steps.length);
    const rows = modelUtils.groupSteps(steps).map((group) => groupRow(group, child, idSuffix, h));
    const rest = rows.slice(VISIBLE_STEP_GROUPS);
    let html = `<ol class="subagent-step-list">${rows.slice(0, VISIBLE_STEP_GROUPS).join('')}</ol>`;
    if (rest.length) {
      html += h.disclosure('steps-more', child, idSuffix, {
        className: 'subagent-more-trigger',
        children: `<span>${escapeHtml(jt('chat.subagentMonitor.stepsMore', '+ {count} more', { count: rest.length }))}</span>`,
      }, {
        className: 'subagent-more-detail',
        children: `<ol class="subagent-step-list">${rest.join('')}</ol>`,
      });
    }
    if (unrecorded) {
      html += `<p class="subagent-step-note">${escapeHtml(jtn('chat.subagentMonitor.stepsNotRecorded', unrecorded, { count: unrecorded }, '+ {count} step not recorded', '+ {count} steps not recorded'))}</p>`;
    }
    return html;
  }

  // The full task the parent wrote, as plain text: three lines with Show all
  // when it is longer. `prefix` keeps the Task and Transcript disclosures apart.
  function taskBody(child, idSuffix, h, prefix) {
    const prompt = child.prompt || '';
    if (!prompt) return '';
    const text = `<p class="subagent-task-text">${escapeHtml(prompt)}</p>`;
    if (prompt.length <= 240 && prompt.split('\n').length <= 3) return text;
    const toggle = h.disclosure(prefix, child, idSuffix, {
      className: 'subagent-more-trigger subagent-task-toggle',
      children: `<span class="subagent-task-more">${escapeHtml(jt('chat.subagentMonitor.showAll', 'Show all'))}</span>`
        + `<span class="subagent-task-less">${escapeHtml(jt('chat.subagentMonitor.showLess', 'Show less'))}</span>`,
    }, { className: 'subagent-task-full', children: text });
    return `<div class="subagent-task"><p class="subagent-task-text subagent-task-preview">${escapeHtml(prompt)}</p>${toggle}</div>`;
  }

  // ---- Transcript ------------------------------------------------------

  // Thoughts and notes repaint with every transcript change: keep their markup.
  const markdownCache = new Map();
  function markdown(text, h) {
    if (markdownCache.has(text)) return markdownCache.get(text);
    const html = h.renderMarkdown(text);
    if (markdownCache.size >= 120) markdownCache.delete(markdownCache.keys().next().value);
    markdownCache.set(text, html);
    return html;
  }

  function note(text) {
    return text ? `<p class="subagent-step-note">${escapeHtml(text)}</p>` : '';
  }

  const fieldCut = () => jt('chat.subagentMonitor.transcriptFieldCut', 'Cut to keep the chat light.');

  function parseInput(text) {
    if (!text) return null;
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (_error) {
      return null;
    }
  }

  // The chat's own status words: a failed call is "errored", a stopped one "cancelled".
  function chatStatus(status) {
    return { failed: 'errored', interrupted: 'cancelled' }[status] || status;
  }

  function callStatusLabel(status) {
    if (status === 'running') return jt('chat.subagentMonitor.callRunning', 'Running');
    if (status === 'failed') return jt('chat.subagentMonitor.callFailed', 'Failed');
    if (status === 'interrupted') return jt('chat.subagentMonitor.callStopped', 'Stopped');
    return jt('chat.subagentMonitor.callCompleted', 'Completed');
  }

  // One tool call: the chat's own one-line header, and its input and output
  // through the chat's tool detail body when opened.
  // The chat's own detail body, but its Show more / copy text never enters the
  // chat's shared registry: transcript fields stay under the preview cap, so
  // the DOM holds the full text, and 80 calls would evict the chat's entries.
  let builder = null;
  function detailBuilder() {
    if (!builder && typeof toolDetailBody.createToolDetailBody === 'function') {
      builder = toolDetailBody.createToolDetailBody({ toolCallUtils, registerFullText: () => false });
    }
    return builder;
  }

  function callRow(entry, index, child, idSuffix, h) {
    const input = parseInput(entry.input);
    const running = entry.status === 'running';
    const status = chatStatus(entry.status);
    const header = toolCallUtils.buildToolHeaderInner({
      status,
      isRunning: running,
      displayToolName: entry.display,
      summary: input ? toolCallUtils.formatToolCallSummary(entry.tool, input) : '',
      durationLabel: running ? '' : toolCallUtils.formatToolDurationMs(entry.ms),
      statusLabel: callStatusLabel(entry.status),
      failureSummary: entry.status === 'failed' ? entry.errorCode : '',
    }, { escapeHtml });
    const token = `subagent-call-${String(child.key).replace(/[^A-Za-z0-9_-]/g, '-')}${idSuffix}-${index}`;
    const body = detailBuilder()?.buildDetailBodyMarkup({
      toolName: entry.tool,
      toolKind: toolCallUtils.normalizeToolKind(entry.tool),
      inputJson: entry.input,
      outputText: entry.output,
      isError: entry.status === 'failed',
      errorCode: entry.errorCode,
      status,
      domToken: token,
    }) || '';
    const cut = [
      entry.outputChars ? jt('chat.subagentMonitor.transcriptOutputCut', 'Output cut: {shown} of {total} characters kept.', {
        shown: entry.output.length.toLocaleString(), total: entry.outputChars.toLocaleString(),
      }) : '',
      entry.inputTruncated ? jt('chat.subagentMonitor.transcriptInputCut', 'Input cut.') : '',
    ].filter(Boolean).join(' ');
    return '<li class="subagent-transcript-item">' + h.disclosure('call', child, `${idSuffix}-${index}`, {
      className: 'tool-run-toggle subagent-transcript-call',
      children: header,
    }, {
      className: 'subagent-transcript-call-detail',
      children: body + note(cut),
    }) + '</li>';
  }

  // One thought: "Thought", its first sentence and how long it took; opened,
  // the whole thought. A live one only shimmers (its text is not streamed).
  function thoughtRow(entry, index, child, idSuffix, h) {
    const first = entry.text.split(/(?<=[.!?])\s/)[0] || '';
    const head = h.stateDot(entry.live ? 'pending' : 'muted')
      + `<span class="reasoning-row-name">${escapeHtml(jt('chat.subagentMonitor.thought', 'Thought'))}</span>`
      + `<span class="reasoning-row-main${entry.live ? ' shimmer-active' : ''}">${escapeHtml(entry.live ? jt('chat.subagentMonitor.thinking', 'Thinking…') : first)}</span>`
      + '<span class="reasoning-row-status-cluster" aria-hidden="true">'
      + (entry.ms ? `<span class="reasoning-row-meta">${escapeHtml(toolCallUtils.formatToolDurationMs(entry.ms))}</span>` : '')
      + (entry.live || !entry.text ? '' : '<span class="reasoning-row-caret"></span>')
      + '</span>';
    if (entry.live || !entry.text) {
      return `<li class="subagent-transcript-item"><div class="reasoning-row-header subagent-transcript-thought">${head}</div></li>`;
    }
    return '<li class="subagent-transcript-item">' + h.disclosure('thought', child, `${idSuffix}-${index}`, {
      className: 'reasoning-row-header subagent-transcript-thought',
      children: head,
    }, {
      className: 'subagent-transcript-thought-body',
      children: `<div class="chat-bubble-markdown" dir="auto">${markdown(entry.text, h)}</div>${entry.truncated ? note(fieldCut()) : ''}`,
    }) + '</li>';
  }

  // The work between two notes: one row in the chat's tool-run grammar ("Read
  // 2 files, searched once, thought twice"); opened, each thought and call.
  function runRow(members, child, idSuffix, h) {
    const tools = members.filter(({ entry }) => entry.kind === 'tool').map(({ entry }) => ({
      tool: entry.tool, toolLabel: entry.display, label: entry.display, durationMs: entry.ms, status: chatStatus(entry.status),
    }));
    const thoughts = members.length - tools.length;
    const summary = toolCallUtils.summarizeToolRun(tools);
    const thinking = members.some(({ entry }) => entry.live);
    const thoughtPhrase = thoughts
      ? jtn('chat.subagentMonitor.thoughtCount', thoughts, { count: thoughts }, 'thought once', 'thought {count} times') : '';
    const sentence = [summary.sentence, thoughtPhrase].filter(Boolean).join(jt('chat.toolRun.separator', ', '));
    const inner = toolCallUtils.buildToolRunToggleInner({
      ...summary,
      sentence: sentence.charAt(0).toLocaleUpperCase() + sentence.slice(1),
      live: summary.live || thinking,
      liveLabel: summary.live ? summary.liveLabel : (thinking ? jt('chat.subagentMonitor.thinking', 'Thinking…') : ''),
    }, { escapeHtml });
    const rows = members.map(({ entry, index }) => (entry.kind === 'tool'
      ? callRow(entry, index, child, idSuffix, h)
      : thoughtRow(entry, index, child, idSuffix, h))).join('');
    return '<li class="subagent-transcript-item">' + h.disclosure('run', child, `${idSuffix}-${members[0].index}`, {
      className: 'tool-run-toggle subagent-transcript-run-toggle',
      children: inner,
    }, {
      className: 'subagent-transcript-run',
      children: `<ol class="subagent-transcript">${rows}</ol>`,
    }) + '</li>';
  }

  function noteRow(entry, h) {
    return '<li class="subagent-transcript-item subagent-transcript-note chat-bubble-markdown" dir="auto">'
      + markdown(entry.text, h) + (entry.truncated ? note(fieldCut()) : '') + '</li>';
  }

  // What Jenny asked, the child's notes with its work folded between them,
  // then its answer and evidence. Disclosure ids key on the entry index, so a
  // live repaint keeps open rows open.
  function renderTranscript(child, idSuffix, h) {
    const rows = [];
    let run = [];
    const flush = () => {
      if (run.length) rows.push(runRow(run, child, idSuffix, h));
      run = [];
    };
    (child.transcript || []).forEach((entry, index) => {
      if (entry.kind === 'text') {
        flush();
        rows.push(noteRow(entry, h));
      } else {
        run.push({ entry, index });
      }
    });
    flush();
    const dropped = child.transcriptDropped
      ? note(jtn('chat.subagentMonitor.transcriptDropped', child.transcriptDropped, { count: child.transcriptDropped },
        '{count} later step was not kept.', '{count} later steps were not kept.'))
      : '';
    const working = !child.terminal && !child.transcript?.some((entry) => entry.live || entry.status === 'running')
      ? `<p class="subagent-transcript-live shimmer-active">${escapeHtml(child.summary)}</p>` : '';
    return h.section(jt('chat.subagentMonitor.sectionAsked', 'Jenny asked'), taskBody(child, idSuffix, h, 'transcript-task'))
      + `<ol class="subagent-transcript subagent-transcript--top">${rows.join('')}</ol>`
      + dropped + working
      + (child.terminal ? h.renderAnswer(child) : '')
      + h.section(jt('chat.subagentMonitor.sectionEvidence', 'Evidence'), h.renderEvidence(child));
  }

  return { renderSteps, renderTranscript, stepCountLabel, taskBody };
});
