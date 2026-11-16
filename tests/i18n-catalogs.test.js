'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_CLI = path.join(REPO_ROOT, 'scripts', 'i18n', 'build-catalogs.js');
const VALIDATE_CLI = path.join(REPO_ROOT, 'scripts', 'i18n', 'validate-catalogs.js');
const PASS_CLI = path.join(REPO_ROOT, 'scripts', 'i18n', 'translation-pass.js');
const { applyTranslations, computeWorklist, englishDigest } = require('../scripts/i18n/translation-pass');
const I18N_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'renderer', 'shared', 'i18n-utils.js'), 'utf8');
const createdFixtures = [];

afterEach(() => {
  for (const root of createdFixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-i18n-catalogs-'));
  createdFixtures.push(root);
  return root;
}

function writeCatalog(root, tag, strings) {
  fs.writeFileSync(
    path.join(root, `${tag}.json`),
    `${JSON.stringify({ tag, strings }, null, 2)}\n`,
    'utf8'
  );
}

function run(script, localesDir, ...args) {
  return spawnSync(process.execPath, [script, '--locales-dir', localesDir, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function validFixture() {
  const root = fixture();
  writeCatalog(root, 'en', {
    'count#one': 'One {count} item',
    'count#other': '{count} items',
    greeting: 'Hello {name}',
    plain: 'Save changes',
  });
  writeCatalog(root, 'de', {
    'count#one': 'Ein {count} Element',
    'count#other': '{count} Elemente',
    greeting: 'Hallo {name}',
    plain: 'Änderungen speichern',
  });
  return root;
}

function mutateGermanCatalog(mutate) {
  const root = validFixture();
  const target = path.join(root, 'de.json');
  const catalog = JSON.parse(fs.readFileSync(target, 'utf8'));
  mutate(catalog.strings);
  fs.writeFileSync(target, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  return root;
}

function expectValidationFailure(mutate, pattern, ...extraArgs) {
  const root = mutateGermanCatalog(mutate);
  const result = run(VALIDATE_CLI, root, '--only', 'de', ...extraArgs);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, pattern);
}

test('catalog build is byte-deterministic across repeated runs', () => {
  const root = validFixture();
  const first = run(BUILD_CLI, root);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const before = new Map(
    fs.readdirSync(root)
      .filter((name) => name.endsWith('.catalog.js'))
      .map((name) => [name, fs.readFileSync(path.join(root, name))])
  );

  const second = run(BUILD_CLI, root);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual(
    [...before.keys()],
    fs.readdirSync(root).filter((name) => name.endsWith('.catalog.js'))
  );
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes, name);
});

test('generated pseudolocale script loads through the browser i18n global', () => {
  const root = fixture();
  for (const tag of ['en', 'qps-ploc']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'locales', `${tag}.json`), path.join(root, `${tag}.json`));
  }
  const result = run(BUILD_CLI, root);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const raw = JSON.parse(fs.readFileSync(path.join(root, 'qps-ploc.json'), 'utf8'));
  const strings = raw.strings || raw;
  const context = vm.createContext({ Intl });
  vm.runInContext(I18N_SOURCE, context);
  vm.runInContext(fs.readFileSync(path.join(root, 'qps-ploc.catalog.js'), 'utf8'), context);

  assert.equal(context.jennyI18n.tag(), 'qps-ploc');
  assert.equal(
    context.jennyI18n.t('settings.about.version', 'x'),
    strings['settings.about.version']
  );
});

test('catalog build removes scripts without a matching JSON catalog', () => {
  const root = fixture();
  writeCatalog(root, 'en', { greeting: 'Hello' });
  fs.writeFileSync(path.join(root, 'orphan.catalog.js'), 'stale\n', 'utf8');

  const result = run(BUILD_CLI, root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(root, 'orphan.catalog.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'en.catalog.js')), true);
});

test('validator warns about a missing key by default (runtime falls back to English)', () => {
  // Enough keys that one gap stays above the 90% coverage floor.
  const root = fixture();
  const english = {};
  const german = {};
  for (let index = 0; index < 20; index += 1) {
    english[`label${index}`] = `Label ${index}`;
    german[`label${index}`] = `Bezeichnung ${index}`;
  }
  english.plain = 'Save changes';
  writeCatalog(root, 'en', english);
  writeCatalog(root, 'de', german);
  const result = run(VALIDATE_CLI, root, '--only', 'de');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /WARN: de\.json:plain: missing English key/);
});

test('validator fails by default when a catalog drops below the coverage floor', () => {
  expectValidationFailure(
    (strings) => { for (const key of Object.keys(strings)) delete strings[key]; },
    /de\.json:<catalog>: covers 0 of \d+ English keys; the floor is 90%/
  );
});

test('validator fails on a missing key under --strict', () => {
  expectValidationFailure((strings) => delete strings.plain, /de\.json:plain: missing English key/, '--strict');
});

test('validator fails on an extra key under --strict and only warns by default', () => {
  expectValidationFailure((strings) => { strings.extra = 'Zusätzlich'; }, /de\.json:extra: unknown key/, '--strict');
  const root = mutateGermanCatalog((strings) => { strings.extra = 'Zusätzlich'; });
  const result = run(VALIDATE_CLI, root, '--only', 'de');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /WARN: de\.json:extra: unknown key/);
});

test('validator catches a placeholder mismatch', () => {
  expectValidationFailure(
    (strings) => { strings.greeting = 'Hallo {person}'; },
    /de\.json:greeting: placeholder set .* does not match English/
  );
});

test('validator catches markup', () => {
  expectValidationFailure(
    (strings) => { strings.greeting = '<b>Hallo {name}</b>'; },
    /de\.json:greeting: markup is not allowed/
  );
});

test('validator accepts a plural variant that borrows a placeholder from another English variant', () => {
  const root = validFixture();
  for (const [tag, one] of [['en', '1 result'], ['de', '{count} Ergebnis']]) {
    const target = path.join(root, `${tag}.json`);
    const catalog = JSON.parse(fs.readFileSync(target, 'utf8'));
    catalog.strings['count#one'] = one;
    fs.writeFileSync(target, `${JSON.stringify(catalog, null, 2)}
`, 'utf8');
  }
  const result = run(VALIDATE_CLI, root, '--only', 'de');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('validator accepts angle delimiters the English source already carries but rejects added ones', () => {
  const root = validFixture();
  const englishTarget = path.join(root, 'en.json');
  const english = JSON.parse(fs.readFileSync(englishTarget, 'utf8'));
  english.strings.plain = 'Open Settings > Remote Control at wss://<name>.workers.dev';
  fs.writeFileSync(englishTarget, `${JSON.stringify(english, null, 2)}
`, 'utf8');
  const target = path.join(root, 'de.json');
  const catalog = JSON.parse(fs.readFileSync(target, 'utf8'));
  catalog.strings.plain = 'Einstellungen > Remote Control unter wss://<name>.workers.dev öffnen';
  fs.writeFileSync(target, `${JSON.stringify(catalog, null, 2)}
`, 'utf8');
  assert.equal(run(VALIDATE_CLI, root, '--only', 'de').status, 0);
  catalog.strings.plain = '<b>Einstellungen</b> > Remote Control unter wss://<name>.workers.dev öffnen';
  fs.writeFileSync(target, `${JSON.stringify(catalog, null, 2)}
`, 'utf8');
  const result = run(VALIDATE_CLI, root, '--only', 'de');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /de\.json:plain: markup is not allowed/);
});

test('validator requires placeholders every English plural variant carries and rejects empty translations', () => {
  const root = validFixture();
  for (const [tag, one, other] of [['en', '{count} item to {destination}', '{count} items to {destination}'], ['de', '{count} Element', '{count} Elemente nach {destination}']]) {
    const target = path.join(root, `${tag}.json`);
    const catalog = JSON.parse(fs.readFileSync(target, 'utf8'));
    catalog.strings['count#one'] = one;
    catalog.strings['count#other'] = other;
    fs.writeFileSync(target, `${JSON.stringify(catalog, null, 2)}
`, 'utf8');
  }
  const result = run(VALIDATE_CLI, root, '--only', 'de');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /de\.json:count#one: placeholder set/);
  expectValidationFailure((strings) => { strings.plain = '   '; }, /de\.json:plain: translation is empty/);
});

test('validator rejects a markup tag substituted for a literal angle token', () => {
  const root = validFixture();
  const englishTarget = path.join(root, 'en.json');
  const english = JSON.parse(fs.readFileSync(englishTarget, 'utf8'));
  english.strings.plain = 'Use <name> for a new file.';
  fs.writeFileSync(englishTarget, `${JSON.stringify(english, null, 2)}
`, 'utf8');
  const target = path.join(root, 'de.json');
  const catalog = JSON.parse(fs.readFileSync(target, 'utf8'));
  catalog.strings.plain = 'Nutze <img src=x onerror=alert(1)> hier.';
  fs.writeFileSync(target, `${JSON.stringify(catalog, null, 2)}
`, 'utf8');
  const result = run(VALIDATE_CLI, root, '--only', 'de');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /de\.json:plain: markup is not allowed/);
  catalog.strings.plain = 'Nutze <name> für eine neue Datei.';
  fs.writeFileSync(target, `${JSON.stringify(catalog, null, 2)}
`, 'utf8');
  assert.equal(run(VALIDATE_CLI, root, '--only', 'de').status, 0);
});

test('validator catches a wrong plural category set', () => {
  expectValidationFailure((strings) => {
    delete strings['count#other'];
    strings['count#few'] = '{count} Elemente';
  }, /de\.json:count: plural categories .* expected one, other/);
});

for (const invalid of [[], { tag: 'wrong', strings: {} }, { strings: [] }, { key: 2 }]) {
  test(`builder and validator reject the same catalog schema: ${JSON.stringify(invalid)}`, () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'en.json'), JSON.stringify(invalid));
    const built = run(BUILD_CLI, root);
    const validated = run(VALIDATE_CLI, root);
    assert.equal(built.status, 1);
    assert.equal(validated.status, 1);
    assert.match(built.stderr, /must (?:be|match)/);
    assert.match(validated.stdout + validated.stderr, /must (?:be|match)/);
  });
}

// --- translation pass: English-only feature commits, one pass before a public release ---

test('worklist lists new, reworded and missing families per language and what to prune', () => {
  const base = { 'count#one': '{count} item', 'count#other': '{count} items', gone: 'Gone', kept: 'Kept', plain: 'Save' };
  const english = { 'count#one': '{count} item', 'count#other': '{count} items', fresh: 'New', kept: 'Kept', plain: 'Save changes' };
  const worklist = computeWorklist(base, english, {
    de: { 'count#one': 'a', 'count#other': 'b', gone: 'Weg', kept: 'Behalten', plain: 'Speichern' },
    ru: { gone: 'x', kept: 'y', plain: 'z' },
  });
  assert.deepEqual(worklist.removed, ['gone']);
  assert.deepEqual(worklist.locales.de.families, ['fresh', 'plain']);
  assert.deepEqual(worklist.locales.de.unknown, ['gone']);
  assert.deepEqual(worklist.locales.ru.families, ['count', 'fresh', 'plain']);
  assert.deepEqual(worklist.locales.ru.pluralCategories, ['few', 'many', 'one', 'other']);
  assert.deepEqual(worklist.english.plain, { text: 'Save changes', previous: 'Save' });
  assert.deepEqual(worklist.english.fresh, { text: 'New' });
  assert.deepEqual(Object.keys(worklist.english), ['count#one', 'count#other', 'fresh', 'plain']);
});

test('apply replaces whole plural families, prunes dead keys and keeps the catalog order', () => {
  const english = { 'count#one': '{count} item', 'count#other': '{count} items', fresh: 'New', plain: 'Save changes', zeta: 'Z' };
  const next = applyTranslations(
    { zeta: 'Я', gone: 'x', 'count#one': 'old', 'count#other': 'old', plain: 'старое' },
    english,
    { plain: 'Сохранить', fresh: 'Новое', 'count#one': 'a', 'count#few': 'b', 'count#many': 'c', 'count#other': 'd' }
  );
  assert.deepEqual(Object.entries(next), [
    ['zeta', 'Я'], ['count#few', 'b'], ['count#many', 'c'], ['count#one', 'a'], ['count#other', 'd'],
    ['plain', 'Сохранить'], ['fresh', 'Новое'],
  ]);
  assert.throws(() => applyTranslations({}, english, { nope: 'x' }), /nope: not an English key/);
});

test('a reworded English string leaves its old translations stale, not failing, until --strict', () => {
  const root = validFixture();
  const base = path.join(root, 'base-en.snapshot');
  fs.copyFileSync(path.join(root, 'en.json'), base);
  const target = path.join(root, 'en.json');
  const english = JSON.parse(fs.readFileSync(target, 'utf8'));
  english.strings.greeting = 'Hello {name}, welcome to {place}';
  english.strings.plain = 'Save all changes';
  fs.writeFileSync(target, `${JSON.stringify(english, null, 2)}\n`, 'utf8');

  const blind = run(VALIDATE_CLI, root, '--only', 'de');
  assert.equal(blind.status, 1, blind.stdout + blind.stderr);
  const aware = run(VALIDATE_CLI, root, '--only', 'de', '--base-english', base);
  assert.equal(aware.status, 0, aware.stdout + aware.stderr);
  assert.match(aware.stderr, /WARN: de\.json:greeting: stale translation/);
  assert.doesNotMatch(aware.stderr, /de\.json:plain/);
  const strict = run(VALIDATE_CLI, root, '--only', 'de', '--base-english', base, '--strict');
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /de\.json:greeting: placeholder set/);

  // A family English did not touch is still judged in full.
  const german = JSON.parse(fs.readFileSync(path.join(root, 'de.json'), 'utf8'));
  german.strings['count#one'] = 'Ein Element {oops}';
  fs.writeFileSync(path.join(root, 'de.json'), `${JSON.stringify(german, null, 2)}\n`, 'utf8');
  const broken = run(VALIDATE_CLI, root, '--only', 'de', '--base-english', base);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /de\.json:count#one: placeholder set/);
});

function passFixture() {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'locales'));
  fs.mkdirSync(path.join(root, 'scripts', 'i18n'), { recursive: true });
  const english = { greeting: 'Hello {name}', plain: 'Save changes' };
  fs.writeFileSync(path.join(root, 'locales', 'en.json'), `${JSON.stringify(english, null, 2)}
`);
  fs.writeFileSync(path.join(root, 'locales', 'de.json'), `${JSON.stringify({ plain: 'Speichern' }, null, 2)}
`);
  fs.writeFileSync(
    path.join(root, 'scripts', 'i18n', 'translation-sync.json'),
    JSON.stringify({ englishCommit: 'unused', englishSha256: englishDigest(english) })
  );
  return root;
}

function runPass(root, ...args) {
  return spawnSync(process.execPath, [PASS_CLI, ...args, '--root', root], { cwd: REPO_ROOT, encoding: 'utf8' });
}

test('pass check fails once English moves, and apply refuses a malformed translation', () => {
  const root = passFixture();
  assert.equal(runPass(root, 'check').status, 0);

  const answers = path.join(root, 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ greeting: 'Hallo {person}' }));
  const baseFile = path.join(root, 'locales', 'en.json');
  const refused = runPass(root, 'apply', '--tag', 'de', '--from', answers, '--base-file', baseFile);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /de\.json:greeting: placeholder set/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'locales', 'de.json'), 'utf8')), { plain: 'Speichern' });

  fs.writeFileSync(answers, JSON.stringify({ greeting: 'Hallo {name}' }));
  const applied = runPass(root, 'apply', '--tag', 'de', '--from', answers, '--base-file', baseFile);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, 'locales', 'de.json'), 'utf8')),
    { plain: 'Speichern', greeting: 'Hallo {name}' }
  );

  fs.writeFileSync(path.join(root, 'locales', 'en.json'), JSON.stringify({ greeting: 'Hi {name}', plain: 'Save changes' }));
  const moved = runPass(root, 'check');
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /changed since the last translation pass/);
});

test('the committed sync marker names a commit and an English digest', () => {
  const marker = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'i18n', 'translation-sync.json'), 'utf8'));
  assert.match(marker.englishCommit, /^[0-9a-f]{40}$/);
  assert.match(marker.englishSha256, /^[0-9a-f]{64}$/);
});
