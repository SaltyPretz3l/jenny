'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeDigests(source) {
  if (source?.kind !== 'folder') {
    throw Object.assign(new Error('--write-digests is available only for plugin folders'), {
      code: 'target_unusable',
    });
  }
  if (!source.manifest || source.manifestParseError || !Array.isArray(source.manifest.contributions)) {
    throw Object.assign(new Error('plugin.json must be valid JSON before digests can be written'), {
      code: 'target_unusable',
    });
  }
  const manifest = structuredClone(source.manifest);
  for (let index = 0; index < manifest.contributions.length; index += 1) {
    const loaded = source.contributions[index];
    if (!Buffer.isBuffer(loaded?.bytes)) {
      throw Object.assign(new Error(`cannot read ${manifest.contributions[index].content_path}`), {
        code: 'target_unusable',
      });
    }
    manifest.contributions[index].content_sha256 = digest(loaded.bytes);
  }
  fs.writeFileSync(path.join(source.rootPath, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

module.exports = { writeDigests };
