'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const GUIDE_DIR = path.join(__dirname, '..', 'config', 'app-guide');
const INDEX_PATH = path.join(GUIDE_DIR, 'index.json');
const ID_PATTERN = /^[a-z][a-z0-9-]{1,48}$/;
const MIN_CHARS = 1500;
const MAX_CHARS = 16000;
const MIN_KEYWORDS = 6;
const MAX_KEYWORDS = 16;
// Printable ASCII plus newline only (no tabs, no CR, no smart punctuation).
const NON_PRINTABLE_ASCII = /[^\x20-\x7E\n]/;

function readIndex() {
  const raw = fs.readFileSync(INDEX_PATH, 'utf8');
  return { raw, index: JSON.parse(raw) };
}

function readPage(page) {
  return fs.readFileSync(path.join(GUIDE_DIR, page.path), 'utf8');
}

test('the index parses and has the expected shape', () => {
  const { index } = readIndex();
  assert.strictEqual(index.schema_version, 1);
  assert.ok(Array.isArray(index.pages), 'pages is an array');
  assert.ok(index.pages.length > 0, 'at least one page');
  for (const page of index.pages) {
    assert.deepStrictEqual(
      Object.keys(page).sort(),
      ['id', 'keywords', 'path', 'summary', 'title'],
      `page ${page.id} has exactly the documented fields`
    );
    assert.strictEqual(typeof page.title, 'string');
    assert.ok(page.title.trim().length > 0, `page ${page.id} has a title`);
    assert.strictEqual(typeof page.summary, 'string');
    assert.ok(page.summary.trim().length > 0, `page ${page.id} has a summary`);
  }
});

test('page ids are unique and well formed, and paths follow the ids', () => {
  const { index } = readIndex();
  const seen = new Set();
  for (const page of index.pages) {
    assert.match(page.id, ID_PATTERN, `id ${page.id} is kebab-case`);
    assert.ok(!seen.has(page.id), `id ${page.id} is unique`);
    seen.add(page.id);
    assert.strictEqual(page.path, `${page.id}.md`, `path for ${page.id}`);
  }
});

test('every indexed page exists and every markdown file is indexed exactly once', () => {
  const { index } = readIndex();
  const indexed = index.pages.map((page) => page.path);
  for (const rel of indexed) {
    assert.ok(fs.existsSync(path.join(GUIDE_DIR, rel)), `${rel} exists`);
  }
  assert.strictEqual(new Set(indexed).size, indexed.length, 'no path is indexed twice');
  const onDisk = fs.readdirSync(GUIDE_DIR).filter((name) => name.endsWith('.md')).sort();
  assert.deepStrictEqual(onDisk, [...indexed].sort(), 'the folder and the index list the same pages');
});

test('page titles match their first heading', () => {
  const { index } = readIndex();
  for (const page of index.pages) {
    const firstLine = readPage(page).split('\n', 1)[0];
    assert.strictEqual(firstLine, `# ${page.title}`, `title for ${page.id}`);
  }
});

test('page sizes stay within the read limit', () => {
  const { index } = readIndex();
  for (const page of index.pages) {
    const length = readPage(page).length;
    assert.ok(length >= MIN_CHARS, `${page.id} has ${length} characters, at least ${MIN_CHARS}`);
    assert.ok(length <= MAX_CHARS, `${page.id} has ${length} characters, at most ${MAX_CHARS}`);
  }
});

test('keywords are 6 to 16 distinct lowercase strings', () => {
  const { index } = readIndex();
  for (const page of index.pages) {
    assert.ok(Array.isArray(page.keywords), `${page.id} keywords is an array`);
    assert.ok(
      page.keywords.length >= MIN_KEYWORDS && page.keywords.length <= MAX_KEYWORDS,
      `${page.id} has ${page.keywords.length} keywords`
    );
    for (const keyword of page.keywords) {
      assert.strictEqual(typeof keyword, 'string', `${page.id} keyword type`);
      assert.ok(keyword.length > 0, `${page.id} has no empty keyword`);
      assert.strictEqual(keyword, keyword.toLowerCase(), `${page.id} keyword ${keyword} is lowercase`);
    }
    assert.strictEqual(new Set(page.keywords).size, page.keywords.length, `${page.id} keywords are distinct`);
  }
});

test('files use LF endings and printable ASCII only', () => {
  const { raw, index } = readIndex();
  const files = [{ name: 'index.json', text: raw }];
  for (const page of index.pages) {
    files.push({ name: page.path, text: readPage(page) });
  }
  for (const file of files) {
    assert.ok(!file.text.includes('\r'), `${file.name} has no carriage returns`);
    const bad = NON_PRINTABLE_ASCII.exec(file.text);
    assert.strictEqual(bad, null, `${file.name} has a non-ASCII or control character at ${bad ? bad.index : -1}`);
    assert.ok(file.text.endsWith('\n'), `${file.name} ends with a newline`);
  }
});

test('pages are plain markdown: no front matter, HTML, images or external links', () => {
  const { index } = readIndex();
  for (const page of index.pages) {
    const text = readPage(page);
    assert.ok(!text.startsWith('---'), `${page.id} has no front matter`);
    assert.ok(!/<\/?[a-zA-Z][^>]*>/.test(text), `${page.id} has no HTML tags`);
    assert.ok(!/!\[[^\]]*\]\(/.test(text), `${page.id} has no images`);
    assert.ok(!/https?:\/\//.test(text), `${page.id} has no external links`);
    assert.ok(/^## /m.test(text), `${page.id} has at least one section heading`);
  }
});

// The Team feature is young and still changing. This pins what the page tells users to what the app
// does, so a renamed label or a moved limit fails here and names the line of team.md to bring up to date.
function teamPage() {
  return fs.readFileSync(path.join(GUIDE_DIR, 'team.md'), 'utf8');
}

test('every quoted label on the team page is a label the app shows', () => {
  const roots = ['renderer/team', 'renderer/shell'].map((dir) => path.join(__dirname, '..', dir));
  const sources = roots.flatMap((dir) => fs.readdirSync(dir, { recursive: true })
    .filter((name) => String(name).endsWith('.js')).map((name) => fs.readFileSync(path.join(dir, String(name)), 'utf8')))
    // The page is ASCII: the app's curly apostrophe reads as a straight one there and "..." is left off.
    .join('\n').replace(/[‘’]/g, "'").replace(/…/g, '');
  const labels = [...new Set([...teamPage().matchAll(/"([^"\n]{3,80})"/g)].map((match) => match[1]))];
  assert.ok(labels.length > 0, 'the page quotes the app\'s labels');
  const gone = labels.filter((label) => !sources.includes(label));
  assert.deepStrictEqual(gone, [], 'team.md quotes labels the Team pages no longer show; update the page');
});

test('the limits on the team page are the limits in the code', () => {
  const members = require('../server/team/member-schema');
  const chat = require('../services/host/team-chat-schema').LIMITS;
  const { RETENTION_LIMITS } = require('../services/host/team-chat-retention');
  const { TRANSFER_LIMITS } = require('../server/team/transfer-manifest');
  const { PROJECT_RULES_LIMITS } = require('../server/team/project-rules-store');
  const MIB = 1024 * 1024;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const grouped = (value) => value.toLocaleString('en-US');
  const facts = [
    `at most ${words[members.LIMITS.MAX_LIVE_MEMBERS]}, who share`,
    `up to ${words[members.LIMITS.MAX_ACTIVE_DEVICES]} devices`,
    `${words[members.LIMITS.MAX_OUTSTANDING_INVITES]} outstanding invites`,
    `(1 hour, 1 day or ${members.INVITE_KINDS.new_member.maxMs / DAY_MS} days; ${members.INVITE_KINDS.new_member.defaultMs / DAY_MS} day unless changed)`,
    `up to ${grouped(chat.TEXT_MAX_CHARS)} characters with up to ${chat.ATTACHMENTS_MAX} attachments of ${chat.ATTACHMENT_MAX_BYTES / MIB} MB each`,
    `at most ${grouped(RETENTION_LIMITS.maxMessages)} messages or ${RETENTION_LIMITS.maxAgeMs / DAY_MS} days`,
    `${grouped(TRANSFER_LIMITS.maxFiles)} files per project`,
    `${TRANSFER_LIMITS.maxFileBytes / MIB} MB per file and ${TRANSFER_LIMITS.maxUploadBytes / MIB} MB per upload`,
    `A project can have ${PROJECT_RULES_LIMITS.MAX_RULES} rules.`,
  ];
  const page = teamPage();
  assert.ok(facts.every((fact) => !fact.includes('undefined') && !fact.includes('NaN')), 'every limit read from the code exists');
  for (const fact of facts) assert.ok(page.includes(fact), `team.md no longer says "${fact}"; the code changed, update the page`);
});
