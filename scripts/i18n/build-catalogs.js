#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArguments(argv) {
  let localesDir = path.join(process.cwd(), 'locales');
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--locales-dir') {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
    const value = argv[index += 1];
    if (!value) throw new Error('--locales-dir requires a path');
    localesDir = path.resolve(value);
  }
  return { localesDir };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readCatalog(file, tag) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isPlainObject(parsed)) throw new Error('catalog must be a JSON object');
  const wrapped = Object.prototype.hasOwnProperty.call(parsed, 'strings');
  const strings = wrapped ? parsed.strings : parsed;
  if (!isPlainObject(strings)) throw new Error('strings must be a JSON object');
  if (wrapped && parsed.tag !== tag) throw new Error(`tag must match filename (${tag})`);
  const sortedStrings = {};
  for (const key of Object.keys(strings).sort(compareOrdinal)) {
    if (typeof strings[key] !== 'string') throw new Error(`${key}: value must be a string`);
    sortedStrings[key] = strings[key];
  }
  return { tag, strings: sortedStrings };
}

function renderCatalog(catalog) {
  const json = JSON.stringify(catalog, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return [
    '(function loadJennyI18nCatalog(globalScope) {',
    "  'use strict';",
    '',
    `  var catalog = ${json};`,
    "  if (globalScope && globalScope.jennyI18n && typeof globalScope.jennyI18n.load === 'function') {",
    '    globalScope.jennyI18n.load(catalog);',
    '  }',
    "})(typeof globalThis !== 'undefined' ? globalThis : this);",
    '',
  ].join('\n');
}

function buildCatalogs(localesDir) {
  const names = fs.readdirSync(localesDir).sort(compareOrdinal);
  const jsonNames = names.filter((name) => name.endsWith('.json'));
  const catalogs = jsonNames.map((name) => {
    const tag = name.slice(0, -5);
    return [tag, readCatalog(path.join(localesDir, name), tag)];
  });
  const expectedScripts = new Set(jsonNames.map((name) => `${name.slice(0, -5)}.catalog.js`));
  for (const name of names) {
    if (name.endsWith('.catalog.js') && !expectedScripts.has(name)) {
      fs.rmSync(path.join(localesDir, name));
    }
  }
  for (const [tag, catalog] of catalogs) {
    fs.writeFileSync(path.join(localesDir, `${tag}.catalog.js`), renderCatalog(catalog), 'utf8');
  }
  return jsonNames.length;
}

function main(argv = process.argv.slice(2)) {
  try {
    const { localesDir } = parseArguments(argv);
    const count = buildCatalogs(localesDir);
    console.log(`BUILT: ${count} i18n catalog script(s)`);
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { buildCatalogs, main, renderCatalog };
