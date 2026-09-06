const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const ELIGIBILITY_FAILURE_MESSAGE = [
  'Explicit spellcheck=true is the eligibility boundary for the delegated spell-correction menu.',
  'Change it only for an agreed prose or short-title field, then update this literal allowlist',
  'in the same intentional change.',
].join(' ');

const EXPECTED_TRUE_SPELLCHECK_IDENTITIES = Object.freeze({
  'index.html': [
    'html:id:homeOpenLoopTitleInput',
    'html:id:homeOpenLoopNotesInput',
    'html:id:chatInput',
  ],
  'renderer/chat/renderer-send-outbox-render.js': [
    'textField:id:`send-outbox-input-${itemKey}`',
  ],
  'renderer/chat/renderer-user-questions-block.js': [
    'markup:data-user-question-other-input',
    'markup:data-user-question-free-text',
  ],
  'renderer/features/personality-form.js': [
    "textField:id:fieldId(prefix, 'note')",
    "textField:id:fieldId(prefix, 'user')",
  ],
  'renderer/features/renderer-dashboard-calendar-agenda.js': [
    "textField:id:'calQuickAdd'",
  ],
  'renderer/features/renderer-dashboard-calendar-form.js': [
    "textField:id:'calFormTitle'",
    "textField:id:'calFormNotes'",
  ],
  'renderer/features/renderer-dashboard-widgets-core.js': [
    "textField:id:'homeAskPill'",
  ],
  'renderer/features/renderer-dashboard-widgets-scratchpad.js': [
    "textField:id:'homeScratchpadInput'",
    "textField:id:'homeScratchpadRename'",
  ],
  'renderer/features/renderer-ide-map-overview.js': [
    "textField:id:'ide-map-overview-question'",
  ],
  'renderer/features/renderer-ide-source-control-panel.js': [
    "textField:id:'ideScmCommitMessage'",
  ],
  'renderer/features/renderer-interactive-panel-utils.js': [
    'markup:data-interactive-other-input',
  ],
  'renderer/features/renderer-memory-notes-utils.js': [
    'textField:id:MEMORY_NOTES_ID',
  ],
  'renderer/features/renderer-memory-settings-utils.js': [
    'textField:id:`memoryTitle${memory.id}`',
    'textField:id:`memoryLesson${memory.id}`',
  ],
  'renderer/features/renderer-scratchpad-pin.js': [
    'textField:id:EDITOR_ID',
  ],
  'renderer/inventory/inline-text-editor.js': [
    'markup:data-edit-target-message-id',
  ],
});

const EXPECTED_TRUE_SPELLCHECK_COUNTS = Object.freeze(Object.fromEntries(
  Object.entries(EXPECTED_TRUE_SPELLCHECK_IDENTITIES)
    .map(([file, identities]) => [file, identities.length])
));

function rendererJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...rendererJavaScriptFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(absolutePath);
    }
  }
  return files;
}

function relativePath(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
}

function sourceInventory() {
  const absolutePaths = [
    path.join(REPO_ROOT, 'index.html'),
    ...rendererJavaScriptFiles(path.join(REPO_ROOT, 'renderer')),
  ];
  return new Map(absolutePaths.map((absolutePath) => [
    relativePath(absolutePath),
    fs.readFileSync(absolutePath, 'utf8'),
  ]));
}

function findHtmlControlById(source, id) {
  const controls = source.match(/<(?:input|textarea)\b[^>]*>/gis) || [];
  return controls.find((control) => control.includes(`id="${id}"`)) || '';
}

function findTextFieldCalls(source) {
  return source.match(/\b(?:[A-Za-z_$][\w$]*\.)?textField\s*\(\s*\{[\s\S]*?\}\s*\)/g) || [];
}

function stripSelectorDeclaration(source) {
  return source.replace(/^.*const SPELLCHECK_FIELD_SELECTOR =.*$/gm, (line) => ' '.repeat(line.length));
}

function compactExpression(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function propertyValue(objectSource, propertyName) {
  const match = new RegExp(`\\b${propertyName}\\s*:`).exec(objectSource);
  if (!match) return '';
  let quote = '';
  let escaped = false;
  let depth = 0;
  let value = '';
  for (let index = match.index + match[0].length; index < objectSource.length; index += 1) {
    const char = objectSource[index];
    if (quote) {
      value += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      value += char;
      continue;
    }
    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) {
      if (depth === 0) break;
      depth -= 1;
    }
    if (char === ',' && depth === 0) break;
    value += char;
  }
  return compactExpression(value);
}

function textFieldRecords(source) {
  const records = [];
  const pattern = /\b(?:[A-Za-z_$][\w$]*\.)?textField\s*\(\s*\{[\s\S]*?\}\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    if (!/\bspellcheck\s*:\s*true\b/.test(match[0])) continue;
    const id = propertyValue(match[0], 'id');
    const className = propertyValue(match[0], 'className');
    records.push({
      identity: id ? `textField:id:${id}` : `textField:className:${className || '<missing>'}`,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return records;
}

function markupIdentity(markup, prefix) {
  const id = /\bid\s*=\s*(['"])([^'"]+)\1/i.exec(markup)?.[2];
  const dataKey = /\b(data-[a-z0-9_-]+)(?:\s*=|\b)/i.exec(markup)?.[1];
  if (prefix === 'html' && id) return `${prefix}:id:${id}`;
  if (dataKey) return `${prefix}:${dataKey}`;
  if (id) return `${prefix}:id:${id}`;
  const className = /\bclass\s*=\s*(['"])([^'"]+)\1/i.exec(markup)?.[2];
  return `${prefix}:class:${compactExpression(className || '<missing>')}`;
}

function markupRecords(source, prefix = 'markup') {
  const records = [];
  const pattern = /<(?:input|textarea)\b[\s\S]*?>/gi;
  for (const match of source.matchAll(pattern)) {
    if (!/\bspellcheck\s*=\s*(['"])true\1/i.test(match[0])) continue;
    records.push({
      identity: markupIdentity(match[0], prefix),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return records;
}

function runtimeAttributeRecords(source) {
  const records = [];
  const pattern = /\b([A-Za-z_$][\w$]*)\.setAttribute\(\s*(['"])spellcheck\2\s*,\s*(['"])true\3\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    records.push({
      identity: `runtime:${match[1]}.setAttribute(spellcheck,true)`,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return records;
}

function trueSpellcheckMarkerOffsets(source) {
  const offsets = [];
  for (const pattern of [
    /\bspellcheck\s*=\s*(['"])true\1/gi,
    /\bspellcheck\s*:\s*true\b/g,
    /\b[A-Za-z_$][\w$]*\.setAttribute\(\s*(['"])spellcheck\1\s*,\s*(['"])true\2\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) offsets.push(match.index);
  }
  return offsets.sort((left, right) => left - right);
}

function spellcheckIdentityInventory(file, originalSource) {
  const source = stripSelectorDeclaration(originalSource);
  const records = file === 'index.html'
    ? markupRecords(source, 'html')
    : [...textFieldRecords(source), ...markupRecords(source), ...runtimeAttributeRecords(source)];
  for (const offset of trueSpellcheckMarkerOffsets(source)) {
    if (!records.some((record) => offset >= record.start && offset < record.end)) {
      const line = source.slice(0, offset).split(/\r?\n/).length;
      records.push({ identity: `unclassified:true-spellcheck@${line}`, start: offset, end: offset + 1 });
    }
  }
  return records.sort((left, right) => left.start - right.start).map((record) => record.identity);
}

test('explicit true spellcheck fields match the delegated-menu eligibility allowlist', () => {
  const actualIdentities = {};
  const actualCounts = {};
  for (const [file, source] of sourceInventory()) {
    const identities = spellcheckIdentityInventory(file, source);
    if (identities.length > 0) {
      actualIdentities[file] = identities;
      actualCounts[file] = identities.length;
    }
  }

  assert.deepEqual(actualCounts, EXPECTED_TRUE_SPELLCHECK_COUNTS, ELIGIBILITY_FAILURE_MESSAGE);
  assert.deepEqual(
    actualIdentities,
    EXPECTED_TRUE_SPELLCHECK_IDENTITIES,
    ELIGIBILITY_FAILURE_MESSAGE
  );
});

test('command, editor fallback, search, and URL fields remain explicitly ineligible', () => {
  const sources = sourceInventory();
  const indexHtml = sources.get('index.html');
  for (const id of ['commandPaletteInput', 'ideEditorFallback', 'artifactReviewEditorFallback']) {
    const control = findHtmlControlById(indexHtml, id);
    assert.ok(control, `Expected #${id} in index.html. ${ELIGIBILITY_FAILURE_MESSAGE}`);
    assert.match(
      control,
      /\bspellcheck="false"/,
      `#${id} must stay outside delegated-menu eligibility. ${ELIGIBILITY_FAILURE_MESSAGE}`
    );
  }

  for (const file of ['renderer/inventory/search-bar.js', 'renderer/inventory/url-field.js']) {
    assert.match(
      sources.get(file),
      /spellcheck="false"/,
      `${file} must keep emitting spellcheck="false". ${ELIGIBILITY_FAILURE_MESSAGE}`
    );
  }
});

test('password fields never opt into delegated spell-correction eligibility', () => {
  const offenders = [];
  for (const [file, source] of sourceInventory()) {
    const htmlControls = source.match(/<(?:input|textarea)\b[^>]*>/gis) || [];
    for (const control of htmlControls) {
      if (/\btype\s*=\s*(['"])password\1/i.test(control)
          && /\bspellcheck\s*=\s*(['"])true\1/i.test(control)) {
        offenders.push(`${file}: password HTML control`);
      }
    }
    for (const call of findTextFieldCalls(source)) {
      if (/\btype\s*:\s*(['"])password\1/.test(call) && /\bspellcheck\s*:\s*true\b/.test(call)) {
        offenders.push(`${file}: password textField call`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Password fields must never enter delegated-menu eligibility. ${ELIGIBILITY_FAILURE_MESSAGE}`
  );
});
