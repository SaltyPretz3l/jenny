from __future__ import annotations

import json
import math
import re
from typing import Any


class BoolArgumentError(ValueError):
    def __init__(self, key: str) -> None:
        super().__init__(f"tool argument '{key}' must be a boolean")
        self.key = key


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def bounded_int(
    value: object,
    *,
    default: int,
    minimum: int = 0,
    maximum: int,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    if value < minimum:
        return default
    return min(value, maximum)


def extract_bool_argument(
    arguments: dict[str, object],
    key: str,
    *,
    default: bool = False,
) -> bool:
    value = arguments.get(key, default)
    if isinstance(value, bool):
        return value
    raise BoolArgumentError(key)


# -- Repair of nearly-right argument values (row 129, group A) --------------------
_INTEGER_TEXT = re.compile(r"-?[0-9]{1,15}")
_NUMBER_TEXT = re.compile(r"-?[0-9]{1,15}(\.[0-9]{1,15})?([eE][-+]?[0-9]{1,3})?")


def _manifest_properties(tool_name: str) -> tuple[dict[str, Any], bool]:
    """A built-in tool's argument schemas and whether its schema is closed."""
    from sidecar.ai.tools.catalog import manifest_tool_entry

    entry = manifest_tool_entry(tool_name)
    parameters = entry.get("parameters") if isinstance(entry, dict) else None
    if not isinstance(parameters, dict):
        return {}, True
    properties = parameters.get("properties")
    closed = parameters.get("additionalProperties") is False
    return (properties if isinstance(properties, dict) else {}), closed


def _repaired_value(value: str, schema_type: object) -> object:
    text = value.strip()
    repaired: object = value
    if schema_type in ("array", "object"):
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        if isinstance(parsed, list if schema_type == "array" else dict):
            repaired = parsed
    elif schema_type == "integer" and _INTEGER_TEXT.fullmatch(text):
        repaired = int(text)
    elif schema_type == "boolean" and text.lower() in ("true", "false"):
        repaired = text.lower() == "true"
    elif schema_type == "number" and _NUMBER_TEXT.fullmatch(text):
        number = float(text)
        if math.isfinite(number):
            repaired = int(text) if _INTEGER_TEXT.fullmatch(text) else number
    return repaired


def repair_stringified_values(tool_name: str, arguments: dict[str, object]) -> dict[str, object]:
    """Turn a string holding JSON or a number into the type a built-in tool's schema wants.

    Local models often send ``"[...]"`` for an array or ``"5"`` for an integer. Only a
    top-level argument whose schema names one non-string type is touched (row 129, A6).
    """
    properties, _closed = _manifest_properties(tool_name)
    repaired = arguments
    for key, value in arguments.items():
        child = properties.get(key)
        if not isinstance(value, str) or not isinstance(child, dict) or "anyOf" in child:
            continue
        fixed = _repaired_value(value, child.get("type"))
        if fixed is not value:
            if repaired is arguments:
                repaired = dict(arguments)
            repaired[key] = fixed
    return repaired


_BUTTON_MESSAGE_SPELLINGS = ("action", "text")


def repair_known_spellings(tool_name: str, arguments: dict[str, object]) -> dict[str, object]:
    """Read two spellings local models send as the one the schema names.

    An ``image_generate`` ``size`` written with spaces, a capital X, ``*`` or a times sign;
    and a ``suggest_next_step`` button's ``action`` or ``text``, read as its ``message``
    (the item schema is closed, so the argument check would refuse it before the handler,
    which accepts it, runs). A present ``message`` wins; two different texts under the two
    other names are left alone, and the check then asks for ``message``.
    """
    size = arguments.get("size")
    if tool_name == "image_generate" and isinstance(size, str):
        # "1024 x 1024", "1024X1024", "1024*1024" and "1024\u00d71024" mean "1024x1024".
        plain = re.sub(r"\s+", "", size).lower().replace("\u00d7", "x").replace("*", "x")
        return arguments if plain == size else {**arguments, "size": plain}
    actions = arguments.get("actions")
    if tool_name != "suggest_next_step" or not isinstance(actions, list):
        return arguments
    repaired: list[object] = []
    changed = False
    for action in actions:
        given = (
            [name for name in _BUTTON_MESSAGE_SPELLINGS if isinstance(action.get(name), str)]
            if isinstance(action, dict)
            else []
        )
        if not given or ("message" not in action and len({action[name] for name in given}) > 1):
            repaired.append(action)
            continue
        item = {key: value for key, value in action.items() if key not in given}
        item.setdefault("message", action[given[0]])
        repaired.append(item)
        changed = True
    return {**arguments, "actions": repaired} if changed else arguments


def ignored_argument_note(tool_name: str, arguments: object) -> str | None:
    """One line naming arguments an open-schema built-in tool does not define (row 129, A4)."""
    if not isinstance(arguments, dict):
        return None
    properties, closed = _manifest_properties(tool_name)
    if closed or not properties:
        return None
    unknown = sorted(
        str(key) for key in arguments if key not in properties and not str(key).startswith("_")
    )
    if not unknown:
        return None
    return (
        f"ignored unknown argument(s): {', '.join(unknown[:8])}. "
        f"This tool accepts: {', '.join(properties)}."
    )
