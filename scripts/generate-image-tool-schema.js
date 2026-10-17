/* Regenerate the image tool dimension contract from engine family presets. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
function updateImageToolSchema(manifest, families) {
  const tool = manifest.tools.find(entry => entry.name === 'image_generate');
  const presets = Object.values(families).map(family => family.resolutions);
  const pairs = presets[0];
  if (!pairs || presets.some(value => JSON.stringify(value) !== JSON.stringify(pairs))) throw new Error('Image families need distinct tool contracts');
  tool.description = tool.description.replace(/Supported width x height pairs: .*?\. Default square:/, `Supported width x height pairs: ${pairs.join(', ')}. Default square:`);
  for (const [index, name] of ['width', 'height'].entries()) tool.parameters.properties[name].enum = pairs.map(pair => Number(pair.split('x')[index]));
  return manifest;
}
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const file = path.join(root, 'services/tools/tool-manifest.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const expected = updateImageToolSchema(structuredClone(current), JSON.parse(fs.readFileSync(path.join(root, 'config/sdcpp-families.json'), 'utf8')).families);
  if (process.argv.includes('--check')) {
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Run node scripts/generate-image-tool-schema.js');
  } else fs.writeFileSync(file, JSON.stringify(expected, null, 2) + '\n');
}
module.exports = { updateImageToolSchema };
