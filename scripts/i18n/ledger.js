#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { scanJavaScript } = require('./ledger-js-scan.js');
const { scanHtml } = require('./ledger-html-scan.js');
const {
  buildArtifacts,
  compareOrdinal,
  isSecurityPolicy,
  jsonBytes,
  renderSamplingAudit,
} = require('./ledger-outputs.js');

const HTML_FILES = [
  'index.html',
  'overlay.html',
  'mermaid-frame.html',
  'plugin-consent.html',
  'uninstall.html',
  'html-artifact-frame.html',
];
const GENERATED_SERVICE_RE = /^services\/backend\/generated-[^/]*\.js$/;
const OUTPUT_PATHS = [
  'docs/i18n/STRING_LEDGER.json',
  'docs/i18n/STRING_LEDGER.md',
  'locales/en.json',
  'locales/qps-ploc.json',
];
const BASELINE_PATH = 'docs/i18n/string_ledger_baseline.json';
const SAMPLE_PATH = 'docs/i18n/SAMPLING_AUDIT.md';
const REMAINDERS_PATH = 'scripts/i18n/remainders.json';

function loadRemainders(root, errors) {
  const target = path.join(root, ...REMAINDERS_PATH.split('/'));
  if (!fs.existsSync(target)) return [];
  let value;
  try {
    value = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    errors.push(`${REMAINDERS_PATH} is invalid: ${error.message}`);
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`${REMAINDERS_PATH} must be a JSON array`);
    return [];
  }
  const entries = [];
  value.forEach((entry, index) => {
    const valid = entry && typeof entry === 'object' && !Array.isArray(entry)
      && ['name', 'file', 'text', 'reason'].every(
        (field) => typeof entry[field] === 'string' && entry[field].length > 0
      );
    if (!valid) {
      errors.push(`${REMAINDERS_PATH}[${index}] must contain non-empty name, file, text, and reason strings`);
      return;
    }
    entries.push({ name: entry.name, file: entry.file, text: entry.text, reason: entry.reason });
  });
  return entries;
}

function parseArguments(argv) {
  const command = argv[0];
  const options = {
    command,
    root: process.cwd(),
    writeBaseline: false,
    seed: 101,
    perStratum: 3,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write-baseline') {
      options.writeBaseline = true;
    } else if (argument === '--root') {
      options.root = path.resolve(argv[index += 1] || '');
    } else if (argument === '--seed') {
      options.seed = Number(argv[index += 1]);
    } else if (argument === '--per-stratum') {
      options.perStratum = Number(argv[index += 1]);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!['scan', 'check', 'sample'].includes(command)) {
    throw new Error('usage: ledger.js scan [--write-baseline] | check | sample [--seed N --per-stratum K] [--root DIR]');
  }
  if (!Number.isInteger(options.seed) || options.seed < 0) throw new Error('--seed must be a non-negative integer');
  if (!Number.isInteger(options.perStratum) || options.perStratum < 1) {
    throw new Error('--per-stratum must be a positive integer');
  }
  return options;
}

function repoPath(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function walkJavaScript(root, directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  const files = [];
  const pending = [absolute];
  while (pending.length) {
    const current = pending.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
    }
  }
  return files;
}

function scanFiles(root) {
  const rendererFiles = walkJavaScript(root, 'renderer');
  const serviceFiles = walkJavaScript(root, 'services')
    .filter((file) => !GENERATED_SERVICE_RE.test(repoPath(root, file)));
  const mainFile = path.join(root, 'main.js');
  const javaScript = [...rendererFiles, ...serviceFiles];
  if (fs.existsSync(mainFile)) javaScript.push(mainFile);
  const html = HTML_FILES.map((file) => path.join(root, file)).filter((file) => fs.existsSync(file));
  return {
    javaScript: [...new Set(javaScript)].sort((a, b) => compareOrdinal(repoPath(root, a), repoPath(root, b))),
    html: html.sort((a, b) => compareOrdinal(repoPath(root, a), repoPath(root, b))),
  };
}

function makeCatalogCollector(catalog, errors) {
  return (key, value, file, _offset, line = 1) => {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || typeof value !== 'string') return;
    const location = `${file}:${line}`;
    if (isSecurityPolicy(value)) {
      errors.push(`${location}: security policies must be code constants, not translation keys (${normalizedKey})`);
      return;
    }
    const previous = catalog.get(normalizedKey);
    if (!previous) {
      catalog.set(normalizedKey, { value, location });
      return;
    }
    if (previous.value !== value) {
      errors.push(
        `conflicting default for "${normalizedKey}": ${previous.location} has ${JSON.stringify(previous.value)}; `
        + `${location} has ${JSON.stringify(value)}`
      );
    }
  };
}

function generate(root) {
  const rawOccurrences = [];
  const catalog = new Map();
  const errors = [];
  const remainders = loadRemainders(root, errors);
  const addCatalog = makeCatalogCollector(catalog, errors);
  const files = scanFiles(root);
  for (const absolute of files.javaScript) {
    const file = repoPath(root, absolute);
    const source = fs.readFileSync(absolute, 'utf8');
    try {
      rawOccurrences.push(...scanJavaScript({ source, file, addCatalog, errors, remainders }));
    } catch (error) {
      errors.push(`${file}: parse error: ${error.message}`);
    }
  }
  for (const absolute of files.html) {
    const file = repoPath(root, absolute);
    const source = fs.readFileSync(absolute, 'utf8');
    rawOccurrences.push(...scanHtml({ source, file, addCatalog, errors }));
  }
  return buildArtifacts(rawOccurrences, catalog, errors, { remainders });
}

function writeFile(root, relative, bytes) {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, 'utf8');
}

function totalsLine(prefix, artifacts) {
  const { totals } = artifacts.ledger;
  const domains = Object.entries(totals.by_domain)
    .map(([domain, counts]) => `${domain}=${counts.pending + counts.migrated + counts.excluded}`)
    .join(', ');
  return `${prefix} pending=${totals.pending} migrated=${totals.migrated} excluded=${totals.excluded}; domains: ${domains}`;
}

function printScannerErrors(errors, stream = process.stderr) {
  for (const error of errors) stream.write(`ERROR: ${error}\n`);
}

function scanCommand(options, artifacts) {
  for (const [relative, bytes] of Object.entries(artifacts.files)) writeFile(options.root, relative, bytes);
  if (options.writeBaseline) {
    const pendingIds = artifacts.occurrences
      .filter((item) => item.disposition === 'pending')
      .map((item) => item.id)
      .sort(compareOrdinal);
    writeFile(options.root, BASELINE_PATH, jsonBytes(pendingIds));
  }
  console.log(totalsLine('SCAN:', artifacts));
  if (artifacts.ledger.errors.length) {
    printScannerErrors(artifacts.ledger.errors);
    return 2;
  }
  return 0;
}

function readBaseline(root, failures) {
  const target = path.join(root, ...BASELINE_PATH.split('/'));
  try {
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      failures.push(`${BASELINE_PATH} must be a JSON array of occurrence ids`);
      return [];
    }
    return value;
  } catch (error) {
    failures.push(`${BASELINE_PATH} is missing or invalid: ${error.message}`);
    return [];
  }
}

function checkCommand(options, artifacts) {
  const failures = [];
  for (const relative of OUTPUT_PATHS) {
    const target = path.join(options.root, ...relative.split('/'));
    let actual = null;
    try {
      actual = fs.readFileSync(target, 'utf8');
    } catch {
      // Reported as generated-output drift below.
    }
    if (actual !== artifacts.files[relative]) {
      failures.push(`${relative} differs from regeneration; run \`node scripts/i18n/ledger.js scan\``);
    }
  }
  const baseline = readBaseline(options.root, failures);
  const baselineIds = new Set(baseline);
  const pendingById = new Map(
    artifacts.occurrences.filter((item) => item.disposition === 'pending').map((item) => [item.id, item])
  );
  for (const item of pendingById.values()) {
    if (!baselineIds.has(item.id)) {
      failures.push(`new untranslated string: ${item.file} [${item.kind}] ${JSON.stringify(item.text)}`);
    }
  }
  for (const id of [...baselineIds].sort(compareOrdinal)) {
    if (!pendingById.has(id)) failures.push(`remove from baseline; it was migrated or deleted: ${id}`);
  }
  for (const error of artifacts.ledger.errors) failures.push(`scanner error: ${error}`);
  if (failures.length) {
    console.log('FAIL: i18n string ledger');
    for (const failure of failures) console.log(`  - ${failure}`);
    return 1;
  }
  console.log(totalsLine('PASS: i18n string ledger;', artifacts));
  return 0;
}

function sampleCommand(options, artifacts) {
  const markdown = renderSamplingAudit(artifacts.occurrences, options.seed, options.perStratum);
  writeFile(options.root, SAMPLE_PATH, markdown);
  console.log(`SAMPLE: wrote ${SAMPLE_PATH} (seed=${options.seed}, per-stratum=${options.perStratum})`);
  if (artifacts.ledger.errors.length) {
    printScannerErrors(artifacts.ledger.errors);
    return 2;
  }
  return 0;
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 2;
  }
  const artifacts = generate(options.root);
  if (options.command === 'scan') return scanCommand(options, artifacts);
  if (options.command === 'check') return checkCommand(options, artifacts);
  return sampleCommand(options, artifacts);
}

if (require.main === module) process.exitCode = main();

module.exports = { generate, main };
