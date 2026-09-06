'use strict';

// Jenny-interpreted declarative migration executor (PLUG-D20, invariant 13/23's
// migration half). This module is the DECLARATIVE-tier executor and nothing
// else: it never runs a migration declared for any other tier, because doing
// so would be exactly the "silently running under a weaker tier" behavior the
// architecture forbids. A migration is either interpretable here (executor
// tier is "declarative" AND that tier is currently enabled) or it resolves to
// `installed_but_incompatible` -- there is no fallback path.
//
// The step vocabulary is closed and finite by construction: rename_field,
// set_default, drop_field, map_enum_value, wrap_object, unwrap_object. There is
// no "eval" step, no loop construct, and no plugin-supplied code ever runs
// here -- every step is a small, bounded, data-only structural edit applied to
// a plain-JSON value. A transform that cannot be expressed with these six
// verbs is a correct `installed_but_incompatible` outcome, not a reason to add
// an escape hatch (see AGENTS.md / PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md).
//
// Pure module: no fs/net/child_process, no ambient clock. Callers inject every
// limit and the migration/input values themselves.

const EXECUTOR_TIERS = Object.freeze(['declarative', 'restricted', 'full_host']);
const EXECUTOR_TIER_SET = new Set(EXECUTOR_TIERS);

// Only "declarative" ships in Stage 2. Callers may inject a narrower set (for
// example to model "declarative migrations disabled by policy") but can never
// widen this module's behavior beyond the declarative tier -- see
// `evaluateMigration` below, which hard-codes the single-tier check.
const DEFAULT_ENABLED_EXECUTOR_TIERS = Object.freeze(['declarative']);

const STEP_KINDS = Object.freeze([
  'rename_field',
  'set_default',
  'drop_field',
  'map_enum_value',
  'wrap_object',
  'unwrap_object',
]);
const STEP_KIND_SET = new Set(STEP_KINDS);

// Numeric bounds are this module's own defensive limits (distinct from the
// W7-frozen contract-payload budgets). Callers may tighten them via `limits`;
// they exist so a hostile or malformed migration cannot force unbounded work.
const DEFAULT_LIMITS = Object.freeze({
  maxSteps: 64,
  maxPathDepth: 8,
  maxOutputNodes: 4096,
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isJsonScalar(value) {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

// Bounded structural clone + node count in one pass so a pathological input
// cannot make this module do unbounded work before the budget check fires.
function cloneAndCount(value, limit) {
  let count = 0;
  function walk(node) {
    count += 1;
    if (count > limit) return undefined;
    if (Array.isArray(node)) {
      const out = [];
      for (const item of node) {
        if (count > limit) return undefined;
        out.push(walk(item));
      }
      return out;
    }
    if (isPlainObject(node)) {
      const out = {};
      for (const key of Object.keys(node)) {
        if (count > limit) return undefined;
        // setOwnField, not assignment: cloning a payload that legitimately
        // carries a field named `__proto__` would otherwise drop it and swap
        // the clone's prototype instead.
        setOwnField(out, key, walk(node[key]));
      }
      return out;
    }
    if (isJsonScalar(node)) return node;
    // Non-JSON value (function, undefined, symbol, ...): reject by treating as
    // over-budget so the caller sees a bounded failure, never a thrown error.
    count = limit + 1;
    return undefined;
  }
  const cloned = walk(value);
  return { value: cloned, nodeCount: count };
}

function fail(outcome, reason, detail) {
  return { ok: false, outcome, reason, detail: detail || {} };
}

function migrationFailed(reason, detail) {
  return fail('migration_failed', reason, { ...detail, recommendedAction: 'restore_prior_snapshot' });
}

function incompatible(reason, detail) {
  return fail('installed_but_incompatible', reason, { ...detail, recommendedAction: 'retain_prior_generation' });
}

// Resolves `path` (an array of plain-object keys) against `root`, returning
// the container object the last segment should act on. `path` addresses the
// PARENT of the field a step touches, so an empty path means "the root
// object itself is the container".
// `hasOwn`, never the `in` operator: `in` walks the prototype chain, so a path
// of ["__proto__"] would resolve to the global Object.prototype (which
// isPlainObject accepts, its own prototype being null) and hand it to a step as
// a writable container -- process-wide prototype pollution from a data-only
// migration descriptor.
function hasOwnField(container, field) {
  return Object.prototype.hasOwnProperty.call(container, field);
}

// Assignment, not defineProperty, is the hazard on the write side: assigning to
// the key `__proto__` invokes Object.prototype's setter and swaps the
// container's prototype instead of storing a field.
function setOwnField(container, field, value) {
  Object.defineProperty(container, field, { value, writable: true, enumerable: true, configurable: true });
}

function resolveContainer(root, path, maxDepth) {
  if (!Array.isArray(path) || path.length > maxDepth) return null;
  let current = root;
  for (const segment of path) {
    if (typeof segment !== 'string' || !isPlainObject(current) || !hasOwnField(current, segment)) return null;
    current = current[segment];
  }
  return isPlainObject(current) ? current : null;
}

function applyStep(root, step, limits) {
  if (!isPlainObject(step) || !STEP_KIND_SET.has(step.kind)) {
    return { ok: false, reason: 'unknown_step_kind' };
  }
  const container = resolveContainer(root, step.path || [], limits.maxPathDepth);
  if (container === null) return { ok: false, reason: 'path_not_found' };

  switch (step.kind) {
    case 'rename_field': {
      if (typeof step.from !== 'string' || typeof step.to !== 'string') return { ok: false, reason: 'malformed_step' };
      if (!hasOwnField(container, step.from)) return { ok: false, reason: 'field_not_found' };
      if (step.from !== step.to && hasOwnField(container, step.to)) return { ok: false, reason: 'rename_target_collision' };
      setOwnField(container, step.to, container[step.from]);
      if (step.from !== step.to) delete container[step.from];
      return { ok: true };
    }
    case 'set_default': {
      if (typeof step.field !== 'string' || !('value' in step) || !isJsonScalar(step.value)) {
        return { ok: false, reason: 'malformed_step' };
      }
      if (!hasOwnField(container, step.field)) setOwnField(container, step.field, step.value);
      return { ok: true };
    }
    case 'drop_field': {
      if (typeof step.field !== 'string') return { ok: false, reason: 'malformed_step' };
      delete container[step.field]; // dropping an already-absent field is a safe no-op
      return { ok: true };
    }
    case 'map_enum_value': {
      if (typeof step.field !== 'string' || !isPlainObject(step.mapping)) return { ok: false, reason: 'malformed_step' };
      if (!hasOwnField(container, step.field)) return { ok: true }; // nothing to map
      const current = container[step.field];
      if (typeof current !== 'string') return { ok: false, reason: 'enum_value_not_string' };
      if (!hasOwnField(step.mapping, current)) {
        return { ok: false, reason: 'unmapped_enum_value' };
      }
      setOwnField(container, step.field, step.mapping[current]);
      return { ok: true };
    }
    case 'wrap_object': {
      if (typeof step.field !== 'string' || typeof step.into !== 'string') return { ok: false, reason: 'malformed_step' };
      if (!hasOwnField(container, step.field)) return { ok: false, reason: 'field_not_found' };
      const wrapper = {};
      setOwnField(wrapper, step.into, container[step.field]);
      setOwnField(container, step.field, wrapper);
      return { ok: true };
    }
    case 'unwrap_object': {
      if (typeof step.field !== 'string' || typeof step.from !== 'string') return { ok: false, reason: 'malformed_step' };
      if (!hasOwnField(container, step.field)) return { ok: false, reason: 'field_not_found' };
      const wrapped = container[step.field];
      if (!isPlainObject(wrapped) || !hasOwnField(wrapped, step.from)) return { ok: false, reason: 'unwrap_source_missing' };
      setOwnField(container, step.field, wrapped[step.from]);
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'unknown_step_kind' };
  }
}

/**
 * Evaluate and, if permitted, run a declarative migration against `input`.
 *
 * @param {object} args
 * @param {object} args.migration - `{ executorTier: string, steps: object[] }`.
 * @param {*} args.input - the plain-JSON value to migrate (never mutated).
 * @param {string[]} [args.enabledExecutorTiers] - tiers currently enabled;
 *   defaults to `['declarative']` (Stage 2 posture). This module still only
 *   ever executes the "declarative" tier regardless of what is enabled here.
 * @param {object} [args.limits] - overrides for DEFAULT_LIMITS.
 * @returns {{ok:true,value:*}|{ok:false,outcome:string,reason:string,detail:object}}
 */
function evaluateMigration({ migration, input, enabledExecutorTiers = DEFAULT_ENABLED_EXECUTOR_TIERS, limits = {} }) {
  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
  if (!isPlainObject(migration) || typeof migration.executorTier !== 'string') {
    return incompatible('malformed_migration', {});
  }
  if (!EXECUTOR_TIER_SET.has(migration.executorTier)) {
    return incompatible('unknown_executor_tier', { executorTier: migration.executorTier });
  }
  const enabledSet = new Set(enabledExecutorTiers);
  if (!enabledSet.has(migration.executorTier)) {
    return incompatible('executor_tier_not_shipped_or_disabled', { executorTier: migration.executorTier });
  }
  // Structural guard, not a fallback: this interpreter only ever runs the
  // declarative tier, so a migration correctly ENABLED for e.g. "restricted"
  // still cannot execute here. A future restricted-host interpreter is a
  // separate module entirely.
  if (migration.executorTier !== 'declarative') {
    return incompatible('executor_tier_requires_different_host', { executorTier: migration.executorTier });
  }

  const steps = migration.steps;
  if (!Array.isArray(steps)) return migrationFailed('malformed_migration', {});
  if (steps.length > effectiveLimits.maxSteps) {
    return migrationFailed('step_count_exceeded', { stepCount: steps.length, maxSteps: effectiveLimits.maxSteps });
  }

  const cloneInput = cloneAndCount(input, effectiveLimits.maxOutputNodes);
  if (cloneInput.nodeCount > effectiveLimits.maxOutputNodes) {
    return migrationFailed('input_size_exceeded', { maxOutputNodes: effectiveLimits.maxOutputNodes });
  }
  let working = cloneInput.value;
  if (!isPlainObject(working)) return migrationFailed('input_not_object', {});

  for (let index = 0; index < steps.length; index += 1) {
    const result = applyStep(working, steps[index], effectiveLimits);
    if (!result.ok) {
      return migrationFailed(result.reason, { stepIndex: index, stepKind: isPlainObject(steps[index]) ? steps[index].kind : null });
    }
  }

  const recount = cloneAndCount(working, effectiveLimits.maxOutputNodes);
  if (recount.nodeCount > effectiveLimits.maxOutputNodes) {
    return migrationFailed('output_size_exceeded', { maxOutputNodes: effectiveLimits.maxOutputNodes });
  }
  return { ok: true, value: recount.value };
}

module.exports = {
  EXECUTOR_TIERS,
  DEFAULT_ENABLED_EXECUTOR_TIERS,
  STEP_KINDS,
  DEFAULT_LIMITS,
  evaluateMigration,
};
