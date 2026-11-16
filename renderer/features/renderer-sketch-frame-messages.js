/**
 * renderer/features/renderer-sketch-frame-messages.js: what the sandboxed sketch frame may say to the
 * page, checked (the project board plan sections 5.2 and 5.4).
 *
 * The frame draws model output, so every message it posts is rebuilt here from known fields with a
 * type, a length cap and a character check, and anything else is dropped. The frame host
 * (renderer-sketch-frame-host.js) hands a message to an action module only after this file has read it.
 * The problems a drawing reports are put into words here too: known codes only, as plain text.
 * Loaded with the first sketch block, before the host; never at startup.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSketchFrameMessages = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const MAX_PROBLEMS = 50;
  const MAX_PROBLEM_TEXT = 200;
  const TOO_LARGE = new Set(['too_long', 'too_many_lines', 'too_many_nodes']);
  const EXPORT_KINDS = Object.freeze({ svg: '.svg', png: '.png', excalidraw: '.excalidraw' });
  const LIMITS = Object.freeze({
    path: 1024,
    line: 10000000,
    askText: 8000,
    askId: 64,
    exportName: 60,
    exportText: 8 * 1024 * 1024,
    base64: 32 * 1024 * 1024,
  });
  const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
  const ASK_ID_RE = /^[A-Za-z0-9_-]+$/;

  /* ── Problems as words ── */

  function cut(value) {
    return typeof value === 'string' ? value.slice(0, MAX_PROBLEM_TEXT) : '';
  }

  function sentenceFor(problem) {
    const names = { id: problem.id, to: problem.to };
    switch (problem.code) {
      case 'removed_line': return jt('markdown.sketch.problem.removedLine', 'This kind of line is not drawn here. It was left out.');
      case 'missing_id': return jt('markdown.sketch.problem.missingId', '"{id}" is not in the drawing. This was left out.', names);
      case 'repointed_id': return jt('markdown.sketch.problem.repointedId', '"{id}" is not in the drawing. It was read as "{to}".', names);
      case 'duplicate_id': return jt('markdown.sketch.problem.duplicateId', 'The name "{id}" is already used. The second one was left out.', names);
      case 'figure_dropped': return jt('markdown.sketch.problem.figureDropped', 'This figure could not be read. It was left out with its lines.');
      case 'prose_node': return jt('markdown.sketch.problem.proseNode', 'This reads as a sentence, not as a part of the drawing.');
      default: return '';
    }
  }

  /** Rebuilds the frame's problems from known codes; anything else is dropped. */
  function readProblems(value) {
    const problems = [];
    for (const raw of Array.isArray(value) ? value.slice(0, MAX_PROBLEMS) : []) {
      if (!raw || typeof raw !== 'object') continue;
      const line = Number.isInteger(raw.line) && raw.line > 0 && raw.line <= 100000 ? raw.line : null;
      const problem = { code: cut(raw.code), line, id: cut(raw.id), to: cut(raw.to), text: cut(raw.text) };
      if (sentenceFor(problem)) problems.push(problem);
    }
    return problems;
  }

  function describeProblem(problem) {
    const sentence = sentenceFor(problem);
    return problem.line
      ? jt('markdown.sketch.problem.atLine', 'Line {line}: {problem}', { line: problem.line, problem: sentence })
      : sentence;
  }

  /** The problems chip under a drawing: its name, its tooltip (each problem, then what a click does) and its tone. */
  function describeChip(problems) {
    const count = problems.length === 1
      ? jt('markdown.sketch.problemsOne', '1 problem')
      : jt('markdown.sketch.problemsMany', '{count} problems', { count: problems.length });
    const hint = jt('markdown.sketch.problemsHint', 'Click to ask Jenny to redraw it');
    return {
      label: count + '. ' + hint,
      tooltip: problems.map(describeProblem).concat('', hint).join('\n'),
      // Only lines left out: the drawing itself is fine, so the chip is quieter.
      tone: problems.every((problem) => problem.code === 'removed_line') ? 'minor' : 'warning',
    };
  }

  /** The message "Fix" puts in the composer. Nothing is sent. */
  function buildFixText(problems, reason) {
    if (TOO_LARGE.has(reason)) {
      return jt('markdown.sketch.fixTooLarge', 'The drawing is too large to draw. Please write the sketch block again with at most 120 parts and 400 lines.');
    }
    if (!problems.length) return '';
    const intro = problems.length === 1
      ? jt('markdown.sketch.fixIntroOne', 'The drawing has 1 problem:')
      : jt('markdown.sketch.fixIntroMany', 'The drawing has {count} problems:', { count: problems.length });
    return [intro]
      .concat(problems.map((problem) => '- ' + describeProblem(problem)))
      .concat(jt('markdown.sketch.fixOutro', 'Please write the whole sketch block again with these fixed.'))
      .join('\n');
  }

  function failureNote(reason) {
    if (TOO_LARGE.has(reason)) return jt('markdown.sketch.tooLarge', 'Could not draw this: the drawing is too large.');
    if (reason === 'too_many_problems') return jt('markdown.sketch.tooManyProblems', 'Could not draw this: too much of it could not be read.');
    if (reason === 'timeout') return jt('markdown.sketch.timedOut', 'Could not draw this: it took too long.');
    return jt('markdown.sketch.couldNotDraw', 'Could not draw this.');
  }

  /* ── What an action module is handed ── */

  function readBase64(value, max) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && BASE64_RE.test(value) ? value : '';
  }

  function hasControlCharacter(text) {
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code < 32 || code === 127) return true;
    }
    return false;
  }

  function readOpenFile(payload) {
    const path = typeof payload.path === 'string' ? payload.path : '';
    if (!path || path.length > LIMITS.path || hasControlCharacter(path)) return null;
    const line = Number.isInteger(payload.line) && payload.line > 0 && payload.line <= LIMITS.line ? payload.line : null;
    return { type: 'open-file', path, line };
  }

  function readExport(payload) {
    const kind = typeof payload.kind === 'string' && Object.prototype.hasOwnProperty.call(EXPORT_KINDS, payload.kind) ? payload.kind : '';
    if (!kind) return null;
    const failed = { type: 'export', kind, ok: false };
    if (payload.ok !== true) return failed;
    const stem = (typeof payload.name === 'string' ? payload.name : '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, LIMITS.exportName);
    const name = (stem || 'sketch') + EXPORT_KINDS[kind];
    if (kind === 'png') {
      const base64 = readBase64(payload.base64, LIMITS.base64);
      return base64 ? { type: 'export', kind, ok: true, name, base64 } : failed;
    }
    const text = typeof payload.text === 'string' && payload.text.length > 0 && payload.text.length <= LIMITS.exportText ? payload.text : '';
    return text ? { type: 'export', kind, ok: true, name, text } : failed;
  }

  function readAsk(payload) {
    const askId = typeof payload.askId === 'string' && payload.askId.length <= LIMITS.askId && ASK_ID_RE.test(payload.askId) ? payload.askId : '';
    const text = typeof payload.text === 'string' ? payload.text.slice(0, LIMITS.askText).trim() : '';
    if (!askId || !text) return null;
    return { type: 'ask', askId, text, pngBase64: readBase64(payload.pngBase64, LIMITS.base64) };
  }

  /**
   * Reads one message a drawn frame posted beyond `rendered` and `height`. Returns a fresh object
   * with only the checked fields, or null for an unknown type or a value that fails its check.
   *   { type: 'open-file', path, line }                 a node with a file was clicked
   *   { type: 'export', kind, ok, name, text | base64 } the answer to an export request
   *   { type: 'ask', askId, text, pngBase64 }           a question about the person's marks ('' = no picture)
   *   { type: 'markup', on }                            drawing mode was turned on or off inside the frame
   */
  function readFrameMessage(payload) {
    if (!payload || typeof payload !== 'object') return null;
    switch (payload.type) {
      case 'open-file': return readOpenFile(payload);
      case 'export': return readExport(payload);
      case 'ask': return readAsk(payload);
      case 'markup': return { type: 'markup', on: payload.on === true };
      default: return null;
    }
  }

  return {
    EXPORT_KINDS,
    LIMITS,
    TOO_LARGE,
    readProblems,
    describeProblem,
    describeChip,
    buildFixText,
    failureNote,
    readFrameMessage,
  };
});
