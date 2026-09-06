const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSpecTypeValues,
  parseServerBuild,
  probeCapabilities,
} = require('../services/backend/llama-server-capabilities');

const REAL_HELP = `--spec-type [none|ngram-cache|ngram-simple|ngram-map-k|ngram-map-k4v|ngram-mod]
                                        type of speculative decoding to use when no draft model is provided
                                        (default: none)
                                        (env: LLAMA_ARG_SPEC_TYPE)
`;
const REAL_SPEC_TYPES = [
  'none',
  'ngram-cache',
  'ngram-simple',
  'ngram-map-k',
  'ngram-map-k4v',
  'ngram-mod',
];
const DRAFT_MTP_HELP = '--spec-type\n  [none|ngram-cache|draft-mtp]\n';
const REAL_VERSION = `ggml_cuda_init: found 1 CUDA devices ...
version: 8846 (bcdcc1044)
built with Clang 19.1.5 for Windows x86_64
`;
// Verbatim from llama-server b10749 (dfc29b64e) --help: the choice list became
// a bare comma-separated multi-select with no brackets.
const B10749_HELP = `--spec-draft-model, -md, --model-draft FNAME
                                        draft model for speculative decoding (default: unused)
                                        (env: LLAMA_ARG_SPEC_DRAFT_MODEL)
--spec-type none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,draft-dspark,ngram-simple,ngram-map-k,ngram-map-k4v,ngram-mod,ngram-cache
                                        comma-separated list of types of speculative decoding to use (default:
                                        none)
                                        (env: LLAMA_ARG_SPEC_TYPE)
`;
const B10749_SPEC_TYPES = [
  'none', 'draft-simple', 'draft-eagle3', 'draft-mtp', 'draft-dflash', 'draft-dspark',
  'ngram-simple', 'ngram-map-k', 'ngram-map-k4v', 'ngram-mod', 'ngram-cache',
];
// Verbatim b10749 --version (STDERR, exit 0): semver first, build/commit in parens.
const B10749_VERSION = `ggml_cuda_init: found 1 CUDA devices (Total VRAM: 16275 MiB):
version: 0.3.0-dev (build 10749, commit dfc29b64e)
built with Clang 19.1.5 for Windows x86_64
`;

test('parseSpecTypeValues reads the wrapped build-8846 help text', () => {
  const values = parseSpecTypeValues(REAL_HELP);

  assert.deepEqual(values, REAL_SPEC_TYPES);
  assert.equal(values.includes('draft-mtp'), false);
});

test('parseSpecTypeValues treats CRLF and LF help text identically', () => {
  assert.deepEqual(parseSpecTypeValues(REAL_HELP.replaceAll('\n', '\r\n')), REAL_SPEC_TYPES);
});

test('parseSpecTypeValues detects draft-mtp in newer help text', () => {
  assert.deepEqual(parseSpecTypeValues(DRAFT_MTP_HELP), [
    'none',
    'ngram-cache',
    'draft-mtp',
  ]);
});

test('parseSpecTypeValues reads the bare comma list printed by build 10749', () => {
  const values = parseSpecTypeValues(B10749_HELP);

  assert.deepEqual(values, B10749_SPEC_TYPES);
  assert.equal(values.includes('draft-mtp'), true);
  assert.deepEqual(parseSpecTypeValues(B10749_HELP.replaceAll('\n', '\r\n')), B10749_SPEC_TYPES);
});

test('parseSpecTypeValues never reads a placeholder or description as values', () => {
  // Uppercase placeholder on the flag line: fail closed.
  assert.deepEqual(parseSpecTypeValues('--spec-type TYPE\n  type of speculative decoding\n'), []);
  // No value on the flag line: the description on the next line is NOT a list.
  assert.deepEqual(parseSpecTypeValues('--spec-type\n  type of speculative decoding\n'), []);
  // The wrapped BRACKETED form is still accepted across the line break.
  assert.deepEqual(parseSpecTypeValues('--spec-type\n  [none|draft-mtp]\n'), ['none', 'draft-mtp']);
});

test('parseServerBuild reads the build-10749 semver layout', () => {
  assert.deepEqual(parseServerBuild(B10749_VERSION), {
    build: 10749,
    commit: 'dfc29b64e',
  });
  // A banner without the commit clause still yields the build number.
  assert.deepEqual(parseServerBuild('version: 0.3.0-dev (build 10749)\n'), {
    build: 10749,
    commit: '',
  });
});

test('parseSpecTypeValues only reads the option definition line, never a prose mention', () => {
  // A cross-reference inside another option's description precedes the real
  // definition — both layouts must skip it and read the definition.
  assert.deepEqual(
    parseSpecTypeValues('  ignored unless --spec-type draft-simple is set\n--spec-type none,draft-simple,draft-mtp,ngram-cache\n'),
    ['none', 'draft-simple', 'draft-mtp', 'ngram-cache']
  );
  assert.deepEqual(
    parseSpecTypeValues('  see --spec-type below\n--spec-type [none|draft-mtp]\n'),
    ['none', 'draft-mtp']
  );
});

test('parseSpecTypeValues survives a wrapped bare list and a short-alias layout', () => {
  // Wrapped after a separator: the continuation line is part of the list.
  assert.deepEqual(
    parseSpecTypeValues('--spec-type none,draft-simple,\n                                        draft-mtp,ngram-cache\n  comma-separated list\n'),
    ['none', 'draft-simple', 'draft-mtp', 'ngram-cache']
  );
  // Short alias printed llama.cpp-style (`--spec-draft-model, -md, --model-draft`).
  assert.deepEqual(
    parseSpecTypeValues('--spec-type, -st none,draft-mtp,ngram-cache\n'),
    ['none', 'draft-mtp', 'ngram-cache']
  );
});

test('parseSpecTypeValues keeps draft-mtp when the list is long', () => {
  const many = Array.from({ length: 40 }, (_, i) => `ngram-x${i}`).concat(['draft-mtp']);
  assert.equal(parseSpecTypeValues(`--spec-type ${many.join(',')}\n`).includes('draft-mtp'), true);
});

test('parseSpecTypeValues rejects missing and malformed input', () => {
  assert.deepEqual(parseSpecTypeValues('usage: llama-server'), []);
  assert.deepEqual(parseSpecTypeValues(null), []);
});

test('parseSpecTypeValues drops illegal entries without dropping valid siblings', () => {
  assert.deepEqual(
    parseSpecTypeValues('--spec-type [none|DRAFT_MTP!|draft-mtp]'),
    ['none', 'draft-mtp']
  );
});

test('parseServerBuild reads the build and commit from mixed version output', () => {
  assert.deepEqual(parseServerBuild(REAL_VERSION), {
    build: 8846,
    commit: 'bcdcc1044',
  });
  assert.deepEqual(parseServerBuild('garbage'), { build: 0, commit: '' });
});

test('probeCapabilities fails closed when the help command throws', () => {
  const result = probeCapabilities({
    binaryPath: 'throwing-llama-server.exe',
    execFileSyncImpl: () => {
      throw new Error('command failed');
    },
    fsImpl: { statSync: () => ({ mtimeMs: 1, size: 2 }) },
  });

  assert.equal(result.ok, false);
  assert.equal(result.supportsMtp, false);
  assert.match(result.reason, /^probe_failed:/);
});

test('probeCapabilities reports live draft-mtp support and version provenance', () => {
  const execCalls = [];
  const spawnCalls = [];
  const result = probeCapabilities({
    binaryPath: 'draft-mtp-llama-server.exe',
    execFileSyncImpl: (binaryPath, args, options) => {
      execCalls.push({ binaryPath, args, options });
      return DRAFT_MTP_HELP;
    },
    // The real binary prints the version banner to STDERR and exits 0 —
    // execFileSync would return only the empty stdout, which is why the
    // implementation must use spawnSync for this half.
    spawnSyncImpl: (binaryPath, args, options) => {
      spawnCalls.push({ binaryPath, args, options });
      return { status: 0, stdout: '', stderr: REAL_VERSION };
    },
    fsImpl: { statSync: () => ({ mtimeMs: 3, size: 4 }) },
  });

  assert.equal(result.ok, true);
  assert.equal(result.supportsMtp, true);
  assert.equal(result.build, 8846);
  assert.equal(result.commit, 'bcdcc1044');
  assert.deepEqual(execCalls.map((call) => call.args), [['--help']]);
  assert.deepEqual(spawnCalls.map((call) => call.args), [['--version']]);
  assert.deepEqual(execCalls[0].options, {
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
  });
});

test('probeCapabilities keeps the probe ok when the version command throws', () => {
  const result = probeCapabilities({
    binaryPath: 'version-throwing-llama-server.exe',
    execFileSyncImpl: () => REAL_HELP,
    spawnSyncImpl: () => {
      throw new Error('spawn failed');
    },
    fsImpl: { statSync: () => ({ mtimeMs: 5, size: 6 }) },
  });

  assert.equal(result.ok, true);
  assert.equal(result.build, 0);
  assert.equal(result.commit, '');
});

test('probeCapabilities memoizes by binary mtime and size', () => {
  let mtimeMs = 7;
  let helpCalls = 0;
  let versionCalls = 0;
  const options = {
    binaryPath: 'memoized-llama-server.exe',
    execFileSyncImpl: () => {
      helpCalls += 1;
      return DRAFT_MTP_HELP;
    },
    spawnSyncImpl: () => {
      versionCalls += 1;
      return { status: 0, stdout: '', stderr: REAL_VERSION };
    },
    fsImpl: { statSync: () => ({ mtimeMs, size: 8 }) },
  };

  probeCapabilities(options);
  probeCapabilities(options);
  assert.equal(helpCalls, 1);
  assert.equal(versionCalls, 1);

  mtimeMs += 1;
  probeCapabilities(options);
  assert.equal(helpCalls, 2);
  assert.equal(versionCalls, 2);
});

test('probeCapabilities fails closed without a binary path', () => {
  const result = probeCapabilities({});

  assert.equal(result.ok, false);
  assert.equal(result.supportsMtp, false);
  assert.equal(result.reason, 'probe_failed:no_binary');
});

test('parseSpecTypeValues rejects a single token followed by same-line prose', () => {
  // Codex second-model review (W0): a lone lowercase word before description
  // text on the flag line must not become an advertised spec type.
  assert.deepEqual(parseSpecTypeValues('  --spec-type draft-mtp support requires a compatible model\n'), []);
  assert.deepEqual(parseSpecTypeValues('  --spec-type none,draft-mtp   \n  comma-separated list\n'), ['none', 'draft-mtp']);
});
