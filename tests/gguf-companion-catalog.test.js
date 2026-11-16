'use strict';

// The pinned GGUF companion catalog (config/gguf-companions.json) and its
// loader, validator, matcher and URL builder (services/gguf-companion-catalog.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_CATALOG_PATH,
  companionDownloadUrl,
  loadCompanionCatalog,
  matchCompanionEntry,
  validateCompanionCatalog,
} = require('../services/gguf-companion-catalog');
const { loadAccelerationCatalog } = require('../services/backend/llama-server-acceleration');

const REPO_ROOT = path.resolve(__dirname, '..');
const ACCEL = loadAccelerationCatalog({ repoRoot: REPO_ROOT }).catalog;
const SEED_TEXT = fs.readFileSync(path.join(REPO_ROOT, 'config', 'gguf-companions.json'), 'utf8');
const seed = () => JSON.parse(SEED_TEXT);
const validate = (json) => validateCompanionCatalog(json, { accelerationCatalog: ACCEL });

// A seed copy with one change applied to its first (Qwen) entry.
function mutated(change) {
  const json = seed();
  change(json.entries[0], json);
  return json;
}

function assertRejects(change, fieldName) {
  const result = validate(mutated(change));
  assert.equal(result.ok, false, `${fieldName} should be rejected`);
  assert.ok(
    result.errors.some((error) => error.includes(fieldName)),
    `${fieldName} not named in ${JSON.stringify(result.errors)}`
  );
}

const QWEN_HEADER = {
  architecture: 'qwen35',
  kv: {
    'general.architecture': 'qwen35',
    'general.basename': 'Qwen3.8-27B',
    'general.base_model.count': 1,
    'general.base_model.0.repo_url': 'https://huggingface.co/Qwen/Qwen3.8-27B',
  },
};

test('the seed catalog validates and its default path is the config file', () => {
  assert.deepEqual(validate(seed()), { ok: true, errors: [] });
  assert.equal(path.resolve(DEFAULT_CATALOG_PATH), path.join(REPO_ROOT, 'config', 'gguf-companions.json'));
  const qwen = seed().entries[0];
  assert.equal(qwen.drafter.bytes, 1369590656);
  assert.equal(qwen.projector.saveAs, 'mmproj-Qwen3.8-27B-F16.gguf');
});

test('the seed stays in step with the acceleration catalog', () => {
  const families = new Map(ACCEL.families.map((family) => [family.family, family]));
  const entries = seed().entries;
  assert.deepEqual(entries.map((entry) => entry.id), [
    'qwen3.8-27b', 'gemma-4-12b-it', 'gemma-4-31b-it', 'gemma-4-e4b-it',
  ]);
  for (const entry of entries) {
    const family = families.get(entry.family);
    assert.ok(family, `${entry.id} family`);
    assert.equal(family.mtp, 'yes');
    assert.equal(family.mtpShape, 'separate');
  }
});

test('the validator rejects each bad field and names it', () => {
  const cases = [
    ['schema_version', (_entry, json) => { json.schema_version = 2; }],
    ['entries', (_entry, json) => { json.entries = 'nope'; }],
    ['entries', (_entry, json) => { json.entries = Array.from({ length: 65 }, () => json.entries[0]); }],
    ['.id', (entry) => { entry.id = 'Bad Id'; }],
    ['.family', (entry) => { entry.family = 'no-such-family'; }],
    ['match.architecture', (entry) => { entry.match.architecture = ''; }],
    ['drafter.repo', (entry) => { entry.drafter.repo = 'not a repo'; }],
    ['drafter.revision', (entry) => { entry.drafter.revision = 'main'; }],
    ['drafter.revision', (entry) => { entry.drafter.revision = 'A'.repeat(40); }],
    ['drafter.repoPath', (entry) => { entry.drafter.repoPath = '../mtp-x.gguf'; }],
    ['drafter.repoPath', (entry) => { entry.drafter.repoPath = 'a/b/mtp-x.gguf'; }],
    ['drafter.repoPath', (entry) => { entry.drafter.repoPath = 'MTP\\mtp-x.gguf'; }],
    ['drafter.repoPath', (entry) => { entry.drafter.repoPath = 'MTP//mtp-x.gguf'; }],
    ['drafter.repoPath', (entry) => { entry.drafter.repoPath = 'MTP/mtp-x.bin'; }],
    ['drafter.saveAs', (entry) => { entry.drafter.saveAs = '../mtp-x.gguf'; }],
    ['drafter.bytes', (entry) => { entry.drafter.bytes = 0; }],
    ['drafter.bytes', (entry) => { entry.drafter.bytes = 8 * 1024 ** 3 + 1; }],
    ['drafter.bytes', (entry) => { entry.drafter.bytes = 1.5; }],
    ['projector.bytes', (entry) => { entry.projector.bytes = 4 * 1024 ** 3 + 1; }],
    ['drafter.sha256', (entry) => { entry.drafter.sha256 = entry.drafter.sha256.toUpperCase(); }],
    ['drafter.sha256', (entry) => { entry.drafter.sha256 = 'abc'; }],
    ['drafter.vramMb', (entry) => { entry.drafter.vramMb = 0; }],
    ['drafter.gainOverBuiltInPct', (entry) => { entry.drafter.gainOverBuiltInPct = 1001; }],
    ['drafter.gainOverBuiltInPct', (entry) => { entry.drafter.gainOverBuiltInPct = Number.NaN; }],
    ['drafter.vramOverBuiltInMb', (entry) => { entry.drafter.vramOverBuiltInMb = -1; }],
    ['projector.repo', (entry) => { entry.projector.repo = 'x'; }],
    ['match', (entry) => { entry.match.baseModelRepos = []; entry.match.basenames = []; entry.match.fileFamilies = []; }],
  ];
  for (const [field, change] of cases) assertRejects(change, field);
});

test('the validator rejects a duplicate id and an entry with no file', () => {
  const dup = seed();
  dup.entries[1].id = dup.entries[0].id;
  assert.ok(validate(dup).errors.some((error) => error.includes('duplicate id')));
  const empty = seed();
  delete empty.entries[0].drafter;
  delete empty.entries[0].projector;
  assert.ok(validate(empty).errors.some((error) => error.includes('drafter or a projector')));
});

test('a drafter on a family without a verified separate drafter is rejected', () => {
  assertRejects((entry) => { entry.family = 'qwen36'; }, 'drafter');
  assertRejects((entry) => { entry.family = 'ornith15'; }, 'drafter');
  const noAccel = validateCompanionCatalog(seed(), { accelerationCatalog: null });
  assert.equal(noAccel.ok, false);
});

test('a saveAs that does not classify or does not pair in a mixed folder is rejected', () => {
  // Not an mtp-* name: it would be taken for a main model.
  assertRejects((entry) => { entry.drafter.saveAs = 'Qwen3.8-27B-drafter.gguf'; }, 'drafter.saveAs');
  // Not an mmproj name.
  assertRejects((entry) => { entry.projector.saveAs = 'Qwen3.8-27B-vision-F16.gguf'; }, 'projector.saveAs');
  // The unsloth name names no model: it pairs only in a single-model folder (finding F4).
  assertRejects((entry) => { entry.projector.saveAs = 'mmproj-F16.gguf'; }, 'does not pair');
  // Names another model.
  assertRejects((entry) => { entry.projector.saveAs = 'mmproj-Other-7B-F16.gguf'; }, 'does not pair');
});

test('the loader reads and freezes a valid catalog', () => {
  const catalog = loadCompanionCatalog({ accelerationCatalog: ACCEL });
  assert.equal(catalog.error, undefined);
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.entries.length, 4);
  assert.ok(Object.isFrozen(catalog));
  assert.ok(Object.isFrozen(catalog.entries[0].drafter));
  assert.ok(Object.isFrozen(catalog.entries[0].match.basenames));
  assert.throws(() => { 'use strict'; catalog.entries[0].drafter.bytes = 1; }, TypeError);
});

test('the loader fails closed on bad JSON, a bad entry, a read error and a missing file', () => {
  const closed = (options) => {
    const catalog = loadCompanionCatalog({ accelerationCatalog: ACCEL, ...options });
    assert.equal(catalog.schemaVersion, 1);
    assert.deepEqual([...catalog.entries], []);
    assert.equal(typeof catalog.error, 'string');
    assert.ok(catalog.error.length > 0);
    return catalog;
  };
  closed({ readFile: () => '{ not json' });
  closed({ readFile: () => { throw new Error('EACCES'); } });
  closed({ filePath: path.join(REPO_ROOT, 'config', 'does-not-exist.json') });
  const bad = seed();
  bad.entries[2].drafter.sha256 = 'zz';
  const catalog = closed({ readFile: () => JSON.stringify(bad) });
  assert.ok(catalog.error.includes('sha256'));
  closed({ readFile: () => JSON.stringify([]) });
});

test('matching by base model repo, case-insensitively, names the base model', () => {
  const catalog = loadCompanionCatalog({ accelerationCatalog: ACCEL });
  const found = matchCompanionEntry({ header: QWEN_HEADER, fileName: 'x.gguf' }, catalog);
  assert.equal(found.entry.id, 'qwen3.8-27b');
  assert.equal(found.matchedBy, 'base_model');
  assert.equal(found.fineTune, false);
  assert.equal(found.baseName, 'Qwen3.8-27B');

  const shouty = {
    architecture: 'qwen35',
    kv: { ...QWEN_HEADER.kv, 'general.base_model.0.repo_url': 'https://huggingface.co/QWEN/qwen3.8-27b/' },
  };
  assert.equal(matchCompanionEntry({ header: shouty }, catalog).matchedBy, 'base_model');
});

test('matching by basename when the header names no base model', () => {
  const catalog = loadCompanionCatalog({ accelerationCatalog: ACCEL });
  const header = { architecture: 'gemma4', kv: { 'general.basename': 'gemma-4-12B-it' } };
  const found = matchCompanionEntry({ header, fileName: 'unrelated.gguf' }, catalog);
  assert.equal(found.entry.id, 'gemma-4-12b-it');
  assert.equal(found.matchedBy, 'basename');
  assert.equal(found.fineTune, false);
  // The 31B header names a base model and a differently cased basename.
  const big = matchCompanionEntry({
    header: {
      architecture: 'gemma4',
      kv: {
        'general.basename': 'Gemma-4-31B-It',
        'general.base_model.count': 1,
        'general.base_model.0.repo_url': 'https://huggingface.co/google/gemma-4-31B-it',
      },
    },
  }, catalog);
  assert.equal(big.entry.id, 'gemma-4-31b-it');
  assert.equal(big.fineTune, false);
});

test('matching by file family when the header cannot be read', () => {
  const catalog = loadCompanionCatalog({ accelerationCatalog: ACCEL });
  const found = matchCompanionEntry({ header: null, fileName: 'Qwen3.8-27B-UD-Q6_K.gguf' }, catalog);
  assert.equal(found.entry.id, 'qwen3.8-27b');
  assert.equal(found.matchedBy, 'file_family');
  assert.equal(found.fineTune, false);
  const gemma = matchCompanionEntry({ header: null, fileName: 'gemma-4-12B-it-qat-UD-Q4_K_XL.gguf' }, catalog);
  assert.equal(gemma.entry.id, 'gemma-4-12b-it');
  assert.equal(matchCompanionEntry({ header: null, fileName: 'Other-7B-Q4_K_M.gguf' }, catalog), null);
  assert.equal(matchCompanionEntry({ header: null }, catalog), null);
});

test('a fine-tune of a listed base model is matched and marked', () => {
  const catalog = loadCompanionCatalog({ accelerationCatalog: ACCEL });
  const header = {
    architecture: 'qwen35',
    kv: { ...QWEN_HEADER.kv, 'general.basename': 'Swift' },
  };
  const found = matchCompanionEntry({ header, fileName: 'Swift-1.5-Qwen3.8-27B-Q6_K.gguf' }, catalog);
  assert.equal(found.entry.id, 'qwen3.8-27b');
  assert.equal(found.matchedBy, 'base_model');
  assert.equal(found.fineTune, true);
  assert.equal(found.baseName, 'Qwen3.8-27B');
  // No basename at all is not evidence of a fine-tune.
  const unnamed = { architecture: 'qwen35', kv: { ...QWEN_HEADER.kv, 'general.basename': undefined } };
  assert.equal(matchCompanionEntry({ header: unnamed }, catalog).fineTune, false);
});

test('a fine-tune whose header names nothing is matched by the base name in its file name', () => {
  const catalog = loadCompanionCatalog({ accelerationCatalog: ACCEL });
  // Swift 1.5's real header: architecture qwen35, basename "Miroslav", no base_model keys.
  const swift = { architecture: 'qwen35', kv: { 'general.architecture': 'qwen35', 'general.basename': 'Miroslav' } };
  const found = matchCompanionEntry({ header: swift, fileName: 'Swift-1.5-Qwen3.8-27B-Q6_K_S.gguf' }, catalog);
  assert.equal(found.entry.id, 'qwen3.8-27b');
  assert.equal(found.matchedBy, 'file_name');
  assert.equal(found.fineTune, true);
  assert.equal(found.baseName, 'Qwen3.8-27B');
  for (const fileName of ['MyQwen3.8-27B-Q4.gguf', 'Qwen3.8-27Bx-Q4.gguf', 'Swift-1.5-Q6_K.gguf']) {
    assert.equal(matchCompanionEntry({ header: swift, fileName }, catalog), null, fileName);
  }
});

test('a different architecture never matches, even with a matching file name', () => {
  const catalog = loadCompanionCatalog({ accelerationCatalog: ACCEL });
  const header = { architecture: 'llama', kv: { ...QWEN_HEADER.kv } };
  assert.equal(matchCompanionEntry({ header, fileName: 'Qwen3.8-27B-UD-Q6_K.gguf' }, catalog), null);
  assert.equal(matchCompanionEntry({ header: { architecture: '', kv: {} }, fileName: 'Qwen3.8-27B.gguf' }, catalog), null);
});

test('a crafted header whose repo_url points elsewhere does not match', () => {
  const catalog = loadCompanionCatalog({ accelerationCatalog: ACCEL });
  const elsewhere = [
    'https://evil.example/Qwen/Qwen3.8-27B',
    'https://huggingface.co.evil.example/Qwen/Qwen3.8-27B',
    'http://huggingface.co/Qwen/Qwen3.8-27B',
    'https://huggingface.co/Qwen/Qwen3.8-27B?x=1',
    'https://huggingface.co/someone/Qwen3.8-27B',
    '../../Qwen/Qwen3.8-27B',
  ];
  for (const url of elsewhere) {
    const header = {
      architecture: 'qwen35',
      kv: { 'general.base_model.count': 1, 'general.base_model.0.repo_url': url, 'general.basename': 'Other' },
    };
    // A neutral file name: the base name in a file name is its own (fine-tune) match.
    assert.equal(matchCompanionEntry({ header, fileName: 'Other-Q4_K_M.gguf' }, catalog), null, url);
  }
  // Only the first eight base models are read.
  const kv = { 'general.base_model.count': 9, 'general.basename': 'Other' };
  for (let n = 0; n < 8; n += 1) kv[`general.base_model.${n}.repo_url`] = 'https://huggingface.co/a/b';
  kv['general.base_model.8.repo_url'] = 'https://huggingface.co/Qwen/Qwen3.8-27B';
  assert.equal(matchCompanionEntry({ header: { architecture: 'qwen35', kv } }, catalog), null);
});

test('companionDownloadUrl derives the URL from validated fields and encodes each segment', () => {
  const qwen = seed().entries[0];
  assert.equal(
    companionDownloadUrl(qwen.drafter),
    'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/4af51b3542f775b0a8e4b310bfb3f17e01c306c9/MTP/mtp-Qwen3.8-27B-Q4_0.gguf'
  );
  assert.equal(
    companionDownloadUrl(qwen.projector),
    'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/4af51b3542f775b0a8e4b310bfb3f17e01c306c9/mmproj-F16.gguf'
  );
  assert.equal(
    companionDownloadUrl({ repo: 'a/b', revision: 'c'.repeat(40), repoPath: 'dir/we ird#name.gguf' }),
    `https://huggingface.co/a/b/resolve/${'c'.repeat(40)}/dir/we%20ird%23name.gguf`
  );
});
