"""Derived import facts for suggested changes (Plan Plus W3, working spec decision 4)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.propose_facts import derive_import_facts
from sidecar.ai.tools.builtins.propose_suggestion import LiveSuggestion
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> tuple[Path, WorkspaceGuard]:
    root = tmp_path / "ws"
    (root / "src" / "util").mkdir(parents=True)
    (root / "src" / "util" / "dates.py").write_text("def parse_day(t):\n    return t\n", encoding="utf-8")
    (root / "web" / "lib").mkdir(parents=True)
    (root / "web" / "lib" / "format.ts").write_text("export const fmt = 1;\n", encoding="utf-8")
    return root, WorkspaceGuard(str(root), pre_change_snapshot_root=str(tmp_path / "snap"))


def test_python_relative_imports_report_missing_targets_and_removed_imports(tmp_path: Path) -> None:
    _root, guard = _guard(tmp_path)
    facts = derive_import_facts(
        relative_path="src/app.py",
        kind="replace",
        old_string="import os\nfrom .legacy import old_helper\n",
        new_string="import os\nfrom .util.dates import parse_day\nfrom .util.money import cents\n",
        workspace=guard,
    )
    assert facts == [
        {"kind": "import_removed", "name": ".legacy"},
        {"kind": "import_missing", "name": ".util.money", "target": "src/util/money"},
    ]


def test_a_live_create_counts_as_existing(tmp_path: Path) -> None:
    _root, guard = _guard(tmp_path)
    live = (LiveSuggestion("sc_1", "src/util/money.py", "create", ""),)
    facts = derive_import_facts(
        relative_path="src/app.py", kind="replace", old_string="x = 1\n",
        new_string="from .util.money import cents\nx = 1\n", workspace=guard, live=live,
    )
    assert facts == []


def test_js_relative_imports_resolve_extensions_and_index_files(tmp_path: Path) -> None:
    root, guard = _guard(tmp_path)
    (root / "web" / "pages").mkdir()
    (root / "web" / "widgets").mkdir()
    (root / "web" / "widgets" / "index.js").write_text("", encoding="utf-8")
    facts = derive_import_facts(
        relative_path="web/pages/home.js",
        kind="create",
        old_string="",
        new_string=(
            "import { fmt } from '../lib/format';\n"
            "import w from '../widgets';\n"
            "const x = require('./missing.js');\n"
            "import React from 'react';\n"
        ),
        workspace=guard,
    )
    assert facts == [{"kind": "import_missing", "name": "./missing.js", "target": "web/pages/missing.js"}]


def test_absolute_imports_and_escapes_are_never_reported(tmp_path: Path) -> None:
    _root, guard = _guard(tmp_path)
    facts = derive_import_facts(
        relative_path="app.py", kind="replace", old_string="a = 1\n",
        new_string="import nowhere.module\nfrom ...outside import x\na = 1\n", workspace=guard,
    )
    assert facts == []
    js = derive_import_facts(
        relative_path="index.js", kind="create", old_string="",
        new_string="import x from '../../etc/passwd';\n", workspace=guard,
    )
    assert js == []


@pytest.mark.skipif(os.name == "nt", reason="symlink creation needs privileges on Windows")
def test_a_link_out_of_the_workspace_is_not_provable(tmp_path: Path) -> None:
    root, guard = _guard(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "src" / "out").symlink_to(outside, target_is_directory=True)
    facts = derive_import_facts(
        relative_path="src/app.py", kind="replace", old_string="a = 1\n",
        new_string="from .out.thing import x\na = 1\n", workspace=guard,
    )
    assert facts == []


def test_unchanged_imports_and_other_languages_say_nothing(tmp_path: Path) -> None:
    _root, guard = _guard(tmp_path)
    same = derive_import_facts(
        relative_path="src/app.py", kind="replace", old_string="from .gone import a\nx = 1\n",
        new_string="from .gone import a\nx = 2\n", workspace=guard,
    )
    assert same == []
    other = derive_import_facts(
        relative_path="README.md", kind="replace", old_string="a", new_string="import x from './y'",
        workspace=guard,
    )
    assert other == []


def test_propose_change_records_the_facts_in_its_metadata(tmp_path: Path) -> None:
    from sidecar.ai.tools.builtins import filesystem as filesystem_module
    from sidecar.ai.tools.builtins.propose_change import propose_change_tool

    filesystem_module.configure_filesystem_tools(None)
    root, guard = _guard(tmp_path)
    (root / "src" / "app.py").write_text("import os\n", encoding="utf-8")
    result = propose_change_tool(
        {
            "path": "src/app.py", "kind": "replace", "old_string": "import os\n",
            "new_string": "import os\nfrom .util.money import cents\n",
            "title": "Use cents", "what": "Prices use cents.", "why": "Rounding.",
        },
        guard,
    )
    assert result.success is True
    facts = result.metadata["suggested_change"]["facts"]
    assert facts == [{"kind": "import_missing", "name": ".util.money", "target": "src/util/money"}]
