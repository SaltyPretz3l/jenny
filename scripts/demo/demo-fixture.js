'use strict';

// Sample workspace for the demo clip recorder (scripts/demo/record-demo-clips.js).
//
// "ledger-cli" is a small, plausible Node project the streaming clip reads with
// the real list_dir / read_file tools and the IDE clip opens in Monaco. It is
// kept as a data map (not real files under the repo) so the sample never gets
// linted, size-checked, or mistaken for app code. materialize() writes it into
// a throwaway directory; demo-profile.js then git-inits it and applies
// WORKING_TREE_EDIT after the first commit so the IDE gutter shows a modified
// hunk.

const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_FILES = Object.freeze({
  'README.md': `# ledger-cli

A tiny command-line expense tracker. Entries live in a plain-text ledger file,
one per line:

    2026-09-01  coffee        4.50  food
    2026-09-01  bus pass     32.00  transit
    2026-09-03  groceries    61.20  food

## Usage

    node src/index.js add "coffee 4.50" --tag food
    node src/index.js list --month 2026-09
    node src/index.js total --tag food

## Layout

- src/index.js - parses argv and dispatches to a command
- src/commands/ - one module per command (add, list, total)
- src/parser.js - turns a ledger line into a typed entry
- test/ - node:test suites

## Why plain text

The ledger is meant to be edited by hand, diffed, and kept in version control.
No database, no daemon, no sync service.
`,

  'package.json': `{
  "name": "ledger-cli",
  "version": "0.3.1",
  "description": "Plain-text expense tracker for the terminal",
  "license": "MIT",
  "bin": { "ledger": "src/index.js" },
  "scripts": {
    "test": "node --test"
  }
}
`,

  '.gitignore': `node_modules/
ledger.txt
*.log
`,

  'src/index.js': `#!/usr/bin/env node
'use strict';

const path = require('node:path');

const commands = {
  add: require('./commands/add'),
  list: require('./commands/list'),
  total: require('./commands/total'),
};

const DEFAULT_LEDGER = path.join(process.cwd(), 'ledger.txt');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function usage() {
  return [
    'usage: ledger <command> [options]',
    '',
    '  add "<description> <amount>" [--tag <tag>]',
    '  list [--month YYYY-MM] [--tag <tag>]',
    '  total [--month YYYY-MM] [--tag <tag>]',
    '',
    'options:',
    '  --ledger <path>   ledger file (default: ./ledger.txt)',
  ].join('\\n');
}

function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const [name, ...rest] = positional;
  const command = commands[name];
  if (!command) {
    console.error(usage());
    return 1;
  }
  const ledgerPath = flags.ledger || DEFAULT_LEDGER;
  return command.run({ args: rest, flags, ledgerPath });
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, parseArgs, usage };
`,

  'src/parser.js': `'use strict';

// One ledger entry per line:  <date> <description> <amount> [tag]
// Amounts are stored as integer cents so totals never drift.
const LINE_PATTERN = /^(\\d{4}-\\d{2}-\\d{2})\\s+(.+?)\\s+(-?\\d+(?:\\.\\d{1,2})?)(?:\\s+(\\S+))?$/;

function parseAmount(raw) {
  const cents = Math.round(Number(raw) * 100);
  if (!Number.isFinite(cents)) {
    throw new TypeError('invalid amount: ' + raw);
  }
  return cents;
}

function parseLine(line, lineNumber = 0) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  const match = LINE_PATTERN.exec(trimmed);
  if (!match) {
    throw new SyntaxError('ledger line ' + lineNumber + ': cannot parse "' + trimmed + '"');
  }
  const [, date, description, amount, tag] = match;
  return {
    date,
    description: description.trim(),
    cents: parseAmount(amount),
    tag: tag || 'untagged',
    line: lineNumber,
  };
}

function parseLedger(text) {
  const entries = [];
  const lines = String(text || '').split(/\\r?\\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const entry = parseLine(lines[index], index + 1);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return sign + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}

module.exports = { LINE_PATTERN, parseAmount, parseLine, parseLedger, formatCents };
`,

  'src/ledger-file.js': `'use strict';

const fs = require('node:fs');
const { parseLedger } = require('./parser');

function readEntries(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) {
    return [];
  }
  return parseLedger(fs.readFileSync(ledgerPath, 'utf8'));
}

function appendLine(ledgerPath, line) {
  fs.appendFileSync(ledgerPath, line + '\\n', 'utf8');
}

function filterEntries(entries, { month, tag } = {}) {
  return entries.filter((entry) => {
    if (month && !entry.date.startsWith(month)) {
      return false;
    }
    if (tag && entry.tag !== tag) {
      return false;
    }
    return true;
  });
}

module.exports = { readEntries, appendLine, filterEntries };
`,

  'src/commands/add.js': `'use strict';

const { parseLine } = require('../parser');
const { appendLine } = require('../ledger-file');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function run({ args, flags, ledgerPath }) {
  const text = args.join(' ').trim();
  if (!text) {
    console.error('add: expected "<description> <amount>"');
    return 1;
  }
  const line = [today(), text, flags.tag || ''].join('  ').trim();
  const entry = parseLine(line, 0);
  appendLine(ledgerPath, line);
  console.log('added ' + entry.description + ' (' + entry.tag + ')');
  return 0;
}

module.exports = { run };
`,

  'src/commands/list.js': `'use strict';

const { formatCents } = require('../parser');
const { readEntries, filterEntries } = require('../ledger-file');

function run({ flags, ledgerPath }) {
  const entries = filterEntries(readEntries(ledgerPath), flags);
  if (entries.length === 0) {
    console.log('(no entries)');
    return 0;
  }
  for (const entry of entries) {
    const amount = formatCents(entry.cents).padStart(9);
    console.log(entry.date + '  ' + amount + '  ' + entry.description.padEnd(24) + '  ' + entry.tag);
  }
  return 0;
}

module.exports = { run };
`,

  'src/commands/total.js': `'use strict';

const { formatCents } = require('../parser');
const { readEntries, filterEntries } = require('../ledger-file');

function run({ flags, ledgerPath }) {
  const entries = filterEntries(readEntries(ledgerPath), flags);
  const byTag = new Map();
  let total = 0;
  for (const entry of entries) {
    total += entry.cents;
    byTag.set(entry.tag, (byTag.get(entry.tag) || 0) + entry.cents);
  }
  for (const [tag, cents] of [...byTag.entries()].sort()) {
    console.log(tag.padEnd(12) + formatCents(cents).padStart(10));
  }
  console.log('total'.padEnd(12) + formatCents(total).padStart(10));
  return 0;
}

module.exports = { run };
`,

  'test/parser.test.js': `'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseLine, parseLedger, formatCents } = require('../src/parser');

test('parses a tagged entry into integer cents', () => {
  const entry = parseLine('2026-09-01  coffee  4.50  food', 1);
  assert.deepStrictEqual(entry, {
    date: '2026-09-01',
    description: 'coffee',
    cents: 450,
    tag: 'food',
    line: 1,
  });
});

test('untagged entries default to "untagged"', () => {
  assert.strictEqual(parseLine('2026-09-01 bus pass 32.00').tag, 'untagged');
});

test('blank lines and comments are skipped', () => {
  const entries = parseLedger('# header\\n\\n2026-09-01 tea 2.10 food\\n');
  assert.strictEqual(entries.length, 1);
});

test('formatCents keeps two decimals and the sign', () => {
  assert.strictEqual(formatCents(450), '4.50');
  assert.strictEqual(formatCents(-5), '-0.05');
});
`,
});

// Applied by demo-profile.js AFTER the initial commit so src/parser.js carries a
// modified hunk in the working tree (the IDE clip shows the git gutter).
const WORKING_TREE_EDIT = Object.freeze({
  path: 'src/parser.js',
  // Near the top of the file so the gutter hunk is on screen at every
  // recording height without scrolling the editor. No regex literal here or
  // in the assistant-edit replay: the tool-input panel's path redactor reads
  // `/,/g` as a POSIX path and would print [redacted:path] in the clip.
  find: "  const cents = Math.round(Number(raw) * 100);\n",
  replace: "  // Accept thousands separators: '1,250.00' parses like '1250.00'.\n"
    + "  const cents = Math.round(Number(String(raw).split(',').join('')) * 100);\n",
});

function materialize(targetDir) {
  const written = [];
  for (const [relPath, contents] of Object.entries(FIXTURE_FILES)) {
    const absolute = path.join(targetDir, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents, 'utf8');
    written.push(absolute);
  }
  return written;
}

module.exports = { FIXTURE_FILES, WORKING_TREE_EDIT, materialize };
