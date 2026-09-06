"""IPC payload shaping helpers for large tool notification fields."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

DEFAULT_MAX_INLINE_PAYLOAD_BYTES = 65_536
_TRUNCATION_SUFFIX = " [truncated]"
_TOOL_FIELDS_BY_METHOD = {
    "tool.executing": ("tool_input",),
    "tool.result": ("tool_input", "output", "metadata"),
}
_SAFE_TOKEN_RE = re.compile(r"[^a-zA-Z0-9_.-]+")


def _clamp_max_inline_payload_bytes(value: Any) -> int:
    if isinstance(value, (int, float)):
        candidate = int(value)
        if 4096 <= candidate <= 2_097_152:
            return candidate
    return DEFAULT_MAX_INLINE_PAYLOAD_BYTES


def _default_ipc_payload_root(config: Any) -> Path:
    configured = str(getattr(config, "background_runtime_root", "") or "").strip()
    if configured:
        return Path(configured).expanduser() / "ipc-payloads"
    return Path.home() / ".companion" / "background-memory" / "ipc-payloads"


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _byte_size(value: Any) -> int:
    return len(_json_text(value).encode("utf-8", errors="surrogatepass"))


def _truncate_text_to_bytes(text: str, limit_bytes: int) -> str:
    if limit_bytes <= 0:
        return ""
    raw_bytes = text.encode("utf-8", errors="surrogatepass")
    if len(raw_bytes) <= limit_bytes:
        return text
    suffix_bytes = _TRUNCATION_SUFFIX.encode("utf-8")
    if limit_bytes <= len(suffix_bytes):
        return _TRUNCATION_SUFFIX[: max(1, limit_bytes)]
    payload_limit = max(0, limit_bytes - len(suffix_bytes))
    truncated = raw_bytes[:payload_limit].decode("utf-8", errors="ignore").rstrip()
    return f"{truncated}{_TRUNCATION_SUFFIX}"


def _preview_value(value: Any, *, field: str, max_inline_bytes: int) -> Any:
    if field == "output":
        return _truncate_text_to_bytes(str(value or ""), max_inline_bytes)
    if isinstance(value, str):
        return {"_externalized": True, "preview": _truncate_text_to_bytes(value, max_inline_bytes)}
    serialized = _json_text(value)
    return {
        "_externalized": True,
        "preview": _truncate_text_to_bytes(serialized, max_inline_bytes),
    }


@dataclass(frozen=True)
class IpcPayloadExternalizer:
    """Externalize oversized tool notification fields to sidecar-owned files."""

    root: Path
    max_inline_payload_bytes: int = DEFAULT_MAX_INLINE_PAYLOAD_BYTES

    @classmethod
    def from_config(cls, config: Any) -> "IpcPayloadExternalizer":
        return cls(
            root=_default_ipc_payload_root(config),
            max_inline_payload_bytes=_clamp_max_inline_payload_bytes(
                getattr(config, "max_inline_payload_bytes", DEFAULT_MAX_INLINE_PAYLOAD_BYTES)
            ),
        )

    def harden_tool_notification(
        self,
        *,
        method: str,
        params: dict[str, Any],
        request_id: str,
        trace_id: str | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        fields = _TOOL_FIELDS_BY_METHOD.get(method)
        if not fields:
            return params
        shaped = dict(params)
        external_refs: dict[str, dict[str, Any]] = {}
        for field in fields:
            if field not in shaped:
                continue
            value = shaped[field]
            size_bytes = _byte_size(value)
            if size_bytes <= self.max_inline_payload_bytes:
                continue
            shaped[field] = _preview_value(
                value,
                field=field,
                max_inline_bytes=self.max_inline_payload_bytes,
            )
            try:
                path = self._write_external_payload(
                    request_id=request_id,
                    trace_id=trace_id,
                    session_id=session_id,
                    field=field,
                    value=value,
                )
            except OSError:
                continue
            external_refs[field] = {
                "path": str(path),
                "bytes": size_bytes,
                "encoding": "utf-8",
                "format": "json",
            }
        if external_refs:
            shaped["_external_payloads"] = external_refs
        return shaped

    def _write_external_payload(
        self,
        *,
        request_id: str,
        trace_id: str | None,
        session_id: str | None,
        field: str,
        value: Any,
    ) -> Path:
        self.root.mkdir(parents=True, exist_ok=True)
        safe_request_id = _SAFE_TOKEN_RE.sub("_", str(request_id or "req")).strip("._-") or "req"
        payload_path = self.root / f"{safe_request_id}-{uuid4().hex}.json"
        payload = {
            "request_id": request_id,
            "trace_id": trace_id,
            "session_id": session_id,
            "field": field,
            "value": value,
        }
        content = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
        payload_path.write_bytes(content.encode("utf-8", errors="surrogatepass"))
        return payload_path.resolve()
