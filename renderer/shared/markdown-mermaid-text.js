/** Pure Mermaid source detection and fenced-block extraction helpers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.markdownMermaidText = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const START_RE = /^\s*(?:(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b|(?:sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|xychart|block-beta|sankey|packet)\b)/i;

  function looksLikeSource(text) {
    return START_RE.test(String(text || '').trim());
  }

  function normalizeSource(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .join('\n');
  }

  function advanceFenceState(line, previousState) {
    const state = previousState && previousState.marker
      ? previousState
      : { marker: '', length: 0 };
    const sourceLine = String(line || '');
    if (state.marker) {
      const closing = /^ {0,3}(`+|~+)\s*$/.exec(sourceLine);
      if (closing && closing[1][0] === state.marker && closing[1].length >= state.length) {
        return { marker: '', length: 0, closed: true };
      }
      return { marker: state.marker, length: state.length };
    }
    const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(sourceLine);
    if (!opener || (opener[1][0] === '`' && opener[2].includes('`'))) {
      return { marker: '', length: 0 };
    }
    return {
      marker: opener[1][0],
      length: opener[1].length,
      opened: true,
      info: String(opener[2] || '').trim().toLowerCase(),
    };
  }

  function extractFenceSources(markdownText) {
    const lines = String(markdownText || '').split(/\r?\n/);
    const sources = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const opened = advanceFenceState(lines[lineIndex]);
      if (!opened.opened) continue;
      let fenceState = opened;
      const info = opened.info;
      const bodyLines = [];
      let closed = false;
      for (lineIndex += 1; lineIndex < lines.length; lineIndex += 1) {
        fenceState = advanceFenceState(lines[lineIndex], fenceState);
        if (fenceState.closed) {
          closed = true;
          break;
        }
        bodyLines.push(lines[lineIndex]);
      }
      if (!closed) break;
      const body = bodyLines.join('\n');
      if (info.startsWith('mermaid')) {
        sources.push(body);
        continue;
      }
      const infoIsPlain = info === '' || info === 'plaintext' || info === 'text' || info === 'none';
      if (infoIsPlain && looksLikeSource(body)) sources.push(body);
    }
    return sources;
  }

  return { looksLikeSource, normalizeSource, advanceFenceState, extractFenceSources };
});
