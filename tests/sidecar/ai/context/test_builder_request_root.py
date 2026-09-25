"""Workspace-derived prompt blocks follow the request authority's root.

Regression for the 2026-09-16 "hallucinated workspace" sessions: one
process-wide ``ContextBuilder`` (constructed from the global
``tools_workspace_root``) kept injecting that folder's ``agentj.md``,
``BOOTSTRAP`` files and workspace manifest into sessions whose project had no
folder bound, while the tool contract and the session-environment overlay for
the same request said the workspace was unbound. The request root now wins:
``None`` renders none of those blocks, a different root renders that root's
blocks, and an omitted root keeps the constructor-root behaviour.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from sidecar.ai.context.builder import (
    ContextBuilder,
    RuntimeToolStatus,
    request_workspace_root_kwargs,
)

INSTRUCTIONS_HEADING = "## Workspace Instructions (agentj.md)"
MANIFEST_HEADING = "## Workspace Manifest"


def _workspace(tmp_path: Path, name: str) -> Path:
    root = tmp_path / name
    (root / "BOOTSTRAP").mkdir(parents=True)
    (root / "BOOTSTRAP" / "IDENTITY.md").write_text(f"{name}-IDENTITY", encoding="utf-8")
    (root / "agentj.md").write_text(f"{name}-AGENTJ", encoding="utf-8")
    (root / "package.json").write_text("{}", encoding="utf-8")
    return root


def _build(builder: ContextBuilder, **kwargs: object) -> str:
    return str(
        builder.build_system_prompt(
            "Base system prompt.",
            workspace_manifest_enabled=True,
            **kwargs,
        )
    )


def test_unbound_request_root_renders_no_workspace_blocks(tmp_path: Path) -> None:
    startup = _workspace(tmp_path, "startup")

    prompt = _build(ContextBuilder(startup), request_workspace_root=None)

    assert INSTRUCTIONS_HEADING not in prompt
    assert MANIFEST_HEADING not in prompt
    assert "startup-AGENTJ" not in prompt
    assert "startup-IDENTITY" not in prompt


def test_request_root_replaces_constructor_root(tmp_path: Path) -> None:
    startup = _workspace(tmp_path, "startup")
    bound = _workspace(tmp_path, "bound")

    prompt = _build(ContextBuilder(startup), request_workspace_root=str(bound))

    assert "bound-AGENTJ" in prompt
    assert "bound-IDENTITY" in prompt
    assert MANIFEST_HEADING in prompt
    assert "startup-AGENTJ" not in prompt
    assert "startup-IDENTITY" not in prompt


def test_omitted_request_root_keeps_constructor_root(tmp_path: Path) -> None:
    startup = _workspace(tmp_path, "startup")

    prompt = _build(ContextBuilder(startup))

    assert "startup-AGENTJ" in prompt
    assert "startup-IDENTITY" in prompt
    assert MANIFEST_HEADING in prompt


def test_alternating_request_roots_never_serve_a_stale_cache(tmp_path: Path) -> None:
    startup = _workspace(tmp_path, "startup")
    bound = _workspace(tmp_path, "bound")
    builder = ContextBuilder(startup)

    for _ in range(2):
        for root, present, absent in (
            (bound, "bound", "startup"),
            (None, "", "bound"),
            (startup, "startup", "bound"),
        ):
            prompt = _build(builder, request_workspace_root=root)
            if present:
                assert f"{present}-AGENTJ" in prompt
                assert f"{present}-IDENTITY" in prompt
            else:
                assert INSTRUCTIONS_HEADING not in prompt
            assert f"{absent}-AGENTJ" not in prompt
            assert f"{absent}-IDENTITY" not in prompt

    # The direct loaders honour the same precedence for callers that prewarm
    # or inspect them; passing nothing still means the constructor root.
    assert builder._load_workspace_instruction_block() == (  # noqa: SLF001
        f"{INSTRUCTIONS_HEADING}\nstartup-AGENTJ"
    )
    assert builder._load_workspace_instruction_block(bound) == (  # noqa: SLF001
        f"{INSTRUCTIONS_HEADING}\nbound-AGENTJ"
    )
    assert builder._load_workspace_instruction_block(None) == ""  # noqa: SLF001
    assert builder._load_bootstrap_blocks(None) == []  # noqa: SLF001


def test_request_root_kwargs_carry_the_authority_root_except_under_host_policy() -> None:
    local = SimpleNamespace(host_mode="desktop", host_execution_policy_version=None)
    hosted = SimpleNamespace(host_mode="server", host_execution_policy_version=1)
    unbound = SimpleNamespace(root_path=None)
    bound = SimpleNamespace(root_path="C:/bound/project")

    assert request_workspace_root_kwargs(local, None) == {}
    assert request_workspace_root_kwargs(local, unbound) == {"request_workspace_root": None}
    assert request_workspace_root_kwargs(local, bound) == {
        "request_workspace_root": "C:/bound/project"
    }
    # Hosted policy hides physical workspace context entirely, so the request
    # root never reaches the builder there (the container root is already None).
    assert request_workspace_root_kwargs(hosted, bound) == {}
    assert request_workspace_root_kwargs(hosted, unbound) == {}


def test_source_access_guidance_names_the_bound_folder(tmp_path: Path) -> None:
    startup = _workspace(tmp_path, "startup")
    bound = _workspace(tmp_path, "ascend-like")
    statuses = [
        RuntimeToolStatus(
            name="read_file",
            display_name="Read File",
            available=True,
            tool_family="filesystem",
        )
    ]

    prompt = _build(
        ContextBuilder(startup),
        request_workspace_root=bound,
        latest_user_content="Explain the architecture of this codebase.",
        tool_statuses=statuses,
    )

    assert "## Workspace Source Access" in prompt
    assert "The workspace bound to this request is the `ascend-like` folder." in prompt
    assert "Jenny source repository" not in prompt
    assert "`startup`" not in prompt
