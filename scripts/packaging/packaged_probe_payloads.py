"""Payload helpers for the packaged-flow smoke probes."""
from __future__ import annotations

import json
from pathlib import Path
from typing import NoReturn

REQUIRED_PACKAGED_BUILTIN_TOOLS = ("read_file", "list_dir", "web_search", "fetch_url")


def _validate_packaged_initialize_payload(payload: dict[str, object]) -> None:
    result = payload.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("packaged sidecar initialize response missing result")

    failures = result.get("mcp_servers_failed")
    if isinstance(failures, list) and failures:
        details = "; ".join(_format_mcp_failure_detail(item) for item in failures)
        raise RuntimeError(f"packaged sidecar initialize reported mcp server failures: {details}")

    tools_status = result.get("tools_status")
    if not isinstance(tools_status, dict):
        tools_status = {}
    available_names = _available_tool_names(result.get("tools_available"))
    unavailable: list[str] = []
    for tool_name in REQUIRED_PACKAGED_BUILTIN_TOOLS:
        detail = _packaged_tool_unavailable_detail(
            tool_name,
            tools_status=tools_status,
            available_names=available_names,
        )
        if detail:
            unavailable.append(detail)
    if unavailable:
        raise RuntimeError(
            "required packaged built-in tools unavailable: " + ", ".join(unavailable)
        )


def _format_mcp_failure_detail(item: object) -> str:
    if not isinstance(item, dict):
        return str(item or "unknown failure").strip() or "unknown failure"
    name = str(item.get("name") or "").strip()
    code = str(item.get("code") or item.get("error_code") or "").strip()
    message = str(item.get("message") or "").strip()
    detail = ": ".join(part for part in (code, message) if part)
    if name and detail:
        return f"{name} ({detail})"
    return name or detail or "unknown failure"


def _available_tool_names(value: object) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {str(name).strip() for name in value if str(name).strip()}


def _packaged_tool_unavailable_detail(
    tool_name: str,
    *,
    tools_status: dict[str, object],
    available_names: set[str],
) -> str:
    status = tools_status.get(tool_name)
    if isinstance(status, dict):
        if status.get("available") is True:
            return ""
        reason = str(status.get("reason") or "").strip()
        return f"{tool_name}{f' ({reason})' if reason else ''}"
    return "" if tool_name in available_names else tool_name


def _append_bounded_tail(buffer: bytearray, chunk: bytes, *, limit: int) -> None:
    buffer.extend(chunk)
    overflow = len(buffer) - limit
    if overflow > 0:
        del buffer[:overflow]


def _decode_stderr_tail(buffer: bytearray) -> str:
    return bytes(buffer).decode("utf-8", errors="replace").strip()


def _format_probe_read_error(error: BaseException, stderr_tail: bytearray) -> str:
    detail = (
        "packaged sidecar initialize probe failed to read response frame: "
        f"{type(error).__name__}: {error}"
    )
    stderr_detail = _decode_stderr_tail(stderr_tail)
    if stderr_detail:
        return f"{detail}; stderr_tail={stderr_detail}"
    return detail


def _raise_probe_response_error(
    response_errors: list[BaseException],
    stderr_tail: bytearray,
) -> NoReturn:
    if response_errors:
        read_error = response_errors[0]
        raise RuntimeError(_format_probe_read_error(read_error, stderr_tail)) from read_error
    stderr_detail = _decode_stderr_tail(stderr_tail)
    if stderr_detail:
        raise RuntimeError(
            "packaged sidecar initialize probe produced no response; "
            f"stderr_tail={stderr_detail}"
        )
    raise RuntimeError("packaged sidecar initialize probe produced no response")


def _load_packaged_smoke_payload(output_path: Path) -> dict[str, object]:
    if not output_path.exists():
        raise RuntimeError(f"packaged app smoke did not produce output: {output_path}")
    try:
        payload = json.loads(output_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"packaged app smoke output is invalid JSON: {output_path}"
        ) from error
    if not isinstance(payload, dict):
        raise RuntimeError("packaged app smoke output is not an object")
    return payload


def _validate_packaged_smoke_payload(payload: dict[str, object]) -> dict[str, object]:
    backend_status = payload.get("backendStatus", {})
    if not isinstance(backend_status, dict):
        raise RuntimeError("packaged app smoke backendStatus is not an object")

    if payload.get("ok") is not True:
        raise RuntimeError(
            "packaged app smoke reported failure: "
            f"{str(payload.get('error', '')).strip() or 'unknown error'}"
        )
    if payload.get("rendererReady") is not True:
        raise RuntimeError("packaged app smoke did not observe renderer-ready")
    if str(backend_status.get("phase", "")).strip().lower() != "ready":
        raise RuntimeError(
            "packaged app smoke backend was not ready: "
            f"{str(backend_status.get('detail', '')).strip() or 'missing detail'}"
        )

    launch_source = str(
        payload.get("launchSource")
        or backend_status.get("launchSource", "")
    ).strip()
    if launch_source != "packaged-binary":
        raise RuntimeError(
            "packaged app smoke expected launchSource=packaged-binary, "
            f"got: {launch_source!r}"
        )
    return payload
