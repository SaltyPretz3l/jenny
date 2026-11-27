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
  assert.deepEqual(utils.resolveModelGroup({ engineType: 'openai-compatible', managed: 'ninfer' }), {
    key: 'ninfer', label: 'NInfer', order: 22,
  });
  assert.deepEqual(utils.resolveModelGroup({ engineType: 'openai-compatible', managed: 'llama-server' }), {
    key: 'llama-server', label: 'llama-server', order: 23,
  });
  // The marker only names a runtime for an openai-compatible entry.
  assert.deepEqual(utils.resolveModelGroup({ engineType: 'ollama', managed: 'ninfer' }), {
    key: 'ollama', label: 'Ollama', order: 10,
  });
  assert.equal(utils.normalizeCatalogEntry({ id: 'n', engine_type: 'openai-compatible', managed: 'ninfer' }).group.key, 'ninfer');
  assert.deepEqual(utils.resolveModelGroup({ engineType: 'plugin_host' }), {
    key: 'other', label: 'Other', order: 90,
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
    hint: '',
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
      hint: '',
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
    { id: '   ' },
  ], { loadedModel: 'FIRST:LATEST', canonicalize });

  assert.deepEqual(groups.map((group) => group.key), [
    'ollama', 'huggingface', 'chatgpt', 'codex-cli', 'other',
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
  assert.equal(utils.buildPillTitle({ backendModel: 'qwen3:27b', defaultLocal: true, loadedModel: 'qwen3:27b' }), 'Default: qwen3:27b, on this PC');
  assert.equal(utils.buildPillTitle({ backendModel: 'qwen3:27b', defaultLocal: true, loadedModel: 'other' }),
    'Default: qwen3:27b, on this PC. Jenny loads it with your next message', 'row 194: says when the default still has to load');
});

test('resolveDefaultChatModel names the Settings default under any engine, else the loaded model', () => {
  const state = {
    status: { model: 'ornith15:9b-q6-256k', engine: 'ollama' },
    offline: { preferredLocalModel: 'qwen3.8-27b-nvfp4' },
    modelList: { data: [{ id: 'ornith15:9b-q6-256k', engine_type: 'ollama' }, { id: 'qwen3.8-27b-nvfp4', engine_type: 'openai-compatible' }] },
  };
  assert.deepEqual(utils.resolveDefaultChatModel(state), { model: 'qwen3.8-27b-nvfp4', engineType: 'openai-compatible' });
  assert.deepEqual(
    utils.resolveDefaultChatModel({ ...state, modelList: { data: [{ id: 'ornith15:9b-q6-256k' }] } }),
    { model: 'qwen3.8-27b-nvfp4', engineType: '' },
    'an unlisted default (NInfer while Ollama runs) is still the default'
  );
  assert.deepEqual(
    utils.resolveDefaultChatModel({ ...state, status: { model: 'gpt-6', engine: 'chatgpt' } }),
    { model: 'qwen3.8-27b-nvfp4', engineType: 'openai-compatible' },
    'row 194: cloud engine current, Default chat resolves to the Settings default'
  );
  assert.deepEqual(utils.resolveDefaultChatModel({ ...state, offline: {} }), { model: 'ornith15:9b-q6-256k', engineType: 'ollama' });
  assert.deepEqual(utils.resolveDefaultChatModel(null), { model: '', engineType: '' });
});

test('no default under a cloud engine: the pill names the local model the backend takes, else stays cloud (owner 2026-11-26)', () => {
  const data = [{ id: 'gpt-6', engine_type: 'chatgpt' }, { id: 'ornith-1.5-9b', engine_type: 'openai-compatible' }];
  const cloud = { status: { model: 'gpt-6', engine: 'chatgpt' }, offline: {}, modelList: { data, default_local_fallback: 'ornith-1.5-9b' } };
  assert.deepEqual(utils.resolveDefaultChatModel(cloud), { model: 'ornith-1.5-9b', engineType: 'openai-compatible' });
  assert.equal(utils.describeCloudPill({}, cloud), null, 'the turn runs on this PC, so the pill does not say cloud');
  const none = { ...cloud, modelList: { data } };
  assert.deepEqual(utils.resolveDefaultChatModel(none), { model: 'gpt-6', engineType: 'chatgpt' });
  assert.ok(utils.describeCloudPill({}, none), 'nothing on this PC can serve it: the turn and the pill stay cloud');
  const local = { status: { model: 'qwen3:8b', engine: 'ollama' }, offline: {}, modelList: { data, default_local_fallback: 'ornith-1.5-9b' } };
  assert.deepEqual(utils.resolveDefaultChatModel(local), { model: 'qwen3:8b', engineType: 'ollama' }, 'a local engine keeps its loaded model');
});

test('row 123: a team model sits in its team group with the notice, and the pill shows the team model id', () => {
  const notice = 'The team’s host and the person whose hardware responds can read your prompts and replies.';
  const team = { id: 'team/team_alpha1/qwen3:8b-q4', engine_type: 'openai-compatible', team_id: 'team_alpha1',
    team_name: 'Alpha crew' };
  const entry = utils.normalizeCatalogEntry(team);
  assert.deepEqual(entry.group, { key: 'team:team_alpha1', label: 'Alpha crew', order: 65 });
  assert.equal(entry.hint, '', 'no per-row notice; the picker draws it once per group');
  const section = utils.groupSectionHtml({ key: entry.group.key, label: 'Alpha crew', entries: [entry] }, '<i>rows</i>', { showHeading: true, id: 'g0', escapeHtml: (v) => String(v) });
  assert.equal(section.split(notice).length - 1, 1, 'the group section carries the notice once');
  assert.equal(utils.groupSectionHtml({ key: 'ollama', label: 'Ollama', entries: [] }, '<i>rows</i>', { showHeading: false, id: 'g1', escapeHtml: (v) => String(v) }), '<i>rows</i>', 'a local group is unchanged');
  assert.deepEqual([entry.family, entry.tag, entry.engineHint], ['qwen3', '8b-q4', 'team']);
  assert.equal(utils.normalizeCatalogEntry({ ...team, team_name: '' }).group.label, 'Unnamed team', 'never the raw team id');
  // A local model of the same name stays in its own group with no notice.
  const local = utils.normalizeCatalogEntry({ id: 'qwen3:8b-q4', engine_type: 'ollama' });
  assert.deepEqual([local.group.key, local.hint], ['ollama', '']);
  const groups = utils.groupCatalogEntries([team, { id: 'qwen3:8b-q4', engine_type: 'ollama' },
    { ...team, id: 'team/team_bravo2/qwen3:8b-q4', team_id: 'team_bravo2', team_name: 'Bravo crew' }]);
  assert.deepEqual(groups.map((group) => group.key), ['ollama', 'team:team_alpha1', 'team:team_bravo2']);
  assert.equal(utils.formatComposerModelPillLabel({ preferredModel: team.id }), 'qwen3 · 8b-q4');
  // Only a well-formed team id is unwrapped; any other id keeps its name.
  assert.equal(utils.splitModelId('team/alpha/x').family, 'team/alpha/x');
});

// Row 144: the size rule is ported from services/model-size-class.js (the renderer cannot load services/).
// These are the same cases tests/model-size-class.test.js uses, so the two cannot drift silently.
test('row 144: the size rule matches the backend rule for names, labels, MoE, cloud and unknown', () => {
  assert.equal(utils.sizeFromText('Qwen3.8-27B-Q4_K_M'), 27);
  assert.equal(utils.sizeFromText('qwen3.6:35b-a3b'), 35);
  assert.equal(utils.sizeFromText('mixtral-8x7B'), 56);
  assert.equal(utils.sizeFromText('model-latest'), null);
  assert.equal(utils.sizeFromLabel('27.8B'), 27.8);
  assert.equal(utils.sizeFromLabel('670M'), 0.67);
  assert.equal(utils.sizeFromLabel('35B-A3B'), 35);
  assert.equal(utils.sizeFromLabel('8x7B'), 56);
  assert.equal(utils.sizeFromLabel(''), null);
  const fit = (input) => utils.classifyCheckModel(input);
  assert.deepEqual(fit({ model: 'qwen3:8b', engineType: 'ollama', parameterSize: '8.2B' }), { fit: true, params_b: 8.2, source: 'engine' });
  assert.equal(fit({ model: 'lfm3:2b', engineType: 'ollama', parameterSize: '2.6B' }).fit, false);
  assert.equal(fit({ model: 'gemma4-e4b' }).fit, false, 'no token: unknown size is too small');
  assert.deepEqual(fit({ model: 'mystery' }), { fit: false, params_b: null, source: 'unknown' });
  assert.equal(fit({ model: 'qwen3.6:35b-a3b' }).fit, true, 'a MoE counts by its total size');
  assert.equal(fit({ model: 'gpt-6', engineType: 'chatgpt' }).fit, true);
  assert.equal(fit({ model: 'x', engineType: 'codex-cli' }).fit, true);
  assert.equal(fit({ model: 'y', engineType: 'api-provider' }).fit, true);
  assert.equal(fit({ model: 'qwen3-7b' }).fit, true, '7B is the floor itself');
});

test('row 144: the pin applies only to the Jenny chat session while the store is ready', () => {
  const ready = { status: 'ready', session_id: 'p', model: ' qwen3:27b ' };
  assert.equal(utils.resolvePinnedModel(ready, 'p'), 'qwen3:27b');
  assert.equal(utils.resolvePinnedModel(ready, 'other'), '');
  assert.equal(utils.resolvePinnedModel(ready, ''), '');
  assert.equal(utils.resolvePinnedModel({ ...ready, model: '' }, 'p'), '');
  assert.equal(utils.resolvePinnedModel({ ...ready, status: 'unavailable' }, 'p'), '');
  assert.equal(utils.resolvePinnedModel({ ...ready, model: 7 }, 'p'), '');
  assert.equal(utils.resolvePinnedModel(null, 'p'), '');
});

test('row 144: the ported size rule answers exactly what the backend rule answers on a shared case table', () => {
  const backend = require('../services/model-size-class');
  const cases = [
    { model: 'gemma3:2b', parameterSize: '2.6B' }, { model: 'qwen3.8:27b', parameterSize: '27.8B' },
    { model: 'my-70b-merge', parameterSize: '3.2B' }, { model: 'tiny', parameterSize: '670M' },
    { model: 'qwen3.6:35b-a3b' }, { model: 'mixtral', parameterSize: '8x7B' }, { model: 'lfm3-omni-2b' },
    { model: 'hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M' }, { model: 'gemma4-e4b' }, { model: 'gpt-oss-120b' },
    { model: 'qwen3.8:q4_k_m' }, { model: 'model-bf16' }, { model: 'gpt-6', engineType: 'chatgpt' },
    { model: 'gpt-6', engineType: 'CODEX-CLI' }, { model: 'm', engineType: 'api-provider' },
    { model: 'lfm3-omni-2b', engineType: 'openai-compatible' }, { model: '', parameterSize: '' },
  ];
  for (const input of cases) {
    assert.deepEqual(utils.classifyCheckModel(input), backend.classifyModelSize(input), JSON.stringify(input));
  }
});

test('an API-provider model shows its own name, not the namespaced id', () => {
  const id = 'api-provider/anthropic-api/claude-haiku-5-5';
  assert.equal(utils.displayModelId(id), 'claude-haiku-5-5');
  assert.equal(utils.displayModelId('api-provider/openrouter/openai/gpt-6-luna'), 'openai/gpt-6-luna');
  assert.equal(utils.displayModelId('qwen3.8:27b-ud-iq3-s'), 'qwen3.8:27b-ud-iq3-s');
  // Only a well-formed provider id is unwrapped.
  assert.equal(utils.displayModelId('api-provider/claude-haiku-5-5'), 'api-provider/claude-haiku-5-5');
  assert.equal(utils.formatComposerModelPillLabel({ backendModel: id }), 'Default \u00b7 claude-haiku-5-5');
  assert.equal(
    utils.formatComposerModelPillLabel({ preferredModel: id, effort: 'high', effortSupported: true }),
    'claude-haiku-5-5 \u00b7 High',
  );
  assert.equal(utils.buildPillTitle({ backendModel: id }), 'Model: default (claude-haiku-5-5)');
  assert.equal(utils.buildPillTitle({ preferredModel: id }), 'Model: claude-haiku-5-5');
});

test('a model that cannot turn thinking off shows Min where others show Off', () => {
  assert.equal(utils.effortSegmentLabel('none', 'Minimal'), 'Min');
  assert.equal(utils.effortSegmentLabel('none', 'None'), 'Off');
  const inputs = {
    preferredModel: 'gemma4:12b',
    effort: 'none',
    effortSupported: true,
    effortOptions: [{ value: 'default', label: 'Use default' }, { value: 'none', label: 'Minimal' }],
  };
  assert.equal(utils.formatComposerModelPillLabel(inputs), 'gemma4 \u00b7 12b \u00b7 Min');
  assert.equal(utils.buildPillTitle(inputs), 'Model: gemma4:12b. Thinking: Min');
});

// Row 201 C1 / OD-1: a team model is a third source class; one predicate, a formatted name, never a local default.
test('isTeamModel is the one predicate for a team id or a catalog entry carrying team_id', () => {
  assert.equal(utils.isTeamModel('team/team_alpha1/qwen3:8b'), true);
  assert.equal(utils.isTeamModel({ id: 'qwen3:8b', team_id: 'team_alpha1' }), true);
  assert.equal(utils.isTeamModel({ id: 'team/team_alpha1/qwen3:8b' }), true);
  for (const value of ['team/alpha/x', 'qwen3:8b', 'api-provider/openrouter/x', '', null, undefined, { id: 'qwen3:8b' }]) {
    assert.equal(utils.isTeamModel(value), false, String(value));
  }
});

test('a team model shows its own model name, never the raw team/<teamId>/<modelId>, and its group is never the raw team id', () => {
  assert.equal(utils.displayModelId('team/team_alpha1/qwen3:8b-q4'), 'qwen3:8b-q4');
  assert.equal(utils.displayModelId('team/alpha/x'), 'team/alpha/x', 'a malformed id keeps its name');
  assert.match(utils.buildPillTitle({ preferredModel: 'team/team_alpha1/qwen3:8b-q4' }), /^Model: qwen3:8b-q4$/);
  const entry = utils.normalizeCatalogEntry({ id: 'team/team_alpha1/qwen3:8b-q4', engine_type: 'openai-compatible', team_id: 'team_alpha1' });
  assert.equal(entry.group.label, 'Unnamed team');
  assert.deepEqual([entry.family, entry.tag, entry.engineHint], ['qwen3', '8b-q4', 'team']);
});

test('a saved team id in the local default slot is no default: a Default chat reads as unset', () => {
  const state = { offline: { preferredLocalModel: 'team/team_alpha1/qwen3:8b' }, status: { model: 'ornith15:9b-q6-256k', engine: 'ollama' },
    modelList: { data: [{ id: 'team/team_alpha1/qwen3:8b', engine_type: 'openai-compatible', team_id: 'team_alpha1' }] } };
  assert.deepEqual(utils.resolveDefaultChatModel(state), { model: 'ornith15:9b-q6-256k', engineType: 'ollama' });
});
