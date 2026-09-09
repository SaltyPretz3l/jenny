'use strict';

const DISPLAY_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt', 'data-tooltip']);
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&times;/gi, '×')
    .replace(/&mdash;/gi, '—')
    .replace(/&rarr;/gi, '→')
    .replace(/&middot;/gi, '·')
    .replace(/&minus;/gi, '−')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&bull;/gi, '•')
    .replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([\da-f]+);/gi, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)));
}

function lineAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function parseTag(token, tokenStart) {
  const nameMatch = token.match(/^<\s*([\w:-]+)/);
  if (!nameMatch) return null;
  const attributes = new Map();
  const attributeRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  attributeRe.lastIndex = nameMatch[0].length;
  let match;
  while ((match = attributeRe.exec(token))) {
    const name = match[1].toLowerCase();
    const value = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
    const valueOffset = match[2] !== undefined
      ? match.index + match[0].indexOf(match[2])
      : match[3] !== undefined
        ? match.index + match[0].indexOf(match[3])
        : match[4] !== undefined ? match.index + match[0].indexOf(match[4]) : match.index;
    attributes.set(name, { value, start: tokenStart + valueOffset });
  }
  return {
    name: nameMatch[1].toLowerCase(),
    attributes,
    selfClosing: /\/\s*>$/.test(token),
    directText: [],
    directOccurrences: [],
    hasChildElement: false,
  };
}

function addOccurrence(output, source, file, kind, text, start, disposition = 'pending') {
  const occurrence = {
    file,
    kind,
    text: decodeEntities(text),
    start,
    line: lineAt(source, start),
    via: 'literal',
    disposition,
  };
  output.push(occurrence);
  return occurrence;
}

function closeElement(element, source, file, addCatalog, errors) {
  const marker = element.attributes.get('data-i18n');
  const key = marker?.value;
  if (!key) return;
  if (element.hasChildElement) {
    for (const occurrence of element.directOccurrences) occurrence.disposition = 'pending';
    errors.push(`${file}:${lineAt(source, marker.start)}: non-leaf data-i18n marker ${JSON.stringify(key)}`);
    return;
  }
  const text = element.directText.join(' ').replace(/\s+/g, ' ').trim();
  if (text) addCatalog(key, text, file, element.attributes.get('data-i18n').start);
}

function scanHtml({ source, file, addCatalog, errors = [] }) {
  const occurrences = [];
  const stack = [];
  let skippedElement = null;
  const tokenRe = /<!--[\s\S]*?-->|<![^>]*>|<[^>]*>|<[^>]*$|[^<]+/g;
  let tokenMatch;
  while ((tokenMatch = tokenRe.exec(source))) {
    const token = tokenMatch[0];
    const start = tokenMatch.index;
    if (token.startsWith('<!--') || /^<!/i.test(token)) continue;
    const closingMatch = token.match(/^<\s*\/\s*([\w:-]+)/);
    if (closingMatch) {
      const closingName = closingMatch[1].toLowerCase();
      if (skippedElement) {
        if (closingName === skippedElement) skippedElement = null;
        continue;
      }
      while (stack.length) {
        const element = stack.pop();
        closeElement(element, source, file, addCatalog, errors);
        if (element.name === closingName) break;
      }
      continue;
    }
    if (token.startsWith('<')) {
      if (skippedElement) continue;
      const element = parseTag(token, start);
      if (!element) continue;
      const parent = stack.at(-1);
      if (parent) parent.hasChildElement = true;
      if (element.name === 'script' || element.name === 'style') {
        skippedElement = element.name;
        continue;
      }
      const translatedText = element.attributes.get('data-i18n')?.value;
      for (const [name, attribute] of element.attributes) {
        if (!DISPLAY_ATTRIBUTES.has(name)) continue;
        const keyAttribute = name === 'data-tooltip' ? 'data-i18n-data-tooltip' : `data-i18n-${name}`;
        const translationKey = element.attributes.get(keyAttribute)?.value;
        const disposition = translationKey ? 'migrated' : 'pending';
        addOccurrence(occurrences, source, file, 'html_attr', attribute.value, attribute.start, disposition);
        if (translationKey) addCatalog(translationKey, attribute.value, file, attribute.start);
      }
      if (!element.selfClosing && !VOID_ELEMENTS.has(element.name)) stack.push(element);
      else if (translatedText) closeElement(element, source, file, addCatalog, errors);
      continue;
    }
    if (skippedElement) continue;
    const text = decodeEntities(token).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const parent = stack.at(-1);
    const translated = Boolean(parent?.attributes.get('data-i18n')?.value);
    // A glyph-only text node (an entity such as &minus;, a symbol, a number)
    // is not copy; marking it would replace the glyph with the catalog text.
    const glyphOnly = !/[A-Za-z]{2}/.test(text.replace(/\{[^{}]*\}/g, ''));
    if (glyphOnly && translated) {
      errors.push(`${file}:${lineAt(source, start)}: data-i18n on a glyph-only text node "${text}"`);
    }
    const occurrence = addOccurrence(
      occurrences,
      source,
      file,
      'html_text',
      text,
      start,
      glyphOnly ? 'excluded:glyph' : (translated ? 'migrated' : 'pending')
    );
    if (parent) {
      parent.directText.push(text);
      parent.directOccurrences.push(occurrence);
    }
  }
  while (stack.length) closeElement(stack.pop(), source, file, addCatalog, errors);
  return occurrences;
}

module.exports = { scanHtml };
