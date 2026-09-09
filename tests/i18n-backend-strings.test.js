const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'renderer', 'shared', 'i18n-backend-strings.js');
const APPROVAL_PATH = path.join(ROOT, 'renderer', 'chat', 'renderer-approval-block.js');
const SOURCE_REGISTRIES = [
  path.join(ROOT, 'sidecar', 'ai', 'error_codes.py'),
  path.join(ROOT, 'services', 'backend', 'error-codes.js'),
];

function registryCodes() {
  const codes = new Set();
  const literalPattern = /["'](CMP-[A-Z0-9-]+)["']/g;
  for (const filePath of SOURCE_REGISTRIES) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(literalPattern)) codes.add(match[1]);
  }
  return codes;
}

function documentedRows() {
  const rows = new Map();
  const lines = fs.readFileSync(path.join(ROOT, 'docs', 'operations', 'error-codes.md'), 'utf8').split(/\r?\n/);
  let codeIndex = -1;
  let userMessageIndex = -1;
  for (const line of lines) {
    if (!line.startsWith('|')) {
      codeIndex = -1;
      userMessageIndex = -1;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const nextCodeIndex = cells.findIndex((cell) => cell === 'Wire code' || cell === 'Code');
    if (nextCodeIndex !== -1) {
      codeIndex = nextCodeIndex;
      userMessageIndex = cells.findIndex((cell) => /^User(?:-visible)? message$|^User message$|^User-facing default$/.test(cell));
      continue;
    }
    if (codeIndex < 0 || userMessageIndex < 0 || cells.length <= Math.max(codeIndex, userMessageIndex)) continue;
    const codeMatch = cells[codeIndex].match(/CMP-[A-Z0-9-]+/);
    if (codeMatch) rows.set(codeMatch[0], cells[userMessageIndex]);
  }
  return rows;
}

function tableCodes() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  return new Set([...source.matchAll(/^\s*'(CMP-[A-Z0-9-]+)': function \(\) \{ return jt\(/gm)].map((match) => match[1]));
}

function setMembers(name) {
  const source = fs.readFileSync(APPROVAL_PATH, 'utf8');
  const body = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(body, `expected ${name} in renderer-approval-block.js`);
  const members = [...body[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  if (body[1].includes('POLICY_FALLBACK')) members.push('Review requested input');
  return members;
}

function loadBackendStrings(tag, strings) {
  const i18nUtils = require('../renderer/shared/i18n-utils');
  globalThis.jennyI18n = i18nUtils.createI18n();
  globalThis.jennyI18n.load({ tag, strings: strings || {} });
  delete require.cache[require.resolve('../renderer/shared/i18n-backend-strings')];
  return require('../renderer/shared/i18n-backend-strings');
}

test.afterEach(() => {
  delete globalThis.jennyI18n;
  delete globalThis.jennyI18nFallback;
  delete globalThis.jennyBackendStrings;
  delete require.cache[require.resolve('../renderer/shared/i18n-backend-strings')];
  delete require.cache[require.resolve('../renderer/chat/renderer-error-recovery-utils')];
  delete require.cache[require.resolve('../renderer/chat/renderer-approval-block')];
});

test('error table exactly covers every documented non-internal registry code', () => {
  const registry = registryCodes();
  const docs = documentedRows();
  const undocumented = [...registry].filter((code) => !docs.has(code)).sort();
  assert.deepEqual(undocumented, [], `registry codes missing documentation rows: ${undocumented.join(', ')}`);
  const expected = [...registry].filter((code) => !/^internal-only\b/.test(docs.get(code))).sort();
  assert.deepEqual([...tableCodes()].sort(), expected);
});

test('browser UMD installs only the three backend-string translators', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(MODULE_PATH, 'utf8'), context);
  assert.deepEqual(Object.keys(context.jennyBackendStrings).sort(), [
    'approvalConsequence', 'approvalScope', 'errorText',
  ]);
});

test('errorText preserves rich English backend text and unknown codes', () => {
  delete globalThis.jennyI18n;
  delete require.cache[require.resolve('../renderer/shared/i18n-backend-strings')];
  const absent = require('../renderer/shared/i18n-backend-strings');
  assert.equal(absent.errorText('CMP-AI-0001', 'Model llama3.2 is not loaded.'), 'Model llama3.2 is not loaded.');
  const strings = loadBackendStrings('en');
  assert.equal(strings.errorText('CMP-AI-0001', 'Model llama3.2 is not loaded.'), 'Model llama3.2 is not loaded.');
  const translated = loadBackendStrings('qps-ploc', {
    'error.ai.modelNotLoaded': '[Ṁodel not loaded]',
  });
  assert.equal(translated.errorText('CMP-UNKNOWN-9999', 'Unknown backend detail'), 'Unknown backend detail');
  assert.equal(translated.errorText(null, 'Backend detail'), '');
  assert.equal(translated.errorText('CMP-AI-0001', null), '');
});

test('errorText returns loaded catalog text for a known code in a non-English language', () => {
  const strings = loadBackendStrings('qps-ploc', {
    'error.ai.modelNotLoaded': '[Ṁodel not loaded]',
  });
  assert.equal(strings.errorText('CMP-AI-0001', 'Model llama3.2 is not loaded.'), '[Ṁodel not loaded]');
});

test('errorText keeps the backend text when the canonical sentence still has a placeholder hole', () => {
  const api = loadBackendStrings('qps-ploc', { 'error.web.invalidUrl': '[Ìñvàlíd ÛRL: {url}.]', 'error.ai.modelNotLoaded': '[Ñö mödél ís löàdéd.]' });
  assert.equal(api.errorText('CMP-WEB-0007', 'Invalid URL: not-a-url'), 'Invalid URL: not-a-url');
  assert.equal(api.errorText('CMP-AI-0001', 'No model is loaded.'), '[Ñö mödél ís löàdéd.]');
});

test('every approval policy scope resolves through its static translation key', () => {
  const keys = {
    'Local command execution': 'approval.scope.localCommandExecution',
    'Workspace files': 'approval.scope.workspaceFiles',
    'Web and browser session': 'approval.scope.webAndBrowserSession',
    'Jenny work items': 'approval.scope.jennyWorkItems',
    'Jenny content': 'approval.scope.jennyContent',
    'Local computer': 'approval.scope.localComputer',
    'Requested tool': 'approval.scope.requestedTool',
  };
  const catalog = Object.fromEntries(Object.entries(keys).map(([member, key]) => [key, `[${member}]`]));
  const strings = loadBackendStrings('qps-ploc', catalog);
  for (const member of setMembers('POLICY_SCOPES')) {
    assert.ok(keys[member], `missing translation key for approval scope: ${member}`);
    assert.equal(strings.approvalScope(member), `[${member}]`);
  }
  assert.equal(strings.approvalScope('Future scope'), 'Future scope');
  assert.equal(strings.approvalScope(null), '');
});

test('every approval policy consequence resolves through its static translation key', () => {
  const keys = {
    'May run a local command and change local state.': 'approval.consequence.mayRunLocalCommandAndChangeLocalState',
    'May change data in this scope.': 'approval.consequence.mayChangeDataInThisScope',
    'May read data in this scope.': 'approval.consequence.mayReadDataInThisScope',
    'Review requested input': 'approval.consequence.reviewRequestedInput',
  };
  const catalog = Object.fromEntries(Object.entries(keys).map(([member, key]) => [key, `[${member}]`]));
  const strings = loadBackendStrings('qps-ploc', catalog);
  for (const member of setMembers('POLICY_CONSEQUENCES')) {
    assert.ok(keys[member], `missing translation key for approval consequence: ${member}`);
    assert.equal(strings.approvalConsequence(member), `[${member}]`);
  }
  assert.equal(strings.approvalConsequence('Future consequence'), 'Future consequence');
  assert.equal(strings.approvalConsequence(undefined), '');
});

test('renderer error sinks translate known backend text at call time', () => {
  const backendStrings = loadBackendStrings('qps-ploc', {
    'error.ai.modelNotLoaded': '[Ṁodel not loaded]',
  });
  let translationCalls = 0;
  globalThis.jennyBackendStrings = Object.assign({}, backendStrings, {
    errorText: function errorText(code, text) {
      translationCalls += 1;
      return backendStrings.errorText(code, text);
    },
  });
  const recovery = require('../renderer/chat/renderer-error-recovery-utils');
  const message = { id: 'error-1', error_code: 'CMP-AI-0001', stream_error: 'Model llama3.2 is not loaded.' };
  assert.match(recovery.renderTimelineErrorCard(message), /\[Ṁodel not loaded\]/);
  assert.match(recovery.renderEnhancedFailureNotice(message), /\[Ṁodel not loaded\]/);
  assert.equal(translationCalls, 2, 'each renderer sink translates the backend string exactly once');
});

test('recovery hint heuristics inspect the untranslated backend text', () => {
  globalThis.jennyBackendStrings = loadBackendStrings('qps-ploc', {
    'error.ai.modelNotLoaded': '[Ṁodelo no cargado]',
  });
  const recovery = require('../renderer/chat/renderer-error-recovery-utils');
  const html = recovery.renderTimelineErrorCard({ id: 'error-2', error_code: 'CMP-AI-0001', stream_error: 'Model llama3.2 is not loaded.' });
  assert.match(html, /\[Ṁodelo no cargado\]/, 'display text is translated');
  assert.match(html, /Model not available/, 'the English not-loaded heuristic still picks the model hint');
});
