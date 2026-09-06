"""Twin JS/Python interpreter emitters for the plugin-platform contract generator.

Split out of scripts/generate_plugin_contracts.py to keep each production file
under the shared 600-raw-line ratchet. Descriptor lint, $defs/format resolution,
and CLI orchestration stay in the parent module; this module only holds the two
embedded runtime templates and the functions that wrap a resolved SPEC with each
language's generated-file header.

Both templates implement the identical generic interpreter: one JSON walk over
the resolved SPEC node tree per contract. A behavior fix belongs in both blocks
at once, mirrored line-for-line where the language allows it.
"""

# ruff: noqa: E501

from __future__ import annotations

import json
from typing import Any

SAFE_INTEGER_MIN = -9007199254740991
SAFE_INTEGER_MAX = 9007199254740991

JS_RUNTIME = r'''
const BIDI_OVERRIDE_CODEPOINTS = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
const ZERO_WIDTH_CODEPOINTS = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
function isPlainObject(value) {
  if (!value || typeof value !== 'object'
    || Object.prototype.toString.call(value) !== '[object Object]') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || (Object.getPrototypeOf(prototype) === null
    && typeof prototype.constructor === 'function'
    && prototype.constructor.name === 'Object');
}
function utf8Bytes(value) { return Buffer.byteLength(String(value), 'utf8'); }
function joinPath(path, key) { return path === '' ? key : `${path}.${key}`; }
// Plain `target[key] = value` routes the key `__proto__` through
// Object.prototype's setter: the field is silently dropped and the object's
// prototype is replaced with attacker-supplied data. defineProperty always
// creates an own data property, matching the Python twin's dict assignment.
function defineOwn(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}
function indexPath(path, index) { return `${path}[${index}]`; }
function fail(code, path, byteCount = null) {
  return { ok: false, value: null, error: { code, reason: SPEC.error_reasons[code], path, byte_count: byteCount } };
}
function hasInvalidUnicodeScalar(value) {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
  }
  return false;
}
function hasForbiddenCodepoint(value) {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
    if (codePoint >= 0x80 && codePoint <= 0x9f) return true;
    if (BIDI_OVERRIDE_CODEPOINTS.has(codePoint) || ZERO_WIDTH_CODEPOINTS.has(codePoint)) return true;
  }
  return false;
}
function inspectStructure(value, budgets) {
  // `seen` holds the ANCESTOR CHAIN, not every node visited. A payload may
  // legitimately share one object across sibling entries (a DAG); only a
  // reference back into the current path is a cycle. Each container pushes an
  // exit marker before its children, and because the stack is LIFO that marker
  // pops after the whole subtree, removing the node from the chain again.
  const seen = new WeakSet();
  const stack = [{ value, path: '', depth: 0 }];
  let nodeCount = 0;
  while (stack.length) {
    const current = stack.pop();
    if (current.exit) { seen.delete(current.exit); continue; }
    nodeCount += 1;
    if (nodeCount > budgets.max_nodes) return fail('node_budget_exceeded', current.path);
    if (current.depth > budgets.max_depth) return fail('depth_budget_exceeded', current.path);
    const item = current.value;
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'string') {
      if (hasInvalidUnicodeScalar(item)) return fail('invalid_unicode_scalar', current.path);
      continue;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return fail('nonfinite_number', current.path);
      continue;
    }
    if (typeof item !== 'object') return fail('unsupported_value_type', current.path);
    if (seen.has(item)) return fail('cycle_detected', current.path);
    if (Array.isArray(item)) {
      if (item.length > budgets.max_array_items) return fail('array_budget_exceeded', current.path);
      seen.add(item);
      stack.push({ exit: item });
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], path: indexPath(current.path, index), depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainObject(item)) return fail('unsupported_value_type', current.path);
    // Sorted, not insertion order: JS hoists integer-like keys to the front of
    // Object.keys while Python preserves JSON insertion order, so an unsorted
    // walk reports a different error `path` in each runtime for the same input.
    const keys = Object.keys(item).sort();
    if (keys.length > budgets.max_object_keys) return fail('key_budget_exceeded', current.path);
    for (const key of keys) {
      if (hasInvalidUnicodeScalar(key)) return fail('invalid_unicode_scalar', joinPath(current.path, key));
    }
    seen.add(item);
    stack.push({ exit: item });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      stack.push({ value: item[key], path: joinPath(current.path, key), depth: current.depth + 1 });
    }
  }
  const byteCount = utf8Bytes(JSON.stringify(value));
  if (byteCount > budgets.max_payload_utf8_bytes) return fail('payload_byte_budget_exceeded', '', byteCount);
  return { ok: true };
}
function validateString(value, node, path) {
  if (typeof value !== 'string') return fail('not_string', path);
  const byteCount = utf8Bytes(value);
  if (node.max_utf8_bytes !== null && byteCount > node.max_utf8_bytes) return fail('max_bytes_exceeded', path, byteCount);
  if (node.nfc_check) {
    if (hasForbiddenCodepoint(value)) return fail('forbidden_codepoint', path);
    if (value.normalize('NFC') !== value) return fail('not_nfc_normalized', path);
  }
  if (node.pattern !== null && !new RegExp(node.pattern).test(value)) return fail('pattern_mismatch', path);
  return { ok: true, value, error: null };
}
function validateInteger(value, node, path) {
  if (typeof value === 'boolean') return fail('integer_is_bool', path);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail('not_integer', path);
  if (node.minimum !== null && value < node.minimum) return fail('integer_out_of_range', path);
  if (node.maximum !== null && value > node.maximum) return fail('integer_out_of_range', path);
  return { ok: true, value, error: null };
}
function validateBoolean(value, path) {
  if (typeof value !== 'boolean') return fail('not_boolean', path);
  return { ok: true, value, error: null };
}
function validateEnum(value, node, path) {
  if (typeof value !== 'string') return fail('not_string', path);
  if (!node.values.includes(value)) return fail('enum_invalid', path);
  return { ok: true, value, error: null };
}
function validateConst(value, node, path) {
  const expected = node.value;
  if (typeof value === 'boolean') return fail('const_mismatch', path);
  const typeMatches = typeof expected === 'number' ? typeof value === 'number' : typeof value === 'string';
  if (!typeMatches || value !== expected) return fail('const_mismatch', path);
  return { ok: true, value, error: null };
}
function validateObject(value, node, path) {
  if (!isPlainObject(value)) return fail('not_object', path);
  const ownKeys = Object.keys(value).sort();
  if (ownKeys.length > node.max_keys) return fail('max_keys_exceeded', path);
  for (const field of node.required) {
    if (!Object.hasOwn(value, field)) return fail('missing_required_field', joinPath(path, field));
  }
  const normalized = {};
  for (const field of Object.keys(node.properties).sort()) {
    if (!Object.hasOwn(value, field)) continue;
    const sub = validateNode(value[field], node.properties[field], joinPath(path, field));
    if (!sub.ok) return sub;
    defineOwn(normalized, field, sub.value);
  }
  const extras = ownKeys.filter((key) => !Object.hasOwn(node.properties, key));
  if (extras.length > 0) {
    if (node.additional_properties === 'reject') return fail('unknown_field', joinPath(path, extras[0]));
    if (node.additional_properties === 'preserve') { for (const key of extras) defineOwn(normalized, key, value[key]); }
  }
  return { ok: true, value: normalized, error: null };
}
function validateArray(value, node, path) {
  if (!Array.isArray(value)) return fail('not_array', path);
  if (value.length > node.max_items) return fail('max_items_exceeded', path);
  const normalized = [];
  for (let index = 0; index < value.length; index += 1) {
    const sub = validateNode(value[index], node.items, indexPath(path, index));
    if (!sub.ok) return sub;
    normalized.push(sub.value);
  }
  if (node.unique_by.length > 0) {
    const seen = new Set();
    for (let index = 0; index < normalized.length; index += 1) {
      // A compact JSON array, not a bare concatenation: joining with no framing
      // collapses ("ab","cd") and ("a","bcd") onto "abcd" and rejects two
      // distinct entries as duplicates. The generator restricts unique_by to
      // required scalar fields, so this encoding is byte-identical in both
      // runtimes and never depends on object key ordering.
      const key = JSON.stringify(node.unique_by.map((field) => normalized[index][field]));
      if (seen.has(key)) return fail('unique_by_violation', indexPath(path, index));
      seen.add(key);
    }
  }
  return { ok: true, value: normalized, error: null };
}
function validateTaggedUnion(value, node, path) {
  if (!isPlainObject(value)) return fail('not_object', path);
  const tagPath = joinPath(path, node.tag_field);
  if (!Object.hasOwn(value, node.tag_field)) return fail('tagged_union_missing_tag', tagPath);
  const tag = value[node.tag_field];
  if (typeof tag !== 'string' || !Object.hasOwn(node.variants, tag)) return fail('tagged_union_unknown_tag', tagPath);
  return validateNode(value, node.variants[tag], path);
}
function validateNode(value, node, path) {
  switch (node.type) {
    case 'object': return validateObject(value, node, path);
    case 'array': return validateArray(value, node, path);
    case 'string': return validateString(value, node, path);
    case 'integer': return validateInteger(value, node, path);
    case 'boolean': return validateBoolean(value, path);
    case 'enum': return validateEnum(value, node, path);
    case 'const': return validateConst(value, node, path);
    case 'tagged_union': return validateTaggedUnion(value, node, path);
    default: return fail('unsupported_value_type', path);
  }
}
function validate(contractName, value) {
  // hasOwn, not a bare lookup: `SPEC.contracts.toString` resolves an inherited
  // Object.prototype member, passes the truthiness guard, and then throws on
  // contract.root. The Python twin's dict .get() has no such hole.
  const contract = Object.hasOwn(SPEC.contracts, contractName) ? SPEC.contracts[contractName] : null;
  if (!contract) return fail('unknown_contract', '');
  const structural = inspectStructure(value, contract.structure || SPEC.structure);
  if (!structural.ok) return structural;
  return validateNode(value, contract.root, '');
}
module.exports = { validate, SPEC };
'''

PY_RUNTIME = r'''
BIDI_OVERRIDE_CODEPOINTS = frozenset({0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069})
ZERO_WIDTH_CODEPOINTS = frozenset({0x200b, 0x200c, 0x200d, 0x2060, 0xfeff})


def _is_plain_object(value: Any) -> bool:
    return isinstance(value, dict)


def _utf8_bytes(value: str) -> int:
    return len(value.encode("utf-8"))


def _join_path(path: str, key: str) -> str:
    return key if path == "" else f"{path}.{key}"


def _index_path(path: str, index: int) -> str:
    return f"{path}[{index}]"


def _fail(code: str, path: str, byte_count: int | None = None) -> dict[str, Any]:
    return {"ok": False, "value": None, "error": {"code": code, "reason": SPEC["error_reasons"][code], "path": path, "byte_count": byte_count}}


def _has_invalid_unicode_scalar(value: str) -> bool:
    return any(0xD800 <= ord(char) <= 0xDFFF for char in value)


def _has_forbidden_codepoint(value: str) -> bool:
    for char in value:
        code_point = ord(char)
        if code_point <= 0x1F or code_point == 0x7F or 0x80 <= code_point <= 0x9F:
            return True
        if code_point in BIDI_OVERRIDE_CODEPOINTS or code_point in ZERO_WIDTH_CODEPOINTS:
            return True
    return False


def _inspect_structure(value: Any, budgets: dict[str, int]) -> dict[str, Any]:
    # `seen` holds the ANCESTOR CHAIN, not every node visited. A payload may
    # legitimately share one object across sibling entries (a DAG); only a
    # reference back into the current path is a cycle. Each container pushes an
    # exit marker before its children, and because the stack is LIFO that marker
    # pops after the whole subtree, removing the node from the chain again.
    # The marker also holds a reference, so id() cannot be recycled underneath us.
    seen: set[int] = set()
    stack: list[tuple[Any, str, int, bool]] = [(value, "", 0, False)]
    node_count = 0
    while stack:
        item, path, depth, is_exit = stack.pop()
        if is_exit:
            seen.discard(id(item))
            continue
        node_count += 1
        if node_count > budgets["max_nodes"]:
            return _fail("node_budget_exceeded", path)
        if depth > budgets["max_depth"]:
            return _fail("depth_budget_exceeded", path)
        if item is None or isinstance(item, bool):
            continue
        if isinstance(item, str):
            if _has_invalid_unicode_scalar(item):
                return _fail("invalid_unicode_scalar", path)
            continue
        if isinstance(item, (int, float)):
            if isinstance(item, float) and not math.isfinite(item):
                return _fail("nonfinite_number", path)
            continue
        if not isinstance(item, (dict, list)):
            return _fail("unsupported_value_type", path)
        if id(item) in seen:
            return _fail("cycle_detected", path)
        if isinstance(item, list):
            if len(item) > budgets["max_array_items"]:
                return _fail("array_budget_exceeded", path)
            seen.add(id(item))
            stack.append((item, path, depth, True))
            for index in range(len(item) - 1, -1, -1):
                stack.append((item[index], _index_path(path, index), depth + 1, False))
            continue
        # Sorted for the same reason the JS twin sorts: see that comment.
        keys = sorted(item.keys())
        if len(keys) > budgets["max_object_keys"]:
            return _fail("key_budget_exceeded", path)
        for key in keys:
            if isinstance(key, str) and _has_invalid_unicode_scalar(key):
                return _fail("invalid_unicode_scalar", _join_path(path, key))
        seen.add(id(item))
        stack.append((item, path, depth, True))
        for index in range(len(keys) - 1, -1, -1):
            key = keys[index]
            stack.append((item[key], _join_path(path, key), depth + 1, False))
    byte_count = _utf8_bytes(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    if byte_count > budgets["max_payload_utf8_bytes"]:
        return _fail("payload_byte_budget_exceeded", "", byte_count)
    return {"ok": True}


def _validate_string(value: Any, node: dict[str, Any], path: str) -> dict[str, Any]:
    if not isinstance(value, str):
        return _fail("not_string", path)
    byte_count = _utf8_bytes(value)
    if node["max_utf8_bytes"] is not None and byte_count > node["max_utf8_bytes"]:
        return _fail("max_bytes_exceeded", path, byte_count)
    if node["nfc_check"]:
        if _has_forbidden_codepoint(value):
            return _fail("forbidden_codepoint", path)
        if unicodedata.normalize("NFC", value) != value:
            return _fail("not_nfc_normalized", path)
    if node["pattern"] is not None and re.fullmatch(node["pattern"], value) is None:
        return _fail("pattern_mismatch", path)
    return {"ok": True, "value": value, "error": None}


def _validate_integer(value: Any, node: dict[str, Any], path: str) -> dict[str, Any]:
    if isinstance(value, bool):
        return _fail("integer_is_bool", path)
    if not isinstance(value, int) or not (SAFE_INTEGER_MIN <= value <= SAFE_INTEGER_MAX):
        return _fail("not_integer", path)
    if node["minimum"] is not None and value < node["minimum"]:
        return _fail("integer_out_of_range", path)
    if node["maximum"] is not None and value > node["maximum"]:
        return _fail("integer_out_of_range", path)
    return {"ok": True, "value": value, "error": None}


def _validate_boolean(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, bool):
        return _fail("not_boolean", path)
    return {"ok": True, "value": value, "error": None}


def _validate_enum(value: Any, node: dict[str, Any], path: str) -> dict[str, Any]:
    if not isinstance(value, str):
        return _fail("not_string", path)
    if value not in node["values"]:
        return _fail("enum_invalid", path)
    return {"ok": True, "value": value, "error": None}


def _validate_const(value: Any, node: dict[str, Any], path: str) -> dict[str, Any]:
    expected = node["value"]
    if isinstance(value, bool):
        return _fail("const_mismatch", path)
    type_matches = isinstance(value, int) if isinstance(expected, int) else isinstance(value, str)
    if not type_matches or value != expected:
        return _fail("const_mismatch", path)
    return {"ok": True, "value": value, "error": None}


def _validate_object(value: Any, node: dict[str, Any], path: str) -> dict[str, Any]:
    if not _is_plain_object(value):
        return _fail("not_object", path)
    own_keys = sorted(value.keys())
    if len(own_keys) > node["max_keys"]:
        return _fail("max_keys_exceeded", path)
    for field in node["required"]:
        if field not in value:
            return _fail("missing_required_field", _join_path(path, field))
    normalized: dict[str, Any] = {}
    for field in sorted(node["properties"].keys()):
        if field not in value:
            continue
        sub = _validate_node(value[field], node["properties"][field], _join_path(path, field))
        if not sub["ok"]:
            return sub
        normalized[field] = sub["value"]
    extras = [key for key in own_keys if key not in node["properties"]]
    if extras:
        if node["additional_properties"] == "reject":
            return _fail("unknown_field", _join_path(path, extras[0]))
        if node["additional_properties"] == "preserve":
            for key in extras:
                normalized[key] = value[key]
    return {"ok": True, "value": normalized, "error": None}


def _validate_array(value: Any, node: dict[str, Any], path: str) -> dict[str, Any]:
    if not isinstance(value, list):
        return _fail("not_array", path)
    if len(value) > node["max_items"]:
        return _fail("max_items_exceeded", path)
    normalized: list[Any] = []
    for index, item in enumerate(value):
        sub = _validate_node(item, node["items"], _index_path(path, index))
        if not sub["ok"]:
            return sub
        normalized.append(sub["value"])
    if node["unique_by"]:
        seen: set[str] = set()
        for index, item in enumerate(normalized):
            # Compact JSON array; see the JS twin for why the fields are framed.
            key = json.dumps([item.get(field) for field in node["unique_by"]], ensure_ascii=False, separators=(",", ":"))
            if key in seen:
                return _fail("unique_by_violation", _index_path(path, index))
            seen.add(key)
    return {"ok": True, "value": normalized, "error": None}


def _validate_tagged_union(value: Any, node: dict[str, Any], path: str) -> dict[str, Any]:
    if not _is_plain_object(value):
        return _fail("not_object", path)
    tag_path = _join_path(path, node["tag_field"])
    if node["tag_field"] not in value:
        return _fail("tagged_union_missing_tag", tag_path)
    tag = value[node["tag_field"]]
    if not isinstance(tag, str) or tag not in node["variants"]:
        return _fail("tagged_union_unknown_tag", tag_path)
    return _validate_node(value, node["variants"][tag], path)


_VALIDATORS = {
    "object": _validate_object,
    "array": _validate_array,
    "string": _validate_string,
    "integer": _validate_integer,
    "enum": _validate_enum,
    "const": _validate_const,
    "tagged_union": _validate_tagged_union,
}


def _validate_node(value: Any, node: dict[str, Any], path: str) -> dict[str, Any]:
    node_type = node["type"]
    if node_type == "boolean":
        return _validate_boolean(value, path)
    validator = _VALIDATORS.get(node_type)
    if validator is None:
        return _fail("unsupported_value_type", path)  # pragma: no cover
    return validator(value, node, path)


def validate(contract_name: str, value: Any) -> dict[str, Any]:
    contract = SPEC["contracts"].get(contract_name)
    if contract is None:
        return _fail("unknown_contract", "")
    structural = _inspect_structure(value, contract.get("structure", SPEC["structure"]))
    if not structural["ok"]:
        return structural
    return _validate_node(value, contract["root"], "")
'''


def js_source(spec: dict[str, Any]) -> str:
    embedded = json.dumps(spec, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return (
        "'use strict';\n\n"
        "// Generated by scripts/generate_plugin_contracts.py. Do not edit by hand.\n"
        "// Source schemas: config/plugins/v1 through v6/*.schema.json\n"
        "// Regen: python scripts/generate_plugin_contracts.py\n"
        f"const SPEC = Object.freeze({embedded});\n"
        + JS_RUNTIME.lstrip()
    )


def python_source(spec: dict[str, Any]) -> str:
    embedded = json.dumps(spec, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    header = (
        '"""Generated plugin-platform contract validators. Do not edit by hand.\n\n'
        "Source schemas: config/plugins/v1 through v6/*.schema.json\n"
        'Regen: python scripts/generate_plugin_contracts.py\n"""\n\n'
        "# ruff: noqa: E501, C901, PLR0911, PLR0912, PLR2004\n\n"
        "from __future__ import annotations\n\n"
        "import json\nimport math\nimport re\nimport unicodedata\n"
        "from typing import Any\n\n"
        f"SPEC: dict[str, Any] = json.loads({embedded!r})\n"
        f"SAFE_INTEGER_MIN = {SAFE_INTEGER_MIN}\n"
        f"SAFE_INTEGER_MAX = {SAFE_INTEGER_MAX}\n"
    )
    return header + PY_RUNTIME.lstrip()
