from __future__ import annotations

import json
import threading
from pathlib import Path

from sidecar.ai.utils import json_io
from sidecar.ai.utils.json_io import write_json_atomic


def test_write_json_atomic_round_trips_payload(tmp_path: Path) -> None:
    path = tmp_path / "payload.json"
    payload = {"message": "hello", "values": [1, 2, 3]}

    assert write_json_atomic(path, payload) is True
    assert json.loads(path.read_text(encoding="utf-8")) == payload


def test_write_json_atomic_returns_false_for_unserializable_payload(tmp_path: Path) -> None:
    path = tmp_path / "payload.json"

    assert write_json_atomic(path, {"invalid": object()}) is False
    assert not path.exists()


def test_write_json_atomic_creates_parent_directories(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "directory" / "payload.json"

    assert write_json_atomic(path, {"ok": True}) is True
    assert path.is_file()


def test_write_json_atomic_coordinates_concurrent_writers(
    tmp_path: Path,
    monkeypatch,
) -> None:
    path = tmp_path / "payload.json"
    payloads = [{"writer": "first"}, {"writer": "second"}]
    first_ready = threading.Event()
    second_replaced = threading.Event()
    real_replace = json_io.os.replace
    results: list[bool | None] = [None, None]

    def synchronized_replace(source, destination) -> None:
        if threading.current_thread().name == "first-writer":
            first_ready.set()
            assert second_replaced.wait(timeout=2)
            real_replace(source, destination)
            return
        assert first_ready.wait(timeout=2)
        real_replace(source, destination)
        second_replaced.set()

    def write(index: int) -> None:
        results[index] = write_json_atomic(path, payloads[index])

    monkeypatch.setattr(json_io.os, "replace", synchronized_replace)
    threads = [
        threading.Thread(target=write, args=(0,), name="first-writer"),
        threading.Thread(target=write, args=(1,), name="second-writer"),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=2)

    assert results == [True, True]
    assert json.loads(path.read_text(encoding="utf-8")) in payloads
    assert list(tmp_path.glob(".payload.json*.tmp")) == []
