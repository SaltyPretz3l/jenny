"""Load the sharded plugin contract-parity corpus.

The corpus is split into per-packet shard files under
tests/fixtures/plugins/contract-parity/shards/ so that parallel authoring lanes
each own one file and never collide on a single shared corpus. Shards are read
in sorted filename order and concatenated, so the flattened case order — and
therefore the cross-runtime differ's comparison order — stays deterministic.

Each shard is a self-contained document:

    {"cases": [{"id": ..., "contract": ..., "value": ...}, ...],
     "expectations": {"<id>": {"ok": bool, "error_code": ..., "error_path": ...}}}

Keeping cases and their frozen expectations in one file means a lane adding a
case cannot forget its expectation in a different file, and the JS loader in
tests/helpers/plugins/contract-parity-corpus.js mirrors this module exactly.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SHARDS_DIR = ROOT / "tests" / "fixtures" / "plugins" / "contract-parity" / "shards"


class ParityCorpusError(ValueError):
    """Raised when a shard is structurally invalid or collides with another."""


def shard_paths() -> list[Path]:
    return sorted(SHARDS_DIR.glob("*.json"))


def load_parity_corpus() -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    paths = shard_paths()
    if not paths:
        raise ParityCorpusError(f"{SHARDS_DIR}: no parity corpus shards found")

    cases: list[dict[str, Any]] = []
    expectations: dict[str, dict[str, Any]] = {}
    owner: dict[str, str] = {}

    for path in paths:
        name = path.name
        document = json.loads(path.read_text(encoding="utf-8"))
        shard_cases = document.get("cases")
        shard_expectations = document.get("expectations")
        if not isinstance(shard_cases, list) or not shard_cases:
            raise ParityCorpusError(f"{name}: 'cases' must be a non-empty list")
        if not isinstance(shard_expectations, dict):
            raise ParityCorpusError(f"{name}: 'expectations' must be a map")

        shard_ids: list[str] = []
        for position, case in enumerate(shard_cases, start=1):
            if not isinstance(case, dict):
                raise ParityCorpusError(f"{name}: case {position} must be an object")
            case_id = case.get("id")
            if not isinstance(case_id, str) or not case_id.strip():
                raise ParityCorpusError(
                    f"{name}: case {position} must have a non-empty string 'id'"
                )
            shard_ids.append(case_id)
        if len(set(shard_ids)) != len(shard_ids):
            raise ParityCorpusError(f"{name}: duplicate case ids within the shard")
        if set(shard_ids) != set(shard_expectations.keys()):
            missing = sorted(set(shard_ids) - set(shard_expectations.keys()))
            extra = sorted(set(shard_expectations.keys()) - set(shard_ids))
            raise ParityCorpusError(f"{name}: cases/expectations mismatch (missing={missing}, unexpected={extra})")

        for case_id in shard_ids:
            if case_id in owner:
                raise ParityCorpusError(f"{name}: case id '{case_id}' already defined by {owner[case_id]}")
            owner[case_id] = name

        cases.extend(shard_cases)
        expectations.update(shard_expectations)

    return cases, expectations
