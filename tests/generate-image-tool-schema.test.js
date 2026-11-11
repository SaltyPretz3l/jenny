'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkRecipeSizes } = require('../scripts/generate-image-tool-schema');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'services/tools/tool-manifest.json'), 'utf8'));
const { recipes } = JSON.parse(fs.readFileSync(path.join(root, 'config/comfyui-recipes.json'), 'utf8'));

test('shipped recipes map every tool size pair to one of their own sizes', () => {
  assert.deepEqual(checkRecipeSizes(manifest, recipes), []);
});

test('a recipe whose size_map misses a tool pair or leaves its resolutions is reported', () => {
  const broken = structuredClone(recipes);
  const recipe = broken.minimax_h3_image;
  delete recipe.size_map['1664x928'];
  recipe.size_map['928x1664'] = '1920x1088';
  const problems = checkRecipeSizes(manifest, broken);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /minimax_h3_image size_map lacks 1664x928/);
  assert.match(problems[1], /928x1664 to 1920x1088/);
});

test('--check passes on the shipped tables and leaves the manifest untouched', () => {
  const file = path.join(root, 'services/tools/tool-manifest.json');
  const before = fs.readFileSync(file);
  const output = execFileSync(process.execPath, [path.join(root, 'scripts/generate-image-tool-schema.js'), '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(output, '');
  assert.deepEqual(fs.readFileSync(file), before);
});
