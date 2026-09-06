"""Fixed sidecar-to-Electron plugin-host reverse RPC."""

from __future__ import annotations

import itertools
from collections.abc import Callable, Iterator
from typing import Any

from sidecar.ai.error_codes import CMP_PLUGIN_HOST_FAILED
from sidecar.protocol import API_VERSION, JSONRPC_VERSION

_REQUEST_IDS = itertools.count(20_000_000)
PLUGIN_HOST_METHOD = "plugin.host"


def invoke_plugin_host(
    request: dict[str, Any],
    *,
    request_id: str,
    write_message: Callable[[dict[str, Any]], None],
    response_reader_factory: (
        Callable[..., Callable[[float], dict[str, Any]]] | None
    ),
    timeout_seconds: float = 30.0,
) -> Iterator[dict[str, Any]]:
    rpc_id = next(_REQUEST_IDS)
    message = {"jsonrpc": JSONRPC_VERSION, "api_version": API_VERSION, "id": rpc_id,
               "method": PLUGIN_HOST_METHOD,
               "params": {"api_version": API_VERSION, "request_id": request_id, **request}}
    if response_reader_factory is None:
        raise RuntimeError(f"{CMP_PLUGIN_HOST_FAILED}: plugin host response reader unavailable")
    reader = response_reader_factory(rpc_id)
    try:
        write_message(message)
        response = reader(timeout_seconds)
        if (
            not isinstance(response, dict)
            or response.get("id") != rpc_id
            or not isinstance(response.get("result"), dict)
        ):
            raise RuntimeError(f"{CMP_PLUGIN_HOST_FAILED}: plugin host response rejected")
        result = response["result"]
        if result.get("ok") is not True:
            raise RuntimeError(f"{CMP_PLUGIN_HOST_FAILED}: plugin host request failed")
        frames = result.get("frames", [])
        if not isinstance(frames, list):
            raise RuntimeError(f"{CMP_PLUGIN_HOST_FAILED}: plugin host frames rejected")
        yield from frames
    finally:
        close = getattr(reader, "close", None)
        if callable(close):
            close()


__all__ = ["PLUGIN_HOST_METHOD", "invoke_plugin_host"]
