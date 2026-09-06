'use strict';

// Thin test-only convenience over services/plugins/store/fs-facade.js's
// production MemoryFsFacade. It intentionally does not reimplement any
// filesystem logic -- it only adds ergonomics the store-module tests reuse a
// lot: seeding a fresh facade with a directory tree of JSON/text files in one
// call, and reading back everything currently on the facade for assertions.

const { createMemoryFsFacade, joinPath } = require('../../../services/plugins/store/fs-facade');

// `files` is a flat map of logical path -> either a raw string or a plain
// object (serialized with JSON.stringify). Parent directories are created
// implicitly, matching how the real store modules always mkdir before write.
async function createSeededFacade(files = {}) {
  const facade = createMemoryFsFacade();
  for (const [filePath, contents] of Object.entries(files)) {
    const normalized = joinPath(filePath);
    const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
    await facade.mkdir(dir);
    const text = typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2);
    await facade.writeFile(normalized, text);
  }
  return facade;
}

// Snapshots every file currently stored on a MemoryFsFacade, parsing JSON
// where possible. Handy for asserting "exactly these paths exist with this
// shape" without reaching into the facade's private Map.
async function snapshotFacade(facade, dirPath = '') {
  const result = {};
  async function walk(current) {
    const names = await facade.list(current);
    for (const name of names) {
      const childPath = current ? `${current}/${name}` : name;
      const stat = await facade.stat(childPath);
      if (stat.isDirectory) {
        await walk(childPath);
      } else if (stat.isFile) {
        const raw = await facade.readFile(childPath);
        try {
          result[childPath] = JSON.parse(raw);
        } catch (error) {
          void error;
          result[childPath] = raw;
        }
      }
    }
  }
  await walk(joinPath(dirPath));
  return result;
}

module.exports = {
  createSeededFacade,
  snapshotFacade,
};
