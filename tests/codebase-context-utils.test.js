'use strict';

// Coverage for services/backend/codebase-context-utils.js
// Uses real temporary directories + files (no git, no Electron, no jsdom) to
// exercise the bounded keyword-search grounding end-to-end.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const {
  getCodebaseContext,
  extractKeywords,
} = require('../services/backend/codebase-context-utils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jenny-codebase-ctx-${label}-`));
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

function writeFile(dir, relName, content) {
  const target = path.join(dir, relName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

// ---------------------------------------------------------------------------
// extractKeywords — pure
// ---------------------------------------------------------------------------

describe('extractKeywords', () => {
  test('drops stopwords + short tokens, keeps content words', () => {
    assert.deepEqual(extractKeywords('where is auth handled?'), ['auth']);
  });

  test('lowercases, de-dupes, and preserves identifier-ish tokens', () => {
    assert.deepEqual(
      extractKeywords('Auth auth login_session login_session token'),
      ['auth', 'login_session', 'token']
    );
  });

  test('caps the number of keywords', () => {
    const result = extractKeywords('alpha bravo charlie delta echo foxtrot golf hotel india', 3);
    assert.equal(result.length, 3);
    assert.deepEqual(result, ['alpha', 'bravo', 'charlie']);
  });

  test('returns [] for non-string / empty / all-stopword input', () => {
    assert.deepEqual(extractKeywords(null), []);
    assert.deepEqual(extractKeywords(''), []);
    assert.deepEqual(extractKeywords('is the a of'), []);
  });
});

// ---------------------------------------------------------------------------
// getCodebaseContext — input guards
// ---------------------------------------------------------------------------

describe('getCodebaseContext — guards', () => {
  test('returns null for falsy / non-string root', async () => {
    assert.equal(await getCodebaseContext(null, 'auth'), null);
    assert.equal(await getCodebaseContext('', 'auth'), null);
    assert.equal(await getCodebaseContext(123, 'auth'), null);
  });

  test('returns null when query has no usable keywords', async () => {
    const dir = makeTempDir('nokw');
    try {
      writeFile(dir, 'a.js', 'const auth = 1;\n');
      assert.equal(await getCodebaseContext(dir, 'where is it?'), null);
    } finally {
      removeTempDir(dir);
    }
  });

  test('returns null for a non-existent root', async () => {
    const missing = path.join(os.tmpdir(), 'jenny-codebase-ctx-does-not-exist-zzz');
    assert.equal(await getCodebaseContext(missing, 'auth'), null);
  });

  test('returns null when the root is a file, not a directory', async () => {
    const dir = makeTempDir('rootfile');
    try {
      const file = path.join(dir, 'plain.txt');
      fs.writeFileSync(file, 'auth\n');
      assert.equal(await getCodebaseContext(file, 'auth'), null);
    } finally {
      removeTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// getCodebaseContext — matching workspace
// ---------------------------------------------------------------------------

describe('getCodebaseContext — repo with matches', () => {
  let dir;
  let result;

  before(async () => {
    dir = makeTempDir('match');
    writeFile(dir, 'services/auth/login.js',
      'function handleLogin(req) {\n  const session = createSession(req);\n  return session;\n}\n');
    writeFile(dir, 'services/auth/session.js',
      'const SESSION_TTL = 3600;\nfunction createSession() {}\n');
    writeFile(dir, 'renderer/app.js', 'console.log("unrelated ui");\n');
    result = await getCodebaseContext(dir, 'where is auth login session handled?');
  });

  after(() => removeTempDir(dir));

  test('returns a non-null string block', () => {
    assert.equal(typeof result, 'string');
    assert.notEqual(result, null);
  });

  test('includes the grounding header + search terms', () => {
    assert.ok(result.includes('[Codebase grounding'), `header missing:\n${result}`);
    assert.ok(/Search terms:.*auth/.test(result), `search terms missing:\n${result}`);
  });

  test('cites real file:line locations with POSIX paths', () => {
    assert.ok(
      /services\/auth\/login\.js:\d+/.test(result),
      `expected services/auth/login.js:<line> in:\n${result}`
    );
    assert.ok(
      /services\/auth\/session\.js:\d+/.test(result),
      `expected services/auth/session.js:<line> in:\n${result}`
    );
  });

  test('does not cite files with no keyword match', () => {
    assert.ok(!result.includes('renderer/app.js'), `unrelated file leaked:\n${result}`);
  });

  test('returns null when no file matches the query', async () => {
    const none = await getCodebaseContext(dir, 'kubernetes orchestration mesh');
    assert.equal(none, null);
  });
});

// ---------------------------------------------------------------------------
// getCodebaseContext — excludePaths (cross-source dedupe vs active-file block)
// ---------------------------------------------------------------------------

describe('getCodebaseContext — excludePaths', () => {
  test('omits an excluded path while still emitting sibling matches', async () => {
    const dir = makeTempDir('exclude');
    try {
      // NB: avoid the path the grounding header cites as an example
      // (services/auth/login.js) so the assertion checks the Matches, not the header.
      writeFile(dir, 'services/auth/handler.js', 'function handleLogin() {}\n');
      writeFile(dir, 'services/auth/store.js', 'function createSession() {}\n');
      const out = await getCodebaseContext(dir, 'login session', {
        excludePaths: ['services/auth/handler.js'],
      });
      assert.ok(out.includes('services/auth/store.js'), `sibling match missing:\n${out}`);
      assert.ok(
        !out.includes('services/auth/handler.js'),
        `excluded active file leaked into the codebase block:\n${out}`
      );
    } finally {
      removeTempDir(dir);
    }
  });

  test('normalizes backslashes and a leading ./ in exclude entries', async () => {
    const dir = makeTempDir('exclude-norm');
    try {
      writeFile(dir, 'renderer/foo.js', 'const widget = 1; // widget\n');
      writeFile(dir, 'renderer/bar.js', 'const widget = 2; // widget\n');
      // Backslash + ./ forms must still fold to the POSIX-relative key.
      const out = await getCodebaseContext(dir, 'widget', {
        excludePaths: ['.\\renderer\\foo.js'],
      });
      assert.ok(out.includes('renderer/bar.js'), `non-excluded match missing:\n${out}`);
      assert.ok(!out.includes('renderer/foo.js'), `excluded file leaked:\n${out}`);
    } finally {
      removeTempDir(dir);
    }
  });

  test('an empty / non-array excludePaths is inert (no files dropped)', async () => {
    const dir = makeTempDir('exclude-empty');
    try {
      writeFile(dir, 'a.js', 'const widget = 1; // widget\n');
      const withEmpty = await getCodebaseContext(dir, 'widget', { excludePaths: [] });
      const withBad = await getCodebaseContext(dir, 'widget', { excludePaths: 'a.js' });
      assert.ok(withEmpty.includes('a.js'), `empty array dropped a file:\n${withEmpty}`);
      assert.ok(withBad.includes('a.js'), `non-array excludePaths dropped a file:\n${withBad}`);
    } finally {
      removeTempDir(dir);
    }
  });

  test('returns null when the only match is excluded', async () => {
    const dir = makeTempDir('exclude-only');
    try {
      writeFile(dir, 'solo.js', 'const widget = 1; // widget\n');
      const out = await getCodebaseContext(dir, 'widget', { excludePaths: ['solo.js'] });
      assert.equal(out, null, 'excluding the sole match yields no block');
    } finally {
      removeTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// getCodebaseContext — bounds + skips
// ---------------------------------------------------------------------------

describe('getCodebaseContext — bounds and skips', () => {
  test('skips node_modules / .git / dist directories', async () => {
    const dir = makeTempDir('skip');
    try {
      writeFile(dir, 'src/real.js', 'const authToken = 1;\n');
      writeFile(dir, 'node_modules/dep/index.js', 'const authToken = 2;\n');
      writeFile(dir, 'dist/bundle.js', 'const authToken = 3;\n');
      // `.git/config` is extensionless, so the TEXT_EXTENSIONS filter drops it
      // even with the directory skip removed; only a scannable file proves it.
      writeFile(dir, '.git/config', 'authToken\n');
      writeFile(dir, '.git/metadata.js', 'const authToken = 4;\n');
      const out = await getCodebaseContext(dir, 'authToken');
      assert.ok(out.includes('src/real.js'), `real file missing:\n${out}`);
      assert.ok(!out.includes('node_modules'), `node_modules leaked:\n${out}`);
      assert.ok(!out.includes('dist/bundle.js'), `dist leaked:\n${out}`);
      assert.ok(!out.includes('.git'), `.git leaked:\n${out}`);
    } finally {
      removeTempDir(dir);
    }
  });

  test('skips binary files (NUL byte)', async () => {
    const dir = makeTempDir('binary');
    try {
      // .json is in the text-extension allowlist, but a NUL byte marks it binary.
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'data', 'blob.json'),
        Buffer.from('authmarker\x00\x00more', 'binary')
      );
      writeFile(dir, 'data/plain.json', '{"authmarker": true}\n');
      const out = await getCodebaseContext(dir, 'authmarker');
      assert.ok(out.includes('data/plain.json'), `text json missing:\n${out}`);
      assert.ok(!out.includes('blob.json'), `binary json leaked:\n${out}`);
    } finally {
      removeTempDir(dir);
    }
  });

  test('honors the maxSnippets cap and notes truncation', async () => {
    const dir = makeTempDir('cap');
    try {
      for (let i = 0; i < 10; i += 1) {
        writeFile(dir, `mod/widget${i}.js`, 'const widget = 1; // widget\n');
      }
      const out = await getCodebaseContext(dir, 'widget', { maxSnippets: 3 });
      const citationLines = out.split('\n').filter((l) => /^- .+:\d+/.test(l));
      assert.equal(citationLines.length, 3, `expected exactly 3 snippets:\n${out}`);
      assert.ok(/capped|incomplete/i.test(out), `expected truncation note:\n${out}`);
    } finally {
      removeTempDir(dir);
    }
  });

  test('caps the complete truncated context block at exactly 4000 characters', async () => {
    const dir = makeTempDir('block-cap');
    try {
      for (let i = 0; i < 20; i += 1) {
        writeFile(dir, `mod/long-widget-${i}.js`, `widget ${'x'.repeat(230)}\n`);
      }
      const out = await getCodebaseContext(dir, 'widget', { maxSnippets: 20 });
      assert.equal(out.length, 4000);
      assert.ok(out.endsWith('… (codebase context truncated at 4000 chars)'));
    } finally {
      removeTempDir(dir);
    }
  });

  test('does not emit a spurious truncation note for a filename-only match', async () => {
    // Regression: a file whose NAME matches but whose CONTENT does not used to
    // be scored with empty snippets, which falsely tripped the truncation note.
    const dir = makeTempDir('pathonly');
    try {
      writeFile(dir, 'auth-helper.js', 'const unrelated = 1;\n');
      writeFile(dir, 'real.js', 'function checkAuth() {}\n');
      const out = await getCodebaseContext(dir, 'auth');
      assert.ok(out.includes('real.js'), `content match missing:\n${out}`);
      assert.ok(!out.includes('auth-helper.js'), `filename-only file should not be cited:\n${out}`);
      assert.ok(!/capped|incomplete/i.test(out), `unexpected truncation note:\n${out}`);
    } finally {
      removeTempDir(dir);
    }
  });

  test('caps snippets per file (MAX_SNIPPETS_PER_FILE)', async () => {
    const dir = makeTempDir('perfile');
    try {
      writeFile(dir, 'big.js',
        'widget a\nwidget b\nwidget c\nwidget d\nwidget e\n');
      const out = await getCodebaseContext(dir, 'widget');
      const bigLines = out.split('\n').filter((l) => l.startsWith('- big.js:'));
      assert.equal(bigLines.length, 3, `expected 3 per-file snippets max:\n${out}`);
    } finally {
      removeTempDir(dir);
    }
  });

  test('skips files larger than maxFileBytes', async () => {
    const dir = makeTempDir('big');
    try {
      writeFile(dir, 'huge.js', `// widget\n${'x'.repeat(5000)}\n`);
      writeFile(dir, 'small.js', '// widget\n');
      const out = await getCodebaseContext(dir, 'widget', { maxFileBytes: 64 });
      assert.ok(out.includes('small.js'), `small file missing:\n${out}`);
      assert.ok(!out.includes('huge.js'), `oversized file leaked:\n${out}`);
    } finally {
      removeTempDir(dir);
    }
  });

  test('does not scan name.env credential files (.env dropped from allowlist)', async () => {
    const dir = makeTempDir('dotenv');
    try {
      writeFile(dir, 'config.js', 'const apiKey = readApiKey();\n');
      // .env is no longer in the text-extension allowlist; this name.env file
      // must not be read into the grounding block even though it matches.
      writeFile(dir, 'secrets.env', 'API_KEY=super-secret-apikey-value\n');
      const out = await getCodebaseContext(dir, 'apiKey');
      assert.ok(out.includes('config.js'), `source file missing:\n${out}`);
      assert.ok(!out.includes('secrets.env'), `name.env credentials file leaked:\n${out}`);
      assert.ok(!out.includes('super-secret'), `secret value leaked into block:\n${out}`);
    } finally {
      removeTempDir(dir);
    }
  });

  test('detects a NUL byte beyond the first 4 KB (full-buffer binary sniff)', async () => {
    const dir = makeTempDir('lateNull');
    try {
      // A matching text head longer than 4 KB, then a NUL deep in the file: the
      // old 4 KB-capped sniff would miss it and leak a partial binary line.
      const head = Buffer.from(`// widget\n${'a'.repeat(8000)}\n`, 'utf8');
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'data', 'late.js'),
        Buffer.concat([head, Buffer.from([0]), Buffer.from('widget tail\n', 'utf8')])
      );
      writeFile(dir, 'data/clean.js', '// widget\n');
      const out = await getCodebaseContext(dir, 'widget');
      assert.ok(out.includes('data/clean.js'), `clean file missing:\n${out}`);
      assert.ok(!out.includes('late.js'), `late-NUL binary file leaked:\n${out}`);
    } finally {
      removeTempDir(dir);
    }
  });

  test('does not follow symlinked directories (best-effort; skipped if unsupported)', async (t) => {
    const dir = makeTempDir('symlink');
    try {
      writeFile(dir, 'inside/real.js', 'const authToken = 1;\n');
      const outsideDir = makeTempDir('symlink-target');
      try {
        writeFile(outsideDir, 'secret.js', 'const authToken = 2;\n');
        try {
          fs.symlinkSync(outsideDir, path.join(dir, 'linked'), 'dir');
        } catch (error) {
          t.skip(`symlink creation unsupported in this environment: ${error.code || error.message}`);
          return;
        }
        const out = await getCodebaseContext(dir, 'authToken');
        assert.ok(out.includes('inside/real.js'), `real file missing:\n${out}`);
        assert.ok(!out.includes('secret.js'), `symlink target was followed:\n${out}`);
      } finally {
        removeTempDir(outsideDir);
      }
    } finally {
      removeTempDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// getCodebaseContext — candidate-file cache (avoid re-walking every turn)
// ---------------------------------------------------------------------------

describe('getCodebaseContext — candidate-file cache', () => {
  test('reuses the walked file list within TTL; ttl:0 bypasses', async () => {
    const dir = makeTempDir('cache');
    try {
      writeFile(dir, 'first.js', 'const widget = 1;\n');
      const first = await getCodebaseContext(dir, 'widget');
      assert.ok(first.includes('first.js'), `first file missing:\n${first}`);

      // Add a second match AFTER the listing was cached.
      writeFile(dir, 'second.js', 'const widget = 2;\n');

      // Cache on (default): the freshly added file is not in the cached listing.
      const cached = await getCodebaseContext(dir, 'widget');
      assert.ok(cached.includes('first.js'), `cached listing lost first.js:\n${cached}`);
      assert.ok(!cached.includes('second.js'), `cache should not yet see second.js:\n${cached}`);

      // Bypass the cache (ttl:0 disables both read and write): fresh walk sees it.
      const fresh = await getCodebaseContext(dir, 'widget', { candidateCacheTtlMs: 0 });
      assert.ok(fresh.includes('second.js'), `fresh walk missed second.js:\n${fresh}`);
    } finally {
      removeTempDir(dir);
    }
  });

  test('candidateCacheTtlMs:0 never caches (always a fresh walk)', async () => {
    const dir = makeTempDir('cache-ttl0');
    try {
      writeFile(dir, 'one.js', 'const widget = 1;\n');
      await getCodebaseContext(dir, 'widget', { candidateCacheTtlMs: 0 });
      writeFile(dir, 'two.js', 'const widget = 2;\n');
      const out = await getCodebaseContext(dir, 'widget', { candidateCacheTtlMs: 0 });
      assert.ok(out.includes('two.js'), `ttl:0 should always re-walk:\n${out}`);
    } finally {
      removeTempDir(dir);
    }
  });
});
