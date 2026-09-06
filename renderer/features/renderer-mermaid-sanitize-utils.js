(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMermaidSanitizeUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function sanitizeMermaidSource(source) {
    return String(source || '')
      .split('\n')
      .map(function repairMermaidComment(line) {
        var comment = /^(\s*)%(?!%)\s*/.exec(line);
        return comment ? comment[1] + '%% ' + line.slice(comment[0].length) : line;
      })
      .join('\n');
  }

  function isFlowchartDiagram(source) {
    var lines = String(source || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var trimmed = String(lines[i] || '').trim();
      if (!trimmed || trimmed.startsWith('%%')) continue;
      return /^(?:flowchart|graph)\b/i.test(trimmed);
    }
    return false;
  }

  function isMermaidNodeIdStart(char) {
    return /[A-Za-z_]/.test(char);
  }

  function isMermaidNodeIdChar(char) {
    return /[A-Za-z0-9_.:-]/.test(char);
  }

  function isMermaidNodeBoundary(char) {
    return !char || /[\s;>|[\]{}()]/.test(char);
  }

  function isMermaidNodeTerminator(char) {
    return !char || /[\s;|&,.<>:=-]/.test(char);
  }

  function findNodeCloseIndex(line, openIndex, openChar, closeChar) {
    if (openChar !== '(') {
      return line.indexOf(closeChar, openIndex + 1);
    }
    var depth = 1;
    for (var i = openIndex + 1; i < line.length; i++) {
      if (line[i] === openChar) {
        depth += 1;
        continue;
      }
      if (line[i] === closeChar) {
        depth -= 1;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }

  var FLOWCHART_NODE_SHAPES = [
    { open: '[[', close: ']]' },
    { open: '((', close: '))' },
    { open: '[(', close: ')]' },
    { open: '([', close: '])' },
    { open: '[/', close: '/]' },
    { open: '[\\', close: '\\]' },
    { open: '{{', close: '}}' },
    { open: '[', close: ']' },
    { open: '(', close: ')', nested: true },
    { open: '{', close: '}' },
  ];

  function getFlowchartNodeShape(line, openIndex) {
    for (var i = 0; i < FLOWCHART_NODE_SHAPES.length; i++) {
      var shape = FLOWCHART_NODE_SHAPES[i];
      if (line.slice(openIndex, openIndex + shape.open.length) === shape.open) {
        return shape;
      }
    }
    return null;
  }

  function getSimpleSquareShape() {
    for (var i = 0; i < FLOWCHART_NODE_SHAPES.length; i++) {
      if (FLOWCHART_NODE_SHAPES[i].open === '[' && FLOWCHART_NODE_SHAPES[i].close === ']') {
        return FLOWCHART_NODE_SHAPES[i];
      }
    }
    return null;
  }

  function findNodeTokenCloseIndex(line, searchStart, closeToken) {
    var closeIndex = line.indexOf(closeToken, searchStart);
    while (closeIndex !== -1) {
      var nextChar = line[closeIndex + closeToken.length] || '';
      if (isMermaidNodeTerminator(nextChar)) {
        return closeIndex + closeToken.length - 1;
      }
      closeIndex = line.indexOf(closeToken, closeIndex + 1);
    }
    return -1;
  }

  function findMalformedBracketShapeCloseIndex(line, openIndex) {
    return findNodeTokenCloseIndex(line, openIndex + 1, ']');
  }

  function sanitizeFlowchartNodeLabels(line) {
    var output = '';
    var index = 0;
    while (index < line.length) {
      var currentChar = line[index];
      var previousChar = index > 0 ? line[index - 1] : '';
      if (!isMermaidNodeIdStart(currentChar) || !isMermaidNodeBoundary(previousChar)) {
        output += currentChar;
        index += 1;
        continue;
      }

      var idEnd = index + 1;
      while (idEnd < line.length && isMermaidNodeIdChar(line[idEnd])) {
        idEnd += 1;
      }

      var shape = getFlowchartNodeShape(line, idEnd);
      if (!shape) {
        output += line.slice(index, idEnd);
        index = idEnd;
        continue;
      }

      var closeIndex = shape.nested
        ? findNodeCloseIndex(line, idEnd, '(', ')')
        : findNodeTokenCloseIndex(line, idEnd + shape.open.length, shape.close);
      if (closeIndex === -1 && shape.open.length > 1 && shape.open[0] === '[') {
        shape = getSimpleSquareShape() || shape;
        closeIndex = findMalformedBracketShapeCloseIndex(line, idEnd);
      }
      if (closeIndex === -1) {
        output += line.slice(index, idEnd + shape.open.length);
        index = idEnd + shape.open.length;
        continue;
      }

      var labelStart = idEnd + shape.open.length;
      var labelEnd = closeIndex - shape.close.length + 1;
      var label = line.slice(labelStart, labelEnd);
      var trimmedLabel = label.trim();
      var shouldQuote = trimmedLabel
        && trimmedLabel[0] !== '"'
        && trimmedLabel[trimmedLabel.length - 1] !== '"'
        && label.indexOf('"') === -1
        && /[()]/.test(label);
      var replacementLabel = shouldQuote ? '"' + label + '"' : label;
      output += line.slice(index, idEnd) + shape.open + replacementLabel + shape.close;
      index = closeIndex + 1;
    }
    return output;
  }

  function sanitizeMermaidPreviewSource(source) {
    var cleanedSource = sanitizeMermaidSource(String(source || ''));
    if (!isFlowchartDiagram(cleanedSource)) {
      return cleanedSource;
    }
    return cleanedSource
      .split('\n')
      .map(sanitizeFlowchartNodeLabels)
      .join('\n');
  }

  function sanitizeMermaidSvgMarkup(svgMarkup, windowRef) {
    var raw = String(svgMarkup || '');
    if (!raw) return '';
    var purifyHost = windowRef || (typeof window !== 'undefined' ? window : null);
    var purify = purifyHost && purifyHost.DOMPurify ? purifyHost.DOMPurify : null;
    if (purify && typeof purify.sanitize === 'function') {
      try {
        // The svg/svgFilters profiles already strip every HTML element
        // inside foreignObject (only text survives — mermaid label text is
        // kept, active content is not). The FORBID list makes that
        // contract explicit so a future profile widening cannot silently
        // reopen script/style/embedding vectors.
        return purify.sanitize(raw, {
          USE_PROFILES: { svg: true, svgFilters: true },
          ADD_TAGS: ['foreignObject'],
          FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base'],
          FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onmouseenter', 'onmouseleave'],
        });
      } catch (_err) {
        // Fall through to conservative strip.
      }
    }
    return raw
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(href|xlink:href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, '');
  }

  return {
    sanitizeMermaidPreviewSource,
    sanitizeMermaidSource,
    sanitizeMermaidSvgMarkup,
  };
});
