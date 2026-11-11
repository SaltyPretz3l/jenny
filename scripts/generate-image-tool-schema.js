/* Regenerate the image tool size list from engine family presets. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
function updateImageToolSchema(manifest, families) {
  const tool = manifest.tools.find(entry => entry.name === 'image_generate');
  const presets = Object.values(families).map(family => family.resolutions);
  const pairs = presets[0];
  if (!pairs || presets.some(value => JSON.stringify(value) !== JSON.stringify(pairs))) throw new Error('Image families need distinct tool contracts');
  tool.parameters.properties.size.enum = [...pairs];
  return manifest;
}
// Every tool pair must reach one of a recipe's own sizes; the tool enum stays the sd.cpp pairs.
function checkRecipeSizes(manifest, recipes) {
  const pairs = manifest.tools.find(entry => entry.name === 'image_generate').parameters.properties.size.enum;
  const problems = [];
  for (const [id, recipe] of Object.entries(recipes)) {
    const sizeMap = recipe.size_map || {};
    for (const pair of pairs) {
      if (!Object.hasOwn(sizeMap, pair)) problems.push(`${id} size_map lacks ${pair}`);
      else if (!(recipe.resolutions || []).includes(sizeMap[pair])) problems.push(`${id} maps ${pair} to ${sizeMap[pair]}, which is not one of its resolutions`);
    }
  }
  return problems;
}
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const file = path.join(root, 'services/tools/tool-manifest.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const expected = updateImageToolSchema(structuredClone(current), JSON.parse(fs.readFileSync(path.join(root, 'config/sdcpp-families.json'), 'utf8')).families);
  if (process.argv.includes('--check')) {
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Run node scripts/generate-image-tool-schema.js');
    const problems = checkRecipeSizes(current, JSON.parse(fs.readFileSync(path.join(root, 'config/comfyui-recipes.json'), 'utf8')).recipes);
    if (problems.length) throw new Error('Recipe size maps: ' + problems.join('; '));
  } else if (JSON.stringify(current) !== JSON.stringify(expected)) fs.writeFileSync(file, JSON.stringify(expected, null, 2) + '\n');
}
module.exports = { updateImageToolSchema, checkRecipeSizes };
