from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType


def _load_script_module(script_name: str) -> ModuleType:
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "checks" / script_name
    spec = importlib.util.spec_from_file_location(f"test_loader_{script_name}", script_path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive guard
        raise RuntimeError(f"unable to load script module: {script_name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _write_file(path: Path, content: str = "stub\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


# Fixture domain roster: must mirror REQUIRED_DOMAIN_MANIFESTS in the check
# script, in the same order, because the root manifest's 'domains' field is
# compared against it exactly. Adding a domain to the check without adding it
# here reddens every PASS-expecting test below with an unrelated-looking
# contract failure; test_workspace_manifest_fixture_covers_every_required_domain
# turns that into one legible failure instead.
_FIXTURE_DOMAINS = (
    ("ui-ux", "docs/manifests/ui-ux.md", "UI", "UI / UX"),
    ("electron-wiring", "docs/manifests/electron-wiring.md", "Electron", "Electron Wiring"),
    ("sidecar-runtime", "docs/manifests/sidecar-runtime.md", "Runtime", "Sidecar Runtime"),
    ("plugin-system", "docs/manifests/plugin-system.md", "Plugins", "Plugin System"),
)


def _root_manifest() -> str:
    domain_entries = "\n".join(f"  - {path}" for _, path, _, _ in _FIXTURE_DOMAINS)
    table_rows = "\n".join(
        f"| {column} | [{link}]({path}) |" for _, path, column, link in _FIXTURE_DOMAINS
    )
    return f"""---
kind: workspace-manifest-root
version: "1"
domains:
{domain_entries}
---

# Workspace Manifest

| If you are changing... | Open first |
|---|---|
{table_rows}
"""


def _domain_manifest(
    *,
    domain: str,
    summary: str,
    paths: list[str],
    entrypoints: list[str],
    tests: list[str],
    related_docs: list[str],
) -> str:
    def _render_list(name: str, values: list[str]) -> str:
        lines = [f"{name}:"]
        lines.extend(f"  - {value}" for value in values)
        return "\n".join(lines)

    frontmatter = "\n".join(
        [
            "---",
            "kind: workspace-manifest-domain",
            f"domain: {domain}",
            f"summary: {summary}",
            _render_list("paths", paths),
            _render_list("entrypoints", entrypoints),
            _render_list("tests", tests),
            _render_list("related_docs", related_docs),
            "---",
        ]
    )
    body = """# Domain Manifest

## Owns

- Owns the listed subsystem.

## Start Here

- Start with the listed entrypoints.

## Common Change Types

- Common changes begin here.

## Consistency Rules

- Follow the listed constraints.

## Verification

- Run the listed tests.

## Update When

- Update when the map changes.
"""
    return f"{frontmatter}\n\n{body}"


def _write_valid_fixture(repo_root: Path) -> None:
    files = [
        "renderer/App.tsx",
        "renderer/components/ErrorBanner.tsx",
        "renderer/features/use-app-controller.ts",
        "renderer/features/chat/ChatPanel.tsx",
        "renderer/inventory/primitives/index.ts",
        "renderer/inventory/primitives/primitives.test.tsx",
        "renderer/theme/ThemeProvider.tsx",
        "renderer/styles/app.css",
        "renderer/App.test.tsx",
        "renderer/features/chat/ChatPanel.test.tsx",
        "renderer/features/chat/ChatPanel.rich.test.tsx",
        "electron/main.ts",
        "electron/ipc-handlers.ts",
        "electron/sidecar.ts",
        "electron/sessions.ts",
        "electron/settings.ts",
        "electron/ipc-handlers.test.ts",
        "electron/sessions.test.ts",
        "electron/sidecar.test.ts",
        "electron/main.bootstrap.test.ts",
        "electron/settings.test.ts",
        "sidecar/server.py",
        "sidecar/protocol.py",
        "sidecar/runtime/request_dispatch.py",
        "sidecar/runtime/chat.py",
        "sidecar/runtime/rpc.py",
        "tests/sidecar/test_server.py",
        "tests/sidecar/server_core/test_protocol_io.py",
        "tests/sidecar/test_approval.py",
        "tests/sidecar/runtime/test_capabilities.py",
        "sidecar/ai/container.py",
        "sidecar/ai/routing/router.py",
        "sidecar/ai/routing/agent_executor.py",
        "sidecar/ai/context/builder.py",
        "sidecar/ai/engines/factory.py",
        "sidecar/ai/tools/executor.py",
        "sidecar/ai/memory/store.py",
        "tests/sidecar/test_server_tools.py",
        "tests/sidecar/ai/context/test_builder.py",
        "tests/sidecar/ai/engines/test_factory.py",
        "tests/sidecar/ai/tools/test_executor.py",
        "tests/sidecar/ai/memory/test_store.py",
        "tests/sidecar/ai/mcp/test_client.py",
        "services/plugins/README.md",
        "services/plugins/contracts/generated-plugin-contracts.js",
        "sidecar/ai/plugins/generated_plugin_contracts.py",
        "scripts/generate_plugin_contracts.py",
        "tests/plugin-contract-parity.test.js",
        "tests/sidecar/ai/plugins/test_plugin_contract_parity.py",
        "PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md",
        "AGENTS.md",
        "README.md",
        "NEXT_STEPS.md",
        "docs/operations/PACKAGING_FLOW.md",
        "docs/adr/ADR-0009-sidecar-packaging-strategy.md",
        "docs/adr/ADR-0003-vision-b1-attachment-privacy.md",
    ]
    for relative_path in files:
        _write_file(repo_root / relative_path)

    _write_file(repo_root / "WORKSPACE_MANIFEST.md", _root_manifest())
    _write_file(
        repo_root / "docs" / "manifests" / "ui-ux.md",
        _domain_manifest(
            domain="ui-ux",
            summary="Renderer shell and UX.",
            paths=["renderer/App.tsx", "renderer/components/", "renderer/features/"],
            entrypoints=[
                "renderer/App.tsx",
                "renderer/features/use-app-controller.ts",
                "renderer/features/chat/ChatPanel.tsx",
            ],
            tests=[
                "renderer/App.test.tsx",
                "renderer/features/chat/ChatPanel.test.tsx",
                "renderer/features/chat/ChatPanel.rich.test.tsx",
            ],
            related_docs=["AGENTS.md", "NEXT_STEPS.md", "docs/operations/PACKAGING_FLOW.md"],
        ),
    )
    _write_file(
        repo_root / "docs" / "manifests" / "electron-wiring.md",
        _domain_manifest(
            domain="electron-wiring",
            summary="Electron ownership.",
            paths=["electron/"],
            entrypoints=["electron/main.ts", "electron/ipc-handlers.ts", "electron/sidecar.ts"],
            tests=[
                "electron/ipc-handlers.test.ts",
                "electron/sessions.test.ts",
                "electron/sidecar.test.ts",
            ],
            related_docs=["AGENTS.md", "docs/operations/PACKAGING_FLOW.md"],
        ),
    )
    _write_file(
        repo_root / "docs" / "manifests" / "sidecar-runtime.md",
        _domain_manifest(
            domain="sidecar-runtime",
            summary="Runtime transport.",
            paths=["sidecar/server.py", "sidecar/protocol.py", "sidecar/runtime/"],
            entrypoints=[
                "sidecar/server.py",
                "sidecar/protocol.py",
                "sidecar/runtime/request_dispatch.py",
            ],
            tests=[
                "tests/sidecar/test_server.py",
                "tests/sidecar/server_core/test_protocol_io.py",
                "tests/sidecar/test_approval.py",
            ],
            related_docs=["AGENTS.md", "docs/operations/PACKAGING_FLOW.md"],
        ),
    )
    _write_file(
        repo_root / "docs" / "manifests" / "plugin-system.md",
        _domain_manifest(
            domain="plugin-system",
            summary="Plugin platform control plane.",
            paths=[
                "services/plugins/",
                "sidecar/ai/plugins/",
                "scripts/generate_plugin_contracts.py",
            ],
            entrypoints=[
                "services/plugins/README.md",
                "services/plugins/contracts/generated-plugin-contracts.js",
                "scripts/generate_plugin_contracts.py",
            ],
            tests=[
                "tests/plugin-contract-parity.test.js",
                "tests/sidecar/ai/plugins/test_plugin_contract_parity.py",
            ],
            related_docs=["AGENTS.md", "PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md"],
        ),
    )


def test_workspace_manifest_fixture_covers_every_required_domain(tmp_path: Path) -> None:
    """The fixture roster must track REQUIRED_DOMAIN_MANIFESTS exactly.

    Without this, adding a domain to the check script leaves the fixture one
    domain short and every PASS-expecting test in this file fails on the root
    'domains' mismatch rather than on what it set out to assert.
    """
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)

    expected = list(module.REQUIRED_DOMAIN_MANIFESTS.items())
    fixture_roster = [(domain, path) for domain, path, _, _ in _FIXTURE_DOMAINS]

    assert fixture_roster == expected, (
        "_FIXTURE_DOMAINS is out of sync with REQUIRED_DOMAIN_MANIFESTS; mirror the "
        "new domain in _FIXTURE_DOMAINS and write its manifest in _write_valid_fixture"
    )
    for _domain, manifest_path in expected:
        assert (repo_root / manifest_path).is_file(), f"fixture never writes {manifest_path}"


def test_workspace_manifest_check_passes_for_valid_structure_with_explicit_refresh(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(
        ["--changed-file", "renderer/App.tsx", "--changed-file", "docs/manifests/ui-ux.md"]
    )
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: workspace manifest contract" in output
    assert "freshness validated" in output


def test_workspace_manifest_check_fails_when_required_domain_file_is_missing(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    (repo_root / "docs" / "manifests" / "sidecar-runtime.md").unlink()
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(["--changed-file", "docs/manifests/ui-ux.md"])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: workspace manifest contract" in output
    assert "missing manifest file: docs/manifests/sidecar-runtime.md" in output


def test_workspace_manifest_check_fails_when_frontmatter_is_malformed(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    _write_file(
        repo_root / "docs" / "manifests" / "electron-wiring.md",
        """---
kind workspace-manifest-domain
---
""",
    )
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(["--changed-file", "docs/manifests/electron-wiring.md"])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "invalid frontmatter" in output


def test_workspace_manifest_check_fails_when_referenced_path_is_missing(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    _write_file(
        repo_root / "docs" / "manifests" / "sidecar-runtime.md",
        _domain_manifest(
            domain="sidecar-runtime",
            summary="Runtime transport.",
            paths=["sidecar/does-not-exist.py"],
            entrypoints=["sidecar/server.py"],
            tests=["tests/sidecar/test_server.py"],
            related_docs=["AGENTS.md"],
        ),
    )
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(["--changed-file", "docs/manifests/sidecar-runtime.md"])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "references missing path in 'paths': sidecar/does-not-exist.py" in output


def test_workspace_manifest_check_warns_instead_of_failing_for_ui_ux_missing_paths(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    """ui-ux is in MISSING_PATH_WARN_DOMAINS — deleted files surface as warnings.

    Sessions deleting renderer files must not be forced to edit ui-ux.md (a
    contended hot file on the on-request refresh cadence) nor leave main red.
    """
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    _write_file(
        repo_root / "docs" / "manifests" / "ui-ux.md",
        _domain_manifest(
            domain="ui-ux",
            summary="Renderer shell and UX.",
            paths=["renderer/does-not-exist.tsx"],
            entrypoints=["renderer/App.tsx"],
            tests=["renderer/deleted.test.tsx"],
            related_docs=["NEXT_STEPS.md"],
        ),
    )
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(["--changed-file", "docs/manifests/ui-ux.md"])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: workspace manifest contract" in output
    assert "WARN: docs/manifests/ui-ux.md references missing path in 'paths': renderer/does-not-exist.tsx" in output
    assert "WARN: docs/manifests/ui-ux.md references missing path in 'tests': renderer/deleted.test.tsx" in output
    assert "FAIL" not in output


def test_workspace_manifest_check_rejects_absolute_or_outside_repo_paths(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    _write_file(
        repo_root / "docs" / "manifests" / "ui-ux.md",
        _domain_manifest(
            domain="ui-ux",
            summary="Renderer shell and UX.",
            paths=["C:/external/file.tsx", "../renderer/App.tsx"],
            entrypoints=["renderer/App.tsx"],
            tests=["renderer/App.test.tsx"],
            related_docs=["NEXT_STEPS.md"],
        ),
    )
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(["--changed-file", "docs/manifests/ui-ux.md"])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "field 'paths' must use repo-relative paths only: C:/external/file.tsx" in output
    assert "field 'paths' must use repo-relative paths only: ../renderer/App.tsx" in output


def test_workspace_manifest_check_rejects_nested_parent_traversal_paths(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    _write_file(
        repo_root / "docs" / "manifests" / "ui-ux.md",
        _domain_manifest(
            domain="ui-ux",
            summary="Renderer shell and UX.",
            paths=["renderer/App.tsx", "docs/../../outside.txt"],
            entrypoints=["renderer/App.tsx"],
            tests=["renderer/App.test.tsx"],
            related_docs=["NEXT_STEPS.md"],
        ),
    )
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(["--changed-file", "docs/manifests/ui-ux.md"])
    output = capsys.readouterr().out.replace("\\", "/")

    assert exit_code == 1
    assert "field 'paths' must use repo-relative paths only: docs/../../outside.txt" in output


def test_workspace_manifest_check_fails_when_root_manifest_link_is_missing(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    _write_file(
        repo_root / "WORKSPACE_MANIFEST.md",
        _root_manifest().replace(
            "[Sidecar Runtime](docs/manifests/sidecar-runtime.md)", "Sidecar Runtime"
        ),
    )
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(["--changed-file", "WORKSPACE_MANIFEST.md"])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "must link to domain manifest: docs/manifests/sidecar-runtime.md" in output


def test_workspace_manifest_check_fails_when_changed_domain_manifest_is_not_refreshed(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(["--changed-file", "electron/ipc-handlers.ts"])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: workspace manifest freshness" in output
    assert "docs/manifests/electron-wiring.md was not updated" in output


def test_workspace_manifest_check_enforces_freshness_for_plugin_system(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    """plugin-system is not freshness-exempt: a plugin-tree edit must pair with it."""
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(
        ["--changed-file", "services/plugins/contracts/generated-plugin-contracts.js"]
    )
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: workspace manifest freshness" in output
    assert "docs/manifests/plugin-system.md was not updated" in output


def test_workspace_manifest_check_plugin_system_freshness_clears_when_manifest_is_paired(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(
        [
            "--changed-file",
            "services/plugins/contracts/generated-plugin-contracts.js",
            "--changed-file",
            "docs/manifests/plugin-system.md",
        ]
    )
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: workspace manifest contract" in output
    assert "FAIL: workspace manifest freshness" not in output


def test_workspace_manifest_check_exempts_ui_ux_from_freshness_enforcement(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    """ui-ux is in FRESHNESS_EXEMPT_DOMAINS — renderer edits alone pass."""
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(["--changed-file", "renderer/features/chat/ChatPanel.tsx"])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: workspace manifest contract" in output
    assert "FAIL: workspace manifest freshness" not in output


def test_workspace_manifest_check_ui_ux_exemption_does_not_mask_electron_wiring(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    """A mixed renderer + electron diff still fails on the electron-wiring side."""
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)

    exit_code = module.main(
        [
            "--changed-file",
            "renderer/features/chat/ChatPanel.tsx",
            "--changed-file",
            "electron/ipc-handlers.ts",
        ]
    )
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "FAIL: workspace manifest freshness" in output
    assert "docs/manifests/electron-wiring.md was not updated" in output
    assert "docs/manifests/ui-ux.md was not updated" not in output


def test_workspace_manifest_check_uses_env_changed_files_when_git_metadata_is_unavailable(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setenv(
        "JENNYGC3_CHANGED_FILES",
        "renderer/features/chat/ChatPanel.tsx\ndocs/manifests/ui-ux.md\nrenderer/features/chat/ChatPanel.tsx\n",
    )

    exit_code = module.main([])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: workspace manifest contract" in output
    assert "freshness validated" in output
    assert "from env" in output


def test_workspace_manifest_check_warns_when_git_metadata_is_unavailable_and_no_changed_files_are_supplied(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    _write_valid_fixture(repo_root)
    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.delenv("JENNYGC3_CHANGED_FILES", raising=False)

    exit_code = module.main([])
    output = capsys.readouterr().out

    assert exit_code == 0
    assert "PASS: workspace manifest contract" in output
    assert "workspace manifest freshness not enforced" in output
    assert "JENNYGC3_CHANGED_FILES" in output


def test_workspace_manifest_change_detection_prefers_origin_main(
    tmp_path: Path,
    monkeypatch,
) -> None:
    # origin/main must win over local main: on a checkout of main itself the
    # local-main merge base is HEAD, so the diff is empty and the check passes
    # vacuously.
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True)
    calls: list[list[str]] = []

    def _fake_git(args: list[str]) -> tuple[int, str, str]:
        calls.append(args)
        if args == ["rev-parse", "--is-inside-work-tree"]:
            return 0, "true\n", ""
        if args == ["merge-base", "origin/main", "HEAD"]:
            return 0, "remote123\n", ""
        if args == ["diff", "--name-only", "--diff-filter=ACDMR", "remote123...HEAD"]:
            return 0, "scripts/checks/run_all.py\n", ""
        if args == ["status", "--porcelain", "--untracked-files=normal"]:
            return 0, "", ""
        return 1, "", "unexpected command"

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_run_git_command", _fake_git)

    changed_files, fallback_reason = module._collect_git_changed_files(None, None)

    assert fallback_reason is None
    assert changed_files == ["scripts/checks/run_all.py"]
    assert ["merge-base", "main", "HEAD"] not in calls


def test_workspace_manifest_change_detection_falls_back_to_local_main(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True)

    def _fake_git(args: list[str]) -> tuple[int, str, str]:
        if args == ["rev-parse", "--is-inside-work-tree"]:
            return 0, "true\n", ""
        if args == ["merge-base", "origin/main", "HEAD"]:
            return 1, "", "no such ref"
        if args == ["merge-base", "main", "HEAD"]:
            return 0, "local123\n", ""
        if args == ["diff", "--name-only", "--diff-filter=ACDMR", "local123...HEAD"]:
            return 0, "scripts/checks/run_all.py\n", ""
        if args == ["status", "--porcelain", "--untracked-files=normal"]:
            return 0, "", ""
        return 1, "", "unexpected command"

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_run_git_command", _fake_git)

    changed_files, fallback_reason = module._collect_git_changed_files(None, None)

    assert fallback_reason is None
    assert changed_files == ["scripts/checks/run_all.py"]


def test_workspace_manifest_change_detection_reports_all_merge_base_failures(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True)

    def _fake_git(args: list[str]) -> tuple[int, str, str]:
        if args == ["rev-parse", "--is-inside-work-tree"]:
            return 0, "true\n", ""
        if args and args[0] == "merge-base":
            return 1, "", "no merge base"
        if args == ["status", "--porcelain", "--untracked-files=normal"]:
            return 0, "", ""
        return 1, "", "unexpected command"

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_run_git_command", _fake_git)

    changed_files, fallback_reason = module._collect_git_changed_files(None, None)

    assert changed_files == []
    assert fallback_reason == (
        "git merge-base failed for origin/main and HEAD: no merge base; "
        "git merge-base failed for main and HEAD: no merge base"
    )


def test_committed_deletion_is_reported_as_a_changed_path(
    tmp_path: Path,
    monkeypatch,
) -> None:
    # W6-08-F06. A removal changes a domain's ownership surface as much as an edit
    # does. With ACMR the deletion was invisible, so a branch whose only change was
    # a removal presented an EMPTY change set and freshness passed having checked
    # nothing. The stub answers ONLY the ACDMR form: an ACMR query falls through to
    # 'unexpected command' and surfaces as a fallback_reason.
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True)

    def _fake_git(args: list[str]) -> tuple[int, str, str]:
        if args == ["rev-parse", "--is-inside-work-tree"]:
            return 0, "true\n", ""
        if args == ["merge-base", "origin/main", "HEAD"]:
            return 0, "remote123\n", ""
        if args == ["diff", "--name-only", "--diff-filter=ACDMR", "remote123...HEAD"]:
            return 0, "sidecar/runtime/retry.py\n", ""
        if args == ["status", "--porcelain", "--untracked-files=normal"]:
            return 0, "", ""
        return 1, "", "unexpected command"

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_run_git_command", _fake_git)

    changed_files, fallback_reason = module._collect_git_changed_files(None, None)

    assert fallback_reason is None
    assert changed_files == ["sidecar/runtime/retry.py"]


def test_merge_base_failure_is_reported_even_when_the_worktree_is_dirty(
    tmp_path: Path,
    monkeypatch,
) -> None:
    # W6-08-F07, second half. A non-empty git status must not be mistaken for a
    # complete change set: the committed history is still unexamined, so the caller
    # has to hear about it rather than enforce freshness against the worktree alone.
    module = _load_script_module("check_workspace_manifest.py")
    repo_root = tmp_path / "repo"
    (repo_root / ".git").mkdir(parents=True)

    def _fake_git(args: list[str]) -> tuple[int, str, str]:
        if args == ["rev-parse", "--is-inside-work-tree"]:
            return 0, "true\n", ""
        if args and args[0] == "merge-base":
            return 1, "", "no merge base"
        if args == ["status", "--porcelain", "--untracked-files=normal"]:
            return 0, " M scripts/checks/run_all.py\n", ""
        return 1, "", "unexpected command"

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "_run_git_command", _fake_git)

    changed_files, fallback_reason = module._collect_git_changed_files(None, None)

    assert changed_files == ["scripts/checks/run_all.py"]
    assert fallback_reason is not None
    assert "merge-base failed" in fallback_reason
