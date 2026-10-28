'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const icons = require('../renderer/features/renderer-ide-icons');

const { categoryForName, fileIconMarkup } = icons;

// The module shipped with 9 glyphs (folder, folderOpen, file, code, braces,
// markdown, image, gear, diagram) before the row 82 growth; the budget is +8.
const GLYPH_COUNT_BEFORE_GROWTH = 9;

// Glyph keys the markup resolves to, read back through the exported helper.
const glyphOf = (name) => icons.glyphKeyForName(name);

test('categoryForName maps extensions to color categories', () => {
  assert.equal(categoryForName('app.js'), 'js');
  assert.equal(categoryForName('module.mjs'), 'js');
  assert.equal(categoryForName('types.d.ts'), 'ts');
  assert.equal(categoryForName('run.py'), 'py');
  assert.equal(categoryForName('build.ps1'), 'shell');
  assert.equal(categoryForName('index.html'), 'html');
  assert.equal(categoryForName('theme.scss'), 'css');
  assert.equal(categoryForName('data.json'), 'json');
  assert.equal(categoryForName('README.md'), 'md');
  assert.equal(categoryForName('flow.mermaid'), 'diagram');
  assert.equal(categoryForName('logo.svg'), 'image');
  assert.equal(categoryForName('settings.yaml'), 'config');
  assert.equal(categoryForName('LICENSE'), 'md');
  assert.equal(categoryForName('.gitignore'), 'git'); // exact filename wins over (absent) extension
  assert.equal(categoryForName('.unknownrc'), 'file'); // leading dot is not an extension
  assert.equal(categoryForName(''), 'file');
});

test('fileIconMarkup renders folder state and category classes', () => {
  const closed = fileIconMarkup('src', 'directory', { expanded: false });
  const open = fileIconMarkup('src', 'directory', { expanded: true });
  assert.match(closed, /ide-tree-icon--folder/);
  assert.match(open, /ide-tree-icon--folder/);
  assert.notEqual(closed, open, 'open and closed folders use distinct glyphs');

  const js = fileIconMarkup('app.js', 'file');
  assert.match(js, /ide-tree-icon--js/);
  assert.match(js, /aria-hidden="true"/);
  assert.match(js, /<svg viewBox="0 0 16 16"/);

  const unknown = fileIconMarkup('notes.zzz', 'file');
  assert.match(unknown, /ide-tree-icon--file/);
});

test('fileIconMarkup never interpolates the file name into markup', () => {
  const hostile = fileIconMarkup('<img onerror=x>.js', 'file');
  assert.ok(!hostile.includes('<img'), 'name must not appear in the markup');
  assert.match(hostile, /ide-tree-icon--js/);
});

test('categoryForName ignores inherited Object.prototype keys as extensions', () => {
  for (const name of ['x.constructor', 'a.toString', 'b.__proto__', 'c.hasOwnProperty', 'd.valueOf']) {
    assert.equal(categoryForName(name), 'file', name);
    assert.match(fileIconMarkup(name, 'file'), /ide-tree-icon--file"/, name);
  }
});

test('exact filenames resolve before the extension lookup, case-insensitively', () => {
  assert.equal(glyphOf('Dockerfile'), 'gear');
  assert.equal(categoryForName('Dockerfile'), 'build');
  assert.equal(categoryForName('DOCKERFILE'), 'build');
  assert.equal(categoryForName('.gitignore'), 'git');
  assert.equal(glyphOf('.gitignore'), 'git');
  assert.equal(glyphOf('.GitAttributes'), 'git');
  assert.equal(glyphOf('package-lock.json'), 'lock'); // not json/braces
  assert.equal(glyphOf('yarn.lock'), 'lock');
  assert.equal(glyphOf('pnpm-lock.yaml'), 'lock');
  assert.equal(glyphOf('tsconfig.json'), 'gear');
  assert.equal(glyphOf('.env'), 'gear');
  assert.equal(glyphOf('.env.local'), 'gear');
  assert.equal(glyphOf('.env.production'), 'gear');
  assert.equal(glyphOf('Makefile'), 'gear');
  assert.equal(glyphOf('CMakeLists.txt'), 'gear');
  assert.equal(glyphOf('README.md'), 'markdown');
  assert.equal(glyphOf('LICENSE'), 'markdown');
  assert.equal(glyphOf('Cargo.toml'), 'archive');
  assert.equal(glyphOf('go.mod'), 'archive');
  assert.equal(glyphOf('package.json'), 'archive');
  assert.ok(Object.keys(icons.FILENAME_CATEGORIES).length >= 20);
});

test('extension table covers the common VS Code set on the intended glyphs', () => {
  assert.equal(glyphOf('script.ps1'), 'terminal');
  assert.equal(glyphOf('run.sh'), 'terminal');
  assert.equal(glyphOf('data.parquet'), 'database');
  assert.equal(glyphOf('q.sql'), 'database');
  assert.equal(glyphOf('pack.zip'), 'archive');
  assert.equal(glyphOf('font.woff2'), 'font');
  assert.equal(glyphOf('x.lock'), 'lock');
  assert.equal(glyphOf('main.rs'), 'code');
  assert.equal(glyphOf('App.vue'), 'code');
  assert.equal(glyphOf('photo.JPG'), 'image');
  assert.ok(Object.keys(icons.EXTENSION_CATEGORIES).length >= 85);
});

test('lookup edge cases: multi-dot, dotfiles, unknown, prototype keys', () => {
  assert.equal(categoryForName('.eslintrc.json'), 'json');
  assert.equal(categoryForName('archive.tar.gz'), 'archive');
  assert.equal(categoryForName('src/deep/dir/Dockerfile'), 'build');
  assert.equal(categoryForName('C:\\proj\\Makefile'), 'build');
  assert.equal(categoryForName('file.unknownext'), 'file');
  assert.equal(glyphOf('file.unknownext'), 'file');
  assert.equal(glyphOf('x.constructor'), 'file');
  assert.equal(glyphOf('constructor'), 'file');
  assert.equal(glyphOf(null), 'file');
  assert.equal(categoryForName('APP.JS'), 'js');
});

test('tables are frozen and every glyph markup is safe, with at most 8 new glyphs', () => {
  assert.ok(Object.isFrozen(icons.EXTENSION_CATEGORIES));
  assert.ok(Object.isFrozen(icons.FILENAME_CATEGORIES));
  assert.ok(Object.isFrozen(icons.GLYPHS));
  const keys = Object.keys(icons.GLYPHS);
  assert.ok(keys.length - GLYPH_COUNT_BEFORE_GROWTH <= 8, `added ${keys.length - GLYPH_COUNT_BEFORE_GROWTH} glyphs`);
  for (const key of keys) {
    const svg = icons.GLYPHS[key];
    assert.ok(!/<script|href|xlink|on\w+=/i.test(svg), key);
  }
  const names = ['a.js', 'a.sh', 'Dockerfile', '.gitignore', 'a.sql', 'a.zip', 'a.ttf', 'a.lock', 'a.png', 'a.md', 'a.json', 'a.yml', 'a.mmd', 'a.zzz', 'a.rs', 'a.rb'];
  for (const name of names) {
    const markup = fileIconMarkup(name, 'file');
    assert.match(markup, /^<span class="ide-tree-icon ide-tree-icon--[a-z]+" aria-hidden="true">/, name);
    assert.ok(!/<script|href/i.test(markup), name);
    assert.ok(markup.includes('stroke="currentColor"'), name);
  }
});

test('every mapped category has a glyph and every glyph is used', () => {
  const used = new Set();
  for (const table of [icons.EXTENSION_CATEGORIES, icons.FILENAME_CATEGORIES]) {
    for (const category of Object.values(table)) {
      assert.ok(Object.prototype.hasOwnProperty.call(icons.CATEGORY_GLYPHS, category), category);
      used.add(icons.CATEGORY_GLYPHS[category]);
    }
  }
  for (const glyph of used) assert.ok(icons.GLYPHS[glyph], glyph);
});
