"""Compare generated JS/Python Chat Lifecycle validators on one corpus."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sidecar.ai.routing.generated_chat_lifecycle_contract import (
    normalize_identifier,
    normalize_terminal_status,
    sanitize_structure,
    truncate_utf8,
)

CORPUS_PATH = ROOT / "tests" / "fixtures" / "chat-lifecycle-v2-cases.json"
PROBE_PATH = ROOT / "scripts" / "checks" / "chat_lifecycle_contract_probe.js"


def _structure_value(item: dict[str, Any]) -> Any:
    if item["kind"] == "value":
        return item["value"]
    if item["kind"] == "array":
        return list(range(int(item["size"])))
    if item["kind"] == "bytes":
        return {"text": "会" * int(item["size"])}
    value: dict[str, Any] = {"leaf": True}
    for _index in range(int(item["depth"])):
        value = {"child": value}
    return value


def _python_result(corpus: dict[str, Any]) -> dict[str, Any]:
    identifiers = []
    for value in corpus["identifier_values"]:
        ok, normalized, reason = normalize_identifier(value)
        identifiers.append({"ok": ok, "value": normalized, "reason": reason})
    return {
        "identifiers": identifiers,
        "terminals": [normalize_terminal_status(value) for value in corpus["terminal_values"]],
        "truncations": [
            truncate_utf8(item["value"], int(item["bytes"]))
            for item in corpus["truncate_cases"]
        ],
        "structures": [
            dict(zip(("value", "reason"), sanitize_structure(_structure_value(item)), strict=True))
            for item in corpus["structure_cases"]
        ],
    }


def main() -> int:
    corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    completed = subprocess.run(
        ["node", str(PROBE_PATH)],
        cwd=ROOT,
        input=json.dumps(corpus, ensure_ascii=False),
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=True,
    )
    javascript = json.loads(completed.stdout)
    python = _python_result(corpus)
    if javascript != python:
        print(
            json.dumps(
                {"javascript": javascript, "python": python},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 1
    print("Chat Lifecycle generated-contract parity: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
