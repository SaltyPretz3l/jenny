'use strict';

// Cross-process timeout ordering for decision-driving models.unload and models.list.
// It deliberately excludes inline.complete because abandoning a completion is harmless.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  REQUEST_TIMEOUT_MS_BY_METHOD,
} = require('../services/backend/sidecar-request-timeouts');

function readPythonConstant(relativePath, constantName) {
  const sourcePath = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const match = source.match(new RegExp(`^${constantName}\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*$`, 'm'));
  assert.ok(match, `${constantName} was not found in ${relativePath}`);
  return Number(match[1]);
}

function readJsConstant(relativePath, constantName) {
  const sourcePath = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const match = source.match(new RegExp(constantName + '[ ]*=[ ]*([0-9]+)[ ]*;'));
  assert.ok(match, `${constantName} was not found in ${relativePath}`);
  return Number(match[1]);
}

// The renderer is the outermost layer: it must give up LAST, or it reports a
// timeout for sidecar work that is still running and may still succeed -- the
// exact failure this hierarchy exists to prevent, one layer up.
test('the renderer unload fence outlasts the Electron RPC budget', () => {
  const electronBudget = REQUEST_TIMEOUT_MS_BY_METHOD['models.unload'];
  for (const rendererFile of [
    'renderer/shell/model-library/model-library-runtime-actions.js',
    'renderer/shell/renderer-model-library.js',
  ]) {
    assert.ok(
      readJsConstant(rendererFile, 'MODEL_UNLOAD_TIMEOUT_MS') > electronBudget,
      `${rendererFile} must not reject before the Electron models.unload budget`
    );
  }
});

test('decision-driving sidecar operations time out before their Electron callers', () => {
  const unloadTimeoutSeconds = readPythonConstant(
    'sidecar/ai/engines/ollama_shared.py',
    '_UNLOAD_TIMEOUT'
  );
  const discoveryBudgetSeconds = readPythonConstant(
    'sidecar/ai/engines/catalog.py',
    '_OLLAMA_DISCOVERY_TOTAL_BUDGET_SECONDS'
  );

  assert.ok(
    REQUEST_TIMEOUT_MS_BY_METHOD['models.unload'] > unloadTimeoutSeconds * 1000,
    'models.unload Electron timeout must exceed the sidecar unload timeout'
  );
  assert.ok(
    REQUEST_TIMEOUT_MS_BY_METHOD['models.list'] > discoveryBudgetSeconds * 1000,
    'models.list Electron timeout must exceed the sidecar discovery budget'
  );
});
