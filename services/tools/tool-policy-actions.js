'use strict';

// (tool, action) side-effect re-keying helpers — the JS mirror of
// sidecar/ai/tools/tool_actions.py (W6/W7b). A descriptor's actions arrive as
// the plain manifest shape: { status: { side_effecting: false }, ... }.
// Semantics are pinned by tests/tool-policy-evaluator.test.js and must stay in
// lockstep with the Python evaluator: no actions → the scalar; actions declared
// but the call's action missing/undeclared → side-effecting (fail closed);
// resolved → the action spec's class, with malformed specs counting as
// side-effecting.

function isNonEmptyPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null)
    && Object.keys(value).length > 0
  );
}

function declaredAction(descriptor, args) {
  const actions = descriptor && descriptor.actions;
  const action = args && args.action;
  return (
    isNonEmptyPlainObject(actions)
    && typeof action === 'string'
    && Object.hasOwn(actions, action)
  ) ? action : '';
}

function effectiveSideEffecting(descriptor, args) {
  const actions = descriptor && descriptor.actions;
  if (!isNonEmptyPlainObject(actions)) {
    return descriptor && descriptor.side_effecting;
  }
  const action = declaredAction(descriptor, args);
  if (!action) {
    return true;
  }
  const spec = actions[action];
  return !(isNonEmptyPlainObject(spec) && spec.side_effecting === false);
}

module.exports = {
  declaredAction,
  effectiveSideEffecting,
  isNonEmptyPlainObject,
};
