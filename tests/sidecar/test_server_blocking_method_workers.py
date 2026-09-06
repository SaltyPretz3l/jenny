from __future__ import annotations

import re
import threading
import time
from pathlib import Path
from typing import Any

from sidecar import server
from sidecar.ai.error_codes import CMP_RESOURCE_EXCEEDED
from sidecar.protocol import (
    CHAT_COMPACT_METHOD,
    COMMIT_GENERATE_MESSAGE_METHOD,
    HARDWARE_PROFILE_METHOD,
    HARDWARE_VRAM_USAGE_METHOD,
    MCP_INSPECT_METHOD,
    MEMORY_LIST_METHOD,
    MODELS_LIST_METHOD,
    MODELS_OLLAMA_BLOB_METHOD,
    MODELS_RESIDENT_METHOD,
    MODELS_UNLOAD_METHOD,
    SUGGESTIONS_GENERATE_METHOD,
)
from sidecar.runtime import server_auxiliary_workers
from sidecar.runtime.outcomes import ProcessOutcome


class _FakeTransport:
    def __init__(self) -> None:
        self.controls: list[dict[str, Any]] = []
        self.response_sent = threading.Event()

    def send_control(self, message: dict[str, Any]) -> None:
        self.controls.append(message)
        self.response_sent.set()


def test_blocking_and_existing_methods_are_auxiliary_worker_methods() -> None:
    expected = {
        MODELS_LIST_METHOD,
        MODELS_UNLOAD_METHOD,
        MODELS_RESIDENT_METHOD,
        MODELS_OLLAMA_BLOB_METHOD,
        MEMORY_LIST_METHOD,
        HARDWARE_VRAM_USAGE_METHOD,
        SUGGESTIONS_GENERATE_METHOD,
        COMMIT_GENERATE_MESSAGE_METHOD,
        HARDWARE_PROFILE_METHOD,
        CHAT_COMPACT_METHOD,
        MCP_INSPECT_METHOD,
    }

    assert expected <= server_auxiliary_workers.AUXILIARY_WORKER_METHODS


def test_blocked_models_list_does_not_block_hardware_profile() -> None:
    models_started = threading.Event()
    release_models = threading.Event()
    hardware_completed = threading.Event()
    transport = _FakeTransport()
    family_workers: dict[str, set[Any]] = {}
    hardware_workers: set[Any] = set()

    def request_runner(message: dict[str, Any], initialized: bool) -> ProcessOutcome:
        if message["method"] == MODELS_LIST_METHOD:
            models_started.set()
            assert release_models.wait(2.0)
        else:
            hardware_completed.set()
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response={"jsonrpc": "2.0", "id": message["id"], "result": {}},
            notifications=[],
        )

    assert server_auxiliary_workers.route_auxiliary_request(
        method=MODELS_LIST_METHOD,
        message={"jsonrpc": "2.0", "id": 101, "method": MODELS_LIST_METHOD},
        multiplexer=None,
        direct_transport=transport,
        hardware_worker_threads=hardware_workers,
        compact_worker_threads=set(),
        family_worker_threads=family_workers,
        request_runner=request_runner,
        send_outcome=lambda outcome, **_kwargs: transport.send_control(outcome.response),
        write_outcome_direct=lambda outcome: transport.send_control(outcome.response),
        logger=server.logger,
    )
    assert models_started.wait(1.0)

    started_at = time.monotonic()
    assert server_auxiliary_workers.route_auxiliary_request(
        method=HARDWARE_PROFILE_METHOD,
        message={"jsonrpc": "2.0", "id": 102, "method": HARDWARE_PROFILE_METHOD},
        multiplexer=None,
        direct_transport=transport,
        hardware_worker_threads=hardware_workers,
        compact_worker_threads=set(),
        family_worker_threads=family_workers,
        request_runner=request_runner,
        send_outcome=lambda outcome, **_kwargs: transport.send_control(outcome.response),
        write_outcome_direct=lambda outcome: transport.send_control(outcome.response),
        logger=server.logger,
    )
    assert hardware_completed.wait(1.0)
    assert transport.response_sent.wait(1.0)
    assert time.monotonic() - started_at < 1.0
    assert transport.controls[0]["id"] == 102

    release_models.set()
    server_auxiliary_workers.join_auxiliary_workers(
        worker_threads=hardware_workers | family_workers["models"],
        timeout_seconds=1.0,
        logger=server.logger,
    )


def test_probe_family_cap_rejects_second_request() -> None:
    probe_started = threading.Event()
    release_probe = threading.Event()
    transport = _FakeTransport()
    family_workers: dict[str, set[Any]] = {}

    def request_runner(message: dict[str, Any], initialized: bool) -> ProcessOutcome:
        probe_started.set()
        assert release_probe.wait(2.0)
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response={"jsonrpc": "2.0", "id": message["id"], "result": {}},
            notifications=[],
        )

    route_kwargs = {
        "multiplexer": None,
        "direct_transport": transport,
        "hardware_worker_threads": set(),
        "compact_worker_threads": set(),
        "family_worker_threads": family_workers,
        "request_runner": request_runner,
        "send_outcome": lambda outcome, **_kwargs: transport.send_control(outcome.response),
        "write_outcome_direct": lambda outcome: transport.send_control(outcome.response),
        "logger": server.logger,
    }
    assert server_auxiliary_workers.route_auxiliary_request(
        method=HARDWARE_VRAM_USAGE_METHOD,
        message={"jsonrpc": "2.0", "id": 103, "method": HARDWARE_VRAM_USAGE_METHOD},
        **route_kwargs,  # type: ignore[arg-type]
    )
    assert probe_started.wait(1.0)

    assert (
        server_auxiliary_workers.route_auxiliary_request(
            method=HARDWARE_VRAM_USAGE_METHOD,
            message={"jsonrpc": "2.0", "id": 104, "method": HARDWARE_VRAM_USAGE_METHOD},
            **route_kwargs,  # type: ignore[arg-type]
        )
        is False
    )
    assert transport.controls[0]["id"] == 104
    error_data = transport.controls[0]["error"]["data"]
    assert error_data["code"] == CMP_RESOURCE_EXCEEDED
    assert error_data["reason"] == "too_many_probe_requests"
    assert error_data["active_count"] == 1
    assert error_data["max_active_workers"] == 1

    release_probe.set()
    server_auxiliary_workers.join_auxiliary_workers(
        worker_threads=family_workers["probe"],
        timeout_seconds=1.0,
        logger=server.logger,
    )


def test_family_method_fails_closed_when_registry_is_not_wired() -> None:
    """A missing family registry is a wiring bug, not a reason to run untracked.

    Starting the worker against a throwaway set would silently disable the
    family cap and hide the thread from the shutdown join, so routing must
    refuse instead.
    """
    transport = _FakeTransport()
    ran = threading.Event()

    def request_runner(message: dict[str, Any], initialized: bool) -> ProcessOutcome:
        ran.set()
        return ProcessOutcome(
            initialized=initialized,
            shutdown_requested=False,
            response={"jsonrpc": "2.0", "id": message["id"], "result": {}},
            notifications=[],
        )

    assert (
        server_auxiliary_workers.route_auxiliary_request(
            method=MODELS_LIST_METHOD,
            message={"jsonrpc": "2.0", "id": 105, "method": MODELS_LIST_METHOD},
            multiplexer=None,
            direct_transport=transport,
            hardware_worker_threads=set(),
            compact_worker_threads=set(),
            family_worker_threads=None,
            request_runner=request_runner,
            send_outcome=lambda outcome, **_kwargs: transport.send_control(outcome.response),
            write_outcome_direct=lambda outcome: transport.send_control(outcome.response),
            logger=server.logger,
        )
        is False
    )
    assert not ran.wait(0.2)

def test_every_routed_family_has_a_worker_cap() -> None:
    """A family without a cap used to raise KeyError on the dispatch loop.

    server.py's loop catches Exception and breaks, so the miss exited the whole
    sidecar. Routing now falls back to serial, and this keeps the two dicts in step.
    """
    families = set(server_auxiliary_workers.AUXILIARY_FAMILY_BY_METHOD.values())
    assert families <= set(server_auxiliary_workers.DEFAULT_MAX_WORKERS_BY_FAMILY)


def test_blob_family_cap_covers_the_shell_fan_out() -> None:
    """models.ollama_blob is issued OLLAMA_SOURCE_BATCH-wide by the shell.

    A cap below that rejects the tail of every batch with CMP-RUNTIME-0001, which
    backend-ollama-blob.js turns into null and caches as "no GGUF source" for 30s.
    """
    repo_root = Path(__file__).resolve().parents[2]
    source = repo_root / "services" / "main" / "llama-server-ipc-handlers.js"
    match = re.search(
        r"^const OLLAMA_SOURCE_BATCH = (\d+);$",
        source.read_text(encoding="utf-8"),
        re.M,
    )
    assert match is not None, "OLLAMA_SOURCE_BATCH not found"
    batch = int(match.group(1))

    family_by_method = server_auxiliary_workers.AUXILIARY_FAMILY_BY_METHOD
    blob_family = family_by_method[MODELS_OLLAMA_BLOB_METHOD]
    assert blob_family != family_by_method[MODELS_LIST_METHOD]
    assert server_auxiliary_workers.DEFAULT_MAX_WORKERS_BY_FAMILY[blob_family] >= batch
