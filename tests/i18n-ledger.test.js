'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { scanJavaScript } = require('../scripts/i18n/ledger-js-scan.js');
const { scanHtml } = require('../scripts/i18n/ledger-html-scan.js');
const { buildArtifacts, compareOrdinal } = require('../scripts/i18n/ledger-outputs.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const LEDGER_CLI = path.join(REPO_ROOT, 'scripts', 'i18n', 'ledger.js');
const createdFixtures = [];

afterEach(() => {
  for (const root of createdFixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-i18n-ledger-'));
  createdFixtures.push(root);
  fs.mkdirSync(path.join(root, 'renderer'), { recursive: true });
  fs.mkdirSync(path.join(root, 'services'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body></body></html>\n');
  return root;
}

function write(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content.replace(/^\n/, ''), 'utf8');
}

function run(root, ...args) {
  return spawnSync(process.execPath, [LEDGER_CLI, ...args, '--root', root], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function scan(root, ...args) {
  const result = run(root, 'scan', ...args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(fs.readFileSync(path.join(root, 'docs/i18n/STRING_LEDGER.json'), 'utf8'));
}

function occurrence(ledger, text) {
  return ledger.occurrences.find((item) => item.text === text);
}

test('detects every JavaScript display sink kind', () => {
  const root = fixture();
  write(root, 'renderer/sinks.js', `
    node.textContent = 'Visible DOM text';
    node.setAttribute('title', 'Visible DOM title');
    const config = { label: 'Visible config label' };
    showToast('Visible toast notice');
    window.confirm('Visible native question');
    date.toLocaleDateString();
  `);
  write(root, 'services/dialog.js', `
    showMessageBox({ title: 'Visible main dialog' });
  `);
  write(root, 'services/ipc.js', `
    function result() { return { message: 'Visible IPC message' }; }
  `);

  const ledger = scan(root);
  const expected = new Map([
    ['Visible DOM text', 'dom_text'],
    ['Visible DOM title', 'dom_attr'],
    ['Visible config label', 'config_copy'],
    ['Visible toast notice', 'toast'],
    ['Visible native question', 'native_dialog'],
    ['Visible main dialog', 'main_dialog'],
    ['Visible IPC message', 'ipc_message'],
  ]);
  for (const [text, kind] of expected) {
    assert.equal(occurrence(ledger, text)?.kind, kind, text);
  }
  assert.ok(ledger.occurrences.some((item) => item.kind === 'format_locale'));
});

test('service tool IPC messages are model-facing while sibling service messages stay pending', () => {
  const root = fixture();
  write(root, 'services/tools/builtin/x-tool.js', `
    function execute() { return { content: 'Worktree select failed.' }; }
  `);
  write(root, 'services/x-service.js', `
    function execute() { return { message: 'Could not open it.' }; }
  `);

  const ledger = scan(root);
  assert.equal(occurrence(ledger, 'Worktree select failed.')?.disposition, 'excluded:model');
  assert.equal(occurrence(ledger, 'Could not open it.')?.disposition, 'pending');
});

test('a jennyI18n tag argument, guarded or bare, exempts locale formatting', () => {
  const root = fixture();
  write(root, 'renderer/format.js', `
    date.toLocaleDateString(globalThis.jennyI18n?.tag?.(), { month: 'short' });
    count.toLocaleString(jennyI18n.tag());
    new Intl.NumberFormat(globalThis.jennyI18n?.tag?.()).format(count);
    other.toLocaleString('en-US');
    time.toLocaleTimeString([], { hour: 'numeric' });
  `);
  const ledger = scan(root);
  const rows = ledger.occurrences.filter((item) => item.kind === 'format_locale');
  assert.equal(rows.length, 2);
  assert.ok(rows.some((item) => /en-US/.test(item.text)));
  assert.ok(rows.some((item) => /toLocaleTimeString\(\[\]/.test(item.text)));
});

test('glyph-only HTML text is excluded and a marker on it is an error', () => {
  const root = fixture();
  write(root, 'index.html', `<!doctype html><html><body>
    <button><span>&minus;</span><span>Minimize window</span></button>
  </body></html>
`);
  const ledger = scan(root);
  assert.equal(occurrence(ledger, '−')?.disposition, 'excluded:glyph');
  assert.equal(occurrence(ledger, 'Minimize window')?.disposition, 'pending');
  write(root, 'index.html', `<!doctype html><html><body><b data-i18n="titlebar.glyph">&times;</b></body></html>
`);
  const result = run(root, 'scan');
  assert.match(result.stdout + result.stderr, /glyph-only text node/);
});

test('thrown invariant messages are excluded prose, not pending copy', () => {
  const root = fixture();
  write(root, 'renderer/invariant.js', `
    function create(options) {
      if (!options) throw new Error('create requires options.state');
      if (!options.dom) throw new TypeError('create requires a dom host');
      return 'Nothing to show yet';
    }
  `);
  const ledger = scan(root);
  assert.equal(occurrence(ledger, 'create requires options.state')?.disposition, 'excluded:invariant');
  assert.equal(occurrence(ledger, 'create requires a dom host')?.disposition, 'excluded:invariant');
  assert.equal(occurrence(ledger, 'Nothing to show yet')?.disposition, 'pending');
});

test('presentation Error callees stay display sinks while invariants stay excluded', () => {
  const root = fixture();
  write(root, 'renderer/error-sinks.js', `
    showError('Could not save that preference.', {
      title: jt('settings.editor.settingNotSavedTitle', 'Setting not saved'),
    });
    renderError('Could not render this view.');
    displayError('Could not display this result.');
    notifyError('Could not notify this user.');
    toastError('Could not show this toast.');
    reportError('Could not report this problem.');
    presentError('Could not present this problem.');
    setError('Could not set this status.');
    pushError('Could not add this problem.');
    announceError('Could not announce this problem.');
    assertReady('state must be ready');
    invariantState('state must remain valid');
    new LifecycleError('lifecycle requires state');
  `);

  const ledger = scan(root);
  for (const text of [
    'Could not save that preference.',
    'Could not render this view.',
    'Could not display this result.',
    'Could not notify this user.',
    'Could not show this toast.',
    'Could not report this problem.',
    'Could not present this problem.',
    'Could not set this status.',
    'Could not add this problem.',
    'Could not announce this problem.',
  ]) {
    assert.equal(occurrence(ledger, text)?.disposition, 'pending', text);
  }
  for (const text of ['state must be ready', 'state must remain valid', 'lifecycle requires state']) {
    assert.equal(occurrence(ledger, text)?.disposition, 'excluded:invariant', text);
  }
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'locales/en.json'), 'utf8'));
  assert.equal(catalog['settings.editor.settingNotSavedTitle'], 'Setting not saved');
});

test('comparison operands are excluded prose, including switch cases and identity helpers', () => {
  const root = fixture();
  write(root, 'renderer/comparisons.js', `
    const isPluginSession = title === 'New Plugin Session';
    const isStarted = status !== 'not started';
    switch (mode) { case 'Auto run': break; }
    const expanded = labels.includes('Show less');
    const readable = label.startsWith('Reads files');
    const found = label.indexOf('History entry');
  `);

  const ledger = scan(root);
  for (const text of [
    'New Plugin Session', 'not started', 'Auto run', 'Show less', 'Reads files', 'History entry',
  ]) {
    assert.equal(occurrence(ledger, text)?.disposition, 'excluded:comparison', text);
  }
});

test('partial markup prose is split into display attributes and stripped text', () => {
  const root = fixture();
  write(root, 'renderer/fragments.js', `
    const titleFragment = 'title="No commits yet">';
    const closingFragment = '</strong>. Owns its controls.</p>';
    const mixedFragment = 'tabindex="-1" aria-label="Runtime health" data-health-tone="';
    const classFragment = 'class="a b"';
  `);

  const ledger = scan(root);
  assert.equal(occurrence(ledger, 'No commits yet')?.disposition, 'pending');
  assert.equal(occurrence(ledger, 'No commits yet')?.via, 'html_attr');
  assert.equal(occurrence(ledger, '. Owns its controls.')?.disposition, 'pending');
  assert.equal(occurrence(ledger, 'Runtime health')?.disposition, 'pending');
  assert.equal(occurrence(ledger, 'Runtime health')?.via, 'html_attr');
  assert.equal(occurrence(ledger, 'title="No commits yet">'), undefined);
  assert.equal(occurrence(ledger, '</strong>. Owns its controls.</p>'), undefined);
  assert.equal(occurrence(ledger, 'class="a b"'), undefined);
});

test('error and log callees exclude direct and concatenated developer fragments', () => {
  const root = fixture();
  write(root, 'renderer/log-fragments.js', `
    console.warn('dispose threw:', err);
    console.debug('candidate reported status ' + status);
    warnLifecycle('stream handler ' + 'reported terminal status', state);
    assertReady('state must be ready ' + actual);
    throw new LifecycleError('createStreamHandlerLifecycle requires ' + 'options.state');
  `);

  const ledger = scan(root);
  for (const text of ['dispose threw:', 'candidate reported status', 'stream handler', 'reported terminal status']) {
    assert.equal(occurrence(ledger, text)?.disposition, 'excluded:log', text);
  }
  for (const text of ['state must be ready', 'createStreamHandlerLifecycle requires', 'options.state']) {
    assert.equal(occurrence(ledger, text)?.disposition, 'excluded:invariant', text);
  }
});

test('lowercase phrases are prose except in DOM class-list contexts', () => {
  const root = fixture();
  write(root, 'renderer/class-lists.js', `
    const owner = isMine ? 'by you' : 'by others';
    node.className = 'a b';
  `);

  const ledger = scan(root);
  assert.equal(occurrence(ledger, 'by you')?.disposition, 'pending');
  assert.equal(occurrence(ledger, 'by others')?.disposition, 'pending');
  assert.equal(occurrence(ledger, 'a b'), undefined);
});

test('records literal, identifier, concat, conditional, array, and template vias', () => {
  const root = fixture();
  write(root, 'renderer/vias.js', `
    node.textContent = 'Literal visible copy';
    const saved = 'Identifier visible copy';
    node.innerText = saved;
    node.textContent = 'Concat first words' + 'Concat second words';
    node.textContent = ready ? 'Conditional ready words' : 'Conditional waiting words';
    const config = { buttons: ['Array accept words', 'Array cancel words'] };
    node.textContent = \`Template visible copy \${name}\`;
  `);
  const ledger = scan(root);
  const expected = new Map([
    ['Literal visible copy', 'literal'],
    ['Identifier visible copy', 'identifier'],
    ['Concat first words', 'concat'],
    ['Concat second words', 'concat'],
    ['Conditional ready words', 'conditional'],
    ['Conditional waiting words', 'conditional'],
    ['Array accept words', 'array'],
    ['Array cancel words', 'array'],
    ['Template visible copy {expr}', 'template'],
  ]);
  for (const [text, via] of expected) {
    assert.equal(occurrence(ledger, text)?.via, via, text);
  }
});

test('prose catch-all records returned, array-pushed, and quoted HTML copy without noise', () => {
  const root = fixture();
  write(root, 'renderer/prose.js', `
    function status(name) { return \`Queued sync for \${name}\`; }
    const rows = [];
    rows.push('Personality and notes');
    const markup = '<button title="Retry local engine">Restart Jenny engine</button>';
    const selector = document.querySelector('.menu item');
    const url = open('https://example.test/help center');
    const translated = jt('status.ready', 'Already migrated prose');
    const chord = 'Ctrl+Shift+O';
  `);

  const ledger = scan(root);
  assert.equal(occurrence(ledger, 'Queued sync for {expr}')?.kind, 'prose');
  assert.equal(occurrence(ledger, 'Queued sync for {expr}')?.via, 'return');
  assert.equal(occurrence(ledger, 'Personality and notes')?.kind, 'prose');
  assert.equal(occurrence(ledger, 'Personality and notes')?.via, 'array');
  assert.equal(occurrence(ledger, 'Restart Jenny engine')?.kind, 'prose');
  assert.equal(occurrence(ledger, 'Retry local engine')?.kind, 'prose');
  assert.equal(
    occurrence(ledger, '<button title="Retry local engine">Restart Jenny engine</button>'),
    undefined
  );
  assert.equal(
    ledger.occurrences.find((item) => item.kind === 'prose' && item.text === '.menu item'),
    undefined
  );
  assert.equal(occurrence(ledger, 'https://example.test/help center'), undefined);
  assert.equal(occurrence(ledger, 'Ctrl+Shift+O')?.disposition, 'excluded:chord');
  assert.equal(
    ledger.occurrences.filter((item) => item.text === 'Already migrated prose').length,
    1,
    'a translation default must not be emitted again as prose'
  );
  assert.equal(occurrence(ledger, 'Already migrated prose')?.disposition, 'migrated');
});

test('innerHTML scanning ignores quoted attribute scaffolding between translated values', () => {
  const root = fixture();
  write(root, 'renderer/markup.js', `
    node.innerHTML = '<button title="' + jt('button.title', 'Button title')
      + '" aria-label="' + jt('button.label', 'Button label') + '">Open</button>';
  `);

  const ledger = scan(root);
  assert.equal(occurrence(ledger, '" aria-label="'), undefined);
  assert.equal(occurrence(ledger, 'Button title')?.disposition, 'migrated');
  assert.equal(occurrence(ledger, 'Button label')?.disposition, 'migrated');
});

test('applies exclusions by role and keeps a lowercase visible word pending', () => {
  const root = fixture();
  write(root, 'renderer/exclusions.js', `
    console.warn('Diagnostic only words', { message: 'Nested diagnostic words' });
    node.textContent = 'CMP-UI-1001';
    node.className = 'identitytoken';
    const wire = { status: 'waitingstate' };
    const visibleStatus = { status: 'Ready to send' };
    node.textContent = 'Jenny';
    node.textContent = '---';
    const visible = { label: 'continue' };
  `);
  write(root, 'renderer/tools/tool-copy.js', `
    const tool = { description: 'Model only instructions' };
  `);
  write(root, 'renderer/frames/frame.js', `node.textContent = 'Frame bootstrap words';\n`);
  write(root, 'tests/ignored.test.js', `node.textContent = 'Test fixture words';\n`);
  write(root, 'services/backend/generated-copy.js', `node.textContent = 'Generated file words';\n`);

  const ledger = scan(root);
  const expected = new Map([
    ['Diagnostic only words', 'excluded:log'],
    ['CMP-UI-1001', 'excluded:code'],
    ['identitytoken', 'excluded:dom_identity'],
    ['waitingstate', 'excluded:wire'],
    ['Ready to send', 'pending'],
    ['Model only instructions', 'excluded:model_facing'],
    ['Jenny', 'excluded:proper_noun'],
    ['---', 'excluded:no_letters'],
    ['Frame bootstrap words', 'excluded:frames'],
    ['continue', 'pending'],
  ]);
  for (const [text, disposition] of expected) {
    assert.equal(occurrence(ledger, text)?.disposition, disposition, text);
  }
  assert.equal(occurrence(ledger, 'Ready to send')?.kind, 'config_copy');
  assert.equal(occurrence(ledger, 'Nested diagnostic words')?.disposition, 'excluded:log');
  assert.equal(
    ledger.occurrences.filter((item) => item.text === 'Nested diagnostic words').length,
    1,
    'the whole log subtree must stay excluded without a config-copy duplicate'
  );
  assert.equal(occurrence(ledger, 'Test fixture words'), undefined);
  assert.equal(occurrence(ledger, 'Generated file words'), undefined);
});

test('services IPC payloads exclude wire tokens but keep user-facing messages pending', () => {
  const root = fixture();
  write(root, 'services/ipc.js', `
    reject({ reason: 'unsafe_path' });
    resolve({ message: 'No workspace root is configured.' });
  `);

  const ledger = scan(root);
  assert.equal(occurrence(ledger, 'unsafe_path')?.disposition, 'excluded:wire');
  assert.equal(occurrence(ledger, 'unsafe_path')?.kind, 'ipc_message');
  assert.equal(occurrence(ledger, 'No workspace root is configured.')?.disposition, 'pending');
  assert.equal(occurrence(ledger, 'No workspace root is configured.')?.kind, 'ipc_message');
});

test('recognizes migrated calls and extracts singular and plural catalogs', () => {
  const root = fixture();
  write(root, 'renderer/migrated.js', `
    node.textContent = jt('shell.ready', 'Ready now');
    node.textContent = jennyI18n.t('shell.close', 'Close window');
    jt('shell.concat', 'Joined ' + 'default');
    jtn('files.count', count, {}, 'One {count} file', '{count} files');
  `);
  const ledger = scan(root);
  assert.equal(occurrence(ledger, 'Ready now').disposition, 'migrated');
  assert.equal(occurrence(ledger, 'Close window').disposition, 'migrated');
  assert.equal(occurrence(ledger, 'One {count} file').disposition, 'migrated');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'locales/en.json'), 'utf8'));
  assert.deepEqual(catalog, {
    'files.count#one': 'One {count} file',
    'files.count#other': '{count} files',
    'shell.close': 'Close window',
    'shell.concat': 'Joined default',
    'shell.ready': 'Ready now',
  });
});

test('registers translation calls nested in params and suppressed log subtrees', () => {
  const root = fixture();
  write(root, 'renderer/nested-translations.js', `
    jt('plugins.consent.summary', 'Consent: {containment}', {
      containment: model.containment
        || jt('plugins.consent.defaultContainment', 'Default containment'),
      archived: jtn(
        'uninstall.archive.itemCount',
        count,
        {},
        'One archived item',
        '{count} archived items'
      ),
    });
    console.warn(jt('diagnostics.localizedWarning', 'Localized warning'));
  `);
  write(root, 'services/nested-translations.js', `
    t('service.outer', 'Outer {value}', {
      value: t('service.inner', 'Inner value'),
    });
  `);

  scan(root);
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'locales/en.json'), 'utf8'));
  assert.equal(catalog['plugins.consent.defaultContainment'], 'Default containment');
  assert.equal(catalog['uninstall.archive.itemCount#one'], 'One archived item');
  assert.equal(catalog['uninstall.archive.itemCount#other'], '{count} archived items');
  assert.equal(catalog['diagnostics.localizedWarning'], 'Localized warning');
  assert.equal(catalog['service.inner'], 'Inner value');
});

test('recognizes main-process translator calls and rejects dynamic service keys', () => {
  const root = fixture();
  write(root, 'services/translated.js', `
    const { t } = createI18nMain();
    const translator = createI18nMain();
    t('x.y', 'Hello {name}', { name });
    i18n.t('x.member', 'Member default');
    i18nMain.t('x.main', 'Main default');
    translator.t('x.derived', 'Derived default');
    t(dynamicKey, 'Dynamic key default');
  `);

  const result = run(root, 'scan');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /services\/translated\.js:7:.*key.*plain string literal/i);
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'docs/i18n/STRING_LEDGER.json'), 'utf8'));
  assert.equal(occurrence(ledger, 'Hello {name}')?.disposition, 'migrated');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'locales/en.json'), 'utf8'));
  assert.equal(catalog['x.y'], 'Hello {name}');
  assert.equal(catalog['x.member'], 'Member default');
  assert.equal(catalog['x.main'], 'Main default');
  assert.equal(catalog['x.derived'], 'Derived default');
});

test('named remainders match exact fixture file and text and render their summary', () => {
  const root = fixture();
  write(root, 'renderer/remainder.js', `node.textContent = 'Persisted default title';\n`);
  write(root, 'scripts/i18n/remainders.json', `${JSON.stringify([{
    name: 'fixture-title',
    file: 'renderer/remainder.js',
    text: 'Persisted default title',
    reason: 'translated at display time',
  }], null, 2)}\n`);

  const ledger = scan(root);
  assert.equal(occurrence(ledger, 'Persisted default title')?.disposition, 'remainder:fixture-title');
  const markdown = fs.readFileSync(path.join(root, 'docs/i18n/STRING_LEDGER.md'), 'utf8');
  assert.match(markdown, /\| fixture-title \| 1 \| translated at display time \|/);
});

test('check fails when a named remainder entry is stale', () => {
  const root = fixture();
  write(root, 'scripts/i18n/remainders.json', `${JSON.stringify([{
    name: 'stale-title',
    file: 'renderer/missing.js',
    text: 'Missing title',
    reason: 'fixture stale entry',
  }], null, 2)}\n`);

  const scanResult = run(root, 'scan', '--write-baseline');
  assert.equal(scanResult.status, 2, scanResult.stdout + scanResult.stderr);
  const checkResult = run(root, 'check');
  assert.equal(checkResult.status, 1, checkResult.stdout + checkResult.stderr);
  assert.match(checkResult.stdout, /stale named remainder.*stale-title/i);
});

test('reports dynamic translation keys and defaults through the scanner API', () => {
  const errors = [];
  scanJavaScript({
    source: [
      "jt(dynamicKey, 'Static default');",
      "jt('review.new', 'Never translated ' + userName);",
      "jennyI18n.t('template.default', `Hello ${userName}`);",
      "jennyI18n.tn('plural.default', count, {}, 'One item', `${count} items`);",
    ].join('\n'),
    file: 'renderer/dynamic.js',
    addCatalog() {},
    errors,
  });

  assert.equal(errors.length, 4);
  assert.match(errors[0], /^renderer\/dynamic\.js:1:.*key.*plain string literal/i);
  assert.match(errors[1], /^renderer\/dynamic\.js:2:.*default.*static string/i);
  assert.match(errors[2], /^renderer\/dynamic\.js:3:.*template.*expression/i);
  assert.match(errors[3], /^renderer\/dynamic\.js:4:.*template.*expression/i);
});

test('dynamic translation scanner errors fail scan and check end to end', () => {
  const root = fixture();
  write(root, 'renderer/dynamic.js', "jt(`dynamic.${name}`, 'Visible default');\n");

  const scanResult = run(root, 'scan', '--write-baseline');
  assert.equal(scanResult.status, 2, scanResult.stdout + scanResult.stderr);
  assert.match(scanResult.stderr, /renderer\/dynamic\.js:1:.*key.*plain string literal/i);
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'docs/i18n/STRING_LEDGER.json'), 'utf8'));
  assert.equal(ledger.errors.length, 1);

  const checkResult = run(root, 'check');
  assert.equal(checkResult.status, 1, checkResult.stdout + checkResult.stderr);
  assert.match(checkResult.stdout, /scanner error: renderer\/dynamic\.js:1:/i);
});

test('reports conflicting translation defaults with both locations', () => {
  const root = fixture();
  write(root, 'renderer/conflict.js', `
    jt('same.key', 'First default words');
    jt('same.key', 'Second default words');
  `);
  const result = run(root, 'scan');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /conflicting default.*renderer\/conflict\.js:1.*renderer\/conflict\.js:2/i);
});

test('scans HTML text and attributes and recognizes data-i18n coverage', () => {
  const root = fixture();
  write(root, 'index.html', `
    <!doctype html><html><body>
      <p>Plain &amp; visible text</p>
      <input title="Plain input title" alt="Plain input alt">
      <button data-i18n="button.save">Save changes</button>
      <input title="Close panel" data-i18n-title="button.close">
      <script>document.body.textContent = 'Ignored script text';</script>
    </body></html>
  `);
  const ledger = scan(root);
  assert.equal(occurrence(ledger, 'Plain & visible text').kind, 'html_text');
  assert.equal(occurrence(ledger, 'Plain input title').kind, 'html_attr');
  assert.equal(occurrence(ledger, 'Save changes').disposition, 'migrated');
  assert.equal(occurrence(ledger, 'Close panel').disposition, 'migrated');
  assert.equal(occurrence(ledger, 'Ignored script text'), undefined);
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'locales/en.json'), 'utf8'));
  assert.equal(catalog['button.save'], 'Save changes');
  assert.equal(catalog['button.close'], 'Close panel');
});

test('reports data-i18n on a non-leaf element as a scanner error', () => {
  const errors = [];
  const catalog = [];
  const occurrences = scanHtml({
    source: '<div data-i18n="parent.copy">Parent <span data-i18n="child.copy">Child copy</span></div>',
    file: 'index.html',
    addCatalog(key, value) { catalog.push([key, value]); },
    errors,
  });

  assert.deepEqual(errors, ['index.html:1: non-leaf data-i18n marker "parent.copy"']);
  assert.equal(occurrence({ occurrences }, 'Parent')?.disposition, 'pending');
  assert.equal(occurrence({ occurrences }, 'Child copy')?.disposition, 'migrated');
  assert.deepEqual(catalog, [['child.copy', 'Child copy']]);
});

test('occurrence ids survive unrelated line shifts', () => {
  const root = fixture();
  const target = 'Stable occurrence words';
  write(root, 'renderer/stable.js', `node.textContent = '${target}';\n`);
  const before = occurrence(scan(root), target).id;
  write(root, 'renderer/stable.js', `\n\nnode.textContent = '${target}';\n`);
  const after = occurrence(scan(root), target).id;
  assert.equal(after, before);
});

test('prose occurrence ids survive unrelated line shifts', () => {
  const root = fixture();
  const target = 'Stable returned prose';
  write(root, 'renderer/stable-prose.js', `function label() { return '${target}'; }\n`);
  const before = occurrence(scan(root), target);
  write(root, 'renderer/stable-prose.js', `\n\nfunction label() { return '${target}'; }\n`);
  const after = occurrence(scan(root), target);
  assert.equal(before.kind, 'prose');
  assert.equal(after.id, before.id);
});

test('occurrence identity hashes the full normalized text', () => {
  const sharedPrefix = 'a'.repeat(117);
  const first = `${sharedPrefix}${'b'.repeat(83)}`;
  const second = `${sharedPrefix}${'c'.repeat(83)}`;
  function build(text) {
    return buildArtifacts([{
      file: 'renderer/long.js', kind: 'dom_text', text, start: 0, line: 1, via: 'literal', disposition: 'pending',
    }], new Map(), []).occurrences[0];
  }

  const firstOccurrence = build(first);
  const secondOccurrence = build(second);
  assert.equal(firstOccurrence.text, first);
  assert.equal(secondOccurrence.text, second);
  assert.notEqual(firstOccurrence.id, secondOccurrence.id);
});

test('ordinal comparator uses locale-independent code-unit order', () => {
  assert.equal(typeof compareOrdinal, 'function');
  assert.deepEqual(['a', 'B', '_'].sort(compareOrdinal), ['B', '_', 'a']);
});

test('check detects drift, new pending ids, stale baseline ids, then passes', () => {
  const root = fixture();
  write(root, 'renderer/policy.js', `node.textContent = 'Original allowed words';\n`);
  assert.equal(run(root, 'scan', '--write-baseline').status, 0);
  assert.equal(run(root, 'check').status, 0);

  fs.appendFileSync(path.join(root, 'docs/i18n/STRING_LEDGER.md'), 'drift\n');
  let result = run(root, 'check');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /run `node scripts\/i18n\/ledger\.js scan`/);

  run(root, 'scan');
  write(root, 'renderer/policy.js', `
    node.textContent = 'Original allowed words';
    node.textContent = 'Brand new untranslated words';
  `);
  result = run(root, 'check');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /new untranslated string.*Brand new untranslated words/i);

  write(root, 'renderer/policy.js', `node.textContent = 'Replacement visible words';\n`);
  run(root, 'scan');
  result = run(root, 'check');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /remove from baseline; it was migrated or deleted/i);

  assert.equal(run(root, 'scan', '--write-baseline').status, 0);
  assert.equal(run(root, 'check').status, 0);
});

test('interpolated templates with one static prose word are pending', () => {
  const root = fixture();
  write(root, 'renderer/interpolated-prose.js', `
    const approval = \`Approve \${displayToolName}?\`;
    const section = \`Section \${index + 1}\`;
    const indentation = \`Spaces: \${tabSize}\`;
  `);

  const ledger = scan(root);
  for (const text of ['Approve {expr}?', 'Section {expr}', 'Spaces: {expr}']) {
    assert.equal(occurrence(ledger, text)?.disposition, 'pending', text);
  }
});

test('interpolated templates require a free-standing static word', () => {
  const root = fixture();
  const cases = [
    { text: '{expr}:error', pending: false },
    { text: 'user-question-{expr}', pending: false },
    { text: 'calMonthPop-{expr}', pending: false },
    { text: 'rgba(180, 100, 255, {expr})', pending: false },
    { text: 'file-diff-{expr}-{expr}-body', pending: false },
    { text: '{expr}|det:{expr}', pending: false },
    { text: 'shell.companion:delete:{expr}', pending: false },
    { text: 'renderer/frames/monaco-worker-bootstrap.js{expr}', pending: false },
    { text: '```mermaid {expr} ```', pending: false },
    { text: 'html-artifact-frame-{expr}-{expr}', pending: false },
    { text: 'Thinking… ({expr} chunks)', pending: true },
    { text: '({expr} selected)', pending: true },
    { text: '(lines {expr}-{expr})', pending: true },
    { text: 'Attachments: {expr}', pending: true },
    { text: '{expr} finished', pending: true },
    { text: '{expr} steps{expr}', pending: true },
    { text: 'Approve {expr}?', pending: true },
    { text: 'Section {expr}', pending: true },
    { text: 'Spaces: {expr}', pending: true },
  ];
  const templateSource = (text) => `\`${text
    .replaceAll('`', '\\`')
    .replaceAll('{expr}', '${value}')}\``;
  write(root, 'renderer/interpolated-free-standing-word.js', cases
    .map(({ text }, index) => `const example${index} = ${templateSource(text)};`)
    .join('\n'));

  const ledger = scan(root);
  for (const { text, pending } of cases) {
    const hasPending = ledger.occurrences.some(
      (item) => item.text === text && item.disposition === 'pending'
    );
    assert.equal(hasPending, pending, text);
  }
});

test('translation parameter literals, templates, and fallbacks remain visible to prose scanning', () => {
  const root = fixture();
  write(root, 'renderer/translation-params.js', `
    jt('ide.location', 'Open {location}', {
      location: 'repository root',
      destination: \`Folder \${folderName}\`,
      fallback: supplied || 'the workspace root',
      target: selectedTarget || 'a file',
      status: 'not available',
    });
  `);
  write(root, 'services/translation-params.js', `
    t('main.location', 'Open {location}', { location: 'service fallback words' });
  `);

  const ledger = scan(root);
  for (const text of ['repository root', 'Folder {expr}', 'the workspace root', 'a file']) {
    assert.equal(occurrence(ledger, text)?.disposition, 'pending', text);
  }
  assert.equal(occurrence(ledger, 'not available')?.disposition, 'excluded:wire');
  assert.equal(occurrence(ledger, 'service fallback words')?.disposition, 'pending');
  assert.equal(occurrence(ledger, 'service fallback words')?.kind, 'ipc_message');
});

test('CSS detection requires CSS syntax instead of any semicolon', () => {
  const root = fixture();
  write(root, 'renderer/css-and-prose.js', `
    const timeout = 'Regular expression timed out; partial results shown.';
    const stopped = \`Replace stopped after \${filesChanged} file(s); partial changes were kept.\`;
    const declaration = 'background-color: red;';
    const selector = '.a > .b';
    const idSelector = '#workspace';
    const attrSelector = '[data-ready]';
    const variable = 'var(--surface-color)';
    const color = 'rgba(0, 0, 0, 0.5)';
    const size = 'calc(100% - 1rem)';
  `);

  const ledger = scan(root);
  assert.equal(occurrence(ledger, 'Regular expression timed out; partial results shown.')?.disposition, 'pending');
  assert.equal(
    occurrence(ledger, 'Replace stopped after {expr} file(s); partial changes were kept.')?.disposition,
    'pending'
  );
  for (const text of [
    'background-color: red;', '.a > .b', '#workspace', '[data-ready]',
    'var(--surface-color)', 'rgba(0, 0, 0, 0.5)', 'calc(100% - 1rem)',
  ]) {
    assert.equal(occurrence(ledger, text), undefined, text);
  }
});

test('structural partial-markup fragments do not produce prose rows', () => {
  const root = fixture();
  write(root, 'renderer/structural-fragments.js', `
    const dataLifecycle = '</div><div class="settings-note" id="dataLifecycleSettingsStatus" aria-live="polite">';
    const commitAttrs = \` class="ide-scm-card ide-scm-card--clickable" role="button" tabindex="0"\`;
    const recoveryClass = 'class="inv-error-action chat-error-card-details-action';
    const dynamicOnly = \`<span class="value">\${label}</span>\`;
  `);

  const ledger = scan(root);
  assert.deepEqual(
    ledger.occurrences.filter((item) => item.file === 'renderer/structural-fragments.js'),
    []
  );
});

test('all-caps hint-table strings are excluded comparison vocabulary', () => {
  const root = fixture();
  write(root, 'renderer/hint-table.js', `
    const DOCUMENT_HINTS = [{
      kind: 'review',
      headings: ['scope of review', 'issues found', 'what looks good'],
    }];
    const matches = DOCUMENT_HINTS[0].headings.includes(candidate);
  `);

  const ledger = scan(root);
  for (const text of ['review', 'scope of review', 'issues found', 'what looks good']) {
    assert.equal(occurrence(ledger, text)?.disposition, 'excluded:comparison', text);
  }
});

test('punctuated one-word service messages stay pending while wire tokens remain excluded', () => {
  const root = fixture();
  write(root, 'services/one-word-messages.js', `
    function deniedSentence() { return { message: 'Denied.' }; }
    function deniedToken() { return { message: 'denied' }; }
  `);

  const ledger = scan(root);
  assert.equal(occurrence(ledger, 'Denied.')?.disposition, 'pending');
  assert.equal(occurrence(ledger, 'Denied.')?.kind, 'ipc_message');
  assert.equal(occurrence(ledger, 'denied')?.disposition, 'excluded:wire');
});

test('scan output is deterministic and pseudolocale preserves parameters', () => {
  const root = fixture();
  write(root, 'renderer/catalog.js', `jt('hello.user', 'Hello {name}');\n`);
  assert.equal(run(root, 'scan', '--write-baseline').status, 0);
  const outputPaths = [
    'docs/i18n/STRING_LEDGER.json',
    'docs/i18n/STRING_LEDGER.md',
    'docs/i18n/string_ledger_baseline.json',
    'locales/en.json',
    'locales/qps-ploc.json',
  ];
  const before = outputPaths.map((item) => fs.readFileSync(path.join(root, item)));
  assert.equal(run(root, 'scan', '--write-baseline').status, 0);
  const after = outputPaths.map((item) => fs.readFileSync(path.join(root, item)));
  after.forEach((bytes, index) => assert.deepEqual(bytes, before[index], outputPaths[index]));
  const pseudo = JSON.parse(fs.readFileSync(path.join(root, 'locales/qps-ploc.json'), 'utf8'));
  assert.match(pseudo['hello.user'], /^\[Héllö \{name\} ~+\]$/);
});

test('security policies cannot enter translation catalogs', () => {
  const root = fixture();
  write(root, 'renderer/policy.js', `jt('unsafe.policy', "default-src 'none'; base-uri 'none'");`);
  const result = run(root, 'scan');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /security policies must be code constants/);
});

test('security policy constants are excluded from translatable prose', () => {
  const root = fixture();
  const policy = "default-src 'none'; base-uri 'none'";
  write(root, 'renderer/policy.js', `const CSP = ${JSON.stringify(policy)}; node.textContent = CSP;`);
  assert.equal(occurrence(scan(root), policy)?.disposition, 'excluded:code');
});
