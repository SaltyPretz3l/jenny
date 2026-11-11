'use strict';

/* global document, window */

/**
 * Builds the JavaScript that webContents.executeJavaScriptInIsolatedWorld runs inside a page to
 * read it as a numbered plain-text outline and to resolve, verify and act on those numbers.
 *
 * The page code is written as real functions in the page-reader-*.js modules and serialised
 * with String(fn), so ESLint checks it. The reader installs itself once per document on one
 * global in the isolated world; page scripts cannot reach its objects.
 */

const { installReaderCore } = require('./page-reader-core');
const { installReaderOutline } = require('./page-reader-outline');
const { installReaderActions } = require('./page-reader-actions');

const READER_WORLD_ID = 1001;
const VIEWPORT_CHAR_BUDGET = 6000;
const FULL_CHAR_BUDGET = 14000;
const REF_BLOCK = 10000;
const MAX_GENERATION = 1_000_000;

// Runs in the page. Installs the reader when this document has none, then dispatches the op.
function readerEntry(op, args, installers, budgets) {
  const KEY = '__jennyPageReader';
  let S = window[KEY];
  if (!S || S.doc !== document) {
    const wanted = Math.floor(Number(args.generation));
    const generation = wanted > 0 ? Math.min(wanted, budgets.maxGeneration) : 0;
    S = {
      doc: document,
      base: generation * budgets.refBlock,
      VIEWPORT_BUDGET: budgets.viewport,
      FULL_BUDGET: budgets.full,
      ops: Object.create(null),
    };
    window[KEY] = S;
    for (const install of installers) install(S);
    S.start();
  }
  S.drainMutations();
  if (typeof op !== 'string' || !(op in S.ops)) return { status: 'unknown_op' };
  try {
    return S.ops[op](args);
  } catch (error) {
    return { status: 'error', message: S.clean(error && error.message).slice(0, 200) };
  }
}

// JSON is valid JS; '<' and the line separators are escaped so the text stays inert in any host.
function embed(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
}

const READER_SOURCE = [installReaderCore, installReaderOutline, installReaderActions, readerEntry]
  .map((fn) => String(fn)).join('\n');
const INSTALLERS = '[installReaderCore, installReaderOutline, installReaderActions]';
const BUDGETS = embed({ viewport: VIEWPORT_CHAR_BUDGET, full: FULL_CHAR_BUDGET, refBlock: REF_BLOCK, maxGeneration: MAX_GENERATION });

function buildReaderCall(op, args = {}) {
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  return `(function () {\n${READER_SOURCE}\nreturn readerEntry(${embed(op)}, ${embed(safeArgs)}, ${INSTALLERS}, ${BUDGETS});\n})()`;
}

module.exports = { READER_WORLD_ID, VIEWPORT_CHAR_BUDGET, FULL_CHAR_BUDGET, buildReaderCall };
