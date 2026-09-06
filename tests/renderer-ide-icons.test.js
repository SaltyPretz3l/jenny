'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { categoryForName, fileIconMarkup } = require('../renderer/features/renderer-ide-icons');

test('categoryForName maps extensions to color categories', () => {
  assert.equal(categoryForName('app.js'), 'js');
  assert.equal(categoryForName('module.mjs'), 'js');
  assert.equal(categoryForName('types.d.ts'), 'ts');
  assert.equal(categoryForName('run.py'), 'py');
  assert.equal(categoryForName('build.ps1'), 'shell');
  assert.equal(categoryForName('index.html'), 'html');
  assert.equal(categoryForName('theme.scss'), 'css');
  assert.equal(categoryForName('package.json'), 'json');
  assert.equal(categoryForName('README.md'), 'md');
  assert.equal(categoryForName('flow.mermaid'), 'diagram');
  assert.equal(categoryForName('logo.svg'), 'image');
  assert.equal(categoryForName('settings.yaml'), 'config');
  assert.equal(categoryForName('LICENSE'), 'file');
  assert.equal(categoryForName('.gitignore'), 'file'); // leading dot is not an extension
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

  const unknown = fileIconMarkup('Makefile', 'file');
  assert.match(unknown, /ide-tree-icon--file/);
});

test('fileIconMarkup never interpolates the file name into markup', () => {
  const hostile = fileIconMarkup('<img onerror=x>.js', 'file');
  assert.ok(!hostile.includes('<img'), 'name must not appear in the markup');
  assert.match(hostile, /ide-tree-icon--js/);
});
