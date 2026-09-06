'use strict';

const MAX_TASK_TEXT_CHARS = 8 * 1024 * 1024;
const MAX_FIND_RESULTS = 500;

let textUtils = null;
let nodeParentPort = null;

if (typeof module === 'object' && module.exports) {
  textUtils = require('./renderer-ide-replace-text-utils');
  ({ parentPort: nodeParentPort } = require('node:worker_threads'));
} else if (typeof globalThis.importScripts === 'function') {
  globalThis.importScripts('./renderer-ide-replace-text-utils.js');
  textUtils = globalThis.rendererIdeReplaceTextUtils;
}

function taskError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedText(value) {
  const text = String(value ?? '');
  if (text.length > MAX_TASK_TEXT_CHARS) {
    throw taskError('Regex task input exceeds the worker limit.', 'REGEX_INPUT_LIMIT');
  }
  return text;
}

function evaluateRegexTask(task) {
  if (!textUtils) throw taskError('Regex utilities are unavailable.', 'REGEX_UNAVAILABLE');
  const input = task && typeof task === 'object' ? task : {};
  switch (input.op) {
    case 'find': {
      const path = String(input.path || '').slice(0, 4096);
      const lfText = textUtils.toLf(boundedText(input.text));
      const regex = textUtils.buildFindRegex(String(input.query || ''), {
        caseSensitive: input.caseSensitive === true,
        multiline: true,
        global: true,
      });
      const limit = Number.isSafeInteger(input.maxResults) && input.maxResults > 0
        ? Math.min(input.maxResults, MAX_FIND_RESULTS)
        : MAX_FIND_RESULTS;
      const results = [];
      const matched = new Set();
      textUtils.collectRegexMatchesForFile(
        path,
        lfText,
        regex,
        results,
        matched,
        () => results.length >= limit
      );
      return { results, matched: matched.has(path), limitHit: results.length >= limit };
    }
    case 'replaceAll':
      return textUtils.applyReplaceToText(boundedText(input.rawText), {
        query: String(input.query || ''),
        replaceText: String(input.replaceText ?? ''),
        useRegex: true,
        caseSensitive: input.caseSensitive === true,
        eol: input.eol,
      });
    case 'replaceAt':
      return textUtils.applyReplaceAtPosition(boundedText(input.rawText), {
        line: input.line,
        column: input.column,
        query: String(input.query || ''),
        replaceText: String(input.replaceText ?? ''),
        useRegex: true,
        caseSensitive: input.caseSensitive === true,
        eol: input.eol,
      });
    default:
      throw taskError('Unknown regex worker operation.', 'REGEX_INVALID_TASK');
  }
}

function serializeError(error) {
  return {
    code: String(error?.code || 'REGEX_EVALUATION_FAILED').slice(0, 64),
    message: String(error?.message || 'Regex evaluation failed.').slice(0, 256),
  };
}

function handleRequest(message, respond) {
  const id = Number(message?.id);
  try {
    respond({ id, ok: true, result: evaluateRegexTask(message?.task) });
  } catch (error) {
    respond({ id, ok: false, error: serializeError(error) });
  }
}

if (nodeParentPort) {
  nodeParentPort.on('message', (message) => {
    handleRequest(message, (response) => nodeParentPort.postMessage(response));
  });
} else if (typeof globalThis.postMessage === 'function') {
  globalThis.onmessage = (event) => {
    handleRequest(event?.data, (response) => globalThis.postMessage(response));
  };
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    evaluateRegexTask,
    MAX_TASK_TEXT_CHARS,
    MAX_FIND_RESULTS,
  };
}
