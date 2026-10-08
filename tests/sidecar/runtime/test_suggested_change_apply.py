"""Plan Plus C4: ``workspace.apply_suggested_changes`` (one consented apply = one change set)."""

from __future__ import annotations

import hashlib
import logging
import os
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.host_policy import HOST_ALLOWED_RPC_METHODS
from sidecar.ai.routing.mutation_change_set_lifecycle import MutationChangeSetLifecycle
from sidecar.ai.tools.builtins import filesystem
from sidecar.ai.tools.contracts import ToolExecutionFailure, ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_mutation_journal_contract import workspace_identity
from sidecar.ai.tools.workspace_mutation_journal_store import (
    StoreResult,
    WorkspaceMutationJournalStore,
)
from sidecar.ai.tools.workspace_restore import list_change_sets, preflight_undo, undo_change_set
from sidecar.protocol import (
    API_VERSION,
    INBOUND_VERSIONED_REQUEST_METHODS,
    WORKSPACE_APPLY_SUGGESTED_CHANGES_METHOD,
)
from sidecar.runtime import suggested_change_apply
from sidecar.runtime.server_auxiliary_workers import AUXILIARY_FAMILY_BY_METHOD
from sidecar.runtime.workspace_recovery_rpc import process_workspace_recovery_method

LOGGER = logging.getLogger(__name__)
BOM = b"\xef\xbb\xbf"
UUID7 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def _hash_bytes(raw: bytes) -> str:
    text = raw[len(BOM):].decode("utf-8") if raw.startswith(BOM) else raw.decode("utf-8")
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return "sha256:" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _hash_file(path: Path) -> str:
    return _hash_bytes(path.read_bytes())


class _Env:
    def __init__(self, tmp_path: Path) -> None:
        self.root = (tmp_path / "workspace").resolve()
        self.root.mkdir()
        self.root = self.root.resolve()
        self.state_root = tmp_path / "state"
        self.state_root.mkdir()
        self.outside = tmp_path / "outside"
        self.outside.mkdir()
        self.config = SimpleNamespace(
            tools_workspace_root=str(self.root),
            electron_state_root=str(self.state_root),
        )
        self.container = SimpleNamespace(stack=SimpleNamespace(config=self.config))

    @property
    def store(self) -> WorkspaceMutationJournalStore:
        return WorkspaceMutationJournalStore(self.state_root / "workspace-recovery")

    def params(self, items: list[dict[str, Any]], **overrides: Any) -> dict[str, Any]:
        identity = workspace_identity(self.root)
        params: dict[str, Any] = {
            "schema_version": 1,
            "workspace_root": str(self.root),
            "device_id": identity.device_id,
            "inode": identity.file_id,
            "session_id": "session-propose",
            "apply_id": "apply-1",
            "items": items,
        }
        params.update(overrides)
        return params

    def call(self, params: dict[str, Any]) -> dict[str, Any]:
        outcome = process_workspace_recovery_method(
            WORKSPACE_APPLY_SUGGESTED_CHANGES_METHOD,
            11,
            {"accept_version": API_VERSION, **params},
            True,
            self.container,
            LOGGER,
        )
        assert outcome is not None
        return outcome.response

    def apply(self, items: list[dict[str, Any]], **overrides: Any) -> dict[str, Any]:
        response = self.call(self.params(items, **overrides))
        assert "result" in response, response
        return response["result"]

    def record(self, change_set_id: str) -> dict[str, Any]:
        loaded = self.store.load(workspace_identity(self.root).workspace_id, change_set_id)
        assert loaded.ok and loaded.record is not None
        return loaded.record


def _replace(sid: str, path: str, old: str, new: str, expected_hash: str | None) -> dict[str, Any]:
    return {
        "suggestion_id": sid,
        "path": path,
        "kind": "replace",
        "old_string": old,
        "new_string": new,
        "expected_hash": expected_hash,
    }


def _create(sid: str, path: str, content: str) -> dict[str, Any]:
    return {
        "suggestion_id": sid,
        "path": path,
        "kind": "create",
        "old_string": None,
        "new_string": content,
        "expected_hash": None,
    }


@pytest.fixture
def env(tmp_path: Path) -> _Env:
    return _Env(tmp_path)


def test_method_is_registered_versioned_on_the_recovery_lane_and_not_hosted() -> None:
    assert WORKSPACE_APPLY_SUGGESTED_CHANGES_METHOD == "workspace.apply_suggested_changes"
    assert WORKSPACE_APPLY_SUGGESTED_CHANGES_METHOD in INBOUND_VERSIONED_REQUEST_METHODS
    assert AUXILIARY_FAMILY_BY_METHOD[WORKSPACE_APPLY_SUGGESTED_CHANGES_METHOD] == (
        "workspace_recovery"
    )
    assert WORKSPACE_APPLY_SUGGESTED_CHANGES_METHOD not in HOST_ALLOWED_RPC_METHODS


def test_replace_applies_preserving_newline_style_and_bom(env: _Env) -> None:
    target = env.root / "notes.txt"
    target.write_bytes(BOM + b"alpha\r\nbeta\r\ngamma\r\n")
    base_hash = _hash_file(target)

    result = env.apply([_replace("s-1", "notes.txt", "beta\n", "BETA\nextra\n", base_hash)])

    expected_bytes = BOM + b"alpha\r\nBETA\r\nextra\r\ngamma\r\n"
    assert target.read_bytes() == expected_bytes
    assert result["schema_version"] == 1
    assert result["status"] == "applied"
    change_set_id = result["workspace_change_set"]["change_set_id"]
    assert UUID7.match(change_set_id)
    [item] = result["items"]
    assert item["suggestion_id"] == "s-1"
    assert item["outcome"] == "applied"
    assert item["reason"] is None
    assert item["base_hash"] == base_hash
    assert item["after_hash"] == _hash_bytes(expected_bytes)
    assert item["diff"]["additions"] == 2 and item["diff"]["deletions"] == 1
    record = env.record(change_set_id)
    assert record["state"] == "committed"
    assert record["session_id"] == "session-propose"
    assert record["turn_id"] == "apply-1"
    assert record["tool_call_ids"] == ["s-1"]
    assert record["actor"] == "sidecar_tools"


def test_hash_mismatch_with_unique_match_is_moved_and_writes_nothing(env: _Env) -> None:
    target = env.root / "a.py"
    target.write_text("x = 1\ny = 2\n", encoding="utf-8")
    stale_hash = _hash_file(target)
    target.write_text("# header\nx = 1\ny = 2\n", encoding="utf-8")
    before = target.read_bytes()

    result = env.apply([_replace("s-1", "a.py", "y = 2", "y = 3", stale_hash)])

    assert target.read_bytes() == before
    assert result["status"] == "refused"
    assert result["workspace_change_set"] is None
    [item] = result["items"]
    assert item["outcome"] == "moved"
    assert item["base_hash"] == _hash_file(target)
    assert item["after_hash"] is None
    assert item["diff"]["additions"] == 1 and item["diff"]["deletions"] == 1
    assert list_change_sets(env.store, env.root)["change_sets"] == []


@pytest.mark.parametrize(
    ("content", "old", "reason"),
    [
        ("one\ntwo\n", "three", "no_match"),
        ("dup\ndup\n", "dup", "ambiguous_match"),
    ],
)
def test_no_or_ambiguous_match_is_out_of_date(
    env: _Env, content: str, old: str, reason: str
) -> None:
    target = env.root / "f.txt"
    target.write_text(content, encoding="utf-8")
    result = env.apply([_replace("s-1", "f.txt", old, "new", _hash_file(target))])

    assert result["status"] == "refused"
    [item] = result["items"]
    assert item["outcome"] == "out_of_date"
    assert item["reason"] == reason
    assert item["base_hash"] == _hash_file(target)
    assert target.read_text(encoding="utf-8") == content


def test_missing_target_for_replace_is_out_of_date(env: _Env) -> None:
    result = env.apply([_replace("s-1", "gone.txt", "a", "b", "sha256:" + "0" * 64)])
    assert result["items"][0]["outcome"] == "out_of_date"
    assert result["items"][0]["reason"] == "file_missing"


def test_create_applies_into_a_new_directory(env: _Env) -> None:
    result = env.apply([_create("c-1", "pkg/new_module.py", "print('hi')\n")])

    created = env.root / "pkg" / "new_module.py"
    assert created.read_bytes() == b"print('hi')\n"
    assert result["status"] == "applied"
    [item] = result["items"]
    assert item["outcome"] == "applied"
    assert item["base_hash"] is None
    assert item["after_hash"] == _hash_file(created)
    assert item["diff"]["status"] == "created"


def test_create_over_an_existing_file_is_refused(env: _Env) -> None:
    existing = env.root / "keep.txt"
    existing.write_text("mine\n", encoding="utf-8")

    result = env.apply([_create("c-1", "keep.txt", "theirs\n")])

    assert existing.read_text(encoding="utf-8") == "mine\n"
    assert result["status"] == "refused"
    assert result["items"][0]["outcome"] == "out_of_date"
    assert result["items"][0]["reason"] == "target_exists"


def test_one_failing_item_refuses_the_whole_call_with_zero_writes(env: _Env) -> None:
    first = env.root / "first.txt"
    first.write_text("keep me\n", encoding="utf-8")
    second = env.root / "second.txt"
    second.write_text("other\n", encoding="utf-8")
    before = (first.read_bytes(), second.read_bytes())

    result = env.apply(
        [
            _replace("s-1", "first.txt", "keep", "changed", _hash_file(first)),
            _replace("s-2", "second.txt", "missing text", "x", _hash_file(second)),
            _create("s-3", "third.txt", "new\n"),
        ]
    )

    assert (first.read_bytes(), second.read_bytes()) == before
    assert not (env.root / "third.txt").exists()
    assert result["status"] == "refused"
    assert result["workspace_change_set"] is None
    assert [(item["outcome"], item["reason"]) for item in result["items"]] == [
        ("refused", "batch_refused"),
        ("out_of_date", "no_match"),
        ("refused", "batch_refused"),
    ]
    assert list_change_sets(env.store, env.root)["change_sets"] == []


def test_two_suggestions_on_one_file_apply_as_one_change_set(env: _Env) -> None:
    target = env.root / "two.txt"
    target.write_text("a = 1\nb = 2\nc = 3\n", encoding="utf-8")
    base = _hash_file(target)

    result = env.apply(
        [
            _replace("s-1", "two.txt", "a = 1", "a = 10", base),
            _replace("s-2", "two.txt", "c = 3", "c = 30", base),
        ]
    )

    assert result["status"] == "applied", result
    assert target.read_text(encoding="utf-8") == "a = 10\nb = 2\nc = 30\n"
    assert result["items"][1]["after_hash"] == _hash_file(target)
    record = env.record(result["workspace_change_set"]["change_set_id"])
    assert record["tool_call_ids"] == ["s-1", "s-2"]
    assert record["operation_count"] == 2


def _failing_second_call(real: Any, failure: str) -> Any:
    calls = {"count": 0}

    def wrapper(arguments: dict[str, object], workspace: WorkspaceGuard) -> ToolHandlerResult:
        calls["count"] += 1
        if calls["count"] == 2:
            if failure == "raise":
                raise RuntimeError("injected fault")
            return ToolHandlerResult(output="injected failure", success=False, metadata={})
        return real(arguments, workspace)

    return wrapper


@pytest.mark.parametrize("failure", ["result", "raise"])
def test_mid_call_write_failure_rolls_back_byte_identical(
    env: _Env, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    first = env.root / "first.txt"
    first.write_bytes(BOM + b"line one\r\nline two\r\n")
    second = env.root / "second.txt"
    second.write_text("second\n", encoding="utf-8")
    first_before, second_before = first.read_bytes(), second.read_bytes()
    monkeypatch.setattr(
        suggested_change_apply,
        "edit_file_tool",
        _failing_second_call(suggested_change_apply.edit_file_tool, failure),
    )

    result = env.apply(
        [
            _replace("s-1", "first.txt", "line two", "line 2", _hash_file(first)),
            _replace("s-2", "second.txt", "second", "2nd", _hash_file(second)),
            _create("s-3", "third.txt", "never\n"),
        ]
    )

    assert result["status"] == "rolled_back"
    assert first.read_bytes() == first_before
    assert second.read_bytes() == second_before
    assert not (env.root / "third.txt").exists()
    assert [(item["outcome"], item["reason"]) for item in result["items"]] == [
        ("refused", "rolled_back"),
        ("refused", "write_failed"),
        ("refused", "rolled_back"),
    ]
    change_set_id = result["workspace_change_set"]["change_set_id"]
    record = env.record(change_set_id)
    # The first edit really landed and was journaled; the undo engine reverted it.
    assert record["tool_call_ids"] == ["s-1"]
    assert record["state"] == "rolled_back"
    assert record["termination_reason"] == "restore_completed"
    assert record["restore"]["status"] == "committed"


def test_finalize_failure_after_a_write_never_claims_applied_or_rolled_back(
    env: _Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = env.root / "fin.txt"
    target.write_text("keep = 1\n", encoding="utf-8")
    monkeypatch.setattr(
        suggested_change_apply.MutationChangeSetLifecycle,
        "finalize",
        lambda self, change_set_id, **_: StoreResult(ok=False),
    )

    item = _replace("s-1", "fin.txt", "keep = 1", "keep = 2", _hash_file(target))
    response = env.call(env.params([item]))

    assert "result" not in response
    data = response["error"]["data"]
    assert data["reason"] == "suggested_change_rollback_failed"
    assert data["status"] == "needs_review"
    assert data["cause"] == "finalize_failed"
    assert data["change_set_id"]


def test_create_write_failure_after_an_edit_rolls_back(
    env: _Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = env.root / "first.txt"
    first.write_text("alpha\n", encoding="utf-8")
    before = first.read_bytes()

    def failing_write(arguments: dict[str, object], workspace: WorkspaceGuard) -> ToolHandlerResult:
        return ToolHandlerResult(output="disk full", success=False, metadata={})

    monkeypatch.setattr(suggested_change_apply, "write_file_tool", failing_write)
    result = env.apply(
        [
            _replace("s-1", "first.txt", "alpha", "beta", _hash_file(first)),
            _create("s-2", "made.txt", "x\n"),
        ]
    )

    assert result["status"] == "rolled_back"
    assert first.read_bytes() == before


def test_journaled_write_fault_inside_the_tool_rolls_back(
    env: _Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = env.root / "first.txt"
    first.write_bytes(b"one\r\ntwo\r\n")
    before = first.read_bytes()

    def failing_bytes_write(*_args: object, **_kwargs: object) -> None:
        raise ToolExecutionFailure(code="CMP-TOOL-0006", message="injected", retryable=True)

    monkeypatch.setattr(filesystem, "write_hosted_bytes_after_read", failing_bytes_write)
    result = env.apply(
        [
            _replace("s-1", "first.txt", "two", "2", _hash_file(first)),
            _create("s-2", "made.txt", "x\n"),
        ]
    )

    assert result["status"] == "rolled_back"
    assert first.read_bytes() == before
    assert not (env.root / "made.txt").exists()
    record = env.record(result["workspace_change_set"]["change_set_id"])
    assert record["tool_call_ids"] == ["s-1", "s-2"]
    assert record["restore"]["status"] == "committed"


def test_applied_change_set_is_visible_to_preflight_and_undo(env: _Env) -> None:
    target = env.root / "undo.txt"
    target.write_bytes(b"keep\r\nchange me\r\n")
    before = target.read_bytes()

    result = env.apply(
        [
            _replace("s-1", "undo.txt", "change me", "changed", _hash_file(target)),
            _create("s-2", "fresh/new.txt", "fresh\n"),
        ]
    )
    change_set_id = result["workspace_change_set"]["change_set_id"]

    listed = list_change_sets(env.store, env.root)["change_sets"]
    assert [item["change_set_id"] for item in listed] == [change_set_id]
    preflight = preflight_undo(env.store, env.root, change_set_id)
    assert preflight["conflicts"] == []
    undo_change_set(env.store, env.root, change_set_id)

    assert target.read_bytes() == before
    assert not (env.root / "fresh" / "new.txt").exists()


def test_root_identity_mismatch_is_refused_before_anything(env: _Env) -> None:
    target = env.root / "r.txt"
    target.write_text("r\n", encoding="utf-8")
    identity = workspace_identity(env.root)

    result = env.apply(
        [_replace("s-1", "r.txt", "r", "R", _hash_file(target))],
        inode=str(int(identity.file_id) + 1),
    )

    assert target.read_text(encoding="utf-8") == "r\n"
    assert result["status"] == "refused"
    assert result["items"][0]["outcome"] == "refused"
    assert result["items"][0]["reason"] == "workspace_root_changed"


def test_missing_root_is_refused(env: _Env, tmp_path: Path) -> None:
    result = env.apply(
        [_create("c-1", "x.txt", "x")], workspace_root=str(tmp_path / "does-not-exist")
    )
    assert result["status"] == "refused"
    assert result["items"][0]["reason"] == "workspace_root_changed"


def test_dotdot_and_absolute_escapes_are_refused(env: _Env) -> None:
    secret = env.outside / "secret.txt"
    secret.write_text("secret\n", encoding="utf-8")
    secret_hash = _hash_file(secret)

    result = env.apply(
        [
            _replace("s-1", "../outside/secret.txt", "secret", "owned", secret_hash),
            _replace("s-2", str(secret), "secret", "owned", secret_hash),
            _create("s-3", "../outside/new.txt", "owned"),
            _create("s-4", ".jenny/state.json", "{}"),
        ]
    )

    assert secret.read_text(encoding="utf-8") == "secret\n"
    assert not (env.outside / "new.txt").exists()
    assert result["status"] == "refused"
    assert [(item["outcome"], item["reason"]) for item in result["items"]] == [
        ("refused", "path_outside_workspace"),
        ("refused", "path_outside_workspace"),
        ("refused", "path_outside_workspace"),
        ("refused", "reserved_path"),
    ]


def _make_dir_link(link: Path, target: Path) -> None:
    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
        return
    os.symlink(target, link, target_is_directory=True)


def test_junction_or_dir_symlink_pointing_outside_is_refused(env: _Env) -> None:
    secret = env.outside / "secret.txt"
    secret.write_text("secret\n", encoding="utf-8")
    try:
        _make_dir_link(env.root / "linked", env.outside)
    except (OSError, ImportError) as error:
        pytest.skip(f"directory link could not be created: {error}")

    result = env.apply(
        [
            _replace("s-1", "linked/secret.txt", "secret", "owned", _hash_file(secret)),
            _create("s-2", "linked/new.txt", "owned"),
        ]
    )

    assert secret.read_text(encoding="utf-8") == "secret\n"
    assert not (env.outside / "new.txt").exists()
    assert [(item["outcome"], item["reason"]) for item in result["items"]] == [
        ("refused", "path_outside_workspace"),
        ("refused", "path_outside_workspace"),
    ]


def test_file_symlink_pointing_outside_is_refused(env: _Env) -> None:
    secret = env.outside / "secret.txt"
    secret.write_text("secret\n", encoding="utf-8")
    try:
        os.symlink(secret, env.root / "link.txt")
    except OSError as error:
        pytest.skip(f"file symlinks need a privilege this machine lacks: {error}")

    result = env.apply([_replace("s-1", "link.txt", "secret", "owned", _hash_file(secret))])

    assert secret.read_text(encoding="utf-8") == "secret\n"
    assert result["items"][0]["reason"] == "path_outside_workspace"


def test_link_inside_the_workspace_is_refused(env: _Env) -> None:
    real_dir = env.root / "real"
    real_dir.mkdir()
    (real_dir / "f.txt").write_text("f\n", encoding="utf-8")
    try:
        _make_dir_link(env.root / "alias", real_dir)
    except (OSError, ImportError) as error:
        pytest.skip(f"directory link could not be created: {error}")

    result = env.apply(
        [_replace("s-1", "alias/f.txt", "f", "g", _hash_file(real_dir / "f.txt"))]
    )

    assert (real_dir / "f.txt").read_text(encoding="utf-8") == "f\n"
    assert result["items"][0]["reason"] == "path_link_refused"


def test_open_change_set_in_the_workspace_refuses_as_busy(env: _Env) -> None:
    lifecycle = MutationChangeSetLifecycle(env.store, env.root)
    guard = WorkspaceGuard(str(env.root), mutation_journal=lifecycle)
    written = filesystem.write_file_tool(
        {
            "path": "turn.txt",
            "content": "turn\n",
            "_jenny_session_id": "other-session",
            "_jenny_turn_id": "other-turn",
            "_jenny_tool_call_id": "call-1",
            "_jenny_change_set_id": "01990f9a-8c51-7ad2-a8be-41190e0e3001",
        },
        guard,
    )
    assert written.success

    result = env.apply([_create("c-1", "mine.txt", "mine\n")])

    assert not (env.root / "mine.txt").exists()
    assert result["status"] == "refused"
    assert result["items"][0]["reason"] == "workspace_busy"


def test_restore_in_progress_refuses(env: _Env, monkeypatch: pytest.MonkeyPatch) -> None:
    first = env.apply([_create("c-1", "one.txt", "one\n")])
    change_set_id = first["workspace_change_set"]["change_set_id"]
    real = suggested_change_apply.list_change_sets

    def restoring(store: Any, root: Any) -> dict[str, object]:
        listed = real(store, root)
        for item in listed["change_sets"]:  # type: ignore[union-attr]
            if item["change_set_id"] == change_set_id:
                item["restore_status"] = "in_progress"
        return listed

    monkeypatch.setattr(suggested_change_apply, "list_change_sets", restoring)
    result = env.apply([_create("c-2", "two.txt", "two\n")], apply_id="apply-2")

    assert not (env.root / "two.txt").exists()
    assert result["items"][0]["reason"] == "restore_in_progress"


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (lambda p: p.update(items=[_create(f"c-{i}", f"f{i}.txt", "x") for i in range(21)]),
         "too_many_items"),
        (lambda p: p.update(items=[]), "items_invalid"),
        (lambda p: p.update(schema_version=2), "schema_version_invalid"),
        (lambda p: p.update(extra=True), "params_invalid"),
        (lambda p: p.update(items=[_create("c-1", "a", "x"), _create("c-1", "b", "y")]),
         "duplicate_suggestion_id"),
        (lambda p: p.update(items=[{**_create("c-1", "a", "x"), "kind": "delete"}]),
         "item_invalid"),
        (lambda p: p.update(items=[_replace("s-1", "a", "", "x", "sha256:" + "0" * 64)]),
         "item_invalid"),
        (lambda p: p.update(items=[_replace("s-1", "a", "o", "x", "md5:abc")]), "item_invalid"),
        (lambda p: p.update(workspace_root="relative/root"), "workspace_root_invalid"),
    ],
)
def test_malformed_params_are_invalid(env: _Env, mutate: Any, reason: str) -> None:
    params = env.params([_create("c-1", "a.txt", "x")])
    mutate(params)
    response = env.call(params)
    assert response["error"]["code"] == -32602
    assert response["error"]["data"]["reason"] == reason


def test_strings_over_the_edit_cap_are_invalid(
    env: _Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(suggested_change_apply, "current_max_edit_file_bytes", lambda: 8)
    response = env.call(env.params([_create("c-1", "a.txt", "123456789")]))
    assert response["error"]["data"]["reason"] == "item_too_large"
