"""Wiring/integration tests for the "repository-delta on resume" feature.

The pure git module (`sidecar/ai/repo_delta/git_delta.py`) and the persistence
/orchestration seam (`sidecar/ai/repo_delta/service.py`) already have unit
coverage in `tests/sidecar/ai/repo_delta/`. This file covers the WIRING that
connects that seam to the rest of the runtime -- the parts a unit test of
`service.py` alone cannot catch:

  A. the `<repository-delta>` heading is registered wherever a runtime-only
     system message needs to be recognized (both copies -- see the H4 note
     below -- plus the recognizer itself), which is what lets approval-resume
     preserve the block instead of tripping `approval_plan_drift`;
  B. `append_repository_delta_runtime_system_message` (the flag-gated,
     fail-closed overlay-append wrapper) actually calls into the service and
     appends/skips correctly;
  C. `build_chat_decision` only invokes the overlay for depth-0 (non-sub-agent)
     turns;
  D. `_maybe_refresh_repo_anchor` (the run-end wrapper) actually calls
     `refresh_repo_anchor` and is itself flag-gated and fail-closed;
  E. a `<repository-delta>`-headed runtime system message frozen into an
     approval plan survives the live-context resume path byte-identical.

Written against the task contract, not against whatever the implementation
happens to do -- a disagreement between the two is a real finding and is
asserted here rather than avoided or softened. See the docstring on each
section below for any such deviations found while authoring this suite.

Note on the two heading registries: `RUNTIME_SYSTEM_MESSAGE_HEADINGS` is
imported into `sidecar/ai/context/builder_shared.py` from
`runtime_message_markers.py` (single source of truth) rather than redefined,
so both names are asserted to point at the exact same tuple object below --
if `builder_shared` ever forked its own copy, section A would catch the drift.
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context import builder_shared, runtime_message_markers
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.context.runtime_overlays import (
    RuntimeOverlayLogContext,
    append_repository_delta_runtime_system_message,
)
from sidecar.ai.repo_delta.service import (
    read_repo_anchor,
    refresh_repo_anchor,
    repo_anchor_path,
)
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.tools.models import GenerationResult
from sidecar.runtime.chat import _build_live_dynamic_system_messages, _maybe_refresh_repo_anchor
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.chat_resume import _build_live_approval_working_messages

# ---------------------------------------------------------------------------
# Real-git fixtures/helpers (small git fixtures are deliberately duplicated
# per test file across this codebase -- see test_git_delta.py's own header
# comment -- rather than shared).
# ---------------------------------------------------------------------------


def _git_available() -> bool:
    return (
        subprocess.run(
            ["git", "--version"], capture_output=True, text=True, check=False
        ).returncode
        == 0
    )


def _skip_if_no_git() -> None:
    if not _git_available():
        pytest.skip("git is unavailable in this environment")


def _init_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init"], cwd=path, capture_output=True, text=True, check=True)
    subprocess.run(
        ["git", "symbolic-ref", "HEAD", "refs/heads/main"],
        cwd=path,
        capture_output=True,
        text=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=path,
        capture_output=True,
        text=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Jenny Test"],
        cwd=path,
        capture_output=True,
        text=True,
        check=True,
    )


def _commit(path: Path, filename: str, content: str, message: str) -> str:
    target = path / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=path, capture_output=True, text=True, check=True)
    subprocess.run(
        ["git", "commit", "-m", message], cwd=path, capture_output=True, text=True, check=True
    )
    return _head_sha(path)


def _head_sha(path: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=path, capture_output=True, text=True, check=True
    ).stdout.strip()


def _config(**overrides: object) -> RuntimeConfig:
    return RuntimeConfig(repo_delta_resume_enabled=True, **overrides)  # type: ignore[arg-type]


def _snapshot_tree(root: Path) -> frozenset[str]:
    if not root.exists():
        return frozenset()
    return frozenset(str(p.relative_to(root)) for p in root.rglob("*"))


@pytest.fixture()
def anchors_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect `resolve_background_runtime_root` at a temp dir (mirrors test_service.py)."""
    base = tmp_path / "background-memory"
    monkeypatch.setattr(
        "sidecar.ai.repo_delta.service.resolve_background_runtime_root",
        lambda _config: base,
    )
    return base / "repo-anchors"


def _log_context(*, session_id: str | None, request_id: str = "req-overlay-test") -> RuntimeOverlayLogContext:
    return RuntimeOverlayLogContext(
        logger=logging.getLogger("sidecar.ai.repo_delta.overlay_test"),
        component="ai.router",
        event="ai.router.repository_delta_overlay_failed",
        request_id=request_id,
        session_id=session_id,
    )


# ===========================================================================
# A. Heading registration (load-bearing)
# ===========================================================================


def test_repository_delta_heading_constant_value() -> None:
    assert runtime_message_markers.REPOSITORY_DELTA_HEADING == "<repository-delta>"


def test_repository_delta_heading_registered_in_runtime_message_markers() -> None:
    assert (
        runtime_message_markers.REPOSITORY_DELTA_HEADING
        in runtime_message_markers.RUNTIME_SYSTEM_MESSAGE_HEADINGS
    )


def test_repository_delta_heading_registered_in_builder_shared() -> None:
    # builder_shared imports (not redefines) RUNTIME_SYSTEM_MESSAGE_HEADINGS from
    # runtime_message_markers -- assert both the membership AND that it is the
    # SAME tuple object, so a future fork of the constant is caught here too.
    assert (
        runtime_message_markers.REPOSITORY_DELTA_HEADING
        in builder_shared.RUNTIME_SYSTEM_MESSAGE_HEADINGS
    )
    assert (
        builder_shared.RUNTIME_SYSTEM_MESSAGE_HEADINGS
        is runtime_message_markers.RUNTIME_SYSTEM_MESSAGE_HEADINGS
    )


def test_is_runtime_system_message_recognizes_repository_delta_block() -> None:
    content = (
        "<repository-delta>\n"
        "The repository changed since this conversation last worked in it.\n"
        "HEAD: abc1234 -> def5678 (2 ahead, 0 behind)\n"
        "</repository-delta>"
    )
    assert ContextBuilder.is_runtime_system_message(content) is True


def test_is_runtime_system_message_rejects_unrelated_content() -> None:
    assert ContextBuilder.is_runtime_system_message("just a normal user message") is False


# ===========================================================================
# B. Overlay append (core integration): append_repository_delta_runtime_system_message
# ===========================================================================


class _FakeContextBuilder:
    """Minimal stand-in exposing only the `workspace_root` attribute the overlay reads."""

    def __init__(self, workspace_root: str) -> None:
        self.workspace_root = workspace_root


def test_append_repository_delta_appends_block_when_repo_has_diverged(
    tmp_path: Path, anchors_root: Path
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()
    session_id = "session-overlay-append"
    refresh_repo_anchor(config=config, session_id=session_id, workspace_root=str(repo))
    _commit(repo, "b.txt", "two\n", "second")

    runtime_system_messages: list[str] = []
    append_repository_delta_runtime_system_message(
        runtime_system_messages,
        config=config,
        context_builder=_FakeContextBuilder(str(repo)),
        session_id=session_id,
        log_context=_log_context(session_id=session_id),
    )

    assert len(runtime_system_messages) == 1
    assert runtime_system_messages[0].startswith("<repository-delta>")
    assert "second" in runtime_system_messages[0]


def test_append_repository_delta_flag_off_appends_nothing_and_never_calls_service(
    tmp_path: Path, anchors_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[dict[str, Any]] = []

    def spy(**kwargs: Any) -> str:
        calls.append(kwargs)
        return "<repository-delta>\nshould never be reached\n</repository-delta>"

    monkeypatch.setattr("sidecar.ai.repo_delta.service.build_repository_delta_block", spy)

    config = RuntimeConfig(repo_delta_resume_enabled=False)
    runtime_system_messages: list[str] = []
    append_repository_delta_runtime_system_message(
        runtime_system_messages,
        config=config,
        context_builder=_FakeContextBuilder(str(tmp_path)),
        session_id="session-flag-off",
        log_context=_log_context(session_id="session-flag-off"),
    )

    assert runtime_system_messages == []
    assert calls == [], "flag off must short-circuit before the service is ever imported/called"


def test_append_repository_delta_no_anchor_yet_appends_nothing(
    tmp_path: Path, anchors_root: Path
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()

    runtime_system_messages: list[str] = []
    append_repository_delta_runtime_system_message(
        runtime_system_messages,
        config=config,
        context_builder=_FakeContextBuilder(str(repo)),
        session_id="session-bootstrap-overlay",
        log_context=_log_context(session_id="session-bootstrap-overlay"),
    )

    assert runtime_system_messages == []


def test_append_repository_delta_exception_is_fail_closed_and_logs_counts_only(
    tmp_path: Path,
    anchors_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    def boom(**_kwargs: Any) -> str:
        raise RuntimeError("overlay exploded")

    monkeypatch.setattr("sidecar.ai.repo_delta.service.build_repository_delta_block", boom)

    config = _config()
    secret_workspace = str(tmp_path / "very-secret-workspace-name")
    runtime_system_messages: list[str] = []
    log_ctx = _log_context(session_id="session-overlay-boom", request_id="req-overlay-boom")

    with caplog.at_level(logging.WARNING, logger="sidecar.ai.repo_delta.overlay_test"):
        append_repository_delta_runtime_system_message(
            runtime_system_messages,
            config=config,
            context_builder=_FakeContextBuilder(secret_workspace),
            session_id="session-overlay-boom",
            log_context=log_ctx,
        )

    assert runtime_system_messages == []
    matching = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "ai.router.repository_delta_overlay_failed"
    ]
    assert len(matching) == 1, "expected exactly one counts-only WARNING on overlay failure"
    assert matching[0].data == {"error_type": "RuntimeError"}  # type: ignore[attr-defined]
    rendered = matching[0].getMessage()
    assert secret_workspace not in rendered
    assert "very-secret-workspace-name" not in rendered


# ===========================================================================
# C. agent_depth guard: build_chat_decision only overlays depth-0 turns
#
# A real harness for the FULL build_chat_decision entry point already exists
# (tests/sidecar/ai/routing/test_router.py's `_build_router` + `_StubEngine`
# pattern, exercised through `ChatRouter.build_chat_decision`) -- reused here
# rather than falling back to the lighter `_build_chat_decision` finalizer
# harness in tests/sidecar/ai/routing/test_chat_decision.py, which only
# covers the tail-end decision assembly and never reaches the overlay
# call site. `append_repository_delta_runtime_system_message` is monkeypatched
# with a spy on `sidecar.ai.routing.chat_decision` (the local name bound at
# import time in that module -- see chat_decision.py's module-level
# reassignment from `_runtime_overlays`) so the assertion is "was the real
# call site reached", not a re-test of section B's overlay behavior.
# ===========================================================================


class _StubEngine:
    def __init__(self, result: GenerationResult) -> None:
        self._result = result

    def generate_with_tools(self, **_kwargs: Any) -> GenerationResult:
        return self._result

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return None


class _StubMCPClient:
    @property
    def available_tools(self) -> list[Any]:
        return []

    def tool_descriptor(self, _tool_name: str) -> Any | None:
        return None

    def execute_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
    ) -> Any:
        raise AssertionError("no tool calls are expected in this test")


def _build_router(*, config: RuntimeConfig, engine: _StubEngine) -> ChatRouter:
    if not config.tools_workspace_root and not config.agent_workspace_root:
        config = replace(config, tools_workspace_root="C:/workspace")
    if config.mode == "chat":
        config = replace(config, mode="assist")
    return ChatRouter(
        config=config,
        engine=engine,
        mcp_client=_StubMCPClient(),
        context_builder=ContextBuilder(None),
    )


def _spy_repo_delta_overlay(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    def spy(_runtime_system_messages: list[str], **kwargs: Any) -> None:
        calls.append(kwargs)

    monkeypatch.setattr(
        "sidecar.ai.routing.chat_decision.append_repository_delta_runtime_system_message",
        spy,
    )
    return calls


def test_build_chat_decision_invokes_repo_delta_overlay_for_depth_zero_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _spy_repo_delta_overlay(monkeypatch)
    engine = _StubEngine(GenerationResult(content="hi", finish_reason="stop"))
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock", model="mock-v1", repo_delta_resume_enabled=True
        ),
        engine=engine,
    )
    request_context = ChatRequestContext(
        request_id="req-depth-0",
        trace_id=None,
        session_id="session-depth-0",
        mode="chat",
        approvals_pre_granted=True,
        agent_depth=0,
    )

    router.build_chat_decision(
        request_context=request_context,
        request_id="req-depth-0",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )

    assert len(calls) == 1
    assert calls[0]["session_id"] == "session-depth-0"


def test_build_chat_decision_skips_repo_delta_overlay_for_sub_agent_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _spy_repo_delta_overlay(monkeypatch)
    engine = _StubEngine(GenerationResult(content="hi", finish_reason="stop"))
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock", model="mock-v1", repo_delta_resume_enabled=True
        ),
        engine=engine,
    )
    request_context = ChatRequestContext(
        request_id="req-depth-1",
        trace_id=None,
        session_id="session-depth-1",
        mode="chat",
        approvals_pre_granted=True,
        agent_depth=1,
    )

    router.build_chat_decision(
        request_context=request_context,
        request_id="req-depth-1",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )

    assert calls == [], "a sub-agent (agent_depth > 0) turn must never get the repo-delta overlay"


def test_build_chat_decision_skips_repo_delta_overlay_when_session_id_is_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _spy_repo_delta_overlay(monkeypatch)
    engine = _StubEngine(GenerationResult(content="hi", finish_reason="stop"))
    router = _build_router(
        config=RuntimeConfig(
            engine_type="mock", model="mock-v1", repo_delta_resume_enabled=True
        ),
        engine=engine,
    )
    request_context = ChatRequestContext(
        request_id="req-no-session",
        trace_id=None,
        session_id=None,
        mode="chat",
        approvals_pre_granted=True,
        agent_depth=0,
    )

    router.build_chat_decision(
        request_context=request_context,
        request_id="req-no-session",
        messages=[{"role": "user", "content": "hello"}],
        latest_user_content="hello",
        mode="chat",
        approvals_pre_granted=True,
    )

    assert calls == [], "a depth-0 turn with no session_id must still skip the overlay"


# ===========================================================================
# D. Run-end refresh: _maybe_refresh_repo_anchor
# ===========================================================================


def _fake_brain_container(config: RuntimeConfig, workspace_root: str) -> SimpleNamespace:
    return SimpleNamespace(
        stack=SimpleNamespace(
            config=config,
            router=SimpleNamespace(
                _context_builder=SimpleNamespace(workspace_root=workspace_root)
            ),
        )
    )


def test_maybe_refresh_repo_anchor_writes_the_current_head_sha(
    tmp_path: Path, anchors_root: Path
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    sha = _commit(repo, "a.txt", "one\n", "initial")
    config = _config()
    brain_container = _fake_brain_container(config, str(repo))

    _maybe_refresh_repo_anchor(session_id="session-runend", brain_container=brain_container)

    anchor_path = repo_anchor_path(config, "session-runend")
    assert anchor_path is not None
    anchor = read_repo_anchor(anchor_path)
    assert anchor is not None
    assert anchor.head_sha == sha
    assert anchor.branch == "main"


def test_maybe_refresh_repo_anchor_flag_off_writes_no_anchor(
    tmp_path: Path, anchors_root: Path
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = RuntimeConfig(repo_delta_resume_enabled=False)
    brain_container = _fake_brain_container(config, str(repo))

    _maybe_refresh_repo_anchor(
        session_id="session-flag-off-runend", brain_container=brain_container
    )

    anchor_path = repo_anchor_path(config, "session-flag-off-runend")
    assert anchor_path is not None
    assert not anchor_path.exists()


def test_maybe_refresh_repo_anchor_empty_session_id_is_a_noop(
    tmp_path: Path, anchors_root: Path
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()
    brain_container = _fake_brain_container(config, str(repo))

    _maybe_refresh_repo_anchor(session_id="", brain_container=brain_container)

    assert _snapshot_tree(anchors_root) == frozenset()


def test_maybe_refresh_repo_anchor_exception_is_fail_closed_and_logs_counts_only(
    tmp_path: Path,
    anchors_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _skip_if_no_git()
    repo = tmp_path / "repo"
    _init_repo(repo)
    _commit(repo, "a.txt", "one\n", "initial")
    config = _config()
    brain_container = _fake_brain_container(config, str(repo))

    def boom(**_kwargs: Any) -> None:
        raise RuntimeError("refresh exploded")

    monkeypatch.setattr("sidecar.ai.repo_delta.service.refresh_repo_anchor", boom)

    with caplog.at_level(logging.WARNING, logger="sidecar.runtime.chat"):
        _maybe_refresh_repo_anchor(
            session_id="session-runend-boom", brain_container=brain_container
        )

    failed = [
        record
        for record in caplog.records
        if getattr(record, "event", "") == "runtime.chat.repo_delta.refresh_failed"
    ]
    assert len(failed) == 1, "expected exactly one counts-only WARNING on refresh failure"
    assert failed[0].data == {"error_type": "RuntimeError"}  # type: ignore[attr-defined]


# ===========================================================================
# E. Approval-resume preserves the <repository-delta> block byte-identical
#
# Seam tested: `sidecar.runtime.chat._build_live_dynamic_system_messages`
# (re-exported from `chat_resume.py`), which is the EXACT function
# `_validate_approval_plan_live_context` calls to recompute the live dynamic
# system messages during approval-resume, and
# `_build_live_approval_working_messages`, which assembles those into the
# final resumed `working_messages` list. Both are exercised directly against
# a `SimpleNamespace(working_messages=...)` stand-in for a frozen
# `ApprovalPlan` -- the same "duck-typed fake plan" pattern already used for
# these two functions in tests/sidecar/runtime/test_chat_dark_paths.py
# (`test_build_live_dynamic_system_messages_appends_runtime_messages_from_plan`,
# `test_build_live_approval_working_messages_stops_at_non_dynamic_message`).
#
# This is the REDUCED assertion, not the full drift-stability harness: it
# does not stand up `_validate_approval_plan_live_context`'s hash comparison
# (`approval_plan_hash` / `build_message_history_hash` etc.), which needs a
# fully-populated `ApprovalPlan` plus a real kernel/tool-contract -- far
# heavier than what's needed to prove the load-bearing property, which is
# that both seams that actually run during resume carry the block through
# with zero mutation.
# ===========================================================================


def _repository_delta_block() -> str:
    return (
        "<repository-delta>\n"
        "The repository changed since this conversation last worked in it. Reconcile your\n"
        "assumptions with these changes before relying on prior file/symbol knowledge; re-read\n"
        "anything you depend on.\n"
        "HEAD: abc1234 -> def5678 (2 ahead, 0 behind)\n"
        "Commits (newest first, 1 of 2):\n"
        "- def5678 second commit\n"
        "</repository-delta>"
    )


def test_build_live_dynamic_system_messages_preserves_repository_delta_block_byte_identical(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "sidecar.runtime.chat.build_dynamic_system_messages",
        lambda **_kwargs: [],
    )
    block = _repository_delta_block()
    assert ContextBuilder.is_runtime_system_message(block) is True  # load-bearing property

    plan = SimpleNamespace(
        working_messages=(
            {"role": "system", "content": "primary system prompt"},
            {"role": "system", "content": block},
            {"role": "user", "content": "what changed?"},
        ),
        personality_rendered=False,
    )
    stack = SimpleNamespace(
        config=SimpleNamespace(feature_flags={}, engine_type="mock", model="mock-v1"),
        router=SimpleNamespace(_context_builder=None),
    )
    brain_container = SimpleNamespace(stack=stack)

    result = _build_live_dynamic_system_messages(
        brain_container=brain_container,
        tool_statuses=(),
        plan=plan,
    )

    # The comprehension keeps only messages whose content == block, so a single
    # match proves the block survived byte-identical: any mutation/re-serialization
    # would change the bytes, drop it from `matches`, and fail this length check.
    # (A follow-on `is block or == block` assertion would be tautological here --
    # the `== block` half is guaranteed by the filter -- so it is omitted.)
    matches = [message for message in result if message.get("content") == block]
    assert len(matches) == 1, f"expected the block preserved byte-identical, got {result!r}"


def test_build_live_approval_working_messages_carries_repository_delta_block_into_final_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One level further down the pipe: the FINAL resumed working_messages list."""
    monkeypatch.setattr(
        "sidecar.runtime.chat.build_dynamic_system_messages",
        lambda **_kwargs: [],
    )
    block = _repository_delta_block()

    plan = SimpleNamespace(
        working_messages=(
            {"role": "system", "content": "frozen system prompt"},
            {"role": "system", "content": block},
            {"role": "user", "content": "what changed?"},
        ),
        personality_rendered=False,
    )
    stack = SimpleNamespace(
        config=SimpleNamespace(feature_flags={}, engine_type="mock", model="mock-v1"),
        router=SimpleNamespace(_context_builder=None),
    )
    brain_container = SimpleNamespace(stack=stack)

    dynamic_system_messages = _build_live_dynamic_system_messages(
        brain_container=brain_container,
        tool_statuses=(),
        plan=plan,
    )
    final_working_messages = _build_live_approval_working_messages(
        plan,
        live_system_prompt="live system prompt",
        dynamic_system_messages=dynamic_system_messages,
    )

    matches = [
        message for message in final_working_messages if message.get("content") == block
    ]
    assert len(matches) == 1, (
        f"expected the block preserved byte-identical in the final resumed "
        f"working_messages, got {final_working_messages!r}"
    )
