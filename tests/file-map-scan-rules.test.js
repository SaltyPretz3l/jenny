'use strict';

// Coverage for services/workspace-file-map-scan-rules.js
// Pure module: no DOM, no IPC, no real fs (readFileSync is injected).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  extract,
  resolveSpecifier,
  parseTsconfigAliases,
  isDependencyContentPath,
} = require('../services/workspace-file-map-scan-rules');

// ---------------------------------------------------------------------------
// extract()
// ---------------------------------------------------------------------------

describe('extract — JS/TS family', () => {
  test('import ... from "..."', () => {
    const content = `import React from 'react';\nimport { a, b } from "./local";`;
    const result = extract('src/App.jsx', content);
    assert.deepEqual(result, [
      { raw: 'react', kind: 'import' },
      { raw: './local', kind: 'import' },
    ]);
  });

  test('bare side-effect import "..."', () => {
    const content = `import './styles.css';`;
    const result = extract('src/index.js', content);
    assert.deepEqual(result, [{ raw: './styles.css', kind: 'import' }]);
  });

  test('export ... from "..." (re-export)', () => {
    const content = `export { foo } from './foo';\nexport * from "./bar";`;
    const result = extract('src/index.ts', content);
    assert.deepEqual(result, [
      { raw: './foo', kind: 'export-from' },
      { raw: './bar', kind: 'export-from' },
    ]);
  });

  test('require("...")', () => {
    const content = `const fs = require('fs');\nconst x = require("./x");`;
    const result = extract('services/thing.js', content);
    assert.deepEqual(result, [
      { raw: 'fs', kind: 'require' },
      { raw: './x', kind: 'require' },
    ]);
  });

  test('dynamic import("...") with string literal', () => {
    const content = `const mod = await import('./lazy');`;
    const result = extract('src/lazy-loader.js', content);
    assert.deepEqual(result, [{ raw: './lazy', kind: 'dynamic-import' }]);
  });

  test('dynamic import(nonLiteral) is skipped without throwing', () => {
    const content = `const mod = await import(someVar);\nconst other = import(\`./\${dyn}\`);`;
    assert.doesNotThrow(() => extract('src/lazy2.js', content));
    const result = extract('src/lazy2.js', content);
    assert.deepEqual(result, []);
  });

  test('specifier inside a stripped comment is not extracted', () => {
    const content = [
      "// import './commented-out' from nowhere",
      '/* require("./also-commented"); */',
      "import './real' from './real';",
    ].join('\n');
    const result = extract('src/commented.js', content);
    assert.ok(!result.some((r) => r.raw.includes('commented')));
    assert.ok(result.some((r) => r.raw === './real'));
  });
});

describe('extract — Python', () => {
  test('dotted absolute import, comma-separated', () => {
    const content = 'import a.b.c\nimport os, sys';
    const result = extract('pkg/mod.py', content);
    assert.deepEqual(result, [
      { raw: 'a.b.c', kind: 'python-import' },
      { raw: 'os', kind: 'python-import' },
      { raw: 'sys', kind: 'python-import' },
    ]);
  });

  test('from .x import y (relative, single dot)', () => {
    const content = 'from .x import y';
    const result = extract('pkg/mod.py', content);
    assert.deepEqual(result, [{ raw: '.x', kind: 'python-import-relative' }]);
  });

  test('from ..pkg import z (relative, double dot)', () => {
    const content = 'from ..pkg import z';
    const result = extract('pkg/sub/mod.py', content);
    assert.deepEqual(result, [{ raw: '..pkg', kind: 'python-import-relative' }]);
  });

  test('from a.b import c (absolute dotted)', () => {
    const content = 'from a.b import c';
    const result = extract('pkg/mod.py', content);
    assert.deepEqual(result, [{ raw: 'a.b', kind: 'python-import' }]);
  });

  test('# comment specifier is not extracted', () => {
    const content = '# import os\nimport sys';
    const result = extract('pkg/mod.py', content);
    assert.deepEqual(result, [{ raw: 'sys', kind: 'python-import' }]);
  });
});

describe('extract — CSS', () => {
  test('@import "..." and @import url(...)', () => {
    const content = `@import './base.css';\n@import url("./theme.css");`;
    const result = extract('styles/main.css', content);
    assert.deepEqual(result, [
      { raw: './base.css', kind: 'css-import' },
      { raw: './theme.css', kind: 'css-import' },
    ]);
  });

  test('specifier inside /* */ comment is not extracted', () => {
    const content = `/* @import './ignored.css'; */\n@import './kept.css';`;
    const result = extract('styles/main.css', content);
    assert.deepEqual(result, [{ raw: './kept.css', kind: 'css-import' }]);
  });
});

describe('extract — HTML', () => {
  test('<script src="...">', () => {
    const content = `<html><head><script src="./app.js"></script></head></html>`;
    const result = extract('index.html', content);
    assert.deepEqual(result, [{ raw: './app.js', kind: 'script-src' }]);
  });
});

describe('extract — unsupported extensions', () => {
  test('returns [] for unknown extension', () => {
    assert.deepEqual(extract('README.md', '# hi'), []);
    assert.deepEqual(extract('data.json', '{}'), []);
  });

  test('returns [] for empty/non-string content', () => {
    assert.deepEqual(extract('src/x.js', ''), []);
    assert.deepEqual(extract('src/x.js', null), []);
  });
});

test('isDependencyContentPath matches exactly the source families that can create edges', () => {
  for (const path of ['a.js', 'a.mjs', 'a.tsx', 'a.py', 'a.css', 'a.html', 'a.htm']) {
    assert.equal(isDependencyContentPath(path), true, path);
  }
  for (const path of ['tsconfig.json', 'README.md', 'asset.png']) {
    assert.equal(isDependencyContentPath(path), false, path);
  }
});

// ---------------------------------------------------------------------------
// resolveSpecifier()
// ---------------------------------------------------------------------------

describe('resolveSpecifier — relative JS/TS', () => {
  test('exact match in fileSet', () => {
    const fileSet = new Set(['src/util.js', 'src/index.js']);
    const result = resolveSpecifier({
      fromPath: 'src/index.js',
      specifier: './util.js',
      fileSet,
    });
    assert.equal(result, 'src/util.js');
  });

  test('extension-inference fallback (.ts)', () => {
    const fileSet = new Set(['src/util.ts', 'src/index.ts']);
    const result = resolveSpecifier({
      fromPath: 'src/index.ts',
      specifier: './util',
      fileSet,
    });
    assert.equal(result, 'src/util.ts');
  });

  test('extension-inference tries list in order (.js before .ts)', () => {
    const fileSet = new Set(['src/util.js', 'src/util.ts']);
    const result = resolveSpecifier({
      fromPath: 'src/index.js',
      specifier: './util',
      fileSet,
    });
    assert.equal(result, 'src/util.js');
  });

  test('index-fallback under resolved directory', () => {
    const fileSet = new Set(['src/lib/index.js', 'src/index.js']);
    const result = resolveSpecifier({
      fromPath: 'src/index.js',
      specifier: './lib',
      fileSet,
    });
    assert.equal(result, 'src/lib/index.js');
  });

  test('.. collapsing normalizes out of nested dir', () => {
    const fileSet = new Set(['src/util.js', 'src/deep/nested.js']);
    const result = resolveSpecifier({
      fromPath: 'src/deep/nested.js',
      specifier: '../util',
      fileSet,
    });
    assert.equal(result, 'src/util.js');
  });

  test('parent traversal above the workspace root stays unresolved', () => {
    const result = resolveSpecifier({
      fromPath: 'src/index.js',
      specifier: '../../util',
      fileSet: new Set(['util.js', 'src/index.js']),
    });

    assert.equal(result, null);
  });

  test('nonexistent relative path returns null', () => {
    const fileSet = new Set(['src/index.js']);
    const result = resolveSpecifier({
      fromPath: 'src/index.js',
      specifier: './missing',
      fileSet,
    });
    assert.equal(result, null);
  });
});

describe('resolveSpecifier — bare specifiers (JS/TS)', () => {
  test('bare specifier with no alias match returns null (external)', () => {
    const fileSet = new Set(['src/index.js']);
    const result = resolveSpecifier({
      fromPath: 'src/index.js',
      specifier: 'lodash',
      fileSet,
      aliases: { baseUrl: null, paths: {} },
    });
    assert.equal(result, null);
  });

  test('bare specifier resolved via a tsconfig-style alias', () => {
    const fileSet = new Set(['app/utils/format.ts', 'src/index.ts']);
    const aliases = { baseUrl: '.', paths: { '@app/*': ['app/*'] } };
    const result = resolveSpecifier({
      fromPath: 'src/index.ts',
      specifier: '@app/utils/format',
      fileSet,
      aliases,
    });
    assert.equal(result, 'app/utils/format.ts');
  });

  test('exact (non-wildcard) alias key match', () => {
    const fileSet = new Set(['shared/thing.js']);
    const aliases = { baseUrl: null, paths: { '@shared': ['shared/thing.js'] } };
    const result = resolveSpecifier({
      fromPath: 'src/index.js',
      specifier: '@shared',
      fileSet,
      aliases,
    });
    assert.equal(result, 'shared/thing.js');
  });

  test('longest-prefix-wins when multiple alias keys could match', () => {
    const fileSet = new Set(['app/utils/special/format.ts']);
    const aliases = {
      baseUrl: null,
      paths: {
        '@app/*': ['app/*'],
        '@app/utils/*': ['app/utils/special/*'],
      },
    };
    const result = resolveSpecifier({
      fromPath: 'src/index.ts',
      specifier: '@app/utils/format',
      fileSet,
      aliases,
    });
    assert.equal(result, 'app/utils/special/format.ts');
  });
});

describe('resolveSpecifier — Python', () => {
  test('dotted absolute import (a.b.c -> a/b/c.py)', () => {
    const fileSet = new Set(['a/b/c.py']);
    const result = resolveSpecifier({
      fromPath: 'main.py',
      specifier: 'a.b.c',
      fileSet,
    });
    assert.equal(result, 'a/b/c.py');
  });

  test('dotted absolute import falls back to __init__.py', () => {
    const fileSet = new Set(['a/b/c/__init__.py']);
    const result = resolveSpecifier({
      fromPath: 'main.py',
      specifier: 'a.b.c',
      fileSet,
    });
    assert.equal(result, 'a/b/c/__init__.py');
  });

  test('relative-dotted: single dot resolves in same package dir', () => {
    const fileSet = new Set(['pkg/x.py', 'pkg/mod.py']);
    const result = resolveSpecifier({
      fromPath: 'pkg/mod.py',
      specifier: '.x',
      fileSet,
    });
    assert.equal(result, 'pkg/x.py');
  });

  test('relative-dotted: double dot ascends one directory', () => {
    const fileSet = new Set(['pkg/other.py', 'pkg/sub/mod.py']);
    const result = resolveSpecifier({
      fromPath: 'pkg/sub/mod.py',
      specifier: '..other',
      fileSet,
    });
    assert.equal(result, 'pkg/other.py');
  });

  test('relative-dotted with sub-package (..pkg.mod)', () => {
    const fileSet = new Set(['top/pkg/mod.py', 'top/sub/importer.py']);
    const result = resolveSpecifier({
      fromPath: 'top/sub/importer.py',
      specifier: '..pkg.mod',
      fileSet,
    });
    assert.equal(result, 'top/pkg/mod.py');
  });
});

describe('resolveSpecifier — CSS/HTML relative', () => {
  test('CSS relative import resolves against fileSet', () => {
    const fileSet = new Set(['styles/base.css', 'styles/main.css']);
    const result = resolveSpecifier({
      fromPath: 'styles/main.css',
      specifier: './base.css',
      fileSet,
    });
    assert.equal(result, 'styles/base.css');
  });

  test('HTML script src relative resolves against fileSet', () => {
    const fileSet = new Set(['js/app.js', 'index.html']);
    const result = resolveSpecifier({
      fromPath: 'index.html',
      specifier: './js/app.js',
      fileSet,
    });
    assert.equal(result, 'js/app.js');
  });

  test('CSS bare (non-relative) specifier returns null (no bare concept)', () => {
    const fileSet = new Set(['node_modules/normalize.css/normalize.css']);
    const result = resolveSpecifier({
      fromPath: 'styles/main.css',
      specifier: 'normalize.css',
      fileSet,
    });
    assert.equal(result, null);
  });

  test('nonexistent CSS relative path returns null', () => {
    const fileSet = new Set(['styles/main.css']);
    const result = resolveSpecifier({
      fromPath: 'styles/main.css',
      specifier: './missing.css',
      fileSet,
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// parseTsconfigAliases()
// ---------------------------------------------------------------------------

describe('parseTsconfigAliases', () => {
  test('parseTsconfigAliases parses already-bounded content without another filesystem read', () => {
    const raw = '{ "compilerOptions": { "baseUrl": "src", "paths": { "@/*": ["*"] } } }';
    assert.deepEqual(parseTsconfigAliases(raw), {
      baseUrl: 'src',
      paths: { '@/*': ['*'] },
    });
    assert.deepEqual(parseTsconfigAliases(undefined), { baseUrl: null, paths: {} });
  });

  test('malformed tsconfig path targets are skipped without aborting alias resolution', () => {
    const aliases = parseTsconfigAliases(JSON.stringify({
      compilerOptions: {
        paths: {
          '': ['ignored/*'],
          '@invalid/*': 'src/*',
          '@mixed/*': [null, 7, 'src/*'],
        },
      },
    }));

    assert.deepEqual(aliases.paths, { '@mixed/*': ['src/*'] });
    assert.equal(resolveSpecifier({
      fromPath: 'index.ts',
      specifier: '@mixed/value',
      fileSet: new Set(['index.ts', 'src/value.ts']),
      aliases: { baseUrl: null, paths: { '@mixed/*': [null, 'src/*'] } },
    }), 'src/value.ts');
  });
});
