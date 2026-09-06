/** Incremental Markdown rendering for one append-only assistant stream. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.markdownStreamRenderer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STATE_VERSION = 1;
  // Bounds only the promotion residual in chooseCompleteLinePromotion and fence
  // construct activation. Tables have no floor: measurement on 2026-09-04 found
  // the construct path cheaper at every measured size.
  const MAX_UNSETTLED_TAIL_CHARS = 8 * 1024;
  const HASH_SEED = 5381;
  const CODE_BLOCK_ID_PLACEHOLDER = '__JENNY_STREAM_CODE_BLOCK_ID__';
  const EMPTY_DEFAULT_TOKEN_SPAN = '<span class="tok tok-default"></span>';
  const issuedStates = new WeakSet();
  const FALLBACK_REASONS = Object.freeze({ INITIAL: 'initial', INVALID_STATE: 'invalid_state',
    SOURCE_REPLACED: 'source_replaced', GUARD_UNAVAILABLE: 'guard_unavailable',
    NO_STABLE_PREFIX: 'no_stable_prefix', RENDER_UNAVAILABLE: 'render_unavailable' });
  const REFERENCE_DEFINITION_RE = /^ {0,3}\[[^\]\n]+\]:/;
  const REFERENCE_LINK_RE = /(?:^|[\s(>.,;:!?-])!?\[[^\]\n]+\](?:\s*\[[^\]\n]*\]|(?!\s*[[(]))/;
  const TASK_CHECKBOX_RE = /^ {0,3}(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s+/;
  const TABLE_UNIT_SUFFIX_RE = /^<\/tbody>\s*<\/table>(?:\s*<\/div>)?\s*$/;
  const RAW_TAG_RE = /<(\/?)([a-z][a-z0-9-]*)(?:\s[^>]*)?\s*\/?>/gi;
  const RAW_VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
    'param', 'source', 'track', 'wbr' ]);
  function hashSegment(value) {
    const source = String(value || '');
    let hash = 0; let power = 1;
    for (let index = 0; index < source.length; index += 1) {
      hash = (Math.imul(hash, 33) + source.charCodeAt(index)) >>> 0;
      power = Math.imul(power, 33) >>> 0;
    }
    return { text: source, length: source.length, hash, power };
  }
  function appendHashSegment(prefix, suffix) {
    const next = typeof suffix === 'string' ? hashSegment(suffix) : suffix;
    if (!prefix?.length) return next;
    if (!next?.length) return prefix;
    return { text: prefix.text + next.text, length: prefix.length + next.length, hash: (Math.imul(prefix.hash, next.power) + next.hash) >>> 0,
      power: Math.imul(prefix.power, next.power) >>> 0 };
  }
  function appendFingerprintSegment(prefix, suffix) {
    const next = typeof suffix === 'string' ? hashSegment(suffix) : suffix;
    if (!prefix?.length) return { length: next.length, hash: next.hash, power: next.power };
    if (!next?.length) return prefix;
    return { length: prefix.length + next.length,
      hash: (Math.imul(prefix.hash, next.power) + next.hash) >>> 0,
      power: Math.imul(prefix.power, next.power) >>> 0 };
  }
  function appendBodyChunk(previous, value) {
    const text = String(value || '');
    return text ? Object.freeze({ previous: previous || null, text }) : previous || null;
  }
  function joinBodyChunks(chunks) {
    const values = [];
    for (let current = chunks; current; current = current.previous) values.push(current.text);
    return values.reverse().join('');
  }
  function fingerprintParts(parts) {
    let hash = HASH_SEED; let length = 0;
    for (const part of parts) {
      const segment = typeof part === 'string' ? hashSegment(part) : part;
      hash = (Math.imul(hash, segment.power) + segment.hash) >>> 0;
      length += segment.length;
    }
    return `unit_${length}_${hash.toString(16)}`;
  }
  function codeBlockIdForBody(bodySegment, index) { return `md-codeblock-${fingerprintParts([bodySegment]).slice(5)}-${index}-pre`; }
  function appendFingerprintChunk(previous, values) {
    const fingerprints = Object.freeze((Array.isArray(values) ? values : [])
      .map((value) => String(value || '')));
    if (fingerprints.length === 0) return previous || null;
    const length = (previous?.length || 0) + fingerprints.length;
    return Object.freeze({ previous: previous || null, values: fingerprints, length });
  }
  function flattenFingerprintChunks(chunks) {
    if (!chunks) return [];
    const ordered = [];
    for (let current = chunks; current; current = current.previous) ordered.push(current.values);
    const result = new Array(chunks.length); let offset = 0;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      for (const value of ordered[index]) result[offset++] = value;
    }
    return result;
  }
  function defineLazyValue(target, name, compute) {
    Object.defineProperty(target, name, { configurable: true, enumerable: true,
      get() {
        const value = compute();
        Object.defineProperty(target, name, { configurable: true, enumerable: true, value });
        return value;
      } });
  }
  function defineFrozenLazyValue(target, name, compute) {
    let resolved = false; let value;
    Object.defineProperty(target, name, { enumerable: true, get() {
      if (!resolved) { value = compute(); resolved = true; }
      return value;
    } });
  }
  function countCodeBlocks(units) { return units.reduce((count, unit) => count + (String(unit.sourceHtml || '').match(/<pre\b[^>]*><code\b/g) || []).length, 0); }
  function resolveModule(globalName, modulePath) {
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) return globalThis[globalName];
    try { return require(modulePath); } catch (_error) { return null; }
  }

  function isContinuationLine(line) {
    return /^(?:[ \t]+|[-+*][ \t]+|\d+[.)][ \t]+|>|\|)/.test(String(line || ''));
  }

  function hasStableGuardDependencies(dependencies) {
    return typeof dependencies?.mermaidText?.advanceFenceState === 'function'
      && typeof dependencies?.mathUtils?.advanceDisplayMathState === 'function';
  }

  function hasUnbalancedRawTags(source) {
    const text = String(source || '');
    if ((text.match(/<!--/g) || []).length !== (text.match(/-->/g) || []).length) return true;
    if ((text.match(/<!\[CDATA\[/g) || []).length !== (text.match(/\]\]>/g) || []).length) return true;
    if ((text.match(/<\?/g) || []).length !== (text.match(/\?>/g) || []).length) return true;
    const openTags = [];
    for (const match of text.matchAll(RAW_TAG_RE)) {
      const tagName = match[2].toLowerCase();
      if (RAW_VOID_TAGS.has(tagName)) continue;
      if (match[0].endsWith('/>')) continue;
      if (!match[1]) {
        openTags.push(tagName);
      } else if (openTags.pop() !== tagName) {
        return true;
      }
    }
    return openTags.length > 0;
  }

  function hasUnbalancedInlineCodeTicks(source) {
    const counts = new Map();
    for (const match of String(source || '').matchAll(/`+/g)) {
      const length = match[0].length;
      counts.set(length, (counts.get(length) || 0) + 1);
    }
    return [...counts.values()].some((count) => count % 2 !== 0);
  }

  function hasGlobalMarkdownDependency(line, plainHtml) {
    const source = String(line || '');
    const proseSource = source.replace(TASK_CHECKBOX_RE, '');
    return REFERENCE_DEFINITION_RE.test(source)
      || REFERENCE_LINK_RE.test(proseSource)
      || (!plainHtml && hasUnbalancedRawTags(source))
      || hasUnbalancedInlineCodeTicks(source);
  }

  function findStablePrefixEnd(source, dependencies) {
    const text = String(source || '');
    if (!hasStableGuardDependencies(dependencies)) return 0;
    if (!text.includes('\n\n') && !text.includes('\r\n\r\n')
        && !text.includes('```') && !text.includes('~~~')) return 0;
    const mermaidText = dependencies.mermaidText;
    const mathUtils = dependencies.mathUtils;
    let fenceState = null;
    let displayMathOpen = false;
    let pendingBoundary = null;
    let stableBoundary = 0;
    let offset = 0;
    let lastNonblankWasContinuation = false;
    let lastNonblankLine = '';

    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      const lineStart = offset;
      offset += rawLine.length + 1;
      const wasInFence = !!fenceState?.marker;
      const wasInDisplayMath = displayMathOpen;
      if (mermaidText && typeof mermaidText.advanceFenceState === 'function') {
        fenceState = mermaidText.advanceFenceState(line, fenceState);
      }
      if (!wasInFence && !fenceState?.marker
          && mathUtils && typeof mathUtils.advanceDisplayMathState === 'function') {
        displayMathOpen = mathUtils.advanceDisplayMathState(line, displayMathOpen);
      }
      const insideOpenConstruct = !!fenceState?.marker || displayMathOpen;
      if (!wasInFence && !fenceState?.marker && hasGlobalMarkdownDependency(line, dependencies.plainHtml)) return 0;
      if (!line.trim()) {
        if (!insideOpenConstruct) {
          pendingBoundary = {
            offset: Math.min(offset, text.length),
            previousWasContinuation: lastNonblankWasContinuation,
          };
        }
        continue;
      }
      if (!pendingBoundary && !wasInFence && fenceState?.marker && !wasInDisplayMath
          && offset <= text.length && lastNonblankLine
          && !/^ {0,3}[<|]/.test(lastNonblankLine)
          && !isContinuationLine(lastNonblankLine) && !isContinuationLine(line)) {
        stableBoundary = Math.min(lineStart, text.length);
        pendingBoundary = null;
      }
      if (pendingBoundary && lineStart >= pendingBoundary.offset && !wasInFence && !wasInDisplayMath) {
        if (!isContinuationLine(line) || !pendingBoundary.previousWasContinuation) {
          stableBoundary = pendingBoundary.offset;
        }
        pendingBoundary = null;
      }
      lastNonblankWasContinuation = isContinuationLine(line);
      lastNonblankLine = line;
    }
    return stableBoundary;
  }

  function scanLines(source) {
    const text = String(source || '');
    const lines = [];
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const complete = newline >= 0;
      const end = complete ? newline + 1 : text.length;
      lines.push({ start, end, complete,
        text: text.slice(start, complete ? newline : end).replace(/\r$/, '') });
      start = end;
    }
    return lines;
  }
  function chooseCompleteLinePromotion(lines, sourceLength) {
    let lastCompleteEnd = 0;
    for (const line of lines) {
      if (!line.complete) break;
      lastCompleteEnd = line.end;
    }
    return sourceLength - lastCompleteEnd <= MAX_UNSETTLED_TAIL_CHARS ? lastCompleteEnd : 0;
  }
  function hasUnsafeTableDependency(source, dependencies) {
    let displayMathOpen = false;
    for (const line of scanLines(source)) {
      if (hasGlobalMarkdownDependency(line.text, dependencies.plainHtml)) return true;
      if (String(line.text).includes('$')) {
        displayMathOpen = dependencies.mathUtils.advanceDisplayMathState(line.text, displayMathOpen);
        if (displayMathOpen) return true;
      }
    }
    return false;
  }
  function tableActivationFor(source, dependencies) {
    const text = String(source || '');
    const lines = scanLines(text);
    if (lines.length < 3 || !lines[0].complete || !lines[1].complete) return null;
    if (!lines[0].text.includes('|')) return null;
    if (!/^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[1].text)) return null;
    if (hasUnsafeTableDependency(text, dependencies)) return null;
    const bodyLines = [];
    for (let index = 2; index < lines.length; index += 1) {
      if (!lines[index].text.trim()) break;
      bodyLines.push(lines[index]);
    }
    const relativeEnd = chooseCompleteLinePromotion(bodyLines.map((line) => ({
      ...line, start: line.start - lines[1].end, end: line.end - lines[1].end,
    })), text.length - lines[1].end);
    if (relativeEnd <= 0) return null;
    return { kind: 'table', openerSource: text.slice(0, lines[1].end),
      promoteEnd: lines[1].end + relativeEnd };
  }
  function fenceActivationFor(source, dependencies) {
    const text = String(source || '');
    if (text.length <= MAX_UNSETTLED_TAIL_CHARS) return null;
    const lines = scanLines(text);
    if (!lines[0]?.complete) return null;
    const opened = dependencies.mermaidText.advanceFenceState(lines[0].text, null);
    if (!opened?.opened || !opened.marker) return null;
    const bodyLines = [];
    let fenceState = opened;
    for (let index = 1; index < lines.length; index += 1) {
      const nextState = dependencies.mermaidText.advanceFenceState(lines[index].text, fenceState);
      if (nextState?.closed) break;
      bodyLines.push(lines[index]);
      fenceState = nextState;
    }
    const relativeEnd = chooseCompleteLinePromotion(bodyLines.map((line) => ({
      ...line, start: line.start - lines[0].end, end: line.end - lines[0].end,
    })), text.length - lines[0].end);
    if (relativeEnd <= 0) return null;
    const promoteEnd = lines[0].end + relativeEnd;
    const promotedBody = text.slice(lines[0].end, promoteEnd);
    if (promotedBody.length <= MAX_UNSETTLED_TAIL_CHARS) return null;
    const info = String(opened.info || '');
    const plainInfo = !info || /^(?:text|plaintext|none)\b/.test(info);
    if (!dependencies.plainHtml
        && (/^mermaid\b/.test(info)
          || (plainInfo && dependencies.mermaidText.looksLikeSource?.(promotedBody)))) {
      return null;
    }
    return { kind: 'fence', openerSource: text.slice(0, lines[0].end),
      closingSource: `${opened.marker.repeat(opened.length)}\n`, marker: opened.marker,
      markerLength: opened.length, promoteEnd };
  }
  function forcedActivationFor(source, dependencies) { return tableActivationFor(source, dependencies) || fenceActivationFor(source, dependencies); }
  function splitTableUnit(unit) {
    const sourceHtml = String(unit?.sourceHtml || '');
    const bodyOpen = sourceHtml.indexOf('<tbody>');
    const bodyClose = sourceHtml.lastIndexOf('</tbody>');
    if (bodyOpen < 0 || bodyClose < bodyOpen) return null;
    const bodyStart = bodyOpen + '<tbody>'.length;
    const sourceSuffix = sourceHtml.slice(bodyClose);
    // The construct freezes head+suffix, so the table must BE the unit. A table
    // nested in a list item would bake </li></ul> into the frozen prefix and
    // push every later block of that item out of the list.
    if (!TABLE_UNIT_SUFFIX_RE.test(sourceSuffix)) return null;
    return { sourceHead: sourceHtml.slice(0, bodyStart),
      sourceBody: sourceHtml.slice(bodyStart, bodyClose), sourceSuffix };
  }
  function splitCodeUnit(unit) {
    function splitBulkDecorated(html) {
      const open = /<code\b[^>]*>/.exec(html);
      if (!open) return null;
      const spanStart = open.index + open[0].length;
      const span = '<span class="tok tok-default">';
      if (!html.startsWith(span, spanStart)) return null;
      const bodyStart = spanStart + span.length;
      const close = html.lastIndexOf('</span></code>');
      return close < bodyStart ? null
        : { head: html.slice(0, bodyStart), body: html.slice(bodyStart, close), suffix: html.slice(close) };
    }
    const source = splitCodeSourceHtml(String(unit?.sourceHtml || ''));
    const id = String(unit?.sourceHtml || '').match(/\bid="(md-codeblock-[^"]+-pre)"/)?.[1];
    const codeBlockId = /^md-codeblock-\d+-pre$/.test(id) ? id : '';
    const decorated = codeBlockId
      ? splitCodeSourceHtml(String(unit?.html || '')) : splitBulkDecorated(String(unit?.html || ''));
    if (!source || !decorated || !id || (!codeBlockId && source.body !== decorated.body)) return null;
    const hasTrailingEmptySpan = codeBlockId && source.body.endsWith('\n')
      && decorated.body.endsWith(EMPTY_DEFAULT_TOKEN_SPAN);
    const htmlBody = hasTrailingEmptySpan
      ? decorated.body.slice(0, -EMPTY_DEFAULT_TOKEN_SPAN.length) : decorated.body;
    const htmlSuffix = (hasTrailingEmptySpan ? EMPTY_DEFAULT_TOKEN_SPAN : '') + decorated.suffix;
    return { sourceHead: source.head.replaceAll(id, CODE_BLOCK_ID_PLACEHOLDER),
      sourceBody: source.body, sourceSuffix: source.suffix.replaceAll(id, CODE_BLOCK_ID_PLACEHOLDER),
      htmlHead: decorated.head.replaceAll(id, CODE_BLOCK_ID_PLACEHOLDER),
      htmlBody, htmlSuffix: htmlSuffix.replaceAll(id, CODE_BLOCK_ID_PLACEHOLDER),
      codeBlockId };
  }
  function splitCodeSourceHtml(html) {
    const open = /<code\b[^>]*>/.exec(html);
    const close = html.lastIndexOf('</code>');
    if (!open || close < open.index + open[0].length) return null;
    const start = open.index + open[0].length; return { head: html.slice(0, start), body: html.slice(start, close), suffix: html.slice(close) };
  }
  function stateFromOptions(options, previousUnits) { return options?.previousStreamState || (Array.isArray(previousUnits) ? previousUnits[0]?.streamState : null); }
  function isValidState(state) {
    const prefixUnits = state?.prefixUnits;
    const prefixShapeValid = Array.isArray(prefixUnits) && prefixUnits.every((unit, index) => unit
      && typeof unit === 'object' && typeof unit.fingerprint === 'string'
      && (index === state.activeConstruct?.unitIndex || typeof unit.html === 'string'));
    return !!state
      && issuedStates.has(state)
      && state.version === STATE_VERSION
      && typeof state.source === 'string'
      && Number.isInteger(state.stablePrefixEnd)
      && state.stablePrefixEnd >= 0
      && state.stablePrefixEnd <= state.source.length
      && typeof state.prefixHtml === 'string'
      && Number.isInteger(state.prefixCodeBlockCount)
      && (state.prefixFingerprintChunks?.length || 0) === prefixUnits.length
      && prefixShapeValid
      && (state.stablePrefixEnd === 0 ? prefixUnits.length === 0 : prefixUnits.length > 0);
  }
  function renderedFragment(rendered, createTemplateElement) {
    if (rendered?.fragment) return rendered.fragment;
    const template = createTemplateElement?.();
    if (!template) return null;
    template.innerHTML = String(rendered?.html ?? rendered ?? '');
    return template.content;
  }

  function rawUnitsFor(source, dependencies, codeBlockIndexOffset) {
    if (!source) return [];
    try {
      // Bulk code-block ids embed an index that restarts at 0 in every
      // fragment. Passing how many blocks already settled makes the id
      // correct at generation time; rewriting rendered HTML afterwards
      // corrupted answer text that merely CONTAINED an id-shaped string.
      const rendered = dependencies.renderChunk(source, codeBlockIndexOffset || 0);
      const fragment = renderedFragment(rendered, dependencies.createTemplateElement);
      const streamUnits = dependencies.streamUnits;
      if (!fragment || !streamUnits?.buildModel) return null;
      const html = typeof rendered === 'object' ? rendered.html : String(rendered || '');
      return streamUnits.buildModel(fragment.childNodes, html, [], dependencies.escapeHtml).units;
    } catch (_error) {
      return null;
    }
  }
  function freezeUnits(units) {
    return Object.freeze((Array.isArray(units) ? units : []).map((unit) => {
      const copy = { ...unit }; delete copy.streamState;
      return Object.freeze(copy);
    }));
  }
  function decorateModel(model, previousUnits, dependencies) {
    const streamUnits = dependencies.streamUnits;
    dependencies.codeHighlight?.decorateStreamModel?.(model, previousUnits, {
      fingerprintHtml: streamUnits.fingerprintHtml, document: dependencies.createTemplateElement?.()?.ownerDocument,
    });
    return model;
  }
  function buildModel(source, previousUnits, state, mode, fallbackReason, dependencies) {
    const prefixUnits = state.prefixUnits.map((unit) => ({ ...unit }));
    const tailUnits = rawUnitsFor(source.slice(state.stablePrefixEnd), dependencies, state.prefixCodeBlockCount);
    if (tailUnits === null) return null;
    const units = prefixUnits.length ? prefixUnits.concat(tailUnits) : tailUnits;
    const streamUnits = dependencies.streamUnits;
    const changedStartIndex = streamUnits.findChangedStartIndex(previousUnits, units);
    const model = { units, changedStartIndex, renderMode: mode, fallbackReason };
    decorateModel(model, previousUnits, dependencies);
    if (previousUnits.length > 0 && previousUnits.every((unit) => typeof unit === 'string')) {
      const fingerprints = model.units.map((unit) => String(unit.fingerprint || ''));
      const sharedLength = Math.min(previousUnits.length, fingerprints.length);
      let changed = previousUnits.length === fingerprints.length ? -1 : sharedLength;
      for (let index = 0; index < sharedLength; index += 1) {
        if (String(previousUnits[index]) !== fingerprints[index]) { changed = index; break; }
      }
      model.changedStartIndex = changed;
    }
    const tailHtml = tailUnits.map((unit) => String(unit.html || '')).join('');
    const tailFingerprints = tailUnits.map((unit) => unit.fingerprint);
    defineLazyValue(model, 'html', () => state.prefixHtml + tailHtml);
    defineLazyValue(model, 'fingerprints', () => flattenFingerprintChunks(
      state.prefixFingerprintChunks
    ).concat(tailFingerprints));
    return model;
  }
  function attachState(model, state) {
    const prefixUnits = Object.isFrozen(state.prefixUnits) ? state.prefixUnits : freezeUnits(state.prefixUnits);
    const issuedState = Object.freeze({ ...state, prefixUnits });
    issuedStates.add(issuedState);
    model.streamState = issuedState;
    if (model.units[0]) model.units[0] = { ...model.units[0], streamState: issuedState };
    return model;
  }
  function fullRender(source, previousUnits, reason, dependencies) {
    const state = { version: STATE_VERSION, source, stablePrefixEnd: 0,
      prefixUnits: Object.freeze([]), prefixHtml: '',
      prefixFingerprintChunks: null, prefixCodeBlockCount: 0, activeConstruct: null };
    const model = buildModel(source, previousUnits, state, 'full', reason, dependencies, 0);
    return model ? attachState(model, state) : null;
  }
  function replaceCodeBlockId(template, id) { return String(template || '').replaceAll(CODE_BLOCK_ID_PLACEHOLDER, id); }
  function buildConstructUnit(construct, tailBody, dependencies) {
    const sourceTailBody = typeof tailBody === 'string' ? tailBody : String(tailBody?.sourceBody || '');
    const body = construct.kind === 'table'
      ? appendHashSegment(construct.bodySegment, tailBody || '')
      : appendFingerprintSegment(construct.bodySegment, sourceTailBody);
    if (construct.kind === 'table') {
      const html = construct.sourceHead + body.text + construct.sourceSuffix;
      const fingerprint = fingerprintParts([construct.sourceHead, body, construct.sourceSuffix]);
      return { html, fingerprint, sourceHtml: html, sourceFingerprint: fingerprint, highlightReuseToken: {} };
    }
    const htmlTailBody = typeof tailBody === 'string' ? tailBody : String(tailBody?.htmlBody || '');
    const htmlBody = appendFingerprintSegment(construct.htmlBodySegment, htmlTailBody);
    const id = construct.codeBlockId || codeBlockIdForBody(body, construct.codeIndex);
    const sourceHead = replaceCodeBlockId(construct.sourceHead, id);
    const sourceSuffix = replaceCodeBlockId(construct.sourceSuffix, id);
    const htmlHead = replaceCodeBlockId(construct.htmlHead, id);
    const htmlSuffix = replaceCodeBlockId(construct.htmlSuffix, id);
    const bodyChunks = appendBodyChunk(construct.bodyChunks, sourceTailBody);
    const htmlBodyChunks = appendBodyChunk(construct.htmlBodyChunks, htmlTailBody);
    let bodyText; let htmlBodyText;
    const materializeBody = () => bodyText ??= joinBodyChunks(bodyChunks);
    const materializeHtmlBody = () => htmlBodyText ??= joinBodyChunks(htmlBodyChunks);
    const unit = { fingerprint: fingerprintParts([htmlHead, htmlBody, htmlSuffix]),
      sourceFingerprint: fingerprintParts([sourceHead, body, sourceSuffix]), highlightReuseToken: {} };
    defineFrozenLazyValue(unit, 'html', () => htmlHead + materializeHtmlBody() + htmlSuffix);
    defineFrozenLazyValue(unit, 'sourceHtml', () => sourceHead + materializeBody() + sourceSuffix);
    return unit;
  }
  function extractConstructBody(kind, unit, construct) {
    if (kind === 'table') return splitTableUnit(unit)?.sourceBody ?? null;
    const source = splitCodeSourceHtml(String(unit?.sourceHtml || ''));
    const html = splitCodeSourceHtml(String(unit?.html || ''));
    if (!source || !html) return null;
    const htmlBody = construct.codeBlockId && source.body.endsWith('\n')
      && html.body.endsWith(EMPTY_DEFAULT_TOKEN_SPAN)
      ? html.body.slice(0, -EMPTY_DEFAULT_TOKEN_SPAN.length) : html.body;
    return { sourceBody: source.body, htmlBody };
  }
  function renderConstructTailParts(state, tailSource, dependencies) {
    const construct = state.activeConstruct;
    if (!tailSource) return { tailBody: '', unit: buildConstructUnit(construct, '', dependencies) };
    // The synthetic closer must open its own line — glued to a content line it
    // rendered as code — unless the tail already ends in an unterminated
    // closing fence (the source's own closer without its newline yet), which
    // the closer extends; a fresh line there would open a second fence.
    const lastLine = tailSource.slice(tailSource.lastIndexOf('\n') + 1);
    const closerRe = construct.kind === 'fence'
      ? new RegExp(`^ {0,3}${construct.marker}{${construct.markerLength},}\\s*$`) : null;
    const closer = !closerRe ? ''
      : (tailSource.endsWith('\n') || closerRe.test(lastLine) ? '' : '\n') + construct.closingSource;
    const synthetic = construct.openerSource + tailSource + closer;
    const units = rawUnitsFor(synthetic, dependencies, construct.codeIndex);
    if (!units || units.length !== 1) return null;
    if (construct.kind === 'fence' && construct.codeBlockId) {
      decorateModel({ units, changedStartIndex: 0 }, [], dependencies);
    }
    const tailBody = extractConstructBody(construct.kind, units[0], construct);
    return tailBody === null ? null : { tailBody,
      unit: buildConstructUnit(construct, tailBody, dependencies) };
  }
  function buildConstructModel(source, state, dependencies, currentUnitOverride) {
    const construct = state.activeConstruct;
    const currentUnit = currentUnitOverride || renderConstructTailParts(
      state, source.slice(state.stablePrefixEnd), dependencies
    )?.unit;
    if (!currentUnit) return null;
    const units = state.prefixUnits.slice(0, construct.unitIndex)
      .map((unit) => ({ ...unit })).concat(currentUnit);
    const model = { units, changedStartIndex: construct.unitIndex,
      renderMode: 'incremental', fallbackReason: '' };
    defineLazyValue(model, 'html', () => construct.leadingPrefixHtml + model.units[construct.unitIndex].html);
    defineLazyValue(model, 'fingerprints', () => flattenFingerprintChunks(
      construct.leadingFingerprintChunks
    ).concat(currentUnit.fingerprint));
    return model;
  }
  function replaceConstructUnit(state, source, stablePrefixEnd, owner, activeConstruct, unit) {
    const frozenUnit = Object.freeze(unit);
    const prefixUnits = state.prefixUnits.slice(0, owner.unitIndex);
    prefixUnits[owner.unitIndex] = frozenUnit;
    return { ...state, source, stablePrefixEnd, prefixUnits: Object.freeze(prefixUnits),
      prefixHtml: activeConstruct ? owner.leadingPrefixHtml : owner.leadingPrefixHtml + frozenUnit.html,
      prefixFingerprintChunks: appendFingerprintChunk(
        owner.leadingFingerprintChunks, [frozenUnit.fingerprint]
      ), activeConstruct };
  }
  function activateConstruct(state, source, activation, previousUnits, dependencies) {
    const start = state.stablePrefixEnd;
    const unsettled = source.slice(start);
    const promotedSource = unsettled.slice(0, activation.promoteEnd);
    const synthetic = promotedSource
      + (activation.kind === 'fence' ? activation.closingSource : '');
    const units = rawUnitsFor(synthetic, dependencies, state.prefixCodeBlockCount);
    if (!units || units.length !== 1) return null;
    if (activation.kind === 'fence') {
      const previousTail = previousUnits.slice(state.prefixUnits.length);
      decorateModel({ units, changedStartIndex: dependencies.streamUnits.findChangedStartIndex(previousTail, units) }, previousTail, dependencies);
    }
    const split = activation.kind === 'table' ? splitTableUnit(units[0]) : splitCodeUnit(units[0]);
    if (!split) return null;
    const construct = Object.freeze({ ...activation, unitIndex: state.prefixUnits.length,
      leadingPrefixHtml: state.prefixHtml, leadingFingerprintChunks: state.prefixFingerprintChunks, codeIndex: state.prefixCodeBlockCount,
      sourceHead: split.sourceHead, sourceSuffix: split.sourceSuffix,
      htmlHead: split.htmlHead || split.sourceHead, htmlSuffix: split.htmlSuffix || split.sourceSuffix,
      codeBlockId: split.codeBlockId || '',
      bodySegment: activation.kind === 'table'
        ? hashSegment(split.sourceBody) : appendFingerprintSegment(null, split.sourceBody),
      bodyChunks: activation.kind === 'fence' ? appendBodyChunk(null, split.sourceBody) : null,
      bodyLineCount: activation.kind === 'fence' ? split.sourceBody.split('\n').length : 0,
      htmlBodySegment: activation.kind === 'fence'
        ? appendFingerprintSegment(null, split.htmlBody) : null,
      htmlBodyChunks: activation.kind === 'fence' ? appendBodyChunk(null, split.htmlBody) : null });
    const prefixUnit = buildConstructUnit(construct, '', dependencies);
    const nextState = activation.kind === 'fence'
      ? { ...state, prefixCodeBlockCount: state.prefixCodeBlockCount + 1 } : state;
    return replaceConstructUnit(nextState, source, start + activation.promoteEnd, construct, construct, prefixUnit);
  }
  function tableSettlement(tailSource) { for (const line of scanLines(tailSource)) { if (!line.text.trim() && line.complete) return { bodyEnd: line.start, settledEnd: line.end }; } return null; }
  function fenceSettlement(tailSource, construct, dependencies) {
    let fenceState = { marker: construct.marker, length: construct.markerLength };
    for (const line of scanLines(tailSource)) {
      const nextState = dependencies.mermaidText.advanceFenceState(line.text, fenceState);
      if (nextState?.closed) return line.complete ? { bodyEnd: line.start, settledEnd: line.end } : null;
      fenceState = nextState;
    }
    return null;
  }
  function updateConstructPrefix(state, source, promotedLength, promotedBody, dependencies) {
    const construct = state.activeConstruct;
    const bodySegment = construct.kind === 'table'
      ? appendHashSegment(construct.bodySegment, promotedBody)
      : appendFingerprintSegment(construct.bodySegment, promotedBody.sourceBody);
    const bodyChunks = construct.kind === 'fence'
      ? appendBodyChunk(construct.bodyChunks, promotedBody.sourceBody) : null;
    const htmlBodySegment = construct.kind === 'fence'
      ? appendFingerprintSegment(construct.htmlBodySegment, promotedBody.htmlBody) : null;
    const htmlBodyChunks = construct.kind === 'fence'
      ? appendBodyChunk(construct.htmlBodyChunks, promotedBody.htmlBody) : null;
    const bodyLineCount = construct.kind === 'fence'
      ? construct.bodyLineCount + (promotedBody.sourceBody.match(/\n/g) || []).length : 0;
    const nextConstruct = Object.freeze({ ...construct, bodySegment, bodyChunks, bodyLineCount,
      htmlBodySegment, htmlBodyChunks });
    const prefixUnit = buildConstructUnit(nextConstruct, '', dependencies);
    return replaceConstructUnit(state, source, state.stablePrefixEnd + promotedLength,
      construct, nextConstruct, prefixUnit);
  }
  function settleConstruct(state, source, settlement, dependencies) {
    const construct = state.activeConstruct;
    const tailSource = source.slice(state.stablePrefixEnd, state.stablePrefixEnd + settlement.bodyEnd);
    const finalUnit = renderConstructTailParts(state, tailSource, dependencies)?.unit;
    if (!finalUnit) return null;
    return replaceConstructUnit(state, source, state.stablePrefixEnd + settlement.settledEnd,
      construct, null, finalUnit);
  }
  function advanceConstruct(state, source, dependencies) {
    const construct = state.activeConstruct;
    const tailSource = source.slice(state.stablePrefixEnd);
    if (construct.kind === 'table' && hasUnsafeTableDependency(tailSource, dependencies)) return { fallback: true };
    const settlement = construct.kind === 'table'
      ? tableSettlement(tailSource)
      : fenceSettlement(tailSource, construct, dependencies);
    const maxBodyLines = dependencies.codeHighlight?.MAX_BODY_LINES;
    const tailBodySource = settlement ? tailSource.slice(0, settlement.bodyEnd) : tailSource;
    if (construct.kind === 'fence' && construct.codeBlockId && Number.isInteger(maxBodyLines)
        && construct.bodyLineCount + (tailBodySource.match(/\n/g) || []).length > maxBodyLines) {
      return { fallback: true };
    }
    if (settlement) { const settled = settleConstruct(state, source, settlement, dependencies); return settled ? { state: settled } : { fallback: true }; }
    const renderedTail = renderConstructTailParts(state, tailSource, dependencies);
    if (!renderedTail) return { fallback: true };
    const lines = scanLines(tailSource);
    const promotable = construct.kind === 'table' ? lines : lines.filter((line) => {
      const fence = { marker: construct.marker, length: construct.markerLength };
      return !dependencies.mermaidText.advanceFenceState(line.text, fence)?.closed;
    });
    const promotedLength = chooseCompleteLinePromotion(promotable, tailSource.length);
    if (promotedLength <= 0) return { state: { ...state, source }, currentUnit: renderedTail.unit };
    const promotedSource = tailSource.slice(0, promotedLength);
    let promotedBody;
    if (construct.kind === 'fence') {
      const promotedLineCount = scanLines(promotedSource).filter((line) => line.complete).length;
      const sourceLines = scanLines(renderedTail.tailBody.sourceBody);
      const htmlLines = scanLines(renderedTail.tailBody.htmlBody);
      if (sourceLines.length < promotedLineCount || htmlLines.length < promotedLineCount
          || !sourceLines[promotedLineCount - 1]?.complete
          || !htmlLines[promotedLineCount - 1]?.complete) return { fallback: true };
      promotedBody = {
        sourceBody: renderedTail.tailBody.sourceBody.slice(0, sourceLines[promotedLineCount - 1].end),
        htmlBody: renderedTail.tailBody.htmlBody.slice(0, htmlLines[promotedLineCount - 1].end),
      };
    } else {
      const rowMatches = renderedTail.tailBody.match(/<tr>[\s\S]*?<\/tr>\n?/g) || [];
      const promotedRowCount = scanLines(promotedSource).filter((line) => line.complete).length;
      if (rowMatches.length < promotedRowCount) return { fallback: true };
      promotedBody = rowMatches.slice(0, promotedRowCount).join('');
    }
    const promoted = updateConstructPrefix(state, source, promotedLength, promotedBody, dependencies);
    return promoted ? { state: promoted, currentUnit: renderedTail.unit } : { fallback: true };
  }
  function promoteStablePrefix(state, source, promotedLength, previousUnits, dependencies) {
    const promotedSource = source.slice(state.stablePrefixEnd, state.stablePrefixEnd + promotedLength);
    const promotedUnits = rawUnitsFor(promotedSource, dependencies, state.prefixCodeBlockCount);
    if (promotedUnits === null) return null;
    const previousPromoted = previousUnits.slice(
      state.prefixUnits.length, state.prefixUnits.length + promotedUnits.length
    );
    decorateModel({ units: promotedUnits,
      changedStartIndex: dependencies.streamUnits.findChangedStartIndex(previousPromoted, promotedUnits) }, previousPromoted, dependencies);
    const frozenPromotedUnits = freezeUnits(promotedUnits);
    const promotedHtml = frozenPromotedUnits.map((unit) => String(unit.html || '')).join('');
    const prefixUnits = Object.freeze(state.prefixUnits.concat(frozenPromotedUnits));
    const fingerprints = frozenPromotedUnits.map((unit) => unit.fingerprint);
    return { ...state, source, stablePrefixEnd: state.stablePrefixEnd + promotedLength,
      prefixUnits, prefixHtml: state.prefixHtml + promotedHtml,
      prefixCodeBlockCount: state.prefixCodeBlockCount + countCodeBlocks(frozenPromotedUnits),
      prefixFingerprintChunks: appendFingerprintChunk(state.prefixFingerprintChunks, fingerprints) };
  }
  function renderStreamingMarkdownUnits(content, options, dependencies) {
    const source = typeof content === 'string' ? content : String(content || '');
    const previousUnits = Array.isArray(options?.previousUnits) ? options.previousUnits
      : (Array.isArray(options?.previousFingerprints) ? options.previousFingerprints : []);
    const deps = {
      ...dependencies,
      streamUnits: dependencies?.streamUnits || resolveModule('markdownStreamUnits', './markdown-stream-units'),
      codeHighlight: dependencies?.codeHighlight || resolveModule('rendererCodeHighlight', '../chat/renderer-code-highlight'),
      mermaidText: dependencies?.mermaidText || resolveModule('markdownMermaidText', './markdown-mermaid-text'),
      mathUtils: dependencies?.mathUtils || resolveModule('markdownMathUtils', './markdown-math-utils'),
      plainHtml: options?.mermaid === 'plain',
    };
    if (!deps.streamUnits?.findChangedStartIndex || typeof deps.renderChunk !== 'function') return null;
    const previousState = stateFromOptions(options, previousUnits);
    if (!previousState) return fullRender(source, previousUnits, FALLBACK_REASONS.INITIAL, deps);
    if (!isValidState(previousState)) return fullRender(source, previousUnits, FALLBACK_REASONS.INVALID_STATE, deps);
    if (!source.startsWith(previousState.source)) return fullRender(source, previousUnits, FALLBACK_REASONS.SOURCE_REPLACED, deps);
    if (!hasStableGuardDependencies(deps)) return fullRender(source, previousUnits, FALLBACK_REASONS.GUARD_UNAVAILABLE, deps);
    let state = previousState;
    if (state.activeConstruct) {
      const advanced = advanceConstruct(state, source, deps);
      if (advanced.fallback) return fullRender(source, previousUnits, FALLBACK_REASONS.RENDER_UNAVAILABLE, deps);
      state = advanced.state;
      if (state.activeConstruct) {
        const activeModel = buildConstructModel(source, state, deps, advanced.currentUnit);
        return activeModel ? attachState(activeModel, state)
          : fullRender(source, previousUnits, FALLBACK_REASONS.RENDER_UNAVAILABLE, deps);
      }
    }
    let unsettledSource = source.slice(state.stablePrefixEnd);
    const promotedLength = findStablePrefixEnd(unsettledSource, deps);
    if (promotedLength > 0) {
      const promoted = promoteStablePrefix(state, source, promotedLength, previousUnits, deps);
      if (!promoted) return fullRender(source, previousUnits, FALLBACK_REASONS.RENDER_UNAVAILABLE, deps);
      state = promoted;
      unsettledSource = source.slice(state.stablePrefixEnd);
    } else {
      state = { ...state, source };
    }
    const activation = forcedActivationFor(unsettledSource, deps);
    if (activation) {
      const activated = activateConstruct(state, source, activation, previousUnits, deps);
      if (activated) {
        const activeModel = buildConstructModel(source, activated, deps);
        return activeModel ? attachState(activeModel, activated)
          : fullRender(source, previousUnits, FALLBACK_REASONS.RENDER_UNAVAILABLE, deps);
      }
    }
    const mode = state.stablePrefixEnd > 0 ? 'incremental' : 'full';
    const fallbackReason = mode === 'full' ? FALLBACK_REASONS.NO_STABLE_PREFIX : '';
    const model = buildModel(source, previousUnits, state, mode, fallbackReason, deps);
    return model ? attachState(model, state) : fullRender(source, previousUnits, FALLBACK_REASONS.RENDER_UNAVAILABLE, deps);
  }
  return { FALLBACK_REASONS, MAX_UNSETTLED_TAIL_CHARS, findStablePrefixEnd, renderStreamingMarkdownUnits };
});
