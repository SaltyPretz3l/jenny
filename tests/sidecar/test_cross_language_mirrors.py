"""Constants that exist once in JavaScript and once in Python must match.

Each pair bounds or names the same data on both sides of the Electron/sidecar
boundary, and each side carries a comment asking a human to keep it in step
with the other. This module loads both sides and compares them, so a change to
one side fails here instead of drifting.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from sidecar.ai.context import interruption_overlay
from sidecar.ai.engines import provider_descriptor_v6
from sidecar.runtime import approval, chat_normalization

REPO_ROOT = Path(__file__).resolve().parents[2]

# One node process loads every JavaScript side.
_NODE_SCRIPT = """
const blocks = require('./services/backend/chat-send-context-blocks');
const receipts = require('./services/backend/interrupted-turn-receipts');
const providers = require('./services/backend/api-provider-config');
const exitPlanMode = require('./services/tools/builtin/exit-plan-mode-tool');
process.stdout.write(JSON.stringify({
  context_block_kinds: [...blocks.CONTEXT_BLOCK_KINDS],
  max_context_blocks: blocks.MAX_CONTEXT_BLOCKS,
  max_context_block_bytes: blocks.MAX_CONTEXT_BLOCK_BYTES,
  max_context_blocks_total_bytes: blocks.MAX_CONTEXT_BLOCKS_TOTAL_BYTES,
  interrupted_turn_entries: receipts.DEFAULT_RECEIPTS_CAP,
  interrupted_turn_tool_name: receipts.MAX_TOOL_NAME,
  interrupted_turn_summary: receipts.MAX_SUMMARY,
  reserved_provider_ids: [...providers.RESERVED_INSTANCE_IDS],
  plan_decisions: [...exitPlanMode.PLAN_DECISIONS],
}));
"""


@pytest.fixture(scope="module")
def javascript_side() -> dict[str, object]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not on PATH")
    result = subprocess.run(
        [node, "-e", _NODE_SCRIPT],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    loaded = json.loads(result.stdout)
    assert isinstance(loaded, dict)
    return loaded


def _python_side() -> dict[str, object]:
    return {
        "context_block_kinds": sorted(chat_normalization.CONTEXT_BLOCK_KINDS),
        "max_context_blocks": chat_normalization.MAX_CONTEXT_BLOCKS,
        "max_context_block_bytes": chat_normalization.MAX_CONTEXT_BLOCK_BYTES,
        "max_context_blocks_total_bytes": chat_normalization.MAX_CONTEXT_BLOCKS_TOTAL_BYTES,
        "interrupted_turn_entries": interruption_overlay.INTERRUPTED_TURN_MAX_ENTRIES_PER_SECTION,
        "interrupted_turn_tool_name": interruption_overlay._INTERRUPTED_TURN_MAX_TOOL_NAME,
        "interrupted_turn_summary": interruption_overlay._INTERRUPTED_TURN_MAX_SUMMARY,
        "reserved_provider_ids": sorted(provider_descriptor_v6.RESERVED_PROVIDER_IDS),
        "plan_decisions": sorted(approval.PLAN_DECISIONS),
    }


@pytest.mark.parametrize("name", sorted(_python_side()))
def test_javascript_and_python_hold_the_same_value(name: str, javascript_side: dict[str, object]) -> None:
    assert name in javascript_side, f"the JavaScript side does not export {name}"
    javascript_value = javascript_side[name]
    if isinstance(javascript_value, list):
        assert len(javascript_value) == len(set(javascript_value)), f"{name} repeats an entry in JavaScript"
        javascript_value = sorted(javascript_value)
    assert javascript_value == _python_side()[name]


def test_every_javascript_value_has_a_python_counterpart(javascript_side: dict[str, object]) -> None:
    assert sorted(javascript_side) == sorted(_python_side())
