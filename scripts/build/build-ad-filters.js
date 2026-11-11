'use strict';

// Manual: refreshes assets/ad-filters/. Run `node scripts/build/build-ad-filters.js`
// to download the lists, or add `--from <dir>` to read easylist.txt and
// easyprivacy.txt from a local copy. Downloads use node:https, one at a time
// (Node 22's fetch crashed on the second large body).

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const OUT_DIR = path.join(__dirname, '..', '..', 'assets', 'ad-filters');
const LICENSE = 'GPL-3.0 OR CC-BY-SA-3.0 (https://easylist.to/pages/licence.html)';
const LISTS = [
  { name: 'EasyList', file: 'easylist.txt', url: 'https://easylist.to/easylist/easylist.txt' },
  { name: 'EasyPrivacy', file: 'easyprivacy.txt', url: 'https://easylist.to/easylist/easyprivacy.txt' },
];
const PARSE_OPTIONS = {
  enableCompression: true,
  loadCosmeticFilters: true,
  loadNetworkFilters: true,
  loadGenericCosmeticsFilters: false,
  loadExtendedSelectors: false,
};

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed with status ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function readVersion(text) {
  const match = /^!\s*Version:\s*(\S+)/m.exec(text.slice(0, 4096));
  if (!match) throw new Error('list has no Version header');
  return match[1];
}

function parseArgs(argv) {
  const index = argv.indexOf('--from');
  if (index === -1) return { from: null };
  if (!argv[index + 1]) throw new Error('--from needs a directory');
  return { from: path.resolve(argv[index + 1]) };
}

async function fetchList(list, from) {
  if (from) return fs.readFileSync(path.join(from, list.file), 'utf8');
  return download(list.url);
}

async function main() {
  const { from } = parseArgs(process.argv.slice(2));
  const { FiltersEngine } = require('@ghostery/adblocker');
  const texts = [];
  const lists = [];
  for (const list of LISTS) {
    const text = await fetchList(list, from);
    texts.push(text);
    lists.push({ name: list.name, url: list.url, version: readVersion(text), license: LICENSE });
  }
  const engine = FiltersEngine.parse(texts.join('\n'), PARSE_OPTIONS);
  const bytes = engine.serialize();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'filters.bin'), bytes);
  const meta = { engine: require('@ghostery/adblocker/package.json').version, lists };
  fs.writeFileSync(path.join(OUT_DIR, 'filters.json'), `${JSON.stringify(meta, null, 2)}\n`);
  process.stdout.write(`wrote filters.bin (${bytes.byteLength} bytes)\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`build-ad-filters failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { readVersion, parseArgs };
