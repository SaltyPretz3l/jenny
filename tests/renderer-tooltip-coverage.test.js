'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function scanStaticDocument(documentRef, relpath = 'index.html') {
  const findings = [];
  const prefixCounts = new Map();
  const candidates = documentRef.querySelectorAll('button, [role="button"], [role="separator"][tabindex]');

  for (const candidate of candidates) {
    const clone = candidate.cloneNode(true);
    clone.querySelectorAll('.sr-only, [aria-hidden="true"], svg').forEach((node) => node.remove());
    const visibleText = String(clone.textContent || '').trim();
    const hasTooltip = ['title', 'data-tooltip'].some((attribute) => (
      String(candidate.getAttribute(attribute) || '').trim().length > 0
    ));
    if (visibleText.length > 2 || hasTooltip) continue;

    if (candidate.id) {
      findings.push(`${relpath}#${candidate.id}`);
      continue;
    }

    const firstClass = String(candidate.getAttribute('class') || '').trim().split(/\s+/)[0] || '';
    const prefix = `${relpath}:${candidate.tagName.toLowerCase()}.${firstClass}`;
    const occurrence = prefixCounts.get(prefix) || 0;
    prefixCounts.set(prefix, occurrence + 1);
    findings.push(`${prefix}[${occurrence}]`);
  }

  return findings;
}

function findClosingBrace(source, openingIndex) {
  let depth = 0;
  let quote = '';
  let escaped = false;

  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      /* Line comment: skip to end of line so an apostrophe in prose
       * ("Jenny's") cannot open a phantom string. */
      const lineEnd = source.indexOf('\n', index);
      if (lineEnd === -1) return -1;
      index = lineEnd;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      if (commentEnd === -1) return -1;
      index = commentEnd + 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function stableSnippet(rawValue) {
  return String(rawValue || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function scanRendererSource(source, relpath) {
  const rawFindings = [];
  const objectStartPattern = /\b(?:actionButton|chip)\s*\(\s*\{/g;
  let match;

  while ((match = objectStartPattern.exec(source)) !== null) {
    const openingIndex = match.index + match[0].lastIndexOf('{');
    const closingIndex = findClosingBrace(source, openingIndex);
    if (closingIndex === -1) continue;
    const literal = source.slice(openingIndex, closingIndex + 1);
    const ariaLabelMatch = literal.match(/\bariaLabel\s*:\s*([^,\r\n}]+)/);
    const hasIconSignal = /\b(?:ariaLabel|trustedHtml)\s*:/.test(literal);
    const hasTitle = /\btitle\s*:/.test(literal) || /(^|[,{\s])title\s*[,}]/.test(literal);
    const hasStaticallyEmptyTitle = /\btitle\s*:\s*(?:'\s*'|"\s*"|`\s*`)\s*[,}]/.test(literal);
    if (hasIconSignal && (!hasTitle || hasStaticallyEmptyTitle)) {
      rawFindings.push({
        position: match.index,
        snippet: stableSnippet(ariaLabelMatch ? ariaLabelMatch[1] : ''),
      });
    }
  }

  const lines = source.split(/\r?\n/);
  let lineOffset = 0;
  let countedThrough = -1;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (lineIndex > countedThrough && line.includes('<button')) {
      const buttonOffset = line.indexOf('<button');
      const windowText = lines.slice(lineIndex, lineIndex + 8).join('\n').slice(buttonOffset);
      let tagEnd = -1;
      let quote = '';
      let escaped = false;
      let expressionDepth = 0;
      for (let index = 0; index < windowText.length; index += 1) {
        const character = windowText[index];
        if (quote) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === quote) quote = '';
          continue;
        }
        if (character === "'" || character === '"' || character === '`') {
          quote = character;
        } else if (character === '$' && windowText[index + 1] === '{') {
          expressionDepth += 1;
          index += 1;
        } else if (expressionDepth > 0 && character === '{') {
          expressionDepth += 1;
        } else if (expressionDepth > 0 && character === '}') {
          expressionDepth -= 1;
        } else if (expressionDepth === 0 && character === '>') {
          tagEnd = index;
          break;
        }
      }
      const openingTag = tagEnd === -1 ? windowText : windowText.slice(0, tagEnd + 1);
      const closedLineCount = tagEnd === -1 ? 7 : (openingTag.match(/\n/g) || []).length;
      countedThrough = Math.min(lines.length - 1, lineIndex + closedLineCount);
      const ariaLabelMatch = openingTag.match(/\baria-label\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/);
      if (ariaLabelMatch && !/\b(?:title|data-tooltip)\s*=/.test(openingTag)) {
        rawFindings.push({
          position: lineOffset + buttonOffset,
          snippet: stableSnippet(ariaLabelMatch[1]),
        });
      }
    }
    lineOffset += line.length + 1;
  }

  rawFindings.sort((left, right) => left.position - right.position);
  const occurrenceCounts = new Map();
  return rawFindings.map(({ snippet }) => {
    const pair = `${relpath}\0${snippet}`;
    const occurrence = occurrenceCounts.get(pair) || 0;
    occurrenceCounts.set(pair, occurrence + 1);
    return `${relpath}|${snippet}|${occurrence}`;
  });
}

function listRendererJavaScriptFiles(directory) {
  const files = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'tests') {
        files.push(...listRendererJavaScriptFiles(fullPath));
      }
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectCurrentFindings(repoRoot) {
  const indexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const dom = new JSDOM(indexHtml);
  const staticFindings = scanStaticDocument(dom.window.document).sort();
  dom.window.close();

  const sourceFindings = [];
  for (const filePath of listRendererJavaScriptFiles(path.join(repoRoot, 'renderer'))) {
    const relpath = path.relative(repoRoot, filePath).split(path.sep).join('/');
    if (relpath === 'renderer/inventory/tooltip.js') continue;
    const source = fs.readFileSync(filePath, 'utf8');
    sourceFindings.push(...scanRendererSource(source, relpath));
  }
  sourceFindings.sort();

  return { static: staticFindings, source: sourceFindings };
}

const REPO_ROOT = path.join(__dirname, '..');
const ALLOWLIST_PATH = path.join(__dirname, 'fixtures', 'tooltip-coverage-allowlist.json');
const findings = collectCurrentFindings(REPO_ROOT);
let allowlist;

if (process.env.TOOLTIP_COVERAGE_WRITE === '1') {
  if (process.env.CI !== undefined) {
    throw new Error('TOOLTIP_COVERAGE_WRITE=1 is disabled when CI is set');
  }
  allowlist = findings;
  fs.writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(allowlist, null, 2)}\n`, 'utf8');
  console.log(`*** TOOLTIP COVERAGE ALLOWLIST REWRITTEN: ${findings.static.length} static, ${findings.source.length} source ***`);
} else {
  allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
}

test('no new gaps', () => {
  const newGaps = ['static', 'source'].flatMap((kind) => (
    findings[kind]
      .filter((key) => !allowlist[kind].includes(key))
      .map((key) => `${kind}: ${key}`)
  ));
  assert.equal(
    newGaps.length,
    0,
    `New tooltip coverage gaps:\n${newGaps.join('\n')}\nadd a title (see docs/operations/onboarding-frontend.md, Tooltips)`,
  );
});

test('allowlist only shrinks', () => {
  const staleEntries = ['static', 'source'].flatMap((kind) => (
    allowlist[kind]
      .filter((key) => !findings[kind].includes(key))
      .map((key) => `${kind}: ${key}`)
  ));
  assert.equal(
    staleEntries.length,
    0,
    `Tooltip coverage allowlist contains stale entries:\n${staleEntries.join('\n')}\nstale entry — delete it from the allowlist`,
  );
});

test('static scanner accepts a titled icon-only button and reports an untitled one', () => {
  const dom = new JSDOM(
    '<button id="titled" aria-label="Close" title="Close">×</button>'
      + '<button id="missing" aria-label="More"><svg aria-hidden="true"></svg></button>',
  );
  assert.deepEqual(scanStaticDocument(dom.window.document, 'fragment.html'), ['fragment.html#missing']);
  dom.window.close();
});

test('source scanner accepts a titled icon button and reports an untitled one', () => {
  const source = [
    "actionButton({ ariaLabel: 'Close', trustedHtml: '&times;', title: 'Close' });",
    "actionButton({ // Jenny's close affordance — apostrophe in a comment must not open a string",
    "  ariaLabel: 'More', trustedHtml: '&hellip;' });",
  ].join('\n');
  assert.deepEqual(scanRendererSource(source, 'renderer/example.js'), [
    "renderer/example.js|'More'|0",
  ]);
});

test('source scanner does not credit a neighbouring span title to a button', () => {
  const source = [
    'const markup = `<button aria-label="More">',
    '  <span title="Unrelated">...</span>',
    '</button>`;',
  ].join('\n');
  assert.deepEqual(scanRendererSource(source, 'renderer/example.js'), [
    'renderer/example.js|"More"|0',
  ]);
});

test('source scanner checks an independent second button inside the old seven-line window', () => {
  const source = [
    'const markup = `<button aria-label="First">',
    '</button>',
    '<button aria-label="Second">',
    '</button>`;',
  ].join('\n');
  assert.deepEqual(scanRendererSource(source, 'renderer/example.js'), [
    'renderer/example.js|"First"|0',
    'renderer/example.js|"Second"|0',
  ]);
});

test('source scanner credits a title on the seventh lookahead line before the opening tag closes', () => {
  const source = [
    'const markup = `<button',
    '  aria-label="More"',
    '  class="icon"',
    '  data-kind="${kind > 0 ? \'large\' : \'small\'}"',
    '  data-copy=">"',
    '  data-one="1"',
    '  data-two="2"',
    '  title="More details">`;',
  ].join('\n');
  assert.deepEqual(
    scanRendererSource(source, 'renderer/example.js'),
    [],
    'the seven-line lookahead cap includes seven lines after the opening line',
  );
});

test('source scanner accepts an object-literal shorthand title', () => {
  const source = "actionButton({ ariaLabel: 'Close', trustedHtml: '&times;', title });";
  assert.deepEqual(scanRendererSource(source, 'renderer/example.js'), []);
});

test('source scanner reports a statically empty object-literal title', () => {
  const source = "actionButton({ ariaLabel: 'Close', trustedHtml: '&times;', title: '' });";
  assert.deepEqual(scanRendererSource(source, 'renderer/example.js'), [
    "renderer/example.js|'Close'|0",
  ]);
});
