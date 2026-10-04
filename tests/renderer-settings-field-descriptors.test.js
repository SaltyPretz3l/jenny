'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const descriptors = require('../renderer/shell/renderer-settings-field-descriptors.js');
const fieldCopy = require('../renderer/shell/renderer-settings-field-copy.js');
const registry = require('../renderer/shell/renderer-settings-section-registry.js');
const schema = require('../renderer/shared/engine-tuning-schema.js');

const all = descriptors.listSettingDescriptors();

test('every descriptor names a registry section, a unique control id, a persistence owner and resolvable copy', () => {
  const sectionIds = new Set(registry.getSettingsSections().map((section) => section.id));
  const controlIds = new Map();
  assert.ok(all.length >= 90, `expected the full preference table, got ${all.length}`);
  for (const descriptor of all) {
    assert.ok(sectionIds.has(descriptor.sectionId), `${descriptor.id}: section "${descriptor.sectionId}" is not a registry section`);
    assert.ok(descriptors.KINDS.includes(descriptor.kind), `${descriptor.id}: kind`);
    assert.ok(descriptor.adapterId && descriptor.key, `${descriptor.id}: adapterId + key`);
    for (const controlId of [descriptor.controlId]) {
      assert.equal(controlIds.get(controlId), undefined, `${descriptor.id}: control id "${controlId}" already used by ${controlIds.get(controlId)}`);
      controlIds.set(controlId, descriptor.id);
    }
    if (typeof descriptor.copy === 'string') {
      const entry = fieldCopy.getSettingsFieldCopy(descriptor.copy.slice('field-copy:'.length));
      assert.ok(entry && entry.label, `${descriptor.id}: field-copy reference "${descriptor.copy}" does not resolve`);
      assert.equal(entry.sectionId, descriptor.sectionId, `${descriptor.id}: copy section must match`);
    } else {
      assert.ok(descriptor.copy.label.trim(), `${descriptor.id}: inline copy needs a label`);
    }
    assert.equal(descriptors.getSettingDescriptorByControlId(descriptor.controlId), descriptor);
  }
});

test('the control follows the value type unless an override states its reason', () => {
  for (const descriptor of all) {
    const derived = descriptors.resolveControlKind(descriptor);
    if (descriptor.control !== derived) {
      assert.ok(descriptor.controlReason, `${descriptor.id}: control "${descriptor.control}" differs from "${derived}" without a reason`);
    }
    if (descriptor.kind === 'boolean') assert.equal(descriptor.control, 'toggle', `${descriptor.id}: booleans are toggles, never Off/On selects`);
  }
  assert.equal(descriptors.resolveControlKind({ kind: 'enum', options: [{ value: 'a' }, { value: 'b' }] }), 'segmented');
  assert.equal(descriptors.resolveControlKind({ kind: 'enum', options: [1, 2, 3, 4, 5].map((value) => ({ value })) }), 'select');
  assert.equal(descriptors.resolveControlKind({ kind: 'enum', options: 'source:palettes' }), 'select');
  assert.equal(descriptors.resolveControlKind({ kind: 'optionalInteger' }), 'optionalNumber');
});

test('the Off/On selects and the personality search ghost are gone; the 24-hour row is a toggle', () => {
  assert.equal(descriptors.getSettingDescriptor('use24HourTime').control, 'toggle');
  assert.equal(descriptors.getSettingDescriptor('use24HourTime').controlId, 'use24HourTimeToggle');
  assert.equal(fieldCopy.getSettingsFieldCopy('use24HourTimeSelect'), null);
  assert.equal(fieldCopy.getSettingsFieldCopy('personalityResetButton'), null);
  assert.equal(descriptors.getSettingDescriptor('unattendedGuardMinutesInput').control, 'choice');
  assert.equal(descriptors.getSettingDescriptor('homeContextualTipsToggle'), null, 'the contextual-tips control is retired (checkpoint 1, D2)');
});

test('hydration normalizes without clamping and preserves zero, Off and Auto', () => {
  const cap = descriptors.getSettingDescriptor('autoApproveStreakCapInput');
  assert.equal(descriptors.normalizeSettingValue(cap, 999), 50, 'out of range falls back to the default, never clamps');
  assert.equal(descriptors.normalizeSettingValue(cap, 0), 0, 'zero is a value, not a missing one');
  assert.equal(descriptors.normalizeSettingValue(cap, '7'), 50, 'strings are not numbers');
  const guard = descriptors.getSettingDescriptor('unattendedGuardMinutesInput');
  assert.equal(descriptors.normalizeSettingValue(guard, 0), 0, 'Off survives');
  assert.equal(descriptors.normalizeSettingValue(guard, 45), 45);
  assert.equal(descriptors.normalizeSettingValue(guard, 1000), 0);
  const mode = descriptors.getSettingDescriptor('safetyModeSelect');
  assert.equal(descriptors.normalizeSettingValue(mode, 'bogus'), 'normal');
  assert.equal(descriptors.normalizeSettingValue(mode, 'strict'), 'strict');
  const flag = descriptors.getSettingDescriptor('notificationsSoundToggle');
  assert.equal(descriptors.normalizeSettingValue(flag, 'yes'), true);
  assert.equal(descriptors.normalizeSettingValue(flag, false), false);
  const ratio = descriptors.getSettingDescriptor('advancedTuningField-tokenBudgetWarningRatio');
  assert.equal(descriptors.normalizeSettingValue(ratio, null), null, 'Auto stays Auto');
  assert.equal(descriptors.normalizeSettingValue(ratio, 0.5), 0.5);
});

test('edits validate and are rejected with a field error, never coerced', () => {
  const cap = descriptors.getSettingDescriptor('autoApproveStreakCapInput');
  assert.deepEqual(descriptors.validateSettingValue(cap, 75), { ok: true, value: 75 });
  const tooBig = descriptors.validateSettingValue(cap, 501);
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /1 to 500/);
  assert.equal(descriptors.validateSettingValue(cap, 7.5).ok, false, 'integers reject fractions');
  assert.equal(descriptors.validateSettingValue(cap, NaN).ok, false);
  const ratio = descriptors.getSettingDescriptor('advancedTuningField-tokenBudgetWarningRatio');
  assert.deepEqual(descriptors.validateSettingValue(ratio, 0.85), { ok: true, value: 0.85 });
  assert.match(descriptors.validateSettingValue(ratio, 2).error, /10 to 99/);
  const mode = descriptors.getSettingDescriptor('safetyModeSelect');
  assert.equal(descriptors.validateSettingValue(mode, 'lenient').ok, false);
  const guard = descriptors.getSettingDescriptor('unattendedGuardMinutesInput');
  assert.deepEqual(descriptors.validateSettingValue(guard, 0), { ok: true, value: 0 });
  assert.equal(descriptors.validateSettingValue(guard, 121).ok, false);
});

test('Modified and the default meta follow the owner semantics', () => {
  const cap = descriptors.getSettingDescriptor('autoApproveStreakCapInput');
  assert.equal(descriptors.isSettingModified(cap, 50), false);
  assert.equal(descriptors.isSettingModified(cap, 0), true);
  assert.equal(descriptors.describeSettingDefaultValue(cap), '50');
  const auto = descriptors.getSettingDescriptor('advancedTuningField-tokenBudgetWarningRatio');
  assert.equal(descriptors.isSettingModified(auto, null), false, 'no override means not modified');
  assert.equal(descriptors.isSettingModified(auto, 0.7), true, 'an override present means modified');
  assert.equal(descriptors.describeSettingDefaultValue(auto), 'Auto');
  assert.equal(descriptors.getSettingDescriptor('advancedTuningField-maxBudgetUsd'), null);
  assert.equal(descriptors.describeSettingDefaultValue(descriptors.getSettingDescriptor('advancedTuningField-maxToolsPerTurn')), '20');
  assert.equal(descriptors.describeSettingDefaultValue(descriptors.getSettingDescriptor('safetyModeSelect')), 'Normal', 'enum defaults show the option label');
  assert.equal(descriptors.describeSettingDefaultValue(descriptors.getSettingDescriptor('notificationsSoundToggle')), '', 'booleans carry no meta');
  const limit = descriptors.getSettingDescriptor('runtime_limit_local_runnable_turns');
  assert.equal(descriptors.describeSettingDefaultValue(limit), '', 'an adapter-sourced default is unknown until hydrated');
  assert.equal(descriptors.describeSettingDefaultValue(limit, 4), '4');
  assert.equal(descriptors.isSettingModified(limit, 9), false, 'the adapter decides');
});

test('Advanced search stubs mirror the engine-tuning schema while taking display units and copy from the page', () => {
  const retired = ['maxLoopIterations', 'tokenBudgetReservedForSummary', 'tokenBudgetToolOverhead', 'tokenBudgetAutoCompactRatio', 'maxBudgetUsd'];
  for (const key of retired) assert.equal(descriptors.getSettingDescriptor('advancedTuningField-' + key), null);
  for (const field of schema.ENGINE_TUNING_FIELDS.filter(field => !retired.includes(field.key))) {
    const stub = descriptors.getSettingDescriptor('advancedTuningField-' + field.key);
    assert.ok(stub, `${field.key}: stub missing`);
    assert.equal(stub.searchOnly, true);
    assert.equal(stub.sectionId, 'advanced');
    assert.equal(stub.default, field.default, `${field.key}: default`);
    assert.equal(stub.validation.min, field.min, `${field.key}: min`);
    assert.equal(stub.validation.max, field.max, `${field.key}: max`);
    assert.equal(stub.validation.step, field.step, `${field.key}: step`);
    const units = { seconds: 'sec', calls: '', rounds: '', agents: '', bytes: 'KB', ratio: '%' };
    assert.equal(stub.presentation.unit, field.key === 'maxLoopWallSeconds' ? 'min' : (units[field.unit] ?? field.unit));
    assert.equal(stub.kind, field.type === 'number' ? 'decimal' : 'integer', `${field.key}: kind follows the schema type`);
    assert.deepEqual(stub.presentation.presets.map(pick => pick.value), field.presets.map(pick => pick.value));
    assert.ok(stub.copy.label);
  }
  const stubs = descriptors.listSettingDescriptors({ sectionId: 'advanced', searchOnly: true });
  assert.equal(stubs.length, schema.ENGINE_TUNING_FIELDS.length - retired.length + 11, 'engine stubs plus limit stubs');
  assert.equal(descriptors.listSettingDescriptors({ sectionId: 'runtimeLimits' }).length, 0);
  const limit = descriptors.getSettingDescriptor('runtime_limit_resources_tests');
  assert.equal(descriptors.isSettingModified(limit, 4), false, 'adapter-sourced default unknown: never Modified');
  assert.equal(descriptors.isSettingModified(limit, 4, 4), false, 'equal to the live default');
  assert.equal(descriptors.isSettingModified(limit, 6, 4), true, 'differs from the live default');
});

test('the search projection includes every descriptor once and reaches Advanced and Runtime limits', () => {
  const entries = fieldCopy.listSettingsSearchEntries();
  const ids = entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'entries are deduplicated by id');
  for (const descriptor of all) {
    assert.ok(ids.includes(descriptor.controlId), `${descriptor.id}: not searchable`);
  }
  const cloud = entries.find((entry) => entry.id === 'advancedTuningField-cloudMaxToolsPerTurn');
  assert.equal(cloud.label, 'Tool calls per reply, Cloud');
  assert.equal(entries.find((entry) => entry.id === 'runtime_limit_resources_tests').sectionId, 'advanced');
  assert.equal(ids.includes('personalityResetButton'), false);
  assert.ok(ids.includes('saveLocalProfileButton'), 'legacy action entries stay searchable');
});

test('defineSettingDescriptor rejects malformed descriptors', () => {
  const base = { sectionId: 'tools', kind: 'integer', default: 1, adapterId: 'x', key: 'k', copy: { label: 'L' } };
  assert.throws(() => descriptors.defineSettingDescriptor({ ...base, id: 'autoApproveStreakCapInput' }), /duplicate/);
  assert.throws(() => descriptors.defineSettingDescriptor({ ...base, id: 't1', kind: 'float' }), /unknown kind/);
  assert.throws(() => descriptors.defineSettingDescriptor({ ...base, id: 't2', control: 'select' }), /controlReason/);
  assert.throws(() => descriptors.defineSettingDescriptor({ ...base, id: 't3', default: null }), /defaultLabel/);
  assert.throws(() => descriptors.defineSettingDescriptor({ ...base, id: 't4', kind: 'enum' }), /options/);
  assert.throws(() => descriptors.defineSettingDescriptor({ ...base, id: 't5', kind: 'optionalInteger' }), /offValue/);
  assert.throws(() => descriptors.defineSettingDescriptor({ ...base, id: 't6', adapterId: '' }), /adapterId/);
  const ok = descriptors.defineSettingDescriptor({ ...base, id: 't7' });
  assert.equal(ok.control, 'number');
  assert.ok(Object.isFrozen(ok));
});


test('row defaults name off states, choices and scaled units without the prefix', () => {
  const guard = descriptors.getSettingDescriptor('unattendedGuardMinutesInput');
  assert.equal(descriptors.describeSettingDefaultValue(guard), 'Never');
  assert.equal(descriptors.describeSettingDefaultValue({ ...guard, default: 60 }), '1 hour');
  assert.equal(descriptors.getSettingDescriptorByControlId('unattendedGuardToggle'), null);
  assert.equal('toggleControlId' in guard, false);
  assert.equal('enableValue' in guard, false);
  assert.equal(descriptors.getSettingDescriptor('contextHistoryScopeSelect').control, 'select');
  const scaled = descriptors.defineSettingDescriptor({ id: 'defaultScaled', sectionId: 'tools', kind: 'integer', default: 3600, adapterId: 'test', key: 'time', presentation: { scale: 60, unit: 'min' }, copy: { label: 'Time' } });
  assert.equal(descriptors.describeSettingDefaultValue(scaled), '60 min');
  const ranged = descriptors.defineSettingDescriptor({ id: 'rangeScaled', sectionId: 'tools', kind: 'integer', default: 3600, adapterId: 'test', key: 'range', validation: { min: 60, max: 7200 }, presentation: { scale: 60, unit: 'min' }, copy: { label: 'Range' } });
  assert.match(descriptors.validateSettingValue(ranged, 12000).error, /from 1 to 120\./, 'the range reads in the units the field shows');
  assert.equal(descriptors.getSettingDescriptor('autoApproveStreakCapInput').presentation.scale, 1);
});

// Fresh copies of the descriptor and binding modules built under a stand-in translator,
// the way the app builds them once the catalog has loaded.
function loadWithTranslator(t) {
  const paths = ['../renderer/shell/renderer-settings-field-descriptors.js', '../renderer/shell/renderer-settings-field-binding.js'].map((p) => require.resolve(p));
  const cached = paths.map((p) => require.cache[p]);
  const saved = globalThis.jennyI18n;
  paths.forEach((p) => { delete require.cache[p]; });
  globalThis.jennyI18n = { t };
  try {
    return paths.map((p) => require(p));
  } finally {
    globalThis.jennyI18n = saved;
    paths.forEach((p, i) => { if (cached[i]) require.cache[p] = cached[i]; else delete require.cache[p]; });
  }
}

test('units reach the translators: number boxes, Revert and quick picks show the catalog unit', () => {
  const fill = (d, p) => (p ? String(d).replace(/\{(\w+)\}/g, (m, n) => (n in p ? String(p[n]) : m)) : d);
  const [fresh, binding] = loadWithTranslator((k, d, p) => (k.startsWith('settings.unit.') ? `<${k}>` : fill(d, p)));
  const seconds = fresh.getSettingDescriptor('advancedTuningField-toolsExecutionTimeoutSeconds');
  assert.equal(seconds.presentation.unit, '<settings.unit.sec>');
  const revert = new JSDOM(binding.buildSettingRevertHtml(seconds, 300, {})).window.document.querySelector('[data-setting-revert]');
  assert.equal(revert.getAttribute('data-setting-revert-default'), '120 <settings.unit.sec>');
  assert.equal(fresh.getSettingDescriptor('advancedTuningField-maxLoopWallSeconds').presentation.unit, '<settings.unit.min>');
  assert.equal(fresh.getSettingDescriptor('unattendedGuardMinutesInput').presentation.unit, '<settings.unit.min>');
  assert.equal(fresh.getSettingDescriptor('advancedTuningField-toolsPythonRuntimeMaxMemoryMb').presentation.unit, '<settings.unit.mb>');
  const payload = fresh.getSettingDescriptor('advancedTuningField-maxInlinePayloadBytes');
  assert.equal(payload.presentation.unit, '<settings.unit.kb>');
  assert.deepEqual(payload.presentation.presets.map((pick) => pick.label), ['16 <settings.unit.kb>', '64 <settings.unit.kb>', '256 <settings.unit.kb>']);
  assert.equal(fresh.getSettingDescriptor('advancedTuningField-tokenBudgetWarningRatio').presentation.unit, '%');
});

test('every Limits search stub takes its label and help from the page row that shows it', () => {
  const rows = descriptors.LIMITS_PAGE_GROUPS.flatMap((group) => group.rows);
  const lines = rows.flatMap((row) => row.lines.map((line) => [line.tuning ? 'advancedTuningField-' + line.tuning : 'runtime_' + line.limit, row]));
  const stubs = descriptors.listSettingDescriptors({ sectionId: 'advanced', searchOnly: true });
  assert.equal(stubs.length, lines.length, 'one stub per line on the page');
  for (const stub of stubs) {
    const row = (lines.find(([id]) => id === stub.id) || [])[1];
    assert.ok(row, `${stub.id}: no page row shows it`);
    assert.ok(stub.copy.label.startsWith(row.label), `${stub.id}: "${stub.copy.label}" does not start with "${row.label}"`);
    assert.equal(stub.copy.description, row.help, `${stub.id}: description`);
  }
  for (const key of ['maxLoopIterations', 'tokenBudgetAutoCompactRatio', 'tokenBudgetReservedForSummary', 'tokenBudgetToolOverhead', 'maxBudgetUsd']) {
    assert.equal(descriptors.getSettingDescriptor('advancedTuningField-' + key), null, key);
  }
  assert.ok(Object.isFrozen(descriptors.LIMITS_PAGE_GROUPS[0].rows[0].lines[0]));
});
