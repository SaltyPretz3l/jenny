"""Require a teardown reference for each renderer harness acquisition.

This is a scoped syntax check, not proof that teardown executes on every path.
Comments, strings, and disposal of unrelated objects do not satisfy it.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TESTS_DIR = ROOT / "tests"
ACORN_PATH = ROOT / "node_modules" / "acorn"
SOURCE_SUFFIXES = {".js", ".mjs"}
EXEMPT_RELATIVE_PATHS = {
    "tests/helpers/renderer-shell-harness.js",
    "tests/helpers/renderer-shell-harness-dom.js",
}

DISPOSE_PROBE = r"""
const fs = require('node:fs');
const acorn = require(process.argv[1]);
const files = JSON.parse(fs.readFileSync(0, 'utf8'));
const failures = [];
const isFunction = n => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']
  .includes(n.type);
function reference(n) {
  if (!n) return '';
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'MemberExpression' && !n.computed) {
    return reference(n.object) + '.' + n.property.name;
  }
  return '';
}
const unwrap = n => n && n.type === 'AwaitExpression' ? n.argument : n;
for (const file of files) {
  let tree;
  try {
    tree = acorn.parse(file.source, {
      ecmaVersion: 'latest', sourceType: 'module', locations: true,
    });
  }
  catch (error) { failures.push(file.path + ': ' + error.message); continue; }
  const records = [];
  function walk(node, parents = []) {
    if (!node || typeof node.type !== 'string') return;
    records.push({ node, parents, scope: [...parents].reverse().find(isFunction) || tree });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => walk(child, [...parents, node]));
      else if (value && typeof value.type === 'string') {
        walk(value, [...parents, node]);
      }
    }
  }
  walk(tree);
  // Track local helpers that return the app, including { app } wrappers.
  const forwarders = new Map();
  const forwardedLoads = new Set();
  function forward(fn, load, prefixes) {
    if (!forwarders.has(fn.id.name)) forwarders.set(fn.id.name, new Map());
    forwarders.get(fn.id.name).set(load.node, prefixes);
    forwardedLoads.add(load.node);
  }
  for (const { node: fn } of records.filter(r => r.node.type === 'FunctionDeclaration')) {
    const own = records.filter(r => r.scope === fn);
    const loads = own.filter(r => r.node.type === 'CallExpression'
      && reference(r.node.callee) === 'loadRendererApp');
    for (const load of loads) {
      const parent = [...load.parents].reverse().find(n => n.type !== 'AwaitExpression');
      const variable = parent && parent.type === 'VariableDeclarator' ? reference(parent.id) : '';
      const cleaned = variable && records.some(r => r.parents.includes(fn) && (
        r.node.type === 'CallExpression' && (reference(r.node.callee) === variable + '.dispose'
          || r.node.arguments.some(a => reference(a) === variable + '.dispose'))));
      if (cleaned) continue;
      for (const record of own.filter(r => r.node.type === 'ReturnStatement')) {
        const value = unwrap(record.node.argument);
        if (value === load.node || (variable && reference(value) === variable)) {
          forward(fn, load, ['']);
        } else if (value && value.type === 'ObjectExpression' && variable) {
          const prefixes = value.properties.filter(p => p.type === 'Property'
            && reference(p.value) === variable)
            .map(p => '.' + p.key.name);
          if (prefixes.length) forward(fn, load, prefixes);
        } else if (value && value.type === 'CallExpression'
            && value.callee.type === 'MemberExpression'
            && value.callee.object === load.node && value.callee.property.name === 'then') {
          const callback = value.arguments[0];
          const body = callback && callback.body;
          if (body && body.type === 'ObjectExpression') {
            const prefixes = body.properties.filter(p => p.type === 'Property'
              && reference(p.value) === reference(callback.params[0])).map(p => '.' + p.key.name);
            if (prefixes.length) forward(fn, load, prefixes);
          }
        }
      }
    }
  }
  for (const acquisition of records) {
    const { node, parents, scope } = acquisition;
    if (node.type !== 'CallExpression') continue;
    const name = reference(node.callee);
    if (name !== 'loadRendererApp' && !forwarders.has(name)) continue;
    if (forwardedLoads.has(node)) {
      if (!records.some(r => r.scope !== scope && r.node.type === 'CallExpression'
          && reference(r.node.callee) === scope.id.name)) {
        failures.push(file.path + ':' + node.loc.start.line);
      }
      continue;
    }
    const parent = [...parents].reverse().find(n => n.type !== 'AwaitExpression');
    const binding = parent && (parent.type === 'VariableDeclarator' ? parent.id
      : parent.type === 'AssignmentExpression' ? parent.left : null);
    const groups = forwarders.has(name) ? [...forwarders.get(name).values()] : [['']];
    // A let/const binding lives in its nearest block: a same-named app in a
    // sibling block must not lend it that block's teardown.
    const declaration = parent && parent.type === 'VariableDeclarator'
      ? [...parents].reverse().find(n => n.type === 'VariableDeclaration') : null;
    const block = declaration && declaration.kind !== 'var'
      ? [...parents].reverse().find(n => n.type === 'BlockStatement') : null;
    for (const prefixes of groups) {
      const objects = new Set();
      const accepted = new Set();
      function bind(pattern, base = '') {
        if (!pattern) return;
        if (pattern.type === 'Identifier') {
          if (!base) {
            objects.add(pattern.name);
            accepted.add(pattern.name + '.dispose');
            accepted.add(pattern.name + '.window.close');
          } else if (base.endsWith('.dispose')) accepted.add(pattern.name);
          else if (base.endsWith('.window')) accepted.add(pattern.name + '.close');
        } else if (pattern.type === 'ObjectPattern') {
          for (const property of pattern.properties) {
            if (property.type !== 'Property' || property.computed) continue;
            const key = property.key.name;
            if (key === 'dispose') bind(property.value, '.dispose');
            if (key === 'window') bind(property.value, '.window');
          }
        }
      }
      for (const prefix of prefixes) {
        if (!prefix) bind(binding);
        else if (binding && binding.type === 'Identifier') {
          accepted.add(binding.name + prefix + '.dispose');
          accepted.add(binding.name + prefix + '.window.close');
        } else if (binding && binding.type === 'ObjectPattern') {
          for (const p of binding.properties) {
            if (p.type === 'Property' && '.' + p.key.name === prefix) bind(p.value);
          }
        }
      }
      for (const record of records.filter(r => r.scope === scope)) {
        const n = record.node;
        if (n.type === 'VariableDeclarator' && objects.has(reference(n.init))) bind(n.id);
      }
      const contextNames = [scope, ...parents.filter(isFunction)]
        .flatMap(fn => (fn.params || []).map(reference));
      const isAfter = n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
        && n.callee.property.name === 'after' && contextNames.includes(reference(n.callee.object));
      const teardown = records.some(record => {
        const n = record.node;
        if (n.type !== 'CallExpression' || (block && !record.parents.includes(block))) return false;
        if (record.scope === scope && isAfter(n)
            && n.arguments.some(arg => accepted.has(reference(arg)))) return true;
        if (!accepted.has(reference(n.callee))) return false;
        if (record.scope === scope) return true;
        const ownerIndex = record.parents.indexOf(scope);
        if (ownerIndex < 0) return false;
        const nested = record.parents.slice(ownerIndex + 1);
        const functions = nested.filter(isFunction);
        return functions.length === 1
          && nested.some(p => isAfter(p) && p.arguments.includes(functions[0]));
      });
      if (!teardown) failures.push(file.path + ':' + node.loc.start.line);
    }
  }
}
process.stdout.write(JSON.stringify(failures));
"""


def _violations() -> list[str]:
    files: list[dict[str, str]] = []
    for path in sorted(TESTS_DIR.rglob("*")):
        if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
            continue
        relative_path = path.relative_to(ROOT).as_posix()
        if relative_path in EXEMPT_RELATIVE_PATHS:
            continue
        try:
            source = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            return [f"{relative_path}: could not read test: {error}"]
        files.append({"path": relative_path, "source": source})
    try:
        result = subprocess.run(
            ["node", "-e", DISPOSE_PROBE, str(ACORN_PATH)],
            input=json.dumps(files), capture_output=True, text=True, encoding="utf-8",
            check=False, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return [f"renderer teardown probe failed: {error}"]
    if result.returncode:
        return [f"renderer teardown probe failed: {result.stderr.strip()}"]
    return json.loads(result.stdout)


def main() -> int:
    violations = _violations()
    if violations:
        print("FAIL: renderer harness acquisition has no scoped teardown reference")
        for item in violations:
            print(f"  - {item}")
        print("  Register t.after(() => dispose()) from loadRendererApp(), "
              "or await window.close().")
        return 1
    print("PASS: each renderer harness acquisition has a scoped teardown reference")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
