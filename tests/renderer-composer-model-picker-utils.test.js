const test = require('node:test');
const assert = require('node:assert/strict');

const utils = require('../renderer/chat/renderer-composer-model-picker-utils');

test('splitModelId parses prefixes, organizations, and compact tag heads', () => {
  assert.deepEqual(utils.splitModelId('  gemma4:12b-qat-ud-q4-k-xl  '), {
    id: 'gemma4:12b-qat-ud-q4-k-xl',
    family: 'gemma4',
    tag: '12b-qat-ud-q4-k-xl',
    tagHead: '12b-qat',
    org: '',
    engineHint: '',
  });
  assert.deepEqual(utils.splitModelId('hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS'), {
    id: 'hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS',
    family: 'Qwen3.6-35B-A3B-GGUF',
    tag: 'UD-IQ4_XS',
    tagHead: 'UD-IQ4_XS',
    org: 'unsloth',
    engineHint: 'huggingface',
  });
  assert.equal(utils.splitModelId('ornith15:9b-q6-256k').tagHead, '9b-q6');
  assert.equal(utils.splitModelId('qwen3.8:27b-ud-iq3-s').tagHead, '27b-ud');
  assert.equal(utils.splitModelId('model:latest').tagHead, 'latest');
  assert.equal(utils.splitModelId('model:27b').tagHead, '27b');
  assert.equal(utils.splitModelId('model').tagHead, '');
  assert.equal(utils.splitModelId('model:abcdefghijkl-zz').tagHead, 'abcdefghijkl');
  assert.equal(utils.splitModelId('model:abcdefghijkl--').tagHead, 'abcdefghijkl');
  assert.deepEqual(utils.splitModelId('CoDeX-ClI/gpt-5'), {
    id: 'CoDeX-ClI/gpt-5',
    family: 'gpt-5',
    tag: '',
    tagHead: '',
    org: '',
    engineHint: 'codex-cli',
  });
  const empty = { id: '', family: '', tag: '', tagHead: '', org: '', engineHint: '' };
  assert.deepEqual(utils.splitModelId('   '), empty);
  assert.deepEqual(utils.splitModelId(42), empty);
});

test('resolveModelGroup uses the contracted first-match ordering', () => {
  assert.deepEqual(utils.resolveModelGroup({ id: 'codex-cli/gpt-5', engineType: 'ollama' }), {
    key: 'codex-cli', label: 'Codex CLI', order: 50,
  });
  // An explicit engine beats the gpt-* name heuristic (gpt-oss:20b runs on Ollama).
  assert.deepEqual(utils.resolveModelGroup({ id: 'gpt-oss:20b', engineType: 'ollama' }), {
    key: 'ollama', label: 'Ollama', order: 10,
  });
  assert.deepEqual(utils.resolveModelGroup({ id: 'gpt-5.5' }), {
    key: 'chatgpt', label: 'ChatGPT', order: 40,
  });
  assert.deepEqual(utils.resolveModelGroup({ id: 'gpt-5.5', engineType: 'chatgpt' }), {
    key: 'chatgpt', label: 'ChatGPT', order: 40,
  });
  assert.deepEqual(utils.resolveModelGroup({ id: 'HF.CO/org/model', engineType: 'vllm' }), {
    key: 'huggingface', label: 'Hugging Face', order: 30,
  });
  assert.deepEqual(utils.resolveModelGroup({ engineType: ' OLLAMA ' }), {
    key: 'ollama', label: 'Ollama', order: 10,
  });
  assert.deepEqual(utils.resolveModelGroup({ engineType: 'vllm' }), {
    key: 'vllm', label: 'vLLM', order: 20,
  });
  assert.deepEqual(utils.resolveModelGroup({ engineType: 'openai-compatible' }), {
    key: 'openai-compatible', label: 'OpenAI-compatible', order: 25,
  });
  assert.deepEqual(utils.resolveModelGroup({ engineType: 'plugin_host' }), {
    key: 'plugins', label: 'Plugins', order: 60,
  });
  assert.deepEqual(utils.resolveModelGroup({}), {
    key: 'other', label: 'Other', order: 90,
  });
});

test('normalizeCatalogEntry normalizes metadata and strict capability flags', () => {
  const entry = utils.normalizeCatalogEntry({
    id: ' Model:Tag-One ',
    engineType: ' VLLM ',
    available: false,
    reason: ' offline ',
    size: 1024,
    parameter_size: '12B',
    quantization_level: 'Q6',
    capabilities: {
      vision: true,
      thinking: 'true',
      insert: true,
      default_reasoning_effort: ' HIGH ',
    },
  });
  assert.deepEqual(entry, {
    id: 'Model:Tag-One',
    engineType: 'vllm',
    available: false,
    reason: 'offline',
    sizeBytes: 1024,
    parameterSize: '12B',
    quantizationLevel: 'Q6',
    vision: true,
    thinking: false,
    insert: true,
    defaultReasoningEffort: 'high',
    loaded: false,
    family: 'Model',
    tag: 'Tag-One',
    tagHead: 'Tag-One',
    org: '',
    engineHint: '',
    group: { key: 'vllm', label: 'vLLM', order: 20 },
  });
  assert.deepEqual(
    utils.normalizeCatalogEntry({ id: 'plain', capabilities: { vision: 'true', insert: 'true' } }),
    {
      id: 'plain',
      engineType: '',
      available: true,
      reason: '',
      sizeBytes: 0,
      parameterSize: '',
      quantizationLevel: '',
      vision: false,
      thinking: false,
      insert: false,
      defaultReasoningEffort: '',
      loaded: false,
      family: 'plain',
      tag: '',
      tagHead: '',
      org: '',
      engineHint: '',
      group: { key: 'other', label: 'Other', order: 90 },
    },
  );
  // Provider catalogs (ChatGPT, Codex CLI) declare reasoning_effort without a
  // thinking flag; they still get the Thinking glyph.
  assert.equal(
    utils.normalizeCatalogEntry({ id: 'gpt-5.5', capabilities: { reasoning_effort: true } }).thinking,
    true,
  );
  assert.equal(utils.normalizeCatalogEntry({ id: '' }), null);
  assert.equal(utils.normalizeCatalogEntry(null), null);
});

test('groupCatalogEntries preserves entry order and sorts groups by priority', () => {
  const canonicalize = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized.includes(':') ? normalized : normalized + ':latest';
  };
  const groups = utils.groupCatalogEntries([
    'misc:model',
    { id: 'second', engine_type: 'ollama' },
    { id: 'hf.co/unsloth/Qwen:Q4', engineType: 'vllm' },
    { id: 'first', engine_type: 'ollama' },
    { id: 'gpt-5', engine_type: 'chatgpt' },
    { id: 'codex-cli/gpt-5', engine_type: 'ollama' },
    { id: 'plugin-model', engine_type: 'plugin_host' },
    { id: '   ' },
  ], { loadedModel: 'FIRST:LATEST', canonicalize });

  assert.deepEqual(groups.map((group) => group.key), [
    'ollama', 'huggingface', 'chatgpt', 'codex-cli', 'plugins', 'other',
  ]);
  assert.deepEqual(groups[0].entries.map((entry) => entry.id), ['second', 'first']);
  assert.equal(groups[0].entries[0].loaded, false);
  assert.equal(groups[0].entries[1].loaded, true);
  assert.deepEqual(utils.groupCatalogEntries('not-an-array'), []);
});

test('filterGroups filters without mutation and preserves identity for blank queries', () => {
  const groups = utils.groupCatalogEntries([
    { id: 'alpha-one', engine_type: 'ollama' },
    { id: 'beta-two', engine_type: 'ollama' },
    { id: 'gamma', engine_type: 'vllm' },
  ]);
  assert.strictEqual(utils.filterGroups(groups, '  '), groups);

  const filtered = utils.filterGroups(groups, ' TWO ');
  assert.notStrictEqual(filtered, groups);
  assert.deepEqual(filtered.map((group) => group.key), ['ollama']);
  assert.deepEqual(filtered[0].entries.map((entry) => entry.id), ['beta-two']);
  assert.deepEqual(groups[0].entries.map((entry) => entry.id), ['alpha-one', 'beta-two']);
  assert.deepEqual(utils.filterGroups(groups, 'missing'), []);
});

test('effortSegmentLabel maps known values and preserves unknown labels', () => {
  assert.deepEqual(
    ['', 'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(
      utils.effortSegmentLabel,
    ),
    ['Default', 'Default', 'Off', 'Min', 'Low', 'Med', 'High', 'X-high', 'Max'],
  );
  assert.equal(utils.effortSegmentLabel('  Custom  '), 'Custom');
});

test('formatComposerModelPillLabel covers model and effort display examples', () => {
  assert.equal(utils.formatComposerModelPillLabel({
    preferredModel: 'gemma4:12b-qat-ud-q4-k-xl',
  }), 'gemma4 · 12b-qat');
  assert.equal(utils.formatComposerModelPillLabel({
    preferredModel: 'qwen3.8:27b-ud-iq3-s', effort: 'high', effortSupported: true,
  }), 'qwen3.8 · 27b-ud · High');
  assert.equal(utils.formatComposerModelPillLabel({
    preferredModel: 'hf.co/unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ4_XS',
  }), 'Qwen3.6-35B-A3B-GGUF · UD-IQ4_XS');
  assert.equal(utils.formatComposerModelPillLabel({
    backendModel: 'ornith15:9b-q6-256k',
  }), 'Default · ornith15');
  assert.equal(utils.formatComposerModelPillLabel({
    preferredModel: 'gemma4:12b', effort: 'none', effortSupported: true,
  }), 'gemma4 · 12b · Off');
  assert.equal(utils.formatComposerModelPillLabel({
    preferredModel: 'gemma4:12b', effort: 'high', effortSupported: false,
  }), 'gemma4 · 12b');
  assert.equal(utils.formatComposerModelPillLabel({
    effort: 'high', effortSupported: true,
  }), 'Default · High');
});

test('buildPillTitle describes overrides, defaults, and supported thinking', () => {
  assert.equal(utils.buildPillTitle({
    preferredModel: 'gemma4:12b-qat-ud-q4-k-xl', effort: '', effortSupported: true,
  }), 'Model: gemma4:12b-qat-ud-q4-k-xl. Thinking: Default');
  assert.equal(utils.buildPillTitle({ backendModel: 'ornith15:9b-q6-256k' }),
    'Model: default (ornith15:9b-q6-256k)');
  assert.equal(utils.buildPillTitle({ effort: 'none', effortSupported: true }),
    'Model: default. Thinking: Off');
  assert.equal(utils.buildPillTitle({ effort: 'high', effortSupported: false }), 'Model: default');
});
