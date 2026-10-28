'use strict';

// The CLI run's permission ceiling (Jenny CLI plan, decision 4). A run names
// the tools it pre-allows and disallows; the ceiling is intersected with the
// profile's stored policy so stored `auto` policy can never widen an agent
// run, and a desktop-only tool runs only when the run names it exactly.
//
// The seam is the permission store: every consumer of policy (the sidecar's
// initialize snapshot, the captured session authority, the Electron tool
// executor and runtime-operation admission) reads through `getSnapshot`, so a
// wrapped store that returns the intersected snapshot enforces the ceiling on
// every path at once. Nothing here is a client-side approval shortcut.

const manifest = require('../tools/tool-manifest.json');
const { CLI_ERROR_CODES } = require('../backend/error-codes');
const { normalizePolicySnapshot } = require('../tools/tool-policy-evaluator');

// Tools that change or run things outside the model's sandboxed reads. A glob
// never covers them; `dangerously-skip` does not exist in the CLI.
const DESKTOP_ONLY_TOOLS = Object.freeze([
  'delete_file', 'move_file', 'run_command', 'run_temp_script', 'python_execute', 'worktree_delete',
]);
// The Electron-side decision surface: `ask_user` is how a run asks, not an
// action in the workspace, so the ceiling never puts an approval in front of
// the question (the decider settles the question itself).
const DECISION_SURFACE_TOOLS = Object.freeze(['ask_user']);
const PERMISSION_MODES = Object.freeze(['ask', 'auto', 'plan']);
// Exact ids, `tool:action` pairs and simple globs only: `read_file`,
// `memory:recall`, `read_*`. Regex metacharacters are refused so a selector
// can never be broader than it reads.
const SELECTOR_RE = /^[A-Za-z0-9_.*-]+(?::[A-Za-z0-9_.*-]+)?$/u;
const MAX_SELECTORS = 64;
const MANIFEST_TOOL_NAMES = Object.freeze(manifest.tools.map((tool) => String(tool.name)));
// Globs expand over tool ids and their declared actions, so `memory:*` and
// `*` both read as what the manifest declares, never wider.
const MANIFEST_SELECTORS = Object.freeze(manifest.tools.flatMap((tool) => {
  const actions = tool.actions && typeof tool.actions === 'object' ? Object.keys(tool.actions) : [];
  return [String(tool.name), ...actions.map((action) => `${tool.name}:${action}`)];
}));

function invalid(reason, message) {
  return Object.assign(new TypeError(message), { code: CLI_ERROR_CODES.INVALID_POLICY, reason });
}

function normalizeSelectors(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid('invalid_tool_selectors', `${label} must be a list.`);
  if (value.length > MAX_SELECTORS) throw invalid('too_many_tool_selectors', `${label} lists more than ${MAX_SELECTORS} tools.`);
  return value.map((entry) => {
    const text = String(entry || '').trim();
    if (!text || text.length > 128 || !SELECTOR_RE.test(text)) {
      throw invalid('invalid_tool_selector', `${label} entry "${text.slice(0, 40)}" is not a tool id, a tool:action pair or a simple glob.`);
    }
    return text;
  });
}

function globToRegExp(selector) {
  const escaped = selector.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^:]*');
  return new RegExp(`^${escaped}$`, 'u');
}

function toolOf(selector) {
  return selector.split(':', 1)[0];
}

// A selector's rule match: `tool` or `tool:action`.
function matchFor(selector) {
  const [tool, action] = selector.split(':');
  return action ? { tool_id: tool, action } : { tool_id: tool };
}

// Exact ids pass through as written (an MCP tool is not in the manifest); a
// glob expands over the known selectors minus the desktop-only set. The
// desktop-only tools are plain-name only: neither a glob nor an action pair
// reaches them.
function expandSelectors(selectors, knownSelectors) {
  const expanded = new Set();
  for (const selector of selectors) {
    if (!selector.includes('*')) {
      expanded.add(selector);
      continue;
    }
    const pattern = globToRegExp(selector);
    for (const name of knownSelectors) {
      if (pattern.test(name) && !DESKTOP_ONLY_TOOLS.includes(toolOf(name))) expanded.add(name);
    }
  }
  return expanded;
}

function ruleCopy(rule, decision) {
  return { id: rule.id, decision, reason: rule.reason, match: { ...rule.match } };
}

function createRunPermissionPolicy({
  allowedTools = [], disallowedTools = [], permissionMode = 'ask', knownTools = MANIFEST_SELECTORS,
} = {}) {
  const mode = String(permissionMode || 'ask').trim().toLowerCase();
  if (!PERMISSION_MODES.includes(mode)) throw invalid('invalid_permission_mode', `permission mode "${mode.slice(0, 20)}" is not ask, auto or plan.`);
  const disallowed = expandSelectors(normalizeSelectors(disallowedTools, 'disallowed tools'), knownTools);
  const disallowedTool = (name) => disallowed.has(name) || disallowed.has(toolOf(name));
  const allowed = new Set([...expandSelectors(normalizeSelectors(allowedTools, 'allowed tools'), knownTools)]
    .filter((name) => !disallowedTool(name)));
  // A desktop-only tool is pre-allowed by its exact plain name only.
  const allowedTool = (name) => allowed.has(name) || allowed.has(toolOf(name));
  const desktopOnlyUnlisted = (name) => DESKTOP_ONLY_TOOLS.includes(toolOf(name)) && !allowed.has(toolOf(name));

  // The legacy per-tool map (the executor's fallback for a tool no rule
  // names, and the defaults that make `read_file` auto on the desktop) is
  // narrowed the same way: auto survives only for a pre-allowed tool.
  function ceilingLegacyDecision(toolName, decision) {
    const key = String(toolName || '');
    if (disallowedTool(key) || desktopOnlyUnlisted(key)) return 'deny';
    if (decision === 'auto' && !allowedTool(key)) return 'ask';
    return decision;
  }

  // Stored denies keep their force; the run can only narrow. A legacy
  // per-tool deny is materialized as a rule here too, so it outranks the
  // run's allow rule whatever shape the stored snapshot arrived in. The
  // closing catch-all `ask` rule is what stops the evaluator's built-in
  // defaults (read-only tools and declared read actions are auto on the
  // desktop) from running a tool the run never named.
  function ceilingSnapshot(storedSnapshot) {
    const stored = normalizePolicySnapshot(storedSnapshot);
    const rules = stored.rules.filter((rule) => rule.decision === 'deny').map((rule) => ruleCopy(rule, 'deny'));
    for (const [key, decision] of Object.entries(stored.legacy_policies)) {
      if (decision !== 'deny') continue;
      rules.push({ id: `cli-ceiling-legacy-deny:${key}`, decision: 'deny', reason: `Per-tool deny for ${key}`, match: matchFor(key) });
    }
    for (const name of disallowed) {
      rules.push({ id: `cli-ceiling-deny:${name}`, decision: 'deny', reason: 'Disallowed by this run.', match: matchFor(name) });
    }
    for (const name of DESKTOP_ONLY_TOOLS) {
      if (allowed.has(name)) continue;
      rules.push({ id: `cli-ceiling-desktop-only:${name}`, decision: 'deny',
        reason: 'A desktop-only tool runs in the CLI only when the run pre-allows it by exact name.', match: { tool_id: name } });
    }
    for (const name of allowed) {
      rules.push({ id: `cli-ceiling-allow:${name}`, decision: 'auto', reason: 'Pre-allowed by this run.', match: matchFor(name) });
    }
    for (const name of DECISION_SURFACE_TOOLS) {
      if (allowed.has(name) || disallowedTool(name)) continue;
      rules.push({ id: `cli-ceiling-allow:${name}`, decision: 'auto', reason: 'The decision surface itself; the decider settles it.', match: { tool_id: name } });
    }
    for (const rule of stored.rules) {
      if (rule.decision === 'deny') continue;
      // A stored `auto` survives only when it is scoped to a tool (or a
      // tool action) the run pre-allows.
      const scope = rule.match.tool_id ? (rule.match.action ? `${rule.match.tool_id}:${rule.match.action}` : rule.match.tool_id) : '';
      const widens = rule.decision === 'auto' && !(scope && allowedTool(scope));
      rules.push(ruleCopy(rule, widens ? 'ask' : rule.decision));
    }
    rules.push({ id: 'cli-ceiling-ask-all', decision: 'ask', reason: 'Not pre-allowed by this run.', match: {} });
    const legacy = {};
    for (const [key, decision] of Object.entries(stored.legacy_policies)) {
      legacy[key] = ceilingLegacyDecision(key, decision);
    }
    return normalizePolicySnapshot({ version: stored.version, legacy_policies: legacy, rules });
  }

  const selectorOf = (name, action) => (action ? `${String(name || '')}:${String(action)}` : String(name || ''));

  return Object.freeze({
    permissionMode: mode,
    allowedTools: Object.freeze([...allowed].sort()),
    disallowedTools: Object.freeze([...disallowed].sort()),
    isAllowed: (name, action) => allowedTool(selectorOf(name, action)),
    isDisallowed: (name, action) => disallowedTool(selectorOf(name, action)),
    ceilingSnapshot,
    ceilingLegacyDecision,
  });
}

// The injected seam: the composition hands this to BackendService as its
// permission store. Reads of policy go through the ceiling; everything else
// (stored decisions, review state) reaches the real store unchanged.
function createCeilingPermissionStore(store, policy) {
  if (!store || typeof store.getSnapshot !== 'function') throw invalid('invalid_permission_store', 'A permission store with getSnapshot is required.');
  if (!policy || typeof policy.ceilingSnapshot !== 'function') throw invalid('invalid_run_policy', 'A run permission policy is required.');
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getSnapshot') {
        return (...args) => policy.ceilingSnapshot(target.getSnapshot(...args));
      }
      if (property === 'getAllPolicies' && typeof target.getAllPolicies === 'function') {
        return () => Object.fromEntries(Object.entries(target.getAllPolicies())
          .map(([tool, decision]) => [tool, policy.ceilingLegacyDecision(tool, decision)]));
      }
      if (property === 'getPolicy' && typeof target.getPolicy === 'function') {
        return (toolName) => {
          const decision = target.getPolicy(toolName);
          return decision === undefined ? undefined : policy.ceilingLegacyDecision(toolName, decision);
        };
      }
      if (property === 'runPermissionPolicy') return policy;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

module.exports = {
  DECISION_SURFACE_TOOLS,
  DESKTOP_ONLY_TOOLS,
  MANIFEST_SELECTORS,
  MANIFEST_TOOL_NAMES,
  PERMISSION_MODES,
  createCeilingPermissionStore,
  createRunPermissionPolicy,
};
